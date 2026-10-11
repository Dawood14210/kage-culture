// ================================================================
// KAGE Culture — Utility helpers
// ================================================================
const path = require('path');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '..', 'uploads');

function getBlobReadWriteToken() {
  // Vercel's store connection can generate a store-prefixed variable (the
  // quickstart for this project's store shows `kage_READ_WRITE_TOKEN`) rather
  // than the SDK's default name. Pass either token explicitly to the SDK.
  return process.env.BLOB_READ_WRITE_TOKEN || process.env.kage_READ_WRITE_TOKEN || process.env.KAGE_READ_WRITE_TOKEN || '';
}

function imageStorageError(code, status, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  // Routes may expose this fixed, safe message to the admin. Provider details
  // stay in server logs and are never sent to the browser.
  err.publicMessage = message;
  return err;
}

// Ensure the local-development upload directory exists. Vercel's deployed
// function filesystem is ephemeral/read-only, so it must use Blob storage.
if (!process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN && !fs.existsSync(uploadsDir)) {
  try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (e) { /* surfaced on upload */ }
}

async function persistImage(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.webp';
  const blobToken = getBlobReadWriteToken();

  if (process.env.VERCEL && !blobToken) {
    throw imageStorageError(
      'IMAGE_STORAGE_UNAVAILABLE',
      503,
      'Product image storage is not configured. Connect a Public Vercel Blob store and configure its read-write token (BLOB_READ_WRITE_TOKEN or the generated kage_READ_WRITE_TOKEN), then redeploy.'
    );
  }

  if (blobToken) {
    try {
      const { put } = require('@vercel/blob');
      const key = `kage/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      const blob = await put(key, buffer, { access: 'public', token: blobToken });
      return blob.url;
    } catch (cause) {
      console.error('Vercel Blob image upload failed:', cause && cause.message ? cause.message : cause);
      throw imageStorageError(
        'IMAGE_UPLOAD_FAILED',
        502,
        'Product image upload failed. Check that the Blob store is Public and that the configured read-write token belongs to that store.'
      );
    }
  }

  const filename = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  try {
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  } catch (cause) {
    console.error('Local image upload failed:', cause && cause.message ? cause.message : cause);
    throw imageStorageError(
      'IMAGE_UPLOAD_FAILED',
      500,
      'Could not save the product image. Check the local uploads directory permissions.'
    );
  }
  return '/uploads/' + filename;
}

async function removeImage(url) {
  if (!url) return;
  const blobToken = getBlobReadWriteToken();
  if (blobToken && /^https?:\/\//.test(url)) {
    const { del } = require('@vercel/blob');
    try { await del(url, { token: blobToken }); } catch (e) { /* already gone */ }
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

// Escape a value for interpolation into HTML — text nodes and attributes
// (quotes are escaped too, so `href="..."`/`title="..."` are safe).
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Strip CR/LF (and NUL) from anything that reaches an email subject or header.
// Without this, a crafted name/order number could inject extra headers
// (e.g. "\r\nBcc: victim@example.com").
function stripHeaderChars(value) {
  return String(value == null ? '' : value).replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// One email rule for the whole app (signup, login, order placement): a single
// loose-but-strict-enough pattern plus the column length limit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(value) {
  const clean = String(value == null ? '' : value).trim();
  return clean.length > 0 && clean.length <= 160 && EMAIL_RE.test(clean);
}

// True when a free-text field carries control characters. Order fields are
// single-line by design, and control characters are how header injection and
// display spoofing start.
function hasControlChars(value) {
  return /[\u0000-\u001F\u007F]/.test(String(value == null ? '' : value));
}

// One CSV cell, RFC 4180 + spreadsheet-safe. Anything that would start a
// formula in Excel/Sheets (= + - @ tab CR) is prefixed with a single quote —
// quoting alone does NOT stop =HYPERLINK(...) from executing. Inner double
// quotes are doubled and the value is always wrapped in double quotes, so
// commas and newlines inside a value can never shift the columns.
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
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
  const { getSessionSecret } = require('./secret');
  return crypto.createHmac('sha256', getSessionSecret()).update(token).digest('hex');
}

module.exports = { persistImage, removeImage, parseCookies, hashToken, generateCsrfToken, signCsrfToken, escapeHtml, stripHeaderChars, hasControlChars, isValidEmail, csvCell };
