'use strict';

/**
 * auth/db.js – Production-grade user persistence layer.
 * 
 * Supports Render PostgreSQL via process.env.DATABASE_URL with
 * automatic table creation (users table).
 * 
 * When DATABASE_URL is not set (e.g. local offline development or local unit tests),
 * seamlessly falls back to local file-based persistent storage so local dev/tests run 100% offline.
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');

const BCRYPT_ROUNDS = 12;

// ── Local File Fallback Settings ──────────────────────────────────────────
function resolveDataDir() {
  if (process.env.DB_PATH) return path.dirname(process.env.DB_PATH);
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── PostgreSQL Connection Pool Management ──────────────────────────────────
let pool = null;
let dbInitialized = false;

function isPg() {
  return Boolean(process.env.DATABASE_URL);
}

function getPgPool() {
  if (!pool && process.env.DATABASE_URL) {
    const isProdOrRender = process.env.NODE_ENV === 'production' ||
                           process.env.DATABASE_URL.includes('render.com') ||
                           process.env.PGSSLMODE === 'require';
    
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isProdOrRender ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

async function initDb() {
  if (dbInitialized) return;

  if (isPg()) {
    const client = getPgPool();
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));
    `;
    await client.query(createTableQuery);
  }

  dbInitialized = true;
}

// ── In-Memory File Cache (Fallback mode) ───────────────────────────────────
let _cache = null;

function loadUsersFile() {
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

function saveUsersFile(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
  _cache = users;
}

function getUsersFile() {
  if (!_cache) loadUsersFile();
  return _cache;
}

// ── Validation Helpers ──────────────────────────────────────────────────────
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

// ── Password Helpers ────────────────────────────────────────────────────────
async function verifyPassword(plain, hash) {
  try {
    return await bcrypt.compare(String(plain), String(hash));
  } catch (_) {
    return false;
  }
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

// ── Data Access Methods (Async) ─────────────────────────────────────────────

async function getUserByEmail(email) {
  if (!email) return null;
  const norm = email.trim().toLowerCase();

  if (isPg()) {
    await initDb();
    const res = await getPgPool().query(
      'SELECT id, email, password, role, is_active, created_at, updated_at FROM users WHERE LOWER(email) = LOWER($1)',
      [norm]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      email: r.email,
      password: r.password,
      role: r.role,
      is_active: Number(r.is_active),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  loadUsersFile();
  return getUsersFile().find(u => u.email.toLowerCase() === norm) || null;
}

async function getUserById(id) {
  if (!id) return null;

  if (isPg()) {
    await initDb();
    const res = await getPgPool().query(
      'SELECT id, email, password, role, is_active, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      email: r.email,
      password: r.password,
      role: r.role,
      is_active: Number(r.is_active),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  }

  return getUsersFile().find(u => u.id === id) || null;
}

async function getAllUsers() {
  if (isPg()) {
    await initDb();
    const res = await getPgPool().query(
      'SELECT id, email, role, is_active, created_at, updated_at FROM users ORDER BY created_at ASC'
    );
    return res.rows.map(r => ({
      id: r.id,
      email: r.email,
      role: r.role,
      is_active: Number(r.is_active),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    }));
  }

  return getUsersFile().map(u => ({
    id: u.id,
    email: u.email,
    role: u.role,
    is_active: Number(u.is_active),
    created_at: u.created_at,
    updated_at: u.updated_at,
  }));
}

async function createUser(email, hashedPassword, role = 'user') {
  const normEmail = email.trim().toLowerCase();
  const existing = await getUserByEmail(normEmail);
  if (existing) throw new Error('Email already exists.');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const isActiveNum = 1;

  if (isPg()) {
    await initDb();
    await getPgPool().query(
      `INSERT INTO users (id, email, password, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, normEmail, hashedPassword, role, isActiveNum, now, now]
    );
    return {
      id,
      email: normEmail,
      password: hashedPassword,
      role,
      is_active: isActiveNum,
      created_at: now,
      updated_at: now,
    };
  }

  loadUsersFile();
  const user = {
    id,
    email: normEmail,
    password: hashedPassword,
    role,
    is_active: isActiveNum,
    created_at: now,
    updated_at: now,
  };
  const users = getUsersFile();
  users.push(user);
  saveUsersFile(users);
  return { ...user };
}

async function updateUserEmail(id, email) {
  const normEmail = email.trim().toLowerCase();
  const now = new Date().toISOString();

  if (isPg()) {
    await initDb();
    const res = await getPgPool().query(
      'UPDATE users SET email = $1, updated_at = $2 WHERE id = $3',
      [normEmail, now, id]
    );
    if (res.rowCount === 0) throw new Error('User not found.');
    return;
  }

  loadUsersFile();
  const users = getUsersFile();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found.');
  users[idx].email = normEmail;
  users[idx].updated_at = now;
  saveUsersFile(users);
}

async function updateUserPassword(id, hashedPassword) {
  const now = new Date().toISOString();

  if (isPg()) {
    await initDb();
    const res = await getPgPool().query(
      'UPDATE users SET password = $1, updated_at = $2 WHERE id = $3',
      [hashedPassword, now, id]
    );
    if (res.rowCount === 0) throw new Error('User not found.');
    return;
  }

  loadUsersFile();
  const users = getUsersFile();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found.');
  users[idx].password = hashedPassword;
  users[idx].updated_at = now;
  saveUsersFile(users);
}

async function updateUserStatus(id, isActive) {
  const now = new Date().toISOString();
  const isActiveNum = isActive ? 1 : 0;

  if (isPg()) {
    await initDb();
    const res = await getPgPool().query(
      'UPDATE users SET is_active = $1, updated_at = $2 WHERE id = $3',
      [isActiveNum, now, id]
    );
    if (res.rowCount === 0) throw new Error('User not found.');
    return;
  }

  loadUsersFile();
  const users = getUsersFile();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User not found.');
  users[idx].is_active = isActiveNum;
  users[idx].updated_at = now;
  saveUsersFile(users);
}

async function deleteUser(id) {
  if (isPg()) {
    await initDb();
    const res = await getPgPool().query('DELETE FROM users WHERE id = $1', [id]);
    if (res.rowCount === 0) throw new Error('User not found.');
    return;
  }

  loadUsersFile();
  const users = getUsersFile().filter(u => u.id !== id);
  saveUsersFile(users);
}

async function getAdminCount() {
  if (isPg()) {
    await initDb();
    const res = await getPgPool().query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
    return parseInt(res.rows[0].count, 10) || 0;
  }

  return getUsersFile().filter(u => u.role === 'admin').length;
}

// ── Bootstrap Admin Account ────────────────────────────────────────────────
async function bootstrapAdmin() {
  await initDb();

  const adminCount = await getAdminCount();
  if (adminCount > 0) return;

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: No admin account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set.');
      process.exit(1);
    }
    // Dev / test safe defaults
    const devEmail = 'admin@test.local';
    const devPass = 'Admin@123456';
    const hash = await hashPassword(devPass);
    await createUser(devEmail, hash, 'admin');
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
  await createUser(adminEmail, hash, 'admin');
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
  isPg,
};
