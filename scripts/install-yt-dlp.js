'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

console.log('====================================================');
console.log('  ANTIGRAVITY YT-DLP PRODUCTION INSTALLER & VERIFIER ');
console.log('====================================================');

const projectRoot = path.join(__dirname, '..');
const venvDir = path.join(projectRoot, '.venv');

function runCmd(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: false,
    ...options
  });
  return res.status === 0;
}

function runCmdOutput(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { shell: false });
    if (res.status === 0) {
      return (res.stdout || Buffer.alloc(0)).toString().trim();
    }
  } catch (_) {}
  return null;
}

function findBasePython() {
  const candidates = ['python3', 'python'];
  for (const c of candidates) {
    const ver = runCmdOutput(c, ['--version']);
    if (ver) {
      console.log(`✔ Found base Python interpreter: ${c} (${ver})`);
      return c;
    }
  }
  return null;
}

function getVenvPython(dir) {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'python.exe' : 'python';
  const subDir = isWin ? 'Scripts' : 'bin';
  return path.join(dir, subDir, binName);
}

function verifyYtDlp(pythonExec) {
  if (!pythonExec || !fs.existsSync(pythonExec)) return false;

  const ver = runCmdOutput(pythonExec, ['-m', 'yt_dlp', '--version']);
  if (!ver) return false;

  const importVer = runCmdOutput(pythonExec, ['-c', 'import yt_dlp; print(yt_dlp.version.__version__)']);
  if (!importVer) return false;

  console.log(`✔ VERIFIED: ${pythonExec} -> yt-dlp ${ver} (import confirmed)`);
  return true;
}

function main() {
  const venvPython = getVenvPython(venvDir);

  // If already installed and verified, skip reinstall unless forced
  if (verifyYtDlp(venvPython) && !process.env.FORCE_YTDLP_INSTALL) {
    console.log('✔ Existing .venv yt-dlp is valid and ready.');
    process.exit(0);
  }

  const basePython = findBasePython();
  if (!basePython) {
    console.error('FATAL: No Python interpreter found on the system. Please install Python 3.');
    process.exit(1);
  }

  // 1. Try creating project-local virtual environment
  console.log(`\nCreating virtual environment at ${venvDir}...`);
  let venvCreated = runCmd(basePython, ['-m', 'venv', venvDir]);

  if (!venvCreated) {
    console.warn('Virtualenv creation failed or ensurepip missing. Attempting with --without-pip...');
    venvCreated = runCmd(basePython, ['-m', 'venv', '--without-pip', venvDir]);
  }

  let targetPython = null;

  if (venvCreated && fs.existsSync(venvPython)) {
    console.log(`\nInstalling yt-dlp into ${venvPython}...`);
    let pipOk = runCmd(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', '-U', 'yt-dlp']);
    if (!pipOk) {
      runCmd(basePython, ['-m', 'ensurepip', '--upgrade']);
      pipOk = runCmd(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', '-U', 'yt-dlp']);
    }

    if (verifyYtDlp(venvPython)) {
      targetPython = venvPython;
    }
  }

  // Fallback 1: Install to system / user Python if venv pip failed
  if (!targetPython) {
    console.log('\nFallback: Installing yt-dlp via base Python pip...');
    runCmd(basePython, ['-m', 'pip', 'install', '--no-cache-dir', '--break-system-packages', '-U', 'yt-dlp']);
    if (verifyYtDlp(basePython)) {
      targetPython = basePython;
    }
  }

  // Fallback 2: Try /opt/venv if on Linux/Render
  const optVenvPython = '/opt/venv/bin/python';
  if (!targetPython && fs.existsSync(optVenvPython)) {
    if (verifyYtDlp(optVenvPython)) {
      targetPython = optVenvPython;
    }
  }

  if (!targetPython) {
    console.error('\nFATAL: Failed to install or verify yt-dlp with any Python interpreter.');
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log(`✔ SUCCESS: yt-dlp installed and verified on: ${targetPython}`);
  console.log('====================================================\n');
}

main();
