// ================================================================
// KAGE Culture — Auth routes (admin + customer + password reset)
// ================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const { requireCsrf } = require('../middleware/csrf');
const { requireAuth, requireCustomerAuth, optionalCustomerId } = require('../middleware/auth');
const { strictLimiter, adminLoginLimiter, customerLoginLimiter, resetLimiter } = require('../middleware/rateLimit');
const { hashToken, isValidEmail } = require('../utils/helpers');
const { getSessionSecret } = require('../utils/secret');
const { getConfiguredSiteUrl } = require('../utils/siteUrl');
const { sendEmail, sendVerificationEmail, buildLink, escapeHtml } = require('../utils/email');

// SESSION_SECRET defaults through utils/secret.js so this route file can never
// carry its own copy of the fallback.
// One kage.session cookie carries BOTH identities (adminId and customerId), so
// a logout must drop only its own key. Assigning `req.session = null` here used
// to sign the other identity out of the same browser too.
function clearSessionIdentity(req, key) {
  if (!req.session) return;
  delete req.session[key];
  const identities = Object.keys(req.session).filter((k) => k === 'adminId' || k === 'customerId');
  if (identities.length === 0) req.session = null; // nothing left — drop the cookie
}

const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_FAILURES = 5;
const CUSTOMER_LOGIN_FAILURES = 10;
const INVALID_LOGIN = { error: 'Invalid credentials.' };
const LOCKED_LOGIN = { error: 'Too many attempts. Please try again later.' };
// Reuse a cost-12 hash for unknown addresses so a missing account follows the
// same password-hash work and never becomes an easy timing-based enum signal.
const DUMMY_PASSWORD_HASH = '$2a$12$f67gNGt3nUl6QJawSDf7PO3u0ZSfICyQ7VunDLHG4/EGn5a78wfo2';

function loginFailureKey(accountType, email) {
  // Keep the admin key in the requested login_fail:<email> form, and give
  // customer accounts a separate namespace if both identities use one email.
  const cleanEmail = String(email || '').trim().toLowerCase();
  return accountType === 'admin'
    ? `login_fail:${cleanEmail}`
    : `login_fail:customer:${cleanEmail}`;
}

async function activeLoginLockout(db, key, threshold) {
  const row = await db.getRateLimit(key);
  if (!row || Number(row.count) < threshold || Number(row.reset_at) <= Date.now()) return null;
  return { count: Number(row.count), reset_at: Number(row.reset_at) };
}

function sendLoginLocked(res, lockout) {
  const seconds = Math.max(1, Math.ceil((Number(lockout.reset_at) - Date.now()) / 1000));
  res.setHeader('Retry-After', String(seconds));
  return res.status(429).json(LOCKED_LOGIN);
}

async function recordLoginFailure(db, key, threshold) {
  return db.incrementRateLimit(key, LOGIN_LOCKOUT_WINDOW_MS, threshold);
}

module.exports = function createAuthRoutes(db, SESSION_SECRET = getSessionSecret()) {
  const router = express.Router();

  // --- Admin setup (first-run) ---
  // SECURITY: bootstrap is opt-in via ALLOW_ADMIN_SETUP=true. Without it this
  // endpoint is disabled, so a fresh/in-memory deployment can never be claimed
  // by whoever visits first (the storefront must NOT auto-call this).
  router.post('/api/admin/setup', strictLimiter, async (req, res) => {
    try {
      if (process.env.ALLOW_ADMIN_SETUP !== 'true') {
        return res.status(403).json({ error: 'Admin setup is disabled. Log in with an existing admin account.' });
      }
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      if (password.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const existing = await db.prepare('SELECT id FROM admin LIMIT 1').get();
      if (existing) return res.status(400).json({ error: 'Admin account already exists.' });
      const hash = await bcrypt.hash(password, 12);
      // Atomic insert: admin.email is UNIQUE, so two concurrent setups race on
      // the INSERT, not on the check above — the loser gets no row created.
      const result = await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?) ON CONFLICT (email) DO NOTHING').run(email, hash);
      const changes = result && result.changes != null ? Number(result.changes) : (result && result.lastInsertRowid != null ? 1 : 0);
      if (!changes) return res.status(400).json({ error: 'Admin account already exists.' });
      res.json({ success: true, message: 'Admin account created. You can now log in.' });
    } catch (err) { console.error('admin/setup failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Admin login ---
  router.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }
      const cleanEmail = email.trim().toLowerCase();
      if (cleanEmail.length > 254) return res.status(400).json({ error: 'Please enter a valid email address.' });
      const failureKey = loginFailureKey('admin', cleanEmail);
      const lockout = await activeLoginLockout(db, failureKey, ADMIN_LOGIN_FAILURES);
      if (lockout) return sendLoginLocked(res, lockout);

      let admin = await db.prepare('SELECT * FROM admin WHERE LOWER(TRIM(email)) = ?').get(cleanEmail);
      if (!admin && process.env.AUTO_CREATE_ADMIN === 'true' && password.length >= config.ADMIN_AUTO_CREATE_MIN_LENGTH) {
        const hash = await bcrypt.hash(password, 12);
        const result = await db.prepare('INSERT INTO admin (email, password_hash) VALUES (?, ?)').run([cleanEmail, hash]);
        admin = { id: result.lastInsertRowid, email: cleanEmail, password_hash: hash };
        console.log('✅ Auto-created admin:', cleanEmail);
      }

      const match = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_PASSWORD_HASH);
      if (!admin || !match) {
        // Unknown addresses deliberately follow the identical response and
        // lockout path; no account-existence signal is returned to the caller.
        const failed = await recordLoginFailure(db, failureKey, ADMIN_LOGIN_FAILURES);
        if (failed.count >= ADMIN_LOGIN_FAILURES) return sendLoginLocked(res, failed);
        return res.status(401).json(INVALID_LOGIN);
      }

      // A valid password clears accumulated failures before a session is
      // issued. If the shared store is unavailable, admin login stays closed.
      await db.resetRateLimit(failureKey);
      req.session.adminId = admin.id;
      res.json({ success: true, admin: { email: admin.email } });
    } catch (err) {
      console.error('admin/login failed closed:', err && err.message ? err.message : err);
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Login is temporarily unavailable. Please try again.' });
    }
  });

  // --- Admin check auth ---
  router.get('/api/admin/me', requireAuth, async (req, res) => {
    const admin = await db.prepare('SELECT id, email, created_at FROM admin WHERE id = ?').get(req.adminId);
    res.json({ admin });
  });

  // --- Admin logout ---
  router.post('/api/admin/logout', requireCsrf, (req, res) => {
    clearSessionIdentity(req, 'adminId');
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
    } catch (err) { console.error('admin/change-password failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
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
    } catch (err) { console.error('admin/create failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Password reset: request ---
  router.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
    try {
      const { email, user_type } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required.' });
      const clean = String(email).trim().toLowerCase();
      const type = user_type === 'customer' ? 'customer' : 'admin';
      if (!getConfiguredSiteUrl()) {
        console.error('Password reset email not sent: SITE_URL is not configured.');
        return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
      }
      const table = type === 'customer' ? 'customers' : 'admin';
      const user = await db.prepare(`SELECT id, email FROM ${table} WHERE LOWER(TRIM(email)) = ?`).get(clean);
      if (!user) return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + config.RESET_TOKEN_EXPIRY_MS).toISOString().replace('T', ' ').slice(0, 19);
      await db.prepare('INSERT INTO password_reset_tokens (user_type, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(type, user.id, tokenHash, expiresAt);
      // SITE_URL + a server-generated token only — the token is URL-encoded and
      // the finished URL is HTML-escaped where it lands in the href.
      const resetUrl = buildLink('/reset-password', { token: rawToken, type });
      const html = `
  <div style="font-family:'Archivo',Arial,sans-serif;background:#D9D4C8;padding:32px;color:#1A1815;">
    <div style="max-width:560px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #BDB6A6;">
      <h1 style="font-size:24px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 4px;color:#4A4433;">KAGE Culture</h1>
      <p style="color:#7A7468;font-size:13px;margin:0 0 24px;">Password Reset</p>
      <p style="font-size:15px;color:#3D3931;line-height:1.6;">We received a request to reset your password. Click the link below to set a new password. This link expires in 1 hour.</p>
      <a href="${escapeHtml(resetUrl)}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#4A4433;color:#FFF;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;border-radius:8px;">Reset Password</a>
      <p style="font-size:12px;color:#8A8578;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </div>`;
      await sendEmail(clean, 'Reset your KAGE Culture password', html);
      res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    } catch (err) { console.error('forgot-password failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Password reset: execute ---
  router.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
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
    } catch (err) { console.error('reset-password failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // ----------------------------------------------------------------
  // Customer email verification
  // ----------------------------------------------------------------
  // Order history is gated on a verified email: without it, anyone could sign
  // up with someone else's address and read that person's orders.
  const VERIFY_TOKEN_TTL_MS = config.VERIFY_TOKEN_EXPIRY_MS;

  // Issue a fresh single-use token and email the link. Any older unused token
  // for the account is burned first, so only the newest link works.
  async function issueVerificationToken(customer) {
    if (!getConfiguredSiteUrl()) {
      console.error('Verification email not sent: SITE_URL is not configured.');
      return null;
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
    await db.prepare('UPDATE customer_verification_tokens SET used = 1 WHERE customer_id = ? AND used = 0').run(customer.id);
    await db.prepare('INSERT INTO customer_verification_tokens (customer_id, token_hash, expires_at) VALUES (?, ?, ?)').run(customer.id, tokenHash, expiresAt);
    const verifyUrl = buildLink('/verify-email', { token: rawToken });
    try { await sendVerificationEmail(customer, verifyUrl); } catch (e) { console.error('verification email failed:', e.message); }
    return { rawToken, verifyUrl };
  }

  // Shared by the link handler and the API endpoint below.
  async function confirmVerificationToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return { ok: false, status: 400, error: 'Verification token is required.' };
    const record = await db.prepare('SELECT * FROM customer_verification_tokens WHERE token_hash = ? AND used = 0').get(hashToken(rawToken));
    if (!record) return { ok: false, status: 400, error: 'This verification link is invalid or has already been used.' };
    if (Date.now() > new Date(record.expires_at).getTime()) {
      await db.prepare('UPDATE customer_verification_tokens SET used = 1 WHERE id = ?').run(record.id);
      return { ok: false, status: 400, error: 'This verification link has expired. Request a new one.' };
    }
    const customer = await db.prepare('SELECT id, email FROM customers WHERE id = ?').get(record.customer_id);
    if (!customer) return { ok: false, status: 404, error: 'Account not found.' };
    await db.prepare('UPDATE customer_verification_tokens SET used = 1 WHERE id = ?').run(record.id);
    await db.prepare('UPDATE customers SET email_verified = 1 WHERE id = ?').run(customer.id);
    // Now that the address is proven, link this customer's earlier guest orders.
    try {
      await db.prepare('UPDATE orders SET customer_id = ? WHERE customer_id IS NULL AND LOWER(TRIM(email)) = ?').run(customer.id, String(customer.email || '').trim().toLowerCase());
    } catch (e) { /* the orders endpoint also matches by email */ }
    return { ok: true, customerId: customer.id };
  }

  // --- Customer signup ---
  router.post('/api/customers/signup', requireCsrf, async (req, res) => {
    try {
      const { email, password, name } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
      if (password.length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
      const clean = email.trim().toLowerCase();
      if (!isValidEmail(clean)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      const existing = await db.prepare('SELECT id FROM customers WHERE LOWER(TRIM(email)) = ?').get(clean);
      if (existing) return res.status(400).json({ error: 'An account with that email already exists.' });
      const hash = await bcrypt.hash(password, 12);
      const customerName = String(name || '').trim().slice(0, 80);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const result = await db.prepare('INSERT INTO customers (email, password_hash, name, created_at, email_verified) VALUES (?, ?, ?, ?, 0)').run(clean, hash, customerName, now);
      const customerId = result.lastInsertRowid;
      // cookie-session middleware commits kage.session after this handler.
      req.session.customerId = customerId;
      const stored = { id: customerId, email: clean, name: customerName };
      const verification = await issueVerificationToken(stored);
      const message = verification
        ? 'Account created. Check your email to verify your address and see your order history.'
        : 'Account created, but verification email is unavailable. Please contact support.';
      res.json({ success: true, customer: { ...stored, email_verified: false }, message });
    } catch (err) { console.error('customer/signup failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Customer login ---
  router.post('/api/customers/login', customerLoginLimiter, requireCsrf, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }
      const cleanEmail = email.trim().toLowerCase();
      if (cleanEmail.length > 254) return res.status(400).json({ error: 'Please enter a valid email address.' });
      const failureKey = loginFailureKey('customer', cleanEmail);

      // Customer login remains fail-open if just the lockout table is briefly
      // unavailable; the shared per-IP limiter also logs and passes requests.
      try {
        const lockout = await activeLoginLockout(db, failureKey, CUSTOMER_LOGIN_FAILURES);
        if (lockout) return sendLoginLocked(res, lockout);
      } catch (storeError) {
        console.warn('⚠️  customer login lockout lookup failed open:', storeError.message);
      }

      const customer = await db.prepare('SELECT * FROM customers WHERE LOWER(TRIM(email)) = ?').get(cleanEmail);
      const match = await bcrypt.compare(password, customer ? customer.password_hash : DUMMY_PASSWORD_HASH);
      if (!customer || !match) {
        try {
          const failed = await recordLoginFailure(db, failureKey, CUSTOMER_LOGIN_FAILURES);
          if (failed.count >= CUSTOMER_LOGIN_FAILURES) return sendLoginLocked(res, failed);
        } catch (storeError) {
          console.warn('⚠️  customer login failure counter failed open:', storeError.message);
        }
        return res.status(401).json(INVALID_LOGIN);
      }

      try { await db.resetRateLimit(failureKey); }
      catch (storeError) { console.warn('⚠️  customer login lockout reset failed open:', storeError.message); }
      // cookie-session middleware commits kage.session after this handler.
      req.session.customerId = customer.id;
      res.json({ success: true, customer: { id: customer.id, email: customer.email, name: customer.name, phone: customer.phone, address: customer.address, city: customer.city, email_verified: Number(customer.email_verified) === 1 } });
    } catch (err) { console.error('customer/login failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Customer logout ---
  router.post('/api/customers/logout', requireCsrf, (req, res) => {
    // NOTE: no kage.cust Set-Cookie here — nothing has set that cookie since the
    // session was consolidated into kage.session; the old line was dead code.
    clearSessionIdentity(req, 'customerId');
    res.json({ success: true });
  });

  // --- Customer: session restore (account page) ---
  // This is a normal bootstrap probe on every storefront page. Return a quiet
  // empty result for anonymous visitors instead of a 401 that browsers report
  // as a console error; protected customer data APIs still require auth.
  router.get('/api/customers/me', (req, res, next) => {
    if (!optionalCustomerId(req)) return res.json({ customer: null });
    return requireCustomerAuth(req, res, next);
  }, async (req, res) => {
    try {
      const c = await db.prepare('SELECT id, email, name, phone, address, city, email_verified, created_at FROM customers WHERE id = ?').get(req.customerId);
      if (!c) return res.json({ customer: null });
      res.json({ customer: { ...c, email_verified: Number(c.email_verified) === 1 } });
    } catch (err) { console.error('customers/me GET failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Customer: update profile OR change password (one endpoint, two shapes) ---
  router.put('/api/customers/me', requireCsrf, requireCustomerAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (currentPassword !== undefined || newPassword !== undefined) {
        // Password change path (account page "Update Password")
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new passwords are required.' });
        if (String(newPassword).length < config.MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `New password must be at least ${config.MIN_PASSWORD_LENGTH} characters.` });
        const c = await db.prepare('SELECT id, password_hash FROM customers WHERE id = ?').get(req.customerId);
        if (!c) return res.status(404).json({ error: 'Account not found.' });
        const match = await bcrypt.compare(currentPassword, c.password_hash);
        if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
        const newHash = await bcrypt.hash(newPassword, 12);
        await db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(newHash, req.customerId);
        return res.json({ success: true, message: 'Password updated successfully.' });
      }
      // Profile update path (account page "Save Changes")
      const existing = await db.prepare('SELECT id, email, name, phone, address, city FROM customers WHERE id = ?').get(req.customerId);
      if (!existing) return res.status(404).json({ error: 'Account not found.' });
      const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 80) : existing.name;
      const phone = req.body.phone !== undefined ? String(req.body.phone).trim().slice(0, 40) : existing.phone;
      const address = req.body.address !== undefined ? String(req.body.address).trim().slice(0, 300) : existing.address;
      const city = req.body.city !== undefined ? String(req.body.city).trim().slice(0, 120) : existing.city;
      await db.prepare('UPDATE customers SET name = ?, phone = ?, address = ?, city = ? WHERE id = ?').run(name, phone, address, city, req.customerId);
      const updated = await db.prepare('SELECT id, email, name, phone, address, city FROM customers WHERE id = ?').get(req.customerId);
      res.json({ success: true, customer: updated });
    } catch (err) { console.error('customers/me PUT failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Customer: verify email (link from the verification email) ---
  // GET so the emailed link works on its own; the SPA also calls the POST
  // variant. Both consume the same single-use token.
  router.get('/api/auth/verify-email', resetLimiter, async (req, res) => {
    try {
      const result = await confirmVerificationToken(req.query.token);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.json({ success: true, message: 'Email verified. Your order history is now available.' });
    } catch (err) { console.error('verify-email failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  router.post('/api/customers/verify-email', resetLimiter, requireCsrf, async (req, res) => {
    try {
      const result = await confirmVerificationToken(req.body && req.body.token);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      // Sign the verifying browser in, so the account page can show history.
      if (!req.session.customerId) req.session.customerId = result.customerId;
      res.json({ success: true, message: 'Email verified. Your order history is now available.' });
    } catch (err) { console.error('customers/verify-email failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  // --- Customer: resend the verification email (logged-in account only) ---
  router.post('/api/customers/resend-verification', resetLimiter, requireCsrf, requireCustomerAuth, async (req, res) => {
    try {
      const customer = await db.prepare('SELECT id, email, name, email_verified FROM customers WHERE id = ?').get(req.customerId);
      if (!customer) return res.status(404).json({ error: 'Account not found.' });
      if (Number(customer.email_verified) === 1) return res.json({ success: true, message: 'Your email is already verified.' });
      const verification = await issueVerificationToken(customer);
      if (!verification) return res.status(503).json({ error: 'Verification email is unavailable. Please try again later.' });
      res.json({ success: true, message: 'Verification email sent. Check your inbox.' });
    } catch (err) { console.error('resend-verification failed:', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  return router;
};
