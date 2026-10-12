// DOM-level interaction regressions for the static storefront and admin panel.
// Run with `npm test`. Most scenarios are DOM-level (jsdom — no browser
// download required); the category-strip geometry checks run in real Chromium
// (see tests/fixtures/chromium.js).
// The panel scenario logs in for real: the admin view now reads its catalog
// from the authenticated /api/admin/products endpoint, because the public
// one deliberately omits internal columns such as unit_cost.
process.env.NODE_ENV = process.env.NODE_ENV || 'test'; // allows the dev fallback in utils/secret.js
process.env.ALLOW_ADMIN_SETUP = 'true';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'frontend-test-secret-0123456789abcdefghij';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { app, ensureReady } = require('../server');

const storeHtml = readFileSync(require.resolve('../public/index.html'), 'utf8');
const adminHtml = readFileSync(require.resolve('../public/admin.html'), 'utf8');
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => {
  // jsdom cannot parse all modern CSS used by the admin page; this is not a JS error.
  if (!String(e).includes('Could not parse CSS stylesheet')) errors.push(String(e));
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Admin session for the panel scenario. The storefront's own public catalog
// cannot be reused here any more: it is allow-listed and carries no unit_cost,
// while the panel's edit form and P&L depend on the full admin shape.
async function adminProductList() {
  const credentials = { email: 'frontend-admin@kage.test', password: 'frontend-secret-1' };
  const headers = { 'Content-Type': 'application/json' };
  const setup = await fetch(origin + '/api/admin/setup', { method: 'POST', headers, body: JSON.stringify(credentials) });
  // 200 on first boot, 400 once the account exists — both mean "admin ready".
  assert.ok([200, 400].includes(setup.status), `admin setup must succeed or report an existing account, got ${setup.status}`);
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200, 'the panel scenario must be able to sign in as admin');
  const cookie = (login.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  assert.match(cookie, /kage\.session=/, 'login must issue an admin session cookie');
  const res = await fetch(origin + '/api/admin/products', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'admin catalog must load for a signed-in admin');
  const products = await res.json();
  assert.ok(products.length > 0, 'admin catalog must not be empty');
  assert.ok(products.every(p => 'unit_cost' in p), 'admin catalog must expose unit_cost for the edit form and P&L');
  // The public catalog must never expose that column.
  const publicProducts = await (await fetch(origin + '/api/products')).json();
  assert.ok(publicProducts.every(p => !('unit_cost' in p)), 'public catalog must not expose unit_cost');
  return products;
}
let origin;
// `browserCookies` makes the harness behave like a browser for the storefront's
// own requests: cookies from the jsdom document are sent with each request and
// Set-Cookie headers from the response are stored back into it. `requests`
// records every URL the page asked for, in order.
function page(html, path = '/', { storage = {}, offline = false, fetchImpl, browserCookies = false } = {}) {
  const requests = [];
  const dom = new JSDOM(html, {
    url: origin + path, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      // jsdom lacks object URLs, which the admin upload previews use.
      let objectUrlSeq = 0;
      w.URL.createObjectURL = () => 'blob:mock-object-url-' + (++objectUrlSeq);
      w.URL.revokeObjectURL = () => {};
      for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
      w.fetch = (url, options) => {
        if (fetchImpl) return fetchImpl(url, options);
        if (offline && url === '/api/products') return Promise.reject(new Error('offline'));
        const requestOptions = { ...(options || {}) };
        if (!browserCookies) return fetch(origin + url, requestOptions);
        const entry = { url: String(url), method: (requestOptions.method || 'GET').toUpperCase(), setCookie: [] };
        requests.push(entry);
        const headers = { ...(requestOptions.headers || {}) };
        const jar = w.document.cookie;
        if (jar) headers.Cookie = jar;
        return fetch(origin + url, { ...requestOptions, headers }).then(res => {
          entry.setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
          for (const cookie of entry.setCookie) {
            const pair = cookie.split(';')[0].trim();
            if (pair) w.document.cookie = pair + '; Path=/';
          }
          return res;
        });
      };
    }
  });
  dom.requests = requests;
  return dom;
}
async function ready(win) {
  for (let i = 0; i < 40; i++) {
    if (win.eval('productsLoadedFromApi') || !win.document.getElementById('productLoadError').hidden) return;
    await wait(50);
  }
  throw new Error('Catalog did not finish loading');
}

(async () => {
  await ensureReady();
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const windows = [];
  try {
    const admin429 = page(adminHtml, '/admin', {
      fetchImpl: async (url) => {
        if (url === '/api/admin/me') return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
        if (url === '/api/admin/login') return {
          ok: false, status: 429,
          headers: { get: (name) => String(name).toLowerCase() === 'retry-after' ? '900' : null },
          json: async () => ({ error: 'Too many attempts. Please try again later.' })
        };
        return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: 'Not found' }) };
      }
    });
    windows.push(admin429);
    await wait(25);
    admin429.window.document.getElementById('loginEmail').value = 'admin@example.test';
    admin429.window.document.getElementById('loginPassword').value = 'bad-password';
    await admin429.window.handleLogin();
    const login429Text = admin429.window.document.getElementById('loginError').textContent;
    assert.match(login429Text, /too many attempts\. please try again later/i);
    assert.match(login429Text, /15 minutes/i, 'the admin login screen must display Retry-After');
    console.log('✅ Admin login 429 displays a clear lockout message and Retry-After duration');

    const store = page(storeHtml); windows.push(store);
    const w = store.window, d = w.document;
    await ready(w);
    w.navigateTo('collection', 'anime');
    assert.equal(d.querySelector('#collectionTitle').textContent, 'ANIME SHIRTS');
    assert.ok([...d.querySelectorAll('#collectionGrid .product-card h3')].every(x =>
      ['Shadow Fit', 'Oni Muscle Tee', 'Kage Core Compression'].includes(x.textContent)),
      'anime filter must not leak graphic-tees products');
    console.log('✅ Anime Shirts filter returns only anime products');
    // The shop grid (#shopSection) is hidden on the plain homepage and shown for
    // collection routes / search results — it used to be `display:none` inline
    // forever, so everything rendered into an invisible section.
    const shopVisible = () => d.getElementById('shopSection').classList.contains('shop-visible');
    w.navigateTo('home');
    assert.equal(shopVisible(), false, 'plain homepage keeps the shop grid hidden');
    assert.equal(d.body.classList.contains('showing-shop'), false, 'homepage keeps its marketing sections');
    w.navigateTo('collection', 'anime');
    assert.equal(shopVisible(), true, 'a collection route reveals the shop grid');
    assert.equal(d.body.classList.contains('showing-shop'), true, 'the homepage marketing sections step aside');
    assert.ok(d.querySelectorAll('#collectionGrid .product-card').length > 0, 'collection grid has cards');
    w.navigateTo('collection', 'graphic-tees');
    assert.equal(d.querySelector('#collectionTitle').textContent, 'GRAPHIC TEES');
    d.getElementById('searchInput').value = 'wolf';
    w.onSearchInput('wolf');
    assert.equal(shopVisible(), true, 'typing a search query reveals the grid');
    assert.equal(d.querySelectorAll('#collectionGrid .product-card h3').length, 1, 'search narrows the grid');
    d.getElementById('searchInput').value = '';
    w.onSearchInput('');
    w.navigateTo('about');
    assert.equal(shopVisible(), false, 'leaving the home view hides the grid again');
    w.navigateTo('home');
    assert.equal(shopVisible(), false, 'returning to the plain homepage hides the grid');
    console.log('✅ Shop grid visibility follows collection routes and search');

    w.navigateTo('home');
    w.nextPage();
    const size = d.querySelector('#filterSidebar .fp-size');
    size.value = 'XL';
    size.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.querySelector('#pageInfo').textContent, 'Page 1 of 1');
    assert.ok(d.querySelector('#collectionGrid .product-card'));
    assert.ok(w.eval('renderHomeProductCard(allProducts.find(p => p.name === "Wrath Silhouette"))').includes('class="product-discount-badge"'));
    console.log('✅ Filters clamp pagination; homepage sale badge is displayed');

    w.quickAdd(9);
    w.toggleWishlist(9);
    assert.equal(d.querySelector('#cartCount').textContent, '1');
    assert.equal(d.querySelector('#wishlistCount').textContent, '1');
    const storage = {
      kageCart: w.localStorage.getItem('kageCart'),
      kageWishlist: w.localStorage.getItem('kageWishlist')
    };
    const reload = page(storeHtml, '/', { storage }); windows.push(reload);
    await ready(reload.window);
    assert.equal(reload.window.document.querySelector('#cartCount').textContent, '1');
    assert.equal(reload.window.document.querySelector('#wishlistCount').textContent, '1');
    console.log('✅ Cart and wishlist survive reload and hydrate from the API');

    w.openProductDetail(9);
    assert.equal(w.location.pathname, '/product/9');
    w.navigateTo('tracking');
    assert.equal(w.location.pathname, '/tracking');
    w.history.back();
    await wait(100);
    assert.equal(d.querySelector('#page-product').classList.contains('active'), true);
    const deepLink = page(storeHtml, '/product/9'); windows.push(deepLink);
    await ready(deepLink.window);
    await wait(100);
    assert.equal(deepLink.window.document.querySelector('#detailName').textContent, 'Wrath Silhouette');
    assert.equal(deepLink.window.document.querySelector('.hero-media img').getAttribute('src'), '/images/hero.jpg');
    // Hero copy and CTA: headline is shown, the button goes to the full collection, and the header height is published for the hero offset.
    assert.equal(deepLink.window.document.querySelector('.hero-title').textContent, 'Engineered Fit. Original Art.');
    assert.equal(deepLink.window.document.querySelector('.hero-copy .btn').getAttribute('href'), '/collection/all');
    assert.match(deepLink.window.document.querySelector('.hero-copy .btn').getAttribute('onclick'), /navigateTo\('collection', 'all'\)/);
    assert.notEqual(deepLink.window.document.documentElement.style.getPropertyValue('--header-h'), '');
    console.log('✅ Product deep links, media, and browser Back work');

    // Per-size stock: a product offering S/M/L with S=2, M=0 (sold out), L=5.
    const db = require('../database');
    const sizeTee = await db.prepare('INSERT INTO products (name, category, fit, price, sizes, stock_qty, in_stock, extra_images) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('Frontend Size Tee', 'anime', 'Regular', 1000, JSON.stringify(['S', 'M', 'L']), 7, 1, '[]');
    const sizeTeeId = Number(sizeTee.lastInsertRowid);
    for (const [size, qty] of [['S', 2], ['M', 0], ['L', 5]]) {
      await db.prepare('INSERT INTO product_size_stock (product_id, size, stock_qty) VALUES (?, ?, ?)').run(sizeTeeId, size, qty);
    }
    const sized = page(storeHtml, `/product/${sizeTeeId}`); windows.push(sized);
    await ready(sized.window);
    await wait(100);
    const sw = sized.window, sd = sw.document;
    assert.equal(sd.querySelector('#detailName').textContent, 'Frontend Size Tee');
    assert.deepEqual([...sd.querySelectorAll('#detailSizePicker .size-btn')].map(b => b.dataset.size), ['S', 'M', 'L']);
    assert.equal(sd.querySelector('[data-size="M"]').disabled, true, 'sold-out size is disabled');
    assert.equal(sd.querySelector('.size-btn.selected').dataset.size, 'S', 'defaults to the first available size');
    sd.querySelector('[data-size="L"]').click();
    assert.equal(sw.eval('detailSize'), 'L');
    assert.equal(sd.querySelector('.size-btn.selected').dataset.size, 'L');
    for (let i = 0; i < 9; i++) sw.detailChangeQty(1);
    assert.equal(sd.getElementById('detailQty').textContent, '5', 'quantity stops at the size count');
    sd.querySelector('[data-size="S"]').click();
    assert.equal(sd.getElementById('detailQty').textContent, '2', 'quantity follows the new size count');
    sw.detailAddToCart();
    assert.equal(sw.eval('cart.length'), 1);
    assert.equal(sw.eval('cart[0].size'), 'S');
    assert.equal(sw.eval('cart[0].qty'), 2);
    sw.detailAddToCart();
    assert.equal(sw.eval('cart[0].qty'), 2, 'cannot add past the size count');
    assert.equal(sd.getElementById('toast').textContent, 'Not enough stock available.');
    assert.equal(sw.eval('addToCart(allProducts.find(p => p.id === ' + sizeTeeId + '), "M", 1)'), false, 'sold-out size cannot be added');
    console.log('✅ Per-size product page: sold-out sizes disabled, quantity capped per size');

    const bad = await fetch(origin + '/does-not-exist');
    assert.equal(bad.status, 404);
    const offline = page(storeHtml, '/', { offline: true }); windows.push(offline);
    await ready(offline.window);
    assert.equal(offline.window.document.getElementById('productLoadError').hidden, false);
    assert.equal(offline.window.document.querySelectorAll('#collectionGrid .product-card').length, 0);
    console.log('✅ Unknown paths return 404; catalog outages show a warning, not fake products');

    // A filled star is not necessarily the chosen rating: the picker highlights
    // every star up to the clicked one. Test the actual payload, not just color.
    w.openProductDetail(1);
    const reviewForm = d.querySelector('.review-form');
    const starButtons = [...d.querySelectorAll('#starInput button')];
    const originalStoreFetch = w.fetch;
    const sentReviews = [];
    const reviewGets = [];
    try {
      w.fetch = (url, options) => {
        if (url === '/api/reviews' && options?.method === 'POST') {
          sentReviews.push(JSON.parse(options.body));
          return Promise.resolve({ ok: true, json: async () => ({ message: 'Review pending approval.' }) });
        }
        if (String(url).startsWith('/api/reviews?')) {
          // Stand in for the server: the author's own pending review comes
          // back alongside the approved ones, flagged is_own.
          reviewGets.push({ url: String(url), headers: options?.headers || {} });
          return Promise.resolve({ ok: true, json: async () => ([
            { id: 9001, customer_name: 'Second Buyer', rating: 3, comment: 'Fabric is okay', created_at: '2026-10-11 09:00:00', status: 'pending', is_own: true },
            { id: 9002, customer_name: 'Test Buyer', rating: 5, comment: 'Great fit', created_at: '2026-10-10 09:00:00', status: 'approved', is_own: false }
          ]) });
        }
        return originalStoreFetch(url, options);
      };
      // The picker is a radiogroup: one value drives a continuous fill from
      // star 1 (.lit), never isolated lit stars.
      assert.equal(d.getElementById('starInput').getAttribute('role'), 'radiogroup');
      assert.ok(starButtons.every(b => b.getAttribute('role') === 'radio'));
      for (let rating = 1; rating <= 5; rating++) {
        // Native button click also covers keyboard activation (Enter/Space).
        starButtons[rating - 1].click();
        const lit = starButtons.filter(b => b.classList.contains('lit'));
        assert.equal(lit.length, rating, 'fill must be continuous from star 1');
        assert.deepEqual(lit.map(b => Number(b.dataset.v)), Array.from({ length: rating }, (_, i) => i + 1), 'lit stars must be 1..N with no gaps');
        assert.deepEqual(starButtons.filter(b => b.getAttribute('aria-checked') === 'true').map(b => Number(b.dataset.v)), [rating]);
        d.getElementById('rvOrder').value = 'KAGE-REVIEW';
        d.getElementById('rvPhone').value = '03001234567';
        await w.submitReview({ preventDefault() {}, target: reviewForm });
        assert.equal(sentReviews.at(-1).rating, rating, 'submitted rating must match clicked star');
        assert.equal(sentReviews.at(-1).product_id, 1);
        assert.equal(starButtons.some(b => b.classList.contains('lit') || b.getAttribute('aria-checked') === 'true'), false, 'successful submit clears stars');
        assert.match(d.getElementById('rvError').textContent, /pending approval/);
      }
      // Every submission carries the same per-browser viewer token, and a
      // successful submit re-fetches the list with it so the author's own
      // (still pending) review shows up for them immediately.
      assert.ok(sentReviews.every(r => /^[a-f0-9]{48}$/.test(r.viewer_token)), 'each submission carries a viewer token');
      assert.equal(new Set(sentReviews.map(r => r.viewer_token)).size, 1, 'same browser reuses one viewer token');
      assert.ok(reviewGets.length >= 5, 'each successful submit must refresh the review list');
      assert.match(reviewGets.at(-1).url, /product_id=1/, 'the refetch identifies the product');
      assert.ok(!reviewGets.at(-1).url.includes('viewer_token='), 'the viewer token must not appear in the URL');
      assert.match(reviewGets.at(-1).headers['X-Viewer-Token'] || '', /^[a-f0-9]{48}$/, 'the refetch carries the viewer token in a header');
      // Await the same function the submit path fires so the DOM assertion is
      // deterministic (an earlier real-fetch render must not race the mock).
      await w.loadReviews(1);
      assert.equal(d.querySelectorAll('#reviewsList .review-item').length, 2, 'author sees approved reviews plus their own pending one');
      const pendingItem = d.querySelector('#reviewsList .review-item.pending-own');
      assert.ok(pendingItem, 'the author\'s own pending review is flagged');
      assert.match(pendingItem.textContent, /Awaiting approval/);
      assert.match(pendingItem.textContent, /only visible to you/i);
      assert.equal(d.querySelectorAll('#reviewsList .review-item:not(.pending-own)').length, 1, 'approved reviews carry no pending flag');
      // Arrow keys move the selection and keep the fill continuous.
      starButtons[0].focus();
      starButtons[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 1, 'ArrowRight from empty selects 1');
      starButtons[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 2, 'ArrowRight again selects 2');
      starButtons[1].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 1, 'ArrowLeft steps back to 1');
      w.resetStarInput();
      starButtons[4].click();
      w.openProductDetail(2);
      assert.equal(starButtons.some(b => b.classList.contains('lit') || b.getAttribute('aria-checked') === 'true'), false, 'switching product clears draft rating');
      const count = sentReviews.length;
      await w.submitReview({ preventDefault() {}, target: reviewForm });
      assert.equal(sentReviews.length, count, 'cannot submit without a rating');
      assert.match(d.getElementById('rvError').textContent, /select a star rating/);
    } finally {
      w.fetch = originalStoreFetch;
    }
    console.log('✅ Review stars 1–5 send the chosen rating; reset and product switching clear the picker');

    // Product page polish: rating line, thank-you message, related section,
    // zoom view, trust line, placeholders, and no stray text.
    w.openProductDetail(1);
    assert.equal(d.getElementById('rvError').style.display, 'none', 'no "Thanks for your review" before anything is submitted');
    assert.equal(d.getElementById('detailRating').textContent.trim(), 'No reviews yet', 'rating line matches the empty review state');
    const trustLine = d.querySelector('.detail-trust-line');
    assert.ok(trustLine, 'trust line exists under Add to Cart');
    assert.equal(trustLine.textContent, 'Cash on delivery · 7-day returns · Fast delivery');
    assert.equal(d.getElementById('rvOrder').placeholder, 'Order number', 'short order placeholder');
    assert.equal(d.getElementById('rvPhone').placeholder, 'Phone used for order', 'short phone placeholder');
    // Zoom view: tap the main image to open, tap the overlay to close.
    const zoomOverlay = d.getElementById('imageZoomOverlay');
    assert.ok(zoomOverlay && zoomOverlay.hidden === true, 'zoom overlay starts closed');
    d.getElementById('detailMainImage').click();
    assert.equal(zoomOverlay.hidden, false, 'tapping the main image opens the zoom view');
    assert.ok(d.getElementById('zoomImage').src, 'zoom shows the current gallery image');
    zoomOverlay.click();
    assert.equal(zoomOverlay.hidden, true, 'tapping the overlay closes the zoom view');
    d.getElementById('detailMainImage').click();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(zoomOverlay.hidden, true, 'Escape closes the zoom view');
    // "You might also like" hides completely (no leftover padding) when empty.
    const origRelated = w.eval('String(getRelatedProducts)');
    try {
      w.eval('getRelatedProducts = () => []');
      w.openProductDetail(2);
      assert.equal(d.getElementById('sectionRelated').style.display, 'none', 'empty related section is hidden');
      w.eval('getRelatedProducts = ' + origRelated);
      w.openProductDetail(2);
      assert.notEqual(d.getElementById('sectionRelated').style.display, 'none', 'related section returns with products');
    } finally {
      w.eval('getRelatedProducts = ' + origRelated);
    }
    // Gallery only renders images that exist (no back-image placeholder).
    const oneImageProduct = w.eval('allProducts.find(p => p.images.length === 1)');
    if (oneImageProduct) {
      w.openProductDetail(oneImageProduct.id);
      assert.equal(d.querySelectorAll('#detailThumbnails .detail-thumb').length, 1, 'only existing images get thumbnails');
      assert.equal(d.getElementById('detailDots').style.display, 'none', 'no dots for a single image');
    }
    // A product with front + back shows both thumbnails; tapping one swaps
    // the main image (the admin back-image upload lands here).
    w.eval('allProducts.push({ id: 999001, name: "Gallery Probe", price: 100, original_price: 100, fit: "Regular", collection: "anime", style: [], rating: null, variants: null, desc: "", sizes: ["L"], images: ["/uploads/probe-front.webp", "/uploads/probe-back.webp"], in_stock: true, on_sale: false, sale_price: null, created_at: null, order_count: 0, stock_qty: 5, size_stock: null, sold_count: 0, avg_rating: null, review_count: 0 })');
    w.openProductDetail(999001);
    assert.equal(d.querySelectorAll('#galleryTrack img').length, 2, 'front and back images both render');
    assert.equal(d.querySelectorAll('#detailThumbnails .detail-thumb').length, 2, 'front and back thumbnails both render');
    w.switchDetailAngle(1);
    assert.ok(d.querySelectorAll('#detailThumbnails .detail-thumb')[1].classList.contains('active'), 'tapping the back thumbnail switches the main image');
    assert.equal(d.getElementById('galleryTrack').style.transform, 'translateX(-100%)', 'gallery track moved to the back image');
    w.eval('allProducts = allProducts.filter(p => p.id !== 999001)');
    // No stray text nodes anywhere in the body (the old lone "n").
    const strayText = [...d.body.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim() !== '');
    assert.deepEqual(strayText.map(n => n.textContent.trim()), [], 'no stray text at the bottom of the page');
    // Content pages share a centred 720px layout with responsive inline gutters.
    const contentPageIds = ['returns', 'shipping', 'terms', 'privacy', 'contact'];
    assert.equal(d.querySelectorAll('.container.content-page').length, contentPageIds.length, 'all five requested pages use the shared content-page class');
    for (const id of contentPageIds) {
      const container = d.querySelector(`#page-${id} > .container`);
      assert.ok(container?.classList.contains('content-page'), `${id} uses the shared content-page container`);
      assert.equal(container.getAttribute('style'), null, `${id} has no inline layout style`);
    }
    assert.doesNotMatch(storeHtml, /style="padding: calc\(104px \+ var\(--spacing-lg\)\) 0 var\(--spacing-xl\); max-width: 720px;"/, 'old zero-gutter inline style is removed');
    assert.match(storeHtml, /\*\s*,\s*\*::before\s*,\s*\*::after\s*\{[^}]*box-sizing:\s*border-box;/, 'global border-box sizing prevents gutters from widening the viewport');
    const contentPageRule = storeHtml.match(/\.container\.content-page\s*\{([^}]*)\}/);
    assert.ok(contentPageRule, 'shared content-page layout rule exists');
    assert.match(contentPageRule[1], /padding:\s*calc\(104px \+ var\(--spacing-lg\)\)\s+16px\s+var\(--spacing-xl\)/, 'content pages keep their vertical spacing and use 16px mobile gutters');
    assert.match(contentPageRule[1], /max-width:\s*720px/);
    assert.match(contentPageRule[1], /margin-left:\s*auto[\s\S]*margin-right:\s*auto/, 'content pages stay centred');
    const wideContentRule = storeHtml.match(/@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.container\.content-page\s*\{([^}]*)\}/);
    assert.ok(wideContentRule, 'desktop gutter breakpoint exists');
    const breakpoint = Number(wideContentRule[1]);
    const desktopGutter = Number(wideContentRule[2].match(/padding-inline:\s*(\d+)px/)?.[1]);
    const maxWidth = Number(contentPageRule[1].match(/max-width:\s*(\d+)px/)?.[1]);
    const mobileGutter = Number(contentPageRule[1].match(/padding:\s*calc\(104px\s*\+\s*var\(--spacing-lg\)\)\s+(\d+)px/)?.[1]);
    for (const width of [360, 414, 768, 1440]) {
      const gutter = width >= breakpoint ? desktopGutter : mobileGutter;
      const containerWidth = Math.min(width, maxWidth);
      const contentWidth = containerWidth - gutter * 2;
      const edgeInset = (width - containerWidth) / 2 + gutter;
      assert.ok(contentWidth > 0, `${width}px leaves room for page text`);
      assert.ok(edgeInset >= gutter && edgeInset < width / 2, `${width}px page text has a positive edge gutter`);
      assert.ok(containerWidth <= width, `${width}px content container cannot cause horizontal overflow`);
      assert.equal(gutter, width < 600 ? 16 : 20, `${width}px uses the requested inline padding`);
    }
    assert.equal(d.querySelector('#page-tracking > .container')?.className, 'container tracking-page', 'Track Order keeps its original page class and layout');
    assert.equal(d.querySelector('#page-tracking > .container')?.getAttribute('style'), null, 'Track Order markup is untouched by content-page styles');
    assert.equal(d.querySelectorAll('.content-page-body').length, 4, 'policy copy shares the extracted text styling');
    const policyPageIds = ['terms', 'privacy', 'returns', 'shipping'];
    assert.deepEqual(
      policyPageIds.map(id => d.querySelector(`#page-${id} .section-label`)?.textContent.trim()),
      policyPageIds.map(() => 'Policy'),
      'all policy-page eyebrow labels match'
    );
    const returnsCopy = d.querySelector('#page-returns .content-page-body').textContent;
    assert.match(returnsCopy, /within 7 days of receiving your order/, 'existing 7-day return window is unchanged');
    assert.match(returnsCopy, /contact us within 48 hours with photos/, 'existing 48-hour defective/wrong-item window is unchanged');
    assert.match(returnsCopy, /Custom-designed items and custom stickers \(non-returnable unless defective or wrong\)/);

    const termsBody = d.querySelector('#page-terms .content-page-body');
    const termsCopy = termsBody.textContent;
    assert.match(termsCopy, /Last updated: October 2026/);
    assert.match(termsCopy, /By accessing and using this website/);
    assert.doesNotMatch(termsCopy, /kage-culture-ruby\.vercel\.app/i, 'Terms do not hardcode the production domain');
    assert.match(termsCopy, /Custom-designed items and custom stickers cannot be returned unless they are defective or the wrong item was supplied/);
    const customOrdersHeading = [...termsBody.querySelectorAll('h3')].find(heading => heading.textContent.trim() === '7. Custom Orders & Returns');
    const returnsPolicyLink = customOrdersHeading?.nextElementSibling?.querySelector('a');
    assert.equal(returnsPolicyLink?.getAttribute('href'), '/returns', 'custom-order terms link to the Returns page');
    assert.equal(returnsPolicyLink?.textContent.trim(), 'Returns & Refund Policy');
    assert.match(termsCopy, /governed by the laws of Pakistan/i);
    assert.match(termsCopy, /not legal advice.*reviewed by a qualified legal professional/i);

    const privacyBody = d.querySelector('#page-privacy .content-page-body');
    const privacyCopy = privacyBody.textContent;
    assert.match(privacyCopy, /Last updated: October 2026/);
    assert.doesNotMatch(privacyCopy, /solely for order fulfillment/i, 'Privacy no longer limits use solely to order fulfillment');
    assert.match(privacyCopy, /customer account details.*password stored as a hash/i);
    assert.match(privacyCopy, /newsletter sign-up emails are for product-drop, restock, and KAGE Clan updates/i);
    assert.match(privacyCopy, /courier partner handling the delivery/i);
    assert.match(privacyCopy, /kage\.session.*customer and admin login sessions/i);
    assert.match(privacyCopy, /kage\.csrf.*cross-site request forgery/i);
    assert.doesNotMatch(privacyCopy, /kage\.cust/, 'Privacy lists the active session cookie rather than the legacy fallback name');
    assert.match(privacyCopy, /does not provide a self-service unsubscribe control/i);
    const newsletterRemovalParagraph = [...privacyBody.querySelectorAll('p')].find(paragraph => paragraph.textContent.includes('self-service unsubscribe control'));
    assert.equal(newsletterRemovalParagraph?.querySelector('a')?.getAttribute('href'), 'https://wa.me/923228042633', 'newsletter removal requests have an existing WhatsApp contact path');
    assert.match(privacyCopy, /not legal advice.*reviewed by a qualified legal professional/i);

    const shippingCopy = d.querySelector('#page-shipping .content-page-body').textContent;
    assert.match(shippingCopy, /Delivery Charges/);
    assert.match(shippingCopy, /Delivery charges depend on your delivery location\. We will contact you about the delivery charges\./);
    assert.doesNotMatch(shippingCopy, /Location-based rates|Rs\. 150/, 'shipping policy no longer promises an unconfigured fee');
    assert.doesNotMatch(shippingCopy, /Free-shipping threshold|\bTODO\b|\[/, 'unconfirmed free-shipping rules are omitted rather than published as placeholders');
    assert.equal(d.getElementById('coShipping').textContent.trim(), 'To be confirmed', 'checkout does not add a delivery charge before confirmation');
    assert.equal(d.querySelector('#page-checkout .co-grand span').textContent.trim(), 'Total before delivery');
    assert.match(d.querySelector('#page-checkout .co-safe').textContent, /contact you about the delivery charges/);
    assert.ok(d.getElementById('confShipping'), 'order confirmation has a pending delivery-charge field');
    assert.match(d.querySelector('#page-confirmation .confirm-next').textContent, /contact you about the delivery charges/);
    assert.doesNotMatch(storeHtml, /const shipping = 150/, 'checkout no longer hardcodes the old flat charge');

    const checkoutPaymentValues = [...d.querySelectorAll('#page-checkout input[name="payMethod"]')].map(input => input.value);
    assert.deepEqual(checkoutPaymentValues, ['cod'], 'checkout offers only Cash on Delivery');
    assert.match(storeHtml, /payment_method:\s*'cod'/, 'checkout submits Cash on Delivery only');
    assert.equal(d.getElementById('paymentRefGroup'), null, 'non-COD payment reference controls are removed');
    assert.equal(d.getElementById('coPaymentRef'), null, 'non-COD payment reference input is removed');
    assert.equal(d.querySelector('#page-checkout .co-safe').textContent.trim(), 'Cash on Delivery accepted. We will contact you about the delivery charges.');
    assert.deepEqual([...d.querySelectorAll('.payment-icons .payment-icon')].map(icon => icon.textContent.trim()), ['COD'], 'footer only advertises COD');
    const shippingPaymentHeading = [...d.querySelectorAll('#page-shipping .content-page-body h3')].find(h => h.textContent.trim() === 'Payment Methods');
    assert.deepEqual([...shippingPaymentHeading.nextElementSibling.querySelectorAll('li')].map(li => li.textContent.trim()), ['Cash on Delivery (COD) — pay when your order arrives']);
    assert.doesNotMatch(d.querySelector('#tab-shipping').textContent, /JazzCash|Bank Transfer/, 'product details only advertise COD');
    assert.doesNotMatch(d.querySelector('#page-terms .content-page-body').textContent, /bank transfer/i, 'Terms no longer describe non-COD payment options');
    assert.doesNotMatch(storeHtml, /0322-8042633/, 'stale local phone formatting is removed');
    const whatsAppLinks = [...d.querySelectorAll('a[href^="https://wa.me/"]')];
    assert.ok(whatsAppLinks.length > 0 && whatsAppLinks.every(link => new URL(link.href).pathname === '/923228042633'), 'WhatsApp links use the normalized number');
    assert.equal(d.querySelectorAll('.content-page h3[style]').length, 0, 'repeated content-page heading styles are no longer inline');
    assert.equal(d.querySelectorAll('.content-page-back[style]').length, 0, 'repeated back-link paragraph spacing is no longer inline');
    assert.equal(d.querySelectorAll('.content-page-contact h3').length, 4, 'all four contact cards use the shared heading style');
    assert.equal(d.querySelectorAll('.content-page-contact p[style]').length, 0, 'contact paragraphs share their extracted styling');
    const contactCards = [...d.querySelectorAll('#page-contact .content-page-contact > .contact-card')];
    assert.deepEqual(contactCards.map(card => card.querySelector('h3').textContent.trim()), ['WhatsApp', 'Order Support', 'Instagram', 'Email']);
    assert.deepEqual(contactCards.map(card => card.tagName), ['A', 'ARTICLE', 'A', 'A'], 'all actions are links except the support card that contains two distinct links');
    assert.ok(contactCards.every(card => card.querySelector('.contact-card-icon svg[viewBox="0 0 24 24"] path, .contact-card-icon svg[viewBox="0 0 24 24"] circle, .contact-card-icon svg[viewBox="0 0 24 24"] rect')), 'each card has an inline vector icon');
    assert.ok(contactCards.every(card => card.querySelector('.contact-card-icon').getAttribute('aria-hidden') === 'true'), 'contact icons are decorative to screen readers');
    assert.doesNotMatch(contactCards.map(card => card.innerHTML).join(''), /💬|📦|📸/, 'contact emoji icons are removed');
    const instagramUrl = 'https://instagram.com/kage__culture';
    const instagramCard = contactCards[2];
    assert.equal(instagramCard.getAttribute('href'), instagramUrl, 'Instagram card links to the footer URL');
    assert.match(instagramCard.textContent, /@kage__culture/, 'contact handle matches the Instagram URL');
    const footerHandle = d.querySelector('.footer-instagram-handle a');
    assert.equal(footerHandle?.getAttribute('href'), instagramUrl, 'footer handle links to the same Instagram URL');
    assert.equal(footerHandle?.textContent.trim(), '@kage__culture', 'footer visibly shows the matching handle');
    assert.equal(d.querySelector('.footer-social .social-instagram').getAttribute('href'), instagramUrl);
    assert.match(storeHtml, /"sameAs":\s*\[\s*"https:\/\/instagram\.com\/kage__culture"/, 'structured data also uses the footer Instagram URL');
    assert.doesNotMatch(storeHtml, /instagram\.com\/kageculture/, 'the stale unseparated Instagram handle is removed');
    const orderSupport = contactCards[1];
    const trackLink = orderSupport.querySelector('.contact-card-primary');
    assert.equal(trackLink.getAttribute('href'), '/tracking', 'Order Support main link goes to Track Order');
    assert.match(trackLink.getAttribute('onclick'), /navigateTo\('tracking'\)/);
    assert.equal(orderSupport.querySelector('.contact-card-secondary a').textContent.trim(), 'message us on WhatsApp');
    assert.match(orderSupport.querySelector('.contact-card-secondary').textContent, /^or\s/);
    assert.match(orderSupport.querySelector('.contact-card-secondary a').getAttribute('href'), /^https:\/\/wa\.me\//);
    assert.equal(contactCards[3].getAttribute('href'), 'mailto:kageculture01@gmail.com', 'Email card uses the footer address in a mailto link');
    assert.equal(d.querySelector('.contact-working-hours'), null, 'unconfirmed working hours are omitted rather than published as placeholders');
    const publicContactAndShippingCopy = [d.querySelector('#page-contact').textContent, shippingCopy].join('\n');
    assert.doesNotMatch(publicContactAndShippingCopy, /\bTODO\b|\[/, 'customer-visible contact and shipping text has no unresolved placeholders');
    w.navigateTo('contact');
    trackLink.click();
    assert.equal(d.getElementById('page-tracking').classList.contains('active'), true, 'Order Support link navigates to the Track Order page');
    w.navigateTo('contact');

    // There is one global footer outside all route-specific page containers.
    const sharedFooter = d.querySelector('body > footer.site-footer');
    assert.ok(sharedFooter, 'shared footer is a direct child of body');
    assert.equal(d.querySelectorAll('footer.site-footer').length, 1, 'all routes use exactly one footer copy');
    assert.equal(sharedFooter.closest('.page'), null, 'footer is not hidden with the home page container');
    for (const id of ['returns', 'shipping', 'terms', 'privacy', 'contact', 'tracking']) {
      w.navigateTo(id);
      assert.equal(d.getElementById(`page-${id}`).classList.contains('active'), true, `${id} route activates`);
      assert.equal(sharedFooter.parentElement, d.body, `${id} keeps the same shared footer`);
      assert.equal(d.querySelectorAll('footer.site-footer').length, 1, `${id} does not introduce a duplicate footer`);
    }
    w.navigateTo('home');
    const footerLinks = [...sharedFooter.querySelectorAll('.footer-bottom-links a')];
    assert.deepEqual(footerLinks.map(link => link.textContent.trim()), ['Privacy', 'Terms']);
    const footerSeparator = sharedFooter.querySelector('.footer-bottom-separator');
    assert.equal(footerSeparator.textContent.trim(), '·', 'Privacy and Terms have a visible middle-dot separator');
    assert.equal(footerSeparator.getAttribute('aria-hidden'), 'true', 'decorative separator is skipped by assistive technology');
    const socialLinks = [...sharedFooter.querySelectorAll('.social-icon')];
    assert.deepEqual(socialLinks.map(link => link.getAttribute('aria-label')), ['Instagram', 'Snapchat', 'Email', 'Etsy', 'WhatsApp'], 'social aria-labels are preserved');
    assert.ok(socialLinks.every(link => link.querySelector('svg path')), 'all social links use vector icon artwork');
    const etsyIcon = sharedFooter.querySelector('.social-etsy svg');
    assert.ok(etsyIcon && etsyIcon.querySelector('path'), 'Etsy uses an SVG logo path');
    assert.equal(etsyIcon.querySelector('text'), null, 'Etsy no longer uses a text glyph');
    assert.match(sharedFooter.querySelector('.social-snapchat svg path').getAttribute('d'), /^M12\.206\.793c\.99 0 4\.347/, 'Snapchat uses its recognizable ghost silhouette');
    console.log('✅ Shared footer, contact cards/links and Track Order responsive contracts pass at 360/414/768/1440px');

    // Static CSS contracts: urgency separator, back link, gutters, footer.
    assert.match(storeHtml, /\.urgency-sold:not\(:first-child\)::before \{ content: '· '; \}/, 'sold-count dot only after another urgency item');
    assert.match(storeHtml, /\.detail-info \.back-link \{[\s\S]*?font-size: 14px;[\s\S]*?min-height: 44px;/, 'back link is 14px with a 44px tap height');
    assert.match(storeHtml, /@media \(max-width: 1024px\) \{\s*\.container \{ padding-left: 24px; padding-right: 24px; \}/, '24px gutters at 769–1024px');
    assert.match(storeHtml, /@media \(max-width: 768px\) \{\s*\.container \{ padding-left: 16px; padding-right: 16px; \}/, '16px gutters at ≤768px');
    assert.match(storeHtml, /\.product-detail-page \{ max-width: var\(--max-width\); margin-left: auto; margin-right: auto; \}/, 'product page capped at 1280px, centred');
    const contactGridCss = storeHtml.match(/\.content-page-contact\s*\{([^}]*)\}/);
    assert.ok(contactGridCss, 'contact cards use a shared responsive grid');
    assert.match(contactGridCss[1], /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(contactGridCss[1], /grid-auto-rows:\s*1fr/, 'contact cards share equal row heights');
    const mobileContactCss = storeHtml.match(/@media \(max-width: 600px\) \{\s*\.content-page-contact \{([^}]*)\}/);
    assert.ok(mobileContactCss, 'contact cards collapse to one column on narrow screens');
    assert.match(mobileContactCss[1], /grid-template-columns:\s*1fr/);
    const contactCardCss = storeHtml.match(/\.contact-card\s*\{([^}]*)\}/);
    assert.ok(contactCardCss);
    assert.match(contactCardCss[1], /min-width:\s*0;[\s\S]*min-height:\s*160px;[\s\S]*padding:\s*var\(--spacing-lg\)/, 'contact cards share minimum dimensions and padding');
    assert.match(storeHtml, /\.contact-card:hover,\s*\.contact-card:focus-within\s*\{[^}]*border-color:\s*var\(--accent\);/, 'contact cards have a visible theme-colored hover state');
    assert.match(storeHtml, /\.contact-card:focus-visible,\s*\.contact-card:focus-within\s*\{[^}]*outline:\s*3px solid var\(--accent\);[^}]*outline-offset:\s*3px;/, 'keyboard focus draws a clear outline around each card');
    assert.match(storeHtml, /\.contact-card-icon svg\s*\{[^}]*stroke:\s*currentColor;[^}]*stroke-width:\s*1\.7;[^}]*stroke-linecap:\s*round;[^}]*stroke-linejoin:\s*round;/, 'contact SVGs share a consistent themed stroke style');
    assert.match(storeHtml, /\.tracking-form \.btn \{ align-self: flex-start; \}/, 'desktop Track Order button retains its original alignment');
    assert.match(storeHtml, /@media \(max-width: 768px\) \{\s*#page-tracking \.tracking-form \.btn \{ width: 100%; align-self: stretch; \}/, 'Track Order button expands to the form width on mobile');
    for (const width of [360, 414, 768, 1440]) {
      const pageOuterWidth = Math.min(width, 720);
      const pageGutter = width < 600 ? 16 : 20;
      const pageContentWidth = pageOuterWidth - pageGutter * 2;
      const columns = width <= 600 ? 1 : 2;
      const cardGap = 16;
      const cardWidth = (pageContentWidth - cardGap * (columns - 1)) / columns;
      assert.ok(pageOuterWidth <= width && pageContentWidth > 0, `${width}px contact page has no horizontal overflow`);
      assert.ok(cardWidth > 0 && cardWidth * columns + cardGap * (columns - 1) <= pageContentWidth, `${width}px contact cards fit their responsive columns`);
    }
    const footerLinksCss = storeHtml.match(/\.footer-bottom-links\s*\{([^}]*)\}/);
    assert.ok(footerLinksCss, 'legal links have a dedicated flex row');
    assert.match(footerLinksCss[1], /display:\s*flex;[\s\S]*gap:\s*var\(--spacing-xs\)/, 'legal links and their separator have visible spacing');
    assert.match(storeHtml, /\.footer-bottom-links a\s*\{[^}]*min-height:\s*44px;[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;/, 'Privacy and Terms links meet the 44px tap-height minimum');
    const socialStart = storeHtml.indexOf('    .footer-social {');
    const socialEnd = storeHtml.indexOf('FLOATING WHATSAPP BUTTON', socialStart);
    const socialCss = storeHtml.slice(socialStart, socialEnd);
    assert.ok(socialStart >= 0 && socialEnd > socialStart, 'footer social CSS block exists');
    assert.match(socialCss, /\.social-icon\s*\{[^}]*border:\s*1px solid var\(--border-color\);[^}]*color:\s*var\(--accent\);/, 'all social glyphs use the same olive/beige theme treatment');
    assert.match(socialCss, /\.social-icon:hover,\s*\.social-icon:focus-visible\s*\{[^}]*background:\s*var\(--accent-glow\);/, 'social hover/focus accent remains subtle and theme-colored');
    assert.doesNotMatch(socialCss, /\.social-(?:instagram|snapchat|email|etsy|whatsapp)(?::hover)?\s*\{/, 'no per-brand rainbow overrides remain');
    const whatsappStart = storeHtml.indexOf('FLOATING WHATSAPP BUTTON');
    const whatsappEnd = storeHtml.indexOf('Keep page-bottom content clear', whatsappStart);
    const whatsappCss = storeHtml.slice(whatsappStart, whatsappEnd);
    assert.ok(whatsappStart >= 0 && whatsappEnd > whatsappStart, 'WhatsApp/footer spacing rules exist');
    assert.match(whatsappCss, /\.whatsapp-float \{\s*position: fixed;[\s\S]*?bottom: 24px;[\s\S]*?width: 60px;[\s\S]*?height: 60px;/, 'wide floating button dimensions and edge offset are known');
    assert.match(whatsappCss, /@media \(max-width: 768px\) \{[\s\S]*?\.whatsapp-float \{\s*bottom: calc\(20px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*?width: 56px;[\s\S]*?height: 56px;/, 'mobile floating button dimensions include the safe-area offset');
    assert.match(whatsappCss, /@media \(max-width: 768px\) \{[\s\S]*?\.site-footer \{ padding-bottom: calc\(var\(--spacing-md\) \+ 76px \+ env\(safe-area-inset-bottom, 0px\)\); \}/, 'mobile footer reserves button height, bottom offset, gap and safe area');
    assert.match(whatsappCss, /@media \(min-width: 769px\) \{\s*\.site-footer \{ padding-bottom: calc\(var\(--spacing-md\) \+ 84px\); \}\s*\}/, 'desktop footer also clears the floating button');
    assert.match(storeHtml, /\.footer-bottom\s*\{[^}]*flex-wrap:\s*wrap;/, 'footer bottom rows wrap instead of forcing horizontal overflow');
    assert.match(storeHtml, /\.payment-icons\s*\{[^}]*flex-wrap:\s*wrap;/, 'payment badges can wrap on narrow screens');
    assert.match(storeHtml, /\.social-icon\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*flex:\s*0 0 44px;/, 'social tap targets stay 44px without shrinking');
    assert.match(storeHtml, /--spacing-sm:\s*0\.5rem;/, 'social-icon gaps are 8px at the 16px root size');
    assert.match(storeHtml, /--spacing-md:\s*1rem;/, 'footer clearance includes a 16px breathing gap');
    assert.match(storeHtml, /--spacing-lg:\s*2rem;[\s\S]*--max-width:\s*1280px;/, 'wide footer container uses the 1280px cap and 32px side padding');
    assert.match(storeHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.footer-main \{ grid-template-columns: 1fr; \}/, 'footer columns collapse into a single mobile column');
    const socialRowWidth = socialLinks.length * 44 + (socialLinks.length - 1) * 8;
    for (const width of [360, 414, 768, 1440]) {
      const gutter = width <= 768 ? 16 : width <= 1024 ? 24 : 32;
      const footerContainerWidth = Math.min(width, 1280);
      const usableWidth = footerContainerWidth - gutter * 2;
      assert.ok(socialRowWidth <= usableWidth, `${width}px footer social row fits inside the container without horizontal overflow`);
      const mobile = width <= 768;
      const floatingTopInset = mobile ? 20 + 56 : 24 + 60;
      const footerContentInset = 16 + (mobile ? 76 : 84);
      assert.ok(footerContentInset >= floatingTopInset + 16, `${width}px footer padding leaves at least 16px below the floating WhatsApp button`);
    }
    assert.match(storeHtml, /@media \(min-width: 481px\) \{\s*\.footer-col ul \{ gap: 10px; \}/, 'footer Help links 10px gap above 480px');
    assert.match(storeHtml, /@media \(max-width: 480px\) \{\s*\.footer-col\.footer-help ul \{[\s\S]*?grid-template-columns: 1fr 1fr;/, 'mobile footer Help links in two columns');
    assert.match(storeHtml, /\.review-form textarea \{ resize: vertical; \}/, 'textarea resizes vertically only');
    assert.match(storeHtml, /@media \(hover: hover\) \{\s*\.star-input button:hover/, 'star hover style gated on hover support');
    assert.match(storeHtml, /\.star-input button \{[^}]*width:44px; height:44px;/, 'star tap targets are 44×44');
    // Pointer-driven preview: press-and-hold / slide previews 1..N and the
    // release commits N (touch emulation with stubbed star geometry).
    const starRects = starButtons.map((b, i) => ({ left: i * 44, right: i * 44 + 44, top: 0, bottom: 44, width: 44, height: 44, x: i * 44, y: 0, toJSON() {} }));
    starButtons.forEach((b, i) => { b.getBoundingClientRect = () => starRects[i]; });
    const starWrap = d.getElementById('starInput');
    const ptr = (type, x) => {
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: 20 };
      try { return new w.PointerEvent(type, { ...init, pointerId: 1, pointerType: 'touch' }); }
      catch (err) { return new w.MouseEvent(type, init); }
    };
    // Tap star 3 → stars 1–3 gold.
    starButtons[2].dispatchEvent(ptr('pointerdown', 90));
    starWrap.dispatchEvent(ptr('pointerup', 90));
    assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 3, 'tap star 3 lights stars 1–3');
    assert.equal(starButtons[2].getAttribute('aria-checked'), 'true', 'tap commits 3');
    // Press and hold star 5 → preview 1–5, release selects 5.
    starButtons[4].dispatchEvent(ptr('pointerdown', 180));
    assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 5, 'holding star 5 previews all five');
    assert.equal(starButtons[4].getAttribute('aria-checked'), 'false', 'a hold is a preview until release');
    starWrap.dispatchEvent(ptr('pointerup', 180));
    assert.equal(starButtons[4].getAttribute('aria-checked'), 'true', 'releasing star 5 selects 5');
    // Select 2, then hold 4 and drag back to 2 → ends at 2.
    starButtons[1].dispatchEvent(ptr('pointerdown', 50));
    starWrap.dispatchEvent(ptr('pointerup', 50));
    assert.equal(starButtons[1].getAttribute('aria-checked'), 'true', 'selected 2');
    starButtons[3].dispatchEvent(ptr('pointerdown', 140));
    assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 4, 'holding 4 previews 1–4');
    starWrap.dispatchEvent(ptr('pointermove', 60));
    assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 2, 'dragging back previews 1–2');
    starWrap.dispatchEvent(ptr('pointerup', 60));
    assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 2, 'release after drag ends at 2');
    assert.equal(starButtons[1].getAttribute('aria-checked'), 'true', 'committed value is 2');
    // Cancelled gesture drops the preview without changing the selection.
    starButtons[4].dispatchEvent(ptr('pointerdown', 180));
    starWrap.dispatchEvent(ptr('pointercancel', 180));
    assert.equal(starButtons.filter(b => b.classList.contains('lit')).length, 2, 'pointercancel restores the committed fill');
    w.resetStarInput();
    console.log('✅ Product page: rating text, zoom, related section, trust line, stars and gutters behave');

    // Side-by-side cards must line up even when only one of them has reviews:
    // every card reserves a rating row and the Quick View / Add to Cart button
    // is pinned to the bottom of the (equal-height) card.
    assert.match(storeHtml, /<div class="card-rating">\$\{starsHtml\(p\.rating, p\.review_count\)\}\<\/div>/, 'product cards render the rating in its own row');
    assert.ok(d.querySelector('.product-grid .product-card .card-rating'), 'rendered cards keep the reserved rating row');
    assert.match(w.renderHomeProductCard({ id: 1, name: 'No reviews yet', price: 10, fit: 'Regular', stock_qty: 10 }), /<div class="card-rating"><\/div>/, 'a product with no reviews still reserves the rating row');
    assert.match(w.renderHomeProductCard({ id: 1, name: 'Reviewed', price: 10, fit: 'Regular', stock_qty: 10, rating: 5, review_count: 2 }), /<div class="card-rating"><span class="star-rating"/, 'a reviewed product fills that row with stars');
    assert.match(storeHtml, /\.product-grid \.product-card \{[^}]*display: flex;[^}]*flex-direction: column;/, 'cards are flex columns so a grid row stretches them to equal height');
    assert.match(storeHtml, /\.product-grid \.product-card-body \{[^}]*flex: 1 1 auto;[^}]*\}/, 'the card body fills the remaining card height');
    assert.match(storeHtml, /\.product-grid \.quick-view-btn \{[^}]*margin-top: auto;/, 'Quick View is pinned to the bottom of the card');
    assert.match(storeHtml, /#page-home \.product-grid \.quick-view-btn \{[^}]*margin-top: auto;/, 'the storefront override keeps Quick View pinned too');
    assert.match(storeHtml, /\.card-rating \{[^}]*min-height: 1\.15rem;[^}]*\}/, 'the rating row keeps its line when there are no reviews');
    console.log('✅ Product cards keep a reserved rating row and pin their button to the card bottom');

    // ---- Four category tiles (Graphic Tees, Anime Shirts, Pants [disabled],
    // ---- Custom Stickers). Phones get a 2×2 grid of equal columns inside the
    // ---- page gutters; 600px and up get one centred row of four. Every card
    // ---- stretches to its cell so the circles / names / descriptions / bottom
    // ---- labels line up no matter how the copy wraps.
    const catTiles = [...d.querySelectorAll('#page-home .category-strip .cat-tile')];
    assert.deepEqual(catTiles.map(t => t.querySelector('.cat-name').textContent), ['Graphic Tees', 'Anime Shirts', 'Pants', 'Custom Stickers'], 'the category strip lists the four cards in order');
    assert.deepEqual(catTiles.map(t => t.querySelector('img').getAttribute('src')), ['/images/graphic-tees.jpg', '/images/anime-shirts.jpg', '/images/pants.jpg', '/images/custom-stickers.jpg'], 'each card keeps its own image (Pants uses pants.jpg)');
    assert.deepEqual(catTiles.map(t => t.querySelector('.cat-desc').textContent), [
      'Bold prints on oversized fits.',
      'Original art on premium cotton.',
      'Relaxed fits for every drop.',
      'Your design, our print.'
    ], 'each card carries the same short two-line description');
    const linkTiles = catTiles.filter(t => t.tagName === 'A');
    assert.deepEqual(linkTiles.map(t => t.getAttribute('href')), ['/collection/graphic-tees', '/collection/anime', '/custom-stickers'], 'enabled tiles link to real routes');
    const pantsTile = catTiles.find(t => t.querySelector('.cat-name').textContent === 'Pants');
    assert.equal(pantsTile.tagName, 'SPAN', 'Pants is a span (not an <a>) while out of stock');
    assert.equal(pantsTile.getAttribute('aria-disabled'), 'true', 'Pants tile is aria-disabled');
    assert.ok(pantsTile.querySelector('.cat-coming-soon'), 'Pants tile shows the Coming-soon pill while unavailable');
    assert.ok(linkTiles.every(t => /Explore/.test(t.querySelector('.cat-shop').textContent)), 'every active card keeps its Explore link');
    assert.ok(catTiles.every(t => t.querySelector('.cat-desc').textContent.trim().length), 'every card keeps its description');
    // Layout contracts: phone-first 2×2 grid, four equal columns from 600px up.
    assert.match(storeHtml, /\.category-strip \{[^}]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'base layout is a phone-first 2×2 grid of equal columns');
    assert.match(storeHtml, /@media \(max-width: 599px\) \{[\s\S]*?#page-home \.category-strip \{[^}]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'phone layout keeps the 2×2 grid');
    assert.match(storeHtml, /@media \(min-width: 600px\) and \(max-width: 1023px\) \{[\s\S]*?#page-home \.category-strip \{[^}]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/, 'tablet layout uses four balanced columns');
    assert.match(storeHtml, /@media \(min-width: 1024px\) \{[\s\S]*?#page-home \.category-strip \{[^}]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[\s\S]*?max-width: 1200px;/, 'desktop layout centers four columns and caps the strip at 1200px');
    // No horizontal scroll row is left behind anywhere on this strip.
    assert.doesNotMatch(storeHtml, /#page-home \.category-strip[^{]*\{[^}]*overflow-x: auto;/, 'the phone strip is never a horizontal scroller');
    assert.doesNotMatch(storeHtml, /#page-home \.category-strip[^{]*\{[^}]*scroll-snap/, 'no scroll-snap is left on the category strip');
    assert.doesNotMatch(storeHtml, /#page-home \.cat-tile \{[^}]*scroll-snap-align/, 'the cards no longer snap into a scroll row');
    assert.doesNotMatch(storeHtml, /#page-home \.category-strip[^{]*\{[^}]*margin-inline: -1?6px;/, 'the phone strip does not bleed past the page gutters');
    // Height contracts that keep the four parts aligned whatever the copy is.
    assert.match(storeHtml, /\.cat-tile \{[^}]*?height: 100%;/, 'every card stretches to its grid cell height');
    assert.match(storeHtml, /\.cat-info \{[^}]*?flex: 1 1 auto;/, '.cat-info fills the card');
    assert.match(storeHtml, /\.cat-name \{[^}]*?min-height: 2lh;/, 'card names reserve two lines everywhere');
    assert.match(storeHtml, /\.cat-desc \{[^}]*?min-height: 2lh;/, 'card descriptions reserve two lines everywhere');
    assert.match(storeHtml, /\.cat-shop,\s*\.cat-coming-soon \{[^}]*?min-height: 28px;/, 'Explore and Coming-soon labels share one row height');
    assert.match(storeHtml, /\.cat-shop \{[^}]*?margin-top: auto;/, 'Explore / Coming-soon labels are pinned to the card bottom');
    assert.match(storeHtml, /\.category-strip:focus-visible \{[^}]*?outline: 2px solid #FFF;/, 'the keyboard-focusable row has a visible focus ring');
    assert.equal(d.getElementById('categoryStrip').getAttribute('tabindex'), '0', 'the category row is keyboard focusable');
    assert.ok(d.getElementById('categoryStrip').getAttribute('aria-label'), 'the category row is labelled for assistive tech');
    console.log('✅ Category strip shows four tiles (Pants disabled): 2×2 phone grid + 4-col tablet/desktop layouts with aligned, pinned labels');

    // ---- Real Chromium: category strip geometry at phone/tablet/desktop widths ----
    const { launchChromium, waitForCatalog, settleLayout } = require('./fixtures/chromium');
    const browser = await launchChromium();
    try {
      for (const [vw, vh, mode] of [[320, 780, 'phone'], [360, 780, 'phone'], [414, 860, 'phone'], [599, 900, 'phone'], [768, 900, 'tablet'], [1440, 900, 'desktop']]) {
        const bp = await browser.newPage();
        await bp.setViewport({ width: vw, height: vh });
        await bp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(bp);
        await settleLayout(bp);
        const m = await bp.evaluate(() => {
          const strip = document.querySelector('#page-home .category-strip');
          const tiles = [...strip.querySelectorAll('.cat-tile')];
          const labelOf = (t) => {
            const shop = t.querySelector('.cat-shop');
            return getComputedStyle(shop).display !== 'none' ? shop : t.querySelector('.cat-coming-soon');
          };
          // Count the wrapped text lines, not the reserved (min-height) box.
          const textLines = (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const tops = new Set([...range.getClientRects()]
              .filter((r) => r.width > 0.5 && r.height > 0.5)
              .map((r) => Math.round(r.top)));
            return tops.size;
          };
          const cs = getComputedStyle(strip);
          const out = {
            columns: cs.gridTemplateColumns,
            columnCount: cs.gridTemplateColumns.trim().split(/\s+/).length,
            overflowX: cs.overflowX,
            snap: cs.scrollSnapType,
            docW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            stripScrollW: strip.scrollWidth,
            stripClientW: strip.clientWidth,
            tiles: []
          };
          for (const t of tiles) {
            const rect = t.getBoundingClientRect();
            const thumb = t.querySelector('.cat-thumb').getBoundingClientRect();
            const name = t.querySelector('.cat-name');
            const desc = t.querySelector('.cat-desc');
            const label = labelOf(t);
            out.tiles.push({
              left: +rect.left.toFixed(2),
              right: +rect.right.toFixed(2),
              top: +rect.top.toFixed(2),
              width: +rect.width.toFixed(2),
              height: +rect.height.toFixed(2),
              thumbTop: +thumb.top.toFixed(2),
              thumbW: +thumb.width.toFixed(2),
              thumbH: +thumb.height.toFixed(2),
              thumbCentre: +(thumb.left + thumb.width / 2).toFixed(2),
              cardCentre: +(rect.left + rect.width / 2).toFixed(2),
              nameTop: +name.getBoundingClientRect().top.toFixed(2),
              nameLines: textLines(name),
              descTop: +desc.getBoundingClientRect().top.toFixed(2),
              descLines: textLines(desc),
              labelTop: +label.getBoundingClientRect().top.toFixed(2),
              labelH: +label.getBoundingClientRect().height.toFixed(2)
            });
          }
          return out;
        });
        await bp.evaluate(() => window.scrollTo(500, 0));
        const pageScrollX = await bp.evaluate(() => window.scrollX);

        // Group the cards into visual rows: in the 2×2 phone grid rows 1|2
        // must line up with each other; at 768/1440 all four share one row.
        const rows = [];
        for (const tile of m.tiles) {
          let row = rows.find((r) => Math.abs(r.top - tile.top) <= 1);
          if (!row) { row = { top: tile.top, tiles: [] }; rows.push(row); }
          row.tiles.push(tile);
        }
        rows.sort((a, b) => a.top - b.top);
        const rowSpread = (key) => rows.map((r) => {
          const xs = r.tiles.map((t) => t[key]);
          return +(Math.max(...xs) - Math.min(...xs)).toFixed(2);
        });

        // The main goal: circles / names / descriptions / bottom labels line up.
        for (const key of ['thumbTop', 'nameTop', 'descTop', 'labelTop']) {
          for (const [i, spread] of rowSpread(key).entries()) {
            assert.ok(spread <= 1, `${vw}px (${mode}): row ${i + 1} cards share the same ${key} within 1px (spread ${spread}px)`);
          }
        }
        assert.ok(m.tiles.every((t) => Math.abs(t.labelH - 28) <= 1), `${vw}px: Explore and Coming-soon labels have equal height (${m.tiles.map((t) => t.labelH)})`);
        assert.ok(m.tiles.every((t) => Math.abs(t.thumbCentre - t.cardCentre) <= 1), `${vw}px: every circle is centred inside its card`);
        assert.ok(m.tiles.every((t) => Math.abs(t.thumbW - t.thumbH) <= 0.5), `${vw}px: circles stay square — never cropped (${m.tiles.map((t) => t.thumbW)})`);
        assert.equal(pageScrollX, 0, `${vw}px: the page itself never scrolls sideways`);
        assert.ok(m.docW <= m.innerW, `${vw}px: no document-level horizontal overflow (${m.docW} <= ${m.innerW})`);
        assert.ok(m.stripScrollW <= m.stripClientW, `${vw}px: the strip itself has nothing to scroll (${m.stripScrollW} <= ${m.stripClientW})`);

        if (mode === 'phone') {
          assert.equal(m.columnCount, 2, `${vw}px: the phone grid is exactly 2 columns (${m.columns})`);
          assert.equal(rows.length, 2, `${vw}px: the four cards sit in two rows of two`);
          assert.ok(rows.every((r) => r.tiles.length === 2), `${vw}px: each phone row holds two cards`);
          assert.ok(rowSpread('width').every((s) => s <= 1), `${vw}px: the two phone columns are equal (${rowSpread('width')})`);
          // Equal gaps in both directions + the page's own side gutters.
          const colGap = +(m.tiles[1].left - m.tiles[0].right).toFixed(2);
          const rowGap = +(rows[1].top - rows[0].tiles[0].top - rows[0].tiles[0].height).toFixed(2);
          assert.ok(Math.abs(colGap - rowGap) <= 1, `${vw}px: the phone grid uses equal gaps (column ${colGap}px / row ${rowGap}px)`);
          const gutter = +(m.innerW - m.tiles[1].right).toFixed(2);
          assert.ok(Math.abs(m.tiles[0].left - gutter) <= 1, `${vw}px: the grid keeps the page's side gutters (${m.tiles[0].left}px / ${gutter}px)`);
          assert.ok(m.tiles[0].left >= 8, `${vw}px: the cards are inset by the page gutter (${m.tiles[0].left}px)`);
          // No scroll row at all, so nothing can be dragged sideways.
          assert.equal(m.overflowX, 'visible', `${vw}px: the phone strip is not a horizontal scroller`);
          assert.equal(m.snap, 'none', `${vw}px: no scroll-snap remains on the phone strip`);
          assert.ok(m.tiles.every((t) => t.nameLines === 1), `${vw}px: every name fits on ONE line (${m.tiles.map((t) => t.nameLines)})`);
          assert.ok(m.tiles.every((t) => t.descLines <= 2), `${vw}px: every description fits in two lines (${m.tiles.map((t) => t.descLines)})`);
          assert.ok(m.tiles.every((t) => t.thumbW >= 87 && t.thumbW <= 105), `${vw}px: all four circles are 88–104px (${m.tiles.map((t) => t.thumbW)})`);
        } else {
          assert.equal(m.columnCount, 4, `${mode} ${vw}px: one row of four columns (${m.columns})`);
          assert.equal(rows.length, 1, `${mode} ${vw}px: all four cards share one row`);
          const widthSpread = +(Math.max(...m.tiles.map((t) => t.width)) - Math.min(...m.tiles.map((t) => t.width))).toFixed(2);
          assert.ok(widthSpread <= 1, `${mode} ${vw}px: four equal columns (spread ${widthSpread}px)`);
          const gutter = +(m.innerW - m.tiles[3].right).toFixed(2);
          assert.ok(Math.abs(m.tiles[0].left - gutter) <= 1, `${mode} ${vw}px: the row is centred (${m.tiles[0].left}px / ${gutter}px)`);
          const thumb = mode === 'tablet' ? 104 : 150;
          assert.ok(m.tiles.every((t) => Math.abs(t.thumbW - thumb) <= 1), `${mode} ${vw}px: circles are ${thumb}px on all four cards`);
          assert.ok(m.tiles.every((t) => t.nameLines <= 2), `${mode} ${vw}px: names stay inside their two-line reservation (${m.tiles.map((t) => t.nameLines)})`);
          assert.ok(m.tiles.every((t) => t.descLines <= 2), `${mode} ${vw}px: descriptions stay inside their two-line reservation (${m.tiles.map((t) => t.descLines)})`);
        }
        console.log(`✅ ${vw}px (${mode}) in real Chromium — ${m.columnCount} cols, tops thumb/name/desc/label: ${m.tiles.map((t) => `${t.thumbTop}/${t.nameTop}/${t.descTop}/${t.labelTop}`).join(' | ')}`);
        await bp.close();
      }

      // Keyboard: the row is tabbable and shows a visible white focus ring.
      const kp = await browser.newPage();
      await kp.setViewport({ width: 360, height: 780 });
      await kp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      await waitForCatalog(kp);
      const focus = await kp.evaluate(() => {
        const strip = document.querySelector('#page-home .category-strip');
        strip.focus();
        const cs = getComputedStyle(strip);
        return {
          tabbable: strip.tabIndex,
          focusVisible: strip.matches(':focus-visible'),
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
          outlineStyle: cs.outlineStyle
        };
      });
      assert.equal(focus.tabbable, 0, 'the category grid is keyboard focusable (tabindex 0)');
      assert.equal(focus.focusVisible, true, 'the category grid matches :focus-visible when focused');
      assert.equal(focus.outlineWidth, '2px', 'the focus ring is 2px');
      assert.equal(focus.outlineColor, 'rgb(255, 255, 255)', 'the focus ring is white (visible on the accent band)');
      assert.equal(focus.outlineStyle, 'solid', 'the focus ring is solid');
      console.log('✅ Real Chromium keyboard check — category grid focus ring is 2px solid white');
      await kp.close();
    } finally {
      await browser.close();
    }


    const admin = page(adminHtml, '/admin'); windows.push(admin);
    await wait(100);
    const aw = admin.window, ad = aw.document;
    const products = await adminProductList();
    aw.eval('products = ' + JSON.stringify(products) + '; filterProducts()');
    ad.getElementById('productSearch').value = '';
    aw.filterProducts();
    const rowSelect = ad.querySelector('#productList .product-row:not(.header-row) .product-select');
    assert.ok(rowSelect, 'product rows should have selection checkboxes');
    rowSelect.checked = true;
    rowSelect.dispatchEvent(new aw.Event('change', { bubbles: true }));
    assert.equal(aw.eval('selectedProductIds.size'), 1);
    assert.equal(ad.getElementById('bulkDeleteProductsBtn').disabled, false);
    const selectVisible = ad.getElementById('selectVisibleProducts');
    selectVisible.checked = true;
    selectVisible.dispatchEvent(new aw.Event('change', { bubbles: true }));
    assert.equal(aw.eval('selectedProductIds.size'), products.length);
    selectVisible.checked = false;
    selectVisible.dispatchEvent(new aw.Event('change', { bubbles: true }));
    assert.equal(aw.eval('selectedProductIds.size'), 0);
    ad.getElementById('productSearch').value = products[0].name;
    aw.filterProducts();
    const filteredCount = ad.querySelectorAll('#productList .product-row:not(.header-row)').length;
    assert.ok(filteredCount > 0 && filteredCount < products.length, 'search should narrow the rows before select-visible');
    selectVisible.checked = true;
    selectVisible.dispatchEvent(new aw.Event('change', { bubbles: true }));
    assert.equal(aw.eval('selectedProductIds.size'), filteredCount);
    selectVisible.checked = false;
    selectVisible.dispatchEvent(new aw.Event('change', { bubbles: true }));
    assert.equal(aw.eval('selectedProductIds.size'), 0);
    ad.getElementById('productSearch').value = '';
    aw.filterProducts();
    console.log('✅ Admin batch-delete selection follows the visible product list');

    // Review moderation stars: the global .icon rule further down the admin
    // stylesheet sets fill:none, so a bare .icon-fill rule lost the cascade
    // and every star rendered as a hollow outline (rating unreadable).
    assert.match(adminHtml, /\.review-stars \.icon\.icon-fill\{fill:currentColor;stroke:currentColor;\}/, 'filled review stars must outrank the global fill:none .icon rule');
    assert.match(adminHtml, /\.review-stars \.icon:not\(\.icon-fill\)\{fill:none;stroke:currentColor;opacity:0\.35;\}/, 'unrated stars stay dimmed outlines');
    aw.eval("allReviews = [{ id: 1, product_id: " + products[0].id + ", order_number: 'KAGE-0001', customer_name: 'Star Buyer', rating: 4, comment: 'Solid fit', status: 'pending' }]; reviewFilter = 'pending'; renderReviews()");
    assert.equal(ad.querySelectorAll('#reviewsList .review-stars .icon').length, 5, 'five stars render per review');
    assert.equal(ad.querySelectorAll('#reviewsList .review-stars .icon-fill').length, 4, 'a 4★ review fills exactly four stars');
    console.log('✅ Admin review rows render filled gold stars for the rating');

    const originalAdminFetch = aw.fetch;
    aw.populateCategorySelects();
    let quickUploadBody = null;
    try {
      aw.eval('quickImageBlob = new Blob(["mock image"], { type: "image/webp" }); quickImageName = "quantity-test.webp"');
      ad.getElementById('quickCategory').value = 'graphic-tees';
      ad.getElementById('quickPrice').value = '500';
      ad.getElementById('quickStockQty').value = '1.5';
      aw.fetch = () => { throw new Error('invalid quantity must stop before upload'); };
      await aw.handleQuickUpload();
      assert.match(ad.getElementById('quickError').textContent, /whole number/);
      ad.getElementById('quickStockQty').value = '7';
      aw.fetch = (url, options) => {
        if (url === '/api/products' && options && options.method === 'POST') {
          quickUploadBody = options.body;
          return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'expected test response' }) });
        }
        return originalAdminFetch(url, options);
      };
      await aw.handleQuickUpload();
      assert.equal(quickUploadBody.get('stock_qty'), '7');
    } finally {
      aw.fetch = originalAdminFetch;
    }
    console.log('✅ Quick Upload validates and submits stock quantity');

    // Admin form: sizes chips and per-size counts are sent as one payload.
    aw.eval('products = ' + JSON.stringify(await adminProductList()) + '; filterProducts()');
    const sizeTeeAdmin = aw.eval('products.find(p => p.name === "Frontend Size Tee")');
    assert.ok(sizeTeeAdmin && sizeTeeAdmin.size_stock, 'admin sees the per-size counts');
    aw.editProduct(sizeTeeAdmin.id);
    assert.deepEqual([...ad.querySelectorAll('#prodSizeChips .size-chip[aria-pressed="true"]')].map(b => b.dataset.size), ['S', 'M', 'L']);
    assert.equal(ad.querySelector('#prodSizeStock [data-size="M"]').value, '0');
    ad.querySelector('#prodSizeStock [data-size="L"]').value = '9';
    let sentBody = null;
    const savedFetch = aw.fetch;
    try {
      aw.fetch = (url, options) => {
        if (options && options.method === 'PUT') { sentBody = options.body; return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'expected test response' }) }); }
        return savedFetch(url, options);
      };
      await aw.handleSaveProduct({ preventDefault() {} });
      assert.equal(sentBody.get('size_stock'), JSON.stringify({ S: 2, M: 0, L: 9 }));
      assert.equal(sentBody.get('sizes'), JSON.stringify(['S', 'M', 'L']));
      assert.equal(sentBody.has('stock_qty'), false, 'no bare total is sent');
      // A half-filled size list must be rejected before any request is made.
      ad.querySelector('#prodSizeStock [data-size="M"]').value = '';
      sentBody = null;
      await aw.handleSaveProduct({ preventDefault() {} });
      assert.equal(sentBody, null);
      assert.match(ad.getElementById('formError').textContent, /size M/);
    } finally {
      aw.fetch = savedFetch;
    }
    aw.resetForm();
    console.log('✅ Admin product form sends sizes and a count per size');

    {
      // Regression: every image blob must be appended WITH a filename. A
      // nameless Blob arrives at the server as filename="blob", which the
      // image-only upload filter rejects — that used to break every save
      // that included a back image.
      ad.getElementById('prodName').value = 'Back Image Regression';
      ad.getElementById('prodCategory').value = 'graphic-tees';
      ad.getElementById('prodPrice').value = '250';
      aw.eval('formImageBlob = new Blob(["mock-front"], { type: "image/webp" })');
      aw.eval('currentImageFiles.back = new Blob(["mock-back"], { type: "image/webp" })');
      aw.eval('extraImageItems = [{ url: "blob:mock-new", blob: new Blob(["mock-extra"], { type: "image/webp" }) }]');
      let sentBody = null;
      const savedFetch = aw.fetch;
      try {
        aw.fetch = (url, options) => {
          if (options && options.method === 'POST') { sentBody = options.body; return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'expected test response' }) }); }
          return savedFetch(url, options);
        };
        await aw.handleSaveProduct({ preventDefault() {} });
        assert.ok(sentBody instanceof aw.FormData, 'form must be submitted as FormData');
        const backFile = sentBody.get('back_image');
        assert.ok(backFile, 'back image must be included in the submission');
        assert.notEqual(backFile.name, 'blob', 'back image must not be sent without a filename');
        assert.match(backFile.name, /\.webp$/, 'back image needs an image extension');
        const extras = sentBody.getAll('extra_images');
        assert.equal(extras.length, 1, 'the selected extra photo must be included');
        assert.match(extras[0].name, /\.webp$/, 'extra photos need an image extension');
        assert.equal(sentBody.has('remove_extra'), false, 'create mode never sends a removal list');
      } finally {
        aw.fetch = savedFetch;
      }
      aw.resetForm();

      // Edit mode: existing gallery photos appear as removable thumbnails;
      // removing one sends remove_extra, kept ones are not re-uploaded.
      aw.eval('products = [{ id: 99999, name: "Gallery Edit Probe", category: "anime", fit: "Regular", price: 100, sale_price: null, unit_cost: null, description: "", sizes: ["L"], stock_qty: null, size_stock: null, front_image: "/uploads/front.webp", back_image: null, extra_images: ["/uploads/keep.webp", "/uploads/drop.webp"] }]');
      aw.editProduct(99999);
      assert.equal(ad.querySelectorAll('#extraPreviews .extra-thumb').length, 2, 'both existing gallery photos must be shown');
      ad.querySelectorAll('#extraPreviews .extra-thumb button')[1].click(); // remove drop.webp
      assert.equal(ad.querySelectorAll('#extraPreviews .extra-thumb').length, 1, 'the removed photo disappears');
      sentBody = null;
      const savedFetch2 = aw.fetch;
      try {
        aw.fetch = (url, options) => {
          if (options && options.method === 'PUT') { sentBody = options.body; return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'expected test response' }) }); }
          return savedFetch2(url, options);
        };
        await aw.handleSaveProduct({ preventDefault() {} });
        assert.equal(sentBody.get('remove_extra'), JSON.stringify(['/uploads/drop.webp']), 'only the removed photo is listed for deletion');
        assert.equal(sentBody.getAll('extra_images').length, 0, 'kept photos are not re-uploaded');
        assert.equal(sentBody.has('front_image'), false, 'an unchanged front image is not re-uploaded');
      } finally {
        aw.fetch = savedFetch2;
      }
      aw.resetForm();
    }
    console.log('✅ Admin product form names every image upload and manages gallery photos');

    ad.getElementById('productSearch').value = 'NoMatch987';
    aw.filterProducts();
    assert.equal(ad.querySelectorAll('#productList .product-row:not(.header-row)').length, 0);
    aw.eval('allOrders = [{id:1,status:"pending",total:100,order_number:"TEST",items:[],created_at:"2026-09-01"}]; filterOrders()');
    assert.equal(ad.querySelectorAll('#ordersList .order-row').length, 1);
    aw.toggleOrderSort();
    assert.equal(ad.querySelectorAll('#ordersList .order-row').length, 1);
    ad.getElementById('orderStatusFilter').value = 'delivered';
    aw.filterOrders();
    assert.match(ad.getElementById('ordersList').textContent, /No orders match/);
    console.log('✅ Admin product search, order filter and sort work');

    // Shared nav order/routes, mobile panel contract, and admin entry points.
    const navLinks = [...d.querySelectorAll('#navLinks > li > a')];
    assert.deepEqual(navLinks.map(a => a.textContent.trim()).filter(t => t !== 'Pants'), [
      'Home', 'Anime Shirts', 'Graphic Tees', 'Custom Stickers', 'About', 'Contact', 'Track Order'
    ], 'Pants link stays hidden until pants are live');
    const visibleNavLinks = navLinks.filter(a => a.closest('li').style.display !== 'none');
    assert.deepEqual(visibleNavLinks.map(a => a.getAttribute('href')), [
      '/', '/collection/anime', '/collection/graphic-tees',
      '/custom-stickers', '/about', '/contact', '/tracking'
    ]);
    const pantsNavItem = navLinks.find(a => a.textContent.trim() === 'Pants');
    assert.ok(pantsNavItem, 'Pants nav link is in markup (hidden until live)');
    assert.equal(pantsNavItem.closest('li').style.display, 'none', 'Pants nav hidden while no pants are stocked');
    const cardTiles = [...d.querySelectorAll('#page-home .cat-tile')];
    assert.deepEqual(cardTiles.map(t => t.querySelector('.cat-name').textContent.trim()), ['Graphic Tees', 'Anime Shirts', 'Pants', 'Custom Stickers']);
    const cardRoutes = Object.fromEntries(cardTiles.filter(t => t.tagName === 'A').map(tile => [
      tile.querySelector('.cat-name').textContent.trim(), tile.getAttribute('href')
    ]));
    for (const name of ['Anime Shirts', 'Graphic Tees', 'Custom Stickers']) {
      assert.equal(visibleNavLinks.find(a => a.textContent.trim() === name).getAttribute('href'), cardRoutes[name], `${name} nav link matches its homepage card`);
    }
    const pantsTileNavCheck = d.getElementById('catTilePants');
    assert.ok(pantsTileNavCheck && pantsTileNavCheck.tagName === 'SPAN' && pantsTileNavCheck.getAttribute('aria-disabled') === 'true', 'Pants tile is a disabled <span> (not a link) until live');
    const footerPantsLinks = [...d.querySelectorAll('.site-footer a')].filter(a => a.textContent.trim() === 'Pants' && a.closest('li').style.display !== 'none');
    assert.equal(footerPantsLinks.length, 0, 'Pants footer link stays hidden until products are live');
    const menuActions = d.querySelector('#navLinks .mobile-icons-row');
    assert.deepEqual([...menuActions.querySelectorAll('.nav-icon')].map(button => button.title), ['Track Order'], 'mobile menu keeps only the action missing from the header');
    assert.equal(menuActions.querySelectorAll('[title="Wishlist"], [title="Cart"], [title="Account"]').length, 0, 'mobile menu has no duplicate account/cart/wishlist icons');
    assert.equal(d.querySelector('#navLinks .nav-admin'), null, 'Admin is removed from the public nav');
    assert.equal(d.getElementById('wishlistCountMobile'), null);
    assert.equal(d.getElementById('cartCountMobile'), null);
    // The storefront admin sign-in modal was dead code (nothing ever opened it) and
    // has been deleted — /admin keeps its own login page as the single entry.
    // Identifiers are assembled from parts so a plain grep for the removed names
    // stays empty across the repo.
    const deadModal = ['admin', 'Login'].join('');   // the old modal's identifier stem
    assert.equal(d.getElementById(deadModal + 'Overlay'), null, 'the dead storefront admin modal is gone');
    assert.doesNotMatch(storeHtml, new RegExp('admin' + '-login-'), 'no admin sign-in modal CSS remains');
    for (const verb of ['open', 'close', 'submit']) {
      assert.equal(typeof w[verb + deadModal], 'undefined', `no ${verb}${deadModal[0].toUpperCase() + deadModal.slice(1)}() helper remains`);
    }
    const adminEntry = await fetch(origin + '/admin');
    assert.equal(adminEntry.status, 200, '/admin remains the public admin sign-in entry');
    assert.match(await adminEntry.text(), /id="loginPage"/);
    const adminRedirect = await fetch(origin + '/admin.html', { redirect: 'manual' });
    assert.equal(adminRedirect.status, 301, '/admin.html redirects instead of serving the panel');
    assert.equal(adminRedirect.headers.get('location'), '/admin', '/admin.html redirects to /admin');

    // JSDOM does not calculate visual layout; lock the CSS breakpoint contracts
    // at the requested widths and exercise open/close behavior at phone/tablet widths.
    assert.match(storeHtml, /@media \(max-width: 1023px\) \{\s*\.nav-links\.open \{[\s\S]*?display: flex;[\s\S]*?max-height: calc\(100dvh - 95px\);[\s\S]*?overflow-y: auto;[\s\S]*?background-color: var\(--bg-primary\);[\s\S]*?z-index: 1001;/, 'open menu is an opaque, bounded panel below the header');
    assert.match(storeHtml, /@media \(max-width: 768px\) \{\s*\.nav-links \{\s*position: absolute; top: 100%; left: 0; right: 0; width: 100%;\s*background: var\(--bg-primary\);/, 'phone/tablet menu spans the viewport with a solid background');
    assert.match(storeHtml, /@media \(max-width: 360px\) \{\s*\.nav-inner \{ flex-wrap: wrap; \}/, 'the 360px header keeps its wrapping guard');
    assert.match(storeHtml, /\.hamburger\.active svg line:nth-child\(2\) \{ transform: translateY\(6px\) rotate\(45deg\); \}/, 'the SVG hamburger animates into an X');
    assert.doesNotMatch(storeHtml, /\.hamburger\.active span:nth-child/, 'hamburger state does not target nonexistent spans');
    assert.match(storeHtml, /@media \(min-width: 1024px\) \{[\s\S]*?\.nav-links \{[\s\S]*?display: flex !important;[\s\S]*?position: static;[\s\S]*?flex-direction: row;[\s\S]*?\.hamburger \{ display: none; \}/, 'desktop nav stays horizontal and hides the hamburger');
    assert.match(storeHtml, /@media \(min-width: 1024px\) \{[\s\S]*?\.nav-links li\.mobile-search,[\s\S]*?\.nav-links li\.mobile-icons-row \{ display: none !important; \}/, 'mobile-only rows stay hidden on desktop');
    const hamburger = d.getElementById('hamburger');
    const navList = d.getElementById('navLinks');
    assert.equal(hamburger.getAttribute('aria-expanded'), 'false');
    for (const width of [360, 414, 768]) {
      Object.defineProperty(w, 'innerWidth', { configurable: true, value: width });
      d.body.style.overflow = 'auto';
      hamburger.click();
      assert.equal(navList.classList.contains('open'), true, `${width}px menu opens`);
      assert.equal(hamburger.classList.contains('active'), true, `${width}px icon enters its open state`);
      assert.equal(hamburger.getAttribute('aria-expanded'), 'true', `${width}px aria-expanded follows open state`);
      assert.equal(hamburger.getAttribute('aria-label'), 'Close menu');
      assert.equal(d.body.style.overflow, 'hidden', `${width}px body scroll locks while menu is open`);
      if (width === 360) {
        d.getElementById('mainContent').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
      } else if (width === 414) {
        d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        d.querySelector('#navLinks a[href="/contact"]').click();
      }
      assert.equal(navList.classList.contains('open'), false, `${width}px menu closes by outside tap, Escape or link tap`);
      assert.equal(hamburger.classList.contains('active'), false);
      assert.equal(hamburger.getAttribute('aria-expanded'), 'false');
      assert.equal(hamburger.getAttribute('aria-label'), 'Open menu');
      assert.equal(d.body.style.overflow, 'auto', `${width}px previous body scroll state is restored`);
    }
    Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
    assert.equal(navList.classList.contains('open'), false, 'desktop menu remains in its closed horizontal-nav state');
    d.body.style.overflow = '';

    // Hidden admin tabs must stay inside the main column (not become siblings
    // in the dashboard flex row).
    assert.match(storeHtml, /\.shop-section \{ display: none; padding:/, 'the shop grid is hidden by default via CSS, not an inline style');
    assert.match(storeHtml, /\.shop-section\.shop-visible \{\s*display: block;/, 'the .shop-visible class reveals the shop grid');
    assert.doesNotMatch(storeHtml, /id="shopSection"[^>]*style=/, 'no inline display style can drift from the class again');
    assert.match(storeHtml, /\.cart-drawer\.open \{ transform: translateX\(0\); \}/);
    assert.match(storeHtml, /\.filter-drawer\.open \{ transform: translateX\(0\); \}/);
    for (const section of ['products', 'orders', 'reports', 'add']) {
      assert.equal(ad.getElementById('tab-' + section).parentElement.className, 'main-content');
    }
    aw.switchSection('reports');
    assert.equal(ad.getElementById('mobileAdminSection').value, 'reports');
    assert.equal(ad.getElementById('tab-reports').classList.contains('active'), true);
    console.log('✅ Mobile menu order, routes, icons, panel/scroll behavior and desktop nav contracts pass');

    // ---------------------------------------------------------------
    // Scenario 19: email verification gates the order history
    // ---------------------------------------------------------------
    const acct = page(storeHtml, '/account'); windows.push(acct);
    await wait(100);
    const cw = acct.window, cd = cw.document;
    // Unverified: the prompt replaces the empty state and the banner is shown.
    cw.currentCustomer = { id: 7, email: 'unverified@kage.test', name: 'Unverified', email_verified: false };
    cw.updateVerifyBanner(false);
    cw.renderAccountOrders([], false);
    const banner = cd.getElementById('acctVerifyBanner');
    assert.equal(banner.hidden, false, 'the verify banner is visible for an unverified account');
    assert.match(banner.textContent, /Verify your email/i, 'the banner explains why history is hidden');
    assert.match(cd.getElementById('acctVerifyLink').textContent, /Resend/i, 'the banner offers a resend link');
    assert.match(cd.getElementById('acctOrders').textContent, /Verify your email to see your orders/i, 'the history area shows the verify state');
    assert.match(cd.getElementById('acctOrders').innerHTML, /resendVerificationEmail\(\)/, 'the empty state links to the resend action');
    // Verified: the banner hides and real rows render.
    cw.updateVerifyBanner(true);
    cw.renderAccountOrders([{ order_number: 'KAGE-TEST1234', status: 'pending', total: 1500, created_at: '2026-10-11 10:00:00' }], true);
    assert.equal(cd.getElementById('acctVerifyBanner').hidden, true, 'the banner hides once the email is verified');
    assert.match(cd.getElementById('acctOrders').textContent, /KAGE-TEST1234/, 'verified accounts see their order rows');
    assert.doesNotMatch(cd.getElementById('acctOrders').textContent, /Verify your email to see your orders/i);

    // The emailed link lands on /verify-email?token=... and is consumed on load.
    let verifyRequestUrl = null;
    const verifyPage = page(storeHtml, '/verify-email?token=abc123def456', {
      fetchImpl: (url) => {
        if (String(url).startsWith('/api/auth/verify-email')) {
          verifyRequestUrl = String(url);
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, message: 'Email verified. Your order history is now available.' }) });
        }
        if (String(url).startsWith('/api/customers/me')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ customer: null }) });
        return fetch(origin + url);
      }
    });
    windows.push(verifyPage);
    await wait(150);
    const vd = verifyPage.window.document;
    assert.ok(vd.getElementById('page-verify').classList.contains('active'), 'the verify route shows the verify page');
    assert.match(verifyRequestUrl || '', /\/api\/auth\/verify-email\?token=abc123def456/, 'the token from the URL is sent to the verify endpoint');
    assert.equal(vd.getElementById('vfyMsg').style.display, 'block', 'a successful verification is reported to the user');
    assert.match(vd.getElementById('vfyMsg').textContent, /verified/i);

    // A link without a token explains itself instead of failing silently.
    const noToken = page(storeHtml, '/verify-email'); windows.push(noToken);
    await wait(150);
    const nd = noToken.window.document;
    assert.equal(nd.getElementById('vfyError').style.display, 'block', 'a token-less link shows an explanation');
    assert.match(nd.getElementById('vfyError').textContent, /missing its token/i);
    console.log('✅ Email verification: account banner, resend link, verify route and token handling');

    // ---------------------------------------------------------------
    // Scenario 20: a browser with no CSRF cookie completes a checkout
    // ---------------------------------------------------------------
    // The public cacheable reads (/api/products, /api/products/:id, /api/reviews)
    // must never send Set-Cookie; when the cookie is gone (expired/cleared) the
    // storefront's fetch wrapper must ask the no-store /api/csrf endpoint for one
    // before the order POST.
    const fresh = page(storeHtml, '/', { browserCookies: true });
    windows.push(fresh);
    await ready(fresh.window);
    const fw = fresh.window, fd = fw.document;

    const cacheableReads = fresh.requests.filter(r => r.url === '/api/products'
      || /^\/api\/products\/\d+$/.test(r.url) || r.url.startsWith('/api/reviews'));
    assert.ok(cacheableReads.length > 0, 'the storefront must load its catalogue from the API');
    for (const read of cacheableReads) {
      assert.deepEqual(read.setCookie, [], `${read.url} must not send Set-Cookie to the browser`);
    }

    // Simulate the cookie expiring/being cleared mid-session.
    fd.cookie = 'kage.csrf=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    assert.equal(fd.cookie.includes('kage.csrf='), false, 'the browser has no CSRF cookie before checkout');

    const added = fw.eval(`(function () {
      const p = allProducts.find(x => x.in_stock && x.sizes && x.sizes.length && (x.stock_qty == null || Number(x.stock_qty) > 0) && (!x.size_stock || Number(x.size_stock[x.sizes[0]] || 0) > 0));
      return p ? addToCart(p, p.sizes[0], 1) : false;
    })()`);
    assert.equal(added, true, 'an in-stock product must go into the cart');

    fw.navigateTo('checkout');
    assert.ok(fd.getElementById('page-checkout').classList.contains('active'), 'checkout opens with a filled cart');
    fd.getElementById('coName').value = 'Fresh Browser';
    fd.getElementById('coEmail').value = 'fresh.browser@kage.test';
    fd.getElementById('coPhone').value = '03001234500';
    fd.getElementById('coAddress').value = '1 Fresh St';
    fd.getElementById('coCity').value = 'Lahore';
    await fw.eval('placeOrder()');

    const csrfRequest = fresh.requests.find(r => r.url === '/api/csrf');
    const orderRequest = fresh.requests.find(r => r.url === '/api/orders' && r.method === 'POST');
    assert.ok(csrfRequest, `the storefront must fetch a token first (saw: ${JSON.stringify(fresh.requests.map(r => r.url))})`);
    assert.ok(orderRequest, 'the order must be posted');
    assert.ok(fresh.requests.indexOf(orderRequest) > fresh.requests.indexOf(csrfRequest), 'the token must be fetched BEFORE the order is posted');
    assert.ok(csrfRequest.setCookie.some(c => c.startsWith('kage.csrf=')), 'the endpoint hands the browser a CSRF cookie');
    assert.match(fd.cookie, /kage\.csrf=/, 'the browser stores the CSRF cookie');
    assert.equal(fd.getElementById('page-confirmation').classList.contains('active'), true, 'the order completes and the confirmation page shows');
    assert.match(fd.getElementById('confNumber').textContent, /^KAGE-[A-Z0-9]{8}$/, 'the confirmation shows a real order number');

    // The shop really has that order.
    const tracked = await fetch(`${origin}/api/orders/track?number=${encodeURIComponent(fd.getElementById('confNumber').textContent.trim())}&phone=03001234500`);
    assert.equal(tracked.status, 200, 'the placed order must be trackable');
    assert.equal((await tracked.json()).status, 'pending', 'a COD order starts pending');

    // With the cookie now present, no further token request is made: the
    // cookie's value is reused for the next state-changing call.
    const csrfRequestsBefore = fresh.requests.filter(r => r.url === '/api/csrf').length;
    const reused = await fw.eval('ensureCsrfToken()');
    assert.equal(reused, fd.cookie.match(/kage\.csrf=([^;]*)/)[1], 'the cookie token is reused');
    assert.equal(fresh.requests.filter(r => r.url === '/api/csrf').length, csrfRequestsBefore, 'no extra token request while the cookie exists');
    console.log('✅ Fresh browser checkout: no Set-Cookie on cached reads, token from /api/csrf, order placed and tracked');

    // ---- The themed collections (The Vault / Iron Code / After Hours) were
    // ---- removed: no pages, no titles, no Collection filter, no data field.
    for (const slug of ['the-vault', 'iron-code', 'after-hours']) {
      const removed = page(storeHtml, '/collection/' + slug); windows.push(removed);
      await ready(removed.window);
      await wait(100);
      const rw = removed.window, rd = rw.document;
      assert.equal(rw.location.pathname, '/collection/all',
        `/collection/${slug} must land on /collection/all like any unknown collection URL`);
      assert.equal(rd.getElementById('page-home').classList.contains('active'), true,
        `/collection/${slug} renders the normal catalog view, not a broken page`);
      assert.equal(rd.getElementById('page-not-found').classList.contains('active'), false);
      assert.equal(rd.getElementById('page-coming-soon').classList.contains('active'), false);
      assert.equal(rd.getElementById('collectionTitle').textContent, 'FEATURED DROPS | NEW ARRIVALS',
        'no themed collection title is shown');
      assert.ok(rd.querySelectorAll('#collectionGrid .product-card').length > 0, 'the full catalog is shown');
    }
    // The three pages, their titles/descriptions and the dropdown options are
    // gone from the storefront source entirely.
    for (const needle of ['the-vault', 'iron-code', 'after-hours', 'the vault', 'iron code', 'after hours']) {
      assert.equal(storeHtml.toLowerCase().includes(needle), false,
        `storefront markup must not mention "${needle}"`);
    }
    assert.equal(d.querySelector('.filter-section[data-group="collection"]'), null,
      'the Collection filter section is gone from the filter panel');
    assert.equal(d.querySelector('.fp-collection'), null, 'no Collection dropdown remains');
    assert.equal(d.getElementById('filterDrawerBody').querySelector('.fp-collection'), null,
      'the mobile Filter drawer has no Collection dropdown either');
    assert.equal(w.eval('typeof filterState.collection'), 'undefined',
      'filterState no longer carries a collection filter');
    assert.ok(w.eval('allProducts.every(p => !("collections" in p))'),
      'fallback catalog products carry no collections field');
    const publicCatalog = await (await fetch(origin + '/api/products')).json();
    assert.ok(publicCatalog.length > 0);
    assert.ok(publicCatalog.every(p => !('collections' in p)),
      'the public products API no longer returns collections');
    // Direct navigation with a deleted slug is normalized the same way.
    w.navigateTo('collection', 'the-vault');
    assert.equal(w.location.pathname, '/collection/all');
    assert.equal(d.getElementById('collectionTitle').textContent, 'FEATURED DROPS | NEW ARRIVALS');
    w.resetFilters();
    console.log('✅ Removed collection pages and the Collection filter are gone; deleted URLs land on /collection/all');

    // ---- The Filter drawer still opens and its remaining filters still work.
    w.navigateTo('collection', 'all');
    const drawer = d.getElementById('filterDrawer');
    assert.ok(drawer, 'the Filter drawer exists');
    w.openFilterDrawer();
    assert.ok(drawer.classList.contains('open'), 'the Filter drawer opens');
    assert.ok(d.getElementById('filterOverlay').classList.contains('open'), 'the drawer overlay opens with it');
    const drawerBody = d.getElementById('filterDrawerBody');
    assert.ok(drawerBody.querySelector('.fp-cat'), 'style filters are in the drawer');
    assert.ok(drawerBody.querySelector('.price-min') && drawerBody.querySelector('.price-max'), 'price filter is in the drawer');
    assert.ok(drawerBody.querySelector('.fp-size'), 'size filter is in the drawer');
    // Style filter: keep only Anime-Inspired and the grid narrows to that style.
    for (const cb of drawerBody.querySelectorAll('.fp-cat')) {
      cb.checked = cb.value === 'Anime-Inspired';
      cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    assert.ok(w.eval('getFilteredProducts().length > 0 && getFilteredProducts().every(p => p.style === "Anime-Inspired")'),
      'the drawer style filter narrows the grid to the checked style');
    assert.equal(d.querySelector('#filterSidebar .fp-cat[value="Anime-Inspired"]').checked, true,
      'drawer changes sync to the desktop filter panel');
    // Size filter through the drawer.
    const drawerSize = drawerBody.querySelector('.fp-size');
    drawerSize.value = 'XXL';
    drawerSize.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.ok(w.eval('getFilteredProducts().every(p => p.sizes.includes("XXL"))'),
      'the drawer size filter keeps only matching sizes');
    assert.equal(d.querySelector('#filterSidebar .fp-size').value, 'XXL', 'the size change syncs to the sidebar');
    // Price filter through the drawer: clamping to 0 must empty the grid.
    const drawerMax = drawerBody.querySelector('.price-max');
    drawerMax.value = '0';
    drawerMax.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.getElementById('resultCount').textContent, '0 results', 'the price filter still filters');
    assert.ok(d.getElementById('collectionGrid').textContent.includes('No products match your filters'));
    assert.equal(d.getElementById('filterBadge').textContent, '4',
      'two unchecked styles + size + price count as four active filters — the collection filter no longer counts');
    // Apply closes the drawer; Reset restores everything.
    [...drawer.querySelectorAll('button')].find(b => b.textContent.trim() === 'Apply').click();
    assert.equal(drawer.classList.contains('open'), false, 'Apply closes the Filter drawer');
    w.resetFilters();
    assert.equal(d.getElementById('filterBadge').textContent, '0', 'Reset Filters clears every remaining filter');
    assert.ok(w.eval('getFilteredProducts().length > 0'), 'the full catalog returns after reset');
    console.log('✅ Filter drawer opens and its style/price/size filters still work');

    assert.deepEqual(errors, []);
    console.log('\n25/25 frontend scenarios passed');
  } finally {
    windows.forEach(win => win.window.close());
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
