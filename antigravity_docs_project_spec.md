# Project Blueprint: Antigravity Autonomous Video Downloader Platform (MVP)

## 1. Executive Summary & Objective
This document serves as the master specification for the **Antigravity Video Downloader Platform**.
The goal is to deliver a minimal, clean, robust, and hardened single-page web platform where a user enters a supported video URL, inspects the video details/preview, and downloads the video file reliably.

---

## 2. Core User Flow
1. **Open**: User accesses the single-page application.
2. **Input**: User pastes a supported video URL into the input field.
3. **Inspect**: User clicks `Get Video`.
4. **Validation & Processing**: System validates the URL, performs anti-SSRF checks, and extracts metadata via the backend.
5. **Preview**: If downloadable, the UI reveals the video preview (title, thumbnail, duration, uploader) and a clear `Download Video` button.
6. **Download**: Clicking `Download Video` initiates the download with a sanitized filename and proper attachment headers.
7. **Error Handling**: If the URL cannot be processed (unsupported domain, private/DRM video, network failure), a clean non-technical message is displayed (`Unable to process this URL`).

---

## 3. Strict MVP Scope
- Single-page application only (`public/index.html` + static assets).
- No database, no user accounts, no login/signup.
- No download history, no dashboards, no payment/subscriptions, no admin panel.
- Support only publicly accessible videos on domains supported by the underlying extractor (`yt-dlp`).
- No DRM bypass, no authentication bypass, no paywall circumvention.

---

## 4. Security & Hardening Architecture

### 4.1 Anti-SSRF & Network Boundary Protection
- **Protocol Enforcement**: Strictly allows only `http:` and `https:` schemes. Disallows `file:`, `ftp:`, `javascript:`, `data:`, etc.
- **Length Constraint**: Enforces maximum URL length limit of 2048 characters.
- **Blocked Hostnames**: Blocks `localhost`, `*.local`, `*.internal`, `metadata.google.internal`, and cloud metadata addresses.
- **DNS Resolution Pre-Check**: Resolves the hostname before media extraction. Blocks loopback (`127.0.0.0/8`, `::1`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local/cloud metadata (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), and multicast ranges.

### 4.2 Safe Process Execution & Resource Governance
- **No Shell Execution**: Child processes are strictly spawned as argument arrays (`spawn('python', args, { shell: false })`) to eliminate command injection.
- **Rate Limiting**: Sliding window in-memory limiter restricts clients to 25 metadata queries/min and 6 downloads/min per IP.
- **Process Timeouts**:
  - 15-second hard timeout for metadata inspection.
  - 120-second timeout for media downloads.
- **File Size Ceiling**: Sets `--max-filesize 100M` on `yt-dlp` invocations to prevent disk space exhaustion.
- **Download Concurrency Limiting**: Caps global active downloads at 8 simultaneous streams.

### 4.3 Secure Temporary File Lifecycle
- Downloads to unique, isolated files generated via `crypto.randomUUID()`.
- Unlinks temporary files immediately when:
  - Streaming to the client completes (`res.on('finish')`).
  - Client aborts or disconnects early (`res.on('close')`).
  - An error or timeout occurs.
- Periodic cleanup worker sweeps any orphaned files older than 10 minutes.

### 4.4 HTTP Security Headers & Data Exposure Protection
- Content-Security-Policy (CSP) restricting scripts and frames (`frame-ancestors 'none'`).
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- `x-powered-by` header removed.
- Sanitized filenames prevent directory traversal (`../`) and illegal character injection.
- Zero server traces (no stack traces, process paths, or internal logs leaked in HTTP responses).

---

## 5. System Components

### 5.1 Frontend (`public/index.html`)
- Clean, high-performance dark-mode card UI.
- States: `Get Video` $\rightarrow$ `Processing...` $\rightarrow$ `Download Video`.
- Error state: `Unable to process this URL.`

### 5.2 Backend Server (`server.js`)
- Express server with static serving and port fallback (`3000` $\rightarrow$ `3001`+).
- `POST /api/info` (rate-limited metadata extraction).
- `GET /api/download` (rate-limited, sanitized file delivery).
- `GET /api/health` (liveness check).
