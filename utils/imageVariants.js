// ================================================================
// KAGE Culture — WebP responsive image variants (F7)
// ----------------------------------------------------------------
// On every product-image upload we best-effort generate 400/800/1200px
// WebP derivatives next to the original. Nothing about the original
// upload contract changes: any failure here (sharp missing, undecodable
// bytes, Blob/local storage error) logs and returns null so the upload
// itself still succeeds — the storefront just renders the original.
//
// Layout of the variants map stored on products.image_variants:
//   { "<original url>": { "400": "<url>", "800": "<url>", "1200": "<url>" } }
// A flat url -> widths map keeps front/back/extra images uniform and
// makes merging/pruning trivial. sanitizeVariantMapForPublic() is the
// only shape allowed past the API boundary.
// ================================================================
const fs = require('fs');
const path = require('path');

const WIDTHS = [400, 800, 1200];
const QUALITY = 78;
const uploadsDir = path.join(__dirname, '..', 'uploads');

const WIDTH_KEYS = new Set(WIDTHS.map(String));

function getBlobReadWriteToken() {
  return (process.env.BLOB_READ_WRITE_TOKEN || process.env.kage_READ_WRITE_TOKEN || '').trim();
}

function isHttpUrl(url) { return /^https?:\/\//i.test(url); }

// Variant URLs are derived deterministically from the original URL:
// /uploads/123-abc.webp          -> /uploads/123-abc-400.webp
// https://host/kage/123-abc.jpg  -> https://host/kage/123-abc-400.webp
// Anything without a clean stem returns null (caller falls back to original).
function variantUrlFor(url, width) {
  const clean = typeof url === 'string' ? url.split('?')[0].split('#')[0] : '';
  if (!clean) return null;
  const slash = clean.lastIndexOf('/');
  if (slash < 0) return null;
  const dir = clean.slice(0, slash + 1);
  const file = clean.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = file.slice(0, dot);
  return `${dir}${stem}-${width}.webp`;
}

// Resize buffer into the configured widths. Never upscales; the source's own
// width and quality stay untouched. Returns null on ANY failure.
async function generateVariants(buffer) {
  let sharp;
  try { sharp = require('sharp'); } catch (error) {
    console.warn('⚠️  sharp is not available — image variants skipped:', error && error.message ? error.message : error);
    return null;
  }
  try {
    const image = sharp(buffer, { failOn: 'none' });
    const meta = await image.metadata();
    const sourceWidth = Number(meta && meta.width) || 0;
    const out = {};
    for (const width of WIDTHS) {
      if (sourceWidth && width >= sourceWidth) continue;
      out[width] = await image.clone().resize({ width }).webp({ quality: QUALITY }).toBuffer();
    }
    return Object.keys(out).length ? out : null;
  } catch (error) {
    console.warn('⚠️  Image variant generation failed (upload continues without variants):', error && error.message ? error.message : error);
    return null;
  }
}

// Write one variant next to where the original went (same origin dir / uploads).
async function persistVariant(variantUrl, data) {
  try {
    if (isHttpUrl(variantUrl)) {
      const token = getBlobReadWriteToken();
      if (!token) return null;
      const { put } = require('@vercel/blob');
      const key = new URL(variantUrl).pathname.replace(/^\/+/, '');
      const blob = await put(key, data, { access: 'public', token });
      return blob.url;
    }
    const file = path.basename(variantUrl);
    fs.writeFileSync(path.join(uploadsDir, file), data);
    return '/uploads/' + file;
  } catch (error) {
    console.warn('⚠️  Variant upload failed for', variantUrl, '-', error && error.message ? error.message : error);
    return null;
  }
}

// Persist a freshly-persisted image's variants. Returns {url, variants|null}.
// The original upload already succeeded before this runs, so callers keep the
// original URL whatever happens here.
async function persistImageVariants(buffer, originalName) {
  const { persistImage } = require('./helpers');
  const url = await persistImage(buffer, originalName);
  const generated = await generateVariants(buffer);
  if (!generated) return { url, variants: null };
  const variants = {};
  for (const [width, data] of Object.entries(generated)) {
    const vurl = await persistVariant(variantUrlFor(url, Number(width)), data);
    if (vurl) variants[width] = vurl;
  }
  return { url, variants: Object.keys(variants).length ? variants : null };
}

function readVariantMap(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) { return {}; }
}

// For DB storage: existing raw map + {url: variants} additions.
function mergeVariantMap(existingRaw, additions) {
  const map = readVariantMap(existingRaw);
  for (const [url, variants] of Object.entries(additions || {})) {
    if (url && variants && typeof variants === 'object') map[url] = variants;
  }
  return map;
}

function pruneVariantMap(map, urls) {
  for (const url of urls || []) { if (url) delete map[url]; }
  return map;
}

// What the public API may expose: http(s)/root-relative keys, widths a subset
// of {400,800,1200}, string values. Everything else is dropped silently.
function sanitizeVariantMapForPublic(raw) {
  const cleanUrl = u => typeof u === 'string' && /^(https?:\/\/|\/uploads\/)/.test(u) && u.length <= 2048;
  const out = {};
  for (const [url, widths] of Object.entries(readVariantMap(raw))) {
    if (!cleanUrl(url)) continue;
    if (!widths || typeof widths !== 'object' || Array.isArray(widths)) continue;
    const kept = {};
    for (const [width, vurl] of Object.entries(widths)) {
      if (WIDTH_KEYS.has(width) && cleanUrl(vurl)) kept[width] = vurl;
    }
    if (Object.keys(kept).length) out[url] = kept;
  }
  return out;
}

module.exports = { variantUrlFor, generateVariants, persistImageVariants, persistVariant, readVariantMap, mergeVariantMap, pruneVariantMap, sanitizeVariantMapForPublic, WIDTHS, QUALITY };
