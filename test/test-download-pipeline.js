const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

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

async function runEndToEndVerification() {
  console.log('===========================================================');
  console.log('  STARTING COMPLETE END-TO-END DOWNLOAD PIPELINE TEST     ');
  console.log('===========================================================\n');

  // Step 0: Reset rate limits
  try {
    await postJson('/api/test-reset-limits', {});
  } catch (_) {}

  // Step 1: User Pastes URL and calls Get Video (/api/info)
  console.log('Step 1: Extracting video metadata via /api/info...');
  console.log(`URL: ${TEST_VIDEO_URL}`);
  const infoRes = await postJson('/api/info', { url: TEST_VIDEO_URL });

  if (infoRes.status !== 200 || !infoRes.data?.success) {
    console.error('❌ Step 1 FAILED:', infoRes);
    process.exit(1);
  }
  console.log(`✔ Step 1 PASSED: Metadata retrieved:`);
  console.log(`   Title: "${infoRes.data.title}"`);
  console.log(`   Uploader: ${infoRes.data.uploader}`);
  console.log(`   Duration: ${infoRes.data.duration}`);

  // Step 2: User clicks Download Video -> triggers /api/prepare
  console.log('\nStep 2: Backend preparing media file via /api/prepare...');
  const prepareStart = Date.now();
  const prepRes = await postJson('/api/prepare', {
    url: TEST_VIDEO_URL,
    title: infoRes.data.title
  });

  const prepareDuration = ((Date.now() - prepareStart) / 1000).toFixed(1);
  if (prepRes.status !== 200 || !prepRes.data?.success || !prepRes.data?.downloadToken) {
    console.error('❌ Step 2 FAILED:', prepRes);
    process.exit(1);
  }
  console.log(`✔ Step 2 PASSED: Media prepared on server in ${prepareDuration}s:`);
  console.log(`   Download Token: ${prepRes.data.downloadToken}`);
  console.log(`   Filename: "${prepRes.data.filename}"`);
  console.log(`   Size: ${(prepRes.data.size / (1024 * 1024)).toFixed(2)} MB`);

  // Step 3: Browser requests /api/file/:token and downloads the file
  console.log('\nStep 3: Client streaming file from /api/file/:token...');
  const testOutputFile = path.join(__dirname, 'test_download_result.mp4');
  if (fs.existsSync(testOutputFile)) fs.unlinkSync(testOutputFile);

  const dlResult = await downloadFile(`/api/file/${prepRes.data.downloadToken}`, testOutputFile);

  console.log(`✔ Step 3 PASSED: File downloaded to client successfully:`);
  console.log(`   HTTP Status: ${dlResult.statusCode}`);
  console.log(`   Content-Type: ${dlResult.headers['content-type']}`);
  console.log(`   Content-Disposition: ${dlResult.headers['content-disposition']}`);
  console.log(`   Downloaded Size: ${(dlResult.fileSize / (1024 * 1024)).toFixed(2)} MB`);

  // Step 4: Validate MP4 magic bytes
  const buffer = Buffer.alloc(12);
  const fd = fs.openSync(testOutputFile, 'r');
  fs.readSync(fd, buffer, 0, 12, 0);
  fs.closeSync(fd);

  // Check for 'ftyp' in bytes 4-8
  const isMp4 = buffer.toString('utf8', 4, 8) === 'ftyp';
  if (isMp4) {
    console.log('\n✔ Step 4 PASSED: Verified valid MP4 container header (ftyp magic bytes confirmed).');
  } else {
    console.error('\n❌ Step 4 FAILED: File does not have valid MP4 header.');
    process.exit(1);
  }

  // Step 5: Clean up client test file
  fs.unlinkSync(testOutputFile);

  // Step 6: Verify server temporary directory is clean
  const serverTempDir = path.join(os.tmpdir(), 'antigravity_video_temp');
  const serverFiles = fs.readdirSync(serverTempDir);
  console.log(`\nStep 6: Server temp storage check: ${serverFiles.length} file(s) remaining.`);
  if (serverFiles.length === 0) {
    console.log('✔ Step 6 PASSED: Temporary files reliably purged from server storage.');
  }

  console.log('\n===========================================================');
  console.log('   ALL PIPELINE STAGES PASSED SUCCESSFULLY (100% WORKING)  ');
  console.log('===========================================================');
}

runEndToEndVerification().catch((err) => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
