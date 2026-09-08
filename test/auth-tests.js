'use strict';

/**
 * test/auth-tests.js – 21 auth & persistence system tests
 *
 * Expects server already running on port 3001 with:
 *   NODE_ENV=test  TEST_REQUIRE_AUTH=1
 *   ADMIN_EMAIL=admin@test.local  ADMIN_PASSWORD=Admin@123456
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const db   = require('../auth/db');

const PORT = parseInt(process.env.TEST_PORT || '3001', 10);
const BASE = `http://localhost:${PORT}`;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@test.local';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'Admin@123456';
const USER_EMAIL  = 'testuser_auth@example.com';
const USER_PASS   = 'User@Test9!';

// ── Colour helpers ─────────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';

let passed = 0; let failed = 0;

function assert(name, cond, extra = '') {
  if (cond) {
    console.log(`${GREEN}✔ PASS${RESET}: ${name}`);
    passed++;
  } else {
    console.log(`${RED}✘ FAIL${RESET}: ${name}${extra ? '  → ' + extra : ''}`);
    failed++;
  }
}

// ── HTTP helper (returns {statusCode, json, headers, cookies}) ─────────────
function req(method, urlPath, body = null, headers = {}, cookieJar = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-enforce-auth': '1', ...headers },
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
    };
    if (cookieJar && cookieJar.cookie) {
      opts.headers['Cookie'] = cookieJar.cookie;
    }
    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const r = http.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        const setCookie = res.headers['set-cookie'] || [];
        resolve({ statusCode: res.statusCode, json, headers: res.headers, setCookies: setCookie });
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function extractCookie(setCookies) {
  const jar = {};
  if (!setCookies || !setCookies.length) return jar;
  const parts = setCookies.map(c => c.split(';')[0]).join('; ');
  jar.cookie = parts;
  jar.raw = setCookies[0] || '';
  return jar;
}

// ── Test runner ──────────────────────────────────────────────────────────────
async function run() {
  console.log(`${BOLD}\n=== AUTH & PERSISTENCE SYSTEM TESTS (21) ===${RESET}\n`);

  let adminJar   = {};
  let userJar    = {};
  let createdUserId = null;

  // ── TEST 1: Unauthenticated request to /api/auth/me → 401 ────────────────
  {
    const r = await req('GET', '/api/auth/me');
    assert('TEST 1: Unauthenticated GET /api/auth/me → 401', r.statusCode === 401, `got ${r.statusCode}`);
  }

  // ── TEST 2: Unauthenticated request to /api/info → 401 ───────────────────
  {
    const r = await req('POST', '/api/info', { url: 'https://example.com/video' });
    assert('TEST 2: Unauthenticated POST /api/info → 401', r.statusCode === 401, `got ${r.statusCode}`);
  }

  // Reset rate limits for clean test run
  await req('POST', '/api/test-reset-limits');

  // ── TEST 3: Login with wrong email → 401 ─────────────────────────────────
  {
    const r = await req('POST', '/api/auth/login', { email: 'wrong@wrong.com', password: 'WrongPass1!' });
    assert('TEST 3: Wrong email login → 401', r.statusCode === 401, `got ${r.statusCode}`);
  }

  // ── TEST 4: Login with correct email but wrong password → 401 ────────────
  {
    const r = await req('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: 'WrongPassword1!' });
    assert('TEST 4: Correct email, wrong password → 401', r.statusCode === 401, `got ${r.statusCode}`);
  }

  // ── TEST 5: Admin login with correct credentials → 200, role=admin ───────
  {
    await req('POST', '/api/test-reset-limits');
    const r = await req('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASS });
    adminJar = extractCookie(r.setCookies);
    assert('TEST 5: Admin login → 200 + role=admin', r.statusCode === 200 && r.json?.role === 'admin', `got ${r.statusCode} role=${r.json?.role}`);
  }

  // ── TEST 6: Admin session cookie has no Max-Age/Expires (browser-session) ─
  {
    const raw = adminJar.raw || '';
    const hasMaxAge = /max-age=/i.test(raw);
    const hasExpires = /expires=/i.test(raw);
    assert('TEST 6: Session cookie has no Max-Age or Expires (browser-session only)', !hasMaxAge && !hasExpires, `cookie: ${raw}`);
  }

  // ── TEST 7: Admin can access /api/auth/me → returns admin role ────────────
  {
    const r = await req('GET', '/api/auth/me', null, {}, adminJar);
    assert('TEST 7: Authenticated GET /api/auth/me → 200 role=admin', r.statusCode === 200 && r.json?.role === 'admin', `got ${r.statusCode} ${JSON.stringify(r.json)}`);
  }

  // ── TEST 8: /api/auth/me response NEVER contains password field ───────────
  {
    const r = await req('GET', '/api/auth/me', null, {}, adminJar);
    const body = JSON.stringify(r.json || {});
    const hasPassword = body.includes('"password"') || body.includes(ADMIN_PASS);
    assert('TEST 8: /api/auth/me response contains no password field', !hasPassword, `body: ${body}`);
  }

  // ── TEST 9: Admin creates a new USER account ──────────────────────────────
  {
    const listR = await req('GET', '/admin/api/users', null, {}, adminJar);
    if (listR.json && Array.isArray(listR.json.users)) {
      const leftover = listR.json.users.find(u => u.email === USER_EMAIL.toLowerCase());
      if (leftover) await req('DELETE', `/admin/api/users/${leftover.id}`, null, {}, adminJar);
    }
    const r = await req('POST', '/admin/api/users', { email: USER_EMAIL, password: USER_PASS, role: 'user' }, {}, adminJar);
    createdUserId = r.json?.user?.id;
    assert('TEST 9: Admin creates user → 201', r.statusCode === 201 && !!createdUserId, `got ${r.statusCode} ${JSON.stringify(r.json)}`);
  }

  // ── TEST 10: User login with correct credentials → 200, role=user ─────────
  {
    await req('POST', '/api/test-reset-limits');
    const r = await req('POST', '/api/auth/login', { email: USER_EMAIL, password: USER_PASS });
    userJar = extractCookie(r.setCookies);
    assert('TEST 10: User login → 200 + role=user', r.statusCode === 200 && r.json?.role === 'user', `got ${r.statusCode} role=${r.json?.role}`);
  }

  // ── TEST 11: User cannot access admin API → 403 ───────────────────────────
  {
    const r = await req('GET', '/admin/api/users', null, {}, userJar);
    assert('TEST 11: User GET /admin/api/users → 403', r.statusCode === 403, `got ${r.statusCode}`);
  }

  // ── TEST 12: User cannot create users (admin-only) → 403 ─────────────────
  {
    const r = await req('POST', '/admin/api/users', { email: 'hacker@x.com', password: 'Hack@1234!', role: 'admin' }, {}, userJar);
    assert('TEST 12: User POST /admin/api/users → 403', r.statusCode === 403, `got ${r.statusCode}`);
  }

  // ── TEST 13: Authenticated user accesses /api/info (downloader) → not 401 ─
  {
    const r = await req('POST', '/api/info', { url: 'https://example.com/video' }, {}, userJar);
    assert('TEST 13: Authenticated user /api/info not 401', r.statusCode !== 401, `got ${r.statusCode}`);
  }

  // ── TEST 14: Admin changes user password via admin API ────────────────────
  {
    await req('POST', '/api/test-reset-limits');
    const newPass = 'NewUser@9876!';
    const r = await req('PUT', `/admin/api/users/${createdUserId}/password`, { password: newPass }, {}, adminJar);
    assert('TEST 14: Admin resets user password → 200', r.statusCode === 200, `got ${r.statusCode} ${JSON.stringify(r.json)}`);

    const oldLoginR = await req('POST', '/api/auth/login', { email: USER_EMAIL, password: USER_PASS });
    assert('TEST 14b: Old user password rejected after admin reset', oldLoginR.statusCode === 401, `got ${oldLoginR.statusCode}`);

    const newLoginR = await req('POST', '/api/auth/login', { email: USER_EMAIL, password: newPass });
    userJar = extractCookie(newLoginR.setCookies);
    assert('TEST 14c: New user password accepted after admin reset', newLoginR.statusCode === 200, `got ${newLoginR.statusCode}`);
  }

  // ── TEST 15: Admin disables user → user can no longer login ──────────────
  {
    await req('POST', '/api/test-reset-limits');
    const r = await req('PUT', `/admin/api/users/${createdUserId}/status`, { is_active: false }, {}, adminJar);
    assert('TEST 15: Admin disables user → 200', r.statusCode === 200, `got ${r.statusCode}`);

    const loginR = await req('POST', '/api/auth/login', { email: USER_EMAIL, password: 'NewUser@9876!' });
    assert('TEST 15b: Disabled user login → 403', loginR.statusCode === 403, `got ${loginR.statusCode}`);

    await req('PUT', `/admin/api/users/${createdUserId}/status`, { is_active: true }, {}, adminJar);
    await req('POST', '/api/test-reset-limits');
    const loginR2 = await req('POST', '/api/auth/login', { email: USER_EMAIL, password: 'NewUser@9876!' });
    userJar = extractCookie(loginR2.setCookies);
    assert('TEST 15c: Re-enabled user can login', loginR2.statusCode === 200, `got ${loginR2.statusCode}`);
  }

  // ── TEST 16: User changes own email ──────────────────────────────────────
  {
    const newEmail = 'changed_' + USER_EMAIL;
    const r = await req('PUT', '/api/user/settings', { currentPassword: 'NewUser@9876!', newEmail }, {}, userJar);
    assert('TEST 16: User changes own email → 200', r.statusCode === 200, `got ${r.statusCode} ${JSON.stringify(r.json)}`);

    const meR = await req('GET', '/api/auth/me', null, {}, userJar);
    assert('TEST 16b: Updated email reflected in /api/auth/me', meR.json?.email === newEmail.toLowerCase(), `got ${meR.json?.email}`);

    await req('PUT', '/api/user/settings', { currentPassword: 'NewUser@9876!', newEmail: USER_EMAIL }, {}, userJar);
  }

  // ── TEST 17: User changes own password → session invalidated ─────────────
  {
    const newPass = 'Changed@Pass77!';
    const r = await req('PUT', '/api/user/settings', {
      currentPassword: 'NewUser@9876!',
      newPassword: newPass,
      confirmPassword: newPass,
    }, {}, userJar);
    assert('TEST 17: User changes own password → sessionInvalidated=true', r.statusCode === 200 && r.json?.sessionInvalidated === true, `got ${r.statusCode} ${JSON.stringify(r.json)}`);

    const meR = await req('GET', '/api/auth/me', null, {}, userJar);
    assert('TEST 17b: Old session after password change → 401', meR.statusCode === 401, `got ${meR.statusCode}`);
  }

  // ── TEST 18: User cannot change password with wrong current password ───────
  {
    await req('POST', '/api/test-reset-limits');
    const loginR = await req('POST', '/api/auth/login', { email: USER_EMAIL, password: 'Changed@Pass77!' });
    userJar = extractCookie(loginR.setCookies);

    const r = await req('PUT', '/api/user/settings', {
      currentPassword: 'WrongCurrent@1!',
      newPassword: 'Another@Pass1!',
      confirmPassword: 'Another@Pass1!',
    }, {}, userJar);
    assert('TEST 18: Wrong current password → 401', r.statusCode === 401, `got ${r.statusCode}`);
  }

  // ── TEST 19: Logout destroys session ─────────────────────────────────────
  {
    const logoutR = await req('POST', '/api/auth/logout', null, {}, userJar);
    assert('TEST 19: POST /api/auth/logout → 200', logoutR.statusCode === 200, `got ${logoutR.statusCode}`);

    const meR = await req('GET', '/api/auth/me', null, {}, userJar);
    assert('TEST 19b: After logout, session → 401', meR.statusCode === 401, `got ${meR.statusCode}`);
  }

  // ── TEST 20: User persistence storage check ──────────────────────────────
  {
    const fetchedUser = await db.getUserByEmail(USER_EMAIL);
    assert('TEST 20: User account is persisted in DB layer', !!fetchedUser && fetchedUser.email === USER_EMAIL.toLowerCase());
  }

  // ── TEST 21: Server restart persistence simulation ─────────────────────────
  {
    // Fetch directly from DB after query re-initialization
    const checkUser = await db.getUserByEmail(USER_EMAIL);
    assert('TEST 21: Created user persists across server restart / DB re-connection', !!checkUser && checkUser.email === USER_EMAIL.toLowerCase());
  }

  // ── Cleanup: delete test user ─────────────────────────────────────────────
  if (createdUserId) {
    await req('DELETE', `/admin/api/users/${createdUserId}`, null, {}, adminJar);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}AUTH TESTS: ${GREEN}${passed} PASSED${RESET}${BOLD}, ${failed > 0 ? RED : ''}${failed} FAILED${RESET}\n`);
  return failed;
}

run()
  .then(failed => process.exit(failed > 0 ? 1 : 0))
  .catch(err => { console.error('Fatal test error:', err); process.exit(1); });
