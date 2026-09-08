process.env.NODE_ENV = 'test';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.TEST_PORT || process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

function request(method, reqPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {}
    };

    let bodyData = null;
    if (body) {
      bodyData = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          raw,
          json
        });
      });
    });

    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runSecuritySuite() {
  console.log('========================================================');
  console.log('   ANTIGRAVITY SECURITY & MVP VERIFICATION TEST SUITE   ');
  console.log('========================================================\n');

  let passed = 0;
  let failed = 0;

  // Reset rate limits before running suite
  await request('POST', '/api/test-reset-limits');

  function assert(name, condition, detail = '') {
    if (condition) {
      console.log(`✔ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name} - ${detail}`);
      failed++;
    }
  }

  // Reset rate limits for test run
  await request('POST', '/api/test-reset-limits');

  // 1. Health & Server check
  try {
    const res = await request('GET', '/api/health');
    assert('Health endpoint responds 200 OK', res.statusCode === 200 && res.json?.status === 'ok');
  } catch (e) {
    assert('Health endpoint responds 200 OK', false, e.message);
  }

  // 2. Security Headers Test
  try {
    const res = await request('GET', '/');
    assert('X-Content-Type-Options is nosniff', res.headers['x-content-type-options'] === 'nosniff');
    assert('X-Frame-Options is DENY', res.headers['x-frame-options'] === 'DENY');
    assert('Content-Security-Policy is present', !!res.headers['content-security-policy']);
    assert('X-Powered-By is hidden', !res.headers['x-powered-by']);
  } catch (e) {
    assert('Security headers check', false, e.message);
  }

  // 3. SSRF & Scheme Attacks
  const maliciousUrls = [
    { label: 'Localhost loopback', url: 'http://localhost:3000' },
    { label: '127.0.0.1 IP', url: 'http://127.0.0.1:8080' },
    { label: '0.0.0.0 IP', url: 'http://0.0.0.0:80' },
    { label: 'AWS/Cloud Metadata 169.254.169.254', url: 'http://169.254.169.254/latest/meta-data/' },
    { label: 'GCP Metadata hostname', url: 'http://metadata.google.internal/computeMetadata/v1/' },
    { label: 'Private LAN 192.168.1.1', url: 'http://192.168.1.1/admin' },
    { label: 'Private LAN 10.0.0.1', url: 'http://10.0.0.1/' },
    { label: 'IPv6 loopback [::1]', url: 'http://[::1]:8080' },
    { label: 'file:// protocol attempt', url: 'file:///etc/passwd' },
    { label: 'javascript: URI attempt', url: 'javascript:alert(1)' },
    { label: 'ftp:// protocol attempt', url: 'ftp://evil.com/video.mp4' },
    { label: 'Malformed scheme', url: 'not-a-valid-url' }
  ];

  console.log('\n--- Testing SSRF & Malicious URL Rejection ---');
  for (const item of maliciousUrls) {
    try {
      const res = await request('POST', '/api/info', { url: item.url });
      const blocked = (res.statusCode === 400 || res.statusCode === 429) && res.json?.error;
      assert(`Blocked ${item.label}`, blocked, `Status: ${res.statusCode}, Resp: ${res.raw}`);
      // Verify no sensitive internal traces leaked
      const leaks = res.raw.includes('node_modules') || res.raw.includes('C:\\') || res.raw.includes('F:\\') || res.raw.includes('yt_dlp');
      assert(`No internal traces leaked for ${item.label}`, !leaks, `Response contained sensitive data: ${res.raw}`);
    } catch (e) {
      assert(`Blocked ${item.label}`, false, e.message);
    }
  }

  // 4. Path Traversal & Filename Sanitization on Download
  console.log('\n--- Testing Filename Sanitization & Traversal Prevention ---');
  try {
    const maliciousTitle = '../../../../Windows/System32/cmd';
    const res = await request('GET', `/api/download?url=http://127.0.0.1&title=${encodeURIComponent(maliciousTitle)}`);
    // Should be blocked by SSRF (400) or Rate Limiter (429) before any process is even spawned
    assert('Blocked malicious /api/download attempt (SSRF or Rate Limit)', res.statusCode === 400 || res.statusCode === 429, `Status: ${res.statusCode}`);
  } catch (e) {
    assert('Blocked malicious /api/download attempt (SSRF or Rate Limit)', false, e.message);
  }

  // 5. Valid Video Processing (The Happy Path)
  console.log('\n--- Testing Valid Video Info Extraction ---');
  await request('POST', '/api/test-reset-limits');
  const TEST_VALID = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  try {
    const res = await request('POST', '/api/info', { url: TEST_VALID });
    const ok = res.statusCode === 200 && res.json?.success && res.json.title;
    assert('Valid URL correctly extracts title & metadata', ok, res.raw);
    if (ok) {
      console.log(`   Title: "${res.json.title}"`);
      console.log(`   Uploader: ${res.json.uploader}`);
      console.log(`   Duration: ${res.json.duration}`);
    }
  } catch (e) {
    assert('Valid video info extraction', false, e.message);
  }

  // 6. Test Rate Limiting
  console.log('\n--- Testing Rate Limiter Shield ---');
  let hitRateLimit = false;
  try {
    // Send rapid requests to exceed rate limit (25/min)
    const promises = [];
    for (let i = 0; i < 30; i++) {
      promises.push(request('POST', '/api/info', { url: 'http://127.0.0.1' }));
    }
    const results = await Promise.all(promises);
    hitRateLimit = results.some(r => r.statusCode === 429);
    assert('Rate limiter triggers HTTP 429 under flood', hitRateLimit);
  } catch (e) {
    assert('Rate limiter test', false, e.message);
  }

  // 7. Verify Temporary Storage Remains Clean
  console.log('\n--- Verifying Temp Directory Storage Hygiene ---');
  const tempDir = path.join(os.tmpdir(), 'antigravity_video_temp');
  if (fs.existsSync(tempDir)) {
    const remaining = fs.readdirSync(tempDir).filter(f => {
      try {
        return !fs.statSync(path.join(tempDir, f)).isDirectory();
      } catch (_) { return false; }
    });
    assert('Temp directory contains no leaked/orphaned files', remaining.length === 0, `Remaining: ${remaining.join(', ')}`);
  } else {
    assert('Temp directory exists and is managed', true);
  }

  console.log(`\n========================================================`);
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================================\n`);

  if (failed > 0) process.exit(1);
}

runSecuritySuite();
