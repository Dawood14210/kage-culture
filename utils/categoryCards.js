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

// Reads every card's stored override and resolves it. Both the admin list and
// the public endpoint go through this, so the two can never disagree about
// what a card is showing.
async function loadCategoryCards(db) {
  const stored = {};
  for (const card of CATEGORY_CARDS) {
    stored[card.id] = {
      image: await db.getSetting(settingKeyFor(card.id)),
      alt: await db.getSetting(altKeyFor(card.id))
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
    return {
      id: card.id,
      label: card.label,
      image: override || card.bundled,
      alt: String(stored.alt || card.defaultAlt).trim() || card.defaultAlt,
      isCustom: Boolean(override)
    };
  });
}

module.exports = {
  CATEGORY_CARDS,
  CATEGORY_CARD_IDS,
  isAcceptableImageUrl,
  settingKeyFor,
  altKeyFor,
  loadCategoryCards,
  resolveCategoryCards
};
