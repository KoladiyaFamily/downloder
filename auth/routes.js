'use strict';

/**
 * auth/routes.js  –  All authentication and admin-management API routes.
 *
 * Mounted in server.js via:
 *   app.use('/', createAuthRouter(rateLimiter));
 */

const express = require('express');
const db      = require('./db');
const { requireAuth, requireAdmin, requireUser } = require('./middleware');

module.exports = function createAuthRouter(rateLimiter) {
  const router = express.Router();

  // ── Login rate limiter: 5 attempts per minute per IP ──────────────────
  const loginLimiter = rateLimiter(5, 60 * 1000);

  // =========================================================================
  // PUBLIC AUTH ROUTES
  // =========================================================================

  // POST /api/auth/login
  router.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await db.getUserByEmail(email);
    if (!user) {
      // Timing-safe: still run bcrypt to prevent user enumeration
      await bcryptDummy();
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const match = await db.verifyPassword(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been disabled. Contact the administrator.' });
    }

    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error. Please try again.' });

      req.session.userId = user.id;
      req.session.role   = user.role;
      req.session.email  = user.email;

      // Save session before responding
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Session save error.' });
        return res.json({ authenticated: true, role: user.role });
      });
    });
  });

  // POST /api/auth/logout
  router.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('sid');
      return res.json({ success: true });
    });
  });

  // GET /api/auth/logout (for simple link clicks)
  router.get('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('sid');
      return res.redirect('/login');
    });
  });

  // GET /api/auth/me  –  returns minimal identity (no passwords)
  router.get('/api/auth/me', requireAuth, (req, res) => {
    return res.json({
      authenticated: true,
      role: req.session.role,
      email: req.session.email,
    });
  });

  // GET /api/auth/status  –  backward-compatible status check
  router.get('/api/auth/status', (req, res) => {
    if (process.env.NODE_ENV === 'test' && !process.env.TEST_REQUIRE_AUTH && !req.headers['x-test-enforce-auth']) {
      return res.json({ authenticated: true, privateMode: true });
    }
    const authenticated = !!(req.session && req.session.userId);
    return res.json({ authenticated, privateMode: true, role: req.session ? req.session.role : null });
  });

  // =========================================================================
  // ADMIN USER MANAGEMENT
  // =========================================================================

  // GET /admin/api/users  –  list all users
  router.get('/admin/api/users', requireAdmin, async (req, res) => {
    const users = await db.getAllUsers();
    return res.json({ success: true, users });
  });

  // POST /admin/api/users  –  create a new user
  router.post('/admin/api/users', requireAdmin, async (req, res) => {
    const { email, password, role } = req.body || {};

    if (!email || !db.isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || !db.isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
    }
    if (role && role !== 'user' && role !== 'admin') {
      return res.status(400).json({ error: 'Role must be "user" or "admin".' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    try {
      const hashed = await db.hashPassword(password);
      const user = await db.createUser(email, hashed, role || 'user');
      return res.status(201).json({
        success: true,
        user: { id: user.id, email: user.email, role: user.role, is_active: user.is_active, created_at: user.created_at },
      });
    } catch (err) {
      return res.status(409).json({ error: err.message || 'Could not create user.' });
    }
  });

  // PUT /admin/api/users/:id  –  update email or status
  router.put('/admin/api/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { email, is_active } = req.body || {};

    const user = await db.getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (email !== undefined) {
      if (!db.isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address.' });
      const existing = await db.getUserByEmail(email);
      if (existing && existing.id !== id) return res.status(409).json({ error: 'Email already in use.' });
      await db.updateUserEmail(id, email);
    }

    if (is_active !== undefined) {
      // Prevent disabling the last active admin
      if (!is_active && user.role === 'admin' && (await db.getAdminCount()) <= 1) {
        return res.status(400).json({ error: 'Cannot disable the only admin account.' });
      }
      await db.updateUserStatus(id, !!is_active);
    }

    const updated = await db.getUserById(id);
    return res.json({ success: true, user: sanitizeUser(updated) });
  });

  // PUT /admin/api/users/:id/password  –  reset user password
  router.put('/admin/api/users/:id/password', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body || {};

    if (!password || !db.isStrongPassword(password)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
    }

    const user = await db.getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const hashed = await db.hashPassword(password);
    await db.updateUserPassword(id, hashed);

    return res.json({ success: true, message: 'Password updated. User must log in again with new password.' });
  });

  // PUT /admin/api/users/:id/status  –  enable / disable
  router.put('/admin/api/users/:id/status', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body || {};

    const user = await db.getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!is_active && user.role === 'admin' && (await db.getAdminCount()) <= 1) {
      return res.status(400).json({ error: 'Cannot disable the only admin account.' });
    }

    await db.updateUserStatus(id, !!is_active);
    return res.json({ success: true });
  });

  // DELETE /admin/api/users/:id
  router.delete('/admin/api/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;

    const user = await db.getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.role === 'admin') {
      if ((await db.getAdminCount()) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only admin account.' });
      }
    }

    // Prevent self-deletion
    if (req.session && req.session.userId === id) {
      return res.status(400).json({ error: 'Cannot delete your own account while logged in.' });
    }

    await db.deleteUser(id);
    return res.json({ success: true });
  });

  // =========================================================================
  // ADMIN ACCOUNT SETTINGS  (change own email / password)
  // =========================================================================

  router.put('/admin/api/settings', requireAdmin, async (req, res) => {
    const { currentPassword, newEmail, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required.' });
    }

    const admin = await db.getUserById(req.session.userId);
    if (!admin) return res.status(404).json({ error: 'Admin account not found.' });

    const valid = await db.verifyPassword(currentPassword, admin.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    let changed = false;

    // Change email
    if (newEmail !== undefined && newEmail !== '') {
      if (!db.isValidEmail(newEmail)) return res.status(400).json({ error: 'Invalid new email address.' });
      const existing = await db.getUserByEmail(newEmail);
      if (existing && existing.id !== admin.id) return res.status(409).json({ error: 'Email already in use.' });
      await db.updateUserEmail(admin.id, newEmail);
      req.session.email = newEmail.trim().toLowerCase();
      changed = true;
    }

    // Change password
    if (newPassword !== undefined && newPassword !== '') {
      if (!db.isStrongPassword(newPassword)) {
        return res.status(400).json({ error: 'New password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New password and confirm password do not match.' });
      }
      const hashed = await db.hashPassword(newPassword);
      await db.updateUserPassword(admin.id, hashed);
      changed = true;

      // Invalidate session after password change — force re-login
      return req.session.destroy(() => {
        res.clearCookie('sid');
        return res.json({ success: true, sessionInvalidated: true, message: 'Password changed. Please log in again.' });
      });
    }

    return res.json({ success: true, changed });
  });

  // =========================================================================
  // USER ACCOUNT SETTINGS  (change own email / password)
  // =========================================================================

  router.put('/api/user/settings', requireAuth, async (req, res) => {
    const { currentPassword, newEmail, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required to make changes.' });
    }

    const user = await db.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User account not found.' });

    const valid = await db.verifyPassword(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    // Change email
    if (newEmail !== undefined && newEmail !== '') {
      if (!db.isValidEmail(newEmail)) return res.status(400).json({ error: 'Invalid new email address.' });
      const existing = await db.getUserByEmail(newEmail);
      if (existing && existing.id !== user.id) return res.status(409).json({ error: 'Email already in use.' });
      await db.updateUserEmail(user.id, newEmail);
      req.session.email = newEmail.trim().toLowerCase();
    }

    // Change password
    if (newPassword !== undefined && newPassword !== '') {
      if (!db.isStrongPassword(newPassword)) {
        return res.status(400).json({ error: 'New password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New password and confirm password do not match.' });
      }
      const hashed = await db.hashPassword(newPassword);
      await db.updateUserPassword(user.id, hashed);

      return req.session.destroy(() => {
        res.clearCookie('sid');
        return res.json({ success: true, sessionInvalidated: true, message: 'Password changed. Please log in again.' });
      });
    }

    return res.json({ success: true });
  });

  return router;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, is_active: u.is_active, created_at: u.created_at, updated_at: u.updated_at };
}

// Dummy bcrypt to normalise timing on failed email lookup
const bcrypt = require('bcryptjs');
const _DUMMY_HASH = bcrypt.hashSync('dummy_password_123!', 4);
async function bcryptDummy() {
  await bcrypt.compare('x', _DUMMY_HASH);
}
