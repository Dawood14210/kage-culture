// ================================================================
// KAGE Culture — E2E regression tests
// Run: node tests/e2e.test.js
//
// Boots the real Express app on an ephemeral port with the in-memory DB
// fallback (local only, never on Vercel), then drives it over HTTP.
// No framework needed — plain node:assert.
// ================================================================
process.env.NODE_ENV = process.env.NODE_ENV || 'test'; // allows the dev fallback in utils/secret.js
process.env.ALLOW_ADMIN_SETUP = 'true'; // tests exercise the gated bootstrap
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-regression-tests';
process.env.SITE_URL = 'https://shop.kage.test';
// The suite drives all scenarios from one IP in seconds; do not exhaust the
// storefront's production-wide per-minute request budget during the tests.
require('../config').RATE_LIMIT_GLOBAL = 1000;
// Auth and tracking paths share the production strict limiter; the broad E2E
// regression suite should not exhaust a real visitor's per-minute budget.
require('../config').RATE_LIMIT_STRICT = 1000;
// The suite places more orders than a single storefront visitor would.
require('../config').RATE_LIMIT_ORDERS = 1000;
// Verification/resend share the reset limiter; the suite exercises them repeatedly.
require('../config').RATE_LIMIT_RESET = 1000;

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');
const demoProducts = require('../utils/demoProducts');

// Fresh module state for every run
delete require.cache[require.resolve('../database.js')];
const dbModule = require('../database.js');

const { app, ensureReady } = require('../server.js');
const productShape = require('../utils/productShape');
const serverModule = require('../server.js');

const BASE = 'http://127.0.0.1:0';

function request(port, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(headers || {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Fetch a PERF-1 bundle body (the split CSS/JS live outside the shell now,
// so content assertions against them fetch the asset instead of the page).
async function asset(port, path) {
  const r = await request(port, 'GET', path);
  assert.strictEqual(r.status, 200, `${path} must be served`);
  return r.text;
}

// Pull the Set-Cookie pairs out of a login response
function cookieHeader(res) {
  const sc = res.headers['set-cookie'] || [];
  return sc.map((c) => c.split(';')[0]).join('; ');
}

// The dev-mode email log prints the links inside each email; capture the
// verification URL a request triggered so the suite can "open" it like a user.
async function captureEmailLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); original.apply(console, args); };
  try { const result = await fn(); return { result, logged: lines.join('\n') }; } finally { console.log = original; }
}
function extractVerifyUrl(log) {
  const m = String(log).match(/https?:\/\/[^\s]*\/verify-email\?token=[a-f0-9]+/);
  return m ? m[0] : null;
}
// Sign a customer up and keep the session cookie the signup response issues.
async function signupCustomer(email, password, name) {
  const csrf = await getCsrf();
  const res = await request(PORT, 'POST', '/api/customers/signup', {
    body: { email, password, name },
    headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
  });
  return { res, cookie: cookieHeader(res) };
}

// Capture outbound emails by stubbing the Resend API call: the real templates
// are built and posted exactly as in production, we just read the payload.
async function captureEmails(fn) {
  const sent = [];
  const realFetch = global.fetch;
  const previousKey = process.env.EMAIL_API_KEY;
  const previousSmtpHost = process.env.SMTP_HOST;
  const previousEmailFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_API_KEY = 'test-capture-key';
  delete process.env.SMTP_HOST; // explicitly exercise the Resend fallback path
  delete process.env.EMAIL_FROM;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse((opts && opts.body) || '{}'));
      return { ok: true, status: 200, json: async () => ({ id: 'captured' }) };
    }
    return realFetch(url, opts);
  };
  try { const result = await fn(); return { result, sent }; }
  finally {
    global.fetch = realFetch;
    if (previousKey === undefined) delete process.env.EMAIL_API_KEY; else process.env.EMAIL_API_KEY = previousKey;
    if (previousSmtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = previousSmtpHost;
    if (previousEmailFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = previousEmailFrom;
  }
}

// Exercise the production SMTP code with Nodemailer's real JSON transport. The
// adapter never opens a socket, but returns the fully-normalized message that
// Nodemailer would send over SMTP. Optional failures emulate unavailable SMTP.
async function captureSmtpEmails(fn, settings = {}) {
  const nodemailer = require('nodemailer');
  const originalCreateTransport = nodemailer.createTransport;
  const realFetch = global.fetch;
  const envKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_API_KEY', 'EMAIL_FROM'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const sent = [];
  const transportOptions = [];
  const resendRequests = [];
  process.env.SMTP_HOST = 'smtp.gmail.test';
  if (settings.port == null) delete process.env.SMTP_PORT;
  else process.env.SMTP_PORT = String(settings.port);
  process.env.SMTP_USER = 'shop@gmail.test';
  process.env.SMTP_PASS = 'capture-only-app-password';
  delete process.env.EMAIL_FROM;
  if (settings.resendKey) process.env.EMAIL_API_KEY = settings.resendKey;
  else delete process.env.EMAIL_API_KEY;

  // A fetch fallback is captured too, so even a regression that wrongly falls
  // through after SMTP failure cannot open a network connection in this test.
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      resendRequests.push({ url: String(url), options: opts });
      return { ok: true, status: 200, json: async () => ({ id: 'unexpected-resend-fallback' }) };
    }
    return realFetch(url, opts);
  };
  nodemailer.createTransport = (options) => {
    transportOptions.push(options);
    if (settings.fail) {
      return { sendMail: async () => { throw new Error('SMTP test transport rejected'); }, close() {} };
    }
    if (settings.stall) {
      return { sendMail: () => new Promise(() => {}), close() {} };
    }
    const jsonTransport = originalCreateTransport({ jsonTransport: true });
    const sendMail = jsonTransport.sendMail.bind(jsonTransport);
    jsonTransport.sendMail = async (message) => {
      const info = await sendMail(message);
      sent.push(JSON.parse(info.message));
      return info;
    };
    return jsonTransport;
  };

  try {
    const result = await fn();
    return { result, sent, transportOptions, resendRequests };
  } finally {
    nodemailer.createTransport = originalCreateTransport;
    global.fetch = realFetch;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
}
const hrefOf = (html) => (String(html).match(/href="([^"]+)"/) || [])[1] || '';
function parseJsonLdSchemas(html) {
  const document = new JSDOM(html).window.document;
  return Array.from(document.querySelectorAll('script[type="application/ld+json"]'), script => JSON.parse(script.textContent));
}
function assertSmtpHeaders(mail, to, subject) {
  assert.deepStrictEqual(mail.from, { address: 'shop@gmail.test', name: '' }, 'SMTP_USER is the default sender');
  assert.deepStrictEqual(mail.to, [{ address: to, name: '' }], 'the intended recipient is preserved');
  assert.strictEqual(mail.subject, subject);
  assert.deepStrictEqual(mail.headers, {}, 'customer data must not add arbitrary message headers');
  assert.ok(!/[\r\n]/.test(mail.subject), 'the SMTP subject must contain no header line breaks');
}

// Minimal RFC 4180 parser: quoted fields may contain commas, doubled quotes
// and newlines, so the export must never be validated by splitting on commas.
function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r' && src[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared by the child-process checks (session secret, boot retry, bootstrap).
const REPO_ROOT = path.join(__dirname, '..');
// Stripped env for spawnSync: none of the suite's own vars leak in.
const cleanEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });

let server, PORT;
const results = [];
function check(name, fn) {
  return fn()
    .then(() => { results.push([name, true, '']); console.log('  ✅', name); })
    .catch((e) => { results.push([name, false, e.message]); console.log('  ❌', name, '—', e.message); });
}

async function main() {
  // Boot DB + seed + routes, then listen on an ephemeral port
  await ensureReady();
  await new Promise((resolve) => {
    server = app.listen(0, () => { PORT = server.address().port; resolve(); });
  });
  console.log(`\nTest server on :${PORT}\n`);

  // ---------------------------------------------------------------
  // Static asset cache contracts (run before changing server.js)
  // ---------------------------------------------------------------
  console.log('Static cache headers:');
  await check('replaceable images use one-day public caching with revalidation', async () => {
    const image = await request(PORT, 'GET', '/images/hero.jpg', { headers: { Cookie: 'kage.csrf=cache-probe' } });
    assert.strictEqual(image.status, 200);
    assert.strictEqual(image.headers['cache-control'], 'public, max-age=86400, must-revalidate');
  });

  await check('HTML remains no-store', async () => {
    const page = await request(PORT, 'GET', '/');
    assert.match(page.headers['cache-control'] || '', /no-store/);
  });

  await check('canonical, Open Graph and JSON-LD tags use SITE_URL; sitemap and robots are dynamic', async () => {
    const [page, sitemap, robots] = await Promise.all([
      request(PORT, 'GET', '/'),
      request(PORT, 'GET', '/sitemap.xml'),
      request(PORT, 'GET', '/robots.txt')
    ]);
    const rootUrl = `${process.env.SITE_URL}/`;
    assert.ok(page.text.includes(`<link rel="canonical" href="${rootUrl}" />`));
    assert.ok(page.text.includes(`<meta property="og:url" content="${rootUrl}" />`));
    assert.ok(page.text.includes(`"url": "${rootUrl}"`));
    assert.ok(page.text.includes(`"logo": "${process.env.SITE_URL}/images/icon-512-v2.png"`));
    const homeDocument = new JSDOM(page.text).window.document;
    assert.strictEqual(homeDocument.title, 'KAGE CULTURE — Engineered Fit. Original Art.');
    assert.strictEqual(homeDocument.querySelector('meta[name="description"]').content,
      'KAGE Culture — Premium streetwear. Anime inspired. Built for everyday. Shop oversized tees, graphic tees, and compression gear.');
    assert.strictEqual(homeDocument.querySelector('meta[property="og:title"]').content,
      'KAGE Culture — Engineered Fit. Original Art.');
    assert.strictEqual(homeDocument.querySelector('meta[property="og:description"]').content,
      'Premium streetwear. Anime inspired. Built for everyday.');
    const homeSchemas = parseJsonLdSchemas(page.text);
    assert.ok(homeSchemas.some(schema => schema['@type'] === 'Organization'), 'homepage Organization JSON-LD remains');
    const website = homeSchemas.find(schema => schema['@type'] === 'WebSite');
    assert.ok(website, 'homepage includes WebSite JSON-LD');
    assert.strictEqual(website.url, rootUrl);
    assert.ok(sitemap.text.includes(`<loc>${rootUrl}</loc>`));
    assert.ok(robots.text.includes(`Sitemap: ${process.env.SITE_URL}/sitemap.xml`));
    assert.match(robots.text, /^User-agent: \*\nAllow: \/\nDisallow: \/admin\nDisallow: \/api\n/m);
  });

  await check('product and collection routes server-render safe metadata and structured data', async () => {
    const seeded = await dbModule.prepare('SELECT id, name, description, front_image, back_image, extra_images FROM products WHERE name = ?').get('Shadow Fit');
    const soldOut = await dbModule.prepare('SELECT id FROM products WHERE name = ?').get('Hollow Gaze');
    assert.ok(seeded, 'the seeded product must be available for SSR coverage');
    assert.ok(soldOut, 'the seeded sold-out product must be available for schema coverage');
    const originalProduct = { ...seeded };
    const hostileName = 'Hostile </script><script>alert("seo-test")</script> & Tee';
    const hostileDescription = `<p>${'Premium cotton with original art & everyday wear. '.repeat(7)}</p>`;
    const reviewOrderNumbers = ['SEO-META-APPROVED-A', 'SEO-META-APPROVED-B', 'SEO-META-PENDING'];
    const createdAt = new Date().toISOString();

    try {
      await dbModule.prepare('UPDATE products SET name = ?, description = ?, front_image = ?, back_image = ?, extra_images = ? WHERE id = ?')
        .run(hostileName, hostileDescription, '/uploads/seo-front.png', 'https://images.kage.test/seo-back.jpg', '["/uploads/seo-gallery.png"]', seeded.id);
      await dbModule.prepare('INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, viewer_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(seeded.id, reviewOrderNumbers[0], 'Buyer <b>Ada</b>', 5, 'Excellent </script><script>alert("review-test")</script>', 'approved', '', createdAt);
      await dbModule.prepare('INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, viewer_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(seeded.id, reviewOrderNumbers[1], 'Kai', 4, 'Great fit', 'approved', '', createdAt);
      await dbModule.prepare('INSERT INTO reviews (product_id, order_number, customer_name, rating, comment, status, viewer_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(seeded.id, reviewOrderNumbers[2], 'Pending Buyer', 1, 'Pending review must not be indexed', 'pending', '', createdAt);

      const productPage = await request(PORT, 'GET', `/product/${seeded.id}`);
      assert.strictEqual(productPage.status, 200);
      const productDocument = new JSDOM(productPage.text).window.document;
      const expectedTitle = `${hostileName} | KAGE CULTURE`;
      const productUrl = `${process.env.SITE_URL}/product/${seeded.id}`;
      const frontImage = `${process.env.SITE_URL}/uploads/seo-front.png`;
      assert.strictEqual(productDocument.title, expectedTitle);
      assert.strictEqual(productDocument.querySelector('meta[name="description"]').content.length,
        require('../config').SEO_DESCRIPTION_MAX_LENGTH, 'long descriptions are capped around 155 characters');
      assert.ok(productDocument.querySelector('meta[name="description"]').content.endsWith('…'));
      assert.strictEqual(productDocument.querySelector('link[rel="canonical"]').href, productUrl);
      assert.strictEqual(productDocument.querySelector('meta[property="og:type"]').content, 'product');
      assert.strictEqual(productDocument.querySelector('meta[property="og:title"]').content, expectedTitle);
      assert.strictEqual(productDocument.querySelector('meta[property="og:image"]').content, frontImage);
      assert.strictEqual(productDocument.querySelector('meta[name="twitter:title"]').content, expectedTitle);
      assert.strictEqual(productDocument.querySelector('meta[name="twitter:image"]').content, frontImage);
      assert.strictEqual(productDocument.querySelector('meta[name="twitter:url"]').content, productUrl);
      assert.ok(!productPage.text.includes('<script>alert("seo-test")</script>'), 'hostile product names never create raw HTML/script tags');
      assert.ok(productPage.text.includes(`${String.fromCharCode(92)}u003c/script`), 'JSON-LD escapes < as \\u003c');

      const productSchemas = parseJsonLdSchemas(productPage.text);
      const productSchema = productSchemas.find(schema => schema['@type'] === 'Product');
      assert.ok(productSchema, 'product route has a Product JSON-LD block');
      assert.strictEqual(productSchema.name, hostileName, 'escaped JSON-LD retains the original product name');
      assert.deepStrictEqual(productSchema.image, [frontImage, 'https://images.kage.test/seo-back.jpg', `${process.env.SITE_URL}/uploads/seo-gallery.png`]);
      assert.ok(productSchema.image.every(image => /^https?:\/\//.test(image)), 'all schema images are absolute HTTP(S) URLs');
      assert.strictEqual(productSchema.sku, String(seeded.id));
      assert.strictEqual(productSchema.productID, String(seeded.id));
      assert.deepStrictEqual(productSchema.brand, { '@type': 'Brand', name: 'KAGE Culture' });
      assert.strictEqual(productSchema.offers.priceCurrency, 'PKR');
      assert.strictEqual(productSchema.offers.price, 1499);
      assert.strictEqual(productSchema.offers.url, productUrl);
      assert.strictEqual(productSchema.offers.availability, 'https://schema.org/InStock');
      assert.strictEqual(productSchema.description.length, require('../config').SEO_DESCRIPTION_MAX_LENGTH);
      assert.strictEqual(productSchema.aggregateRating.reviewCount, 2, 'only approved reviews contribute to the aggregate');
      assert.strictEqual(productSchema.aggregateRating.ratingValue, 4.5);
      assert.strictEqual(productSchema.review.length, 2, 'only approved reviews are embedded');
      assert.ok(!JSON.stringify(productSchema).includes('Pending review must not be indexed'));
      assert.doesNotMatch(JSON.stringify(productSchema), /unit_cost|updated_at|viewer_token|order_number/,
        'the schema contains no admin-only product columns or private review fields');
      const productBreadcrumb = productSchemas.find(schema => schema['@type'] === 'BreadcrumbList');
      assert.ok(productBreadcrumb, 'product route has BreadcrumbList JSON-LD');
      assert.strictEqual(productBreadcrumb.itemListElement.at(-1).item, productUrl);

      const soldOutPage = await request(PORT, 'GET', `/product/${soldOut.id}`);
      assert.strictEqual(soldOutPage.status, 200);
      const soldOutSchema = parseJsonLdSchemas(soldOutPage.text).find(schema => schema['@type'] === 'Product');
      assert.ok(soldOutSchema);
      assert.strictEqual(soldOutSchema.offers.availability, 'https://schema.org/OutOfStock');
      assert.ok(!('aggregateRating' in soldOutSchema) && !('review' in soldOutSchema),
        'review schema is omitted when no approved reviews exist');

      const collectionPage = await request(PORT, 'GET', '/collection/anime');
      assert.strictEqual(collectionPage.status, 200);
      const collectionDocument = new JSDOM(collectionPage.text).window.document;
      const collectionUrl = `${process.env.SITE_URL}/collection/anime`;
      assert.strictEqual(collectionDocument.title, 'Anime Shirts | KAGE CULTURE');
      assert.strictEqual(collectionDocument.querySelector('link[rel="canonical"]').href, collectionUrl);
      assert.strictEqual(collectionDocument.querySelector('meta[name="description"]').content,
        'Shop anime-inspired shirts with original artwork, premium cotton, and everyday streetwear fits.');
      assert.strictEqual(collectionDocument.querySelector('meta[property="og:image"]').content, frontImage);
      assert.strictEqual(collectionDocument.querySelector('meta[name="twitter:url"]').content, collectionUrl);
      const collectionSchemas = parseJsonLdSchemas(collectionPage.text);
      const collectionBreadcrumb = collectionSchemas.find(schema => schema['@type'] === 'BreadcrumbList');
      assert.ok(collectionBreadcrumb, 'collection route has BreadcrumbList JSON-LD');
      assert.strictEqual(collectionBreadcrumb.itemListElement.at(-1).item, collectionUrl);
      assert.ok(!collectionSchemas.some(schema => schema['@type'] === 'Product'), 'collection route does not invent a Product entity');

      const missing = await request(PORT, 'GET', '/product/999999999');
      assert.strictEqual(missing.status, 404, 'an established missing product uses HTTP 404');
      assert.match(missing.headers['content-type'] || '', /text\/html/);
      assert.ok(missing.text.includes('<!DOCTYPE html>'), '404 retains the SPA shell');
    } finally {
      for (const orderNumber of reviewOrderNumbers) {
        await dbModule.prepare('DELETE FROM reviews WHERE order_number = ?').run(orderNumber);
      }
      await dbModule.prepare('UPDATE products SET name = ?, description = ?, front_image = ?, back_image = ?, extra_images = ? WHERE id = ?')
        .run(originalProduct.name, originalProduct.description, originalProduct.front_image, originalProduct.back_image, originalProduct.extra_images, seeded.id);
    }
  });

  await check('sitemap is valid, cached XML with product/category/static URLs and no private routes', async () => {
    const sitemap = await request(PORT, 'GET', '/sitemap.xml');
    const known = await dbModule.prepare('SELECT id, updated_at FROM products WHERE name = ?').get('Shadow Fit');
    const soldOut = await dbModule.prepare('SELECT id FROM products WHERE name = ?').get('Hollow Gaze');
    assert.ok(known, 'the seeded known product must be present');
    assert.ok(soldOut, 'the seeded sold-out product must be present');

    const namespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
    const xmlDocument = new JSDOM(sitemap.text, { contentType: 'application/xml' }).window.document;
    assert.strictEqual(xmlDocument.documentElement.localName, 'urlset');
    assert.strictEqual(xmlDocument.getElementsByTagName('parsererror').length, 0, 'the response must parse as valid XML');
    const locations = Array.from(xmlDocument.getElementsByTagNameNS(namespace, 'loc'), node => node.textContent);
    const expectedProductUrl = `${process.env.SITE_URL}/product/${known.id}`;
    assert.ok(locations.includes(expectedProductUrl), `missing known product URL ${expectedProductUrl}`);
    assert.ok(locations.includes(`${process.env.SITE_URL}/product/${soldOut.id}`), 'sold-out products remain listed');

    for (const route of [
      '/', '/about', '/contact', '/custom-stickers', '/returns', '/shipping', '/terms', '/privacy', '/tracking',
      '/collection/all', '/collection/new', '/collection/anime', '/collection/graphic-tees', '/collection/sale'
    ]) {
      const url = route === '/' ? `${process.env.SITE_URL}/` : `${process.env.SITE_URL}${route}`;
      assert.ok(locations.includes(url), `missing expected public URL ${url}`);
    }
    for (const forbidden of ['/admin', '/admin.html', '/api', '/cart', '/checkout', '/account', '/reset-password', '/verify-email', '/confirmation']) {
      assert.ok(!locations.some(location => new URL(location).pathname === forbidden || new URL(location).pathname.startsWith(`${forbidden}/`)),
        `private route must not appear: ${forbidden}`);
    }

    const entries = Array.from(xmlDocument.getElementsByTagNameNS(namespace, 'url'));
    const productEntry = entries.find(entry => entry.getElementsByTagNameNS(namespace, 'loc')[0]?.textContent === expectedProductUrl);
    assert.ok(productEntry, 'known product entry must be in the parsed document');
    assert.strictEqual(productEntry.getElementsByTagNameNS(namespace, 'lastmod')[0]?.textContent,
      new Date(known.updated_at).toISOString(), 'product lastmod must come from updated_at');

    assert.strictEqual(sitemap.headers['cache-control'], `public, max-age=${Math.floor(require('../config').SITEMAP_CACHE_MS / 1000)}, s-maxage=${Math.floor(require('../config').SITEMAP_CACHE_MS / 1000)}`);
    assert.strictEqual(sitemap.headers['set-cookie'], undefined, 'a shared-cacheable sitemap must not set visitor-specific cookies');
    assert.doesNotMatch(sitemap.text, /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/,
      'all ampersands in the XML must be escaped as valid entities');
    assert.strictEqual(serverModule.escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;',
      'the sitemap escaper encodes all XML-significant characters');
  });

  await check('production page tags fall back to the request origin and warn when SITE_URL is unset', async () => {
    const previousSiteUrl = process.env.SITE_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    const originalWarn = console.warn;
    const warnings = [];
    delete process.env.SITE_URL;
    process.env.NODE_ENV = 'production';
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
      const page = await request(PORT, 'GET', '/');
      const requestOrigin = `http://127.0.0.1:${PORT}/`;
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes(`href="${requestOrigin}"`), 'canonical must use the current request origin');
      assert.ok(warnings.some(message => /SITE_URL.*request origin/i.test(message)), 'production fallback must be logged');
    } finally {
      console.warn = originalWarn;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
      if (previousSiteUrl === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = previousSiteUrl;
    }
  });

  await check('/vendor assets retain their long cache lifetime', async () => {
    const vendor = await request(PORT, 'GET', '/vendor/chart.umd.min.js', { headers: { Cookie: 'kage.csrf=cache-probe' } });
    assert.strictEqual(vendor.status, 200);
    assert.match(vendor.headers['cache-control'] || '', /max-age=31536000/);
  });

  console.log('API cache headers:');
  await check('single-product GET uses public cache headers', async () => {
    const product = await request(PORT, 'GET', '/api/products/1', { headers: { Cookie: 'kage.csrf=cache-probe' } });
    assert.strictEqual(product.status, 200);
    assert.strictEqual(product.headers['cache-control'], 'public, max-age=0, s-maxage=10, stale-while-revalidate=30, must-revalidate');
  });

  await check('public cached API reads with an existing CSRF cookie do not Set-Cookie', async () => {
    const products = await request(PORT, 'GET', '/api/products', { headers: { Cookie: 'kage.csrf=cache-probe' } });
    assert.strictEqual(products.status, 200);
    assert.strictEqual(products.headers['set-cookie'], undefined);
  });

  await check('public cacheable reads never send Set-Cookie to a cookie-less client', async () => {
    // A CDN/edge cache would store these responses and replay one visitor's
    // cookie to every other visitor, so no Set-Cookie may be emitted at all.
    const reads = [
      ['/api/products', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30, must-revalidate'],
      ['/api/products/1', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30, must-revalidate'],
      ['/api/reviews', 'public, max-age=120, s-maxage=120']
    ];
    for (const [path, expectedCache] of reads) {
      // HEAD must report the same headers a GET would, cacheability included.
      for (const method of ['GET', 'HEAD']) {
        const fresh = await request(PORT, method, path);
        assert.strictEqual(fresh.status, 200, `${method} ${path} must answer 200`);
        assert.strictEqual(fresh.headers['cache-control'], expectedCache, `${method} ${path} cache headers`);
        assert.strictEqual(fresh.headers['set-cookie'], undefined, `${method} ${path} must not send Set-Cookie`);
        // …and the same holds for a client that already carries one.
        const withCookie = await request(PORT, method, path, { headers: { Cookie: 'kage.csrf=cache-probe' } });
        assert.strictEqual(withCookie.headers['set-cookie'], undefined, `${method} ${path} must not refresh Set-Cookie`);
      }
    }
  });

  await check('product revalidation returns bodyless 304s without Set-Cookie', async () => {
    for (const path of ['/api/products', '/api/products/1']) {
      const first = await request(PORT, 'GET', path);
      assert.strictEqual(first.status, 200);
      assert.ok(first.headers.etag, `${path} must have an ETag`);
      assert.strictEqual(first.headers['set-cookie'], undefined);
      for (const cookie of [undefined, 'kage.csrf=cache-probe']) {
        const repeat = await request(PORT, 'GET', path, { headers: {
          'If-None-Match': first.headers.etag, ...(cookie ? { Cookie: cookie } : {})
        } });
        assert.strictEqual(repeat.status, 304, path);
        assert.strictEqual(repeat.text, '');
        assert.strictEqual(repeat.headers.etag, first.headers.etag);
        assert.strictEqual(repeat.headers['cache-control'], first.headers['cache-control']);
        assert.strictEqual(repeat.headers['set-cookie'], undefined);
      }
    }
  });

  await check('the no-store /api/csrf endpoint issues the token the client must echo back', async () => {
    const fresh = await request(PORT, 'GET', '/api/csrf');
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.headers['cache-control'], 'no-store');
    const cookie = (fresh.headers['set-cookie'] || []).find(c => c.startsWith('kage.csrf='));
    assert.ok(cookie, 'a cookie-less client must receive the kage.csrf cookie');
    assert.strictEqual(fresh.json && fresh.json.token, cookie.split(';')[0].split('=')[1], 'the body token must match the cookie');

    // A client that already has the cookie gets the same token back and no
    // second cookie (the middleware only defers one when it was missing).
    const again = await request(PORT, 'GET', '/api/csrf', { headers: { Cookie: cookie.split(';')[0] } });
    assert.strictEqual(again.headers['set-cookie'], undefined);
    assert.strictEqual(again.json.token, fresh.json.token);
  });

  await check('HTML page responses still issue the CSRF cookie', async () => {
    const page = await request(PORT, 'GET', '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['cache-control'] || '', /no-store/);
    assert.ok((page.headers['set-cookie'] || []).some(cookie => cookie.startsWith('kage.csrf=')),
      'the storefront page must hand a fresh visitor its CSRF cookie');
    const admin = await request(PORT, 'GET', '/admin');
    assert.ok((admin.headers['set-cookie'] || []).some(cookie => cookie.startsWith('kage.csrf=')),
      'the admin page must hand a fresh visitor its CSRF cookie');
    // Publicly cached static assets are not page responses either.
    const asset = await request(PORT, 'GET', '/images/hero.jpg');
    assert.strictEqual(asset.headers['set-cookie'], undefined, 'cached static assets must not send Set-Cookie');

    // …and the cookie that page just handed out is usable for a later POST
    // (the primary browser path). A valid token reaches the handler, which
    // rejects the deliberately empty order body with a validation 400 — not a
    // CSRF 403.
    const pageCookie = (page.headers['set-cookie'] || []).find(c => c.startsWith('kage.csrf=')).split(';')[0];
    const emptyOrder = await request(PORT, 'POST', '/api/orders', {
      body: {},
      headers: { 'X-CSRF-Token': pageCookie.split('=')[1], Cookie: pageCookie }
    });
    assert.strictEqual(emptyOrder.status, 400, `a page-issued token must pass requireCsrf: ${JSON.stringify(emptyOrder.json)}`);
  });

  // ---------------------------------------------------------------
  // A fresh browser (no cookies at all) still completes a checkout
  // ---------------------------------------------------------------
  console.log('CSRF: fresh-browser checkout:');
  await check('a cookie-less client is refused until it fetches /api/csrf, then places an order', async () => {
    const catalog = (await request(PORT, 'GET', '/api/products')).json;
    const product = catalog.find(p => p.in_stock && (p.stock_qty == null || Number(p.stock_qty) > 0) && Array.isArray(p.sizes) && p.sizes.length > 0);
    assert.ok(product, 'the catalogue must offer an in-stock product');
    const orderBody = {
      name: 'Fresh Browser',
      email: 'fresh.browser@kage.test',
      phone: '03001234500',
      address: '1 Fresh St',
      city: 'Lahore',
      payment_method: 'cod',
      items: [{ id: product.id, qty: 1, size: product.sizes[0] }]
    };

    // 1. No cookie, no token: the state-changing request must be refused.
    const withoutToken = await request(PORT, 'POST', '/api/orders', { body: orderBody });
    assert.strictEqual(withoutToken.status, 403, JSON.stringify(withoutToken.json));

    // 2. Double submit: a valid token without its cookie is still refused
    //    (so a stolen/replayed header value is worthless on its own).
    const other = await getCsrf();
    const withoutCookie = await request(PORT, 'POST', '/api/orders', { body: orderBody, headers: { 'X-CSRF-Token': other.token } });
    assert.strictEqual(withoutCookie.status, 403, JSON.stringify(withoutCookie.json));

    // 3. What the storefront does when document.cookie has no kage.csrf:
    //    ask the small no-store endpoint for a fresh one.
    const csrf = await request(PORT, 'GET', '/api/csrf');
    assert.strictEqual(csrf.status, 200);
    assert.strictEqual(csrf.headers['cache-control'], 'no-store');
    const setCookie = (csrf.headers['set-cookie'] || []).find(c => c.startsWith('kage.csrf='));
    assert.ok(setCookie, 'the endpoint must issue the kage.csrf cookie');
    const cookie = setCookie.split(';')[0];
    assert.strictEqual(csrf.json.token, cookie.split('=')[1], 'body token and cookie must agree');

    // 4. With both halves the order goes through — from a browser that never
    //    loaded an HTML page and never touched a cacheable API read.
    const placed = await request(PORT, 'POST', '/api/orders', { body: orderBody, headers: { 'X-CSRF-Token': csrf.json.token, Cookie: cookie } });
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.json));
    assert.match(String(placed.json.order_number), /^KAGE-[A-Z0-9]{8}$/);

    // 5. …and the shop can track it as a real order.
    const tracked = await request(PORT, 'GET', `/api/orders/track?number=${encodeURIComponent(placed.json.order_number)}&phone=03001234500`);
    assert.strictEqual(tracked.status, 200, JSON.stringify(tracked.json));
    assert.strictEqual(tracked.json.order_number, placed.json.order_number);
    assert.strictEqual(tracked.json.status, 'pending', 'COD orders start pending');
  });

  // ---------------------------------------------------------------
  // 1. requireAuth — cookie-session state only; reject forged raw cookies
  // ---------------------------------------------------------------
  console.log('Auth middleware:');
  await check('admin login sets a signed session cookie', async () => {
    const r = await request(PORT, 'POST', '/api/admin/setup', { body: { email: 'root@kage.test', password: 'supersecret1' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const r2 = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'root@kage.test', password: 'supersecret1' } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
    assert.ok(cookieHeader(r2).includes('kage.session='), 'expected kage.session cookie');
  });

  let adminCookie = '';
  {
    const r = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'root@kage.test', password: 'supersecret1' } });
    adminCookie = cookieHeader(r);
  }

  await check('session-varying admin responses are no-store', async () => {
    const response = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: adminCookie } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['cache-control'], 'no-store');
  });

  await check('valid admin cookie → 200', async () => {
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: adminCookie } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.admin && r.json.admin.email === 'root@kage.test');
  });

  await check('forged inline adminId payload → 401', async () => {
    const forged = Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64');
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${forged}.x` } });
    assert.strictEqual(r.status, 401);
  });

  await check('tampered payload + valid-looking sig → 401', async () => {
    const payload = Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64');
    const badSig = Buffer.from('totally-invalid-signature-bytes!!').toString('base64');
    const r = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${payload}.${badSig}` } });
    assert.strictEqual(r.status, 401);
  });

  await check('no cookie → 401', async () => {
    const r = await request(PORT, 'GET', '/api/admin/me');
    assert.strictEqual(r.status, 401);
  });

  await check('customer session on admin route → 401; customer session data is no-store', async () => {
    const csrf = await getCsrf();
    await request(PORT, 'POST', '/api/customers/signup', { body: { email: 'cust@kage.test', password: 'custpass1', name: 'Cust' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    const login = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'custpass1' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    const custCookie = cookieHeader(login);
    const adminResponse = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(adminResponse.status, 401);
    const customerResponse = await request(PORT, 'GET', '/api/customers/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(customerResponse.status, 200);
    assert.strictEqual(customerResponse.headers['cache-control'], 'no-store');

    const storedCustomer = await dbModule.prepare('SELECT id FROM customers WHERE email = ?').get('cust@kage.test');
    const payload = Buffer.from(JSON.stringify({ customerId: Number(storedCustomer.id) })).toString('base64');
    const secret = require('../utils/secret').getSessionSecret();
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    const legacyCookie = await request(PORT, 'GET', '/api/customers/me', {
      headers: { Cookie: `kage.cust=${payload}.${signature}` }
    });
    assert.deepStrictEqual(legacyCookie.json, { customer: null }, 'the removed kage.cust cookie must not authorize a customer');
  });

  // ---------------------------------------------------------------
  // 2. Admin setup gating (C1)
  // ---------------------------------------------------------------
  console.log('\nAdmin setup gate:');
  await check('setup with wrong secret email reuse → 400 (account exists)', async () => {
    const r = await request(PORT, 'POST', '/api/admin/setup', { body: { email: 'root@kage.test', password: 'whatever1' } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  });

  // ---------------------------------------------------------------
  // 3. Order PII endpoint (H1)
  // ---------------------------------------------------------------
  console.log('\nOrder endpoints:');
  let orderNumber = '';
  {
    const csrf = await getCsrf();
    const r = await request(PORT, 'POST', '/api/orders', {
      body: {
        name: 'Test Buyer', email: 'buyer@kage.test', phone: '03001234567', address: '1 Test St', city: 'Lahore',
        payment_method: 'cod',
        items: [{ id: 1, qty: 1, size: 'L' }]
      },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.shipping, 0, 'new orders do not include an unconfirmed delivery charge');
    assert.strictEqual(r.json.shipping_pending, true, 'delivery charge is marked pending');
    assert.strictEqual(r.json.total, r.json.subtotal, 'initial order total excludes the delivery charge');
    orderNumber = r.json.order_number;
  }

  await check('GET order without phone → 401', async () => {
    const r = await request(PORT, 'GET', `/api/orders/${orderNumber}`);
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check('GET order with wrong phone → 404', async () => {
    const r = await request(PORT, 'GET', `/api/orders/${orderNumber}?phone=03000000000`);
    assert.strictEqual(r.status, 404);
  });

  await check('GET order with matching phone → 200 (sanitized)', async () => {
    const r = await request(PORT, 'GET', `/api/orders/${orderNumber}?phone=03001234567`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.order_number === orderNumber);
    assert.ok(!('email' in r.json), 'email must be stripped from public payload');
    assert.ok(!('address' in r.json), 'address must be stripped from public payload');
  });

  await check('/track with matching phone → 200', async () => {
    const r = await request(PORT, 'GET', `/api/orders/track?number=${encodeURIComponent(orderNumber)}&phone=03001234567`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.order_number === orderNumber);
    assert.strictEqual(r.json.shipping_pending, true, 'tracking exposes the pending delivery charge');
  });

  // ---------------------------------------------------------------
  // Reviews: >3.5★ auto-approve · ≤3.5★ pending (author-only visibility
  // via viewer_token) → admin approval → public rating
  // ---------------------------------------------------------------
  console.log('\nReview endpoints:');
  const reviewBody = { product_id: 1, order_number: orderNumber, phone: '03001234567', rating: 5, name: 'Test Buyer', comment: 'Great fit', viewer_token: 'e2e-viewer-token-1' };
  const postReview = async (body) => {
    const csrf = await getCsrf();
    return request(PORT, 'POST', '/api/reviews', {
      body, headers: { Cookie: csrf.cookie, 'X-CSRF-Token': csrf.token }
    });
  };
  await check('review requires a delivered order and matching phone/product', async () => {
    const pending = await postReview(reviewBody);
    assert.strictEqual(pending.status, 403);
    assert.match(pending.json.error, /delivered/);
    const row = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber);
    const csrf = await getCsrf();
    const delivered = await request(PORT, 'PATCH', `/api/orders/${row.id}/status`, {
      body: { status: 'delivered' }, headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
    });
    assert.strictEqual(delivered.status, 200, JSON.stringify(delivered.json));
    assert.strictEqual((await postReview({ ...reviewBody, phone: '03000000000' })).status, 404);
    assert.strictEqual((await postReview({ ...reviewBody, product_id: 2 })).status, 403);
    assert.strictEqual((await postReview({ ...reviewBody, rating: 0 })).status, 400);
  });
  await check('review above 3.5 stars auto-approves and is public immediately', async () => {
    const created = await postReview(reviewBody);
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.strictEqual(created.json.approved, true, '5★ review must skip moderation');
    assert.strictEqual((await postReview(reviewBody)).status, 409, 'same purchase cannot review twice');
    const pub = await request(PORT, 'GET', '/api/reviews?product_id=1');
    assert.strictEqual(pub.json.length, 1, 'auto-approved review must be listed without any admin action');
    assert.strictEqual(pub.json[0].rating, 5);
    assert.strictEqual(pub.json[0].status, 'approved');
    assert.ok(!('viewer_token' in pub.json[0]), 'viewer token must never leak in public payloads');
    const product = await request(PORT, 'GET', '/api/products');
    const p = product.json.find(p => p.id === 1);
    assert.strictEqual(p.avg_rating, 5);
    assert.strictEqual(p.review_count, 1);
  });

  await check('review of 3.5 stars or less: author sees it instantly, public only after approval', async () => {
    // Second delivered order (product 2) so product 1 stock assertions hold.
    const csrf1 = await getCsrf();
    const order2 = await request(PORT, 'POST', '/api/orders', {
      body: { name: 'Second Buyer', email: 'buyer3@kage.test', phone: '03007654321', address: '2 Test St', city: 'Karachi', payment_method: 'cod', items: [{ id: 2, qty: 1, size: 'XL' }] },
      headers: { 'X-CSRF-Token': csrf1.token, Cookie: csrf1.cookie }
    });
    assert.strictEqual(order2.status, 201, JSON.stringify(order2.json));
    const row = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(order2.json.order_number);
    const csrf2 = await getCsrf();
    const delivered = await request(PORT, 'PATCH', `/api/orders/${row.id}/status`, {
      body: { status: 'delivered' }, headers: { Cookie: `${adminCookie}; ${csrf2.cookie}`, 'X-CSRF-Token': csrf2.token }
    });
    assert.strictEqual(delivered.status, 200, JSON.stringify(delivered.json));

    const low = await postReview({ product_id: 2, order_number: order2.json.order_number, phone: '03007654321', rating: 3, name: 'Second Buyer', comment: 'Fabric is okay', viewer_token: 'e2e-viewer-token-2' });
    assert.strictEqual(low.status, 201, JSON.stringify(low.json));
    assert.strictEqual(low.json.approved, false, '3★ review must not auto-approve');
    assert.strictEqual(low.json.viewer_token, 'e2e-viewer-token-2', 'server keeps the submitted viewer token');

    // Invisible to the public and to any other browser's token; anonymous
    // responses remain publicly cacheable because they contain no private data.
    const publicReviews = await request(PORT, 'GET', '/api/reviews?product_id=2');
    assert.deepStrictEqual(publicReviews.json, []);
    assert.strictEqual(publicReviews.headers['cache-control'], 'public, max-age=120, s-maxage=120');
    assert.deepStrictEqual((await request(PORT, 'GET', '/api/reviews?product_id=2&viewer_token=someone-elses-token')).json, []);
    // The header token is the primary path; the query parameter remains a
    // temporary compatibility path for older storefront clients.
    const mine = await request(PORT, 'GET', '/api/reviews?product_id=2', {
      headers: { 'X-Viewer-Token': 'e2e-viewer-token-2' }
    });
    assert.strictEqual(mine.json.length, 1, 'author must see their own pending review immediately');
    assert.strictEqual(mine.headers['cache-control'], 'private', 'token-scoped responses must never be shared-cacheable');
    const legacyMine = await request(PORT, 'GET', '/api/reviews?product_id=2&viewer_token=e2e-viewer-token-2');
    assert.strictEqual(legacyMine.json.length, 1, 'legacy query tokens remain accepted during the transition');
    assert.strictEqual(legacyMine.headers['cache-control'], 'private', 'legacy token responses must not be shared-cacheable');
    assert.strictEqual(mine.json[0].status, 'pending');
    assert.strictEqual(mine.json[0].is_own, true);
    assert.strictEqual(mine.json[0].rating, 3);
    assert.ok(!('viewer_token' in mine.json[0]), 'viewer token must never leak in public payloads');

    // Pending reviews stay out of the product rating.
    const product = await request(PORT, 'GET', '/api/products');
    assert.strictEqual(product.json.find(p => p.id === 2).review_count, 0);

    // Admin approval publishes it for everyone.
    const all = await request(PORT, 'GET', '/api/reviews/all', { headers: { Cookie: adminCookie } });
    const rv = all.json.find(r => r.order_number === order2.json.order_number && r.product_id === 2);
    assert.strictEqual(rv.status, 'pending');
    const csrf3 = await getCsrf();
    const approved = await request(PORT, 'PATCH', `/api/reviews/${rv.id}`, { body: { status: 'approved' }, headers: { Cookie: `${adminCookie}; ${csrf3.cookie}`, 'X-CSRF-Token': csrf3.token } });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.json));
    const pub = await request(PORT, 'GET', '/api/reviews?product_id=2');
    assert.strictEqual(pub.json.length, 1);
    assert.strictEqual(pub.json[0].rating, 3);
    assert.strictEqual(pub.json[0].status, 'approved');
    const product2 = await request(PORT, 'GET', '/api/products');
    const p2 = product2.json.find(p => p.id === 2);
    assert.strictEqual(p2.avg_rating, 3);
    assert.strictEqual(p2.review_count, 1);
  });

  // ---------------------------------------------------------------
  // 4. Order placement decrements stock atomically (M2)
  // ---------------------------------------------------------------
  console.log('\nStock decrement:');
  await check('stock decremented after order', async () => {
    const p = await request(PORT, 'GET', '/api/products/1');
    assert.strictEqual(p.status, 200);
    // Seed product #1 (Shadow Fit) starts at stock 4; one was ordered above.
    assert.strictEqual(Number(p.json.stock_qty), 3, `expected 3, got ${p.json.stock_qty}`);
  });

  await check('order exceeding stock → 400', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'POST', '/api/orders', {
      body: {
        name: 'Test Buyer', email: 'buyer2@kage.test', phone: '03001234568', address: '1 Test St', city: 'Lahore',
        payment_method: 'cod',
        items: [{ id: 1, qty: 99, size: 'L' }]
      },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(r.status, 400);
    assert.ok(/stock/i.test(r.json.error), 'error should mention stock');
  });

  // ---------------------------------------------------------------
  // 5. CSRF on admin mutations (invariant)
  // ---------------------------------------------------------------
  console.log('\nCSRF:');
  await check('admin status update without CSRF → 403', async () => {
    const r = await request(PORT, 'PATCH', '/api/orders/1/status', { body: { status: 'confirmed' }, headers: { Cookie: adminCookie } });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  // ---------------------------------------------------------------
  // 6. FE-C2 — customer account endpoints (GET/PUT /api/customers/me)
  // ---------------------------------------------------------------
  console.log('\nCustomer account (FE-C2):');
  let custCookie = '';
  {
    const csrf = await getCsrf();
    const login = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'custpass1' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.json));
    custCookie = cookieHeader(login);
  }

  await check('GET /api/customers/me without session → empty success without console-error status', async () => {
    const r = await request(PORT, 'GET', '/api/customers/me');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { customer: null });
  });

  await check('GET /api/customers/me with session → customer object, no password_hash', async () => {
    const r = await request(PORT, 'GET', '/api/customers/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.customer && r.json.customer.email === 'cust@kage.test');
    assert.ok(!('password_hash' in r.json.customer), 'password_hash must not leak');
  });

  await check('PUT /api/customers/me profile update → persists', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PUT', '/api/customers/me', {
      body: { name: 'Renamed Cust', phone: '03005559999', address: '2 New St', city: 'Karachi' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: custCookie + '; ' + csrf.cookie }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.customer.name, 'Renamed Cust');
    const me = await request(PORT, 'GET', '/api/customers/me', { headers: { Cookie: custCookie } });
    assert.strictEqual(me.json.customer.city, 'Karachi', 'update must persist');
  });

  await check('PUT password change with wrong current password → 401', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PUT', '/api/customers/me', {
      body: { currentPassword: 'wrongpass', newPassword: 'newpass456' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: custCookie + '; ' + csrf.cookie }
    });
    assert.strictEqual(r.status, 401);
    assert.ok(/incorrect/i.test(r.json.error), 'must reject the current-password check, not the session');
  });

  await check('PUT password change → old login fails, new login works', async () => {
    const csrf = await getCsrf();
    const r = await request(PORT, 'PUT', '/api/customers/me', {
      body: { currentPassword: 'custpass1', newPassword: 'newpass456' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: custCookie + '; ' + csrf.cookie }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const oldLogin = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'custpass1' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    assert.strictEqual(oldLogin.status, 401, 'old password must stop working');
    const newLogin = await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'newpass456' }, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie } });
    assert.strictEqual(newLogin.status, 200, 'new password must work');
  });

  // ---------------------------------------------------------------
  // 7. FE-C4 — password reset flow + page shell
  // ---------------------------------------------------------------
  console.log('\nPassword reset (FE-C4):');
  await check('POST /api/auth/reset-password with bogus token → 400', async () => {
    const r = await request(PORT, 'POST', '/api/auth/reset-password', { body: { token: 'deadbeef', password: 'whatever1' } });
    assert.strictEqual(r.status, 400);
  });

  await check('GET /reset-password serves the SPA shell with the reset view', async () => {
    const r = await request(PORT, 'GET', '/reset-password?token=abc&type=customer');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('page-reset'), 'shell must contain the reset view');
    assert.ok((await asset(PORT, '/storefront.js')).includes('initPasswordReset'), 'the JS bundle must contain the reset code');
  });

  // ---------------------------------------------------------------
  // 8. FE-C3 — self-hosted Chart.js must be served
  // ---------------------------------------------------------------
  console.log('\nVendor assets (FE-C3):');
  await check('GET /vendor/chart.umd.min.js → 200 javascript', async () => {
    const r = await request(PORT, 'GET', '/vendor/chart.umd.min.js');
    assert.strictEqual(r.status, 200);
    assert.ok(/javascript|ecmascript/i.test(r.headers['content-type'] || ''), `unexpected content-type: ${r.headers['content-type']}`);
  });

  await check('admin.html references the self-hosted chart, not the CDN', async () => {
    const r = await request(PORT, 'GET', '/admin');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes('cdn.jsdelivr.net/npm/chart.js'), 'CDN reference must be gone');
    assert.ok(r.text.includes('/vendor/chart.umd.min.js'), 'self-hosted script must be referenced');
  });

  // ---------------------------------------------------------------
  // 9. FE-C1 — product cards route through openProductDetail
  // ---------------------------------------------------------------
  console.log('\nCard wiring (FE-C1):');
  await check('the shared product-card renderer uses openProductDetail, not navigateTo', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes("onclick=\"navigateTo('product', "), 'stale navigateTo(product) wiring must be gone');
    const storeJs = await asset(PORT, '/storefront.js');
    assert.ok(storeJs.includes('data-action="open-product" data-pid="${p.id}"'), 'cards carry the delegated open-product action');
    assert.ok(storeJs.includes("'open-product': (el) => openProductDetail(Number(el.dataset.pid))"), 'the action table routes to openProductDetail');
  });

  // ---------------------------------------------------------------
  // FE-H2 — delegated events: zero inline handlers, CSP forbids them
  // ---------------------------------------------------------------
  console.log('\nDelegated events (FE-H2):');
  await check('served pages carry zero inline event handlers', async () => {
    for (const path of ['/', '/admin']) {
      const r = await request(PORT, 'GET', path);
      assert.strictEqual(r.status, 200, path);
      // Whitespace-prefixed so meta content="..." never matches.
      const hits = r.text.match(/\son[a-z]+="[^"]{0,40}/g) || [];
      assert.deepStrictEqual(hits, [], `${path} must have no on*= attributes, found: ${hits.slice(0, 3).join(' | ')}`);
    }
  });

  await check("CSP forbids inline scripts and handlers; only same-origin bundles run", async () => {
    for (const path of ['/', '/admin']) {
      const r = await request(PORT, 'GET', path);
      assert.strictEqual(r.status, 200, path);
      const csp = r.headers['content-security-policy'] || '';
      const scriptSrc = /script-src[^;]*/.exec(csp)?.[0] || '';
      assert.equal(scriptSrc, "script-src 'self'", `${path}: scripts load only from same-origin bundles, got: ${scriptSrc}`);
      assert.match(csp, /script-src-attr 'none'/, 'injected inline handlers cannot execute');
    }
  });

  // ---------------------------------------------------------------
  // PERF-1 — split bundles: hashed, immutable, shell stays small
  // ---------------------------------------------------------------
  console.log('\nSplit bundles (PERF-1):');
  await check('pages reference hashed CSS/JS bundles and stay small', async () => {
    const pages = { '/': ['storefront.css', 'storefront.js'], '/admin': ['admin.css', 'admin.js'] };
    for (const [path, bundles] of Object.entries(pages)) {
      const r = await request(PORT, 'GET', path);
      assert.strictEqual(r.status, 200, path);
      assert.ok(Buffer.byteLength(r.text, 'utf8') < 120000, `${path} shell must stay under 120KB, got ${Buffer.byteLength(r.text, 'utf8')}`);
      assert.ok(!r.text.includes('__STORE_') && !r.text.includes('__ADMIN_'), `${path} must substitute every asset hash token`);
      for (const bundle of bundles) {
        const m = new RegExp(`/${bundle}\\?v=([0-9a-f]{10})`).exec(r.text);
        assert.ok(m, `${path} must reference /${bundle} with a 10-hex content hash`);
      }
    }
  });

  await check('hashed bundles are immutable for a year, unhashed revalidate daily', async () => {
    for (const bundle of ['/storefront.css', '/storefront.js', '/admin.css', '/admin.js']) {
      const bare = await request(PORT, 'GET', bundle);
      assert.strictEqual(bare.status, 200, bundle);
      assert.strictEqual(bare.headers['cache-control'], 'public, max-age=86400, must-revalidate', `${bundle} without a hash revalidates daily`);
      const hashed = await request(PORT, 'GET', `${bundle}?v=0123456789`);
      assert.strictEqual(hashed.status, 200, bundle);
      assert.strictEqual(hashed.headers['cache-control'], 'public, max-age=31536000, immutable', `${bundle}?v= is immutable`);
      assert.strictEqual(hashed.text, bare.text, 'the hash only affects caching, never the bytes');
    }
  });

  await check('collection grid and Best Sellers share ONE card template (no second renderer, no Add to Cart card)', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(/<div class="product-grid collection-grid" id="collectionGrid"><\/div>/.test(r.text),
      '#collectionGrid is a .product-grid, so it picks up the Best Sellers card CSS');
    const storeJs = await asset(PORT, '/storefront.js');
    assert.strictEqual((storeJs.match(/<div class="product-card"/g) || []).length, 1, 'exactly one product-card template may exist');
    assert.strictEqual((storeJs.match(/function renderProductCard\(/g) || []).length, 1, 'exactly one card renderer may exist');
    assert.ok(/pageItems\.map\(renderProductCard\)/.test(storeJs), 'renderCollectionGrid renders through renderProductCard');
    assert.ok(/sorted\.map\(renderProductCard\)/.test(storeJs), 'Best Sellers renders through renderProductCard');
    assert.ok(!storeJs.includes('class="quick-add"') && !storeJs.includes('class="wishlist-icon ${'),
      'the old collection-only card markup (Add to Cart / wishlist-icon) is gone');
  });

  // ---------------------------------------------------------------
  // 10. Header nav search — must stay centred and clear of the nav icons
  // A second `.nav-search` rule (equal specificity, declared later) once
  // overrode `position: absolute` back to `relative`, so the centred
  // `left: 50%` + `translateX(-50%)` pair shifted the field ~370px right
  // and it rendered on top of the right-hand icons.
  // ---------------------------------------------------------------
  console.log('\nNav search layout:');
  await check('single .nav-search positioning rule, centred + width-guarded', async () => {
    const storeCss = await asset(PORT, '/storefront.css');
    const positional = (storeCss.match(/\.nav-search\s*\{[^}]*\}/g) || [])
      .filter((rule) => /position\s*:/.test(rule));
    assert.strictEqual(positional.length, 1, `expected one .nav-search positioning rule, found ${positional.length}`);
    const rule = positional[0];
    assert.ok(/position:\s*absolute/.test(rule), 'field must be out of flow or it pushes over the icons');
    assert.ok(/left:\s*50%/.test(rule), 'field must be horizontally centred');
    assert.ok(/translate\(\s*-50%/.test(rule), 'centring needs the matching translate(-50%)');
    assert.ok(/min\(320px,\s*calc\(100%\s*-\s*520px\)\)/.test(rule), 'field must shrink so it never reaches the icon cluster');
  });

  // ---------------------------------------------------------------
  // 11. Wishlist hearts — product cards must reuse the navbar's icon
  // The cards rendered text glyphs (♡ / &#9825; / &#9829;) that look different
  // per platform and never matched the navbar, and the homepage card called
  // toggleWishlist() without its element, so the heart kept its old state
  // until the section re-rendered.
  // ---------------------------------------------------------------
  console.log('\nWishlist hearts:');
  await check('card hearts reuse the navbar SVG, fill when saved, pass their element', async () => {
    const r = await request(PORT, 'GET', '/');
    assert.strictEqual(r.status, 200);
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const svgAfter = (marker) => {
      const start = r.text.indexOf('<svg', r.text.indexOf(marker));
      return norm(r.text.slice(start, r.text.indexOf('</svg>', start) + 6));
    };
    const storeJs = await asset(PORT, '/storefront.js');
    const storeCss = await asset(PORT, '/storefront.css');
    const constant = storeJs.match(/const HEART_SVG = .(<svg[\s\S]*?<\/svg>).;/);
    assert.ok(constant, 'HEART_SVG constant must be defined');
    assert.strictEqual(norm(constant[1]), svgAfter('id="wishlistNav"'), 'card heart must match the navbar icon exactly');
    assert.ok((storeJs.match(/\$\{HEART_SVG\}/g) || []).length >= 1, 'the shared card renderer must use HEART_SVG');
    assert.ok(!storeJs.includes('&#9825;') && !storeJs.includes('&#9829;'), 'text-glyph hearts must be gone');
    assert.ok(!/toggleWishlist\(\$\{p\.id\}\)"/.test(storeJs), 'card buttons must pass their element so the heart updates on click');
    assert.ok(/\.wishlist-icon\.active svg,/.test(storeCss) && /\.product-wishlist\.active svg \{ fill: currentColor/.test(storeCss), 'saved items must fill the heart');
  });

  // 12. Heart pop animation — saving a product pops the heart once.
  // The keyframe must animate the SVG (not the round button background) and
  // must be gated behind the .pop class so grid re-renders never re-pop.
  // ---------------------------------------------------------------
  console.log('\nHeart pop animation:');
  await check('heart-pop keyframe on svg, .pop-gated, added only when saving', async () => {
    const storeJs = await asset(PORT, '/storefront.js');
    const storeCss = await asset(PORT, '/storefront.css');
    assert.ok(/@keyframes heart-pop[\s\S]*?\.wishlist-icon\.pop svg,\s*\.product-wishlist\.pop svg\s*\{\s*animation:\s*heart-pop/.test(storeCss),
      'keyframe must animate the svg via .pop, not the button');
    const fn = storeJs.match(/function toggleWishlist\([\s\S]*?\n    \}/);
    assert.ok(fn, 'toggleWishlist must be defined');
    assert.ok(/classList\.add\('pop'\)/.test(fn[0]) && /classList\.remove\('pop'\)/.test(fn[0]),
      'toggleWishlist must toggle the .pop class');
    const popIdx = fn[0].indexOf("add('pop')");
    const savedIdx = fn[0].indexOf('if (saved)');
    assert.ok(savedIdx !== -1 && popIdx > savedIdx && popIdx < fn[0].indexOf('} else {'),
      'pop must fire only when saving, not when unsaving');
  });

  // 13. Track-your-order page — the customer-facing bugs fixed here:
  // (a) the submit button was never re-enabled after a failed lookup,
  // (b) cancelled orders rendered an active "Pending" timeline,
  // (c) awaiting_verification (JazzCash/bank) looked identical to pending.
  // ---------------------------------------------------------------
  console.log('\nTrack order page:');
  await check('trackOrder re-enables button + cancelled/awaiting_verification handled', async () => {
    const storeJs = await asset(PORT, '/storefront.js');
    const track = storeJs.match(/async function trackOrder\([\s\S]*?\n    \}/);
    assert.ok(track, 'trackOrder must be defined');
    assert.ok(/finally\s*\{[\s\S]*?btn\.disabled\s*=\s*false/.test(track[0]),
      'submit button must be re-enabled in finally (no dead button after an error)');
    const render = storeJs.match(/function renderTracking\([\s\S]*?\n    \}/);
    assert.ok(render, 'renderTracking must be defined');
    assert.ok(/status === 'cancelled'/.test(render[0]) && /track-status-cancelled/.test(storeJs),
      'cancelled orders must render the terminal state, not a live timeline');
    assert.ok(/awaiting_verification.*\? 1 :/.test(render[0]),
      'awaiting_verification must map to the confirmed step, not clamp to pending');
    assert.ok(/TRACK_STATUS_LABELS/.test(storeJs) && /formatTrackDate/.test(storeJs),
      'statuses must be humanized and the placed date formatted');
  });

  // ---------------------------------------------------------------
  // Responsive layout guards (2026-09-25 session)
  // (a) track timeline overflowed 4-across on phones,
  // (b) admin product/order rows assumed a ~700px column grid,
  // (c) admin disabled pinch-zoom (user-scalable=no).
  // ---------------------------------------------------------------
  console.log('\nResponsive layout guards:');
  await check('storefront ≤540px + ≤360px blocks present, checkout stacks', async () => {
    const storeCss = await asset(PORT, '/storefront.css');
    assert.ok(/@media \(max-width: 540px\)[\s\S]*?\.track-timeline \{\s*flex-direction: column/.test(storeCss),
      'track timeline must stack vertically on phones (4 labels across overflow)');
    assert.ok(/\.nav-links li \{\s*min-height: 0;/.test(storeCss) && /\.nav-links li:has\(\.nav-icon\) \{\s*min-height: 44px;/.test(storeCss),
      'nav dropdown rows must not inherit the 44px min-height as full-width rows');
    assert.ok(/@media \(max-width: 360px\)[\s\S]*?\.nav-inner \{\s*flex-wrap: wrap/.test(storeCss),
      'header must wrap instead of overflowing on ultra-narrow phones');
    assert.ok(/\.co-row \{\s*grid-template-columns: 1fr;\s*\}/.test(storeCss),
      'checkout form rows must collapse to one column on phones');
  });

  await check('admin ≤768px wrap-cards, legend hidden, no zoom lock', async () => {
    const r = await request(PORT, 'GET', '/admin');
    assert.strictEqual(r.status, 200);
    const adminCss = await asset(PORT, '/admin.css');
    // The media block now includes top-bar/main-wrapper fixes BEFORE product-row
    assert.ok(/@media\(max-width:768px\)[\s\S]*?\.product-row\{display:flex;flex-wrap:wrap/.test(adminCss),
      'admin product/order rows must become wrap cards on phones');
    assert.ok(/\.product-row\.header-row\{display:none;\}/.test(adminCss),
      'admin column-label legend must hide once rows wrap');
    assert.ok(/\.pnl-summary\{grid-template-columns:1fr;\}/.test(adminCss),
      'PnL summary must go single-column on phones');
    assert.ok(!r.text.includes('user-scalable=no'),
      'admin must not disable pinch-zoom (accessibility)');
  });

  // The admin tables used to be visually jumbled at every width: products,
  // orders and recent-orders all shared one `auto`-terminated grid template,
  // so the legend/columns resolved to different widths (labels sat ~45px off
  // the data they name), orders crushed six columns into the products
  // template, and the products table overflowed the page between 901-1024px.
  await check('admin tables keep one column template per table and collapse safely', async () => {
    const adminCss = await asset(PORT, '/admin.css');
    // Every track must be fixed or minmax-bounded: a trailing `auto` track
    // sized the legend's "Actions" (≈56px) and the row buttons (≈108px)
    // differently, which made the shared 1fr name track differ between them.
    const products = /#tab-products \.product-row \{ grid-template-columns:[^}]+\}/.exec(adminCss);
    assert.ok(products, 'the products table must own its column template');
    assert.match(products[0], / 108px; \}$/,
      'products legend/actions track must be a fixed width, never auto');
    // Orders (six columns) and recent orders (five) must not inherit the
    // seven-column products template.
    assert.match(adminCss, /#tab-orders \.product-row \{ grid-template-columns:minmax\(0, max-content\)/,
      'order rows must define their own six-column template');
    assert.match(adminCss, /\.recent-orders \.product-row \{ grid-template-columns:/,
      'dashboard recent-order rows must define their own five-column template');
    // Wrap-card tiers. Orders' status menus are position:absolute, so those
    // rows wrap at 1060px rather than living inside an overflow container.
    assert.ok(/@media\(max-width:1060px\)[\s\S]*?#tab-orders \.product-row[\s\S]*?display:flex;flex-wrap:wrap/.test(adminCss),
      'order rows must become wrap cards before their columns collide');
    assert.ok(/#tab-orders \.product-row\.header-row[\s\S]*?display:none;/.test(adminCss),
      'the orders legend must hide at the wrap-card breakpoint (id-scoped, so it outranks the flex rule)');
    assert.ok(/@media\(max-width:900px\)[\s\S]*?\.product-row\{display:flex;flex-wrap:wrap/.test(adminCss),
      'the products table must become wrap cards before its columns collide');
    // Only the products list may scroll sideways — anything inside the orders
    // rows would be clipped by such a container.
    assert.ok(/#tab-products \.product-list \{ overflow-x:auto; \}/.test(adminCss),
      'the products table gets its own horizontal scroll at tablet widths');
    assert.ok(!/#tab-orders[^{]*\.product-list[^{]*\{[^}]*overflow-x/.test(adminCss),
      'the orders list must never become a scroll container');
  });

  // The favicon set is easy to break silently: a wrong href is a 404 the page
  // never surfaces, and a mismatch between the declared `sizes` and the actual
  // image makes browsers pick the wrong frame. Check both pages + the manifest.
  await check('favicon set resolves with the declared formats and sizes', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const pngDims = (buf) => {
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'icon must be a real PNG');
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    };
    const icoSizes = (buf) => {
      assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field');
      assert.equal(buf.readUInt16LE(2), 1, 'ICO type must be 1 (icon)');
      const count = buf.readUInt16LE(4);
      return Array.from({ length: count }, (_, i) => {
        const w = buf.readUInt8(6 + i * 16) || 256;
        const h = buf.readUInt8(7 + i * 16) || 256;
        return `${w}x${h}`;
      });
    };

    for (const path of ['/', '/admin']) {
      const html = (await request(PORT, 'GET', path)).text;
      if (path === '/') {
        assert.match(html, /name="msapplication-TileImage" content="\/images\/icon-192-v\d+\.png"/,
          'the Windows tile icon must use the versioned artwork URL');
        assert.match(html, /"logo": "https?:\/\/[^\"]+\/images\/icon-512-v\d+\.png"/,
          'the structured-data logo must use the versioned artwork URL');
      }
      const tags = [...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*>/g)].map((m) => m[0]);
      assert.ok(tags.length >= 3, `${path} must declare its favicon set (found ${tags.length})`);
      for (const tag of tags) {
        const href = /href="([^"]+)"/.exec(tag)[1];
        // Both pages share one icon set at the web root (the admin page used to
        // point at its own copies under /images, which then drifted).
        assert.ok(!/^\/images\/(favicon|apple-touch)/.test(href),
          `${path} must not point at per-page icon duplicates (${href})`);
        assert.match(new URL(href, base).pathname, /-v\d+\.(?:ico|png)$/,
          `${path} must use the versioned icon URL so browsers do not keep the old artwork (${href})`);
        const res = await fetch(base + href);
        assert.equal(res.status, 200, `${path} declares ${href}, which must be served`);
        const buf = Buffer.from(await res.arrayBuffer());
        const declared = /sizes="(\d+)x(\d+)"/.exec(tag);
        if (href.endsWith('.ico')) {
          assert.deepEqual(icoSizes(buf), ['16x16', '32x32', '48x48'],
            'the .ico must carry 16, 32 and 48 pixel frames — browsers pick per DPI');
          assert.equal(res.headers.get('content-type'), 'image/x-icon');
        } else if (declared) {
          assert.equal(pngDims(buf), `${declared[1]}x${declared[2]}`, `${href} must match its declared sizes`);
          assert.match(res.headers.get('content-type') || '', /^image\/png/);
        } else {  // apple-touch-icon (180x180 by convention)
          assert.equal(pngDims(buf), '180x180', `${href} must be a 180x180 touch icon`);
        }
      }
    }

    const legacy = await fetch(base + '/favicon.ico', { redirect: 'manual' });
    assert.equal(legacy.status, 301, 'implicit browser favicon requests must redirect');
    assert.equal(legacy.headers.get('location'), '/favicon-v2.ico');
    const redirected = await fetch(base + '/favicon.ico');
    const versioned = await fetch(base + '/favicon-v2.ico');
    assert.equal(redirected.status, 200);
    assert.equal(redirected.headers.get('content-type'), 'image/x-icon');
    assert.deepEqual(Buffer.from(await redirected.arrayBuffer()), Buffer.from(await versioned.arrayBuffer()));
    assert.equal((await fetch(base + '/favicon-48x48.png')).status, 404);
    const { existsSync } = require('node:fs');
    assert.equal(existsSync(require('node:path').join(__dirname, '../public/favicon.ico')), false);
    assert.equal(existsSync(require('node:path').join(__dirname, '../public/favicon-48x48.png')), false);

    // Same set for the installable app icons the manifest advertises.
    const manifest = JSON.parse((await request(PORT, 'GET', '/manifest.json')).text);
    assert.ok(manifest.icons.length >= 2, 'the manifest must advertise app icons');
    for (const icon of manifest.icons) {
      assert.match(new URL(icon.src, base).pathname, /-v\d+\.png$/,
        `manifest icon ${icon.src} must use a versioned URL so installed apps refresh their artwork`);
      const res = await fetch(base + icon.src);
      assert.equal(res.status, 200, `manifest icon ${icon.src} must be served`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(pngDims(buf), icon.sizes, `manifest icon ${icon.src} must actually be ${icon.sizes}`);
    }
  });

  // Frontend/API contract: stock and sale editing must agree with checkout.
  console.log('\nCatalog contract:');
  await check('SVG uploads are rejected by product and standalone upload filters', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    process.env.VERCEL = '1'; // if a broken filter accepts SVG, Blob config stops it before persistence
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN;
    try {
      const csrf = await getCsrf();
      const headers = { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token };
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      const productForm = new FormData();
      productForm.append('front_image', new Blob([svg], { type: 'image/svg+xml' }), 'unsafe.svg');
      const productResponse = await fetch(`http://127.0.0.1:${PORT}/api/products`, { method: 'POST', headers, body: productForm });
      const productBody = await productResponse.json();
      assert.strictEqual(productResponse.status, 400, JSON.stringify(productBody));
      assert.match(productBody.error || '', /Only image files/i);

      const uploadForm = new FormData();
      uploadForm.append('image', new Blob([svg], { type: 'image/svg+xml' }), 'unsafe.svg');
      const uploadResponse = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: 'POST', headers, body: uploadForm });
      const uploadBody = await uploadResponse.json();
      assert.strictEqual(uploadResponse.status, 400, JSON.stringify(uploadBody));
      assert.match(uploadBody.error || '', /Only image files/i);
    } finally {
      if (oldVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = oldVercel;
      if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
      if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
      else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
    }
  });

  await check('admin file pickers exclude SVG and wildcard image types', async () => {
    const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    const accepts = [...adminHtml.matchAll(/<input\b[^>]*type="file"[^>]*accept="([^"]+)"/gi)].map(match => match[1]);
    assert.ok(accepts.length >= 3, 'all product image pickers should declare their accepted types');
    assert.ok(accepts.every(value => !value.includes('*') && !/svg/i.test(value)), JSON.stringify(accepts));
  });

  await check('admin can create a product with an image, unit cost and stock', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    delete process.env.VERCEL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN; // exercise local upload storage deterministically
    let productId = null;
    try {
      const csrf = await getCsrf();
      const form = new FormData();
      form.append('name', 'Regression Product');
      form.append('category', 'pants');
      form.append('fit', 'Relaxed');
      form.append('price', '299');
      form.append('description', 'Create-product regression test');
      form.append('sizes', JSON.stringify(['One Size']));
      form.append('unit_cost', '80');
      form.append('stock_qty', '2');
      form.append('front_image', new Blob([Buffer.from('test-webp-image')], { type: 'image/webp' }), 'regression.webp');
      const response = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
        method: 'POST',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: form
      });
      const product = await response.json();
      assert.strictEqual(response.status, 201, JSON.stringify(product));
      productId = product.id;
      assert.strictEqual(product.name, 'Regression Product');
      assert.strictEqual(product.category, 'pants');
      assert.strictEqual(Number(product.unit_cost), 80);
      assert.strictEqual(Number(product.stock_qty), 2);
      assert.ok(product.front_image && product.front_image.startsWith('/uploads/'), 'image must be persisted');
    } finally {
      try {
        if (productId != null) {
          const csrf = await getCsrf();
          const removed = await request(PORT, 'DELETE', `/api/products/${productId}`, {
            headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
          });
          assert.strictEqual(removed.status, 200, JSON.stringify(removed.json));
        }
      } finally {
        if (oldVercel === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = oldVercel;
        if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
        else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
        if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
        else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
      }
    }
  });

  await check('product create accepts front + back + multiple extra images', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    delete process.env.VERCEL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN; // exercise local upload storage deterministically
    let productId = null;
    try {
      const csrf = await getCsrf();
      const form = new FormData();
      form.append('name', 'Gallery Regression Product');
      form.append('category', 'anime');
      form.append('price', '499');
      form.append('sizes', JSON.stringify(['L']));
      form.append('front_image', new Blob([Buffer.from('front-webp-data')], { type: 'image/webp' }), 'front.webp');
      // The admin panel sends the back image WITH a filename; a nameless
      // blob arrives as filename="blob" and must not pass the image filter
      // (see the next check).
      form.append('back_image', new Blob([Buffer.from('back-webp-data')], { type: 'image/webp' }), 'back.webp');
      form.append('extra_images', new Blob([Buffer.from('extra-1-data')], { type: 'image/webp' }), 'extra-1.webp');
      form.append('extra_images', new Blob([Buffer.from('extra-2-data')], { type: 'image/webp' }), 'extra-2.webp');
      const response = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
        method: 'POST',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: form
      });
      const product = await response.json();
      assert.strictEqual(response.status, 201, JSON.stringify(product));
      productId = product.id;
      assert.ok(product.front_image && product.front_image.startsWith('/uploads/'), 'front image must be persisted');
      assert.ok(product.back_image && product.back_image.startsWith('/uploads/'), 'back image must be persisted');
      assert.strictEqual(product.extra_images.length, 2, 'both extra images must be persisted');
      assert.ok(product.extra_images.every(u => u.startsWith('/uploads/')), 'extra images must be persisted');
      // Read it back fresh (survives a reload) — the record stores the URL.
      const reread = await request(PORT, 'GET', `/api/products/${productId}`);
      assert.strictEqual(reread.status, 200, JSON.stringify(reread.json));
      assert.strictEqual(reread.json.back_image, product.back_image, 'back image URL is stored on the product record');
      const frontFile = path.join(__dirname, '..', product.back_image);
      assert.ok(fs.existsSync(frontFile), 'back image file exists in storage');
    } finally {
      try {
        if (productId != null) {
          const csrf = await getCsrf();
          await request(PORT, 'DELETE', `/api/products/${productId}`, {
            headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
          });
        }
      } finally {
        if (oldVercel === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = oldVercel;
        if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
        else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
        if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
        else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
      }
    }
  });

  await check('nameless image uploads are rejected (back-image filename regression)', async () => {
    const csrf = await getCsrf();
    const form = new FormData();
    form.append('name', 'Nameless Back Image');
    form.append('category', 'anime');
    form.append('price', '499');
    form.append('sizes', JSON.stringify(['L']));
    form.append('front_image', new Blob([Buffer.from('front-webp-data')], { type: 'image/webp' }), 'front.webp');
    // No filename: the multipart serializer defaults it to "blob", which has
    // no image extension — the filter must reject it (and therefore the whole
    // save), which is why the admin panel names every uploaded blob.
    form.append('back_image', new Blob([Buffer.from('back-webp-data')], { type: 'image/webp' }));
    const response = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
      method: 'POST',
      headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
      body: form
    });
    const body = await response.json().catch(() => ({}));
    assert.strictEqual(response.status, 400, JSON.stringify(body));
    assert.match(body.error || '', /image files/i);
  });

  await check('product update appends new extra images and removes listed ones', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    delete process.env.VERCEL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN;
    let productId = null;
    try {
      let csrf = await getCsrf();
      const create = new FormData();
      create.append('name', 'Extra Removal Regression');
      create.append('category', 'anime');
      create.append('price', '399');
      create.append('sizes', JSON.stringify(['L']));
      create.append('front_image', new Blob([Buffer.from('front-data')], { type: 'image/webp' }), 'front.webp');
      create.append('extra_images', new Blob([Buffer.from('old-extra-data')], { type: 'image/webp' }), 'old-extra.webp');
      const created = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
        method: 'POST',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: create
      });
      const product = await created.json();
      assert.strictEqual(created.status, 201, JSON.stringify(product));
      productId = product.id;
      const oldExtraUrl = product.extra_images[0];
      assert.ok(oldExtraUrl, 'created product must have the extra image');

      // Remove the existing extra, add two new ones and a back image in the
      // same save (Edit Product must persist the back image too).
      csrf = await getCsrf();
      const update = new FormData();
      update.append('name', 'Extra Removal Regression');
      update.append('remove_extra', JSON.stringify([oldExtraUrl]));
      update.append('back_image', new Blob([Buffer.from('edit-back-data')], { type: 'image/webp' }), 'edit-back.webp');
      update.append('extra_images', new Blob([Buffer.from('new-extra-1')], { type: 'image/webp' }), 'new-extra-1.webp');
      update.append('extra_images', new Blob([Buffer.from('new-extra-2')], { type: 'image/webp' }), 'new-extra-2.webp');
      const updated = await fetch(`http://127.0.0.1:${PORT}/api/products/${productId}`, {
        method: 'PUT',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: update
      });
      const after = await updated.json();
      assert.strictEqual(updated.status, 200, JSON.stringify(after));
      assert.ok(after.back_image && after.back_image.startsWith('/uploads/'), 'edited back image must be persisted');
      assert.ok(!after.extra_images.includes(oldExtraUrl), 'removed extra image must be gone from the product');
      assert.strictEqual(after.extra_images.length, 2, 'the two new extra images must be stored');
      assert.ok(!fs.existsSync(path.join(__dirname, '..', oldExtraUrl)), 'removed extra image file must be deleted from storage');

      // The gallery cap: pushing the total over MAX_EXTRA_IMAGES is rejected.
      csrf = await getCsrf();
      const overflow = new FormData();
      overflow.append('name', 'Extra Removal Regression');
      for (let i = 0; i < 4; i++) overflow.append('extra_images', new Blob([Buffer.from('overflow-' + i)], { type: 'image/webp' }), `overflow-${i}.webp`);
      const rejected = await fetch(`http://127.0.0.1:${PORT}/api/products/${productId}`, {
        method: 'PUT',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: overflow
      });
      const rejectedBody = await rejected.json().catch(() => ({}));
      assert.strictEqual(rejected.status, 400, JSON.stringify(rejectedBody));
      assert.match(rejectedBody.error || '', /extra photos/i);

      // remove_extra must be a JSON array of URL strings.
      csrf = await getCsrf();
      const badRemove = new FormData();
      badRemove.append('name', 'Extra Removal Regression');
      badRemove.append('remove_extra', 'not-json');
      const bad = await fetch(`http://127.0.0.1:${PORT}/api/products/${productId}`, {
        method: 'PUT',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: badRemove
      });
      assert.strictEqual(bad.status, 400);
    } finally {
      try {
        if (productId != null) {
          const csrf = await getCsrf();
          await request(PORT, 'DELETE', `/api/products/${productId}`, {
            headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
          });
        }
      } finally {
        if (oldVercel === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = oldVercel;
        if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
        else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
        if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
        else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
      }
    }
  });

  await check('batch product delete is authenticated, CSRF-protected and removes selected rows', async () => {
    const insertProduct = () => dbModule.prepare(`
      INSERT INTO products (name, category, fit, price, sizes, stock_qty, extra_images)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Batch Delete Test', 'anime', 'Regular', 100, JSON.stringify(['L']), 1, '[]');
    const ids = [];
    try {
      ids.push(Number((await insertProduct()).lastInsertRowid));
      ids.push(Number((await insertProduct()).lastInsertRowid));
      const csrf = await getCsrf();
      const noCsrf = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids }, headers: { Cookie: adminCookie }
      });
      assert.strictEqual(noCsrf.status, 403);
      const noAuth = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids }, headers: { Cookie: csrf.cookie, 'X-CSRF-Token': csrf.token }
      });
      assert.strictEqual(noAuth.status, 401);
      const removed = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids: [ids[0], ids[1], ids[0]] },
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
      });
      assert.strictEqual(removed.status, 200, JSON.stringify(removed.json));
      assert.strictEqual(removed.json.deletedCount, 2);
      assert.deepStrictEqual(removed.json.deletedIds.sort((a, b) => a - b), ids.slice().sort((a, b) => a - b));
      for (const id of ids) {
        const product = await request(PORT, 'GET', `/api/products/${id}`);
        assert.strictEqual(product.status, 404);
      }
      const tooMany = await request(PORT, 'DELETE', '/api/products/batch', {
        body: { ids: Array.from({ length: 101 }, (_, i) => i + 1) },
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
      });
      assert.strictEqual(tooMany.status, 400);
    } finally {
      for (const id of ids) await dbModule.prepare('DELETE FROM products WHERE id = ?').run(id);
    }
  });

  await check('product stock quantities reject fractions instead of silently rounding', async () => {
    const csrf = await getCsrf();
    const headers = { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token };
    const created = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Fractional Stock Test', category: 'anime', price: 100, stock_qty: 1.5 }, headers
    });
    assert.strictEqual(created.status, 400);
    assert.match(created.json.error, /whole number/);
    const updated = await request(PORT, 'PUT', '/api/products/1', { body: { stock_qty: 1.5 }, headers });
    assert.strictEqual(updated.status, 400);
    assert.match(updated.json.error, /whole number/);
    const stock = await request(PORT, 'PATCH', '/api/products/1/stock-qty', { body: { stock_qty: 1.5 }, headers });
    assert.strictEqual(stock.status, 400);
    assert.match(stock.json.error, /whole number/);
  });

  await check('Vercel product creation explains missing Blob storage', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    const csrf = await getCsrf();
    process.env.VERCEL = '1';
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.kage_READ_WRITE_TOKEN;
    try {
      const form = new FormData();
      form.append('name', 'No-storage Regression Product');
      form.append('category', 'anime');
      form.append('price', '500');
      form.append('sizes', JSON.stringify(['L']));
      form.append('front_image', new Blob([Buffer.from('test-webp-image')], { type: 'image/webp' }), 'regression.webp');
      const response = await fetch(`http://127.0.0.1:${PORT}/api/products`, {
        method: 'POST',
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token },
        body: form
      });
      const body = await response.json();
      assert.strictEqual(response.status, 503, JSON.stringify(body));
      assert.strictEqual(body.code, 'IMAGE_STORAGE_UNAVAILABLE');
      assert.match(body.error, /BLOB_READ_WRITE_TOKEN/);
    } finally {
      if (oldVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = oldVercel;
      if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
      if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
      else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
    }
  });

  await check('Vercel uses the store-prefixed read-write token from its quickstart', async () => {
    const oldVercel = process.env.VERCEL;
    const oldBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const oldKageBlobToken = process.env.kage_READ_WRITE_TOKEN;
    const Module = require('module');
    const originalLoad = Module._load;
    const calls = [];
    process.env.VERCEL = '1';
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.kage_READ_WRITE_TOKEN = 'test-prefixed-store-token';
    Module._load = function(request, parent, isMain) {
      if (request === '@vercel/blob') {
        return {
          put: async (pathname, buffer, options) => {
            calls.push(['put', pathname, options]);
            return { url: `https://test.public.blob.vercel-storage.com/${pathname}` };
          },
          del: async (url, options) => { calls.push(['del', url, options]); }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const { persistImage, removeImage } = require('../utils/helpers');
      const url = await persistImage(Buffer.from('mock-image'), 'mock.webp');
      await removeImage(url);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0][2].access, 'public');
      assert.strictEqual(calls[0][2].token, 'test-prefixed-store-token');
      assert.strictEqual(calls[1][2].token, 'test-prefixed-store-token');
    } finally {
      Module._load = originalLoad;
      if (oldVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = oldVercel;
      if (oldBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = oldBlobToken;
      if (oldKageBlobToken === undefined) delete process.env.kage_READ_WRITE_TOKEN;
      else process.env.kage_READ_WRITE_TOKEN = oldKageBlobToken;
    }
  });
  await check('zero-stock products are unavailable in the catalog', async () => {
    const r = await request(PORT, 'GET', '/api/products');
    assert.strictEqual(r.status, 200);
    const zeroStockNames = ['Hollow Gaze']; // demo seed includes one out-of-stock item
    for (const name of zeroStockNames) {
      const p = r.json.find(x => x.name === name);
      assert.ok(p, `expected demo product ${name} to exist`);
      assert.equal(Number(p.stock_qty), 0, `${name} must be seeded at stock 0`);
      assert.equal(p.in_stock, false, `${name} must be marked out of stock`);
    }
  });
  await check('zero-stock product cannot be marked available without restocking', async () => {
    const csrf = await getCsrf();
    const list = await request(PORT, 'GET', '/api/products');
    const zero = list.json.find(p => p.name === 'Hollow Gaze');
    assert.ok(zero, 'expected Hollow Gaze to exist for stock-toggle test');
    const r = await request(PORT, 'PATCH', `/api/products/${zero.id}/stock`, {
      headers: { Cookie: adminCookie + '; ' + csrf.cookie, 'X-CSRF-Token': csrf.token }
    });
    assert.strictEqual(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /Restock/);
  });
  await check('clearing a sale price removes the discount on the API', async () => {
    const csrf = await getCsrf();
    const headers = { Cookie: adminCookie + '; ' + csrf.cookie, 'X-CSRF-Token': csrf.token };
    const r = await request(PORT, 'PUT', '/api/products/4', { body: { sale_price: '' }, headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sale_price, null);
    assert.equal(r.json.on_sale, false);
    const list = await request(PORT, 'GET', '/api/products');
    assert.equal(list.json.find(x => x.id === 4).sale_price, null);
  });

  // ---------------------------------------------------------------
  // Per-size stock: sizes offered, stock per size, order + cancel accounting
  // ---------------------------------------------------------------
  console.log('\nPer-size stock:');
  const adminHeaders = async () => { const csrf = await getCsrf(); return { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }; };
  const placeOrder = async (items, email) => {
    const csrf = await getCsrf();
    return request(PORT, 'POST', '/api/orders', {
      body: { name: 'Size Buyer', email, phone: '03005550000', address: '1 Test St', city: 'Lahore', payment_method: 'cod', items },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
  };
  const readProductForStock = async id => (await request(PORT, 'GET', `/api/products/${id}`)).json;
  for (const mode of ['legacy pool', 'untracked', 'per size']) {
    await check(`sold-out ${mode} products stay public, reject orders and restock consistently`, async () => {
      const headers = await adminHeaders();
      const created = await request(PORT, 'POST', '/api/products', {
        headers, body: { name: 'Sold Out Contract ' + mode, category: 'pants', price: 1000,
          sizes: '["M"]', unit_cost: 321,
          ...(mode === 'per size' ? { size_stock: '{"M":3}' } : mode === 'legacy pool' ? { stock_qty: 3 } : {}) }
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.json));
      const id = created.json.id;
      const read = async () => (await request(PORT, 'GET', `/api/products/${id}`)).json;
      try {
        const initial = await read();
        const noCsrf = await request(PORT, 'PATCH', `/api/products/${id}/stock`, { headers: { Cookie: adminCookie } });
        assert.strictEqual(noCsrf.status, 403);
        const csrf = await getCsrf();
        const noAuth = await request(PORT, 'PATCH', `/api/products/${id}/stock`, {
          headers: { Cookie: csrf.cookie, 'X-CSRF-Token': csrf.token }
        });
        assert.strictEqual(noAuth.status, 401);
        const toggle = await request(PORT, 'PATCH', `/api/products/${id}/stock`, { headers });
        assert.strictEqual(toggle.status, 200);
        assert.strictEqual(toggle.json.in_stock, false);
        const detail = await read();
        assert.strictEqual(detail.in_stock, false);
        assert.strictEqual(detail.stock_qty, initial.stock_qty, 'manual Sold Out preserves inventory');
        assert.deepStrictEqual(detail.size_stock, initial.size_stock);
        const listed = (await request(PORT, 'GET', '/api/products')).json.find(p => p.id === id);
        assert.ok(listed, 'Sold Out must not remove the product from the public list');
        assert.strictEqual(listed.in_stock, false);
        assert.ok(!('unit_cost' in listed) && !('unit_cost' in detail), 'public payload remains allow-listed');
        const beforeOrders = (await dbModule.prepare('SELECT * FROM orders').all()).length;
        const otherBefore = (await readProductForStock(1)).stock_qty;
        for (const items of [[{ id, qty: 1, size: 'M' }], [{ id: 1, qty: 1, size: 'L' }, { id, qty: 1, size: 'M' }]]) {
          const rejected = await placeOrder(items, 'soldout-contract@kage.test');
          assert.strictEqual(rejected.status, 400, JSON.stringify(rejected.json));
          assert.match(rejected.json.error, /unavailable|out of stock/i);
        }
        assert.strictEqual((await dbModule.prepare('SELECT * FROM orders').all()).length, beforeOrders, 'rejection creates no order');
        assert.strictEqual((await readProductForStock(1)).stock_qty, otherBefore, 'mixed cart rejection must not decrement available items');
        assert.strictEqual((await read()).stock_qty, initial.stock_qty);
        assert.strictEqual((await request(PORT, 'PATCH', `/api/products/${id}/stock`, { headers })).json.in_stock, true);
        const zero = await request(PORT, 'PATCH', `/api/products/${id}/stock-qty`, { headers, body: { stock_qty: 0 } });
        assert.strictEqual(zero.status, 200);
        assert.strictEqual(zero.json.in_stock, false);
        const blocked = await request(PORT, 'PATCH', `/api/products/${id}/stock`, { headers });
        assert.strictEqual(blocked.status, 400, 'zero stock must not become buyable via toggle');
        const restock = await request(PORT, 'PATCH', `/api/products/${id}/stock-qty`, { headers, body: { stock_qty: 6 } });
        assert.strictEqual(restock.status, 200);
        assert.strictEqual(restock.json.in_stock, true);
        assert.strictEqual(Number(restock.json.stock_qty), 6);
        if (mode === 'per size') assert.deepStrictEqual((await read()).size_stock, { M: 6 });
      } finally {
        await request(PORT, 'DELETE', `/api/products/${id}`, { headers });
      }
    });
  }

  const getProduct = async (id) => (await request(PORT, 'GET', `/api/products/${id}`)).json;
  const sizeProductId = { id: null };

  await check('admin creates a product with a stock count per size', async () => {
    const r = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Per Size Tee', category: 'anime', price: 1000, sizes: JSON.stringify(['S', 'M', 'L']), size_stock: JSON.stringify({ S: 2, M: 0, L: 5 }) },
      headers: await adminHeaders()
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    sizeProductId.id = r.json.id;
    assert.deepStrictEqual(r.json.sizes, ['S', 'M', 'L']);
    assert.deepStrictEqual(r.json.size_stock, { S: 2, M: 0, L: 5 });
    assert.strictEqual(Number(r.json.stock_qty), 7, 'total is the sum of the sizes');
    const listed = (await request(PORT, 'GET', '/api/products')).json.find((x) => x.id === sizeProductId.id);
    assert.deepStrictEqual(listed.size_stock, { S: 2, M: 0, L: 5 });
  });

  await check('per-size restocking with S=0 keeps the product available until every size is empty', async () => {
    const headers = await adminHeaders();
    const created = await request(PORT, 'POST', '/api/products', { headers, body: {
      name: 'Partial Size Stock Regression', category: 'pants', price: 1000,
      sizes: '["S","M","L"]', size_stock: '{"S":0,"M":0,"L":0}'
    } });
    assert.strictEqual(created.status, 201);
    const id = created.json.id;
    const save = body => request(PORT, 'PUT', `/api/products/${id}`, { headers, body });
    try {
      assert.strictEqual(created.json.in_stock, false);
      const restocked = await save({ size_stock: '{"S":0,"M":2,"L":3}' });
      assert.strictEqual(restocked.status, 200);
      assert.strictEqual(restocked.json.in_stock, true, 'Small=0 must not keep the entire restocked product Sold Out');
      assert.strictEqual(restocked.json.stock_qty, 5);
      const publicProduct = await getProduct(id);
      assert.strictEqual(publicProduct.in_stock, true);
      assert.deepStrictEqual(publicProduct.size_stock, { S: 0, M: 2, L: 3 });
      const smallOrder = await placeOrder([{ id, size: 'S', qty: 1 }], 'small-zero@kage.test');
      assert.strictEqual(smallOrder.status, 400);
      assert.match(smallOrder.json.error, /sold out in size S/);
      const mediumOrder = await placeOrder([{ id, size: 'M', qty: 1 }], 'medium-live@kage.test');
      assert.strictEqual(mediumOrder.status, 201, JSON.stringify(mediumOrder.json));
      assert.strictEqual((await getProduct(id)).in_stock, true);
      const depleted = await save({ size_stock: '{"S":0,"M":0,"L":0}' });
      assert.strictEqual(depleted.json.in_stock, false);
      const explicitPause = await save({ size_stock: '{"S":0,"M":2,"L":3}', in_stock: false });
      assert.strictEqual(explicitPause.json.in_stock, false, 'explicit admin Sold Out still wins');
      const pausedEdit = await save({ size_stock: '{"S":0,"M":3,"L":3}' });
      assert.strictEqual(pausedEdit.json.in_stock, false, 'editing a manually paused stocked product must not resume sales');
    } finally {
      await request(PORT, 'DELETE', `/api/products/${id}`, { headers });
    }
  });

  await check('per-size stock must cover every size and no unknown size', async () => {
    const headers = await adminHeaders();
    const missing = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Missing Size Tee', category: 'anime', price: 1000, sizes: JSON.stringify(['S', 'M']), size_stock: JSON.stringify({ S: 1 }) }, headers
    });
    assert.strictEqual(missing.status, 400);
    assert.match(missing.json.error, /size M/);
    const unknown = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Unknown Size Tee', category: 'anime', price: 1000, sizes: JSON.stringify(['S']), size_stock: JSON.stringify({ S: 1, XXL: 2 }) }, headers
    });
    assert.strictEqual(unknown.status, 400);
    assert.match(unknown.json.error, /XXL/);
  });

  await check('a bare stock total cannot be split across several sizes', async () => {
    const headers = await adminHeaders();
    const r = await request(PORT, 'PATCH', `/api/products/${sizeProductId.id}/stock-qty`, { body: { stock_qty: 9 }, headers });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /per size/);
    const put = await request(PORT, 'PUT', `/api/products/${sizeProductId.id}`, { body: { stock_qty: 9 }, headers });
    assert.strictEqual(put.status, 400);
    assert.match(put.json.error, /per size/);
  });

  await check('ordering a sold-out size is rejected', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 1, size: 'M' }], 'size1@kage.test');
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /sold out in size M/);
  });

  await check('ordering a size the product does not offer is rejected', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 1, size: 'XXL' }], 'size2@kage.test');
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /not offered/);
  });

  let sizeOrderNumber = '';
  await check('order decrements only the ordered size', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 2, size: 'L' }], 'size3@kage.test');
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    sizeOrderNumber = r.json.order_number;
    const p = await getProduct(sizeProductId.id);
    assert.deepStrictEqual(p.size_stock, { S: 2, M: 0, L: 3 });
    assert.strictEqual(Number(p.stock_qty), 5);
  });

  await check('ordering more than one size has left is rejected with the size named', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 4, size: 'L' }], 'size4@kage.test');
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Only 3 units .* in size L/);
  });

  await check('a failed multi-size order restores the sizes it already took', async () => {
    const r = await placeOrder([{ id: sizeProductId.id, qty: 1, size: 'S' }, { id: sizeProductId.id, qty: 99, size: 'L' }], 'size5@kage.test');
    assert.strictEqual(r.status, 400);
    const p = await getProduct(sizeProductId.id);
    assert.deepStrictEqual(p.size_stock, { S: 2, M: 0, L: 3 }, 'S must be back to 2');
    const orders = await dbModule.prepare('SELECT COUNT(*) AS c FROM orders WHERE email = ?').get('size5@kage.test');
    assert.strictEqual(Number(orders.c), 0, 'no phantom order');
  });

  await check('cancelling and reactivating an order returns and retakes the size units', async () => {
    const row = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(sizeOrderNumber);
    const headers = await adminHeaders();
    const cancel = await request(PORT, 'PATCH', `/api/orders/${row.id}/status`, { body: { status: 'cancelled' }, headers });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.json));
    assert.deepStrictEqual((await getProduct(sizeProductId.id)).size_stock, { S: 2, M: 0, L: 5 });
    const reopen = await request(PORT, 'PATCH', `/api/orders/${row.id}/status`, { body: { status: 'pending' }, headers });
    assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.json));
    assert.deepStrictEqual((await getProduct(sizeProductId.id)).size_stock, { S: 2, M: 0, L: 3 });
  });

  await check('editing sizes keeps counts for kept sizes and drops removed ones', async () => {
    const r = await request(PORT, 'PUT', `/api/products/${sizeProductId.id}`, { body: { sizes: JSON.stringify(['S', 'L', 'XL']) }, headers: await adminHeaders() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json.size_stock, { S: 2, L: 3, XL: 0 });
    assert.strictEqual(Number(r.json.stock_qty), 5);
  });

  await check('editing with per-size stock replaces each size count', async () => {
    const r = await request(PORT, 'PUT', `/api/products/${sizeProductId.id}`, { body: { size_stock: JSON.stringify({ S: 1, L: 1, XL: 4 }) }, headers: await adminHeaders() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json.size_stock, { S: 1, L: 1, XL: 4 });
    assert.strictEqual(Number(r.json.stock_qty), 6);
  });

  await check('a single-size product keeps quick stock edits working per size', async () => {
    const headers = await adminHeaders();
    const created = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Single Size Tee', category: 'anime', price: 900, sizes: JSON.stringify(['M']), size_stock: JSON.stringify({ M: 3 }) }, headers
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const r = await request(PORT, 'PATCH', `/api/products/${created.json.id}/stock-qty`, { body: { stock_qty: 6 }, headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(Number(r.json.stock_qty), 6);
    assert.deepStrictEqual((await getProduct(created.json.id)).size_stock, { M: 6 });
    await request(PORT, 'DELETE', `/api/products/${created.json.id}`, { headers });
  });

  await check('deleting a per-size product removes its size rows', async () => {
    const headers = await adminHeaders();
    const r = await request(PORT, 'DELETE', `/api/products/${sizeProductId.id}`, { headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const left = await dbModule.prepare('SELECT COUNT(*) AS c FROM product_size_stock WHERE product_id = ?').get(sizeProductId.id);
    assert.strictEqual(Number(left.c), 0);
  });

  // ---------------------------------------------------------------
  // Order history is bound to the customer, not to typed-in details
  // ---------------------------------------------------------------
  console.log('\nOrder history identity binding:');

  // Dedicated high-stock product: seeded stock runs out during the suite, and
  // these checks need every order placement to succeed.
  const historyProbe = await request(PORT, 'POST', '/api/products', {
    body: { name: 'History Probe Tee', category: 'anime', price: 700, sizes: JSON.stringify(['One Size']), stock_qty: 50 },
    headers: await adminHeaders()
  });
  assert.strictEqual(historyProbe.status, 201, JSON.stringify(historyProbe.json));
  const probeItem = { id: historyProbe.json.id, qty: 1, size: 'One Size' };
  const placeGuestOrder = async (fields) => {
    const csrf = await getCsrf();
    return request(PORT, 'POST', '/api/orders', {
      body: { payment_method: 'cod', items: [probeItem], ...fields },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
  };

  await check('a profile phone cannot unlock a stranger\'s order history', async () => {
    // Victim: a guest order (no account) whose phone the attacker can read off
    // a parcel. The attacker is verified, so only the matching rule is on trial.
    const victimOrder = await placeGuestOrder({ name: 'Phone Victim', email: 'victim.phone@kage.test', phone: '03009998881', address: 'Victim St 1', city: 'Karachi' });
    assert.strictEqual(victimOrder.status, 201, JSON.stringify(victimOrder.json));

    const attacker = await signupCustomer('attacker.phone@kage.test', 'attackerpass1', 'Attacker');
    assert.strictEqual(attacker.res.status, 200, JSON.stringify(attacker.res.json));
    await dbModule.prepare('UPDATE customers SET email_verified = 1 WHERE id = ?').run(attacker.res.json.customer.id);

    const csrf2 = await getCsrf();
    const profile = await request(PORT, 'PUT', '/api/customers/me', {
      body: { phone: '03009998881' },
      headers: { Cookie: `${attacker.cookie}; ${csrf2.cookie}`, 'X-CSRF-Token': csrf2.token }
    });
    assert.strictEqual(profile.status, 200, JSON.stringify(profile.json));
    assert.strictEqual(profile.json.customer.phone, '03009998881', 'the profile update itself is allowed');

    const history = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: attacker.cookie } });
    assert.strictEqual(history.status, 200, JSON.stringify(history.json));
    assert.deepStrictEqual(history.json.orders, [], 'a typed-in phone must never match orders');
    assert.strictEqual(history.json.email_verified, true, 'the attacker is verified — the empty list is the phone rule doing its job');
    assert.ok(!history.text.includes(victimOrder.json.order_number), 'the victim order number must not leak');
    assert.ok(!history.text.includes('victim.phone@kage.test'), 'the victim email must not leak');
    assert.ok(!history.text.includes('Victim St 1'), 'the victim address must not leak');
  });

  await check('signing up with a victim\'s email stays empty until the address is proven', async () => {
    const victimOrder = await placeGuestOrder({ name: 'Email Victim', email: 'victim.email@kage.test', phone: '03009998882', address: 'Victim St 2', city: 'Lahore' });
    assert.strictEqual(victimOrder.status, 201, JSON.stringify(victimOrder.json));

    // The attacker registers the victim's address (no account existed yet).
    const attacker = await signupCustomer('victim.email@kage.test', 'attackerpass2', 'Not The Owner');
    assert.strictEqual(attacker.res.status, 200, JSON.stringify(attacker.res.json));
    assert.strictEqual(attacker.res.json.customer.email_verified, false, 'a new signup is unverified');

    // Unverified accounts can still log in and edit their profile…
    const csrf = await getCsrf();
    const login = await request(PORT, 'POST', '/api/customers/login', {
      body: { email: 'victim.email@kage.test', password: 'attackerpass2' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.json));
    assert.strictEqual(login.json.customer.email_verified, false);
    const cookie = cookieHeader(login);
    const profile = await request(PORT, 'PUT', '/api/customers/me', {
      body: { name: 'Claimed', city: 'Lahore' }, headers: { Cookie: `${cookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
    });
    assert.strictEqual(profile.status, 200, JSON.stringify(profile.json));

    // …but the history stays empty, flagged so the UI can explain why.
    const history = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: cookie } });
    assert.strictEqual(history.status, 200, JSON.stringify(history.json));
    assert.deepStrictEqual(history.json.orders, [], 'unverified signups get no order history');
    assert.strictEqual(history.json.email_verified, false);
    assert.deepStrictEqual(Object.keys(history.json).sort(), ['email_verified', 'orders'], 'nothing else may be returned');
    assert.ok(!history.text.includes(victimOrder.json.order_number), 'the victim order must not leak');
  });

  await check('a verified customer sees their orders, including mixed-case guest orders', async () => {
    // Guest checkout with a mixed-case address (a phone-keyboard auto-capital).
    const mixed = await placeGuestOrder({ name: 'Mixed Case', email: 'Mixed.Case@Kage.Test', phone: '03009998883', address: 'Case St 3', city: 'Islamabad' });
    assert.strictEqual(mixed.status, 201, JSON.stringify(mixed.json));
    const stored = await dbModule.prepare('SELECT email FROM orders WHERE order_number = ?').get(mixed.json.order_number);
    assert.strictEqual(stored.email, 'mixed.case@kage.test', 'order emails are stored lowercased');

    // The real owner signs up for the same address (lowercase).
    const signup = await captureEmailLog(async () => signupCustomer('mixed.case@kage.test', 'ownerpass1', 'Real Owner'));
    assert.strictEqual(signup.result.res.status, 200, JSON.stringify(signup.result.res.json));
    assert.ok(signup.result.res.json.message && /verify/i.test(signup.result.res.json.message), 'signup must tell the user to verify');
    const verifyUrl = extractVerifyUrl(signup.logged);
    assert.ok(verifyUrl, 'the dev-mode email log must contain the verification link');

    const cookie = signup.result.cookie;
    const before = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: cookie } });
    assert.deepStrictEqual(before.json.orders, [], 'history is hidden until the address is verified');

    // "Open" the emailed link.
    const token = verifyUrl.split('token=')[1];
    const verified = await request(PORT, 'GET', `/api/auth/verify-email?token=${token}`);
    assert.strictEqual(verified.status, 200, JSON.stringify(verified.json));

    const after = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: cookie } });
    assert.strictEqual(after.status, 200, JSON.stringify(after.json));
    assert.strictEqual(after.json.email_verified, true);
    const seen = after.json.orders.find((o) => o.order_number === mixed.json.order_number);
    assert.ok(seen, 'the mixed-case guest order must be part of the history');
    assert.deepStrictEqual(
      Object.keys(seen).sort(),
      ['created_at', 'items', 'order_number', 'payment_method', 'shipping', 'shipping_pending', 'status', 'subtotal', 'total'],
      'the customer shape is an allow-list — no notes/email/address/phone'
    );
    for (const item of seen.items) {
      assert.deepStrictEqual(Object.keys(item).sort(), ['id', 'image', 'name', 'qty', 'size', 'total', 'unit'], 'item cost/stock internals stay server-side');
    }
    assert.ok(!/cost|notes|address|payment_ref|payment_verified|customer_id/.test(JSON.stringify(seen)), 'no internal field may appear in the payload');

    // The link is single-use.
    const replay = await request(PORT, 'GET', `/api/auth/verify-email?token=${token}`);
    assert.strictEqual(replay.status, 400, `a used token must be rejected (got ${replay.status})`);
  });

  await check('resend issues a fresh link, burns the old one and needs a session', async () => {
    const csrfAnon = await getCsrf();
    const anon = await request(PORT, 'POST', '/api/customers/resend-verification', { headers: { Cookie: csrfAnon.cookie, 'X-CSRF-Token': csrfAnon.token } });
    assert.strictEqual(anon.status, 401, 'resend requires a signed-in customer');

    const first = await captureEmailLog(async () => signupCustomer('resend.probe@kage.test', 'resendpass1', 'Resend Probe'));
    const firstUrl = extractVerifyUrl(first.logged);
    assert.ok(firstUrl, 'signup email must carry a link');
    const cookie = first.result.cookie;

    const csrf = await getCsrf();
    const resend = await captureEmailLog(async () => request(PORT, 'POST', '/api/customers/resend-verification', { headers: { Cookie: `${cookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token } }));
    assert.strictEqual(resend.result.status, 200, JSON.stringify(resend.result.json));
    const secondUrl = extractVerifyUrl(resend.logged);
    assert.ok(secondUrl && secondUrl !== firstUrl, 'resend must issue a new token');

    const stale = await request(PORT, 'GET', `/api/auth/verify-email?token=${firstUrl.split('token=')[1]}`);
    assert.strictEqual(stale.status, 400, 'requesting a new link must burn the previous one');

    const fresh = await request(PORT, 'GET', `/api/auth/verify-email?token=${secondUrl.split('token=')[1]}`);
    assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.json));
    const again = await request(PORT, 'POST', '/api/customers/resend-verification', { headers: { Cookie: `${cookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token } });
    assert.strictEqual(again.status, 200, JSON.stringify(again.json));
    assert.match(again.json.message || '', /already verified/i);
  });

  await check('backfill links existing orders to verified customers only', async () => {
    // Orders from before the account existed (no customer_id), plus a decoy
    // from a different address that must stay unlinked.
    const target = await placeGuestOrder({ name: 'Backfill Target', email: 'backfill.target@kage.test', phone: '03009998884', address: 'Bf St 4', city: 'Multan' });
    const decoy = await placeGuestOrder({ name: 'Backfill Decoy', email: 'backfill.decoy@kage.test', phone: '03009998885', address: 'Bf St 5', city: 'Multan' });
    assert.strictEqual(target.status, 201, JSON.stringify(target.json));
    assert.strictEqual(decoy.status, 201, JSON.stringify(decoy.json));
    await dbModule.prepare('UPDATE orders SET customer_id = NULL WHERE order_number IN (?, ?)').run(target.json.order_number, decoy.json.order_number);

    const account = await signupCustomer('Backfill.Target@Kage.Test', 'backfillpass1', 'Backfill Owner');
    assert.strictEqual(account.res.status, 200, JSON.stringify(account.res.json));
    const accountId = account.res.json.customer.id;
    // Unverified → the backfill must skip it.
    await dbModule.backfillOrderCustomerIds();
    let row = await dbModule.prepare('SELECT customer_id FROM orders WHERE order_number = ?').get(target.json.order_number);
    assert.strictEqual(row.customer_id, null, 'an unverified account must not be handed old orders');

    await dbModule.prepare('UPDATE customers SET email_verified = 1 WHERE id = ?').run(accountId);
    const linked = await dbModule.backfillOrderCustomerIds();
    assert.ok(linked >= 1, `expected at least one linked order, got ${linked}`);
    row = await dbModule.prepare('SELECT customer_id FROM orders WHERE order_number = ?').get(target.json.order_number);
    assert.strictEqual(Number(row.customer_id), accountId, 'the matching order is linked');
    const decoyRow = await dbModule.prepare('SELECT customer_id FROM orders WHERE order_number = ?').get(decoy.json.order_number);
    assert.strictEqual(decoyRow.customer_id, null, 'a different email must not be linked');

    const history = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: account.cookie } });
    assert.ok(history.json.orders.some((o) => o.order_number === target.json.order_number), 'the linked order is now in the history');
    assert.ok(!history.json.orders.some((o) => o.order_number === decoy.json.order_number), 'the decoy order stays out');
  });

  // ---------------------------------------------------------------
  // Email escaping + order input validation
  // ---------------------------------------------------------------
  console.log('\nEmail escaping and order validation:');

  await check('the order confirmation email escapes every customer-supplied value', async () => {
    const { result: order, sent } = await captureEmails(() => placeGuestOrder({
      name: '<a href="http://evil.test">Verify your account</a>',
      email: 'Escaping.Probe@Kage.Test',
      phone: '03009998886',
      address: '<b>y</b>',
      city: 'Lahore',
      notes: 'note with <script>alert(2)</script>',
      payment_method: 'jazzcash',
      payment_ref: '"><script>1</script>'
    }));
    assert.strictEqual(order.status, 201, JSON.stringify(order.json));
    assert.strictEqual(sent.length, 1, 'exactly one confirmation email');
    const mail = sent[0];
    assert.strictEqual(mail.to[0], 'escaping.probe@kage.test', 'the recipient is the normalised address');
    assert.ok(!/[\r\n]/.test(mail.subject), 'the subject must not carry CR/LF');
    assert.ok(!/[\r\n]/.test(mail.to[0]), 'the recipient must not carry CR/LF');

    const html = mail.html;
    assert.ok(html.includes('&lt;a href=&quot;http://evil.test&quot;&gt;Verify your account&lt;/a&gt;'), 'the name must be entity-escaped');
    assert.ok(html.includes('&lt;b&gt;y&lt;/b&gt;'), 'the address must be entity-escaped');
    assert.ok(html.includes('&lt;script&gt;1&lt;/script&gt;'), 'the payment reference must be entity-escaped');
    assert.ok(!html.includes('<a href="http://evil.test"'), 'the injected anchor must not survive as markup');
    assert.ok(!/<b>y<\/b>/.test(html), 'the injected <b> must not survive');
    assert.ok(!html.includes('<script>'), 'no script tag may appear in the email');
    assert.ok(!/<a\s/i.test(html), 'the confirmation template carries no links at all');
    assert.ok(html.includes(order.json.order_number), 'the real order number is still present');
    assert.ok(html.includes('Rs. 250 – Rs. 450'), 'the pending email shows the published delivery band (D1)');
  });

  await check('the status update email escapes the stored customer name', async () => {
    const order = await placeGuestOrder({
      name: '<a href="http://evil.test">Verify your account</a>',
      email: 'status.probe@kage.test', phone: '03009998887', address: '<i>addr</i>', city: 'Multan'
    });
    assert.strictEqual(order.status, 201, JSON.stringify(order.json));
    const row = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(order.json.order_number);

    const { result: patched, sent } = await captureEmails(async () => {
      const csrf = await getCsrf();
      return request(PORT, 'PATCH', `/api/orders/${row.id}/status`, {
        body: { status: 'shipped' },
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
      });
    });
    assert.strictEqual(patched.status, 200, JSON.stringify(patched.json));
    assert.strictEqual(sent.length, 1, 'exactly one status email');
    const html = sent[0].html;
    assert.ok(html.includes('&lt;a href=&quot;http://evil.test&quot;&gt;'), 'the name must be escaped in the status email');
    assert.ok(!/<a\s/i.test(html), 'no anchor may be injected into the status email');
    assert.ok(!/[\r\n]/.test(sent[0].subject), 'the subject must not carry CR/LF');
  });

  await check('the password reset link is SITE_URL plus an encoded server token', async () => {
    const { result: reset, sent } = await captureEmails(async () => {
      const csrf = await getCsrf();
      return request(PORT, 'POST', '/api/auth/forgot-password', {
        body: { email: 'cust@kage.test', user_type: 'customer' },
        headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
      });
    });
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.json));
    assert.strictEqual(sent.length, 1, 'exactly one reset email');
    // The href is escaped in the HTML, so the & of the second query param shows as &amp;.
    const href = hrefOf(sent[0].html);
    assert.match(href, /^https:\/\/shop\.kage\.test\/reset-password\?token=[a-f0-9]{64}&amp;type=customer$/, href);
    assert.ok(!/<script/i.test(sent[0].html), 'no script may appear in the reset email');
    assert.ok(!/[\r\n]/.test(sent[0].subject), 'the subject must not carry CR/LF');
  });

  await check('unset SITE_URL never sends guessed reset or verification links', async () => {
    const previousSiteUrl = process.env.SITE_URL;
    delete process.env.SITE_URL;
    try {
      const { buildLink } = require('../utils/email');
      assert.throws(() => buildLink('/reset-password', { token: 'test' }), /SITE_URL/i);

      const { result: reset, sent: resetEmails } = await captureEmails(async () => {
        const csrf = await getCsrf();
        return request(PORT, 'POST', '/api/auth/forgot-password', {
          body: { email: 'cust@kage.test', user_type: 'customer' },
          headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
        });
      });
      assert.strictEqual(reset.status, 200, JSON.stringify(reset.json));
      assert.strictEqual(resetEmails.length, 0, 'password reset must not send a guessed link');

      const { result: signup, sent: verificationEmails } = await captureEmails(() => signupCustomer('missing.site.url@kage.test', 'nositepass1', 'No URL'));
      assert.strictEqual(signup.res.status, 200, JSON.stringify(signup.res.json));
      assert.strictEqual(verificationEmails.length, 0, 'verification must not send a guessed link');
      const customer = await dbModule.prepare('SELECT id FROM customers WHERE email = ?').get('missing.site.url@kage.test');
      const tokens = await dbModule.prepare('SELECT COUNT(*) AS count FROM customer_verification_tokens WHERE customer_id = ?').get(customer.id);
      assert.strictEqual(Number(tokens.count), 0, 'no unusable verification token should be stored');
    } finally {
      if (previousSiteUrl === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = previousSiteUrl;
    }
  });

  await check('the verification email escapes the name and encodes the token', async () => {
    const { result: signup, sent } = await captureEmails(() => signupCustomer('escaper@kage.test', 'escaperpass1', '<img src=x onerror=alert(1)>'));
    assert.strictEqual(signup.res.status, 200, JSON.stringify(signup.res.json));
    assert.strictEqual(sent.length, 1, 'exactly one verification email');
    const html = sent[0].html;
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the customer name must be escaped');
    assert.ok(!/<img\s/i.test(html), 'no injected image/tag may survive');
    const href = hrefOf(html);
    assert.match(href, /^https:\/\/shop\.kage\.test\/verify-email\?token=[a-f0-9]{64}$/, href);
    assert.ok(!/[^a-zA-Z0-9:/.?=&%-]/.test(href), 'the href must stay a plain URL');
  });

  await check('order placement rejects invalid emails and control characters', async () => {
    const base = { name: 'Valid Name', email: 'valid@kage.test', phone: '03009998888', address: 'Valid St', city: 'Lahore' };
    const bad = async (patch, label) => {
      const r = await placeGuestOrder({ ...base, ...patch });
      assert.strictEqual(r.status, 400, `${label} must be rejected (got ${r.status} ${JSON.stringify(r.json)})`);
      return r;
    };
    await bad({ email: 'not-an-email' }, 'a malformed email');
    await bad({ email: 'a@b' }, 'an email without a TLD');
    await bad({ email: `${'x'.repeat(200)}@kage.test` }, 'an over-long email');
    await bad({ name: 'Evil\r\nBcc: victim@kage.test' }, 'a CRLF in the name');
    await bad({ name: 'Evil\nName' }, 'a bare LF in the name');
    await bad({ address: 'Street\r\nX-Header: 1' }, 'a CRLF in the address');
    await bad({ payment_ref: 'ref\nline', payment_method: 'jazzcash' }, 'a newline in the payment reference');

    // Rich text is allowed through (it is escaped at every render/email sink)…
    const htmlish = await placeGuestOrder({ ...base, name: '<b>Bold Buyer</b>', address: '<i>St</i>', email: 'bold.buyer@kage.test' });
    assert.strictEqual(htmlish.status, 201, JSON.stringify(htmlish.json));
    // …and a normal order still works after all of that.
    const ok = await placeGuestOrder({ ...base, email: 'still.works@kage.test' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  });

  await check('header characters are stripped from subjects and recipients', async () => {
    const { stripHeaderChars } = require('../utils/helpers');
    assert.strictEqual(stripHeaderChars('Evil\r\nBcc: victim@kage.test'), 'Evil Bcc: victim@kage.test');
    assert.strictEqual(stripHeaderChars('Order KAGE-1\nX-Mailer: evil'), 'Order KAGE-1 X-Mailer: evil');
    assert.strictEqual(stripHeaderChars(null), '');

    // And a forged subject/recipient can never reach the transport.
    const emailModule = require('../utils/email');
    const { result: ok, sent } = await captureEmails(async () => emailModule.sendEmail('victim@kage.test\r\nBcc: x@kage.test', 'Hello\r\nX-Evil: 1', '<p>hi</p>'));
    assert.strictEqual(ok, true);
    assert.ok(!/[\r\n]/.test(sent[0].to[0]), 'the recipient must be stripped');
    assert.ok(!/[\r\n]/.test(sent[0].subject), 'the subject must be stripped');
  });

  await check('Resend remains the fallback when SMTP_HOST is unset', async () => {
    const emailModule = require('../utils/email');
    const { result, sent } = await captureEmails(() => emailModule.sendEmail('resend@kage.test', 'Resend fallback', '<p>Resend body</p>'));
    assert.strictEqual(result, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].from, 'KAGE Culture <noreply@kage-culture.vercel.app>');
    assert.deepStrictEqual(sent[0].to, ['resend@kage.test']);
    assert.strictEqual(sent[0].subject, 'Resend fallback');
    assert.strictEqual(sent[0].html, '<p>Resend body</p>');
  });

  await check('SMTP JSON transport sends an escaped order confirmation with secure Gmail defaults', async () => {
    const { result: order, sent, transportOptions } = await captureSmtpEmails(() => placeGuestOrder({
      name: '<a href="http://evil.test">SMTP Buyer</a>',
      email: 'Smtp.Order@Kage.Test', phone: '03009998891',
      address: '<b>SMTP Street</b>', city: 'Lahore'
    }));
    assert.strictEqual(order.status, 201, JSON.stringify(order.json));
    assert.strictEqual(sent.length, 1, 'one SMTP confirmation is produced');
    const mail = sent[0];
    assertSmtpHeaders(mail, 'smtp.order@kage.test', `Order ${order.json.order_number} — KAGE Culture`);
    assert.ok(mail.html.includes('&lt;a href=&quot;http://evil.test&quot;&gt;SMTP Buyer&lt;/a&gt;'));
    assert.ok(mail.html.includes('&lt;b&gt;SMTP Street&lt;/b&gt;'));
    assert.ok(!/<a href="http:\/\/evil\.test"/.test(mail.html));
    assert.strictEqual(transportOptions.length, 1);
    assert.strictEqual(transportOptions[0].host, 'smtp.gmail.test');
    assert.strictEqual(transportOptions[0].port, 465, 'SMTP_PORT defaults to 465');
    assert.strictEqual(transportOptions[0].secure, true, 'port 465 must use implicit TLS');
    assert.strictEqual(transportOptions[0].requireTLS, false);
    assert.deepStrictEqual(transportOptions[0].auth, { user: 'shop@gmail.test', pass: 'capture-only-app-password' });
    assert.strictEqual(transportOptions[0].connectionTimeout, 8000);
    assert.strictEqual(transportOptions[0].greetingTimeout, 8000);
    assert.strictEqual(transportOptions[0].socketTimeout, 8000);
  });

  await check('SMTP port 587 requires STARTTLS', async () => {
    const emailModule = require('../utils/email');
    const { result, sent, transportOptions } = await captureSmtpEmails(
      () => emailModule.sendEmail('starttls@kage.test', 'STARTTLS check', '<p>hi</p>'),
      { port: 587 }
    );
    assert.strictEqual(result, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(transportOptions[0].port, 587);
    assert.strictEqual(transportOptions[0].secure, false);
    assert.strictEqual(transportOptions[0].requireTLS, true);
  });

  await check('SMTP JSON transport sends an escaped order status update', async () => {
    const { result: order } = await captureEmails(() => placeGuestOrder({
      name: '<a href="http://evil.test">Status Buyer</a>',
      email: 'smtp.status@kage.test', phone: '03009998892', address: 'Status St', city: 'Karachi'
    }));
    assert.strictEqual(order.status, 201, JSON.stringify(order.json));
    const row = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(order.json.order_number);
    const { result: patched, sent } = await captureSmtpEmails(async () => {
      const csrf = await getCsrf();
      return request(PORT, 'PATCH', `/api/orders/${row.id}/status`, {
        body: { status: 'shipped' },
        headers: { Cookie: `${adminCookie}; ${csrf.cookie}`, 'X-CSRF-Token': csrf.token }
      });
    });
    assert.strictEqual(patched.status, 200, JSON.stringify(patched.json));
    assert.strictEqual(sent.length, 1);
    assertSmtpHeaders(sent[0], 'smtp.status@kage.test', `Order ${order.json.order_number} — Shipped — KAGE Culture`);
    assert.ok(sent[0].html.includes('&lt;a href=&quot;http://evil.test&quot;&gt;Status Buyer&lt;/a&gt;'));
    assert.ok(!/<a href="http:\/\/evil\.test"/.test(sent[0].html));
  });

  await check('SMTP JSON transport sends an escaped password reset with the configured site link', async () => {
    const { result: reset, sent } = await captureSmtpEmails(async () => {
      const csrf = await getCsrf();
      return request(PORT, 'POST', '/api/auth/forgot-password', {
        body: { email: 'cust@kage.test', user_type: 'customer' },
        headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
      });
    });
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.json));
    assert.strictEqual(sent.length, 1);
    assertSmtpHeaders(sent[0], 'cust@kage.test', 'Reset your KAGE Culture password');
    const href = hrefOf(sent[0].html);
    assert.match(href, /^https:\/\/shop\.kage\.test\/reset-password\?token=[a-f0-9]{64}&amp;type=customer$/, href);
    assert.ok(!/<script/i.test(sent[0].html));
  });

  await check('SMTP JSON transport sends an escaped verification email with a server token', async () => {
    const { result: signup, sent } = await captureSmtpEmails(() => signupCustomer(
      'smtp.verify@kage.test', 'smtpverify1', '<img src=x onerror=alert(1)>'
    ));
    assert.strictEqual(signup.res.status, 200, JSON.stringify(signup.res.json));
    assert.strictEqual(sent.length, 1);
    assertSmtpHeaders(sent[0], 'smtp.verify@kage.test', 'Verify your KAGE Culture email');
    assert.ok(sent[0].html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!/<img\s/i.test(sent[0].html));
    const href = hrefOf(sent[0].html);
    assert.match(href, /^https:\/\/shop\.kage\.test\/verify-email\?token=[a-f0-9]{64}$/, href);
  });

  await check('an SMTP failure warns but does not fail or roll back order placement', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
      const { result: order, sent, resendRequests } = await captureSmtpEmails(() => placeGuestOrder({
        name: 'SMTP Failure Buyer', email: 'smtp.failure@kage.test', phone: '03009998893',
        address: 'Failure St', city: 'Lahore'
      }), { fail: true, resendKey: 'must-not-fall-through-to-resend' });
      assert.strictEqual(order.status, 201, JSON.stringify(order.json));
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(resendRequests.length, 0, 'SMTP has precedence; failure must not trigger Resend');
      assert.ok(warnings.some((line) => /Email send failed: SMTP test transport rejected/.test(line)), warnings.join('\n'));
      const stored = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(order.json.order_number);
      assert.ok(stored, 'the successfully placed order must remain stored');
    } finally {
      console.warn = originalWarn;
    }
  });

  await check('a stalled SMTP transport is cut off at the configured timeout', async () => {
    const config = require('../config');
    const emailModule = require('../utils/email');
    const previousTimeout = config.EMAIL_SEND_TIMEOUT_MS;
    const originalWarn = console.warn;
    const warnings = [];
    config.EMAIL_SEND_TIMEOUT_MS = 30; // shorten only for this deterministic timeout regression test
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    const started = Date.now();
    try {
      const { result, transportOptions } = await captureSmtpEmails(
        () => emailModule.sendEmail('slow@kage.test', 'Slow transport', '<p>hi</p>'),
        { stall: true }
      );
      assert.strictEqual(result, false);
      assert.ok(Date.now() - started < 1000, 'a stalled send must be bounded by the configured deadline');
      assert.strictEqual(transportOptions[0].connectionTimeout, 30);
      assert.ok(warnings.some((line) => /timed out after 30ms/.test(line)), warnings.join('\n'));
    } finally {
      console.warn = originalWarn;
      config.EMAIL_SEND_TIMEOUT_MS = previousTimeout;
    }
  });

  await check('SMTP still strips CR/LF from recipient and subject headers', async () => {
    const emailModule = require('../utils/email');
    const { result, sent } = await captureSmtpEmails(() => emailModule.sendEmail(
      'victim@kage.test\r\nBcc: x@kage.test',
      'Hello\r\nX-Evil: 1',
      '<p>safe body</p>'
    ));
    assert.strictEqual(result, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].subject, 'Hello X-Evil: 1');
    assert.ok(!/[\r\n]/.test(JSON.stringify(sent[0])));
    assert.ok(!Object.keys(sent[0].headers).some((name) => name.toLowerCase() === 'bcc'));
  });

  // ---------------------------------------------------------------
  // Admin CSV export: RFC 4180 quoting + spreadsheet formula shielding
  // ---------------------------------------------------------------
  console.log('\nOrder CSV export:');

  await check('csvCell quotes every cell and defuses formulas', async () => {
    const { csvCell } = require('../utils/helpers');
    assert.strictEqual(csvCell(null), '""');
    assert.strictEqual(csvCell(undefined), '""');
    assert.strictEqual(csvCell('plain'), '"plain"');
    assert.strictEqual(csvCell('A,B'), '"A,B"');
    assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
    assert.strictEqual(csvCell('=1+1'), '"\'=1+1"');
    assert.strictEqual(csvCell('+1@x.com'), '"\'+1@x.com"');
    assert.strictEqual(csvCell('-5'), '"\'-5"');
    assert.strictEqual(csvCell('@cmd'), '"\'@cmd"');
    assert.strictEqual(csvCell('\tlead'), '"\'\tlead"');
    assert.strictEqual(csvCell('\r=1'), '"\'\r=1"');
  });

  await check('the CSV export quotes, shields and round-trips every text column', async () => {
    const probe = await request(PORT, 'POST', '/api/products', {
      body: { name: 'CSV Probe Tee', category: 'anime', price: 500, sizes: JSON.stringify(['One Size']), stock_qty: 20 },
      headers: await adminHeaders()
    });
    assert.strictEqual(probe.status, 201, JSON.stringify(probe.json));

    const csrf = await getCsrf();
    const nasty = await request(PORT, 'POST', '/api/orders', {
      body: {
        name: 'Quote "The Boss", Jr.', email: '+1@x.com', phone: '03009998885',
        address: '12 "Main" St, Block B', city: 'A,B',
        payment_method: 'jazzcash', payment_ref: '=HYPERLINK("http://evil.test","x"),extra',
        notes: '@SUM(1+1) notes', items: [{ id: probe.json.id, qty: 1, size: 'One Size' }]
      },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(nasty.status, 201, JSON.stringify(nasty.json));

    // A row that already contains a newline in the name: the API rejects
    // control characters now, but old/hand-edited data must not shift columns.
    const legacyNumber = 'KAGE-LEGACY01';
    await dbModule.prepare(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, notes, payment_method, payment_ref, subtotal, shipping, shipping_pending, total, items_json, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(legacyNumber, 'Line\nBreak "Quoted"', 'legacy@kage.test', '03009998880', 'Legacy St', 'Lahore', 'multi\nline note', 'cod', null, 100, 0, 0, 100, '[]', 'pending');

    const res = await request(PORT, 'GET', '/api/orders/export/csv', { headers: await adminHeaders() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.match(res.headers['content-type'], /^text\/csv/, res.headers['content-type']);
    assert.match(res.headers['content-type'], /charset=utf-8/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="kage-orders-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.strictEqual(res.text.charCodeAt(0), 0xFEFF, 'the export must start with a UTF-8 BOM');

    // Strict RFC 4180 endings: with the quoted fields blanked out, every
    // remaining line break must be a CRLF.
    const outsideQuotes = res.text.replace(/"(?:[^"]|"")*"/g, '"X"');
    assert.ok(!outsideQuotes.replace(/\r\n/g, '').includes('\n'), 'rows must be CRLF-terminated');

    const rows = parseCsv(res.text);
    const header = rows[0];
    assert.strictEqual(header.length, 16, `unexpected header: ${header.join('|')}`);
    assert.deepStrictEqual(header.slice(0, 3), ['Order Number', 'Customer Name', 'Email']);
    assert.strictEqual(header[15], 'Notes');
    rows.forEach((r, i) => assert.strictEqual(r.length, header.length, `row ${i} has ${r.length} columns, expected ${header.length}`));

    const byNumber = new Map(rows.slice(1).map(r => [r[0], r]));
    const row = byNumber.get(nasty.json.order_number);
    assert.ok(row, 'the probe order must be exported');
    assert.strictEqual(row[1], 'Quote "The Boss", Jr.', 'the name must round-trip');
    // "+1@x.com" starts with + → it is a formula-shaped value too, so it is
    // shielded as well; the original address is the cell minus the apostrophe.
    assert.ok(row[2].startsWith("'"), 'a leading + must be shielded');
    assert.strictEqual(row[2].slice(1), '+1@x.com', 'the email must round-trip after the shield');
    assert.strictEqual(row[4], '12 "Main" St, Block B', 'the address must round-trip');
    assert.strictEqual(row[5], 'A,B', 'the city must round-trip');
    assert.strictEqual(row[6], 'jazzcash');
    assert.ok(row[7].startsWith("'"), `the formula cell must be prefixed with a single quote, got ${JSON.stringify(row[7])}`);
    assert.strictEqual(row[7].slice(1), '=HYPERLINK("http://evil.test","x"),extra', 'the payment ref must round-trip after the shield');
    assert.strictEqual(row[15], '@SUM(1+1) notes'.replace(/^/, "'"), 'the notes column is exported and shielded');
    assert.strictEqual(row[13], 'awaiting_verification');
    // The raw record really does carry the apostrophe inside the quotes.
    assert.ok(res.text.includes('"\'=HYPERLINK(""http://evil.test""'), 'the raw CSV must hold the shielded cell');

    const legacy = byNumber.get(legacyNumber);
    assert.ok(legacy, 'the legacy row must be exported');
    assert.strictEqual(legacy[1], 'Line\nBreak "Quoted"', 'a newline inside a name must stay in one field');
    assert.strictEqual(legacy[15], 'multi\nline note', 'a newline in notes must stay in one field');
    assert.ok(!legacy[9].includes('"'), 'numeric columns stay unquoted');
    assert.strictEqual(Number(legacy[9]), 100);

    // Money columns are plain numbers, still unquoted in the raw text.
    const rawLegacy = res.text.split('\r\n').find(l => l.startsWith('"KAGE-LEGACY01"'));
    assert.ok(rawLegacy, 'the legacy line must be present');
    assert.match(rawLegacy, /,100,0,"No",100,/, `money columns should be unquoted: ${rawLegacy}`);
  });

  await check('the CSV export still requires an admin session', async () => {
    const r = await request(PORT, 'GET', '/api/orders/export/csv');
    assert.strictEqual(r.status, 401);
  });

  // ---------------------------------------------------------------
  // Product field exposure: public allow-list vs admin-only columns
  // ---------------------------------------------------------------
  console.log('\nProduct field exposure:');

  await check('public product list carries only the allow-listed fields — no unit_cost', async () => {
    const r = await request(PORT, 'GET', '/api/products');
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.length > 0, 'catalog must not be empty');
    const expected = [...productShape.PUBLIC_PRODUCT_COLUMNS, 'size_stock', 'sold_count', 'order_count', 'avg_rating', 'review_count'].sort();
    for (const p of r.json) {
      assert.deepStrictEqual(Object.keys(p).sort(), expected, `unexpected field set on public product ${p.id}`);
      for (const leaked of ['unit_cost', 'updated_at']) assert.ok(!(leaked in p), `${leaked} must never be public`);
    }
    // The omission must be deliberate: the table really does hold costs.
    const costed = await dbModule.prepare('SELECT COUNT(*) AS c FROM products WHERE unit_cost IS NOT NULL').get();
    assert.ok(Number(costed.c) > 0, 'seeded products should carry unit_cost, otherwise this test proves nothing');
  });

  await check('public single-product response omits unit_cost too', async () => {
    const r = await request(PORT, 'GET', '/api/products/1');
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.id, 1);
    assert.ok(!('unit_cost' in r.json), 'unit_cost must not be public');
    assert.ok(!('updated_at' in r.json), 'updated_at must not be public');
    assert.ok('stock_qty' in r.json && 'sizes' in r.json && 'size_stock' in r.json, 'storefront fields must survive the allow-list');
  });

  await check('admin product list exposes unit_cost behind auth', async () => {
    const r = await request(PORT, 'GET', '/api/admin/products', { headers: { Cookie: adminCookie } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const p1 = r.json.find((p) => p.id === 1);
    assert.ok(p1, 'seeded product 1 must be present');
    for (const field of ['unit_cost', 'on_sale', 'updated_at', 'size_stock', 'sold_count']) {
      assert.ok(field in p1, `admin list must include ${field}`);
    }
    const row = await dbModule.prepare('SELECT unit_cost FROM products WHERE id = 1').get();
    assert.strictEqual(Number(p1.unit_cost), Number(row.unit_cost), 'admin unit_cost must match the DB');
  });

  await check('admin single-product endpoint exposes unit_cost behind auth', async () => {
    const r = await request(PORT, 'GET', '/api/admin/products/1', { headers: { Cookie: adminCookie } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.id, 1);
    assert.ok('unit_cost' in r.json, 'admin single must include unit_cost');
    const missing = await request(PORT, 'GET', '/api/admin/products/999999', { headers: { Cookie: adminCookie } });
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.json));
  });

  await check('admin product routes reject anonymous and forged callers with 401', async () => {
    const list = await request(PORT, 'GET', '/api/admin/products');
    assert.strictEqual(list.status, 401, JSON.stringify(list.json));
    const single = await request(PORT, 'GET', '/api/admin/products/1');
    assert.strictEqual(single.status, 401, JSON.stringify(single.json));
    assert.ok(!JSON.stringify(list.json).includes('unit_cost'), 'the 401 body must not leak cost columns');
    assert.ok(!JSON.stringify(single.json).includes('unit_cost'), 'the 401 body must not leak cost columns');
    // A forged inline admin id (the classic bypass) must not open the route.
    const forged = await request(PORT, 'GET', '/api/admin/products', {
      headers: { Cookie: 'kage.admin=' + Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64') }
    });
    assert.strictEqual(forged.status, 401, JSON.stringify(forged.json));
  });

  await check('sold_count matches the order-item scan and follows cancellation', async () => {
    const headers = await adminHeaders();
    const created = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Sold Count Probe', category: 'anime', price: 500, sizes: JSON.stringify(['M']), stock_qty: 9 },
      headers
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;
    assert.strictEqual(Number((await request(PORT, 'GET', `/api/products/${id}`)).json.sold_count), 0);

    const csrf = await getCsrf();
    const order = await request(PORT, 'POST', '/api/orders', {
      body: { name: 'Sold Probe', email: 'sold@kage.test', phone: '03001239999', address: '1 Sold St', city: 'Lahore', payment_method: 'cod', items: [{ id, qty: 3, size: 'M' }] },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(order.status, 201, JSON.stringify(order.json));
    const afterOrder = (await request(PORT, 'GET', `/api/products/${id}`)).json;
    assert.strictEqual(Number(afterOrder.sold_count), 3, 'sold_count must count the ordered units');
    assert.strictEqual(Number(afterOrder.order_count), Number(afterOrder.sold_count), 'order_count mirrors sold_count today');

    const orderRow = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(order.json.order_number);
    const csrf2 = await getCsrf();
    const cancelled = await request(PORT, 'PATCH', `/api/orders/${orderRow.id}/status`, {
      body: { status: 'cancelled' }, headers: { Cookie: `${adminCookie}; ${csrf2.cookie}`, 'X-CSRF-Token': csrf2.token }
    });
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.json));
    assert.strictEqual(Number((await request(PORT, 'GET', `/api/products/${id}`)).json.sold_count), 0, 'cancelled orders must stop counting');

    // The single SQL aggregate must agree with the reference scan everywhere.
    const fromAggregate = [...(await productShape.getSoldCounts(dbModule)).entries()].sort((a, b) => a[0] - b[0]);
    const fromScan = [...(await productShape.scanSoldCounts(dbModule)).entries()].sort((a, b) => a[0] - b[0]);
    assert.deepStrictEqual(fromAggregate, fromScan, 'SQL aggregate must match the JSON scan');

    await request(PORT, 'DELETE', `/api/products/${id}`, { headers });
  });

  await check('sold and review aggregates share a 60-second cache invalidated by product writes', async () => {
    let reviewQueries = 0;
    let soldQueries = 0;
    const originalPrepare = dbModule.prepare;
    dbModule.prepare = function (sql) {
      const text = String(sql);
      if (/SELECT product_id, rating FROM reviews WHERE status = \?/i.test(text)) reviewQueries++;
      if (text.includes('json_each(o.items_json)') || /SELECT items_json FROM orders WHERE status != \?/i.test(text)) soldQueries++;
      return originalPrepare.call(dbModule, sql);
    };
    try {
      productShape.invalidateSoldCounts();
      await request(PORT, 'GET', '/api/products');
      await request(PORT, 'GET', '/api/products');
      assert.strictEqual(reviewQueries, 1, 'repeat reads should share the approved-review aggregate');
      assert.strictEqual(soldQueries, 1, 'repeat reads should share the sold-unit aggregate');

      const headers = await adminHeaders();
      const created = await request(PORT, 'POST', '/api/products', {
        body: { name: 'Aggregate Invalidation Probe', category: 'anime', price: 500, sizes: JSON.stringify(['M']), stock_qty: 4 },
        headers
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.json));
      await request(PORT, 'GET', '/api/products');
      assert.strictEqual(reviewQueries, 2, 'creating a product must invalidate the combined aggregate cache');

      const updated = await request(PORT, 'PUT', `/api/products/${created.json.id}`, {
        body: { description: 'Updated description' }, headers
      });
      assert.strictEqual(updated.status, 200, JSON.stringify(updated.json));
      await request(PORT, 'GET', '/api/products');
      assert.strictEqual(reviewQueries, 3, 'updating a product must invalidate the combined aggregate cache');

      const deleted = await request(PORT, 'DELETE', `/api/products/${created.json.id}`, { headers });
      assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.json));
      await request(PORT, 'GET', '/api/products');
      assert.strictEqual(reviewQueries, 4, 'deleting a product must invalidate the combined aggregate cache');
    } finally {
      dbModule.prepare = originalPrepare;
    }
  });

  // ---------------------------------------------------------------
  // One-time bootstrap: seeding happens once per DATABASE, not per boot
  // ---------------------------------------------------------------
  console.log('\nOne-time data bootstrap:');

  const BOOTSTRAP_FIXTURE = path.join(__dirname, 'fixtures', 'bootstrap-child.js');
  const runBootstrap = (command, dbFile, extraArg) => {
    const args = [BOOTSTRAP_FIXTURE, command];
    if (extraArg) args.push(extraArg);
    const child = spawnSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: cleanEnv({ KAGE_DB_FILE: dbFile })
    });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('RESULT: '));
    assert.ok(line, `${command} produced no result\nexit=${child.status}\nstdout=${child.stdout}\nstderr=${child.stderr}`);
    return JSON.parse(line.slice('RESULT: '.length));
  };
  const tempDb = (name) => path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'kage-boot-')), `${name}.db`);

  await check('a fresh database seeds the demo catalogue once and records the keys', async () => {
    const file = tempDb('fresh');
    const out = runBootstrap('seed-fresh', file);
    assert.strictEqual(out.products, demoProducts.DEMO_PRODUCTS.length, JSON.stringify(out));
    assert.deepStrictEqual(Object.keys(out.keys).sort(), ['backfill_newsletter_tokens_v1', 'backfill_unit_costs_v1', 'normalize_demo_categories_v1', 'normalize_emails_v1', 'remove_old_categories_v1', 'seed_products_v1', 'sync_seed_sale_prices_v1']);
    assert.strictEqual(out.keys.seed_products_v1, 'seeded');
    assert.strictEqual(out.keys.normalize_demo_categories_v1, 'normalized:0', 'fresh products already use their route collection keys');
    const seededGraphics = demoProducts.DEMO_PRODUCTS.filter(product => product.category === 'graphic-tees').map(product => product.name);
    assert.deepStrictEqual(Object.entries(out.categories).filter(([, category]) => category === 'graphic-tees').map(([name]) => name), seededGraphics);
    const again = runBootstrap('seed-fresh', file); // second process, same file
    assert.strictEqual(again.products, demoProducts.DEMO_PRODUCTS.length, 'a restart must not duplicate the catalogue');
  });

  await check('deleting every product survives a restart (no demo products resurrected)', async () => {
    const file = tempDb('deleted');
    const seeded = runBootstrap('delete-all', file);
    assert.strictEqual(seeded.products, 0, JSON.stringify(seeded));
    assert.ok(seeded.keys.seed_products_v1, 'the seed marker must stay after the products are gone');
    const restarted = runBootstrap('expect-empty', file);
    assert.strictEqual(restarted.products, 0, 'the demo catalogue must NOT come back on restart');
  });

  await check('a sale the admin removed stays removed across restarts', async () => {
    const file = tempDb('sale');
    const removed = runBootstrap('remove-sale', file, 'Rising Vermillion');
    assert.strictEqual(removed.product.sale_price, null, JSON.stringify(removed));
    const restarted = runBootstrap('expect-no-sale', file, 'Rising Vermillion');
    assert.strictEqual(restarted.sale_price === null || restarted.sale_price === undefined, true, `the sale must not be re-applied: ${JSON.stringify(restarted)}`);
    assert.strictEqual(Number(restarted.on_sale) || 0, 0, 'the product must stay off sale');
  });

  await check('a deliberate unit_cost of 0 is never overwritten', async () => {
    const file = tempDb('cost');
    const zeroed = runBootstrap('set-cost-zero', file, 'Blade Wolf');
    assert.strictEqual(Number(zeroed.product.unit_cost), 0, JSON.stringify(zeroed));
    const restarted = runBootstrap('expect-cost-zero', file, 'Blade Wolf');
    assert.strictEqual(Number(restarted.unit_cost), 0, `0 must survive the restart: ${JSON.stringify(restarted)}`);
  });

  await check('legacy graphic-tee categories are corrected without overwriting admin category edits', async () => {
    const file = tempDb('legacy');
    const prepped = runBootstrap('legacy-prep', file);
    assert.ok(prepped.products > 0 && Object.keys(prepped.keys).length === 0, JSON.stringify(prepped).slice(0, 200));

    const before = runBootstrap('fingerprint', file);
    assert.deepStrictEqual(Object.keys(before.keys), [], 'the fixture DB must have no markers yet');

    const after = runBootstrap('legacy-check', file);
    assert.deepStrictEqual(after.fingerprint, before.fingerprint, 'legacy normalization must not change prices, stock or product names');
    assert.equal(before.categories['Rising Vermillion'], 'anime', 'fixture reproduces the previous seed classification');
    for (const name of ['Rising Vermillion', 'Neon Fangs', 'Shinobi Mark']) {
      assert.equal(after.categories[name], 'graphic-tees', `${name} uses the category key filtered by the storefront`);
    }
    assert.equal(after.categories['Blade Wolf'], 'pants', 'an admin edit to an allowed category is preserved across the remove-old-categories step');
    assert.equal(after.categories['Old Streetwear Tee'], 'graphic-tees', 'legacy streetwear products are rehomed to graphic-tees');
    assert.strictEqual(after.keys.remove_old_categories_v1, 'migrated:1', 'one legacy category row migrated');
    // Costs: NULL may be filled once, 0 and real numbers must be untouched.
    for (const [name, costBefore] of Object.entries(before.costs)) {
      const costAfter = after.costs[name];
      if (costBefore === null) assert.ok(costAfter !== null, `${name}: a NULL cost may be backfilled once`);
      else assert.strictEqual(costAfter, costBefore, `${name}: unit_cost ${costBefore} must never change`);
    }
    assert.strictEqual(after.risingVermillion.sale_price, null, 'the removed sale must not be re-applied');
    assert.strictEqual(Number(after.risingVermillion.on_sale) || 0, 0, 'the product must stay off sale');
    assert.strictEqual(Number(after.bladeWolfCost), 0, 'a deliberate 0 cost must be untouched');
    assert.notStrictEqual(after.customCost, null, 'unit_cost IS NULL rows may be backfilled once');
    assert.strictEqual(after.keys.seed_products_v1, 'existing', 'the seed marker records "existing", not a re-seed');
    assert.strictEqual(after.keys.sync_seed_sale_prices_v1, 'skipped-existing');
    assert.strictEqual(after.keys.normalize_demo_categories_v1, 'normalized:3', 'only three legacy default categories changed');
    assert.ok(after.keys.backfill_unit_costs_v1, 'the cost step records its own key');
    // …and a further restart changes nothing at all.
    const again = runBootstrap('legacy-check', file);
    assert.deepStrictEqual(again.fingerprint, after.fingerprint, 'a later boot must also be a no-op');
    assert.deepStrictEqual(again.costs, after.costs, 'a later boot must not touch a single cost');
    assert.deepStrictEqual(again.categories, after.categories, 'the one-off category migration never repeats');
  });

  await check('a failed seed does not record its key and is retried next time', async () => {
    const file = tempDb('retry');
    const broken = runBootstrap('break-seed', file);
    // The email normalisation and the newsletter token backfill do not touch
    // `products`, so they may record their own markers; the product-dependent
    // steps must not be marked done.
    assert.deepStrictEqual(Object.keys(broken.keysAfterFailure), ['backfill_newsletter_tokens_v1', 'normalize_emails_v1'],
      `a failed bootstrap must not record the failed steps' markers: ${JSON.stringify(broken)}`);
    assert.strictEqual(broken.products, 0, 'nothing should have been inserted by the failed attempt');

    const retried = runBootstrap('expect-seeded', file);
    assert.strictEqual(retried.products, demoProducts.DEMO_PRODUCTS.length, 'the retry must seed for real');
    assert.strictEqual(retried.keys.seed_products_v1, 'seeded');
  });

  await check('POST /api/admin/seed-demo restores the demo catalogue on purpose', async () => {
    // CSRF runs before requireAuth on admin writes (same as every other admin
    // mutation), so an anonymous request fails the CSRF check first.
    const noCsrf = await request(PORT, 'POST', '/api/admin/seed-demo');
    assert.strictEqual(noCsrf.status, 403, JSON.stringify(noCsrf.json));
    const csrfOnly = await getCsrf();
    const noSession = await request(PORT, 'POST', '/api/admin/seed-demo', {
      headers: { 'X-CSRF-Token': csrfOnly.token, Cookie: csrfOnly.cookie }
    });
    assert.strictEqual(noSession.status, 401, JSON.stringify(noSession.json));

    const first = await request(PORT, 'POST', '/api/admin/seed-demo', { headers: await adminHeaders() });
    assert.strictEqual(first.status, 200, JSON.stringify(first.json));
    assert.strictEqual(first.json.success, true);
    assert.strictEqual(first.json.added + first.json.skipped, demoProducts.DEMO_PRODUCTS.length,
      `every demo product must be accounted for: ${JSON.stringify(first.json)}`);

    // Empty the shop, then load the demo catalogue deliberately.
    const ids = (await request(PORT, 'GET', '/api/products')).json.map((p) => p.id);
    const emptied = await request(PORT, 'DELETE', '/api/products/batch', { body: { ids }, headers: await adminHeaders() });
    assert.strictEqual(emptied.status, 200, JSON.stringify(emptied.json));
    assert.strictEqual((await request(PORT, 'GET', '/api/products')).json.length, 0, 'the shop must be empty now');

    const restored = await request(PORT, 'POST', '/api/admin/seed-demo', { headers: await adminHeaders() });
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
    assert.strictEqual(restored.json.added, demoProducts.DEMO_PRODUCTS.length, 'every demo product must come back');
    const products = (await request(PORT, 'GET', '/api/products')).json;
    assert.strictEqual(products.length, demoProducts.DEMO_PRODUCTS.length);
    assert.ok(products.some(product => product.category === 'graphic-tees'), 'restored Graphic Tees retain the storefront category key');
    // The bootstrap markers are untouched by a deliberate re-seed.
    const markers = await dbModule.prepare('SELECT key FROM app_settings').all();
    assert.strictEqual(markers.length, 7, JSON.stringify(markers));
  });

  // ---------------------------------------------------------------
  // Email casing, shared logout, and reactivation stock checks
  // ---------------------------------------------------------------
  console.log('\nEmail casing, shared sessions and order reactivation:');

  await check('the email migration lowercases legacy rows and merges duplicates safely', async () => {
    const stamp = Date.now();
    // Legacy rows, inserted exactly as a pre-fix database could hold them:
    // mixed case, duplicated in different casings, orders already attributed.
    const olderCustomer = await dbModule.prepare('INSERT INTO customers (email, password_hash, name, email_verified, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Dup.Case@Kage.Test', await require('bcryptjs').hash('duppass1', 10), 'Older', 1, '2026-01-01 00:00:00');
    const newerCustomer = await dbModule.prepare('INSERT INTO customers (email, password_hash, name, email_verified, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('dup.case@kage.test', await require('bcryptjs').hash('duppass2', 10), 'Newer', 0, '2026-02-01 00:00:00');
    const olderId = Number(olderCustomer.lastInsertRowid);
    const newerId = Number(newerCustomer.lastInsertRowid);
    // The order was attributed to the NEWER duplicate — the merge must re-point it.
    await dbModule.prepare('INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal, shipping, shipping_pending, total, items_json, status, customer_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('KAGE-DUPCASE1', 'Dup Buyer', 'Dup.Case@Kage.Test', '03001112233', 'Dup St', 'Lahore', 'cod', 500, 0, 0, 500, '[]', 'pending', newerId, '2026-01-02 00:00:00');
    await dbModule.prepare('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)').run('News.Letter@Kage.Test', '2026-01-01 00:00:00');
    await dbModule.prepare('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)').run('news.letter@kage.test', '2026-02-01 00:00:00');
    await dbModule.prepare("DELETE FROM app_settings WHERE key = 'normalize_emails_v1'").run();

    await serverModule.bootstrapData();

    const dupCustomers = await dbModule.prepare('SELECT id, email, email_verified FROM customers WHERE LOWER(email) = ?').all('dup.case@kage.test');
    assert.strictEqual(dupCustomers.length, 1, `duplicate customer rows must be merged: ${JSON.stringify(dupCustomers)}`);
    assert.strictEqual(Number(dupCustomers[0].id), olderId, 'the OLDEST row must be kept');
    assert.strictEqual(dupCustomers[0].email, 'dup.case@kage.test', 'the kept row must be lowercased');
    assert.strictEqual(Number(dupCustomers[0].email_verified), 1, 'verification from the merged row must survive');
    const order = await dbModule.prepare('SELECT email, customer_id FROM orders WHERE order_number = ?').get('KAGE-DUPCASE1');
    assert.strictEqual(order.email, 'dup.case@kage.test', 'legacy order emails must be lowercased');
    assert.strictEqual(Number(order.customer_id), olderId, 'orders must be re-pointed to the surviving customer');
    const dupNews = await dbModule.prepare('SELECT id, email FROM newsletter_subscribers WHERE LOWER(email) = ?').all('news.letter@kage.test');
    assert.strictEqual(dupNews.length, 1, `duplicate newsletter rows must be merged: ${JSON.stringify(dupNews)}`);
    assert.strictEqual(dupNews[0].email, 'news.letter@kage.test');
    assert.ok(!/[\sA-Z]/.test(dupNews[0].email), 'no casing or padding may survive');
    const marker = await dbModule.prepare('SELECT value FROM app_settings WHERE key = ?').get('normalize_emails_v1');
    assert.ok(marker, 'the migration must record its run-once marker');

    // A second run is a no-op (nothing left to fix, no crash).
    await serverModule.bootstrapData();
    assert.strictEqual((await dbModule.prepare('SELECT COUNT(*) AS c FROM customers WHERE LOWER(email) = ?').get('dup.case@kage.test')).c, 1);

    // cleanup: these rows are only for this check
    await dbModule.prepare('DELETE FROM orders WHERE order_number = ?').run('KAGE-DUPCASE1');
    await dbModule.prepare('DELETE FROM customers WHERE LOWER(email) = ?').run('dup.case@kage.test');
    await dbModule.prepare('DELETE FROM newsletter_subscribers WHERE LOWER(email) = ?').run('news.letter@kage.test');
    void stamp;
  });

  await check('email lookups are case-insensitive for mixed-case legacy rows', async () => {
    // A newsletter row with casing, and a verified customer whose row was never
    // normalised — every lookup must still find them.
    await dbModule.prepare('INSERT INTO newsletter_subscribers (email, created_at) VALUES (?, ?)').run('Case.Only@Kage.Test', '2026-01-01 00:00:00');
    const cust = await dbModule.prepare('INSERT INTO customers (email, password_hash, name, email_verified, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('History.Legacy@Kage.Test', await require('bcryptjs').hash('legacypass1', 10), 'Legacy', 1, '2026-01-01 00:00:00');
    await dbModule.prepare('INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal, shipping, shipping_pending, total, items_json, status, customer_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('KAGE-LEGACY9', 'Legacy Buyer', 'History.Legacy@Kage.Test', '03001112244', 'Legacy St', 'Lahore', 'cod', 900, 0, 0, 900, JSON.stringify([{ id: 1, name: 'Legacy Tee', size: 'One Size', qty: 5, unit: 180, total: 900 }]), 'delivered', Number(cust.lastInsertRowid), '2026-01-03 00:00:00');

    // 1. newsletter: "already subscribed" instead of a second row
    const csrfNews = await getCsrf();
    const news = await request(PORT, 'POST', '/api/newsletter', {
      body: { email: 'case.only@kage.test' },
      headers: { 'X-CSRF-Token': csrfNews.token, Cookie: csrfNews.cookie }
    });
    assert.strictEqual(news.status, 200, JSON.stringify(news.json));
    assert.match(news.json.message, /already subscribed/i);
    assert.strictEqual(Number((await dbModule.prepare('SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE LOWER(email) = ?').get('case.only@kage.test')).c), 1);

    // 2. login with the lowercased address must find the mixed-case account
    const csrfLogin = await getCsrf();
    const login = await request(PORT, 'POST', '/api/customers/login', {
      body: { email: 'history.legacy@kage.test', password: 'legacypass1' },
      headers: { 'X-CSRF-Token': csrfLogin.token, Cookie: csrfLogin.cookie }
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.json));
    const history = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: cookieHeader(login) } });
    assert.strictEqual(history.status, 200, JSON.stringify(history.json));
    assert.ok(history.json.orders.some((o) => o.order_number === 'KAGE-LEGACY9'),
      `the mixed-case legacy order must appear in history: ${JSON.stringify(history.json.orders.map((o) => o.order_number))}`);

    // 3. clan: the legacy order's shirts must count
    const csrfClan = await getCsrf();
    const clan = await request(PORT, 'POST', '/api/clan-join', {
      body: { email: 'History.Legacy@Kage.Test' },
      headers: { 'X-CSRF-Token': csrfClan.token, Cookie: csrfClan.cookie }
    });
    assert.strictEqual(clan.status, 200, JSON.stringify(clan.json));
    assert.ok(Number(clan.json.total_shirts) >= 5, `clan total must include the legacy order: ${JSON.stringify(clan.json)}`);

    // 4. forgot-password must also find a mixed-case account row
    const csrfReset = await getCsrf();
    const reset = await request(PORT, 'POST', '/api/auth/forgot-password', {
      body: { email: 'history.legacy@kage.test', user_type: 'customer' },
      headers: { 'X-CSRF-Token': csrfReset.token, Cookie: csrfReset.cookie }
    });
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.json));

    await dbModule.prepare('DELETE FROM orders WHERE order_number = ?').run('KAGE-LEGACY9');
    await dbModule.prepare('DELETE FROM customers WHERE LOWER(email) = ?').run('history.legacy@kage.test');
    await dbModule.prepare('DELETE FROM newsletter_subscribers WHERE LOWER(email) IN (?, ?)').run('case.only@kage.test', 'history.legacy@kage.test');
  });

  await check('a mixed-case order reaches its verified customer and the clan total', async () => {
    const probe = await request(PORT, 'POST', '/api/products', {
      body: { name: 'Case Probe Tee', category: 'anime', price: 300, sizes: JSON.stringify(['One Size']), size_stock: JSON.stringify({ 'One Size': 40 }) },
      headers: await adminHeaders()
    });
    assert.strictEqual(probe.status, 201, JSON.stringify(probe.json));

    const signup = await captureEmailLog(() => signupCustomer('mixed.case@example.com', 'mixedcase1', 'Mixed Case'));
    assert.strictEqual(signup.result.res.status, 200, JSON.stringify(signup.result.res.json));
    const verifyUrl = extractVerifyUrl(signup.logged);
    assert.ok(verifyUrl, 'the signup must email a verification link');
    const token = new URL(verifyUrl).searchParams.get('token');
    const verified = await request(PORT, 'GET', `/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    assert.strictEqual(verified.status, 200, JSON.stringify(verified.json));

    const csrf = await getCsrf();
    const order = await request(PORT, 'POST', '/api/orders', {
      body: { name: 'Mixed Case', email: 'Mixed.Case@Example.com', phone: '03001112255', address: 'Case St', city: 'Lahore', payment_method: 'cod', items: [{ id: probe.json.id, qty: 5, size: 'One Size' }] },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(order.status, 201, JSON.stringify(order.json));
    const stored = await dbModule.prepare('SELECT email FROM orders WHERE order_number = ?').get(order.json.order_number);
    assert.strictEqual(stored.email, 'mixed.case@example.com', 'orders must store the email trimmed and lowercased');

    const csrfLogin = await getCsrf();
    const login = await request(PORT, 'POST', '/api/customers/login', {
      body: { email: 'Mixed.Case@Example.com', password: 'mixedcase1' },
      headers: { 'X-CSRF-Token': csrfLogin.token, Cookie: csrfLogin.cookie }
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.json));
    const history = await request(PORT, 'GET', '/api/customers/orders', { headers: { Cookie: cookieHeader(login) } });
    assert.strictEqual(history.status, 200, JSON.stringify(history.json));
    assert.ok(history.json.orders.some((o) => o.order_number === order.json.order_number),
      'the mixed-case order must show up in that verified customer\'s history');

    const csrfClan = await getCsrf();
    const clan = await request(PORT, 'POST', '/api/clan-join', {
      body: { email: 'Mixed.Case@Example.com' },
      headers: { 'X-CSRF-Token': csrfClan.token, Cookie: csrfClan.cookie }
    });
    assert.strictEqual(clan.status, 200, JSON.stringify(clan.json));
    assert.ok(Number(clan.json.total_shirts) >= 5, `the order must count toward the clan total: ${JSON.stringify(clan.json)}`);
  });

  await check('customer and admin logouts only clear their own identity', async () => {
    // A real browser jar: every Set-Cookie pair overrides its key, exactly like
    // Chrome does (cookie-session writes kage.session + kage.session.sig).
    const jar = {};
    const applyCookies = (res) => {
      (res.headers['set-cookie'] || []).forEach((c) => {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      });
    };
    const jarHeaders = () => ({
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      ...(jar['kage.csrf'] ? { 'X-CSRF-Token': jar['kage.csrf'] } : {})
    });

    applyCookies(await request(PORT, 'GET', '/api/products'));           // CSRF cookie
    applyCookies(await request(PORT, 'POST', '/api/admin/login', { body: { email: 'root@kage.test', password: 'supersecret1' } }));
    assert.strictEqual((await request(PORT, 'GET', '/api/admin/me', { headers: jarHeaders() })).status, 200, 'admin login must work');

    // The customer signs in in the same browser — one shared kage.session.
    applyCookies(await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'newpass456' }, headers: jarHeaders() }));
    assert.strictEqual((await request(PORT, 'GET', '/api/admin/me', { headers: jarHeaders() })).status, 200, 'both identities must be live');
    assert.strictEqual((await request(PORT, 'GET', '/api/customers/me', { headers: jarHeaders() })).status, 200, 'both identities must be live');

    // Customer logs out → the admin session must survive.
    const customerLogout = await request(PORT, 'POST', '/api/customers/logout', { headers: jarHeaders() });
    assert.strictEqual(customerLogout.status, 200, JSON.stringify(customerLogout.json));
    assert.ok(!/kage\.cust=/.test((customerLogout.headers['set-cookie'] || []).join(' | ')),
      'the dead kage.cust Set-Cookie must be gone (cookie was never set anywhere)');
    applyCookies(customerLogout);
    assert.strictEqual((await request(PORT, 'GET', '/api/admin/me', { headers: jarHeaders() })).status, 200,
      'logging the customer out must not log the admin out');
    const signedOutCustomer = await request(PORT, 'GET', '/api/customers/me', { headers: jarHeaders() });
    assert.strictEqual(signedOutCustomer.status, 200, 'session restore uses a non-error empty result for signed-out visitors');
    assert.deepStrictEqual(signedOutCustomer.json, { customer: null }, 'the customer session must be gone');

    // Admin logs out → the customer session must survive.
    applyCookies(await request(PORT, 'POST', '/api/customers/login', { body: { email: 'cust@kage.test', password: 'newpass456' }, headers: jarHeaders() }));
    assert.strictEqual((await request(PORT, 'GET', '/api/customers/me', { headers: jarHeaders() })).status, 200);
    applyCookies(await request(PORT, 'POST', '/api/admin/login', { body: { email: 'root@kage.test', password: 'supersecret1' }, headers: jarHeaders() }));
    const adminLogout = await request(PORT, 'POST', '/api/admin/logout', { headers: jarHeaders() });
    assert.strictEqual(adminLogout.status, 200, JSON.stringify(adminLogout.json));
    applyCookies(adminLogout);
    assert.strictEqual((await request(PORT, 'GET', '/api/customers/me', { headers: jarHeaders() })).status, 200,
      'logging the admin out must not log the customer out');
    assert.strictEqual((await request(PORT, 'GET', '/api/admin/me', { headers: jarHeaders() })).status, 401,
      'the admin session must be gone');
  });

  await check('reactivating a cancelled order is refused when the stock is gone', async () => {
    const createProbe = async (name, stock) => {
      const r = await request(PORT, 'POST', '/api/products', {
        body: { name, category: 'anime', price: 400, sizes: JSON.stringify(['One Size']), size_stock: JSON.stringify({ 'One Size': stock }) },
        headers: await adminHeaders()
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      return r.json;
    };
    const place = async (productId, qty, email) => {
      const csrf = await getCsrf();
      return request(PORT, 'POST', '/api/orders', {
        body: { name: 'Stock Probe', email, phone: '03001112266', address: 'Stock St', city: 'Lahore', payment_method: 'cod', items: [{ id: productId, qty, size: 'One Size' }] },
        headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
      });
    };

    // Sell out, cancel (stock returns), then sell every unit to another order.
    const soldOut = await createProbe('Reactivate Probe Tee', 4);
    const first = await place(soldOut.id, 4, 'reactivate.one@kage.test');
    assert.strictEqual(first.status, 201, JSON.stringify(first.json));
    const firstRow = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(first.json.order_number);
    assert.strictEqual((await request(PORT, 'PATCH', `/api/orders/${firstRow.id}/status`, { body: { status: 'cancelled' }, headers: await adminHeaders() })).status, 200);
    const afterCancel = await request(PORT, 'GET', `/api/products/${soldOut.id}`);
    assert.strictEqual(afterCancel.json.size_stock['One Size'], 4, 'cancelling must return the units');

    const second = await place(soldOut.id, 4, 'reactivate.two@kage.test');
    assert.strictEqual(second.status, 201, JSON.stringify(second.json));
    assert.strictEqual((await request(PORT, 'GET', `/api/products/${soldOut.id}`)).json.size_stock['One Size'], 0);

    const reactivate = await request(PORT, 'PATCH', `/api/orders/${firstRow.id}/status`, { body: { status: 'pending' }, headers: await adminHeaders() });
    assert.strictEqual(reactivate.status, 409, `expected 409, got ${reactivate.status} ${JSON.stringify(reactivate.json)}`);
    assert.match(reactivate.json.error, /Reactivate Probe Tee/, 'the message must name the product');
    assert.match(reactivate.json.error, /One Size/, 'the message must name the size');
    assert.match(reactivate.json.error, /4 needed/, 'the message must say how many are needed');
    assert.match(reactivate.json.error, /0 available/, 'the message must say how many are available');
    assert.strictEqual((await request(PORT, 'GET', `/api/products/${soldOut.id}`)).json.size_stock['One Size'], 0, 'stock must be unchanged');
    assert.strictEqual((await dbModule.prepare('SELECT status FROM orders WHERE id = ?').get(firstRow.id)).status, 'cancelled', 'the status must be unchanged');

    // Multi-line order: one line has stock, the other does not — nothing may be
    // partially applied.
    const mixedA = await createProbe('Reactivate Probe A', 5);
    const mixedB = await createProbe('Reactivate Probe B', 1);
    const csrfMulti = await getCsrf();
    const multi = await request(PORT, 'POST', '/api/orders', {
      body: { name: 'Stock Probe', email: 'reactivate.three@kage.test', phone: '03001112277', address: 'Stock St', city: 'Lahore', payment_method: 'cod',
        items: [{ id: mixedA.id, qty: 5, size: 'One Size' }, { id: mixedB.id, qty: 1, size: 'One Size' }] },
      headers: { 'X-CSRF-Token': csrfMulti.token, Cookie: csrfMulti.cookie }
    });
    assert.strictEqual(multi.status, 201, JSON.stringify(multi.json));
    const multiRow = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(multi.json.order_number);
    assert.strictEqual((await request(PORT, 'PATCH', `/api/orders/${multiRow.id}/status`, { body: { status: 'cancelled' }, headers: await adminHeaders() })).status, 200);
    // Take the units of B (the second line) elsewhere; A still has enough.
    const stealB = await place(mixedB.id, 1, 'reactivate.four@kage.test');
    assert.strictEqual(stealB.status, 201, JSON.stringify(stealB.json));
    const okStockA = (await request(PORT, 'GET', `/api/products/${mixedA.id}`)).json.size_stock['One Size'];
    const blocked = await request(PORT, 'PATCH', `/api/orders/${multiRow.id}/status`, { body: { status: 'pending' }, headers: await adminHeaders() });
    assert.strictEqual(blocked.status, 409, `expected 409, got ${blocked.status} ${JSON.stringify(blocked.json)}`);
    assert.match(blocked.json.error, /Reactivate Probe B/);
    assert.strictEqual((await request(PORT, 'GET', `/api/products/${mixedA.id}`)).json.size_stock['One Size'], okStockA, 'the line that COULD be re-taken must not be, either');
    assert.strictEqual((await dbModule.prepare('SELECT status FROM orders WHERE id = ?').get(multiRow.id)).status, 'cancelled');

    // With enough stock, reactivation still works.
    const plenty = await createProbe('Reactivate Probe C', 6);
    const last = await place(plenty.id, 2, 'reactivate.five@kage.test');
    assert.strictEqual(last.status, 201, JSON.stringify(last.json));
    const lastRow = await dbModule.prepare('SELECT id FROM orders WHERE order_number = ?').get(last.json.order_number);
    assert.strictEqual((await request(PORT, 'PATCH', `/api/orders/${lastRow.id}/status`, { body: { status: 'cancelled' }, headers: await adminHeaders() })).status, 200);
    assert.strictEqual((await request(PORT, 'GET', `/api/products/${plenty.id}`)).json.size_stock['One Size'], 6);
    const reopen = await request(PORT, 'PATCH', `/api/orders/${lastRow.id}/status`, { body: { status: 'pending' }, headers: await adminHeaders() });
    assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.json));
    assert.strictEqual((await request(PORT, 'GET', `/api/products/${plenty.id}`)).json.size_stock['One Size'], 4, 'reactivation must retake the units');
  });

  // ---------------------------------------------------------------
  // Newsletter one-click unsubscribe (CONTENT-2)
  // ---------------------------------------------------------------
  console.log('\nNewsletter unsubscribe:');
  await check('subscribe mints a token link; confirm page + POST unsubscribe; resubscribe restores', async () => {
    const csrf = await getCsrf();
    const post = (body) => request(PORT, 'POST', '/api/newsletter', {
      body, headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    const sub = await post({ email: 'Unsub.Probe@Kage.Test' });
    assert.strictEqual(sub.status, 200, JSON.stringify(sub.json));
    assert.match(sub.json.message, /welcome to the clan/i);
    assert.match(sub.json.unsubscribe_url, /^\/newsletter\/unsubscribe\?token=[0-9a-f]{48}$/);
    const token = sub.json.unsubscribe_url.split('token=')[1];
    const row = await dbModule.prepare('SELECT * FROM newsletter_subscribers WHERE LOWER(email) = ?').get('unsub.probe@kage.test');
    assert.strictEqual(row.unsubscribe_token, token);
    assert.ok(!row.unsubscribed, 'a new subscriber is active');

    // Already-subscribed returns the SAME link (self-service recovery).
    const again = await post({ email: 'unsub.probe@kage.test' });
    assert.match(again.json.message, /already subscribed/i);
    assert.strictEqual(again.json.unsubscribe_url, sub.json.unsubscribe_url);

    // Confirm page: missing / unknown / valid tokens.
    const missing = await request(PORT, 'GET', '/newsletter/unsubscribe');
    assert.strictEqual(missing.status, 400);
    assert.match(missing.headers['content-type'], /html/);
    const unknown = await request(PORT, 'GET', '/newsletter/unsubscribe?token=' + '0'.repeat(48));
    assert.strictEqual(unknown.status, 404);
    const confirm = await request(PORT, 'GET', '/newsletter/unsubscribe?token=' + token);
    assert.strictEqual(confirm.status, 200);
    assert.match(confirm.text, /Unsubscribe\?/);
    assert.ok(confirm.text.includes(token), 'the confirm form carries the token');
    assert.match(confirm.text, /un•••@kage\.test/, 'the address is masked');
    assert.doesNotMatch(confirm.text, /unsub\.probe@kage\.test/, 'the full address is not echoed');
    assert.strictEqual(confirm.headers['cache-control'], 'no-store');
    assert.ok(!(await dbModule.prepare('SELECT unsubscribed FROM newsletter_subscribers WHERE id = ?').get(row.id)).unsubscribed,
      'GET must not unsubscribe (mail-client prefetch safety)');

    // POST performs it; idempotent; validates the token.
    const doUnsub = await request(PORT, 'POST', '/api/newsletter/unsubscribe', { body: { token } });
    assert.strictEqual(doUnsub.status, 200, JSON.stringify(doUnsub.json));
    assert.ok((await dbModule.prepare('SELECT unsubscribed FROM newsletter_subscribers WHERE id = ?').get(row.id)).unsubscribed);
    const doUnsubAgain = await request(PORT, 'POST', '/api/newsletter/unsubscribe', { body: { token } });
    assert.strictEqual(doUnsubAgain.status, 200);
    const badToken = await request(PORT, 'POST', '/api/newsletter/unsubscribe', { body: { token: 'nope' } });
    assert.strictEqual(badToken.status, 404);
    const noToken = await request(PORT, 'POST', '/api/newsletter/unsubscribe', { body: {} });
    assert.strictEqual(noToken.status, 400);

    // The confirm page now reports the settled state.
    const settled = await request(PORT, 'GET', '/newsletter/unsubscribe?token=' + token);
    assert.strictEqual(settled.status, 200);
    assert.match(settled.text, /Already unsubscribed/);

    // Resubscribing clears the flag and keeps the same token.
    const back = await post({ email: 'unsub.probe@kage.test' });
    assert.match(back.json.message, /welcome back/i);
    assert.strictEqual(back.json.unsubscribe_url, sub.json.unsubscribe_url);
    assert.ok(!(await dbModule.prepare('SELECT unsubscribed FROM newsletter_subscribers WHERE id = ?').get(row.id)).unsubscribed);
  });

  await check('legacy tokenless rows are repaired on subscribe and by the bootstrap backfill', async () => {
    await dbModule.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run('legacy.tokenless@kage.test');
    const csrf = await getCsrf();
    const repair = await request(PORT, 'POST', '/api/newsletter', {
      body: { email: 'legacy.tokenless@kage.test' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(repair.status, 200);
    assert.match(repair.json.unsubscribe_url, /token=[0-9a-f]{48}$/);
    const repaired = await dbModule.prepare('SELECT unsubscribe_token FROM newsletter_subscribers WHERE email = ?').get('legacy.tokenless@kage.test');
    assert.match(repaired.unsubscribe_token, /^[0-9a-f]{48}$/, 'lazy repair persists the token');

    // Bootstrap backfill: drop the marker, add another legacy row, re-run.
    await dbModule.prepare('INSERT INTO newsletter_subscribers (email) VALUES (?)').run('legacy.backfill@kage.test');
    await dbModule.prepare('DELETE FROM app_settings WHERE key = ?').run('backfill_newsletter_tokens_v1');
    assert.strictEqual(await serverModule.bootstrapData(), true);
    const filled = await dbModule.prepare('SELECT unsubscribe_token FROM newsletter_subscribers WHERE email = ?').get('legacy.backfill@kage.test');
    assert.match(filled.unsubscribe_token, /^[0-9a-f]{48}$/, 'boot backfill fills tokenless rows');
    assert.ok(await dbModule.getSetting('backfill_newsletter_tokens_v1'), 'the step records its marker');
    // Idempotent: the minted token survives a second run.
    await dbModule.prepare('DELETE FROM app_settings WHERE key = ?').run('backfill_newsletter_tokens_v1');
    assert.strictEqual(await serverModule.bootstrapData(), true);
    const kept = await dbModule.prepare('SELECT unsubscribe_token FROM newsletter_subscribers WHERE email = ?').get('legacy.backfill@kage.test');
    assert.strictEqual(kept.unsubscribe_token, filled.unsubscribe_token);
  });

  // ---------------------------------------------------------------
  // Per-account login lockouts (shared rate_limits table)
  // ---------------------------------------------------------------
  console.log('\nLogin lockouts:');
  await check('admin lockout is per email, counts bad credentials only, resets on success, and returns Retry-After', async () => {
    for (const account of [
      { email: 'lockout.admin@kage.test', password: 'lockout-secret1' },
      { email: 'unlocked.admin@kage.test', password: 'unlocked-secret1' }
    ]) {
      const created = await request(PORT, 'POST', '/api/admin/create', { body: account, headers: await adminHeaders() });
      assert.strictEqual(created.status, 200, JSON.stringify(created.json));
    }

    const missing = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'lockout.admin@kage.test' } });
    assert.strictEqual(missing.status, 400, 'missing credentials must not count as a password failure');
    const wrong = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'Lockout.Admin@Kage.Test', password: 'wrong-password' } });
    const unknown = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'unknown.admin@kage.test', password: 'wrong-password' } });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(unknown.status, 401);
    assert.deepStrictEqual(unknown.json, wrong.json, 'unknown emails and wrong passwords must have the same response shape');

    // Three more failures gives four total; the valid password on the next
    // attempt must succeed and clear the counter before a fresh sequence.
    for (let i = 0; i < 3; i++) {
      const failed = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'lockout.admin@kage.test', password: 'wrong-password' } });
      assert.strictEqual(failed.status, 401, `failure ${i + 2} should not lock yet`);
    }
    const success = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'LOCKOUT.ADMIN@KAGE.TEST', password: 'lockout-secret1' } });
    assert.strictEqual(success.status, 200, JSON.stringify(success.json));

    for (let i = 0; i < 4; i++) {
      const failed = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'lockout.admin@kage.test', password: 'wrong-password' } });
      assert.strictEqual(failed.status, 401, `post-success failure ${i + 1} should start a fresh counter`);
    }
    const locked = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'lockout.admin@kage.test', password: 'wrong-password' } });
    assert.strictEqual(locked.status, 429, JSON.stringify(locked.json));
    assert.match(locked.json.error, /too many attempts/i);
    assert.ok(Number(locked.headers['retry-after']) >= 899, `expected a 15-minute Retry-After, got ${locked.headers['retry-after']}`);

    const stillLocked = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'lockout.admin@kage.test', password: 'lockout-secret1' } });
    assert.strictEqual(stillLocked.status, 429, 'a locked email stays locked even with the correct password');
    const other = await request(PORT, 'POST', '/api/admin/login', { body: { email: 'unlocked.admin@kage.test', password: 'unlocked-secret1' } });
    assert.strictEqual(other.status, 200, 'another admin email remains unaffected');
  });

  await check('customer login locks after ten failures without affecting another email', async () => {
    const created = await signupCustomer('lockout.customer@kage.test', 'customer-secret1', 'Lockout Customer');
    assert.strictEqual(created.res.status, 200, JSON.stringify(created.res.json));
    const otherCreated = await signupCustomer('unlocked.customer@kage.test', 'customer-secret2', 'Other Customer');
    assert.strictEqual(otherCreated.res.status, 200, JSON.stringify(otherCreated.res.json));
    const csrf = await getCsrf();
    for (let i = 0; i < 9; i++) {
      const failed = await request(PORT, 'POST', '/api/customers/login', {
        body: { email: 'Lockout.Customer@Kage.Test', password: 'wrong-password' },
        headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
      });
      assert.strictEqual(failed.status, 401, `customer failure ${i + 1} should not lock yet`);
    }
    const locked = await request(PORT, 'POST', '/api/customers/login', {
      body: { email: 'lockout.customer@kage.test', password: 'wrong-password' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(locked.status, 429, JSON.stringify(locked.json));
    assert.ok(Number(locked.headers['retry-after']) >= 899, `expected a 15-minute Retry-After, got ${locked.headers['retry-after']}`);
    const other = await request(PORT, 'POST', '/api/customers/login', {
      body: { email: 'unlocked.customer@kage.test', password: 'customer-secret2' },
      headers: { 'X-CSRF-Token': csrf.token, Cookie: csrf.cookie }
    });
    assert.strictEqual(other.status, 200, 'another customer email remains unaffected');
  });

  // ---------------------------------------------------------------
  // Session secret: one rule for the whole app (utils/secret.js)
  // ---------------------------------------------------------------
  console.log('\nSession secret resolution:');

  const SECRET_MODULE = path.join(REPO_ROOT, 'utils', 'secret.js');
  const SECRET_CALL = `const { getSessionSecret } = require(${JSON.stringify(SECRET_MODULE)}); console.log('VALUE:' + getSessionSecret());`;
  const runNode = (env, args) => spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000, env: cleanEnv(env) });

  await check('no NODE_ENV and no SESSION_SECRET → throws "SESSION_SECRET is required"', async () => {
    const r = runNode({}, ['-e', SECRET_CALL]);
    assert.notStrictEqual(r.status, 0, 'the module call must throw');
    assert.match(r.stderr, /SESSION_SECRET is required/);
    assert.match(r.stderr, /randomBytes\(48\)/, 'the error must show how to generate one');
  });

  await check('a SESSION_SECRET shorter than 32 characters → throws', async () => {
    const short = runNode({ SESSION_SECRET: '1234567890' }, ['-e', SECRET_CALL]);
    assert.notStrictEqual(short.status, 0);
    assert.match(short.stderr, /at least 32 characters/);
    // …and exactly 32 is accepted.
    const exact = runNode({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }, ['-e', SECRET_CALL]);
    assert.strictEqual(exact.status, 0, exact.stderr);
    assert.ok(exact.stdout.includes('VALUE:' + 'x'.repeat(32)));
  });

  await check('NODE_ENV=production with a 48-char secret → works', async () => {
    const secret = crypto.randomBytes(24).toString('hex'); // 48 chars
    const r = runNode({ NODE_ENV: 'production', SESSION_SECRET: secret }, ['-e', SECRET_CALL]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('VALUE:' + secret), 'the configured secret must be used verbatim');
  });

  await check('NODE_ENV=development with no secret → dev fallback, other envs refuse', async () => {
    const dev = runNode({ NODE_ENV: 'development' }, ['-e', SECRET_CALL]);
    assert.strictEqual(dev.status, 0, dev.stderr);
    assert.ok(dev.stdout.includes('VALUE:' + require('../utils/secret').DEV_FALLBACK_SECRET));
    for (const env of ['staging', 'Production', 'prod', '']) {
      const r = runNode(env ? { NODE_ENV: env } : {}, ['-e', SECRET_CALL]);
      assert.notStrictEqual(r.status, 0, `NODE_ENV=${JSON.stringify(env)} must not get a fallback`);
      assert.match(r.stderr, /SESSION_SECRET is required/);
    }
  });

  await check('node server.js refuses to boot without SESSION_SECRET (clear message)', async () => {
    const r = runNode({}, ['server.js']);
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stderr, /^FATAL: SESSION_SECRET is required/);
    assert.ok(!/KAGE CULTURE — Admin System/.test(r.stdout), 'the server must not have started');
  });

  await check('a cookie signed with the old public fallback is rejected (401)', async () => {
    const { DEV_FALLBACK_SECRET } = require('../utils/secret');
    const payload = Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64');
    const sig = crypto.createHmac('sha256', DEV_FALLBACK_SECRET).update(payload).digest('base64');
    const forged = `${payload}.${sig}`;
    const res = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${forged}` } });
    assert.strictEqual(res.status, 401, JSON.stringify(res.json));
  });

  await check('standalone kage.session payloads are ignored without cookie-session middleware state', async () => {
    const secret = require('../utils/secret').getSessionSecret();
    const payload = Buffer.from(JSON.stringify({ adminId: 1 })).toString('base64');
    const unsigned = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${payload}` } });
    assert.strictEqual(unsigned.status, 401, 'an unsigned payload must never pass');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    const detached = await request(PORT, 'GET', '/api/admin/me', { headers: { Cookie: `kage.session=${payload}.${sig}` } });
    assert.strictEqual(detached.status, 401, 'a raw signature without cookie-session state must not authorize');
  });

  // ---------------------------------------------------------------
  // Serverless readiness: a failed boot must never be cached forever
  // ---------------------------------------------------------------
  console.log('\nServer boot retry:');

  await check('a transient db boot failure → 503 + Retry-After, then 200 after the backoff', async () => {
    const serverModule = require('../server.js');
    const express = require('express');
    const config = require('../config');
    const realInit = dbModule.init;
    const realBackoff = config.READY_RETRY_BACKOFF_MS;
    config.READY_RETRY_BACKOFF_MS = 250; // same rule, shorter window for the suite
    let attempts = 0;
    let failOnce = true;
    const rejections = [];
    const onRejection = (reason) => rejections.push(String(reason));
    process.on('unhandledRejection', onRejection);

    // Mock a cold start against a briefly unreachable database.
    dbModule.init = async (...args) => {
      attempts += 1;
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated outage at libsql://secret-host.turso.io?authToken=leak');
      }
      return realInit.apply(dbModule, args);
    };

    const routesBefore = app._router.stack.length;
    const productsBefore = (await request(PORT, 'GET', '/api/products')).json.length;
    const gateApp = express();
    gateApp.use(serverModule.readinessGate);
    gateApp.get('/api/probe', (req, res) => res.json({ ok: true }));
    const gateServer = gateApp.listen(0);
    const gatePort = gateServer.address().port;
    try {
      const first = await request(gatePort, 'GET', '/api/probe');
      assert.strictEqual(first.status, 503, JSON.stringify(first.json));
      assert.strictEqual(first.headers['retry-after'], '1', 'the 503 must carry Retry-After');
      assert.ok(first.json && typeof first.json.error === 'string', 'the 503 must be JSON');
      assert.ok(!/turso|libsql|authToken|secret-host|\bat .*\.js:\d/i.test(JSON.stringify(first.json)),
        'the 503 must not leak internals: ' + JSON.stringify(first.json));
      assert.strictEqual(attempts, 1, 'the first request must try to boot');

      // Two requests INSIDE the backoff window: still 503, still one attempt.
      const second = await request(gatePort, 'GET', '/api/probe');
      const third = await request(gatePort, 'GET', '/api/probe');
      assert.strictEqual(second.status, 503);
      assert.strictEqual(third.status, 503);
      assert.strictEqual(attempts, 1, 'requests inside the backoff window must not re-hit the database');
      assert.strictEqual(third.headers['retry-after'], '1');

      await sleep(config.READY_RETRY_BACKOFF_MS + 50);
      const fourth = await request(gatePort, 'GET', '/api/probe');
      assert.strictEqual(fourth.status, 200, `the retry after the backoff must succeed: ${JSON.stringify(fourth.json)}`);
      assert.strictEqual(fourth.json.ok, true);
      assert.strictEqual(attempts, 2, 'exactly one retry after the backoff');

      assert.deepStrictEqual(rejections, [], 'no unhandled rejection may be emitted: ' + rejections.join('; '));
      // A retried boot must not double-register routes or re-seed products.
      assert.strictEqual(app._router.stack.length, routesBefore, 'routes must not be registered twice');
      assert.strictEqual((await request(PORT, 'GET', '/api/products')).json.length, productsBefore, 'products must not be re-seeded');
      assert.strictEqual(dbModule._initialized, true, 'a successful boot leaves the db flagged ready');
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      dbModule.init = realInit;
      config.READY_RETRY_BACKOFF_MS = realBackoff;
      await new Promise((r) => gateServer.close(r));
    }
  });

  await check('a permanently failing db keeps answering 503 without crashing', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'db-down-serverless-child.js');
    const child = spawnSync(process.execPath, [fixture], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000, env: cleanEnv({}) });
    assert.strictEqual(child.status, 0, `child exited ${child.status}\nstdout: ${child.stdout}\nstderr: ${child.stderr}`);
    const line = child.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    assert.ok(line, `the child must report its results:\n${child.stdout}\n${child.stderr}`);
    const out = JSON.parse(line);
    assert.strictEqual(out.all503, true, JSON.stringify(out));
    assert.strictEqual(out.bodyLeaks, false, 'no 503 body may leak internals');
    assert.strictEqual(out.crawlerFallback, true, 'sitemap and robots must serve static crawler content during DB failure');
    assert.deepStrictEqual(out.crawlerStatuses, [200, 200]);
    assert.strictEqual(out.unhandled, 0, 'no unhandled rejection may be emitted');
    assert.strictEqual(out.alive, true, 'the process must survive');
    assert.deepStrictEqual(out.statuses, [503, 503, 503, 503, 503], JSON.stringify(out));

    // The failed boot must NOT be cached: the burst inside the window shares one
    // attempt, and the request after the window triggers a fresh one. The old
    // one-shot promise produced exactly one "Turso init failed" line, ever.
    const attempts = (child.stdout + child.stderr).match(/Turso init failed/g) || [];
    assert.ok(attempts.length >= 2, `the boot must be retried after a failure (saw ${attempts.length} attempts)`);
    assert.ok(attempts.length <= 3, `attempts must stay bounded by the backoff (saw ${attempts.length})`);
  });

  // ---------------------------------------------------------------
  await new Promise((r) => server.close(r));
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f[0]).join(', ')); process.exit(1); }
  process.exit(0);
}

// Fetch + echo a CSRF token from the dedicated no-store endpoint. The public
// cacheable reads deliberately never send Set-Cookie, so this is the endpoint a
// cookie-less client uses before its first state-changing request.
// Returns { cookie, token } — both must accompany the mutating request.
async function getCsrf() {
  const r = await request(PORT, 'GET', '/api/csrf');
  const sc = (r.headers['set-cookie'] || []).find((c) => c.startsWith('kage.csrf='));
  if (!sc) throw new Error('no CSRF cookie issued');
  const cookie = sc.split(';')[0];
  return { cookie, token: cookie.split('=')[1] };
}

main().catch((e) => { console.error(e); process.exit(1); });
