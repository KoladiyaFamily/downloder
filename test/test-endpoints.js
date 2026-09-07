const http = require('http');

let PORT = process.env.PORT || 3000;
let BASE_URL = `http://localhost:${PORT}`;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
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
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: buffer,
          json() {
            try {
              return JSON.parse(buffer.toString());
            } catch (e) {
              return null;
            }
          }
        });
      });
    });

    req.on('error', reject);

    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== Starting Video Downloader MVP Integration Tests ===\n');
  let passed = 0;
  let failed = 0;

  // Test 1: Health Check
  try {
    const res = await request('GET', '/api/health');
    const json = res.json();
    if (res.statusCode === 200 && json && json.status === 'ok') {
      console.log('✔ PASS: Health check endpoint /api/health returned 200 OK');
      passed++;
    } else {
      console.error('❌ FAIL: Health check endpoint unexpected response:', res.statusCode, json);
      failed++;
    }
  } catch (err) {
    console.error('❌ FAIL: Health check error:', err.message);
    failed++;
  }

  // Test 2: Invalid URL input validation
  try {
    const res = await request('POST', '/api/info', { url: 'not-a-valid-url' });
    const json = res.json();
    if (res.statusCode === 400 && json && json.error) {
      console.log('✔ PASS: Invalid URL correctly rejected with 400 and friendly error message');
      passed++;
    } else {
      console.error('❌ FAIL: Invalid URL did not return expected 400 error:', res.statusCode, json);
      failed++;
    }
  } catch (err) {
    console.error('❌ FAIL: Invalid URL test error:', err.message);
    failed++;
  }

  // Test 3: Unsupported domain error handling
  try {
    const res = await request('POST', '/api/info', { url: 'https://example.com/not-a-video' });
    const json = res.json();
    if (res.statusCode === 400 && json && json.error) {
      console.log('✔ PASS: Unsupported URL correctly caught with 400 and friendly explanation');
      passed++;
    } else {
      console.error('❌ FAIL: Unsupported URL error unexpected status:', res.statusCode, json);
      failed++;
    }
  } catch (err) {
    console.error('❌ FAIL: Unsupported URL test error:', err.message);
    failed++;
  }

  // Test 4: Valid public video metadata extraction
  const TEST_VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  try {
    console.log(`Testing metadata extraction for ${TEST_VIDEO}...`);
    const res = await request('POST', '/api/info', { url: TEST_VIDEO });
    const json = res.json();
    if (res.statusCode === 200 && json && json.success && json.title) {
      console.log(`✔ PASS: /api/info extracted video successfully: "${json.title}" (${json.duration || 'N/A'}) by ${json.uploader}`);
      passed++;
    } else {
      console.error('❌ FAIL: /api/info failed for valid video:', res.statusCode, json);
      failed++;
    }
  } catch (err) {
    console.error('❌ FAIL: Valid video info test error:', err.message);
    failed++;
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

// Wait for server to be responsive
setTimeout(runTests, 1000);
