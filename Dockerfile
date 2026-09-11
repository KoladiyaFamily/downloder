FROM node:20-bookworm-slim

# Install system dependencies: Python3 + venv module, FFmpeg, curl, ca-certificates.
# python-is-python3 is intentionally NOT installed — /opt/venv/bin/python is the sole
# interpreter used for yt-dlp; no ambiguous /usr/bin/python symlink is needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated virtual environment — this is the ONLY Python environment
# that server.js will use for yt-dlp. No system-wide pip installs, no ambiguity.
RUN python3 -m venv /opt/venv

# Install latest yt-dlp and media processing libraries into the venv using the venv's own pip.
RUN /opt/venv/bin/python -m pip install --no-cache-dir -U yt-dlp curl-cffi opencv-python-headless numpy pillow

# --- Build-time verification (must pass or build hard-fails) ---
# 1. CLI round-trip: /opt/venv/bin/python can run yt_dlp and print version.
RUN /opt/venv/bin/python -m yt_dlp --version
# 2. Import check: yt_dlp, cv2, numpy, PIL are fully importable from the venv.
RUN /opt/venv/bin/python -c "import yt_dlp, cv2, numpy, PIL; print('Python imports OK: yt-dlp', yt_dlp.version.__version__, 'cv2', cv2.__version__)"

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY . .

# Ensure data and temporary directories exist with proper permissions
RUN mkdir -p /data /tmp/antigravity_video_temp/clips /tmp/antigravity_video_temp/watermark

# Expose Render PORT
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["node", "server.js"]
