FROM node:20-bookworm-slim

# Install system dependencies: Python3, pip, python-is-python3, and FFmpeg (includes ffprobe)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python-is-python3 \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via python3 -m pip to guarantee it is installed into the exact
# Python3 interpreter that server.js will call (`python3 -m yt_dlp`).
# Using pip3 or a bare pip may target a different interpreter / path on some distros.
RUN python3 -m pip install --no-cache-dir --break-system-packages -U yt-dlp

# Verify that python3 can actually import and run yt_dlp — hard-fail the build if not.
RUN python3 -m yt_dlp --version

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
