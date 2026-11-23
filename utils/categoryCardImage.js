// ================================================================
// KAGE Culture — category-card photo pipeline
// ----------------------------------------------------------------
// WHY THIS EXISTS
// Product photos already went through sharp: the admin canvas-compresses them
// to WebP before upload, and `persistImageVariants()` writes 400/800/1200 WebP
// derivatives. Category-card photos skipped both steps — the admin sent the
// raw file and the route called `persistImage()`, which stores bytes verbatim.
// A 1122x1126 PNG straight off a phone therefore landed in Blob at 2.7 MB and
// was then displayed inside a 104–150 px circle on the home page.
//
// This module closes that gap on the SERVER, so it does not depend on the
// admin's browser doing the right thing:
//   * decode with sharp, honouring EXIF rotation;
//   * resize to at most 600 px on the long edge (never upscale);
//   * re-encode to WebP at quality 78;
//   * write a 300 px variant beside it for the small on-screen circle.
// Everything is best-effort: if sharp is missing or cannot decode the bytes,
// `processImage()` returns null and the caller keeps today's plain-upload
// behaviour. An upload must never fail because optimisation did.
// ================================================================
const { persistImage } = require('./helpers');
const { variantUrlFor, persistVariant } = require('./imageVariants');

// The largest size the storefront ever renders a category circle at is 150 px
// (desktop). 600 px covers a 3x phone at the 104 px mobile size with room, and
// keeps the file comfortably under the 100 KB budget.
const MAX_LONG_EDGE = 600;
const VARIANT_WIDTH = 300;
const QUALITY = 78;
// Quality ladder: 78 is the default, and it only steps down when a very
// high-detail photo would otherwise blow the byte budget (the same photo at
// 600 px is normally 20-60 KB, not 130 KB).
const QUALITY_STEPS = [78, 72, 66, 60];
// Budgets from the audit: no category tile over 100 KB, and the phone-sized
// (300w) file under 60 KB.
const MAX_MAIN_BYTES = 100 * 1024;
const MAX_VARIANT_BYTES = 48 * 1024;
// Above this, a PNG/JPG original is always re-encoded (we always re-encode, so
// this is the documented threshold from the audit rather than a branch).
const MAX_RECOMMENDED_SOURCE_BYTES = 500 * 1024;

function loadSharp() {
  try { return require('sharp'); } catch (error) {
    console.warn('⚠️  sharp is not available — category card photos are stored unoptimised:', error && error.message ? error.message : error);
    return null;
  }
}

// Encode at quality 78, stepping down the ladder only if the result would
// exceed `maxBytes`. Returns the smallest attempt if even the last step is over
// budget (a pathological image still gets the best we can do).
async function encodeWithinBudget(makePipeline, maxBytes) {
  let last = null;
  let quality = QUALITY_STEPS[0];
  for (const q of QUALITY_STEPS) {
    const out = await makePipeline().webp({ quality: q }).toBuffer({ resolveWithObject: true });
    last = out;
    quality = q;
    if (out.data.length <= maxBytes) break;
  }
  return { ...last, quality };
}

// Decode → resize → WebP. Returns null on any failure so the caller can fall
// back to storing the raw upload.
async function processImage(buffer) {
  if (!buffer || !buffer.length) return null;
  const sharp = loadSharp();
  if (!sharp) return null;
  try {
    const base = () => sharp(buffer, { failOn: 'none' }).rotate(); // .rotate() applies EXIF orientation
    const fitMain = () => base().resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true });
    const main = await encodeWithinBudget(fitMain, MAX_MAIN_BYTES);

    let variant = null;
    if (main.info && main.info.width > VARIANT_WIDTH) {
      variant = await encodeWithinBudget(
        () => sharp(main.data).resize({ width: VARIANT_WIDTH, withoutEnlargement: true }),
        MAX_VARIANT_BYTES
      );
      variant = variant.data;
    }

    return {
      main: main.data,
      variant,
      width: main.info ? main.info.width : null,
      height: main.info ? main.info.height : null,
      quality: main.quality,
      sourceBytes: buffer.length
    };
  } catch (error) {
    console.warn('⚠️  Category card optimisation failed (upload continues unoptimised):', error && error.message ? error.message : error);
    return null;
  }
}

// Persist the processed files next to each other and return the URL the card
// should store, plus the metadata the public API turns into a srcset.
// Returns null if even the main file could not be written — the caller then
// falls back to storing the untouched upload.
async function storeProcessedImage(processed) {
  if (!processed || !processed.main) return null;
  try {
    const url = await persistImage(processed.main, 'card.webp');
    let variantUrl = null;
    if (processed.variant) {
      variantUrl = await persistVariant(variantUrlFor(url, VARIANT_WIDTH), processed.variant);
    }
    return {
      url,
      variantUrl,
      width: processed.width,
      height: processed.height,
      bytes: processed.main.length
    };
  } catch (error) {
    console.warn('⚠️  Category card optimisation could not be stored (upload continues unoptimised):', error && error.message ? error.message : error);
    return null;
  }
}

// One call for the upload routes: optimise, store, and describe what happened.
// `optimised: false` always comes with a usable fallback instruction from the
// caller (store the raw buffer).
async function optimiseCardUpload(buffer) {
  const processed = await processImage(buffer);
  if (!processed) return { optimised: false };
  const stored = await storeProcessedImage(processed);
  if (!stored) return { optimised: false };
  return { optimised: true, ...stored, sourceBytes: processed.sourceBytes };
}

module.exports = {
  MAX_LONG_EDGE,
  VARIANT_WIDTH,
  QUALITY,
  QUALITY_STEPS,
  MAX_MAIN_BYTES,
  MAX_VARIANT_BYTES,
  MAX_RECOMMENDED_SOURCE_BYTES,
  processImage,
  storeProcessedImage,
  optimiseCardUpload
};
