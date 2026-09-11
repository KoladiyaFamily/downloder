'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
const mediaDetector = require('../mediaDetector');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let sessionCookie = null;
let passedCount = 0;
let failedCount = 0;

function logPass(desc) {
  console.log(`✔ PASS: ${desc}`);
  passedCount++;
}

function logFail(desc, detail) {
  console.error(`✖ FAIL: ${desc} -> ${detail || ''}`);
  failedCount++;
}

function assert(desc, condition, detail) {
  if (condition) logPass(desc);
  else logFail(desc, detail);
}

// HTTP request helper supporting cookies and multipart uploads
function makeRequest({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(reqPath, BASE_URL);
    const reqHeaders = { ...headers };
    if (sessionCookie) {
      reqHeaders['Cookie'] = sessionCookie;
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      // Capture set-cookie
      const setCookies = res.headers['set-cookie'];
      if (setCookies && Array.isArray(setCookies)) {
        sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        const rawStr = rawBuf.toString('utf8');
        let json = null;
        try { json = JSON.parse(rawStr); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBuf,
          raw: rawStr,
          json
        });
      });
    });

    req.on('error', reject);
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else if (typeof body === 'string') {
        req.write(body);
      }
    }
    req.end();
  });
}

// Helper to build multipart/form-data body
function buildMultipartBody(fieldName, filename, fileBuffer, mimeType) {
  const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  return {
    boundary,
    body,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// Generate test PNG image using simple RGB buffer or canvas/ffmpeg
function createSamplePng(filePath) {
  // Use FFmpeg to generate a clean test image with a visible watermark square
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=blue:s=320x240:d=1',
    '-vf', 'drawbox=x=220:y=20:w=80:h=40:color=red@1:t=fill',
    '-vframes', '1',
    filePath
  ];
  spawnSync(ffmpegPath, args, { shell: false });
  return fs.existsSync(filePath);
}

// Generate test MP4 video with video and audio tracks
function createSampleMp4(filePath) {
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:duration=2',
    '-vf', 'drawbox=x=220:y=20:w=80:h=40:color=yellow@1:t=fill',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    filePath
  ];
  spawnSync(ffmpegPath, args, { shell: false });
  return fs.existsSync(filePath);
}

async function runWatermarkTestSuite() {
  console.log('===============================================================');
  console.log('       ANTIGRAVITY WATERMARK REMOVER VERIFICATION SUITE        ');
  console.log('===============================================================\n');

  const tmpTestDir = path.join(os.tmpdir(), `wm_test_${Date.now()}`);
  fs.mkdirSync(tmpTestDir, { recursive: true });

  const samplePngPath = path.join(tmpTestDir, 'sample_watermark.png');
  const sampleMp4Path = path.join(tmpTestDir, 'sample_watermark.mp4');
  const fakeFilePath = path.join(tmpTestDir, 'fake_image.png');

  createSamplePng(samplePngPath);
  createSampleMp4(sampleMp4Path);
  fs.writeFileSync(fakeFilePath, 'THIS IS NOT AN IMAGE OR VIDEO CONTENT - SPOOFED');

  const pngBuffer = fs.readFileSync(samplePngPath);
  const mp4Buffer = fs.readFileSync(sampleMp4Path);
  const fakeBuffer = fs.readFileSync(fakeFilePath);

  // Reset rate limits on test server
  await makeRequest({ method: 'POST', reqPath: '/api/test-reset-limits' });

  // ── TEST 1: Unauthenticated Upload Rejection ───────────────────────────────
  console.log('--- Step 1: Authentication & Authorization ---');
  try {
    const mp = buildMultipartBody('file', 'test.png', pngBuffer, 'image/png');
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/upload',
      headers: {
        'Content-Type': mp.contentType,
        'Content-Length': mp.body.length,
        'x-test-enforce-auth': '1'
      },
      body: mp.body
    });
    assert('Unauthenticated POST /api/watermark/upload rejected (401)', res.statusCode === 401, `Status: ${res.statusCode}`);
  } catch (e) {
    assert('Unauthenticated rejection', false, e.message);
  }

  // Reset rate limits before login
  await makeRequest({ method: 'POST', reqPath: '/api/test-reset-limits' });

  // Authenticate as regular user
  try {
    const loginRes = await makeRequest({
      method: 'POST',
      reqPath: '/api/auth/login',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@test.local', password: 'User@123456' })
    });
    assert('Authenticated as user@test.local (200)', loginRes.statusCode === 200 && loginRes.json?.authenticated === true, `Resp: ${loginRes.raw}`);
  } catch (e) {
    assert('Login for test suite', false, e.message);
  }

  // ── TEST 2: Image Upload & Keyframe Extraction ─────────────────────────────
  console.log('\n--- Step 2: Image Upload & Metadata Extraction ---');
  let imageFileId = null;
  try {
    const mp = buildMultipartBody('file', 'sample_watermark.png', pngBuffer, 'image/png');
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/upload',
      headers: { 'Content-Type': mp.contentType, 'Content-Length': mp.body.length },
      body: mp.body
    });
    assert('Image upload returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}, Resp: ${res.raw}`);
    assert('Image upload response contains fileId and mediaType="image"', res.json?.success && res.json?.mediaType === 'image' && !!res.json?.fileId, `Resp: ${res.raw}`);
    assert('Image dimensions correctly detected (320x240)', res.json?.width === 320 && res.json?.height === 240, `Dimensions: ${res.json?.width}x${res.json?.height}`);
    imageFileId = res.json?.fileId;
  } catch (e) {
    assert('Image upload step', false, e.message);
  }

  // ── TEST 3: Image Preview Endpoint ─────────────────────────────────────────
  console.log('\n--- Step 3: Image Preview Serving ---');
  try {
    const res = await makeRequest({
      method: 'GET',
      reqPath: `/api/watermark/preview/${imageFileId}`
    });
    assert('GET /api/watermark/preview/:fileId returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}`);
    assert('Preview returns image content-type', res.headers['content-type']?.includes('image'), `Content-Type: ${res.headers['content-type']}`);
    assert('Preview buffer has non-zero size', res.rawBuf.length > 500, `Size: ${res.rawBuf.length}`);
  } catch (e) {
    assert('Image preview step', false, e.message);
  }

  // ── TEST 4: Image Inpainting Execution (Telea & Navier-Stokes) ────────────
  console.log('\n--- Step 4: Image Watermark Inpainting ---');
  let imageProcessId = null;
  try {
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/process',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: imageFileId,
        box: { x: 220, y: 20, width: 80, height: 40 },
        inpaintMethod: 'telea'
      })
    });
    assert('POST /api/watermark/process returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}, Resp: ${res.raw}`);
    assert('Response contains processId, resultPreviewUrl, downloadUrl', res.json?.success && !!res.json?.processId && !!res.json?.downloadUrl, `Resp: ${res.raw}`);
    imageProcessId = res.json?.processId;
  } catch (e) {
    assert('Image inpainting step', false, e.message);
  }

  // ── TEST 5: Download Cleaned Image ─────────────────────────────────────────
  console.log('\n--- Step 5: Cleaned Image Download & Verification ---');
  try {
    const res = await makeRequest({
      method: 'GET',
      reqPath: `/api/watermark/download/${imageProcessId}`
    });
    assert('GET /api/watermark/download/:processId returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}`);
    assert('Download response has attachment header', res.headers['content-disposition']?.includes('attachment'), `Header: ${res.headers['content-disposition']}`);
    const magic = mediaDetector.detectMagicBytes(res.rawBuf);
    assert('Cleaned file verified as valid Image', magic && magic.type === 'image', `Magic: ${JSON.stringify(magic)}`);
  } catch (e) {
    assert('Image download step', false, e.message);
  }

  // ── TEST 6: Video Upload & Metadata Extraction ────────────────────────────
  console.log('\n--- Step 6: Video Upload & Keyframe Extraction ---');
  let videoFileId = null;
  try {
    const mp = buildMultipartBody('file', 'sample_watermark.mp4', mp4Buffer, 'video/mp4');
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/upload',
      headers: { 'Content-Type': mp.contentType, 'Content-Length': mp.body.length },
      body: mp.body
    });
    assert('Video upload returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}, Resp: ${res.raw}`);
    assert('Video upload response contains fileId and mediaType="video"', res.json?.success && res.json?.mediaType === 'video' && !!res.json?.fileId, `Resp: ${res.raw}`);
    assert('Video duration and audio detected', res.json?.durationSec > 0 && res.json?.hasAudio === true, `Duration: ${res.json?.durationSec}, hasAudio: ${res.json?.hasAudio}`);
    videoFileId = res.json?.fileId;
  } catch (e) {
    assert('Video upload step', false, e.message);
  }

  // ── TEST 7: Video Representative Frame Preview ────────────────────────────
  console.log('\n--- Step 7: Video Representative Keyframe Preview ---');
  try {
    const res = await makeRequest({
      method: 'GET',
      reqPath: `/api/watermark/preview/${videoFileId}`
    });
    assert('GET /api/watermark/preview/:fileId for video returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}`);
    assert('Keyframe preview returns JPEG content-type', res.headers['content-type']?.includes('image/jpeg'), `Content-Type: ${res.headers['content-type']}`);
    assert('Keyframe preview buffer has non-zero size', res.rawBuf.length > 500, `Size: ${res.rawBuf.length}`);
  } catch (e) {
    assert('Video keyframe preview step', false, e.message);
  }

  // ── TEST 8: Video Inpainting Execution (Static Mode) ──────────────────────
  console.log('\n--- Step 8: Video Watermark Inpainting (Static Delogo) ---');
  let videoProcessId = null;
  try {
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/process',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: videoFileId,
        box: { x: 220, y: 20, width: 80, height: 40 },
        mode: 'static'
      })
    });
    assert('Video static inpainting returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}, Resp: ${res.raw}`);
    assert('Response contains processId, resultPreviewUrl, downloadUrl', res.json?.success && !!res.json?.processId && !!res.json?.downloadUrl, `Resp: ${res.raw}`);
    videoProcessId = res.json?.processId;
  } catch (e) {
    assert('Video static inpainting step', false, e.message);
  }

  // ── TEST 9: Download Cleaned Video & Verify Audio / Video Integrity ────────
  console.log('\n--- Step 9: Cleaned Video Download & Stream Integrity ---');
  try {
    const res = await makeRequest({
      method: 'GET',
      reqPath: `/api/watermark/download/${videoProcessId}`
    });
    assert('GET /api/watermark/download/:processId for video returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}`);
    assert('Video download has attachment header', res.headers['content-disposition']?.includes('attachment'), `Header: ${res.headers['content-disposition']}`);
    const magic = mediaDetector.detectMagicBytes(res.rawBuf);
    assert('Cleaned file verified as valid Video container (MP4)', magic && magic.type === 'video', `Magic: ${JSON.stringify(magic)}`);

    // Verify audio stream is preserved in output
    const outTestFile = path.join(tmpTestDir, 'cleaned_output.mp4');
    fs.writeFileSync(outTestFile, res.rawBuf);
    const probeRes = spawnSync(ffmpegPath, ['-i', outTestFile], { shell: false });
    const probeStderr = probeRes.stderr.toString();
    assert('Audio stream is preserved in cleaned video', /Stream #\d+:\d+.*?: Audio:/i.test(probeStderr), 'Audio stream check');
    assert('Video stream is preserved in cleaned video', /Stream #\d+:\d+.*?: Video:/i.test(probeStderr), 'Video stream check');
  } catch (e) {
    assert('Video download step', false, e.message);
  }

  // ── TEST 10: Video Inpainting Execution (Moving Mode) ─────────────────────
  console.log('\n--- Step 10: Video Watermark Inpainting (Moving Tracking Mode) ---');
  try {
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/process',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: videoFileId,
        box: { x: 220, y: 20, width: 80, height: 40 },
        mode: 'moving',
        inpaintMethod: 'telea'
      })
    });
    assert('Video moving inpainting returns 200 OK', res.statusCode === 200, `Status: ${res.statusCode}, Resp: ${res.raw}`);
    assert('Moving inpainting generates valid processId', res.json?.success && !!res.json?.processId, `Resp: ${res.raw}`);
  } catch (e) {
    assert('Video moving inpainting step', false, e.message);
  }

  // ── TEST 11: Spoofed File Signature Rejection ─────────────────────────────
  console.log('\n--- Step 11: Security & Spoofed File Validation ---');
  await makeRequest({ method: 'POST', reqPath: '/api/test-reset-limits' });
  try {
    const mp = buildMultipartBody('file', 'fake.png', fakeBuffer, 'image/png');
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/upload',
      headers: { 'Content-Type': mp.contentType, 'Content-Length': mp.body.length },
      body: mp.body
    });
    assert('Spoofed text file with .png extension rejected (400)', res.statusCode === 400 && res.json?.error, `Status: ${res.statusCode}, Resp: ${res.raw}`);
  } catch (e) {
    assert('Spoofed file rejection step', false, e.message);
  }

  // ── TEST 12: Invalid / Out-of-Bounds Coordinates Validation ───────────────
  console.log('\n--- Step 12: Boundary & Input Validation ---');
  await makeRequest({ method: 'POST', reqPath: '/api/test-reset-limits' });
  try {
    const res = await makeRequest({
      method: 'POST',
      reqPath: '/api/watermark/process',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: imageFileId,
        box: { x: -50, y: -20, width: 0, height: -10 }
      })
    });
    assert('Invalid/negative coordinates rejected (400)', res.statusCode === 400 && res.json?.error, `Status: ${res.statusCode}, Resp: ${res.raw}`);
  } catch (e) {
    assert('Invalid coordinates rejection step', false, e.message);
  }

  // Cleanup test artifacts
  try {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n===============================================================');
  console.log(`   WATERMARK TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('===============================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runWatermarkTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
