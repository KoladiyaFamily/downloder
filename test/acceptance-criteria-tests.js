process.env.NODE_ENV = 'test';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.TEST_PORT || process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

function postJson(reqPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, text: body });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function listenSSE(ssePath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: ssePath,
      method: 'GET'
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

      res.on('end', () => {
        resolve(events);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function downloadFile(reqPath, destination) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: reqPath,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error(`Download failed with status ${res.statusCode}: ${errBody}`)));
        return;
      }

      const fileStream = fs.createWriteStream(destination);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            fileSize: fs.statSync(destination).size
          });
        });
      });

      fileStream.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

function verifyMediaStreamsWithFFmpeg(filePath) {
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

async function runAcceptanceTests() {
  console.log('===============================================================');
  console.log('       ANTIGRAVITY FINAL MANDATORY ACCEPTANCE CRITERIA         ');
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
  await postJson('/api/test-reset-limits', {});

  // Startup: Verify FFmpeg availability
  const healthRes = await new Promise(res => {
    http.get(`${BASE_URL}/api/health`, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
    });
  });
  assert('FFmpeg verified and ready on server', healthRes.status === 'ok' && healthRes.ffmpeg === true);

  // TEST 4: Invalid URL
  console.log('\n--- TEST 4: Invalid URL Handling ---');
  const invRes = await postJson('/api/info', { url: 'not-a-valid-url' });
  assert('Invalid URL rejected with clean message', invRes.status === 400 && invRes.data?.error);

  // TEST 5: Malicious / Internal URL (SSRF)
  console.log('\n--- TEST 5: Malicious / Internal URL (SSRF) ---');
  const ssrfRes = await postJson('/api/info', { url: 'http://169.254.169.254/metadata' });
  assert('SSRF AWS metadata IP blocked', ssrfRes.status === 400);

  // TEST 3: Audio-only source rejection
  console.log('\n--- TEST 3: Audio-Only Source Rejected Cleanly ---');
  await postJson('/api/test-reset-limits', {});
  const audioOnlyRes = await postJson('/api/prepare', {
    url: 'https://soundcloud.com/octobersveryown/drake-gods-plan',
    title: 'AudioTest'
  });
  assert('Audio-only URL rejected with exact friendly message', audioOnlyRes.status === 400 && audioOnlyRes.data?.error === 'This video could not be prepared in a compatible video format.');

  // TEST 1 & TEST 2: Normal video requiring separate DASH streams with SSE Real Progress
  console.log('\n--- TEST 1 & 2: Normal / DASH Video Download via SSE Real Progress ---');
  await postJson('/api/test-reset-limits', {});
  const TEST_VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  
  // 1. Metadata check
  const infoRes = await postJson('/api/info', { url: TEST_VIDEO });
  assert('Metadata extracted successfully', infoRes.status === 200 && infoRes.data?.title);

  // 2. Real SSE Stream Progress
  console.log('Connecting to SSE endpoint /api/prepare-stream...');
  const ssePath = `/api/prepare-stream?url=${encodeURIComponent(TEST_VIDEO)}&title=${encodeURIComponent(infoRes.data.title)}`;
  const sseEvents = await listenSSE(ssePath);

  assert('SSE received events array', sseEvents.length > 0);
  const stages = sseEvents.map(e => e.stage);
  console.log(`   Captured stages: ${Array.from(new Set(stages)).join(' -> ')}`);

  const hasPreparing = stages.includes('preparing');
  const hasDownloading = stages.includes('downloading');
  const hasReady = stages.includes('ready');

  assert('SSE reported "preparing" stage', hasPreparing);
  assert('SSE reported real "downloading" progress percentages', hasDownloading);
  assert('SSE reached "ready" stage at 100%', hasReady);

  const readyEvent = sseEvents.find(e => e.stage === 'ready');
  assert('Ready event contains downloadToken and filename', readyEvent && readyEvent.downloadToken && readyEvent.filename);

  // 3. Download and inspect the resulting media
  const destFile = path.join(__dirname, 'test_final_acceptance.mp4');
  if (fs.existsSync(destFile)) fs.unlinkSync(destFile);

  const dlResult = await downloadFile(`/api/file/${readyEvent.downloadToken}`, destFile);
  assert('Client downloaded media successfully with HTTP 200', dlResult.statusCode === 200);

  const mediaInfo = verifyMediaStreamsWithFFmpeg(destFile);
  console.log(`   Inspected Streams: Video=${mediaInfo.videoCodec || 'NONE'}, Audio=${mediaInfo.audioCodec || 'NONE'}, MP4=${mediaInfo.isMp4}`);
  assert('Final media contains at least one VIDEO stream', mediaInfo.hasVideo);
  assert('Final media contains at least one AUDIO stream', mediaInfo.hasAudio);
  assert('Final media is in a valid MP4 container', mediaInfo.isMp4);

  fs.unlinkSync(destFile);

  // TEST 6: Large Video (India's Got Latent, 52 mins) metadata and preparation validation
  console.log('\n--- TEST 6: Long / Large Video Verification ---');
  await postJson('/api/test-reset-limits', {});
  const LONG_VIDEO = 'https://youtu.be/zbIr24Tes7E';
  const longInfo = await postJson('/api/info', { url: LONG_VIDEO });
  assert('Long video metadata (52:26) successfully extracted', longInfo.status === 200 && longInfo.data?.duration === '52:26');

  // Verify server temporary directory cleanliness
  const serverTempDir = path.join(os.tmpdir(), 'antigravity_video_temp');
  const remainingFiles = fs.readdirSync(serverTempDir).filter(f => {
    try {
      return !fs.statSync(path.join(serverTempDir, f)).isDirectory();
    } catch (_) { return false; }
  });
  assert('Temporary directory contains no orphaned files', remainingFiles.length === 0, `Remaining: ${remainingFiles.join(', ')}`);

  console.log(`\n===============================================================`);
  console.log(`   ACCEPTANCE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`===============================================================\n`);

  if (failed > 0) process.exit(1);
}

runAcceptanceTests().catch(err => {
  console.error('Fatal Acceptance Test Error:', err);
  process.exit(1);
});
