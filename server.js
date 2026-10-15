// ================================================================
// KAGE CULTURE — Server entry point
// Wires up middleware, routes, and starts the server.
// Route logic lives in routes/*.js, middleware in middleware/*.js.
// ================================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const dbModule = require('./database');
const config = require('./config');
const { globalLimiter } = require('./middleware/rateLimit');
const { csrfMiddleware, CSRF_ENDPOINT } = require('./middleware/csrf');
const { requireAuth } = require('./middleware/auth');
const { getSessionSecret } = require('./utils/secret');
const { getSiteUrlForRequest } = require('./utils/siteUrl');
const productShape = require('./utils/productShape');
const sizeStock = require('./utils/sizes');
const demoProducts = require('./utils/demoProducts');

// Lazy-loaded heavy modules (loaded on first use, not on every cold start)
let helmet, compression, cookieSession, multer;
function loadHelmet() { return (helmet = helmet || require('helmet')); }
function loadCompression() { return (compression = compression || require('compression')); }
function loadCookieSession() { return (cookieSession = cookieSession || require('cookie-session')); }
function loadMulter() { return (multer = multer || require('multer')); }

let db = dbModule;

const app = express();
const PORT = process.env.PORT || 3000;

// M1: behind Vercel's proxy every request arrives with the proxy IP. Without
// `trust proxy`, express-rate-limit would bucket ALL visitors into one shared
// bucket — the 120/min global limit could knock the whole site over. Vercel is
// the single trusted hop, so req.ip resolves its X-Forwarded-For client value;
// express-rate-limit's built-in keyGenerator then applies ipKeyGenerator's
// IPv6 subnet normalization (we intentionally do not replace it).
app.set('trust proxy', 1);

const STOREFRONT_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
function setHtmlNoStore(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const SITEMAP_STATIC_URLS = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/about', changefreq: 'monthly', priority: '0.6' },
  { path: '/contact', changefreq: 'monthly', priority: '0.5' },
  { path: '/custom-stickers', changefreq: 'monthly', priority: '0.5' },
  { path: '/returns', changefreq: 'monthly', priority: '0.4' },
  { path: '/shipping', changefreq: 'monthly', priority: '0.4' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/tracking', changefreq: 'monthly', priority: '0.4' }
];
// These slugs are routable collection filters. Only emit a category URL when
// at least one public product is actually assigned to it.
const SITEMAP_CATEGORY_SLUGS = new Set([
  ...config.PRODUCT_CATEGORY_VALUES,
  ...config.COMING_SOON_CATEGORIES.filter(category => category !== 'sale')
]);
let sitemapProductsCache = null;
let sitemapProductsCacheUntil = 0;
let sitemapProductsPromise = null;

function sitemapLastmod(value) {
  if (value == null || String(value).trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function shapeSitemapProduct(row) {
  const id = Number(row && row.id);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return {
    id,
    category: String(row.category || '').trim().toLowerCase(),
    price: Number(row.price),
    salePrice: row.sale_price == null || row.sale_price === '' ? null : Number(row.sale_price),
    lastmod: sitemapLastmod(row.updated_at)
  };
}

// One indexed, narrow read per ten-minute window. The in-flight promise also
// coalesces concurrent cold requests in a warm Vercel instance. A failed or
// empty database becomes an empty catalogue, leaving the static URLs intact.
function getSitemapProducts() {
  if (sitemapProductsCache && Date.now() < sitemapProductsCacheUntil) {
    return Promise.resolve(sitemapProductsCache);
  }
  if (sitemapProductsPromise) return sitemapProductsPromise;

  sitemapProductsPromise = Promise.resolve()
    .then(() => db.prepare('SELECT id, category, price, sale_price, updated_at FROM products ORDER BY id ASC').all())
    .then(rows => (Array.isArray(rows) ? rows : []).map(shapeSitemapProduct).filter(Boolean))
    .catch(() => {
      // Avoid logging backend error details here; some drivers include
      // connection metadata in them. The response remains a valid static map.
      console.warn('Sitemap product lookup failed; serving static URLs.');
      return [];
    })
    .then(products => {
      sitemapProductsCache = products;
      sitemapProductsCacheUntil = Date.now() + config.SITEMAP_CACHE_MS;
      return products;
    })
    .finally(() => { sitemapProductsPromise = null; });

  return sitemapProductsPromise;
}

function sitemapEntry(siteUrl, { path: urlPath, changefreq, priority, lastmod }) {
  const lines = [
    '  <url>',
    `    <loc>${escapeXml(new URL(urlPath, `${siteUrl}/`).href)}</loc>`
  ];
  if (lastmod) lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
  lines.push(`    <changefreq>${escapeXml(changefreq)}</changefreq>`);
  lines.push(`    <priority>${escapeXml(priority)}</priority>`);
  lines.push('  </url>');
  return lines.join('\n');
}

function renderSitemap(siteUrl, products) {
  const sitemapUrls = [...SITEMAP_STATIC_URLS];
  if (products.length) {
    sitemapUrls.push(
      { path: '/collection/all', changefreq: 'weekly', priority: '0.9' },
      { path: '/collection/new', changefreq: 'weekly', priority: '0.8' }
    );

    const categories = new Set(products.map(product => product.category));
    for (const category of SITEMAP_CATEGORY_SLUGS) {
      if (categories.has(category)) {
        sitemapUrls.push({ path: `/collection/${category}`, changefreq: 'weekly', priority: '0.8' });
      }
    }
    if (products.some(product => Number.isFinite(product.salePrice) && Number.isFinite(product.price) && product.salePrice < product.price)) {
      sitemapUrls.push({ path: '/collection/sale', changefreq: 'weekly', priority: '0.7' });
    }
  }

  for (const product of products) {
    sitemapUrls.push({
      path: `/product/${product.id}`,
      lastmod: product.lastmod,
      changefreq: 'weekly',
      priority: '0.7'
    });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map(entry => sitemapEntry(siteUrl, entry)).join('\n')}\n</urlset>\n`;
}

const COLLECTION_SEO = Object.freeze({
  all: {
    name: 'Shop All',
    description: 'Shop every KAGE Culture drop: premium streetwear, graphic tees, anime shirts, and pants made for everyday.'
  },
  new: {
    name: 'New Arrivals',
    description: 'Explore the latest KAGE Culture streetwear arrivals, featuring original art and everyday fits.'
  },
  sale: {
    name: 'Sale',
    description: 'Shop limited-time markdowns on KAGE Culture streetwear while selected pieces are still available.'
  },
  anime: {
    name: 'Anime Shirts',
    description: 'Shop anime-inspired shirts with original artwork, premium cotton, and everyday streetwear fits.'
  },
  'graphic-tees': {
    name: 'Graphic Tees',
    description: 'Discover original graphic tees from KAGE Culture, printed on premium cotton for everyday wear.'
  },
  pants: {
    name: 'Pants',
    description: 'Shop relaxed KAGE Culture pants, designed to pair with original graphic tees and streetwear drops.'
  },
  compression: {
    name: 'Compression',
    description: 'Explore KAGE Culture compression streetwear: engineered fits with original art and everyday comfort.'
  },
  oversized: {
    name: 'Oversized',
    description: 'Shop oversized KAGE Culture streetwear with relaxed silhouettes, premium fabrics, and original art.'
  }
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function upsertMetaContent(html, attribute, key, content) {
  const marker = `<meta ${attribute}="${key}"`;
  const start = html.indexOf(marker);
  const safeContent = escapeHtml(content);
  if (start < 0) {
    const headEnd = html.indexOf('</head>');
    if (headEnd < 0) return html;
    const tag = `<meta ${attribute}="${escapeHtml(key)}" content="${safeContent}" />`;
    return `${html.slice(0, headEnd)}  ${tag}\n${html.slice(headEnd)}`;
  }

  const tagEnd = html.indexOf('>', start);
  if (tagEnd < 0) return html;
  const tag = html.slice(start, tagEnd + 1);
  const contentMarker = 'content="';
  const contentStart = tag.indexOf(contentMarker);
  let replacement;
  if (contentStart < 0) {
    const close = tag.lastIndexOf('/>');
    replacement = close >= 0
      ? `${tag.slice(0, close)} content="${safeContent}" ${tag.slice(close)}`
      : `${tag.slice(0, -1)} content="${safeContent}">`;
  } else {
    const valueStart = contentStart + contentMarker.length;
    const valueEnd = tag.indexOf('"', valueStart);
    if (valueEnd < 0) return html;
    replacement = `${tag.slice(0, valueStart)}${safeContent}${tag.slice(valueEnd)}`;
  }
  return `${html.slice(0, start)}${replacement}${html.slice(tagEnd + 1)}`;
}

function removeMetaTag(html, attribute, key) {
  const start = html.indexOf(`<meta ${attribute}="${key}"`);
  if (start < 0) return html;
  const end = html.indexOf('>', start);
  return end < 0 ? html : `${html.slice(0, start)}${html.slice(end + 1)}`;
}

function replaceCanonicalLink(html, url) {
  const start = html.indexOf('<link rel="canonical"');
  if (start < 0) return html;
  const end = html.indexOf('>', start);
  return end < 0 ? html : `${html.slice(0, start)}<link rel="canonical" href="${escapeHtml(url)}" />${html.slice(end + 1)}`;
}

function plainSeoText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function trimSeoDescription(value, fallback = '') {
  const text = plainSeoText(value) || plainSeoText(fallback);
  const maxLength = Math.max(1, Number(config.SEO_DESCRIPTION_MAX_LENGTH) || 155);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeSeoName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim() || 'KAGE Culture';
}

function absoluteHttpUrl(value, siteUrl) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, `${siteUrl}/`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch (_) { return null; }
}

function publicProductImages(product, siteUrl) {
  const images = [...new Set([
    product.front_image,
    product.back_image,
    ...(Array.isArray(product.extra_images) ? product.extra_images : [])
  ].map(image => absoluteHttpUrl(image, siteUrl)).filter(Boolean))];
  if (!images.length) images.push(new URL('/images/og-image.jpg', `${siteUrl}/`).href);
  const frontImage = absoluteHttpUrl(product.front_image, siteUrl);
  return { images, frontImage: frontImage || images[0] };
}

function schemaDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function loadApprovedReviewSchema(productId) {
  try {
    const [ratingRows, reviewRows] = await Promise.all([
      db.prepare('SELECT rating FROM reviews WHERE product_id = ? AND status = ?').all(productId, 'approved'),
      db.prepare('SELECT id, customer_name, rating, comment, created_at FROM reviews WHERE product_id = ? AND status = ? ORDER BY id DESC LIMIT ?')
        .all(productId, 'approved', config.SEO_REVIEW_SCHEMA_LIMIT)
    ]);
    const ratings = (Array.isArray(ratingRows) ? ratingRows : [])
      .map(row => Number(row.rating))
      .filter(rating => Number.isFinite(rating) && rating >= 1 && rating <= 5);
    if (!ratings.length) return null;

    const reviews = (Array.isArray(reviewRows) ? reviewRows : [])
      .filter(row => Number.isFinite(Number(row.rating)) && Number(row.rating) >= 1 && Number(row.rating) <= 5)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, config.SEO_REVIEW_SCHEMA_LIMIT)
      .map(row => {
        const review = {
          '@type': 'Review',
          author: { '@type': 'Person', name: normalizeSeoName(row.customer_name) },
          reviewRating: {
            '@type': 'Rating',
            ratingValue: Number(row.rating),
            bestRating: 5,
            worstRating: 1
          }
        };
        const body = String(row.comment || '').trim();
        if (body) review.reviewBody = body;
        const datePublished = schemaDate(row.created_at);
        if (datePublished) review.datePublished = datePublished;
        return review;
      });
    return {
      reviewCount: ratings.length,
      ratingValue: Math.round((ratings.reduce((total, rating) => total + rating, 0) / ratings.length) * 10) / 10,
      reviews
    };
  } catch (_) {
    // Review metadata is optional: a review-table hiccup must not prevent the
    // public product shell from rendering, and no pending data is exposed.
    return null;
  }
}

function breadcrumbSchema(entries) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: entry.url
    }))
  };
}

function serializeJsonLd(data) {
  const backslash = String.fromCharCode(92);
  return JSON.stringify(data)
    .replace(/</g, `${backslash}u003c`)
    .split(String.fromCharCode(0x2028)).join(`${backslash}u2028`)
    .split(String.fromCharCode(0x2029)).join(`${backslash}u2029`);
}

function appendJsonLd(html, schemas) {
  const newline = String.fromCharCode(10);
  const scripts = schemas.map(schema => `  <script type="application/ld+json" data-seo-generated="true">${serializeJsonLd(schema)}</script>`).join(newline);
  const headEnd = html.lastIndexOf('</head>');
  if (headEnd < 0) return html;
  return `${html.slice(0, headEnd)}${scripts}${newline}${html.slice(headEnd)}`;
}

function applySeoMetadata(html, seo) {
  const titleStart = html.indexOf('<title>');
  const titleEnd = html.indexOf('</title>', titleStart);
  if (titleStart >= 0 && titleEnd >= 0) {
    html = `${html.slice(0, titleStart)}<title>${escapeHtml(seo.title)}</title>${html.slice(titleEnd + '</title>'.length)}`;
  }
  html = replaceCanonicalLink(html, seo.url);
  html = upsertMetaContent(html, 'name', 'description', seo.description);
  html = upsertMetaContent(html, 'property', 'og:type', seo.type);
  html = upsertMetaContent(html, 'property', 'og:title', seo.title);
  html = upsertMetaContent(html, 'property', 'og:description', seo.description);
  html = upsertMetaContent(html, 'property', 'og:image', seo.image);
  html = upsertMetaContent(html, 'property', 'og:image:alt', seo.imageAlt);
  html = upsertMetaContent(html, 'property', 'og:url', seo.url);
  html = upsertMetaContent(html, 'name', 'twitter:title', seo.title);
  html = upsertMetaContent(html, 'name', 'twitter:description', seo.description);
  html = upsertMetaContent(html, 'name', 'twitter:image', seo.image);
  html = upsertMetaContent(html, 'name', 'twitter:url', seo.url);
  html = removeMetaTag(html, 'property', 'og:image:width');
  html = removeMetaTag(html, 'property', 'og:image:height');
  return html;
}

async function collectionSeoImage(slug, siteUrl) {
  const columns = productShape.PUBLIC_PRODUCT_SELECT;
  let row;
  try {
    if (config.PRODUCT_CATEGORY_VALUES.has(slug)) {
      row = await db.prepare(`SELECT ${columns} FROM products WHERE category = ? AND front_image IS NOT NULL AND front_image != '' ORDER BY created_at DESC, id DESC LIMIT 1`).get(slug);
      if (!row) row = await db.prepare(`SELECT ${columns} FROM products WHERE category = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(slug);
    } else if (slug === 'sale') {
      const candidates = await db.prepare(`SELECT ${columns} FROM products WHERE sale_price > ? AND sale_price < price ORDER BY created_at DESC, id DESC`)
        .all(0);
      const discounted = (candidates || []).filter(candidate => Number(candidate.sale_price) > 0 && Number(candidate.sale_price) < Number(candidate.price));
      row = discounted.find(candidate => absoluteHttpUrl(candidate.front_image, siteUrl)) || discounted[0];
    } else {
      row = await db.prepare(`SELECT ${columns} FROM products WHERE front_image IS NOT NULL AND front_image != '' ORDER BY created_at DESC, id DESC LIMIT 1`).get();
      if (!row) row = await db.prepare(`SELECT ${columns} FROM products ORDER BY created_at DESC, id DESC LIMIT 1`).get();
    }
  } catch (_) { row = null; }
  if (!row) return new URL('/images/og-image.jpg', `${siteUrl}/`).href;
  const product = productShape.shapePublicProduct(row);
  return publicProductImages(product, siteUrl).frontImage;
}

function productIdFromPath(pathname) {
  const prefix = '/product/';
  const pathValue = String(pathname || '');
  if (!pathValue.startsWith(prefix)) return null;
  const id = pathValue.slice(prefix.length);
  return id.length && Array.from(id).every(character => character >= '0' && character <= '9') ? id : null;
}

function collectionSlugFromPath(pathname) {
  const prefix = '/collection/';
  const pathValue = String(pathname || '');
  if (!pathValue.startsWith(prefix)) return null;
  const slug = pathValue.slice(prefix.length);
  const valid = slug.length && Array.from(slug).every(character =>
    (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character === '-');
  return valid ? slug : null;
}

async function resolveSeoPage(req, siteUrl) {
  const rawProductId = productIdFromPath(req.path);
  if (rawProductId !== null) {
    const id = Number(rawProductId);
    if (!Number.isSafeInteger(id) || id < 1) return { status: 404 };
    let row;
    try {
      row = await db.prepare(`SELECT ${productShape.PUBLIC_PRODUCT_SELECT} FROM products WHERE id = ?`).get(id);
    } catch (_) {
      // A lookup error is not evidence that the product is unknown. Preserve
      // the SPA shell/status when the database itself cannot answer reliably.
      return { status: 200 };
    }
    if (!row) return { status: 404 };

    let sizeStockMap = null;
    try { sizeStockMap = await sizeStock.loadSizeStock(db, row.id); } catch (_) { /* use public stock_qty below */ }
    const product = productShape.shapePublicProduct(row, { size_stock: sizeStockMap });
    const name = normalizeSeoName(product.name);
    const description = trimSeoDescription(product.description,
      `Shop ${name} from KAGE Culture: premium streetwear with original art, made for everyday wear.`);
    const { images, frontImage } = publicProductImages(product, siteUrl);
    const canonical = new URL(`/product/${id}`, `${siteUrl}/`).href;
    const offerPrice = product.sale_price != null && product.sale_price > 0 && product.sale_price < product.price
      ? product.sale_price
      : product.price;
    const productSchema = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name,
      image: images,
      description,
      sku: String(product.id),
      productID: String(product.id),
      brand: { '@type': 'Brand', name: 'KAGE Culture' },
      offers: {
        '@type': 'Offer',
        url: canonical,
        priceCurrency: 'PKR',
        price: offerPrice,
        availability: product.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        itemCondition: 'https://schema.org/NewCondition'
      }
    };
    const reviewData = await loadApprovedReviewSchema(product.id);
    if (reviewData && reviewData.reviewCount > 0) {
      productSchema.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: reviewData.ratingValue,
        reviewCount: reviewData.reviewCount,
        bestRating: 5,
        worstRating: 1
      };
      if (reviewData.reviews.length) productSchema.review = reviewData.reviews;
    }

    const categorySlug = COLLECTION_SEO[product.category] ? product.category : 'all';
    const category = COLLECTION_SEO[categorySlug];
    const categoryUrl = new URL(`/collection/${categorySlug}`, `${siteUrl}/`).href;
    return {
      status: 200,
      seo: {
        title: `${name} | KAGE CULTURE`,
        description,
        url: canonical,
        image: frontImage,
        imageAlt: name,
        type: 'product'
      },
      schemas: [
        productSchema,
        breadcrumbSchema([
          { name: 'Home', url: new URL('/', `${siteUrl}/`).href },
          { name: category.name, url: categoryUrl },
          { name, url: canonical }
        ])
      ]
    };
  }

  const slug = collectionSlugFromPath(req.path);
  if (slug !== null) {
    const collection = COLLECTION_SEO[slug];
    if (!collection) return { status: 200 };
    const canonical = new URL(`/collection/${slug}`, `${siteUrl}/`).href;
    return {
      status: 200,
      seo: {
        title: `${collection.name} | KAGE CULTURE`,
        description: trimSeoDescription(collection.description),
        url: canonical,
        image: await collectionSeoImage(slug, siteUrl),
        imageAlt: `${collection.name} by KAGE Culture`,
        type: 'website'
      },
      schemas: [breadcrumbSchema([
        { name: 'Home', url: new URL('/', `${siteUrl}/`).href },
        { name: collection.name, url: canonical }
      ])]
    };
  }
  return { status: 200 };
}

async function renderStorefrontHtml(req) {
  const siteUrl = getSiteUrlForRequest(req);
  const pagePath = req.path === '/index.html' ? '/' : req.path;
  const pageUrl = new URL(pagePath || '/', `${siteUrl}/`).href;
  let html = STOREFRONT_HTML_TEMPLATE
    .replaceAll('__SITE_URL__', siteUrl)
    .replaceAll('__PAGE_URL__', pageUrl);
  const resolved = await resolveSeoPage(req, siteUrl);
  if (resolved.seo) {
    html = applySeoMetadata(html, resolved.seo);
    html = appendJsonLd(html, resolved.schemas || []);
  }
  return { html, status: resolved.status || 200 };
}

async function sendStorefrontHtml(req, res, status) {
  setHtmlNoStore(res);
  const rendered = await renderStorefrontHtml(req);
  res.status(status == null ? rendered.status : status).type('html').send(rendered.html);
}

// Session secret — resolved through the single rule in utils/secret.js:
// SESSION_SECRET must be >= 32 chars, and the development fallback is allowed
// only when NODE_ENV is exactly 'development' or 'test'. Every other case
// (NODE_ENV unset, 'staging', a VPS/Docker deploy, ...) refuses to boot rather
// than sign cookies with a string anyone can read in this repo.
let SESSION_SECRET;
try {
  SESSION_SECRET = getSessionSecret();
} catch (err) {
  console.error('FATAL: ' + err.message);
  process.exit(1);
}

// ── Security Headers ──────────────────────────────────────────
app.use(loadHelmet()({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      // REQUIRED: the storefront/admin are built on inline onclick/onkeydown
      // handlers — omitting this lets helmet default to script-src-attr 'none',
      // which silently blocks every click (prod incident 2026-09-23).
      // Long-term removal tracked in AUDIT.md as FE-H2 (event delegation).
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://*.blob.vercel-storage.com"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false
}));

// ── Rate Limiting ─────────────────────────────────────────────
app.use((req, res, next) => {
  // A failed readiness check already proves the shared DB-backed limiter is
  // unavailable; don't make a second database attempt before serving crawler
  // documents from their static fallback.
  if (req.crawlerDatabaseUnavailable) return next();
  return globalLimiter(req, res, next);
});

// ── CSRF ──────────────────────────────────────────────────────
app.use(csrfMiddleware);

// The public cacheable reads (`/api/products`, `/api/products/:id`,
// `/api/reviews`) never send Set-Cookie, so a browser that has no `kage.csrf`
// cookie yet asks this small no-store endpoint for one before its first
// state-changing request. Returns the same value that (when the cookie was
// missing) is set as the cookie by the middleware above; no-store because the
// response both varies per client and carries a cookie.
app.get(CSRF_ENDPOINT, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: req.csrfRawToken });
});

// ── Compression ───────────────────────────────────────────────
app.use(loadCompression()({ level: 6, threshold: 1024 }));

// ── Body Parsers ──────────────────────────────────────────────
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// ── Sessions ──────────────────────────────────────────────────
app.use(loadCookieSession()({
  name: 'kage.session',
  secret: SESSION_SECRET,
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
  sameSite: 'lax'
}));

// ── Static Files ──────────────────────────────────────────────
// Preserve the conventional browser favicon request without a duplicate asset.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon-v2.ico'));

// L4: one canonical admin entry — redirect /admin.html to /admin BEFORE the
// static middleware can serve it directly.
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect(301, '/admin');
  next();
});
// Vendored assets are treated as version-pinned; changing one should include a
// filename bump so its one-year cache can remain immutable.
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), {
  maxAge: '365d',
  immutable: true,
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
}));

// These public documents use the same canonical origin configuration. The
// sitemap is shared-cacheable (CSRF middleware suppresses its first-visit
// cookie automatically); robots.txt stays no-store because it is tiny/static.
app.get('/sitemap.xml', async (req, res) => {
  const siteUrl = getSiteUrlForRequest(req);
  const cacheSeconds = Math.max(0, Math.floor(config.SITEMAP_CACHE_MS / 1000));
  res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`);
  const products = req.crawlerDatabaseUnavailable ? [] : await getSitemapProducts();
  res.type('application/xml').send(renderSitemap(siteUrl, products));
});
app.get('/robots.txt', (req, res) => {
  const siteUrl = getSiteUrlForRequest(req);
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
});
app.get(['/', '/index.html'], (req, res, next) => {
  sendStorefrontHtml(req, res).catch(next);
});

app.use(express.static(path.join(__dirname, 'public'), {
  // HTML stays uncacheable so deployments take effect immediately. Replaceable
  // static files get one day of public caching and must revalidate with ETag or
  // Last-Modified before a stale copy is used.
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate')
}));

// ── Cache-Control for API ─────────────────────────────────────
// HEAD follows the GET policy: it must report the same headers a GET would,
// including the cacheability the CSRF middleware reads before deciding whether
// this response may carry a cookie.
app.use((req, res, next) => {
  const sessionVaryingApi = /^\/api\/(?:admin|customers)(?:\/|$)/.test(req.path);
  if (sessionVaryingApi || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.path === '/api/products' || /^\/api\/products\/\d+$/.test(req.path)) {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30, must-revalidate');
    } else if (req.path === '/api/reviews') {
      res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120');
    }
  }
  next();
});

// ── Uploads directory (local dev) ─────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  try { require('fs').mkdirSync(uploadsDir, { recursive: true }); } catch (e) { /* serverless */ }
}

// ── Routes ────────────────────────────────────────────────────
const createAuthRoutes = require('./routes/auth');
const createProductRoutes = require('./routes/products');
const createOrderRoutes = require('./routes/orders');
const createReviewRoutes = require('./routes/reviews');
const createAdminRoutes = require('./routes/admin');

// Routes are registered after DB init below (see startServer)
// HTML fallback routes are also registered there (after API routes).

// ── Error Handler ─────────────────────────────────────────────
// Registered in ensureReady() AFTER all routes: Express only routes errors
// to handlers that sit later in the middleware stack, so an early registration
// let route errors (e.g. multer upload rejections) fall through to the
// default HTML stack-trace page instead of JSON.
function jsonErrorHandler(err, req, res, next) {
  console.error('Server error:', err);
  if (res.headersSent) return next(err);
  if (err instanceof loadMulter().MulterError) return res.status(400).json({ error: 'Upload error: ' + err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error.' });
}

// ── One-time data bootstrap ──────────────────────────────────────
// Each step is recorded in the DATABASE (app_settings) under a versioned key,
// so it runs at most once per database — not once per cold start. That is what
// stops a live shop from getting its deleted products back, its removed sales
// re-applied and its deliberate unit_cost = 0 overwritten on every deploy.
const BOOTSTRAP_KEYS = {
  products: 'seed_products_v1',
  categories: 'normalize_demo_categories_v1',
  salePrices: 'sync_seed_sale_prices_v1',
  unitCosts: 'backfill_unit_costs_v1',
  emails: 'normalize_emails_v1',
  removeOldCategories: 'remove_old_categories_v1'
};
let _bootstrapDone = false;

// Run `step` unless `key` is already recorded. The key is written only after
// the step resolved, so a failure is retried on the next request instead of
// being silently skipped forever.
async function runOnce(key, step) {
  if (await db.getSetting(key)) return false;
  const value = await step();
  await db.setSetting(key, value == null ? new Date().toISOString() : String(value));
  return true;
}

// Brand-new databases get the demo catalogue; databases that already have
// products (i.e. every existing deployment upgrading to this change) only get
// the marker — never a single product or sale price.
async function seedProductsOnce() {
  const count = await db.prepare('SELECT COUNT(*) as c FROM products').get();
  const existing = count && count.c != null ? Number(count.c) : 0;
  if (existing > 0) {
    console.log(`ℹ️  ${existing} product(s) already in the database — demo seed recorded as done, nothing re-inserted`);
    return 'existing';
  }
  const { added } = await demoProducts.seedDemoProducts(db);
  console.log('✅ Seeded ' + added + ' default products');
  return 'seeded';
}

// Earlier demo seeds stored the regular graphic tees as `anime`, while the
// storefront routes Graphic Tees using the `graphic-tees` collection key.
// Correct only those legacy defaults; an admin's other category edits survive.
async function normalizeDemoCategoriesOnce() {
  let changed = 0;
  for (const fix of demoProducts.LEGACY_CATEGORY_FIXES) {
    const result = await db.prepare('UPDATE products SET category = ? WHERE name = ? AND category = ?')
      .run(fix.to, fix.name, fix.from);
    changed += Number(result && result.changes) || 0;
  }
  if (changed) {
    await db.save();
    console.log(`🗂️  Corrected ${changed} legacy demo product categor${changed === 1 ? 'y' : 'ies'}`);
  }
  return 'normalized:' + changed;
}

async function syncSeedSalePricesOnce() {
  const seedState = await db.getSetting(BOOTSTRAP_KEYS.products);
  if (!seedState) throw new Error('seed step has not completed yet'); // retried with it
  if (seedState === 'existing') {
    console.log('ℹ️  catalogue predates the settings table — sale prices left exactly as the admin set them');
    return 'skipped-existing';
  }
  let changed = 0;
  for (const s of demoProducts.SEED_SALE_SYNCS) {
    const row = await db.prepare('SELECT id FROM products WHERE name = ? AND price = ? AND sale_price IS NULL').get(s.name, s.price);
    if (row) { await db.prepare('UPDATE products SET sale_price = ?, on_sale = ? WHERE id = ?').run(s.sale, 1, row.id); changed++; }
  }
  if (changed > 0) { await db.save(); console.log('💸 Synced sale prices for ' + changed + ' seeded product(s)'); }
  return 'synced:' + changed;
}

// unit_cost IS NULL only — a deliberate 0 (freebie, promo, unknown-but-zero)
// must survive, so 0 is never treated as "missing".
async function backfillUnitCostsOnce() {
  const missing = await db.prepare('SELECT id, price FROM products WHERE unit_cost IS NULL').all();
  if (missing.length === 0) return 'none';
  for (const p of missing) { await db.prepare('UPDATE products SET unit_cost = ? WHERE id = ?').run(Math.max(50, Math.round(p.price * 0.55)), p.id); }
  await db.save();
  console.log('💰 Backfilled unit costs for ' + missing.length + ' product(s)');
  return 'backfilled:' + missing.length;
}

// Emails are compared case-insensitively everywhere, so legacy mixed-case rows
// are normalised once per database. Duplicate-safe: see database.js.
async function normalizeEmailsOnce() {
  const stats = await db.normalizeEmailsMigration();
  const touched = stats.orders + stats.customersMerged + stats.customersLowered + stats.newsletterMerged + stats.newsletterLowered;
  if (touched) console.log(`📧 Normalised email casing (${JSON.stringify(stats)})`);
  return JSON.stringify(stats);
}

// v2026-10: the only allowed product categories are graphic-tees, anime, pants.
// Move any product not in one of those (including 'streetwear', 'goofy-wears'
// and any other unknown value) into 'graphic-tees' so nothing disappears from
// the catalog. Products already in an allowed category are left untouched.
// Idempotent: after running once every row carries an allowed category, so
// re-running changes zero rows.
async function removeOldCategoriesOnce() {
  const allowedList = Array.from(config.PRODUCT_CATEGORY_VALUES)
    .map(v => `'${String(v).replace(/'/g, "''")}'`).join(',');
  const result = await db.prepare(
    `UPDATE products SET category = 'graphic-tees' WHERE category NOT IN (${allowedList})`
  ).run();
  const moved = Number(result && result.changes) || 0;
  if (moved) {
    await db.save();
    console.log(`👖 Migrated ${moved} product(s) from removed categories into Graphic Tees`);
  }
  return 'migrated:' + moved;
}

// Returns true when every step is known-done (nothing left to retry).
async function bootstrapData() {
  let complete = true;
  for (const [key, step] of [
    [BOOTSTRAP_KEYS.products, seedProductsOnce],
    [BOOTSTRAP_KEYS.categories, normalizeDemoCategoriesOnce],
    [BOOTSTRAP_KEYS.removeOldCategories, removeOldCategoriesOnce],
    [BOOTSTRAP_KEYS.salePrices, syncSeedSalePricesOnce],
    [BOOTSTRAP_KEYS.unitCosts, backfillUnitCostsOnce],
    [BOOTSTRAP_KEYS.emails, normalizeEmailsOnce]
  ]) {
    try {
      await runOnce(key, step);
    } catch (e) {
      complete = false;
      console.error(`${key} skipped:`, e.message);
    }
  }
  return complete;
}

// ── Start ─────────────────────────────────────────────────────
// Idempotent bootstrap: init DB → seed → register routes. Safe to call from
// local dev, Vercel serverless, and tests.
async function ensureReady() {
  try { await dbModule.init(); } catch (e) { console.error('⚠️  Database init failed:', e.message); throw e; }
  db = dbModule;

  // One-time-per-database steps (app_settings keys), retried on the next
  // request if a step fails. A failure here must not take the site down.
  if (!_bootstrapDone) {
    if (await bootstrapData()) _bootstrapDone = true;
  }

  // Register routes (guard so repeated invocations don't double-register)
  if (!app._kageRoutesRegistered) {
    app._kageRoutesRegistered = true;
    app.use(createAuthRoutes(db));
    app.use(createProductRoutes(db));
    app.use(createOrderRoutes(db));
    app.use(createReviewRoutes(db));
    app.use(createAdminRoutes(db));

    // HTML fallback routes (registered AFTER API routes)
    // L4: admin.html IS the login page, so it must stay publicly reachable;
    // the data APIs behind it are the real protection. /admin.html already
    // redirects to /admin above (before static), giving one canonical entry.
    app.get('/admin', (req, res) => {
      setHtmlNoStore(res);
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
    const spaPages = new Set(['/', '/about', '/contact', '/tracking', '/shipping', '/returns', '/privacy', '/terms', '/account', '/checkout', '/confirmation', '/reset-password', '/verify-email', '/custom-stickers', '/coming-soon']);
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
      const isProductRoute = productIdFromPath(req.path) !== null;
      const known = spaPages.has(req.path) || isProductRoute || collectionSlugFromPath(req.path) !== null;
      // Product status comes from the public DB lookup: known products are 200,
      // missing products are 404, and lookup failures remain the SPA shell.
      const statusOverride = isProductRoute ? undefined : (known ? 200 : 404);
      sendStorefrontHtml(req, res, statusOverride).catch(next);
    });

    // Must sit AFTER the routes so route/middleware errors reach it as JSON
    // (upload-filter rejections, multer limits, etc.).
    app.use(jsonErrorHandler);
  }
}

// ── Readiness ─────────────────────────────────────────────────
// The boot promise is cached ONLY while it is pending or fulfilled. A failed
// attempt clears the cache so the next request retries — the old one-shot
// `const serverReady = ensureReady()` replayed one rejection for the entire life
// of a serverless instance (every request 503 until it was recycled) and, on
// Node 15+, that rejected promise was also an unhandled rejection at creation.
let readyPromise = null;   // pending or fulfilled boot attempt
let readyError = null;     // last failure (cleared on success)
let readyFailedAt = 0;     // when it failed — drives the retry backoff

function getReady() {
  if (readyPromise) return readyPromise;                 // pending or ready
  if (readyError && Date.now() - readyFailedAt < config.READY_RETRY_BACKOFF_MS) {
    // Inside the backoff window: report the known failure immediately instead
    // of running another doomed init against a database that is already down.
    const cached = Promise.reject(readyError);
    cached.catch(() => {});                              // never unhandled
    return cached;
  }
  const attempt = ensureReady().then(
    (value) => { readyError = null; return value; },
    (err) => {
      readyPromise = null;                               // allow a retry
      readyError = err;
      readyFailedAt = Date.now();
      throw err;
    }
  );
  attempt.catch(() => {});                               // never unhandled
  readyPromise = attempt;
  return attempt;
}

// Middleware used by the serverless entrypoint (and by the tests): wait for the
// boot, or answer a JSON 503 with Retry-After. The real error stays in the
// server log — the response carries no connection strings or stack traces.
function sendUnavailable(res) {
  const retryAfter = String(Math.max(1, Math.ceil(config.READY_RETRY_BACKOFF_MS / 1000)));
  const body = { error: 'Service temporarily unavailable — the server is still starting up. Please retry in a moment.' };
  if (res.headersSent) return;
  res.setHeader('Retry-After', retryAfter);
  // Express-style response when mounted in Express (Vercel, tests); plain
  // writeHead/end when this runs behind a bare http server. Either way the
  // failure path itself must never throw.
  if (typeof res.status === 'function') return res.status(503).json(body);
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': retryAfter });
  res.end(JSON.stringify(body));
}

function requestPathname(req) {
  if (typeof req.path === 'string') return req.path;
  try { return new URL(String(req.url || '/'), 'http://localhost').pathname; }
  catch (_) { return ''; }
}

function isCrawlerDocumentRequest(req) {
  return ['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase()) &&
    ['/sitemap.xml', '/robots.txt'].includes(requestPathname(req));
}

function readinessGate(req, res, next) {
  const crawlerDocument = isCrawlerDocumentRequest(req);
  return getReady().then(() => next(), (err) => {
    if (crawlerDocument) {
      // Crawler documents have a static fallback even when the database is
      // unavailable. The sitemap route skips its product query on this request.
      req.crawlerDatabaseUnavailable = true;
      console.warn('Serving crawler document fallback after database readiness failure.');
      return next();
    }
    console.error('Server not ready:', err.message);
    try { sendUnavailable(res); } catch (e) { console.error('503 write failed:', e.message); }
  });
}

// Vercel serverless entrypoint
module.exports = (req, res) => {
  readinessGate(req, res, () => app(req, res));
};
module.exports.app = app;          // tests: boot your own listener
module.exports.ensureReady = ensureReady;
module.exports.getReady = getReady;         // tests: retry/backoff behaviour
module.exports.bootstrapData = bootstrapData; // tests: one-time-per-database steps
module.exports.readinessGate = readinessGate;
module.exports.escapeXml = escapeXml;   // sitemap XML escaping regression tests

// Local dev / direct execution: listen and manage the process lifecycle.
if (require.main === module) {
  getReady().then(() => {
    const server = app.listen(PORT, () => {
      const mode = dbModule.USE_TURSO ? 'Turso (cloud)' : (dbModule.activeBackend === 'mem' ? 'in-memory' : 'sql.js (local)');
      console.log(`\n╔══════════════════════════════════════════════════╗\n║         KAGE CULTURE — Admin System              ║\n╠══════════════════════════════════════════════════╣\n║  Public site:  http://localhost:${PORT}              ║\n║  Admin panel:  http://localhost:${PORT}/admin       ║\n║  Database:     ${mode}                                ║\n╚══════════════════════════════════════════════════╝\n    `);
    });
    process.on('SIGTERM', () => { console.log('SIGTERM received — shutting down gracefully...'); server.close(() => { process.exit(0); }); setTimeout(() => process.exit(1), 5000); });
  }).catch(err => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}
