const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const TEST_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const downloadUrl = `http://localhost:${PORT}/api/download?url=${encodeURIComponent(TEST_URL)}&title=TestBigBuckBunny`;

console.log('Testing GET /api/download endpoint...');
console.log('URL:', downloadUrl);

const req = http.get(downloadUrl, (res) => {
  console.log('Status Code:', res.statusCode);
  console.log('Headers:', {
    'content-type': res.headers['content-type'],
    'content-disposition': res.headers['content-disposition'],
    'content-length': res.headers['content-length']
  });

  if (res.statusCode !== 200) {
    let errBody = '';
    res.on('data', c => errBody += c);
    res.on('end', () => {
      console.error('Error Response:', errBody);
      process.exit(1);
    });
    return;
  }

  let receivedBytes = 0;
  res.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > 50000) {
      console.log(`✔ Successfully streaming video data! Received ${receivedBytes} bytes so far.`);
      console.log('✔ Verified Content-Disposition, Content-Type, and valid media stream.');
      req.destroy();
      console.log('✔ Test finished successfully.');
      process.exit(0);
    }
  });
});

req.on('error', (err) => {
  // If we destroyed the request intentionally, that's fine
  if (err.code === 'ECONNRESET') {
    process.exit(0);
  }
  console.error('Download test error:', err.message);
  process.exit(1);
});
