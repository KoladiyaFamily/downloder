const fs = require('fs');
const path = require('path');
const os = require('os');

async function runPrivacySuite() {
  console.log('===============================================================');
  console.log('       ANTIGRAVITY PRIVACY & ZERO URL STORAGE TEST SUITE      ');
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

  // TEST 1: Database Persistence Verification
  console.log('--- TEST 1: Application Database Privacy ---');
  const dbPath = path.join(__dirname, '..', 'data', 'users.json');
  if (fs.existsSync(dbPath)) {
    const dbRaw = fs.readFileSync(dbPath, 'utf8');
    const hasUrls = /https?:\/\//i.test(dbRaw);
    assert('users.json contains zero submitted URLs or URL fields', !hasUrls, 'Found HTTP/HTTPS URL string in users.json');
    
    try {
      const dbJson = JSON.parse(dbRaw);
      const keys = Object.keys(dbJson.users || {});
      let urlFieldFound = false;
      for (const k of keys) {
        const u = dbJson.users[k];
        if (u.url || u.download_url || u.history || u.downloads) {
          urlFieldFound = true;
          break;
        }
      }
      assert('User schema has no URL or download history fields', !urlFieldFound, 'User object contains URL or download history property');
    } catch (err) {
      assert('users.json is valid JSON', false, err.message);
    }
  } else {
    assert('users.json exists or database clean', true);
  }

  // TEST 2: Source Code Console Logging Audit
  console.log('\n--- TEST 2: Source Code Log Audit ---');
  const filesToAudit = [
    path.join(__dirname, '..', 'server.js'),
    path.join(__dirname, '..', 'auth', 'db.js'),
    path.join(__dirname, '..', 'auth', 'middleware.js'),
    path.join(__dirname, '..', 'auth', 'routes.js'),
    path.join(__dirname, '..', 'viralClipsEngine.js')
  ];

  let urlLoggerFound = false;
  for (const filePath of filesToAudit) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/console\.(log|info|warn|error)\s*\(.*(url|cleanUrl|inputUrl).*\)/i.test(line)) {
          urlLoggerFound = true;
          console.error(`  Warning in ${path.basename(filePath)}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert('Application source code has zero URL console logging statements', !urlLoggerFound, 'Found console logging statement referencing URL variable');

  // TEST 3: Temporary Files Directory Audit
  console.log('\n--- TEST 3: Temporary Runtime Directory Audit ---');
  const tempDir = path.join(os.tmpdir(), 'antigravity_video_temp');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    let invalidFilenameFound = false;
    for (const f of files) {
      if (f.startsWith('http') || f.includes('://') || f.includes('youtube') || f.includes('vimeo')) {
        invalidFilenameFound = true;
        break;
      }
    }
    assert('Temporary media files use clean sanitized/UUID filenames without URLs', !invalidFilenameFound, 'Found temporary file with URL in filename');
  } else {
    assert('Temporary download directory clean', true);
  }

  // TEST 4: Frontend Browser Storage Audit
  console.log('\n--- TEST 4: Frontend Browser Storage Audit ---');
  const publicDir = path.join(__dirname, '..', 'public');
  let browserUrlStorageFound = false;
  if (fs.existsSync(publicDir)) {
    const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html') || f.endsWith('.js'));
    for (const file of htmlFiles) {
      const content = fs.readFileSync(path.join(publicDir, file), 'utf8');
      if (/(localStorage|sessionStorage)\.setItem\s*\(\s*['"](url|download_url|history)/i.test(content)) {
        browserUrlStorageFound = true;
      }
    }
  }
  assert('Frontend HTML/JS scripts do not save URLs to localStorage/sessionStorage', !browserUrlStorageFound, 'Found localStorage/sessionStorage setter for URL');

  console.log(`\n===============================================================`);
  console.log(`   PRIVACY TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`===============================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPrivacySuite().catch((err) => {
  console.error('Fatal error running privacy suite:', err);
  process.exit(1);
});
