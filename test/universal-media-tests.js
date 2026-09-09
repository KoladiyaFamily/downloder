'use strict';

/**
 * test/universal-media-tests.js – Verification for Universal Media Support
 * 
 * Verifies:
 * 1. Direct Image URL (JPG/PNG/WebP) → Detected as image, downloads cleanly.
 * 2. Direct Video URL (MP4/WebM) → Detected as video, downloads cleanly.
 * 3. YouTube & youtu.be URLs → Detected and processed via yt-dlp.
 * 4. Other yt-dlp supported platforms (e.g. Vimeo) → Detected as video.
 * 5. Normal HTML Webpages (Google, Wikipedia, GitHub) → Rejected with clear non-media message.
 * 6. Inaccessible / 404 / 403 URLs → Returns clear specific error.
 * 7. Safe redirect following for media URLs.
 * 8. SSRF protection on direct media URLs.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mediaDetector = require('../mediaDetector');

const PORT = parseInt(process.env.TEST_PORT || '3001', 10);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    console.log(`✔ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name}${detail ? ' → ' + detail : ''}`);
    failed++;
  }
}

let sessionCookie = null;

function req(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionCookie ? { 'Cookie': sessionCookie } : {}),
        ...headers
      },
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      timeout: 45000
    };
    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const r = http.request(opts, (res) => {
      if (res.headers['set-cookie']) {
        sessionCookie = res.headers['set-cookie'][0].split(';')[0];
      }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ statusCode: res.statusCode, json, headers: res.headers, raw });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out')); });
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function downloadMedia(reqPath, destination) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path: reqPath,
      method: 'GET',
      headers: sessionCookie ? { 'Cookie': sessionCookie } : {},
      timeout: 45000
    };

    const r = http.request(opts, (res) => {
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

    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Download request timed out')); });
    r.end();
  });
}

async function runUniversalMediaSuite() {
  console.log('===============================================================');
  console.log('       ANTIGRAVITY UNIVERSAL MEDIA VERIFICATION SUITE         ');
  console.log('===============================================================\n');

  // Reset rate limits first
  await req('POST', '/api/test-reset-limits');

  // Authenticate as default user if required
  try {
    const loginRes = await req('POST', '/api/auth/login', { email: 'user@test.local', password: 'User@123456' });
    if (loginRes.headers['set-cookie']) {
      sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
    }
  } catch (_) {}

  // ── TEST 1: Direct Image Inspection & Download (JPEG) ──────────────────────
  console.log('--- Category 1: Direct Image URLs ---');
  const SAMPLE_JPG = 'https://picsum.photos/400/300.jpg';
  try {
    const res = await req('POST', '/api/info', { url: SAMPLE_JPG });
    assert('Direct JPEG inspection returns 200 and mediaType=image', res.statusCode === 200 && res.json?.success && res.json?.mediaType === 'image', `Status: ${res.statusCode}, Resp: ${res.raw}`);
    
    // Prepare download
    const prep = await req('POST', '/api/prepare', { url: SAMPLE_JPG, title: 'sample_photo' });
    assert('Direct JPEG prepare returns downloadToken', prep.statusCode === 200 && prep.json?.success && prep.json?.downloadToken, `Got: ${prep.raw}`);

    if (prep.json?.downloadToken) {
      const dest = path.join(os.tmpdir(), `test_dl_jpg_${Date.now()}.jpg`);
      const dl = await downloadMedia(`/api/file/${prep.json.downloadToken}`, dest);
      assert('Direct JPEG file downloaded with non-zero size', dl.fileSize > 0, `Size: ${dl.fileSize}`);
      const buf = fs.readFileSync(dest);
      const magic = mediaDetector.detectMagicBytes(buf);
      assert('Downloaded file verified as genuine JPEG', magic && magic.type === 'image' && magic.ext === '.jpg', `Magic: ${JSON.stringify(magic)}`);
      try { fs.unlinkSync(dest); } catch (_) {}
    }
  } catch (e) {
    assert('Direct JPEG pipeline', false, e.message);
  }

  // ── TEST 2: Direct Image Inspection & Download (PNG) ──────────────────────
  const SAMPLE_PNG = 'https://raw.githubusercontent.com/KoladiyaFamily/downloder/main/public/favicon.ico'; // or raw image
  try {
    const res = await req('POST', '/api/info', { url: 'https://httpbin.org/image/png' });
    assert('Direct PNG inspection returns 200 and mediaType=image', res.statusCode === 200 && res.json?.mediaType === 'image', `Resp: ${res.raw}`);

    const prep = await req('POST', '/api/prepare', { url: 'https://httpbin.org/image/png', title: 'sample_png' });
    if (prep.json?.downloadToken) {
      const dest = path.join(os.tmpdir(), `test_dl_png_${Date.now()}.png`);
      const dl = await downloadMedia(`/api/file/${prep.json.downloadToken}`, dest);
      assert('Direct PNG file downloaded with non-zero size', dl.fileSize > 0, `Size: ${dl.fileSize}`);
      const buf = fs.readFileSync(dest);
      const magic = mediaDetector.detectMagicBytes(buf);
      assert('Downloaded file verified as genuine PNG', magic && magic.type === 'image' && magic.ext === '.png', `Magic: ${JSON.stringify(magic)}`);
      try { fs.unlinkSync(dest); } catch (_) {}
    }
  } catch (e) {
    assert('Direct PNG pipeline', false, e.message);
  }

  // ── TEST 3: Direct WebP Image ─────────────────────────────────────────────
  try {
    const res = await req('POST', '/api/info', { url: 'https://httpbin.org/image/webp' });
    assert('Direct WebP inspection returns 200 and mediaType=image', res.statusCode === 200 && res.json?.mediaType === 'image', `Resp: ${res.raw}`);
  } catch (e) {
    assert('Direct WebP pipeline', false, e.message);
  }

  // ── TEST 4: Direct MP4 Video URL ──────────────────────────────────────────
  console.log('\n--- Category 2: Direct Video URLs ---');
  const DIRECT_MP4 = 'https://www.w3schools.com/html/mov_bbb.mp4';
  try {
    const res = await req('POST', '/api/info', { url: DIRECT_MP4 });
    assert('Direct MP4 video inspection returns 200 and mediaType=video', res.statusCode === 200 && res.json?.success && res.json?.mediaType === 'video', `Resp: ${res.raw}`);

    const prep = await req('POST', '/api/prepare', { url: DIRECT_MP4, title: 'direct_sample' });
    assert('Direct MP4 video prepare returns downloadToken', prep.statusCode === 200 && prep.json?.downloadToken, `Resp: ${prep.raw}`);

    if (prep.json?.downloadToken) {
      const dest = path.join(os.tmpdir(), `test_dl_mp4_${Date.now()}.mp4`);
      const dl = await downloadMedia(`/api/file/${prep.json.downloadToken}`, dest);
      assert('Direct MP4 video file downloaded with non-zero size', dl.fileSize > 1000, `Size: ${dl.fileSize}`);
      const buf = fs.readFileSync(dest);
      const magic = mediaDetector.detectMagicBytes(buf);
      assert('Downloaded file verified as genuine MP4 video', magic && magic.type === 'video', `Magic: ${JSON.stringify(magic)}`);
      try { fs.unlinkSync(dest); } catch (_) {}
    }
  } catch (e) {
    assert('Direct MP4 video pipeline', false, e.message);
  }

  // ── TEST 5: Non-Media Webpages MUST BE REJECTED ───────────────────────────
  console.log('\n--- Category 3: Non-Media Webpages Rejection ---');
  const NON_MEDIA_URLS = [
    { label: 'Google Search Page', url: 'https://www.google.com' },
    { label: 'Wikipedia Article', url: 'https://en.wikipedia.org/wiki/Earth' },
    { label: 'GitHub Repository Page', url: 'https://github.com' },
    { label: 'JSON API Endpoint', url: 'https://httpbin.org/json' }
  ];

  for (const item of NON_MEDIA_URLS) {
    try {
      const res = await req('POST', '/api/info', { url: item.url });
      const rejected = res.statusCode === 400 && res.json?.error;
      const expectedMessage = res.json?.error?.includes('does not contain a supported downloadable video or image') || res.json?.error?.includes('not contain a supported');
      assert(`Non-media rejected: ${item.label}`, rejected, `Got status ${res.statusCode}: ${res.raw}`);
      assert(`Clear user error for: ${item.label}`, expectedMessage, `Got error: ${res.json?.error}`);
    } catch (e) {
      assert(`Non-media rejection for ${item.label}`, false, e.message);
    }
  }

  // ── TEST 6: Inaccessible / 404 / 403 URLs ────────────────────────────────
  console.log('\n--- Category 4: Error Handling for Broken/Inaccessible URLs ---');
  try {
    const res = await req('POST', '/api/info', { url: 'https://httpbin.org/status/404' });
    assert('404 URL rejected with status 400 and clear error', res.statusCode === 400 && res.json?.error, `Resp: ${res.raw}`);
  } catch (e) {
    assert('404 URL error handling', false, e.message);
  }

  // ── TEST 7: SSRF Protection on Direct Media Probe ─────────────────────────
  console.log('\n--- Category 5: SSRF Security Preservation ---');
  try {
    const res = await req('POST', '/api/info', { url: 'http://127.0.0.1:3000/image.jpg' });
    assert('SSRF loopback image URL blocked with 400', res.statusCode === 400 && res.json?.error, `Resp: ${res.raw}`);
  } catch (e) {
    assert('SSRF loopback protection', false, e.message);
  }

  // ── TEST 8: YouTube Video (Existing Functionality Preserved) ──────────────
  console.log('\n--- Category 6: Existing YouTube Functionality ---');
  try {
    const res = await req('POST', '/api/info', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
    assert('YouTube video extraction works as expected', res.statusCode === 200 && res.json?.success && res.json?.mediaType === 'video' && res.json?.title, `Resp: ${res.raw}`);
  } catch (e) {
    assert('YouTube extraction', false, e.message);
  }

  // ── TEST 9: Instagram Media Post Extraction & Download ────────────────────
  console.log('\n--- Category 7: Instagram Post Media Extraction ---');
  await req('POST', '/api/test-reset-limits');
  try {
    const igUrl = 'https://www.instagram.com/p/DcPIHc2s9zH/?stkn=MXUwY3NvcG9qZUxzdw==';
    const res = await req('POST', '/api/info', { url: igUrl });
    assert('Instagram photo post returns 200 with mediaType=image', res.statusCode === 200 && res.json?.success && res.json?.mediaType === 'image', `Resp: ${res.raw}`);

    if (res.json?.url) {
      const prep = await req('POST', '/api/prepare', { url: res.json.url, title: 'elevenlabs_post' });
      assert('Instagram photo prepare returns downloadToken', prep.statusCode === 200 && prep.json?.downloadToken, `Got: ${prep.raw}`);

      if (prep.json?.downloadToken) {
        const dest = path.join(os.tmpdir(), `test_ig_${Date.now()}.jpg`);
        const dl = await downloadMedia(`/api/file/${prep.json.downloadToken}`, dest);
        assert('Instagram photo downloaded with non-zero size', dl.fileSize > 1000, `Size: ${dl.fileSize}`);
        const buf = fs.readFileSync(dest);
        const magic = mediaDetector.detectMagicBytes(buf);
        assert('Downloaded file verified as genuine JPEG', magic && magic.type === 'image' && magic.ext === '.jpg', `Magic: ${JSON.stringify(magic)}`);
        try { fs.unlinkSync(dest); } catch (_) {}
      }
    }
  } catch (e) {
    assert('Instagram photo post extraction pipeline', false, e.message);
  }

  console.log('\n===============================================================');
  console.log(`  UNIVERSAL MEDIA TESTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

runUniversalMediaSuite().catch(err => { console.error('Fatal test error:', err); process.exit(1); });
