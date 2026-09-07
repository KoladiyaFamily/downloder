'use strict';

/**
 * auth/db.js  –  Lightweight, file-persisted user store.
 *
 * Users are kept in a JSON file at DATA_DIR/users.json.
 * On Render: set DATA_DIR=/data (persistent disk mount).
 * Locally:   falls back to ./data/users.json.
 *
 * All writes use atomic rename-on-write so a crash never corrupts the file.
 * bcryptjs is used for password hashing (pure JS, no native compilation).
 */

const path = require('path');
const fs   = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_ROUNDS = 12;

// ── Data directory ─────────────────────────────────────────────────────────
function resolveDataDir() {
  if (process.env.DB_PATH) return path.dirname(process.env.DB_PATH);
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR  = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── In-process cache (re-read from disk on each mutating op for safety) ───
let _cache = null;

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      _cache = JSON.parse(raw);
    } else {
      _cache = [];
    }
  } catch (_) {
    _cache = [];
  }
  return _cache;
}

function saveUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
  _cache = users;
}

function getUsers() {
  if (!_cache) loadUsers();
  return _cache;
}

// ── Validation ─────────────────────────────────────────────────────────────
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(email.trim());
}

function isStrongPassword(password) {
  if (!password || typeof password !== 'string') return false;
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

// ── Password helpers ────────────────────────────────────────────────────────
async function verifyPassword(plain, hash) {
  try { return await bcrypt.compare(String(plain), String(hash)); }
  catch (_) { return false; }
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

// ── CRUD ────────────────────────────────────────────────────────────────────
function getUserByEmail(email) {
  if (!email) return null;
  const norm = email.trim().toLowerCase();
  return getUsers().find(u => u.email.toLowerCase() === norm) || null;
}

function getUserById(id) {
  return getUsers().find(u => u.id === id) || null;
}

function getAllUsers() {
  return getUsers().map(u => ({
    id: u.id,
    email: u.email,
    role: u.role,
    is_active: u.is_active,
    created_at: u.created_at,
    updated_at: u.updated_at,
  }));
}

function createUser(email, hashedPassword, role = 'user') {
  loadUsers();  // fresh read
  const existing = getUserByEmail(email);
  if (existing) throw new Error('Email already exists.');
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    email: email.trim().toLowerCase(),
    password: hashedPassword,
    role,
    is_active: 1,
    created_at: now,
    updated_at: now,
  };
  const users = getUsers();
  users.push(user);
  saveUsers(users);
  return { ...user };
}

function updateUserEmail(id, email) {
  loadUsers();
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found.');
  users[idx].email = email.trim().toLowerCase();
  users[idx].updated_at = new Date().toISOString();
  saveUsers(users);
}

function updateUserPassword(id, hashedPassword) {
  loadUsers();
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found.');
  users[idx].password = hashedPassword;
  users[idx].updated_at = new Date().toISOString();
  saveUsers(users);
}

function updateUserStatus(id, isActive) {
  loadUsers();
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found.');
  users[idx].is_active = isActive ? 1 : 0;
  users[idx].updated_at = new Date().toISOString();
  saveUsers(users);
}

function deleteUser(id) {
  loadUsers();
  const users = getUsers().filter(u => u.id !== id);
  saveUsers(users);
}

function getAdminCount() {
  return getUsers().filter(u => u.role === 'admin').length;
}

// ── Bootstrap admin on first run ─────────────────────────────────────────
async function bootstrapAdmin() {
  loadUsers();
  const hasAdmin = getUsers().some(u => u.role === 'admin');
  if (hasAdmin) return;

  const adminEmail    = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: No admin account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set.');
      process.exit(1);
    }
    // Dev / test safe defaults
    const devEmail = 'admin@test.local';
    const devPass  = 'Admin@123456';
    const hash = await hashPassword(devPass);
    createUser(devEmail, hash, 'admin');
    console.log('[AUTH] Dev admin created → admin@test.local / Admin@123456');
    return;
  }

  if (!isValidEmail(adminEmail)) {
    console.error('FATAL: ADMIN_EMAIL is not a valid email address.');
    process.exit(1);
  }
  if (!isStrongPassword(adminPassword)) {
    console.error('FATAL: ADMIN_PASSWORD does not meet strength requirements (8+ chars, upper+lower+digit+special).');
    process.exit(1);
  }

  const hash = await hashPassword(adminPassword);
  createUser(adminEmail, hash, 'admin');
  console.log('[AUTH] Admin account created from environment variables.');
}

module.exports = {
  bootstrapAdmin,
  isValidEmail,
  isStrongPassword,
  verifyPassword,
  hashPassword,
  getUserByEmail,
  getUserById,
  getAllUsers,
  createUser,
  updateUserEmail,
  updateUserPassword,
  updateUserStatus,
  deleteUser,
  getAdminCount,
  USERS_FILE,
};
