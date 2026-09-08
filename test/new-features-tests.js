process.env.NODE_ENV = 'test';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.TEST_PORT || process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

function request(method, reqPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: { ...headers }
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

function listenSSE(ssePath, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(ssePath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { ...headers }
    };

    const events = [];
    const req = http.request(options, (res) => {
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          const lines = part.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                events.push(parsed);
              } catch (_) {}
            }
          }
        }
      });

      res.on('end', () => resolve(events));
    });

    req.on('error', reject);
    req.end();
  });
}

function verifyMediaStreams(filePath) {
  const res = spawnSync(ffmpegPath, ['-i', filePath], { shell: false });
  const stderr = res.stderr.toString();
  const videoMatch = stderr.match(/Stream #\d+:\d+.*?: Video: ([^\n,]+)/i);
  const audioMatch = stderr.match(/Stream #\d+:\d+.*?: Audio: ([^\n,]+)/i);
  const isMp4 = /Input #0,\s*(mov,mp4,m4a|mp4)/i.test(stderr);
  return {
    hasVideo: !!videoMatch,
    videoCodec: videoMatch ? videoMatch[1].trim() : null,
    hasAudio: !!audioMatch,
    audioCodec: audioMatch ? audioMatch[1].trim() : null,
    isMp4
  };
}

async function runFeatureTests() {
  console.log('===============================================================');
  console.log('       ANTIGRAVITY ADVANCED FEATURES VERIFICATION SUITE        ');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, detail = '') {
    if (condition) {
      console.log(`✔ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name} - ${detail}`);
      failed++;
    }
  }

  // Reset rate limits
  await request('POST', '/api/test-reset-limits');

  const SAMPLE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

  // TEST O: Unauthenticated Access & Private Password Protection
  console.log('\n--- TEST O: Unauthenticated Access & Credential Verification ---');
  // 1. Unauthenticated request to /api/info with x-test-enforce-auth
  const unauthRes = await request('POST', '/api/info', { url: SAMPLE_URL }, { 'x-test-enforce-auth': 'true' });
  assert('Unauthenticated visitor blocked with HTTP 401', unauthRes.statusCode === 401 && unauthRes.json?.error);

  // 2. Wrong credentials attempt
  const wrongPassRes = await request('POST', '/api/auth/login', { email: 'wrong@wrong.com', password: 'wrong-password-123' });
  assert('Wrong credentials blocked with HTTP 401', wrongPassRes.statusCode === 401);

  // 3. Correct admin credentials
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@test.local';
  const adminPass  = process.env.ADMIN_PASSWORD || 'Admin@123456';
  const correctPassRes = await request('POST', '/api/auth/login', { email: adminEmail, password: adminPass });
  assert('Correct credentials login with HTTP 200 and role', correctPassRes.statusCode === 200 && correctPassRes.json?.role === 'admin');

  // Extract session cookie for subsequent authenticated requests
  const setCookieHeader = correctPassRes.headers?.['set-cookie'] || [];
  const sessionCookie = setCookieHeader.map(c => c.split(';')[0]).join('; ');
  const authHeaders = sessionCookie ? { 'Cookie': sessionCookie } : {};

  // 4. Authenticated request succeeds
  const authInfoRes = await request('POST', '/api/info', { url: SAMPLE_URL }, { ...authHeaders, 'x-test-enforce-auth': 'true' });
  assert('Authenticated request succeeds with HTTP 200', authInfoRes.statusCode === 200 && authInfoRes.json?.success);

  // TEST P: Malicious / Internal URL rejection on clips endpoint
  console.log('\n--- TEST P: Malicious/Internal URL Protection on Clips API ---');
  const clipSsrfRes = await request('POST', '/api/clips/generate', { url: 'http://169.254.169.254/latest' }, authHeaders);
  assert('Malicious SSRF blocked on clips endpoint', clipSsrfRes.statusCode === 400);

  // TEST A-E: Quality Selection from Metadata
  console.log('\n--- TEST A - F: Video Quality Selection & Format Availability ---');
  const infoData = authInfoRes.json;
  assert('Qualities list extracted from real formats', Array.isArray(infoData.qualities) && infoData.qualities.length > 0);
  console.log('   Available qualities:', infoData.qualities.map(q => q.label).join(', '));

  const hasBest = infoData.qualities.some(q => q.value === 'best');
  assert('TEST A: Best Quality option present', hasBest);

  const has720p = infoData.qualities.some(q => q.value === '720p' || q.value === '360p');
  assert('TEST C: 720p or 360p option present when available', has720p);

  // TEST H & I: Real Download Progress with MB/GB Display
  console.log('\n--- TEST H & I: Real Download Progress & MB/GB Formatting ---');
  await request('POST', '/api/test-reset-limits');
  const sseUrl = `/api/prepare-stream?url=${encodeURIComponent(SAMPLE_URL)}&title=${encodeURIComponent(infoData.title)}&quality=720p`;
  const events = await listenSSE(sseUrl, authHeaders);

  assert('SSE received events array', events.length > 0);
  const dlEvents = events.filter(e => e.stage === 'downloading');
  assert('TEST H: Real downloading events streamed', dlEvents.length > 0);

  const eventWithMB = dlEvents.find(e => e.downloaded && e.totalSize);
  if (eventWithMB) {
    console.log(`   Captured MB progress: ${eventWithMB.downloaded} / ${eventWithMB.totalSize}, Speed: ${eventWithMB.speed}, ETA: ${eventWithMB.eta}`);
    assert('TEST I: Real MB/GB downloaded vs total size displayed', true);
  } else {
    assert('TEST I: Downloaded progress contains valid byte/percentage data', dlEvents.some(e => e.percent > 0));
  }

  const readyEvent = events.find(e => e.stage === 'ready');
  assert('Download completed and reached ready stage with 100%', readyEvent && readyEvent.percent === 100);

  // TEST G: Video + audio separate streams merged
  console.log('\n--- TEST G: Video + Audio Streams in Output ---');
  const tempFile = path.join(__dirname, 'test_feature_out.mp4');
  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

  const fileReq = await new Promise((resolve) => {
    http.get(`${BASE_URL}/api/file/${readyEvent.downloadToken}`, (res) => {
      const out = fs.createWriteStream(tempFile);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ statusCode: res.statusCode })));
    });
  });

  assert('Client downloaded file with HTTP 200', fileReq.statusCode === 200);
  const mediaStreams = verifyMediaStreams(tempFile);
  console.log(`   Streams: Video=${mediaStreams.videoCodec}, Audio=${mediaStreams.audioCodec}, MP4=${mediaStreams.isMp4}`);
  assert('TEST G: Output contains VIDEO stream', mediaStreams.hasVideo);
  assert('TEST G: Output contains AUDIO stream', mediaStreams.hasAudio);
  assert('TEST G: Output is valid browser MP4 container', mediaStreams.isMp4);

  // TEST K, L, M, N: AI Viral Clips Engine
  console.log('\n--- TEST K, L, M, N: AI Viral Clips Generation, Preview & Download ---');
  await request('POST', '/api/test-reset-limits');
  console.log('Generating AI viral clips from source video...');
  const clipsRes = await request('POST', '/api/clips/generate', {
    url: SAMPLE_URL,
    title: infoData.title,
    isVertical: false
  }, authHeaders);

  assert('TEST K: Create Viral Clips endpoint returned HTTP 200', clipsRes.statusCode === 200 && clipsRes.json?.success);
  const clips = clipsRes.json?.clips || [];
  console.log(`   Generated ${clips.length} viral clips:`);
  clips.forEach(c => console.log(`   - [Clip #${c.index}] "${c.title}" (${c.duration}, Score: ${c.viralScore})`));

  assert('TEST L: Multiple meaningful clips generated (>= 3 clips)', clips.length >= 3);
  const firstClip = clips[0];
  assert('Clip metadata includes hook title and viral score', firstClip && firstClip.title && firstClip.viralScore > 80);

  // TEST M: Clip preview stream
  const previewRes = await request('GET', firstClip.previewUrl, null, authHeaders);
  assert('TEST M: Clip preview stream responds with HTTP 200', previewRes.statusCode === 200 && previewRes.headers['content-type'] === 'video/mp4');

  // TEST N: Clip download
  const downloadRes = await request('GET', firstClip.downloadUrl, null, authHeaders);
  assert('TEST N: Clip download responds with HTTP 200 attachment', downloadRes.statusCode === 200 && downloadRes.headers['content-disposition']?.includes('attachment'));

  // TEST R: Error Pass-Through & Non-Swallowing Verification
  console.log('\n--- TEST R: Error Pass-Through & Non-Swallowing Verification ---');
  await request('POST', '/api/test-reset-limits');
  const invalidHostRes = await request('POST', '/api/info', { url: 'https://non-existent-video-domain-xyz999.com/video/1' }, authHeaders);
  assert('TEST R: Non-existent domain returns clear HTTP 400 error message', invalidHostRes.statusCode === 400 && invalidHostRes.json?.error && !invalidHostRes.json.error.includes('object'));
  console.log(`   Captured error response: "${invalidHostRes.json?.error}"`);

  // Clean up test file
  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

  console.log(`\n===============================================================`);
  console.log(`   FEATURE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`===============================================================\n`);

  if (failed > 0) process.exit(1);
}

runFeatureTests().catch(err => {
  console.error('Fatal Feature Test Error:', err);
  process.exit(1);
});
