'use strict';

/**
 * mediaDetector.js – Safe universal media detection and direct download pipeline.
 *
 * Responsibilities:
 * 1. Safe HTTP/HTTPS probing with SSRF protection on every redirect hop.
 * 2. Magic bytes / file signature sniffing (JPEG, PNG, WebP, GIF, AVIF, BMP, MP4, WebM, etc.).
 * 3. Content-Type and header analysis (differentiating media vs HTML/JSON/text).
 * 4. Safe streaming download of direct media files with progress tracking.
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── SSRF IP Validation Helpers ──────────────────────────────────────────────

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
    return { valid: false, reason: 'Please enter a valid URL.' };
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

  if (
    blockedHostnames.includes(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
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
  } catch (_) {
    return { valid: false, reason: 'Could not connect to the specified host.' };
  }

  return { valid: true, sanitizedUrl: parsed.href };
}

// ── Magic Bytes & File Signature Detection ──────────────────────────────────

function detectMagicBytes(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { type: 'image', ext: '.jpg', contentType: 'image/jpeg', format: 'JPEG' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { type: 'image', ext: '.png', contentType: 'image/png', format: 'PNG' };
  }

  // GIF: GIF87a or GIF89a
  const gifHeader = buffer.slice(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { type: 'image', ext: '.gif', contentType: 'image/gif', format: 'GIF' };
  }

  // WEBP: RIFF .... WEBP
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { type: 'image', ext: '.webp', contentType: 'image/webp', format: 'WEBP' };
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return { type: 'image', ext: '.bmp', contentType: 'image/bmp', format: 'BMP' };
  }

  // AVIF: .... ftyp avif / mif1
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand.includes('avif') || brand.includes('mif1')) {
      return { type: 'image', ext: '.avif', contentType: 'image/avif', format: 'AVIF' };
    }
    // MP4 / MOV / M4V / QuickTime
    return { type: 'video', ext: '.mp4', contentType: 'video/mp4', format: 'MP4' };
  }

  // MP4 moov / mdat
  if (buffer.length >= 8 && (buffer.slice(4, 8).toString('ascii') === 'moov' || buffer.slice(4, 8).toString('ascii') === 'mdat')) {
    return { type: 'video', ext: '.mp4', contentType: 'video/mp4', format: 'MP4' };
  }

  // WebM / MKV (Matroska): 1A 45 DF A3
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return { type: 'video', ext: '.webm', contentType: 'video/webm', format: 'WebM' };
  }

  // FLV: FLV\x01
  if (buffer.slice(0, 3).toString('ascii') === 'FLV') {
    return { type: 'video', ext: '.flv', contentType: 'video/x-flv', format: 'FLV' };
  }

  // AVI: RIFF .... AVI
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'AVI ') {
    return { type: 'video', ext: '.avi', contentType: 'video/x-msvideo', format: 'AVI' };
  }

  // Detect HTML / XML / JSON / Text
  const textSample = buffer.slice(0, Math.min(buffer.length, 512)).toString('utf8').trim().toLowerCase();
  if (
    textSample.startsWith('<!doctype html') ||
    textSample.startsWith('<html') ||
    textSample.includes('<head>') ||
    textSample.includes('<body>') ||
    textSample.startsWith('<?xml') ||
    textSample.startsWith('{') ||
    textSample.startsWith('[')
  ) {
    return { type: 'non_media', ext: null, contentType: 'text/html' };
  }

  return null;
}

// ── Content-Type to Media Mapping ───────────────────────────────────────────

const IMAGE_MIME_MAP = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
  'image/svg+xml': '.svg'
};

const VIDEO_MIME_MAP = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/x-flv': '.flv',
  'video/x-m4v': '.m4v',
  'video/ogg': '.ogv'
};

// Extract a clean display title / filename from URL or Content-Disposition
function extractFilenameFromUrl(targetUrl, disposition = null, defaultExt = '') {
  if (disposition && typeof disposition === 'string') {
    const match = disposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i);
    if (match && match[1] && match[1].trim()) {
      const decoded = decodeURIComponent(match[1].trim());
      const base = path.basename(decoded);
      if (base && base.length > 0 && base.length < 100) return base;
    }
  }

  try {
    const parsed = new URL(targetUrl);
    const pathname = parsed.pathname || '';
    const base = path.basename(pathname);
    if (base && base.length > 0 && !base.includes('?') && !base.includes('&')) {
      const clean = base.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 60);
      if (clean && clean.length > 0) return clean;
    }
  } catch (_) {}

  return `media_${Date.now().toString().slice(-6)}${defaultExt}`;
}

// ── Safe HTTP/HTTPS Probe (Follows redirects + SSRF validation) ──────────────

function safeProbeUrl(targetUrl, maxRedirects = 5) {
  return new Promise(async (resolve) => {
    if (maxRedirects < 0) {
      return resolve({ success: false, error: 'Too many redirects.' });
    }

    const ssrf = await validateUrlForSSRF(targetUrl);
    if (!ssrf.valid) {
      return resolve({ success: false, error: ssrf.reason, isSSRF: true });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(ssrf.sanitizedUrl);
    } catch (_) {
      return resolve({ success: false, error: 'Invalid URL.' });
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/*, video/*, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Range': 'bytes=0-4096' // Fast initial bytes fetch
      },
      timeout: 10000
    };

    const req = lib.request(reqOptions, async (res) => {
      const statusCode = res.statusCode || 0;

      // Handle redirects safely
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = res.headers['location'];
        res.resume(); // Discard stream
        if (!location) {
          return resolve({ success: false, error: 'Redirect without location header.' });
        }
        try {
          const nextUrl = new URL(location, ssrf.sanitizedUrl).href;
          return resolve(await safeProbeUrl(nextUrl, maxRedirects - 1));
        } catch (_) {
          return resolve({ success: false, error: 'Invalid redirect target.' });
        }
      }

      if (statusCode === 404) {
        res.resume();
        return resolve({ success: false, error: 'The requested resource could not be found (404 Not Found).' });
      }

      if (statusCode === 401 || statusCode === 403) {
        res.resume();
        return resolve({ success: false, error: 'Access to this resource is private or requires authorization.' });
      }

      if (statusCode >= 400) {
        res.resume();
        return resolve({ success: false, error: `Remote server responded with HTTP error ${statusCode}.` });
      }

      const rawContentType = (res.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      const disposition = res.headers['content-disposition'] || null;

      // Sniff first chunk for magic bytes
      const chunks = [];
      let totalBytes = 0;
      let handled = false;

      const finishProbe = () => {
        if (handled) return;
        handled = true;

        const buffer = Buffer.concat(chunks);
        const magic = detectMagicBytes(buffer);

        // Check if Content-Type or Magic Bytes indicate Image
        if (IMAGE_MIME_MAP[rawContentType] || (magic && magic.type === 'image')) {
          const ext = IMAGE_MIME_MAP[rawContentType] || (magic ? magic.ext : '.jpg');
          const filename = extractFilenameFromUrl(ssrf.sanitizedUrl, disposition, ext);
          return resolve({
            success: true,
            mediaType: 'image',
            contentType: rawContentType || (magic ? magic.contentType : 'image/jpeg'),
            ext,
            size: contentLength > 0 ? contentLength : totalBytes,
            filename,
            title: filename.replace(/\.[^.]+$/, ''),
            url: ssrf.sanitizedUrl
          });
        }

        // Check if Content-Type or Magic Bytes indicate Video
        if (VIDEO_MIME_MAP[rawContentType] || (magic && magic.type === 'video')) {
          const ext = VIDEO_MIME_MAP[rawContentType] || (magic ? magic.ext : '.mp4');
          const filename = extractFilenameFromUrl(ssrf.sanitizedUrl, disposition, ext);
          return resolve({
            success: true,
            mediaType: 'video',
            contentType: rawContentType || (magic ? magic.contentType : 'video/mp4'),
            ext,
            size: contentLength > 0 ? contentLength : totalBytes,
            filename,
            title: filename.replace(/\.[^.]+$/, ''),
            url: ssrf.sanitizedUrl
          });
        }

        // Detected HTML or non-media
        if (rawContentType.includes('text/html') || rawContentType.includes('application/json') || (magic && magic.type === 'non_media')) {
          return resolve({
            success: false,
            isNonMedia: true,
            error: 'This URL does not contain a supported downloadable video or image.'
          });
        }

        // Unknown binary or other format
        return resolve({
          success: false,
          isNonMedia: true,
          error: 'This URL does not contain a supported downloadable video or image.'
        });
      };

      res.on('data', (chunk) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes >= 512) {
          finishProbe();
          try { res.destroy(); } catch (_) {}
        }
      });

      res.on('end', finishProbe);
      res.on('close', finishProbe);

      res.on('error', (err) => {
        if (handled) return;
        handled = true;
        resolve({ success: false, error: 'Network error while inspecting media resource: ' + err.message });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Connection timed out while connecting to the host.' });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: 'Could not connect to the specified host: ' + err.message });
    });

    req.end();
  });
}

// ── Direct Media Downloader Pipeline ────────────────────────────────────────

function downloadDirectMediaWithProgress(targetUrl, fileId, tempDir, onProgress, onProcessCreated, maxRedirects = 5) {
  return new Promise(async (resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Too many redirects.'));
    }

    const ssrf = await validateUrlForSSRF(targetUrl);
    if (!ssrf.valid) {
      return reject(new Error(ssrf.reason));
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(ssrf.sanitizedUrl);
    } catch (_) {
      return reject(new Error('Invalid URL format.'));
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/*, video/*, */*;q=0.8'
      },
      timeout: 60000
    };

    let isTerminated = false;
    const req = lib.request(reqOptions, async (res) => {
      const statusCode = res.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = res.headers['location'];
        res.resume();
        if (!location) return reject(new Error('Redirect without location header.'));
        try {
          const nextUrl = new URL(location, ssrf.sanitizedUrl).href;
          return resolve(await downloadDirectMediaWithProgress(nextUrl, fileId, tempDir, onProgress, onProcessCreated, maxRedirects - 1));
        } catch (_) {
          return reject(new Error('Invalid redirect location.'));
        }
      }

      if (statusCode >= 400) {
        res.resume();
        return reject(new Error(`Server returned HTTP ${statusCode}.`));
      }

      const rawContentType = (res.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      const totalLength = parseInt(res.headers['content-length'] || '0', 10);
      const disposition = res.headers['content-disposition'] || null;

      // Reject immediate HTML Content-Type
      if (rawContentType.includes('text/html') || rawContentType.includes('application/json')) {
        res.resume();
        return reject(new Error('This URL does not contain a supported downloadable video or image.'));
      }

      const isImage = !!IMAGE_MIME_MAP[rawContentType];
      let ext = IMAGE_MIME_MAP[rawContentType] || VIDEO_MIME_MAP[rawContentType] || '.mp4';
      const tempFilePath = path.join(tempDir, `${fileId}${ext}`);
      const fileStream = fs.createWriteStream(tempFilePath);

      let downloadedBytes = 0;
      let firstChunkChecked = false;
      let lastReportedPercent = -1;
      const startTime = Date.now();

      if (onProcessCreated) {
        onProcessCreated(req, () => {
          if (!isTerminated) {
            isTerminated = true;
            try { req.destroy(); } catch (_) {}
            try { fileStream.destroy(); } catch (_) {}
            try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}
          }
        });
      }

      res.on('data', (chunk) => {
        if (isTerminated) return;

        // Verify magic bytes on first chunk
        if (!firstChunkChecked) {
          firstChunkChecked = true;
          const magic = detectMagicBytes(chunk);
          if (magic && magic.type === 'non_media') {
            isTerminated = true;
            req.destroy();
            fileStream.destroy();
            try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}
            return reject(new Error('This URL does not contain a supported downloadable video or image.'));
          }
          if (magic && magic.ext) {
            ext = magic.ext;
          }
        }

        downloadedBytes += chunk.length;

        // Size limit guard: 1000MB max
        if (downloadedBytes > 1000 * 1024 * 1024) {
          isTerminated = true;
          req.destroy();
          fileStream.destroy();
          try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}
          return reject(new Error('Media file exceeds 1GB limit.'));
        }

        if (totalLength > 0 && onProgress) {
          const pct = Math.min(99, Math.floor((downloadedBytes / totalLength) * 100));
          if (pct !== lastReportedPercent) {
            lastReportedPercent = pct;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const speedBytes = elapsedSec > 0 ? downloadedBytes / elapsedSec : 0;
            const speedStr = speedBytes > 1024 * 1024 ? `${(speedBytes / (1024 * 1024)).toFixed(1)} MB/s` : `${(speedBytes / 1024).toFixed(0)} KB/s`;
            onProgress({
              stage: 'downloading',
              percent: pct,
              downloaded: `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`,
              totalSize: `${(totalLength / (1024 * 1024)).toFixed(1)} MB`,
              speed: speedStr,
              message: `Downloading ${pct}%`
            });
          }
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        if (isTerminated) return;
        fileStream.close(async () => {
          try {
            if (!fs.existsSync(tempFilePath) || fs.statSync(tempFilePath).size === 0) {
              return reject(new Error('Downloaded file is empty.'));
            }

            const stat = fs.statSync(tempFilePath);
            const filename = extractFilenameFromUrl(ssrf.sanitizedUrl, disposition, ext);

            resolve({
              filePath: tempFilePath,
              size: stat.size,
              ext,
              contentType: rawContentType || (isImage ? 'image/jpeg' : 'video/mp4'),
              mediaType: isImage ? 'image' : 'video',
              hasVideo: !isImage,
              hasAudio: false,
              filename
            });
          } catch (e) {
            reject(e);
          }
        });
      });

      fileStream.on('error', (err) => {
        if (!isTerminated) {
          isTerminated = true;
          try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      if (!isTerminated) {
        isTerminated = true;
        req.destroy();
        reject(new Error('TIMEOUT'));
      }
    });

    req.on('error', (err) => {
      if (!isTerminated) {
        isTerminated = true;
        reject(err);
      }
    });

    req.end();
  });
}

// ── Webpage Embedded Media Extractor (OpenGraph, Twitter Cards, HTML5 Media) ───

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u0026/g, '&');
}

function extractPageMedia(targetUrl, maxRedirects = 5) {
  return new Promise(async (resolve) => {
    if (maxRedirects < 0) return resolve({ success: false, error: 'Too many redirects.' });

    const ssrf = await validateUrlForSSRF(targetUrl);
    if (!ssrf.valid) return resolve({ success: false, error: ssrf.reason, isSSRF: true });

    let parsedUrl;
    try {
      parsedUrl = new URL(ssrf.sanitizedUrl);
    } catch (_) {
      return resolve({ success: false, error: 'Invalid URL.' });
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none'
      },
      timeout: 12000
    };

    const req = lib.request(reqOptions, async (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers['location']) {
        res.resume();
        try {
          const nextUrl = new URL(res.headers['location'], ssrf.sanitizedUrl).href;
          return resolve(await extractPageMedia(nextUrl, maxRedirects - 1));
        } catch (_) {
          return resolve({ success: false, error: 'Invalid redirect location.' });
        }
      }

      if (statusCode >= 400) {
        res.resume();
        return resolve({ success: false, error: `Remote server returned HTTP ${statusCode}.` });
      }

      const contentType = (res.headers['content-type'] || '').toLowerCase();
      if (IMAGE_MIME_MAP[contentType] || VIDEO_MIME_MAP[contentType]) {
        res.destroy();
        return resolve(await safeProbeUrl(ssrf.sanitizedUrl));
      }

      let body = '';
      res.on('data', (chunk) => {
        if (body.length < 2 * 1024 * 1024) {
          body += chunk.toString('utf8');
        } else {
          res.destroy();
        }
      });

      res.on('close', async () => {
        // Extract Title
        let title = '';
        const titleOg = body.match(/<meta\s+[^>]*property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                        body.match(/<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:title["']/i) ||
                        body.match(/<meta\s+[^>]*name=["']twitter:title["']\s+content=["']([^"']+)["']/i);
        const titleTag = body.match(/<title>([^<]+)<\/title>/i);
        if (titleOg && titleOg[1]) title = decodeHtmlEntities(titleOg[1].trim());
        else if (titleTag && titleTag[1]) title = decodeHtmlEntities(titleTag[1].trim());

        // Explicitly exclude non-media informational / reference websites
        const isNonMediaHost = /wikipedia\.org|wikimedia\.org|google\.com|bing\.com|yahoo\.com|github\.com|stackoverflow\.com|gitlab\.com|bitbucket\.org|httpbin\.org/i.test(parsedUrl.hostname);
        const isMediaHost = !isNonMediaHost && /instagram\.com|facebook\.com|tiktok\.com|reddit\.com|twitter\.com|x\.com|pinterest\.com|imgur\.com|flickr\.com|giphy\.com|tenor\.com|threads\.net|tumblr\.com|vsco\.co|deviantart\.com|snapchat\.com|bilibili\.com|weibo\.com/i.test(parsedUrl.hostname);
        const hasMediaMeta = !isNonMediaHost && (
          /<(?:meta\s+name=["']medium["']\s+content=["'](?:image|video)["']|meta\s+property=["']og:type["']\s+content=["'](?:video|video\.[^"']+|photo|image|image\.[^"']+)["'])/i.test(body) ||
          body.includes('"@type":"VideoObject"') || body.includes('"@type": "VideoObject"')
        );

        // Only extract embedded page media if it is a media platform or explicit media object
        if (!isMediaHost && !hasMediaMeta) {
          return resolve({
            success: false,
            isNonMedia: true,
            error: 'This URL does not contain a supported downloadable video or image.'
          });
        }

        // Extract Video Candidates
        const videoCandidates = [];
        const ogVideo = body.match(/<meta\s+[^>]*property=["']og:video(?::secure_url|:url)?["']\s+content=["']([^"']+)["']/i) ||
                        body.match(/<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:video(?::secure_url|:url)?["']/i);
        if (ogVideo && ogVideo[1]) videoCandidates.push(decodeHtmlEntities(ogVideo[1]));

        const html5Video = body.match(/<video[^>]*src=["']([^"']+)["']/i) || body.match(/<source[^>]*src=["']([^"']+)["'][^>]*type=["']video\//i);
        if (html5Video && html5Video[1]) videoCandidates.push(decodeHtmlEntities(html5Video[1]));

        for (const rawCandidate of videoCandidates) {
          try {
            const absoluteCandidate = new URL(rawCandidate, ssrf.sanitizedUrl).href;
            const probe = await safeProbeUrl(absoluteCandidate);
            if (probe.success && probe.mediaType === 'video') {
              return resolve({
                success: true,
                mediaType: 'video',
                title: title || probe.title || 'Video',
                url: absoluteCandidate,
                thumbnail: null,
                ext: probe.ext || '.mp4',
                size: probe.size || 0,
                uploader: parsedUrl.hostname
              });
            }
          } catch (_) {}
        }

        // Extract Image Candidates
        const imageCandidates = [];
        const ogImage = body.match(/<meta\s+[^>]*property=["']og:image(?::secure_url|:url)?["']\s+content=["']([^"']+)["']/i) ||
                        body.match(/<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:image(?::secure_url|:url)?["']/i);
        if (ogImage && ogImage[1]) imageCandidates.push(decodeHtmlEntities(ogImage[1]));

        const twitterImage = body.match(/<meta\s+[^>]*name=["']twitter:image(?::src)?["']\s+content=["']([^"']+)["']/i) ||
                              body.match(/<meta\s+[^>]*content=["']([^"']+)["']\s+name=["']twitter:image(?::src)?["']/i);
        if (twitterImage && twitterImage[1]) imageCandidates.push(decodeHtmlEntities(twitterImage[1]));

        const jsonLdMatches = body.match(/"(?:image|thumbnailUrl|contentUrl)"\s*:\s*["']([^"']+\.(?:jpg|jpeg|png|webp|avif)[^"']*)["']/gi);
        if (jsonLdMatches) {
          for (const j of jsonLdMatches) {
            const m = j.match(/["']([^"']+)["']$/);
            if (m && m[1]) imageCandidates.push(decodeHtmlEntities(m[1]));
          }
        }

        // Probe Image Candidates
        for (const rawCandidate of imageCandidates) {
          try {
            const absoluteCandidate = new URL(rawCandidate, ssrf.sanitizedUrl).href;
            const probe = await safeProbeUrl(absoluteCandidate);
            if (probe.success && probe.mediaType === 'image') {
              return resolve({
                success: true,
                mediaType: 'image',
                title: title || probe.title || 'Image',
                url: absoluteCandidate,
                thumbnail: absoluteCandidate,
                ext: probe.ext || '.jpg',
                size: probe.size || 0,
                uploader: parsedUrl.hostname
              });
            }
          } catch (_) {}
        }

        return resolve({
          success: false,
          isNonMedia: true,
          error: 'This URL does not contain a supported downloadable video or image.'
        });
      });

      res.on('error', (err) => resolve({ success: false, error: 'Failed to read webpage: ' + err.message }));
    });

    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Connection timed out while loading webpage.' }); });
    req.on('error', (err) => resolve({ success: false, error: 'Could not connect to the specified host: ' + err.message }));
    req.end();
  });
}

module.exports = {
  validateUrlForSSRF,
  detectMagicBytes,
  safeProbeUrl,
  extractPageMedia,
  downloadDirectMediaWithProgress,
  IMAGE_MIME_MAP,
  VIDEO_MIME_MAP
};
