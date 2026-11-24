// ================================================================
// KAGE CULTURE — Homepage category cards
// ================================================================
// The four cards in the home page's category strip. Each one ships with a
// bundled photo and its own copy; an admin can replace the photo, and the
// replacement is stored per card in `app_settings` under
// `category_card.<id>.image`.
//
// The bundled file is only the DEFAULT. Storing the override in the database
// instead of editing public/images keeps the deploy artefact immutable and
// makes "Reset to default" a single delete — deleting a Blob object is
// one-way, so overwriting the shipped photo would be unrecoverable.

// `bundled` is the shipped photo relative to public/; `defaultAlt` doubles as
// the card's label in the admin panel.
const CATEGORY_CARDS = [
  { id: 'graphic-tees',    label: 'Graphic Tees',    bundled: '/images/graphic-tees.jpg',    defaultAlt: 'Graphic Tees' },
  { id: 'anime',           label: 'Anime Shirts',    bundled: '/images/anime-shirts.jpg',    defaultAlt: 'Anime Shirts' },
  { id: 'pants',           label: 'Pants',           bundled: '/images/pants.jpg',           defaultAlt: 'Pants' },
  { id: 'custom-stickers', label: 'Custom Stickers', bundled: '/images/custom-stickers.jpg', defaultAlt: 'Custom Stickers' }
];

const CATEGORY_CARD_IDS = CATEGORY_CARDS.map(card => card.id);

// Uploaded photos come back either from Vercel Blob (absolute https URL) or the
// local development `/uploads/...` directory. Anything else — including a
// javascript: or data: URL, or a protocol-relative //host/path — is refused, so
// a bad value can never become markup in the storefront.
function isAcceptableImageUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  if (trimmed.startsWith('/uploads/')) return !trimmed.includes('..');
  return /^https:\/\/[^\s"'<>]+$/i.test(trimmed);
}

function settingKeyFor(cardId) {
  return `category_card.${cardId}.image`;
}

function altKeyFor(cardId) {
  return `category_card.${cardId}.alt`;
}

// Optimisation metadata for an uploaded photo: the real pixel size plus the
// URL of the 300 px variant, both produced by utils/categoryCardImage.js.
// It lives beside the image key so the public endpoint can emit a correct
// srcset without stat-ing the file on every request.
function metaKeyFor(cardId) {
  return `category_card.${cardId}.meta`;
}

// Anything malformed is treated as "no metadata": the card then renders its
// single image with width/height attributes, which is the old behaviour.
function parseCardMeta(raw) {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  const out = {
    width: Number.isFinite(width) && width > 0 && width <= 10000 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 && height <= 10000 ? Math.round(height) : null,
    variants: {}
  };
  const variants = parsed.variants && typeof parsed.variants === 'object' && !Array.isArray(parsed.variants) ? parsed.variants : {};
  for (const [w, url] of Object.entries(variants)) {
    if (!/^\d{2,4}$/.test(w)) continue;
    if (!isAcceptableImageUrl(url)) continue;
    out.variants[w] = url.trim();
  }
  return out;
}

// `"<300 url> 300w, <main url> 600w"` — built only from values that survived
// validation, and only when the real width is known. A card with no metadata
// gets no srcset, so older uploads render exactly as before.
function buildSrcset(imageUrl, meta) {
  if (!meta || !meta.width) return null;
  const candidates = Object.entries(meta.variants || {})
    .map(([w, url]) => ({ w: Number(w), url }))
    .filter(c => Number.isFinite(c.w) && c.w > 0 && c.w < meta.width)
    .sort((a, b) => a.w - b.w);
  candidates.push({ w: meta.width, url: imageUrl });
  return candidates.map(c => `${c.url} ${c.w}w`).join(', ');
}

// Reads every card's stored override and resolves it. Both the admin list and
// the public endpoint go through this, so the two can never disagree about
// what a card is showing.
// One query for every `category_card.%` row instead of twelve sequential
// getSetting() round trips (4 cards x image/alt/meta). On Turso each of those
// was a network hop, which is part of why this endpoint was the slowest request
// in the PageSpeed waterfall. Unexpected shapes and failures fall back to the
// per-key reads, so behaviour is identical if the table or adapter misbehaves.
async function loadCategoryCards(db) {
  const stored = {};
  let rows = null;
  try {
    rows = await db.prepare('SELECT key, value FROM app_settings WHERE key LIKE ?').all('category_card.%');
  } catch (err) {
    rows = null;
  }
  if (Array.isArray(rows) && rows.length >= 0) {
    const byKey = {};
    for (const row of rows) {
      if (row && typeof row.key === 'string') byKey[row.key] = row.value == null ? null : String(row.value);
    }
    for (const card of CATEGORY_CARDS) {
      stored[card.id] = {
        image: byKey[settingKeyFor(card.id)] || null,
        alt: byKey[altKeyFor(card.id)] || null,
        meta: parseCardMeta(byKey[metaKeyFor(card.id)])
      };
    }
    return resolveCategoryCards(stored);
  }
  for (const card of CATEGORY_CARDS) {
    stored[card.id] = {
      image: await db.getSetting(settingKeyFor(card.id)),
      alt: await db.getSetting(altKeyFor(card.id)),
      meta: parseCardMeta(await db.getSetting(metaKeyFor(card.id)))
    };
  }
  return resolveCategoryCards(stored);
}

// The storefront needs url + alt per card. `stored` is whatever the database
// holds (possibly null); an unusable value falls back to the bundled photo
// rather than rendering a broken image.
function resolveCategoryCards(storedById) {
  const byId = storedById || {};
  return CATEGORY_CARDS.map(card => {
    const stored = byId[card.id] || {};
    const override = isAcceptableImageUrl(stored.image) ? stored.image.trim() : null;
    const image = override || card.bundled;
    // The bundled files already ship their own responsive <picture> crops, so
    // the extra fields only describe an uploaded photo. Consumers must treat
    // srcset/width/height as optional.
    const meta = override ? (stored.meta || null) : null;
    return {
      id: card.id,
      label: card.label,
      image,
      alt: String(stored.alt || card.defaultAlt).trim() || card.defaultAlt,
      isCustom: Boolean(override),
      srcset: override ? buildSrcset(image, meta) : null,
      width: meta && meta.width ? meta.width : null,
      height: meta && meta.height ? meta.height : null
    };
  });
}

module.exports = {
  CATEGORY_CARDS,
  CATEGORY_CARD_IDS,
  isAcceptableImageUrl,
  settingKeyFor,
  altKeyFor,
  metaKeyFor,
  parseCardMeta,
  buildSrcset,
  loadCategoryCards,
  resolveCategoryCards
};
