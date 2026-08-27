// ================================================================
// KAGE Culture — Auth routes (admin + customer + password reset)
// ================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth } = require('../middleware/auth');
const { strictLimiter, resetLimiter } = require('../middleware/rateLimit');
const { hashToken } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');

module.exports = function createAuthRoutes(db, SESSION_SECRET) {
  const router = express.Router();

  // --- Admin setup (first-run) ---
  router.post('/api/admin/setup', strictLimiter, async (req, res) => {
    try {
      const existing = await db.prepare('SELECT id FROM admin LIMIT 1').get();
      if (existing) return res.status(400).json({ error: 'Admin account already exists.' });
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      if (password.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const hash = await bcrypt.hash(password, 12);
      await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run(email, hash);
      res.json({ success: true, message: 'Admin account created.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Admin login ---
  router.post('/api/admin/login', strictLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      let admin = await db.prepare('SELECT * FROM admin WHERE email = ?').get(email);
      if (!admin && process.env.AUTO_CREATE_ADMIN === 'true' && password.length >= config.ADMIN_AUTO_CREATE_MIN_LENGTH) {
        const hash = await bcrypt.hash(password, 12);
        const result = await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run([email, hash]);
        admin = { id: result.lastInsertRowid, email, password_hash: hash };
        console.log('✅ Auto-created admin:', email);
      }
      if (!admin) return res.status(401).json({ error: 'Invalid credentials.' });
      const match = await bcrypt.compare(password, admin.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials.' });
      req.session.adminId = admin.id;
      const cookieVal = Buffer.from(JSON.stringify({ adminId: admin.id })).toString('base64');
      const sig = crypto.createHmac('sha256', SESSION_SECRET).update(cookieVal).digest('base64');
      res.setHeader('Set-Cookie', `kage.session=${cookieVal}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      res.json({ success: true, admin: { email: admin.email } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Admin check auth ---
  router.get('/api/admin/me', requireAuth, async (req, res) => {
    const admin = await db.prepare('SELECT id, email, created_at FROM admin WHERE id = ?').get(req.adminId);
    res.json({ admin });
  });

  // --- Admin logout ---
  router.post('/api/admin/logout', requireCsrf, (req, res) => {
    req.session = null;
    res.json({ success: true });
  });

  // --- Admin change password ---
  router.post('/api/admin/change-password', requireCsrf, requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new passwords are required.' });
      if (newPassword.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `New password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const admin = await db.prepare('SELECT * FROM admin WHERE id = ?').get(req.adminId);
      if (!admin) return res.status(404).json({ error: 'Admin not found.' });
      const match = await bcrypt.compare(currentPassword, admin.password_hash);
      if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
      const newHash = await bcrypt.hash(newPassword, 12);
      await db.prepare('UPDATE admin SET password_hash = ? WHERE id = ?').run(newHash, req.adminId);
      res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Admin create new admin ---
  router.post('/api/admin/create', requireCsrf, requireAuth, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      if (password.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const existing = await db.prepare('SELECT id FROM admin WHERE email = ?').get(email);
      if (existing) return res.status(400).json({ error: 'An admin with that email already exists.' });
      const hash = await bcrypt.hash(password, 12);
      await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run(email, hash);
      res.json({ success: true, message: 'Admin account created.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Password reset: request ---
  router.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
    try {
      const { email, user_type } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required.' });
      const clean = String(email).trim().toLowerCase();
      const type = user_type === 'customer' ? 'customer' : 'admin';
      const table = type === 'customer' ? 'customers' : 'admin';
      const user = await db.prepare(`SELECT id, email FROM ${table} WHERE email = ?`).get(clean);
      if (!user) return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + config.RESET_TOKEN_EXPIRY_MS).toISOString().replace('T', ' ').slice(0, 19);
      await db.prepare('INSERT INTO password_reset_tokens (user_type, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(type, user.id, tokenHash, expiresAt);
      const resetUrl = `${process.env.SITE_URL || 'https://kage-culture.vercel.app'}/reset-password?token=${rawToken}&type=${type}`;
      const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Password Reset</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">We received a request to reset your password. Click the link below to set a new password. This link expires in 1 hour.</p>
      <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#4A4433;color:#FFF;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;border-radius:8px;">Reset Password</a>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </div>`;
      await sendEmail(clean, 'Reset your KAGE Culture password', html);
      res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Password reset: execute ---
  router.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { token, password, user_type } = req.body;
      if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
      if (password.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const tokenHash = hashToken(token);
      const record = await db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0').get(tokenHash);
      if (!record) return res.status(400).json({ error: 'Invalid or expired reset token.' });
      if (Date.now() > new Date(record.expires_at).getTime()) {
        await db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);
        return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
      }
      const table = record.user_type === 'customer' ? 'customers' : 'admin';
      const newHash = await bcrypt.hash(password, 12);
      await db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(newHash, record.user_id);
      await db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);
      res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Customer signup ---
  router.post('/api/customers/signup', requireCsrf, async (req, res) => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      if (password.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const clean = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      const existing = await db.prepare('SELECT id FROM customers WHERE email = ?').get(clean);
      if (existing) return res.status(400).json({ error: 'An account with that email already exists.' });
      const hash = await bcrypt.hash(password, 12);
      const customerName = String(name || '').trim().slice(0, 80);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const result = await db.prepare('INSERT INTO customers (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)').run(clean, hash, customerName, now);
      const customerId = result.lastInsertRowid;
      req.session.customerId = customerId;
      const cookieVal = Buffer.from(JSON.stringify({ customerId })).toString('base64');
      const sig = crypto.createHmac('sha256', SESSION_SECRET).update(cookieVal).digest('base64');
      res.setHeader('Set-Cookie', `kage.cust=${cookieVal}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      res.json({ success: true, customer: { id: customerId, email: clean, name: customerName } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Customer login ---
  router.post('/api/customers/login', requireCsrf, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      const customer = await db.prepare('SELECT * FROM customers WHERE email = ?').get(email.trim().toLowerCase());
      if (!customer) return res.status(401).json({ error: 'Invalid email or password.' });
      const match = await bcrypt.compare(password, customer.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid email or password.' });
      req.session.customerId = customer.id;
      const cookieVal = Buffer.from(JSON.stringify({ customerId: customer.id })).toString('base64');
      const sig = crypto.createHmac('sha256', SESSION_SECRET).update(cookieVal).digest('base64');
      res.setHeader('Set-Cookie', `kage.cust=${cookieVal}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      res.json({ success: true, customer: { id: customer.id, email: customer.email, name: customer.name, phone: customer.phone, address: customer.address, city: customer.city } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Customer logout ---
  router.post('/api/customers/logout', requireCsrf, (req, res) => {
    req.session = null;
    res.setHeader('Set-Cookie', 'kage.cust=; Path=/; HttpOnly; Max-Age=0');
    res.json({ success: true });
  });

  return router;
};
