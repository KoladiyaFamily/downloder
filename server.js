const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const viralClipsEngine = require('./viralClipsEngine');

const app = express();

// Disable x-powered-by header
app.disable('x-powered-by');

// Security & Anti-Indexing Headers Middleware
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; media-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});

// JSON parser with strict limit
app.use(express.json({ limit: '10kb' }));

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'ignore',
  index: 'index.html',
  maxAge: '1h'
}));

// STRICT FFMPEG VERIFICATION AT STARTUP
function verifyFFmpeg() {
  if (ffmpegPath && typeof ffmpegPath === 'string' && fs.existsSync(ffmpegPath)) {
    try {
      const res = spawnSync(ffmpegPath, ['-version'], { shell: false });
      if (res.status === 0) {
        console.log(`✔ FFmpeg VERIFIED: ${ffmpegPath}`);
        return { available: true, path: ffmpegPath };
      }
    } catch (_) {}
  }

  // Fallback to system ffmpeg binary
  try {
    const sysRes = spawnSync('ffmpeg', ['-version'], { shell: false });
    if (sysRes.status === 0) {
      console.log('✔ FFmpeg VERIFIED: system ffmpeg binary');
      return { available: true, path: 'ffmpeg' };
    }
  } catch (_) {}

  console.error('FATAL: FFmpeg binary could not be found or executed.');
  return { available: false, path: null };
}

const ffmpegCheck = verifyFFmpeg();
const isFFmpegReady = ffmpegCheck.available;
const activeFFmpegPath = ffmpegCheck.path || ffmpegPath;

// Determine available python command (python vs python3)
let pythonCmd = 'python';
try {
  const pCheck = spawnSync('python', ['--version'], { shell: false });
  if (pCheck.status !== 0) {
    pythonCmd = 'python3';
  }
} catch (_) {
  pythonCmd = 'python3';
}

// Temporary download directory
const TEMP_DIR = path.join(os.tmpdir(), 'antigravity_video_temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// In-memory store for prepared downloads: token -> { filePath, filename, contentType, size, createdAt }
const preparedDownloads = new Map();

// Periodic cleanup of temp files and prepared downloads older than 10 minutes
function cleanupOldTempFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;
        if (now - stat.mtimeMs > 10 * 60 * 1000) {
          fs.unlink(filePath, () => {});
        }
      } catch (_) {}
    }
  } catch (_) {}

  const now = Date.now();
  for (const [token, data] of preparedDownloads.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      try { fs.unlinkSync(data.filePath); } catch (_) {}
      preparedDownloads.delete(token);
    }
  }
}
cleanupOldTempFiles();
setInterval(cleanupOldTempFiles, 5 * 60 * 1000);

// In-memory rate limiter per IP
const rateLimits = new Map();
function rateLimiter(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const clientRecord = rateLimits.get(ip) || [];

    const activeRequests = clientRecord.filter(t => now - t < windowMs);

    if (activeRequests.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    activeRequests.push(now);
    rateLimits.set(ip, activeRequests);
    next();
  };
}

// Testing hook to reset rate limits
if (process.env.NODE_ENV === 'test') {
  app.post('/api/test-reset-limits', (req, res) => {
    rateLimits.clear();
    res.json({ ok: true });
  });
}

// Global active download concurrency counter (prevent denial of service)
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 8;

// =========================================================================
// PRIVATE ACCESS & AUTHENTICATION
// =========================================================================
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity2026';
const authenticatedSessions = new Set();

function extractToken(req) {
  if (req.headers['x-app-auth']) return req.headers['x-app-auth'];
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.slice(7).trim();
  }
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)app_session=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  if (req.query && req.query.auth_token) {
    return req.query.auth_token;
  }
  return null;
}

function requireAuth(req, res, next) {
  // Enforce auth in production, or if TEST_REQUIRE_AUTH is set, or if test explicitly requests auth check
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_REQUIRE_AUTH && !req.headers['x-test-enforce-auth']) {
    return next();
  }
  const token = extractToken(req);
  if (token && authenticatedSessions.has(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required. Please enter password to unlock.' });
}

// Rate limiter for login attempts (5 attempts per minute per IP)
const authLimiter = rateLimiter(5, 60 * 1000);

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required.' });
  }

  const passBuf = Buffer.from(password);
  const targetBuf = Buffer.from(APP_PASSWORD);
  const isMatch = passBuf.length === targetBuf.length && crypto.timingSafeEqual(passBuf, targetBuf);

  if (!isMatch) {
    return res.status(401).json({ error: 'Incorrect password. Access denied.' });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  authenticatedSessions.add(sessionToken);

  res.setHeader('Set-Cookie', `app_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  return res.json({ success: true, token: sessionToken });
});

// GET /api/auth/status
app.get('/api/auth/status', (req, res) => {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_REQUIRE_AUTH) {
    return res.json({ authenticated: true, privateMode: true });
  }
  const token = extractToken(req);
  const authenticated = !!(token && authenticatedSessions.has(token));
  return res.json({ authenticated, privateMode: true });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  if (token) authenticatedSessions.delete(token);
  res.setHeader('Set-Cookie', 'app_session=; Path=/; HttpOnly; Max-Age=0');
  return res.json({ success: true });
});

// SSRF IP Validation Helpers
function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;

  const n = ipToLong(ip);
  if (n >= ipToLong('0.0.0.0') && n <= ipToLong('0.255.255.255')) return true;
  if (n >= ipToLong('10.0.0.0') && n <= ipToLong('10.255.255.255')) return true;
  if (n >= ipToLong('100.64.0.0') && n <= ipToLong('100.127.255.255')) return true;
  if (n >= ipToLong('127.0.0.0') && n <= ipToLong('127.255.255.255')) return true;
  if (n >= ipToLong('169.254.0.0') && n <= ipToLong('169.254.255.255')) return true;
  if (n >= ipToLong('172.16.0.0') && n <= ipToLong('172.31.255.255')) return true;
  if (n >= ipToLong('192.0.0.0') && n <= ipToLong('192.0.2.255')) return true;
  if (n >= ipToLong('192.168.0.0') && n <= ipToLong('192.168.255.255')) return true;
  if (n >= ipToLong('198.18.0.0') && n <= ipToLong('198.19.255.255')) return true;
  if (n >= ipToLong('198.51.100.0') && n <= ipToLong('198.51.100.255')) return true;
  if (n >= ipToLong('203.0.113.0') && n <= ipToLong('203.0.113.255')) return true;
  if (n >= ipToLong('224.0.0.0') && n <= ipToLong('239.255.255.255')) return true;
  if (n >= ipToLong('240.0.0.0') && n <= ipToLong('255.255.255.255')) return true;

  return false;
}

function isPrivateIPv6(ip) {
  const clean = ip.toLowerCase();
  if (clean === '::1' || clean === '::' || clean.startsWith('fe80:') || clean.startsWith('fc00:') || clean.startsWith('fd00:')) {
    return true;
  }
  if (clean.startsWith('::ffff:')) {
    const v4 = clean.replace('::ffff:', '');
    return isPrivateIPv4(v4);
  }
  return false;
}

// Strict URL validator and SSRF shield
async function validateUrlForSSRF(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { valid: false, reason: 'Please enter a valid video URL.' };
  }

  if (inputUrl.length > 2048) {
    return { valid: false, reason: 'URL exceeds maximum allowable length.' };
  }

  let parsed;
  try {
    parsed = new URL(inputUrl.trim());
  } catch (_) {
    return { valid: false, reason: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only HTTP and HTTPS URLs are supported.' };
  }

  const hostname = parsed.hostname.toLowerCase();

  const blockedHostnames = [
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
    'metadata.google.internal',
    'metadata',
    'instance-data'
  ];

  if (blockedHostnames.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    return { valid: false, reason: 'Access to private or local network resources is forbidden.' };
  }

  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { valid: false, reason: 'Unable to resolve domain name.' };
    }

    for (const record of addresses) {
      if (record.family === 4 && isPrivateIPv4(record.address)) {
        return { valid: false, reason: 'Access to private network addresses is forbidden.' };
      }
      if (record.family === 6 && isPrivateIPv6(record.address)) {
        return { valid: false, reason: 'Access to private network addresses is forbidden.' };
      }
    }
  } catch (dnsErr) {
    return { valid: false, reason: 'Could not connect to the specified host.' };
  }

  return { valid: true, sanitizedUrl: parsed.href };
}

// Sanitize filename to prevent directory traversal or header injection
function sanitizeDownloadFilename(name, ext = '.mp4') {
  if (!name || typeof name !== 'string') return `video${ext}`;
  const clean = name
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 60);
  return (clean || 'video') + ext;
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return null;
  const sec = Math.floor(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Safe yt-dlp arguments base
function getYtDlpArgs() {
  const args = [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--no-warnings'
  ];
  if (activeFFmpegPath && (activeFFmpegPath === 'ffmpeg' || fs.existsSync(activeFFmpegPath))) {
    args.push('--ffmpeg-location', activeFFmpegPath);
  }
  return args;
}

// Inspect media streams using FFmpeg - MUST verify video and audio
function inspectMediaStreams(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath) || !activeFFmpegPath) {
      return resolve({ hasVideo: false, hasAudio: false, container: 'unknown' });
    }

    const proc = spawn(activeFFmpegPath, ['-i', filePath], { shell: false });
    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', () => {
      const hasVideo = /Stream #\d+:\d+.*?: Video:/i.test(stderr);
      const hasAudio = /Stream #\d+:\d+.*?: Audio:/i.test(stderr);
      const isMp4 = /Input #0,\s*(mov,mp4,m4a|mp4)/i.test(stderr);
      const isWebm = /Input #0,\s*matroska,webm/i.test(stderr);
      
      resolve({
        hasVideo,
        hasAudio,
        container: isMp4 ? 'mp4' : (isWebm ? 'webm' : 'other'),
        rawDetails: stderr
      });
    });

    proc.on('error', () => {
      resolve({ hasVideo: false, hasAudio: false, container: 'unknown' });
    });
  });
}

// POST /api/info - Inspect metadata and available real video qualities
app.post('/api/info', requireAuth, rateLimiter(25, 60 * 1000), async (req, res) => {
  const { url } = req.body;

  const check = await validateUrlForSSRF(url);
  if (!check.valid) {
    return res.status(400).json({ error: check.reason });
  }

  const cleanUrl = check.sanitizedUrl;
  const args = [
    ...getYtDlpArgs(),
    '--dump-single-json',
    '--skip-download',
    cleanUrl
  ];

  let stdoutData = '';
  let finished = false;

  const proc = spawn(pythonCmd, args, { shell: false });

  const timeoutTimer = setTimeout(() => {
    if (!finished) {
      finished = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
      if (!res.headersSent) {
        res.status(504).json({ error: 'Request timed out while inspecting video.' });
      }
    }
  }, 15000);

  req.on('close', () => {
    if (!finished) {
      finished = true;
      clearTimeout(timeoutTimer);
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  });

  proc.stdout.on('data', (chunk) => {
    if (stdoutData.length < 8 * 1024 * 1024) {
      stdoutData += chunk.toString();
    }
  });

  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);

    if (code !== 0) {
      return res.status(400).json({ error: 'Unable to process this URL. Please check the link and try again.' });
    }

    try {
      const info = JSON.parse(stdoutData);

      // Extract real available video qualities from format list
      const availableQualities = [{ label: 'Best Quality', value: 'best' }];
      if (Array.isArray(info.formats)) {
        const heights = new Set(
          info.formats
            .filter(f => f && f.vcodec && f.vcodec !== 'none' && f.height)
            .map(f => f.height)
        );

        const tiers = [
          { height: 1080, label: '1080p', value: '1080p' },
          { height: 720, label: '720p', value: '720p' },
          { height: 480, label: '480p', value: '480p' },
          { height: 360, label: '360p', value: '360p' }
        ];

        for (const t of tiers) {
          if (heights.has(t.height) || [...heights].some(h => Math.abs(h - t.height) <= 20)) {
            availableQualities.push({ label: t.label, value: t.value });
          }
        }
      }

      return res.json({
        success: true,
        title: info.title ? String(info.title).slice(0, 150) : 'Video',
        thumbnail: (info.thumbnail && typeof info.thumbnail === 'string' && info.thumbnail.startsWith('https://')) ? info.thumbnail : null,
        duration: formatDuration(info.duration),
        durationSec: info.duration || 0,
        uploader: info.uploader ? String(info.uploader).slice(0, 80) : null,
        qualities: availableQualities,
        url: cleanUrl
      });
    } catch (_) {
      return res.status(500).json({ error: 'Unable to process this URL.' });
    }
  });

  proc.on('error', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal processing error.' });
    }
  });
});

// Helper to clean up all temporary files matching a fileId
function cleanupFileId(fileId) {
  try {
    const matches = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(fileId));
    for (const m of matches) {
      try { fs.unlinkSync(path.join(TEMP_DIR, m)); } catch (_) {}
    }
  } catch (_) {}
}

// Download execution with progress callbacks, quality selection, and stream verification
function executeDownloadWithProgress(cleanUrl, fileId, onProgress, onProcessCreated, quality = 'best') {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);

    // Quality-based format selection with automatic fallback to closest lower quality
    let formatSelector = 'bv*[height<=720]+ba/b[height<=720][vcodec!=none]/bv*+ba/b[vcodec!=none]'; // Default fast web delivery
    if (quality === 'best' || quality === '1080p') {
      formatSelector = 'bv*[height<=1080]+ba/b[height<=1080][vcodec!=none]/bv*+ba/b[vcodec!=none]';
    } else if (quality === '720p') {
      formatSelector = 'bv*[height<=720]+ba/b[height<=720][vcodec!=none]/bv*+ba/b[vcodec!=none]';
    } else if (quality === '480p') {
      formatSelector = 'bv*[height<=480]+ba/b[height<=480][vcodec!=none]/bv*+ba/b[vcodec!=none]';
    } else if (quality === '360p') {
      formatSelector = 'bv*[height<=360]+ba/b[height<=360][vcodec!=none]/bv*+ba/b[vcodec!=none]';
    }

    const args = [
      ...getYtDlpArgs(),
      '--newline',
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '--max-filesize', '1000M',
      '-o', outputTemplate,
      cleanUrl
    ];

    const proc = spawn(pythonCmd, args, { shell: false });
    let isTerminated = false;

    if (onProcessCreated) {
      onProcessCreated(proc, () => {
        if (!isTerminated) {
          isTerminated = true;
          try { proc.kill('SIGKILL'); } catch (_) {}
        }
      });
    }

    // 5-minute timeout for large video downloads
    const timer = setTimeout(() => {
      if (!isTerminated) {
        isTerminated = true;
        try { proc.kill('SIGKILL'); } catch (_) {}
        reject(new Error('TIMEOUT'));
      }
    }, 300000);

    let lastReportedPercent = -1;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n');

      for (const line of lines) {
        // Detailed download progress: [download]  45.2% of ~512.00MiB at 8.40MiB/s ETA 00:23
        const detailedMatch = line.match(/\[download\]\s+([\d\.]+)%\s+of\s+~?([\d\.]+\s*[a-zA-Z]+)(?:\s+at\s+([\d\.]+\s*[a-zA-Z\/]+))?(?:\s+ETA\s+([\d:]+))?/i);
        if (detailedMatch) {
          const pct = Math.min(99, Math.floor(parseFloat(detailedMatch[1])));
          const rawTotal = detailedMatch[2].trim().replace(/iB/g, 'B');
          const rawSpeed = detailedMatch[3] ? detailedMatch[3].trim().replace(/iB/g, 'B') : null;
          const rawEta = detailedMatch[4] ? detailedMatch[4].trim() : null;

          // Compute real downloaded bytes/MB
          let downloadedStr = null;
          const numMatch = rawTotal.match(/([\d\.]+)\s*([a-zA-Z]+)/);
          if (numMatch) {
            const totalNum = parseFloat(numMatch[1]);
            const unit = numMatch[2];
            const dlNum = (pct / 100) * totalNum;
            downloadedStr = `${unit.toUpperCase().includes('G') ? dlNum.toFixed(2) : dlNum.toFixed(1)} ${unit}`;
          }

          if (pct !== lastReportedPercent && onProgress) {
            lastReportedPercent = pct;
            onProgress({
              stage: 'downloading',
              percent: pct,
              downloaded: downloadedStr,
              totalSize: rawTotal,
              speed: rawSpeed,
              eta: rawEta,
              message: `Downloading ${pct}%`
            });
          }
        } else {
          const simpleMatch = line.match(/\[download\]\s+([\d\.]+)%/i);
          if (simpleMatch) {
            const pct = Math.min(99, Math.floor(parseFloat(simpleMatch[1])));
            if (pct !== lastReportedPercent && onProgress) {
              lastReportedPercent = pct;
              onProgress({
                stage: 'downloading',
                percent: pct,
                message: `Downloading ${pct}%`
              });
            }
          } else if (line.includes('[Merger]') || line.includes('Merging formats') || line.includes('[VideoRemuxer]')) {
            if (onProgress) {
              onProgress({ stage: 'merging', message: 'Merging video + audio...', detail: 'Merging video and audio streams...' });
            }
          }
        }
      }
    });

    proc.on('close', async (code) => {
      if (isTerminated) return;
      isTerminated = true;
      clearTimeout(timer);

      if (code !== 0) {
        return reject(new Error('DOWNLOAD_FAILED'));
      }

      try {
        if (onProgress) {
          onProgress({ stage: 'validating', message: 'Validating video...', detail: 'Verifying video streams...' });
        }

        const preferredFile = path.join(TEMP_DIR, `${fileId}.mp4`);
        let finalFilePath = null;

        if (fs.existsSync(preferredFile)) {
          finalFilePath = preferredFile;
        } else {
          const matches = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(fileId) && !f.endsWith('.part'));
          if (matches.length > 0) {
            finalFilePath = path.join(TEMP_DIR, matches[0]);
          }
        }

        if (!finalFilePath || !fs.existsSync(finalFilePath)) {
          return reject(new Error('FILE_NOT_FOUND'));
        }

        // Clean up any lingering .part or stream fragment files
        const allFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(fileId));
        for (const f of allFiles) {
          const p = path.join(TEMP_DIR, f);
          if (p !== finalFilePath) {
            try { fs.unlinkSync(p); } catch (_) {}
          }
        }

        // STREAM INSPECTION: Must have at least one video stream
        const streams = await inspectMediaStreams(finalFilePath);
        if (!streams.hasVideo) {
          console.warn(`[REJECTED] Downloaded file ${finalFilePath} has NO video stream.`);
          try { fs.unlinkSync(finalFilePath); } catch (_) {}
          return reject(new Error('AUDIO_ONLY_REJECTED'));
        }

        const stat = fs.statSync(finalFilePath);
        const ext = streams.container === 'mp4' ? '.mp4' : (streams.container === 'webm' ? '.webm' : path.extname(finalFilePath) || '.mp4');
        const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';

        resolve({
          filePath: finalFilePath,
          size: stat.size,
          ext,
          contentType,
          hasVideo: streams.hasVideo,
          hasAudio: streams.hasAudio
        });
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', (err) => {
      if (isTerminated) return;
      isTerminated = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// SSE ENDPOINT: /api/prepare-stream - Real download & processing progress
app.get('/api/prepare-stream', requireAuth, rateLimiter(10, 60 * 1000), async (req, res) => {
  const { url, title, quality } = req.query;

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  function sendEvent(data) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  if (!isFFmpegReady) {
    sendEvent({ stage: 'error', error: 'FFmpeg is not available on the server.' });
    return res.end();
  }

  const check = await validateUrlForSSRF(url);
  if (!check.valid) {
    sendEvent({ stage: 'error', error: check.reason });
    return res.end();
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    sendEvent({ stage: 'error', error: 'Server download capacity reached. Please try again shortly.' });
    return res.end();
  }

  activeDownloads++;
  const fileId = crypto.randomUUID().replace(/-/g, '');
  let cancelDownload = null;
  let preparationCompleted = false;

  req.on('close', () => {
    if (!preparationCompleted) {
      if (cancelDownload) cancelDownload();
      cleanupFileId(fileId);
    }
  });

  sendEvent({ stage: 'preparing', message: 'Preparing video...' });

  try {
    const media = await executeDownloadWithProgress(
      check.sanitizedUrl,
      fileId,
      (progressData) => {
        sendEvent(progressData);
      },
      (proc, killFn) => {
        cancelDownload = killFn;
      },
      quality || 'best'
    );

    activeDownloads = Math.max(0, activeDownloads - 1);
    preparationCompleted = true;

    const safeFilename = sanitizeDownloadFilename(title, media.ext);
    const downloadToken = crypto.randomUUID().replace(/-/g, '');

    preparedDownloads.set(downloadToken, {
      filePath: media.filePath,
      filename: safeFilename,
      contentType: media.contentType,
      size: media.size,
      createdAt: Date.now()
    });

    sendEvent({
      stage: 'ready',
      downloadToken,
      filename: safeFilename,
      percent: 100,
      message: 'Download ready'
    });

    res.end();
  } catch (err) {
    activeDownloads = Math.max(0, activeDownloads - 1);
    cleanupFileId(fileId);

    if (err.message === 'AUDIO_ONLY_REJECTED') {
      sendEvent({ stage: 'error', error: 'This video could not be prepared in a compatible video format.' });
    } else if (err.message === 'TIMEOUT') {
      sendEvent({ stage: 'error', error: 'Download timed out. Please try again.' });
    } else {
      sendEvent({ stage: 'error', error: 'Unable to prepare this video. Please try another supported video URL.' });
    }
    res.end();
  }
});

// POST /api/prepare - JSON prepare endpoint (backward compatibility & test suites)
app.post('/api/prepare', requireAuth, rateLimiter(10, 60 * 1000), async (req, res) => {
  const { url, title, quality } = req.body;

  if (!isFFmpegReady) {
    return res.status(500).json({ error: 'FFmpeg is not available on the server.' });
  }

  const check = await validateUrlForSSRF(url);
  if (!check.valid) {
    return res.status(400).json({ error: check.reason });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).json({ error: 'Server download capacity reached. Please try again shortly.' });
  }

  activeDownloads++;
  const fileId = crypto.randomUUID().replace(/-/g, '');
  let cancelDownload = null;
  let preparationCompleted = false;

  req.on('close', () => {
    if (!preparationCompleted) {
      if (cancelDownload) cancelDownload();
      cleanupFileId(fileId);
    }
  });

  try {
    const media = await executeDownloadWithProgress(
      check.sanitizedUrl,
      fileId,
      null,
      (proc, killFn) => { cancelDownload = killFn; },
      quality || 'best'
    );

    activeDownloads = Math.max(0, activeDownloads - 1);
    preparationCompleted = true;

    const safeFilename = sanitizeDownloadFilename(title, media.ext);
    const downloadToken = crypto.randomUUID().replace(/-/g, '');

    preparedDownloads.set(downloadToken, {
      filePath: media.filePath,
      filename: safeFilename,
      contentType: media.contentType,
      size: media.size,
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      downloadToken,
      filename: safeFilename,
      size: media.size,
      hasVideo: media.hasVideo,
      hasAudio: media.hasAudio
    });
  } catch (err) {
    activeDownloads = Math.max(0, activeDownloads - 1);
    cleanupFileId(fileId);

    if (err.message === 'AUDIO_ONLY_REJECTED') {
      return res.status(400).json({ error: 'This video could not be prepared in a compatible video format.' });
    }
    if (err.message === 'TIMEOUT') {
      return res.status(504).json({ error: 'Download timed out. Please try again.' });
    }
    return res.status(400).json({ error: 'This video could not be prepared in a compatible video format.' });
  }
});

// GET /api/file/:token - Serves prepared media and cleans up immediately
app.get('/api/file/:token', (req, res) => {
  const { token } = req.params;

  if (!token || !preparedDownloads.has(token)) {
    return res.status(404).json({ error: 'Download not found or expired. Please prepare the video again.' });
  }

  const { filePath, filename, contentType, size } = preparedDownloads.get(token);
  preparedDownloads.delete(token); // Single-use token

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File no longer exists.' });
  }

  res.setHeader('Content-Type', contentType || 'video/mp4');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  let cleaned = false;
  const onEnd = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (!stream.destroyed) stream.destroy(); } catch (_) {}
    setTimeout(() => {
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
          setTimeout(() => fs.unlink(filePath, () => {}), 1000);
        }
      });
    }, 100);
  };

  res.on('finish', onEnd);
  res.on('close', onEnd);
  stream.on('close', onEnd);
  stream.on('error', onEnd);
});

// GET /api/download - Direct streaming fallback
app.get('/api/download', requireAuth, rateLimiter(6, 60 * 1000), async (req, res) => {
  const { url, title, quality } = req.query;

  if (!isFFmpegReady) {
    return res.status(500).json({ error: 'FFmpeg is not available on the server.' });
  }

  const check = await validateUrlForSSRF(url);
  if (!check.valid) {
    return res.status(400).json({ error: check.reason });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).json({ error: 'Server download capacity reached. Please try again shortly.' });
  }

  activeDownloads++;
  const fileId = crypto.randomUUID().replace(/-/g, '');
  let cancelDownload = null;

  req.on('close', () => {
    if (cancelDownload) cancelDownload();
    cleanupFileId(fileId);
  });

  try {
    const media = await executeDownloadWithProgress(
      check.sanitizedUrl,
      fileId,
      null,
      (proc, killFn) => { cancelDownload = killFn; },
      quality || 'best'
    );

    activeDownloads = Math.max(0, activeDownloads - 1);

    const safeFilename = sanitizeDownloadFilename(title, media.ext);
    res.setHeader('Content-Type', media.contentType || 'video/mp4');
    res.setHeader('Content-Length', media.size);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    const stream = fs.createReadStream(media.filePath);
    stream.pipe(res);

    let cleaned = false;
    const onEnd = () => {
      if (cleaned) return;
      cleaned = true;
      try { if (!stream.destroyed) stream.destroy(); } catch (_) {}
      setTimeout(() => {
        fs.unlink(media.filePath, () => {});
      }, 100);
    };

    res.on('finish', onEnd);
    res.on('close', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onEnd);
  } catch (err) {
    activeDownloads = Math.max(0, activeDownloads - 1);
    cleanupFileId(fileId);

    if (!res.headersSent) {
      return res.status(400).json({ error: 'This video could not be prepared in a compatible video format.' });
    }
  }
});

// =========================================================================
// AI VIRAL CLIPS ENDPOINTS
// =========================================================================

// POST /api/clips/generate
app.post('/api/clips/generate', requireAuth, rateLimiter(6, 60 * 1000), async (req, res) => {
  const { url, title, isVertical } = req.body || {};

  if (!isFFmpegReady) {
    return res.status(500).json({ error: 'FFmpeg is not available on the server.' });
  }

  const check = await validateUrlForSSRF(url);
  if (!check.valid) {
    return res.status(400).json({ error: check.reason });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).json({ error: 'Server capacity reached. Please try again shortly.' });
  }

  activeDownloads++;
  const fileId = crypto.randomUUID().replace(/-/g, '');
  let cancelProc = null;
  let finished = false;

  req.on('close', () => {
    if (!finished) {
      if (cancelProc) cancelProc();
      cleanupFileId(fileId);
    }
  });

  try {
    // Download source video at 720p/best for quick clip generation
    const media = await executeDownloadWithProgress(
      check.sanitizedUrl,
      fileId,
      null,
      (proc, killFn) => { cancelProc = killFn; },
      '720p'
    );

    finished = true;
    activeDownloads = Math.max(0, activeDownloads - 1);

    const clips = await viralClipsEngine.generateViralClips(media.filePath, {
      isVertical: !!isVertical,
      maxClips: 6,
      tempDir: TEMP_DIR
    });

    cleanupFileId(fileId);

    return res.json({
      success: true,
      title: title || 'Video',
      clipsCount: clips.length,
      clips
    });
  } catch (err) {
    finished = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    cleanupFileId(fileId);

    return res.status(400).json({ error: 'Could not generate viral clips for this video. Minimum length is 25 seconds.' });
  }
});

// GET /api/clips/:clipId/preview
app.get('/api/clips/:clipId/preview', requireAuth, (req, res) => {
  const { clipId } = req.params;
  const clip = viralClipsEngine.getClipById(clipId);
  if (!clip || !fs.existsSync(clip.filePath)) {
    return res.status(404).json({ error: 'Clip not found or expired.' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', clip.size);
  const stream = fs.createReadStream(clip.filePath);
  stream.pipe(res);
  const cleanStream = () => { try { if (!stream.destroyed) stream.destroy(); } catch (_) {} };
  res.on('finish', cleanStream);
  res.on('close', cleanStream);
});

// GET /api/clips/:clipId/download
app.get('/api/clips/:clipId/download', requireAuth, (req, res) => {
  const { clipId } = req.params;
  const clip = viralClipsEngine.getClipById(clipId);
  if (!clip || !fs.existsSync(clip.filePath)) {
    return res.status(404).json({ error: 'Clip not found or expired.' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', clip.size);
  res.setHeader('Content-Disposition', `attachment; filename="${clip.filename}"`);
  const stream = fs.createReadStream(clip.filePath);
  stream.pipe(res);
  const cleanStream = () => { try { if (!stream.destroyed) stream.destroy(); } catch (_) {} };
  res.on('finish', cleanStream);
  res.on('close', cleanStream);
});

// Health check endpoints (Render health check compatibility)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ffmpeg: isFFmpegReady,
    privateMode: true
  });
});

// Server binding: Render binds to 0.0.0.0 and uses process.env.PORT
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

function startServer(port) {
  const server = app.listen(port, HOST, () => {
    console.log(`Antigravity Video Downloader running on http://${HOST}:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is in use, falling back to port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(DEFAULT_PORT);
