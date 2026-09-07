const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = 3001;
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

function inspectStreamsWithFFmpeg(filePath) {
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

async function runMediaVerification() {
  console.log('===============================================================');
  console.log('      MEDIA PIPELINE VERIFICATION: VIDEO + AUDIO STREAMS       ');
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

  // Check 1: Verify FFmpeg availability on server
  const health = await postJson('/api/health', {});
  // health was GET, so let's call GET /api/health
  const healthRes = await new Promise(res => {
    http.get(`${BASE_URL}/api/health`, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
    });
  });
  assert('FFmpeg verified and ready on server', healthRes.status === 'ok' && healthRes.ffmpeg === true);

  // Reset rate limits for test suite
  await postJson('/api/test-reset-limits', {});

  // Scenario 1: High-Resolution Video with Separate Video + Audio Streams (YouTube DASH)
  console.log('\n--- Scenario 1: Separate DASH Video and Audio Streams ---');
  const DASH_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  console.log(`Preparing: ${DASH_URL}`);
  const prep1 = await postJson('/api/prepare', { url: DASH_URL, title: 'BlenderTest' });

  assert('Server prepared DASH video successfully', prep1.status === 200 && prep1.data?.downloadToken, JSON.stringify(prep1));

  if (prep1.data?.downloadToken) {
    const dest1 = path.join(__dirname, 'test_scenario_dash.mp4');
    if (fs.existsSync(dest1)) fs.unlinkSync(dest1);

    const dl1 = await downloadFile(`/api/file/${prep1.data.downloadToken}`, dest1);
    assert('File downloaded with HTTP 200 and Content-Type video/mp4', dl1.statusCode === 200 && dl1.headers['content-type'] === 'video/mp4');

    const streamInfo = inspectStreamsWithFFmpeg(dest1);
    console.log(`   Stream inspection: Video=${streamInfo.videoCodec || 'NONE'}, Audio=${streamInfo.audioCodec || 'NONE'}, MP4=${streamInfo.isMp4}`);
    assert('Output contains at least one VIDEO stream', streamInfo.hasVideo);
    assert('Output contains at least one AUDIO stream', streamInfo.hasAudio);
    assert('Output is a valid MP4 container', streamInfo.isMp4);

    if (fs.existsSync(dest1)) fs.unlinkSync(dest1);
  }

  // Scenario 2: Audio-Only Source Must Be REJECTED
  console.log('\n--- Scenario 2: Audio-Only Content Must Be Strictly Rejected ---');
  await postJson('/api/test-reset-limits', {});
  // Submitting an audio-only track (e.g. from an audio-only platform or podcast)
  const AUDIO_ONLY_URL = 'https://soundcloud.com/octobersveryown/drake-gods-plan';
  console.log(`Testing audio-only URL: ${AUDIO_ONLY_URL}`);
  const prepAudio = await postJson('/api/prepare', { url: AUDIO_ONLY_URL, title: 'AudioTrack' });

  assert(
    'Audio-only source rejected with "This video could not be prepared in a compatible video format."',
    prepAudio.status === 400 && prepAudio.data?.error === 'This video could not be prepared in a compatible video format.',
    `Status: ${prepAudio.status}, Resp: ${JSON.stringify(prepAudio.data)}`
  );

  console.log(`\n===============================================================`);
  console.log(`      MEDIA VERIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`===============================================================\n`);

  if (failed > 0) process.exit(1);
}

runMediaVerification().catch(err => {
  console.error('Fatal Verification Error:', err);
  process.exit(1);
});
