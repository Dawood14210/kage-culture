// ================================================================
// KAGE Culture — Utility helpers
// ================================================================
const path = require('path');
const fs = require('fs');

const BLOB_ENABLED = !!process.env.BLOB_READ_WRITE_TOKEN;
const uploadsDir = path.join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
if (!BLOB_ENABLED && !fs.existsSync(uploadsDir)) {
  try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (e) { /* serverless */ }
}

async function persistImage(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.webp';
  if (BLOB_ENABLED) {
    const { put } = require('@vercel/blob');
    const key = `kage/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const blob = await put(key, buffer, { access: 'public' });
    return blob.url;
  }
  const filename = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return '/uploads/' + filename;
}

async function removeImage(url) {
  if (!url) return;
  if (BLOB_ENABLED && /^https?:\/\//.test(url)) {
    const { del } = require('@vercel/blob');
    try { await del(url); } catch (e) { /* already gone */ }
    return;
  }
  const p = path.join(__dirname, '..', url);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) result[key.trim()] = val.join('=').trim();
  });
  return result;
}

function hashToken(token) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateCsrfToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

function signCsrfToken(token) {
  const crypto = require('crypto');
  const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'kage-dev-secret');
  if (!secret) return token;
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

module.exports = { persistImage, removeImage, parseCookies, hashToken, generateCsrfToken, signCsrfToken };
