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
