FROM node:20-bookworm-slim

# Install system dependencies: Python3, pip, FFmpeg (includes ffprobe), curl, ca-certificates.
# python-is-python3 is intentionally NOT installed — server.js calls python3 explicitly,
# so a /usr/bin/python symlink is never used and cannot silently resolve to the wrong interpreter.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp using python3's own pip module.
# This guarantees yt-dlp lands in the EXACT site-packages directory that
# `python3 -m yt_dlp` will search at runtime — no path ambiguity possible.
RUN python3 -m pip install --no-cache-dir --break-system-packages -U yt-dlp

# --- Build-time verification (both must pass or build fails) ---
# 1. CLI round-trip: python3 can launch yt_dlp as a module and print its version.
RUN python3 -m yt_dlp --version
# 2. Import check: the yt_dlp package is importable and reports its version string.
RUN python3 -c "import yt_dlp; print('yt_dlp import OK:', yt_dlp.version.__version__)"

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY . .

# Ensure data and temporary directories exist with proper permissions
RUN mkdir -p /data /tmp/antigravity_video_temp/clips

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
