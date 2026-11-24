#!/usr/bin/env node
// ================================================================
// KAGE Culture — one-time category-card photo conversion
// ----------------------------------------------------------------
// Before utils/categoryCardImage.js existed, admin uploads were stored exactly
// as sent. The live Pants card is a 1122x1126 PNG (2.7 MB) rendered inside a
// 104-150 px circle. This script converts every stored override the same way
// new uploads are converted (<=600 px long edge, WebP q78, plus a 300 px
// variant) and reports exactly what it changed.
//
//   node scripts/convert-category-cards.js            # convert
//   node scripts/convert-category-cards.js --dry-run  # report only
//
// Safety:
//   * Idempotent — a card already stored as a small WebP with metadata is
//     skipped, so running it twice is harmless.
//   * The original file is deleted ONLY after the replacement has been written
//     AND confirmed to serve (HTTP 200 image/* for Blob, a real file for
//     /uploads). If either check fails, the card keeps pointing at the old
//     image and nothing is deleted.
//   * Bundled defaults (/images/…) are never touched: they are deploy assets,
//     already shipped as 200w/500w WebP crops.
//
// Production run (once, after deploy):
//   TURSO_DATABASE_URL=… TURZO_AUTH_TOKEN=… BLOB_READ_WRITE_TOKEN=… \
//     node scripts/convert-category-cards.js
const fs = require('fs');
const path = require('path');

const db = require('../database');
const categoryCards = require('../utils/categoryCards');
const categoryCardImage = require('../utils/categoryCardImage');
const { removeImage } = require('../utils/helpers');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const MAX_BYTES_BUDGET = 100 * 1024; // "no category tile image is over 100 KB"

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function readImage(url) {
  if (/^https:\/\//i.test(url)) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  const file = path.join(ROOT, url);
  if (!fs.existsSync(file)) throw new Error('local file is missing');
  return fs.readFileSync(file);
}

// "Confirmed to serve" — the new files must really be reachable before the old
// one is removed.
async function serves(url) {
  if (/^https:\/\//i.test(url)) {
    try {
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!res.ok) return false;
      const type = String(res.headers.get('content-type') || '');
      return type.startsWith('image/');
    } catch (_) { return false; }
  }
  return fs.existsSync(path.join(ROOT, url));
}

function dimensionsOf(buffer) {
  try {
    const sharp = require('sharp');
    return sharp(buffer, { failOn: 'none' }).metadata()
      .then(meta => ({ format: meta.format, width: Number(meta.width) || 0, height: Number(meta.height) || 0 }));
  } catch (_) {
    return Promise.resolve(null);
  }
}

async function convertCard(card, report) {
  const storedUrl = await db.getSetting(categoryCards.settingKeyFor(card.id));
  if (!storedUrl || !categoryCards.isAcceptableImageUrl(storedUrl)) {
    report.push({ id: card.id, status: 'skipped', reason: 'no uploaded photo (bundled default)' });
    return;
  }
  const meta = categoryCards.parseCardMeta(await db.getSetting(categoryCards.metaKeyFor(card.id)));

  const buffer = await readImage(storedUrl);
  const before = await dimensionsOf(buffer);

  // Already converted: small WebP with metadata. Nothing to do.
  if (meta && meta.width && meta.width <= categoryCardImage.MAX_LONG_EDGE
      && buffer.length <= MAX_BYTES_BUDGET && /\.webp$/i.test(storedUrl.split('?')[0])) {
    report.push({ id: card.id, status: 'skipped', reason: 'already optimised', beforeBytes: buffer.length });
    return;
  }

  const alreadySmallWebp = before && before.format === 'webp'
    && Math.max(before.width, before.height) <= categoryCardImage.MAX_LONG_EDGE
    && buffer.length <= MAX_BYTES_BUDGET;

  if (alreadySmallWebp && !meta) {
    // Small enough already — keep the exact bytes, just publish the variant and
    // the metadata the srcset needs (no second lossy encode).
    const variant = before.width > categoryCardImage.VARIANT_WIDTH
      ? await require('sharp')(buffer).resize({ width: categoryCardImage.VARIANT_WIDTH, withoutEnlargement: true }).webp({ quality: categoryCardImage.QUALITY }).toBuffer()
      : null;
    if (DRY_RUN) {
      report.push({ id: card.id, status: 'metadata-only (dry run)', beforeBytes: buffer.length, afterBytes: buffer.length });
      return;
    }
    let variantUrl = null;
    if (variant) {
      const { persistVariant, variantUrlFor } = require('../utils/imageVariants');
      variantUrl = await persistVariant(variantUrlFor(storedUrl, categoryCardImage.VARIANT_WIDTH), variant);
    }
    await db.setSetting(categoryCards.metaKeyFor(card.id), JSON.stringify({
      v: 1, width: before.width, height: before.height,
      variants: variantUrl ? { [String(categoryCardImage.VARIANT_WIDTH)]: variantUrl } : {}
    }));
    report.push({ id: card.id, status: 'metadata-only', beforeBytes: buffer.length, afterBytes: buffer.length });
    return;
  }

  const processed = await categoryCardImage.processImage(buffer);
  if (!processed) {
    report.push({ id: card.id, status: 'failed', reason: 'image could not be decoded (left untouched)' });
    return;
  }
  if (DRY_RUN) {
    report.push({
      id: card.id, status: 'would convert', beforeBytes: buffer.length,
      afterBytes: processed.main.length, width: processed.width, height: processed.height
    });
    return;
  }

  const stored = await categoryCardImage.storeProcessedImage(processed);
  if (!stored) {
    report.push({ id: card.id, status: 'failed', reason: 'new files could not be written (left untouched)' });
    return;
  }

  // Verify BEFORE touching the database or deleting anything.
  const mainOk = await serves(stored.url);
  const variantOk = !stored.variantUrl || await serves(stored.variantUrl);
  if (!mainOk || !variantOk) {
    report.push({ id: card.id, status: 'failed', reason: 'new files did not serve; old photo kept' });
    return;
  }

  await db.setSetting(categoryCards.settingKeyFor(card.id), stored.url);
  await db.setSetting(categoryCards.metaKeyFor(card.id), JSON.stringify({
    v: 1, width: stored.width, height: stored.height,
    variants: stored.variantUrl ? { [String(categoryCardImage.VARIANT_WIDTH)]: stored.variantUrl } : {}
  }));
  try { await removeImage(storedUrl); } catch (err) {
    console.warn(`   (old file could not be deleted, it is now orphaned: ${err && err.message ? err.message : err})`);
  }
  report.push({
    id: card.id, status: 'converted', beforeBytes: buffer.length,
    afterBytes: stored.bytes, width: stored.width, height: stored.height
  });
}

(async () => {
  await db.init();
  console.log(`Category-card photo conversion ${DRY_RUN ? '(dry run — nothing is written)' : ''}`);
  console.log(`Backend: ${db.activeBackend}\n`);

  const report = [];
  const cards = categoryCards.CATEGORY_CARDS;
  for (const card of cards) {
    try {
      await convertCard(card, report);
    } catch (err) {
      report.push({ id: card.id, status: 'failed', reason: err && err.message ? err.message : String(err) });
    }
  }

  let saved = 0;
  let changed = 0;
  for (const row of report) {
    const label = row.id.padEnd(16);
    if (row.status === 'converted' || row.status === 'would convert') {
      const diff = row.beforeBytes - row.afterBytes;
      saved += diff;
      changed++;
      const pct = row.beforeBytes > 0 ? ((diff / row.beforeBytes) * 100).toFixed(1) : '0.0';
      console.log(`${label} ${row.status}: ${fmtBytes(row.beforeBytes)} → ${fmtBytes(row.afterBytes)} ` +
        `(${row.width}x${row.height}, saved ${fmtBytes(diff)}, ${pct}%)`);
    } else if (row.status === 'metadata-only' || row.status === 'metadata-only (dry run)') {
      console.log(`${label} ${row.status}: ${fmtBytes(row.beforeBytes)} (already under the budget; added srcset metadata only)`);
    } else if (row.status === 'skipped') {
      console.log(`${label} skipped: ${row.reason}`);
    } else {
      console.log(`${label} ${row.status}: ${row.reason || ''}`);
    }
  }

  console.log(`\n${changed} photo(s) ${DRY_RUN ? 'would be converted' : 'converted'}; ${fmtBytes(saved)} ${DRY_RUN ? 'would be ' : ''}saved.`);
  const over = report.filter(r => Number.isFinite(r.afterBytes) && r.afterBytes > MAX_BYTES_BUDGET);
  if (over.length) {
    console.log(`⚠️  Still over the 100 KB budget: ${over.map(r => `${r.id} (${fmtBytes(r.afterBytes)})`).join(', ')}`);
  }

  if (!DRY_RUN) await db.save();
  if (!process.env.KAGE_DB_FILE && !process.env.TURSO_DATABASE_URL && !DRY_RUN) {
    console.log('NOTE: no KAGE_DB_FILE / TURSO_DATABASE_URL set — this in-memory database disappears with the process.');
  }
})().catch(err => {
  console.error('Conversion failed:', err && err.message ? err.message : err);
  process.exit(1);
});
