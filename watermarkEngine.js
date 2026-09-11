'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const mediaDetector = require('./mediaDetector');

// Temporary directory for uploads and processed outputs
const WATERMARK_TEMP_DIR = path.join(os.tmpdir(), 'antigravity_watermark');
try {
  if (!fs.existsSync(WATERMARK_TEMP_DIR)) {
    fs.mkdirSync(WATERMARK_TEMP_DIR, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create watermark temp directory:', e);
}

// In-memory store for active uploaded files and processed jobs
// Key: fileId / processId -> metadata
const uploadedFiles = new Map();
const processedJobs = new Map();

// Limits
const MAX_IMAGE_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB
const TTL_MS = 20 * 60 * 1000; // 20 minutes

const SUPPORTED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const SUPPORTED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/gif'
]);

const SUPPORTED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/avi'
]);

// Helper to get active FFmpeg path
function getFFmpegBinary() {
  if (ffmpegPath && fs.existsSync(ffmpegPath)) return ffmpegPath;
  return 'ffmpeg';
}

// Helper to resolve Python binary
function resolvePython() {
  const isWin = process.platform === 'win32';
  const projectRoot = __dirname;
  const candidates = [
    process.env.PYTHON_PATH,
    path.join(projectRoot, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'),
    '/opt/venv/bin/python',
    'python3',
    'python'
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return isWin ? 'python' : 'python3';
}

// Probe image / video dimensions and metadata using FFmpeg
function probeMedia(filePath) {
  return new Promise((resolve) => {
    const ffmpeg = getFFmpegBinary();
    const proc = spawn(ffmpeg, ['-i', filePath], { shell: false });
    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', () => {
      // Parse resolution (e.g. 1920x1080)
      const resMatch = stderr.match(/Video:.*,\s*(\d{2,5})x(\d{2,5})/i);
      let width = 0;
      let height = 0;
      if (resMatch) {
        width = parseInt(resMatch[1], 10);
        height = parseInt(resMatch[2], 10);
      }

      // Parse duration (e.g. 00:01:23.45)
      let durationSec = 0;
      const durMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/i);
      if (durMatch) {
        const h = parseFloat(durMatch[1]);
        const m = parseFloat(durMatch[2]);
        const s = parseFloat(durMatch[3]);
        durationSec = Math.round(h * 3600 + m * 60 + s);
      }

      // Parse FPS
      let fps = 30;
      const fpsMatch = stderr.match(/,\s*([\d\.]+)\s*fps/i);
      if (fpsMatch) {
        fps = parseFloat(fpsMatch[1]);
      }

      const hasAudio = /Audio:/i.test(stderr);

      resolve({
        width,
        height,
        durationSec,
        fps,
        hasAudio
      });
    });

    proc.on('error', () => {
      resolve({ width: 0, height: 0, durationSec: 0, fps: 30, hasAudio: false });
    });
  });
}

// Extract first representative frame from a video for preview/bounding box selection
function extractVideoKeyframe(videoPath, previewPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFFmpegBinary();
    const args = [
      '-y',
      '-ss', '00:00:00.500',
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      previewPath
    ];

    const proc = spawn(ffmpeg, args, { shell: false });
    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(previewPath)) {
        resolve(previewPath);
      } else {
        // Fallback without timestamp offset
        const fallbackArgs = ['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', previewPath];
        const fbProc = spawn(ffmpeg, fallbackArgs, { shell: false });
        fbProc.on('close', (fbCode) => {
          if (fbCode === 0 && fs.existsSync(previewPath)) {
            resolve(previewPath);
          } else {
            reject(new Error(`Failed to extract preview keyframe from video: ${stderr}`));
          }
        });
        fbProc.on('error', reject);
      }
    });

    proc.on('error', reject);
  });
}

// Validate uploaded file
function validateUploadedFile(file) {
  if (!file || !file.path) {
    return { valid: false, error: 'No file uploaded.' };
  }

  const ext = path.extname(file.originalname || '').toLowerCase();
  const isImageExt = SUPPORTED_IMAGE_EXTS.has(ext);
  const isVideoExt = SUPPORTED_VIDEO_EXTS.has(ext);

  if (!isImageExt && !isVideoExt) {
    return {
      valid: false,
      error: `Unsupported file extension "${ext}". Supported formats: JPG, PNG, WEBP, BMP, GIF, MP4, MOV, WEBM, MKV, AVI.`
    };
  }

  const mediaType = isImageExt ? 'image' : 'video';
  const maxSize = mediaType === 'image' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;

  if (file.size > maxSize) {
    const limitMb = Math.round(maxSize / (1024 * 1024));
    return {
      valid: false,
      error: `File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum size for ${mediaType}s is ${limitMb}MB.`
    };
  }

  // Check magic bytes
  try {
    const fd = fs.openSync(file.path, 'r');
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);

    const magic = mediaDetector.detectMagicBytes(buf);
    if (!magic) {
      // If magic byte not recognized, check if it's a known format or reject
      if (ext === '.bmp' || ext === '.avi') {
        // Accepted based on extension check
      } else {
        return { valid: false, error: 'Corrupted or unsupported file content.' };
      }
    } else if (magic.type !== mediaType) {
      return {
        valid: false,
        error: `File content (${magic.type}) does not match expected file type (${mediaType}).`
      };
    }
  } catch (e) {
    return { valid: false, error: `Failed to inspect uploaded file: ${e.message}` };
  }

  return { valid: true, mediaType, ext };
}

// Inpaint an image using Python OpenCV worker with FFmpeg fallback
async function inpaintImage({ inputPath, outputPath, box, method = 'telea' }) {
  const pythonBin = resolvePython();
  const scriptPath = path.join(__dirname, 'scripts', 'watermark_inpaint.py');

  return new Promise((resolve, reject) => {
    // 1. Try Python OpenCV inpainting worker
    const args = [
      scriptPath,
      '--mode', 'image',
      '--input', inputPath,
      '--output', outputPath,
      '--x', String(box.x),
      '--y', String(box.y),
      '--width', String(box.width),
      '--height', String(box.height),
      '--method', method === 'ns' ? 'ns' : 'telea',
      '--radius', '3',
      '--feather', '2'
    ];

    let stdout = '';
    let stderr = '';
    const proc = spawn(pythonBin, args, { shell: false });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        try {
          const jsonRes = JSON.parse(stdout.trim());
          return resolve(jsonRes);
        } catch (_) {
          return resolve({ success: true, outputPath });
        }
      }

      // 2. Fallback to FFmpeg delogo filter if python/opencv worker encounters an issue
      console.warn('Python image inpaint fallback to FFmpeg delogo. Stderr:', stderr);
      inpaintWithFFmpegDelogo(inputPath, outputPath, box, true)
        .then(() => resolve({ success: true, outputPath, fallback: true }))
        .catch((err) => reject(new Error(`Image inpainting failed: ${err.message}`)));
    });

    proc.on('error', (err) => {
      console.warn('Python spawn error, falling back to FFmpeg delogo:', err.message);
      inpaintWithFFmpegDelogo(inputPath, outputPath, box, true)
        .then(() => resolve({ success: true, outputPath, fallback: true }))
        .catch((e) => reject(new Error(`Image inpainting failed: ${e.message}`)));
    });
  });
}

// Inpaint using FFmpeg delogo filter (High quality, high speed, lossless audio preservation)
function inpaintWithFFmpegDelogo(inputPath, outputPath, box, isImage = false) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFFmpegBinary();

    // Ensure coordinates are integers and strictly valid
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));

    const delogoFilter = `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`;

    let args = [];
    if (isImage) {
      args = ['-y', '-i', inputPath, '-vf', delogoFilter, outputPath];
    } else {
      args = [
        '-y',
        '-i', inputPath,
        '-vf', delogoFilter,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-c:a', 'copy',
        outputPath
      ];
    }

    const proc = spawn(ffmpeg, args, { shell: false });
    let stderr = '';

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath });
      } else {
        reject(new Error(`FFmpeg delogo processing failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`FFmpeg process failed: ${err.message}`));
    });
  });
}

// Inpaint a video with moving watermark tracking
async function inpaintVideoTracking({ inputPath, outputPath, box, method = 'telea' }) {
  const pythonBin = resolvePython();
  const scriptPath = path.join(__dirname, 'scripts', 'watermark_inpaint.py');
  const tempRawVideo = path.join(WATERMARK_TEMP_DIR, `track_raw_${crypto.randomBytes(8).toString('hex')}.mp4`);

  return new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      '--mode', 'video_track',
      '--input', inputPath,
      '--output', tempRawVideo,
      '--x', String(box.x),
      '--y', String(box.y),
      '--width', String(box.width),
      '--height', String(box.height),
      '--method', method === 'ns' ? 'ns' : 'telea',
      '--radius', '3'
    ];

    let stdout = '';
    let stderr = '';
    const proc = spawn(pythonBin, args, { shell: false });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempRawVideo)) {
        // Mux original audio into processed video
        const ffmpeg = getFFmpegBinary();
        const muxArgs = [
          '-y',
          '-i', tempRawVideo,
          '-i', inputPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '20',
          '-map', '0:v:0',
          '-map', '1:a:0?',
          '-c:a', 'copy',
          outputPath
        ];

        const muxProc = spawn(ffmpeg, muxArgs, { shell: false });
        muxProc.on('close', (muxCode) => {
          try { fs.unlinkSync(tempRawVideo); } catch (_) {}
          if (muxCode === 0 && fs.existsSync(outputPath)) {
            resolve({ success: true, outputPath });
          } else {
            // Fallback to static delogo
            inpaintWithFFmpegDelogo(inputPath, outputPath, box, false)
              .then(() => resolve({ success: true, outputPath, fallback: true }))
              .catch((e) => reject(new Error(`Video tracking muxing failed: ${e.message}`)));
          }
        });
        muxProc.on('error', () => {
          try { fs.unlinkSync(tempRawVideo); } catch (_) {}
          inpaintWithFFmpegDelogo(inputPath, outputPath, box, false)
            .then(() => resolve({ success: true, outputPath, fallback: true }))
            .catch(reject);
        });
      } else {
        console.warn('Video tracking failed, falling back to static delogo filter:', stderr);
        inpaintWithFFmpegDelogo(inputPath, outputPath, box, false)
          .then(() => resolve({ success: true, outputPath, fallback: true }))
          .catch((err) => reject(new Error(`Video inpainting failed: ${err.message}`)));
      }
    });

    proc.on('error', (err) => {
      console.warn('Video tracking spawn error, fallback to static delogo:', err.message);
      inpaintWithFFmpegDelogo(inputPath, outputPath, box, false)
        .then(() => resolve({ success: true, outputPath, fallback: true }))
        .catch(reject);
    });
  });
}

// Periodic cleanup of expired temporary files
function cleanupExpiredFiles() {
  const now = Date.now();

  for (const [fileId, item] of uploadedFiles.entries()) {
    if (now - item.createdAt > TTL_MS) {
      try { if (item.filePath && fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath); } catch (_) {}
      try { if (item.previewPath && fs.existsSync(item.previewPath)) fs.unlinkSync(item.previewPath); } catch (_) {}
      uploadedFiles.delete(fileId);
    }
  }

  for (const [processId, item] of processedJobs.entries()) {
    if (now - item.createdAt > TTL_MS) {
      try { if (item.outputPath && fs.existsSync(item.outputPath)) fs.unlinkSync(item.outputPath); } catch (_) {}
      try { if (item.previewPath && fs.existsSync(item.previewPath)) fs.unlinkSync(item.previewPath); } catch (_) {}
      processedJobs.delete(processId);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredFiles, 5 * 60 * 1000).unref();

module.exports = {
  WATERMARK_TEMP_DIR,
  uploadedFiles,
  processedJobs,
  validateUploadedFile,
  probeMedia,
  extractVideoKeyframe,
  inpaintImage,
  inpaintWithFFmpegDelogo,
  inpaintVideoTracking,
  cleanupExpiredFiles
};
