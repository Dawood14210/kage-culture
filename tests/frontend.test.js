// DOM-level interaction regressions for the static storefront and admin panel.
// Run with `npm test`. Most scenarios are DOM-level (jsdom — no browser
// download required); responsive layout, image-priority and floating-action
// checks run in real Chromium (see tests/fixtures/chromium.js).
// The panel scenario logs in for real: the admin view now reads its catalog
// from the authenticated /api/admin/products endpoint, because the public
// one deliberately omits internal columns such as unit_cost.
process.env.NODE_ENV = process.env.NODE_ENV || 'test'; // allows the dev fallback in utils/secret.js
process.env.ALLOW_ADMIN_SETUP = 'true';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'frontend-test-secret-0123456789abcdefghij';
// The real-Chromium scenarios open dozens of pages (and fetch their images) from one IP within a
// minute, far past the production per-minute request budget. Lift the global limiter for this
// process the way e2e.test.js does, before the server (and its limiter) is loaded.
require('../config').RATE_LIMIT_GLOBAL = 1000;
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { app, ensureReady } = require('../server');

const { stitched } = require('./fixtures/stitch');
const storeHtml = stitched('storefront');
// Bumped by every console.log('✅ …') so the summary can never drift from the
// number of scenarios that actually ran. Must be installed before main() runs.
let scenarioCount = 0;
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('✅')) scenarioCount++;
  realConsoleLog(...args);
};
const adminHtml = stitched('admin');
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
function page(html, path = '/', { storage = {}, offline = false, fetchImpl, browserCookies = false, cookies = [] } = {}) {
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
      // Cookies planted before any page script runs (jsdom's jar, so the
      // browserCookies fetch shim forwards them like a real browser would).
      for (const cookie of cookies) w.document.cookie = cookie + '; Path=/';
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
    assert.equal(d.title, 'Anime Shirts | KAGE CULTURE', 'SPA collection title matches server-rendered collection metadata');
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
    w.loadMore();
    const size = d.querySelector('#filterSidebar .fp-size');
    size.value = 'XL';
    size.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.match(d.querySelector('#catalogShowing').textContent, /^Showing (\d+) of \1$/, 'a fully-visible filtered grid reports "Showing N of N"');
    assert.equal(d.getElementById('loadMoreBtn').style.display, 'none', 'no Load more when everything fits');
    assert.ok(d.querySelector('#collectionGrid .product-card'));
    assert.ok(w.eval('renderProductCard(allProducts.find(p => p.name === "Wrath Silhouette"))').includes('class="product-discount-badge"'));
    console.log('✅ Filters clamp pagination; homepage sale badge is displayed');

    w.quickAdd(9);
    assert.equal(d.getElementById('cartDrawer').classList.contains('open'), true, 'add to cart opens the cart list');
    w.toggleWishlist(9);
    assert.equal(d.querySelector('#cartCount').textContent, '1');
    assert.equal(d.querySelector('#wishlistCount').textContent, '1');
    // Favouriting opens the favourites list; only one drawer is open at a time.
    assert.equal(d.getElementById('cartDrawer').classList.contains('open'), false, 'the favourites list replaces the cart list');
    assert.equal(d.getElementById('wishlistDrawer').classList.contains('open'), true, 'favouriting opens the favourites list');
    w.toggleCart(true);
    assert.equal(d.getElementById('wishlistDrawer').classList.contains('open'), false, 'opening the cart closes the favourites list');
    w.toggleCart(false);
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
    assert.equal(d.title, 'Wrath Silhouette | KAGE CULTURE', 'SPA product title matches server-rendered product metadata');
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
    assert.equal(deepLink.window.document.querySelector('.hero-copy .btn').getAttribute('data-route'), 'collection');
    assert.equal(deepLink.window.document.querySelector('.hero-copy .btn').getAttribute('data-filter'), 'all');
    assert.notEqual(deepLink.window.document.documentElement.style.getPropertyValue('--header-h'), '');
    console.log('✅ Product deep links, media, and browser Back work');

    // Per-size stock: a product offering S/M/L with S=2, M=0 (sold out), L=5.
    const db = require('../database');
    // A manual Sold Out flag preserves inventory but blocks buying, not browsing.
    {
      const inserted = await db.prepare(`INSERT INTO products
        (name, category, fit, price, sale_price, on_sale, sizes, description, stock_qty, in_stock, front_image, extra_images)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('Sold Out Visibility Pants', 'pants', 'Relaxed', 2499, 1999, 1, '["S","M"]', 'The description remains visible.', 3, 1, '/images/pants.jpg', '[]');
      const pid = Number(inserted.lastInsertRowid);
      await db.prepare('INSERT INTO product_size_stock (product_id, size, stock_qty) VALUES (?, ?, ?)').run(pid, 'S', 3);
      await db.prepare('INSERT INTO product_size_stock (product_id, size, stock_qty) VALUES (?, ?, ?)').run(pid, 'M', 0);
      const soldPage = page(storeHtml, '/product/' + pid); windows.push(soldPage);
      const pw = soldPage.window, pd = pw.document;
      try {
        await ready(pw); await wait(50);
        pw.quickAdd(pid);
        const cartThumb = pd.querySelector('#cartItems .cart-item-image img');
        assert.ok(cartThumb, 'cart drawer renders the product thumbnail');
        assert.equal(cartThumb.getAttribute('width'), '55');
        assert.equal(cartThumb.getAttribute('height'), '55');
        assert.equal(cartThumb.getAttribute('loading'), 'lazy');
        assert.equal(cartThumb.getAttribute('decoding'), 'async');
        pw.toggleWishlist(pid);
        pw.navigateTo('checkout');
        const checkoutThumb = pd.querySelector('#coItems .co-item-img img');
        assert.ok(checkoutThumb, 'checkout summary renders the product thumbnail');
        assert.equal(checkoutThumb.getAttribute('width'), '52');
        assert.equal(checkoutThumb.getAttribute('height'), '60');
        assert.equal(checkoutThumb.getAttribute('loading'), 'lazy');
        assert.equal(checkoutThumb.getAttribute('decoding'), 'async');
        await db.prepare('UPDATE products SET in_stock = 0 WHERE id = ?').run(pid);
        await pw.loadProductsFromAPI();
        assert.equal(pw.eval('cart.length'), 1, 'sold-out cart lines stay visible after refresh');
        assert.match(pd.getElementById('cartItems').textContent, /Sold Out — unavailable/);
        assert.match(pd.getElementById('wishlistItems').textContent, /Sold Out — unavailable/);
        assert.equal(pd.querySelector('#wishlistItems .btn').disabled, true);
        assert.equal(pd.querySelector('#cartFooter button').disabled, true);
        assert.equal(pd.getElementById('coPlaceBtn').disabled, true, 'an already open checkout is disabled on refetch');
        assert.match(pd.getElementById('coItems').textContent, /Unavailable/);
        await pw.placeOrder();
        assert.match(pd.getElementById('checkoutError').textContent, /unavailable/i);
        pw.navigateTo('home'); pw.startCheckout();
        assert.equal(pd.getElementById('page-checkout').classList.contains('active'), false);
        assert.equal(pw.eval(`addToCart(allProducts.find(p => p.id === ${pid}), 'S', 1)`), false);
        for (const route of ['all', 'pants', 'sale']) {
          pw.navigateTo('collection', route);
          assert.ok(pd.querySelector(`#collectionGrid .product-card[data-pid="${pid}"]`), route + ' must keep sold-out products');
        }
        pw.onSearchInput('Sold Out Visibility');
        assert.ok(pd.querySelector(`#collectionGrid .product-card[data-pid="${pid}"]`));
        pw.onSearchInput('');
        pw.openProductDetail(pid);
        assert.equal(pd.getElementById('addToCartBtn').textContent, 'Sold Out');
        assert.equal(pd.getElementById('addToCartBtn').disabled, true);
        assert.equal(pd.querySelector('#stickyCartBar .btn').textContent, 'Sold Out');
        assert.ok([...pd.querySelectorAll('#page-product .qty-btn, #detailSizePicker button')].every(b => b.disabled));
        assert.match(pd.getElementById('detailDesc').textContent, /description remains visible/);
        assert.ok(pd.querySelector('#galleryTrack img'));
        assert.doesNotMatch(pd.getElementById('detailUrgency').textContent, /left in stock/);
        assert.equal(pw.eval('cart[0].qty'), 1);
        pw.detailChangeQty(1);
        assert.equal(pd.getElementById('detailQty').textContent, '1');
        // Restocking a still-open detail page re-enables its controls.
        await db.prepare('UPDATE products SET in_stock = 1 WHERE id = ?').run(pid);
        await pw.loadProductsFromAPI();
        assert.equal(pd.getElementById('addToCartBtn').disabled, false);
        assert.equal(pd.getElementById('addToCartBtn').textContent, 'Add to Cart');
        assert.equal(pd.querySelector('#cartFooter button').disabled, false);
        // Depleted inventory follows the same UI contract, including direct links.
        await db.prepare('UPDATE product_size_stock SET stock_qty = 0 WHERE product_id = ?').run(pid);
        await db.prepare('UPDATE products SET stock_qty = 0, in_stock = 0 WHERE id = ?').run(pid);
        await pw.loadProductsFromAPI();
        assert.equal(pd.getElementById('addToCartBtn').disabled, true, 'stock loss refreshes an open detail page');
        const soldLink = page(storeHtml, '/product/' + pid, { storage: {
          kageCart: pw.localStorage.getItem('kageCart'), kageWishlist: pw.localStorage.getItem('kageWishlist')
        } }); windows.push(soldLink);
        await ready(soldLink.window); await wait(50);
        assert.equal(soldLink.window.document.getElementById('detailName').textContent, 'Sold Out Visibility Pants');
        assert.equal(soldLink.window.document.getElementById('addToCartBtn').textContent, 'Sold Out');
        assert.equal(soldLink.window.eval('cart.length'), 1, 'unavailable lines remain visible across visits');
      } finally {
        await db.prepare('DELETE FROM product_size_stock WHERE product_id = ?').run(pid);
        await db.prepare('DELETE FROM products WHERE id = ?').run(pid);
      }
      console.log('✅ Sold-out products remain browsable, refresh detail/cart/wishlist, and block checkout');
    }

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
    assert.equal(sd.querySelector('[data-size="M"]').closest('.size-option').querySelector('.size-stock-status').textContent, 'Sold Out');
    assert.equal(sd.querySelector('[data-size="L"]').closest('.size-option').querySelector('.size-stock-status').textContent, '');
    // Small being zero must not label the entire product Sold Out.
    const originalCounts = { S: 2, M: 0, L: 5 };
    try {
      await db.prepare('UPDATE product_size_stock SET stock_qty = ? WHERE product_id = ? AND size = ?').run(0, sizeTeeId, 'S');
      await db.prepare('UPDATE products SET stock_qty = 5 WHERE id = ?').run(sizeTeeId);
      await sw.loadProductsFromAPI();
      assert.equal(sd.getElementById('addToCartBtn').textContent, 'Add to Cart');
      assert.equal(sd.getElementById('addToCartBtn').disabled, false);
      assert.equal(sw.eval('detailSize'), 'L', 'select an available size, not zero-stock Small');
      assert.equal(sd.querySelector('[data-size="S"]').closest('.size-option').querySelector('.size-stock-status').textContent, 'Sold Out');
      assert.equal(sd.querySelector('[data-size="L"]').disabled, false);
      sw.navigateTo('collection', 'anime');
      assert.equal(sd.querySelector(`#collectionGrid [data-pid="${sizeTeeId}"] .sale-flag`), null,
        'card must not be SOLD OUT while Large is available');
      sw.openProductDetail(sizeTeeId);
      await db.prepare('UPDATE product_size_stock SET stock_qty = 0 WHERE product_id = ?').run(sizeTeeId);
      await db.prepare('UPDATE products SET stock_qty = 0, in_stock = 0 WHERE id = ?').run(sizeTeeId);
      await sw.loadProductsFromAPI();
      assert.equal(sd.getElementById('addToCartBtn').textContent, 'Sold Out');
      assert.equal(sd.getElementById('addToCartBtn').disabled, true);
      assert.ok([...sd.querySelectorAll('.size-stock-status')].every(label => label.textContent === 'Sold Out'));
      sw.navigateTo('collection', 'anime');
      assert.equal(sd.querySelector(`#collectionGrid [data-pid="${sizeTeeId}"] .sale-flag`).textContent, 'SOLD OUT');
    } finally {
      for (const [size, qty] of Object.entries(originalCounts)) {
        await db.prepare('UPDATE product_size_stock SET stock_qty = ? WHERE product_id = ? AND size = ?').run(qty, sizeTeeId, size);
      }
      await db.prepare('UPDATE products SET stock_qty = 7, in_stock = 1 WHERE id = ?').run(sizeTeeId);
    }
    console.log('✅ Per-size product page: sold-out sizes disabled, quantity capped per size');

    // ---- Detail tabs: Fabric & Care / Fit Guide are per product ----
    // The shipped markup IS the generic copy, so a product without saved text
    // must keep it verbatim, and browsing a customised product in between must
    // not leak its copy into the next one.
    {
      const tabsW = w, tabsD = d;
      const fabricPane = () => tabsD.getElementById('tab-fabric');
      const fitPane = () => tabsD.getElementById('tab-fit');
      const genericFabric = fabricPane().innerHTML;
      const genericFit = fitPane().innerHTML;
      // The fixture must really be the generic list, or the fallback proves nothing.
      assert.ok(tabsD.querySelectorAll('#tab-fabric li').length > 0, 'shipped markup must carry the generic fabric list');
      assert.ok(tabsD.querySelectorAll('#tab-fit li').length > 0, 'shipped markup must carry the generic fit list');

      const tabTee = await db.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get();
      const pid = tabTee.id;
      try {
        // 1. No saved copy -> the generic lists survive untouched.
        await db.prepare('UPDATE products SET fabric_care = NULL, fit_guide = NULL WHERE id = ?').run(pid);
        await tabsW.loadProductsFromAPI();
        tabsW.openProductDetail(pid);
        assert.equal(fabricPane().innerHTML, genericFabric, 'a product with no saved fabric copy keeps the generic list');
        assert.equal(fitPane().innerHTML, genericFit, 'a product with no saved fit copy keeps the generic list');

        // 2. Saved copy renders one <li> per line, with typed bullets stripped.
        await db.prepare('UPDATE products SET fabric_care = ?, fit_guide = ? WHERE id = ?')
          .run('- 100% cotton, 240 GSM\n• Wash cold\n\n  Tumble dry low  ', 'Boxy oversized body\nSize down for regular', pid);
        await tabsW.loadProductsFromAPI();
        tabsW.openProductDetail(pid);
        const fabricItems = [...tabsD.querySelectorAll('#tab-fabric li')].map(li => li.textContent.trim());
        const fitItems = [...tabsD.querySelectorAll('#tab-fit li')].map(li => li.textContent.trim());
        assert.deepEqual(fabricItems, ['100% cotton, 240 GSM', 'Wash cold', 'Tumble dry low'],
          'one bullet per line, typed -/• prefixes stripped, blank lines dropped');
        assert.deepEqual(fitItems, ['Boxy oversized body', 'Size down for regular'], 'the fit guide renders one <li> per line');

        // 3. Back to a product with no copy: the generic lists return, not the last product's text.
        const plain = await db.prepare('SELECT id FROM products WHERE id != ? ORDER BY id LIMIT 1').get(pid);
        await db.prepare('UPDATE products SET fabric_care = NULL, fit_guide = NULL WHERE id = ?').run(plain.id);
        await tabsW.loadProductsFromAPI();
        tabsW.openProductDetail(plain.id);
        assert.equal(fabricPane().innerHTML, genericFabric, 'browsing an un-customised product afterwards restores the generic fabric list');
        assert.equal(fitPane().innerHTML, genericFit, 'browsing an un-customised product afterwards restores the generic fit list');

        // 4. Rows are escaped: admin copy is text, never markup.
        await db.prepare('UPDATE products SET fabric_care = ? WHERE id = ?')
          .run('<img src=x onerror=alert(1)>', pid);
        await tabsW.loadProductsFromAPI();
        tabsW.openProductDetail(pid);
        assert.equal(tabsD.querySelectorAll('#tab-fabric img').length, 0, 'markup in saved copy must not become an element');
        assert.equal(tabsD.querySelector('#tab-fabric li').textContent, '<img src=x onerror=alert(1)>', 'the payload shows as literal text');
      } finally {
        await db.prepare('UPDATE products SET fabric_care = NULL, fit_guide = NULL WHERE id = ?').run(pid);
        await tabsW.loadProductsFromAPI();
      }
      console.log('✅ Detail tabs: per-product Fabric & Care / Fit Guide, generic copy preserved as the fallback');
    }

    // ---- Home category card photos: custom swaps out the bundled <picture> ----
    {
      const cw = w, cd = d;
      const thumbOf = (cat) => cd.querySelector(`#categoryStrip .cat-tile[data-cat="${cat}"] .cat-thumb`);
      // The bundled markup is the default; capture it before any swap.
      const defaultThumb = thumbOf('pants').innerHTML;
      assert.ok(/<picture>/.test(defaultThumb), 'the fixture ships a <picture> with WebP crops');

      cw.applyCategoryCardPhotos([{
        id: 'pants', label: 'Pants', image: '/uploads/pants-custom.webp', alt: 'Custom pants art', isCustom: true,
        srcset: '/uploads/pants-custom-300.webp 300w, /uploads/pants-custom.webp 600w', width: 600, height: 600
      }]);
      assert.equal(/<picture>/.test(thumbOf('pants').innerHTML), false, 'a custom photo drops the bundled <picture> so its crops cannot win');
      assert.equal(thumbOf('pants').querySelector('img').getAttribute('src'), '/uploads/pants-custom.webp');
      assert.equal(thumbOf('pants').querySelector('img').getAttribute('alt'), 'Custom pants art');
      // Uploaded photos ship their own candidates + a sizes value that matches
      // the circle, so a phone never downloads the 600px file for a 104px box.
      assert.equal(thumbOf('pants').querySelector('img').getAttribute('srcset'),
        '/uploads/pants-custom-300.webp 300w, /uploads/pants-custom.webp 600w', 'the server srcset is rendered verbatim');
      assert.equal(thumbOf('pants').querySelector('img').getAttribute('sizes'), '(min-width: 1024px) 150px, 104px');
      assert.equal(thumbOf('pants').querySelector('img').getAttribute('width'), '600', 'pixel attributes keep the aspect ratio');
      assert.equal(thumbOf('pants').querySelector('img').getAttribute('height'), '600');
      // The card still links to the real collection route.
      assert.equal(cd.querySelector('#categoryStrip .cat-tile[data-cat="pants"]').getAttribute('href'), '/collection/pants');

      // Other cards are untouched by one card's override.
      assert.equal(/<picture>/.test(thumbOf('anime').innerHTML), true, 'other cards keep their bundled photo');

      // Resetting restores the shipped <picture> markup verbatim.
      cw.applyCategoryCardPhotos([{ id: 'pants', label: 'Pants', image: '/images/pants.jpg', alt: 'Pants', isCustom: false }]);
      assert.equal(thumbOf('pants').innerHTML, defaultThumb, 'reset restores the bundled markup exactly');

      // A malformed payload must never replace a photo or throw.
      const before = thumbOf('anime').innerHTML;
      cw.applyCategoryCardPhotos(null);
      cw.applyCategoryCardPhotos([{ id: 'anime' }, { id: 'nope', image: 'x' }]);
      assert.equal(thumbOf('anime').innerHTML, before, 'a malformed payload leaves the photos alone');

      // A non-OK response keeps the bundled photos and surfaces no error. Kept
      // synchronous: this suite closes each jsdom window aggressively, so a
      // pending promise from an earlier window is not a safe place to assert.
      const realFetch = cw.fetch;
      let requested = 0;
      cw.fetch = () => { requested++; return Promise.resolve({ ok: false, json: async () => [] }); };
      cw.syncCategoryCardPhotos();
      cw.syncCategoryCardPhotos();
      assert.equal(requested, 2, 'each refresh asks for the current photos once');
      cw.fetch = realFetch;
      assert.equal(/<picture>/.test(thumbOf('anime').innerHTML), true, 'a failed photo request keeps the bundled image');
      console.log('✅ Home category photos: custom swaps, reset restores, failures keep the bundled art');
    }

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
    const galleryImages = [...d.querySelectorAll('#galleryTrack img')];
    assert.deepEqual(galleryImages.map(image => [image.getAttribute('width'), image.getAttribute('height')]), [['900', '1200'], ['900', '1200']]);
    assert.equal(galleryImages[0].getAttribute('loading'), 'eager');
    assert.equal(galleryImages[0].getAttribute('decoding'), 'async');
    assert.equal(galleryImages[0].getAttribute('fetchpriority'), 'high', 'only the first visible detail image gets high priority');
    assert.equal(galleryImages[1].getAttribute('loading'), 'lazy');
    assert.equal(galleryImages[1].getAttribute('fetchpriority'), null);
    const thumbImages = [...d.querySelectorAll('#detailThumbnails img')];
    assert.ok(thumbImages.every(image => image.getAttribute('width') === '56' && image.getAttribute('height') === '56' && image.getAttribute('loading') === 'lazy' && image.getAttribute('decoding') === 'async'));
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
    assert.match(returnsCopy, /return shipping paid by customer unless item is defective/i, 'the checkout trust wording does not imply free return shipping');
    assert.match(returnsCopy, /Sale items \(final sale unless defective\)/, 'sale-item exclusions remain visible in the return policy');

    const termsBody = d.querySelector('#page-terms .content-page-body');
    const termsCopy = termsBody.textContent;
    assert.match(termsCopy, /Last updated: October 2026/);
    assert.match(termsCopy, /By accessing and using this website/);
    assert.doesNotMatch(termsCopy, /kage-culture-ruby\.vercel\.app/i, 'Terms do not hardcode the production domain');
    assert.match(termsCopy, /Custom-designed items and custom stickers cannot be returned unless they are defective or the wrong item was supplied/);
    const customOrdersHeading = [...termsBody.querySelectorAll('h2, h3')].find(heading => heading.textContent.trim() === '7. Custom Orders & Returns');
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
    assert.match(privacyCopy, /private one-click unsubscribe link/i, 'Privacy describes the self-service unsubscribe control');
    assert.doesNotMatch(privacyCopy, /does not provide a self-service unsubscribe control/i, 'the no-self-service disclaimer is gone');
    assert.match(privacyCopy, /Umami Cloud.*uses no cookies and collects no personal data/i, 'Privacy discloses the Umami analytics tag (D2)');
    const newsletterRemovalParagraph = [...privacyBody.querySelectorAll('p')].find(paragraph => paragraph.textContent.includes('one-click unsubscribe link'));
    assert.equal(newsletterRemovalParagraph?.querySelector('a')?.getAttribute('href'), 'https://wa.me/923228042633', 'the WhatsApp fallback path is retained for lost links');
    assert.match(privacyCopy, /not legal advice.*reviewed by a qualified legal professional/i);

    const shippingCopy = d.querySelector('#page-shipping .content-page-body').textContent;
    assert.match(shippingCopy, /Delivery Charges/);
    assert.match(shippingCopy, /Delivery charges are Rs\. 250 – Rs\. 500 depending on your city and are confirmed by phone before dispatch\./);
    assert.doesNotMatch(shippingCopy, /Location-based rates|Rs\. 150/, 'shipping policy no longer promises an unconfigured fee');
    assert.doesNotMatch(shippingCopy, /Free-shipping threshold|\bTODO\b|\[/, 'unconfirmed free-shipping rules are omitted rather than published as placeholders');
    assert.equal(d.getElementById('coShipping').textContent.trim(), 'Rs. 250 – Rs. 500 (confirmed by phone)', 'checkout shows the published band with the phone-confirmation wording, not an unconfirmed charge');
    assert.equal(d.querySelector('#page-checkout .co-grand span').textContent.trim(), 'Total (before delivery)');
    assert.match(d.querySelector('#page-checkout .co-callnote').textContent, /We'll call you to confirm your order and the exact delivery charge before dispatch/);
    assert.equal(d.getElementById('confShipping').textContent.trim(), 'Rs. 250 – Rs. 500 (confirmed by phone)', 'confirmation shows the published band with phone-confirmation wording');
    assert.match(d.querySelector('#page-confirmation .confirm-next').textContent, /We'll call you to confirm your order and the exact delivery charge before dispatch\. You pay the total plus delivery in cash when it arrives\./, 'confirmation view carries the phone-confirmation wording');
    assert.doesNotMatch(storeHtml, /const shipping = 150/, 'checkout no longer hardcodes the old flat charge');

    const checkoutPaymentValues = [...d.querySelectorAll('#page-checkout input[name="payMethod"]')].map(input => input.value);
    assert.deepEqual(checkoutPaymentValues, ['cod'], 'checkout offers only Cash on Delivery');
    assert.match(storeHtml, /payment_method:\s*'cod'/, 'checkout submits Cash on Delivery only');
    assert.equal(d.getElementById('paymentRefGroup'), null, 'non-COD payment reference controls are removed');
    assert.equal(d.getElementById('coPaymentRef'), null, 'non-COD payment reference input is removed');
    assert.equal(d.querySelector('#page-checkout .co-callnote').textContent.trim(), "We'll call you to confirm your order and the exact delivery charge before dispatch. You pay the total plus delivery in cash when it arrives.");
    assert.equal(d.getElementById('coPlaceBtn').getAttribute('aria-describedby'), 'coDeliveryNote', 'Place Order points at the note beside it');
    const checkoutTrust = d.querySelector('#page-checkout .co-trust-strip');
    assert.equal(checkoutTrust.getAttribute('aria-label'), 'Checkout reassurance');
    assert.deepEqual([...checkoutTrust.querySelectorAll('li')].map(item => item.textContent.trim()), [
      'Cash on Delivery', 'Secure checkout', 'Easy returns · 7-day window · eligible items', 'WhatsApp support · +92 322 804 2633'
    ], 'checkout reassurance uses the actual COD, returns and support policies');
    const checkoutReturnsLink = checkoutTrust.querySelector('a[href="/returns"]');
    assert.ok(checkoutReturnsLink, 'the returns reassurance links to the local /returns policy');
    assert.equal(checkoutReturnsLink.getAttribute('data-route'), 'returns', 'the returns link preserves SPA navigation');
    const checkoutSupportLink = checkoutTrust.querySelector('a[href^="https://wa.me/"]');
    assert.equal(new URL(checkoutSupportLink.href).pathname, '/923228042633');
    assert.equal(checkoutSupportLink.getAttribute('target'), '_blank');
    assert.match(checkoutSupportLink.getAttribute('rel'), /noopener/);
    assert.match(checkoutSupportLink.getAttribute('rel'), /noreferrer/);
    assert.match(storeHtml, /\.co-trust-strip\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, 'checkout reassurance stays compact in two columns');
    assert.match(storeHtml, /@media \(max-width: 380px\) \{\s*\.co-trust-strip \{ grid-template-columns: 1fr; \}/, 'checkout reassurance stacks for narrow 320px screens');
    assert.deepEqual([...d.querySelectorAll('.payment-icons .payment-icon')].map(icon => icon.textContent.trim()), ['COD'], 'footer only advertises COD');
    const shippingPaymentHeading = [...d.querySelectorAll('#page-shipping .content-page-body h2, #page-shipping .content-page-body h3')].find(h => h.textContent.trim() === 'Payment Methods');
    assert.deepEqual([...shippingPaymentHeading.nextElementSibling.querySelectorAll('li')].map(li => li.textContent.trim()), ['Cash on Delivery (COD) — pay when your order arrives']);
    assert.doesNotMatch(d.querySelector('#tab-shipping').textContent, /JazzCash|Bank Transfer/, 'product details only advertise COD');
    assert.doesNotMatch(d.querySelector('#page-terms .content-page-body').textContent, /bank transfer/i, 'Terms no longer describe non-COD payment options');
    assert.doesNotMatch(storeHtml, /0322-8042633/, 'stale local phone formatting is removed');
    const whatsAppLinks = [...d.querySelectorAll('a[href^="https://wa.me/"]')];
    assert.ok(whatsAppLinks.length > 0 && whatsAppLinks.every(link => new URL(link.href).pathname === '/923228042633'), 'WhatsApp links use the normalized number');
    assert.equal(d.querySelectorAll('.content-page h2[style], .content-page h3[style]').length, 0, 'repeated content-page heading styles are no longer inline');
    assert.equal(d.querySelectorAll('.content-page-back[style]').length, 0, 'repeated back-link paragraph spacing is no longer inline');
    assert.equal(d.querySelectorAll('.content-page-contact :is(h2, h3)').length, 4, 'all four contact cards use the shared heading style');
    assert.equal(d.querySelectorAll('.content-page-contact p[style]').length, 0, 'contact paragraphs share their extracted styling');
    const contactCards = [...d.querySelectorAll('#page-contact .content-page-contact > .contact-card')];
    assert.deepEqual(contactCards.map(card => card.querySelector('h2, h3').textContent.trim()), ['WhatsApp', 'Order Support', 'Instagram', 'Email']);
    assert.deepEqual(contactCards.map(card => card.tagName), ['A', 'ARTICLE', 'A', 'A'], 'all actions are links except the support card that contains two distinct links');
    assert.ok(contactCards.every(card => card.querySelector('.contact-card-icon svg[viewBox="0 0 24 24"] path, .contact-card-icon svg[viewBox="0 0 24 24"] circle, .contact-card-icon svg[viewBox="0 0 24 24"] rect')), 'each card has an inline vector icon');
    assert.ok(contactCards.every(card => card.querySelector('.contact-card-icon').getAttribute('aria-hidden') === 'true'), 'contact icons are decorative to screen readers');
    assert.doesNotMatch(contactCards.map(card => card.innerHTML).join(''), /💬|📦|📸/, 'contact emoji icons are removed');
    const instagramUrl = 'https://instagram.com/kage_culture';
    const instagramCard = contactCards[2];
    assert.equal(instagramCard.getAttribute('href'), instagramUrl, 'Instagram card links to the footer URL');
    assert.match(instagramCard.textContent, /@kage_culture/, 'contact handle matches the Instagram URL');
    assert.equal(d.querySelector('.footer-instagram-handle'), null, 'footer handle text below social icons is removed');
    assert.equal(d.querySelector('.footer-social .social-instagram').getAttribute('href'), instagramUrl);
    assert.match(storeHtml, /"sameAs":\s*\[\s*"https:\/\/instagram\.com\/kage_culture"/, 'structured data also uses the footer Instagram URL');
    assert.doesNotMatch(storeHtml, /instagram\.com\/kageculture/, 'the stale unseparated Instagram handle is removed');
    const orderSupport = contactCards[1];
    const trackLink = orderSupport.querySelector('.contact-card-primary');
    assert.equal(trackLink.getAttribute('href'), '/tracking', 'Order Support main link goes to Track Order');
    assert.equal(trackLink.getAttribute('data-route'), 'tracking');
    assert.equal(orderSupport.querySelector('.contact-card-secondary a').textContent.trim(), 'message us on WhatsApp');
    assert.match(orderSupport.querySelector('.contact-card-secondary').textContent, /^or\s/);
    assert.match(orderSupport.querySelector('.contact-card-secondary a').getAttribute('href'), /^https:\/\/wa\.me\//);
    assert.equal(contactCards[3].getAttribute('href'), 'mailto:kageculture01@gmail.com', 'Email card uses the footer address in a mailto link');
    assert.equal(d.querySelector('.contact-working-hours')?.textContent.trim(), 'Working hours: Monday to Saturday, 11am to 8pm (Pakistan time). Sunday closed.', 'confirmed working hours are published on the contact page');
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
    // Mobile tracking timeline regression: an @media (max-width: 540px) block used to
    // sit ABOVE the base .track-* rules. Same specificity, so the base
    // `.track-step { flex-direction: column }` won the cascade, the steps rendered
    // as centred columns and the horizontal connector's left: -50% bled outside the
    // result card. The override must come after the base rules it overrides.
    const storeCssLf = storeHtml.replace(/\r\n/g, '\n'); // the bundle is CRLF on disk
    const baseTrackStep = storeCssLf.indexOf('.track-step { display: flex; flex-direction: column;');
    const narrowTrackStep = storeCssLf.indexOf('.track-step {\n        flex-direction: row;');
    assert.ok(baseTrackStep !== -1, 'base tracking step rule exists');
    assert.ok(narrowTrackStep !== -1, 'narrow-screen tracking step override exists');
    assert.ok(narrowTrackStep > baseTrackStep, 'narrow-screen tracking override comes after the base rule it overrides (source order decides at equal specificity)');
    const narrowTrackBlock = storeCssLf.slice(storeCssLf.lastIndexOf('@media (max-width: 540px)', narrowTrackStep), narrowTrackStep + 400);
    assert.match(narrowTrackBlock, /\.track-timeline \{ flex-direction: column;/, 'narrow screens stack the timeline vertically');
    assert.match(narrowTrackBlock, /\.track-step::before \{[^}]*left: 11px;[^}]*width: 2px;/, 'narrow-screen connector is a vertical rail beside the dots, inside the card (never left: -50%)');
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
    const whatsappEnd = storeHtml.indexOf('    .footer-newsletter h3 {', whatsappStart);
    const whatsappCss = storeHtml.slice(whatsappStart, whatsappEnd);
    assert.ok(whatsappStart >= 0 && whatsappEnd > whatsappStart, 'WhatsApp/footer spacing rules exist');
    assert.match(whatsappCss, /\.whatsapp-float \{\s*position: fixed;[\s\S]*?bottom: 24px;[\s\S]*?width: 60px;[\s\S]*?height: 60px;/, 'wide floating button dimensions and edge offset are known');
    assert.match(whatsappCss, /body:has\(#page-product\.active\) \.whatsapp-float,[\s\S]*?body:has\(#page-checkout\.active\) \.whatsapp-float,[\s\S]*?body:has\(#cartDrawer\.open\) \.whatsapp-float,[\s\S]*?display: none;/, 'the floating action is hidden on product, cart and checkout surfaces at every width');
    assert.match(whatsappCss, /@media \(max-width: 768px\) \{[\s\S]*?\.whatsapp-float \{\s*bottom: calc\(20px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*?width: 56px;[\s\S]*?height: 56px;/, 'mobile floating button dimensions include the safe-area offset');
    assert.match(whatsappCss, /@media \(max-width: 768px\) \{[\s\S]*?\.site-footer \{ padding-bottom: calc\(var\(--spacing-md\) \+ env\(safe-area-inset-bottom, 0px\)\); \}/, 'mobile footer uses normal bottom padding plus safe-area inset without a large gap below Privacy · Terms');
    assert.doesNotMatch(whatsappCss, /\.site-footer \{ padding-bottom: calc\(var\(--spacing-md\) \+ (?:76|84)px/, 'no extra 76px/84px gap below Privacy · Terms');
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
    // every card reserves a rating row and the Quick View button
    // is pinned to the bottom of the (equal-height) card.
    assert.match(storeHtml, /<div class="card-rating">\$\{starsHtml\(p\.rating, p\.review_count\)\}\<\/div>/, 'product cards render the rating in its own row');
    assert.ok(d.querySelector('.product-grid .product-card .card-rating'), 'rendered cards keep the reserved rating row');
    assert.match(w.renderProductCard({ id: 1, name: 'No reviews yet', price: 10, fit: 'Regular', stock_qty: 10 }), /<div class="card-rating"><\/div>/, 'a product with no reviews still reserves the rating row');
    assert.match(w.renderProductCard({ id: 1, name: 'Reviewed', price: 10, fit: 'Regular', stock_qty: 10, rating: 5, review_count: 2 }), /<div class="card-rating"><span class="star-rating"/, 'a reviewed product fills that row with stars');
    const cardImageTag = w.renderProductCard({ id: 1, name: 'Responsive image', price: 10, fit: 'Regular', stock_qty: 10, images: ['/uploads/card.webp'] }).match(/<img\b[^>]*>/)?.[0];
    assert.ok(cardImageTag, 'the shared card renderer includes its product image');
    assert.match(cardImageTag, /width="600" height="800"/);
    assert.match(cardImageTag, /sizes="\(max-width: 768px\)[^"]+"/);
    assert.match(cardImageTag, /loading="lazy" decoding="async"/);
    assert.doesNotMatch(cardImageTag, /fetchpriority="high"/, 'non-visible shared cards do not receive high fetch priority');
    assert.match(storeHtml, /function prioritizeFirstVisibleProductImage\(grid\)/, "only a visible grid's first image can be promoted");
    assert.match(storeHtml, /\.product-grid \.product-card \{[^}]*display: flex;[^}]*flex-direction: column;/, 'cards are flex columns so a grid row stretches them to equal height');
    assert.match(storeHtml, /\.product-grid \.product-card-image img \{[^}]*object-fit: cover;[^}]*padding: 8%;/, 'product card images stay uniform (object-fit: cover) while keeping their 8% card boundary');
    assert.match(storeHtml, /\.product-grid \.product-card-body \{[^}]*flex: 1 1 auto;[^}]*\}/, 'the card body fills the remaining card height');
    assert.match(storeHtml, /\.product-grid \.quick-view-btn \{[^}]*margin-top: auto;/, 'Quick View is pinned to the bottom of the card');
    assert.match(storeHtml, /#page-home \.product-grid \.quick-view-btn \{[^}]*margin-top: auto;/, 'the storefront override keeps Quick View pinned too');
    assert.match(storeHtml, /\.card-rating \{[^}]*min-height: 1\.15rem;[^}]*\}/, 'the rating row keeps its line when there are no reviews');
    console.log('✅ Product cards keep a reserved rating row and pin their button to the card bottom');

    // ---- "What customers say" home strip (F34) -----------------------
    {
      const strip = d.getElementById('sectionHomeReviews');
      assert.ok(strip, 'the reviews strip exists in the shell');
      assert.ok(strip.classList.contains('is-hidden'), 'strip ships hidden until real reviews exist');
      assert.equal(d.getElementById('homeReviewsGrid').children.length, 0);
      const realFetch = w.fetch;
      w.fetch = (url, options) => {
        if (String(url).startsWith('/api/reviews/featured')) {
          return Promise.resolve({ ok: true, json: async () => ([
            { id: 1, customer_name: 'Eve <script>alert(1)</script>', rating: 5, comment: 'Love it <img src=x onerror=alert(1)>', created_at: '2026-10-01 09:00:00', product_id: 1, product_name: 'Shadow <b>Fit</b>' },
            { id: 2, customer_name: 'Kai', rating: 4, comment: 'Great fit', created_at: '2026-09-30 09:00:00', product_id: 2, product_name: 'Oni Muscle Tee' },
            { id: 3, customer_name: 'Ada', rating: 5, comment: 'Third review', created_at: '2026-09-29 09:00:00', product_id: 3, product_name: 'Kage Core Compression' },
            { id: 4, customer_name: 'Extra', rating: 5, comment: 'Would be fourth — must not render', created_at: '2026-09-28 09:00:00', product_id: 4, product_name: 'Blade Wolf' }
          ]) });
        }
        return realFetch(url, options);
      };
      await w.loadHomeReviews();
      const grid = d.getElementById('homeReviewsGrid');
      assert.equal(grid.querySelectorAll('.home-review-card').length, 3, 'caps at three cards');
      assert.equal(strip.classList.contains('is-hidden'), false, 'strip reveals with real reviews');
      assert.ok(!grid.innerHTML.includes('<script>alert'), 'names are escaped');
      assert.ok(!/<img src=x/.test(grid.innerHTML), 'comments are escaped');
      assert.ok(grid.innerHTML.includes('&lt;img'), 'comment markup is entity-escaped');
      assert.ok(!grid.textContent.includes('Would be fourth'), 'only three render');
      d.querySelector('.home-review-product').click();
      assert.equal(w.location.pathname, '/product/1', 'the product link opens the product page');
      w.navigateTo('home');
      w.fetch = (url, options) => String(url).startsWith('/api/reviews/featured')
        ? Promise.resolve({ ok: true, json: async () => [] })
        : realFetch(url, options);
      await w.loadHomeReviews();
      assert.equal(d.getElementById('sectionHomeReviews').classList.contains('is-hidden'), true, 'an empty feed hides the strip again');
      w.fetch = realFetch;
      await w.loadHomeReviews();
      console.log('✅ What customers say: hidden without approved reviews, real escaped data with them, product link opens the product');
    }

    // ---- ONE card renderer for every product grid. The /collection/* and
    // ---- search grid (#collectionGrid) used to render its own big single-column
    // ---- card with "Add to Cart"; it now shows exactly the home Best Sellers card.
    const sharedPage = page(storeHtml, '/collection/all'); windows.push(sharedPage);
    await ready(sharedPage.window);
    await wait(100);
    const sharedWin = sharedPage.window, sharedDoc = sharedWin.document;
    // Source contract: one template, one function, every grid goes through it.
    assert.equal((storeHtml.match(/<div class="product-card"/g) || []).length, 1, 'the page contains exactly one product-card template');
    assert.equal((storeHtml.match(/function renderProductCard\(/g) || []).length, 1, 'there is exactly one card renderer');
    for (const fn of ['loadBestSellers', 'renderCollectionGrid', 'renderRelated', 'loadRecentlyViewed']) {
      const body = storeHtml.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n    \\}`));
      assert.ok(body, `${fn}() exists`);
      assert.match(body[0], /\.map\(renderProductCard\)/, `${fn}() renders its cards through the shared renderProductCard`);
    }
    // The old home-only name was a public alias for the shared renderer. Nothing
    // (page, template or test) ever called it, so it is gone — one name only.
    assert.equal(sharedWin.renderHomeProductCard, undefined, 'no legacy renderer alias lingers on the page');
    assert.doesNotMatch(storeHtml, /animateProductGrid/, 'no load-time stagger that would leave inline transform/opacity on collection cards (it killed their hover lift)');
    // Both grids are .product-grid, so one set of card CSS styles them.
    const bsGridEl = sharedDoc.getElementById('bestSellersGrid');
    const colGridEl = sharedDoc.getElementById('collectionGrid');
    assert.ok(bsGridEl.classList.contains('product-grid'), 'Best Sellers is a .product-grid');
    assert.ok(colGridEl.classList.contains('product-grid') && colGridEl.classList.contains('collection-grid'), 'the collection grid is a .product-grid too');
    assert.equal(sharedDoc.getElementById('shopSection').closest('#page-home') !== null, true, 'the shop grid sits under #page-home with the Best Sellers CSS scope');
    // Same products in the same order → byte-identical cards in both grids.
    sharedWin.eval('allProducts = allProducts.map((p, i) => Object.assign({}, p, { order_count: 100 - i })); currentPage = 1; loadBestSellers(); renderCollectionGrid();');
    const bsMarkup = [...bsGridEl.children].map(card => card.outerHTML);
    const colMarkup = [...colGridEl.children].map(card => card.outerHTML);
    assert.ok(colMarkup.length >= 4, 'the collection grid shows the catalog');
    assert.deepEqual(colMarkup, bsMarkup, 'Best Sellers and the collection grid render byte-identical cards for the same products');
    // Every collection card has the Best Sellers anatomy and none of the old collection-card pieces.
    for (const card of colGridEl.children) {
      const name = card.querySelector('h3').textContent;
      assert.ok(card.classList.contains('product-card'), `${name}: grid children are product cards`);
      for (const part of ['.product-card-image', '.product-wishlist svg', '.product-card-body > h3', '.fit-label', '.card-rating', '.price', '.quick-view-btn']) {
        assert.ok(card.querySelector(part), `${name}: card has ${part}`);
      }
      assert.equal(card.querySelector('.quick-view-btn').textContent.trim(), 'Quick View', `${name}: the button reads Quick View`);
      for (const legacy of ['.quick-add', '.wishlist-icon', '.product-fit-tag', '.img-back', '.angle-dots']) {
        assert.equal(card.querySelector(legacy), null, `${name}: no ${legacy} (old collection card)`);
      }
      assert.doesNotMatch(card.textContent, /Add to Cart|Out of Stock/, `${name}: no Add to Cart / Out of Stock button text`);
    }
    // Wiring on a real catalog: the heart saves without opening the product…
    const heart = colGridEl.children[1].querySelector('.product-wishlist');
    heart.click();
    assert.ok(heart.classList.contains('active'), 'the heart saves the product');
    assert.equal(sharedDoc.getElementById('wishlistCount').textContent, '1', 'the wishlist counter follows the heart');
    assert.equal(sharedWin.location.pathname, '/collection/all', 'the heart does not open the product page');
    sharedWin.eval('renderCollectionGrid(); loadBestSellers();');
    assert.equal(sharedDoc.querySelectorAll('#collectionGrid .product-wishlist.active').length, 1, 'the saved heart is filled after a re-render');
    assert.equal(sharedDoc.querySelectorAll('#bestSellersGrid .product-wishlist.active').length, 1, 'and filled in Best Sellers too');
    // …Quick View, a click on the card and Enter on a focused card all open it.
    const firstId = sharedDoc.querySelector('#collectionGrid .product-card').dataset.pid;
    sharedDoc.querySelector('#collectionGrid .product-card .quick-view-btn').click();
    assert.equal(sharedWin.location.pathname, '/product/' + firstId, 'Quick View opens the product page');
    sharedWin.navigateTo('collection', 'all');
    const cardToClick = sharedDoc.querySelectorAll('#collectionGrid .product-card')[1];
    cardToClick.click();
    assert.equal(sharedWin.location.pathname, '/product/' + cardToClick.dataset.pid, 'clicking the card opens the product page');
    sharedWin.navigateTo('collection', 'all');
    const cardForKeyboard = sharedDoc.querySelectorAll('#collectionGrid .product-card')[2];
    assert.equal(cardForKeyboard.getAttribute('tabindex'), '0', 'cards are keyboard focusable');
    assert.equal(cardForKeyboard.getAttribute('role'), 'link');
    cardForKeyboard.dispatchEvent(new sharedWin.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(sharedWin.location.pathname, '/product/' + cardForKeyboard.dataset.pid, 'Enter on a focused card opens the product page');
    // Card states: sale, low stock, reviews, sold out, price range, and products with no images at all
    // (the old collection template threw on a missing images array).
    sharedWin.navigateTo('collection', 'all');
    sharedWin.eval(`allProducts = [
      { id: 7001, name: 'Probe Sale', price: 799, original_price: 999, sale_price: 799, on_sale: true, fit: 'Regular', collection: 'graphic-tees', style: 'Typography', sizes: ['M'], images: ['/images/hero.jpg'], stock_qty: 3, in_stock: true, rating: 4.5, review_count: 12 },
      { id: 7002, name: 'Probe Sold Out', price: 1200, original_price: 1200, sale_price: null, on_sale: false, fit: 'Oversized', collection: 'anime', style: 'Anime-Inspired', sizes: ['L'], images: [], stock_qty: 0, in_stock: false },
      { id: 7003, name: 'Probe No Images', price: 1500, fit: 'Regular', collection: 'pants', style: 'Typography', sizes: ['L'], stock_qty: 9, in_stock: true },
      { id: 7004, name: 'Probe Range', price: 1199, original_price: 1199, fit: 'Oversized', collection: 'anime', style: 'Anime-Inspired', sizes: ['L'], images: ['/images/hero.jpg'], stock_qty: 9, in_stock: true, variants: [{ price: 1199 }, { price: 1249 }] }
    ]; currentPage = 1; renderCollectionGrid();`);
    const probe = (id) => sharedDoc.querySelector(`#collectionGrid .product-card[data-pid="${id}"]`);
    const saleCard = probe(7001);
    assert.equal(saleCard.querySelector('.product-discount-badge').textContent, '-20%', 'a sale card shows its discount badge');
    assert.equal(saleCard.querySelector('.price .original').textContent, 'Rs. 999', 'the struck-through regular price');
    assert.equal(saleCard.querySelector('.price .sale').textContent, 'Rs. 799', 'the sale price');
    assert.equal(saleCard.querySelector('.low-stock-flag').textContent, 'Only 3 left', 'the low-stock badge works');
    assert.ok(saleCard.querySelector('.card-rating .star-rating'), 'a reviewed product shows its stars');
    assert.equal(saleCard.querySelector('.rating-count').textContent, '12', 'and its review count');
    const soldOutCard = probe(7002);
    assert.equal(soldOutCard.querySelector('.sale-flag').textContent, 'SOLD OUT', 'an out-of-stock card carries the Sold out flag');
    assert.equal(soldOutCard.querySelector('.low-stock-flag'), null, 'sold out cards never show a low-stock badge');
    assert.equal(soldOutCard.querySelector('.quick-view-btn').disabled, false, 'a sold-out card still opens its product page');
    assert.match(soldOutCard.querySelector('.product-card-image').textContent, /No Image/, 'a product without a photo shows the placeholder');
    assert.ok(probe(7003), 'a product with no images array no longer breaks the grid');
    assert.equal(probe(7004).querySelector('.price').textContent.replace(/\s+/g, ' ').trim(), 'Rs. 1,199 — Rs. 1,249', 'price ranges keep working');
    assert.equal(probe(7001).querySelector('.price .original').nextElementSibling.className, 'sale', 'struck price first, sale price second — as on the home page');
    sharedWin.onSearchInput('probe sale');
    assert.deepEqual([...sharedDoc.querySelectorAll('#collectionGrid .product-card h3')].map(h => h.textContent), ['Probe Sale'], 'search results render through the same cards');
    sharedWin.onSearchInput('');
    console.log('✅ Collection grid = Best Sellers cards: ONE shared renderer, identical markup, Quick View, heart, keyboard, sale / sold-out / low-stock states');

    // ---- Four category tiles (Graphic Tees, Anime Shirts, Pants,
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
    assert.deepEqual(linkTiles.map(t => t.getAttribute('href')), ['/collection/graphic-tees', '/collection/anime', '/collection/pants', '/custom-stickers'], 'all four tiles link to real routes even when empty');
    const pantsTile = catTiles.find(t => t.querySelector('.cat-name').textContent === 'Pants');
    assert.equal(pantsTile.tagName, 'A', 'Pants keeps its link node while hidden out of stock');
    assert.equal(pantsTile.getAttribute('aria-disabled'), null, 'Pants uses visibility, not disabled-link semantics');
    assert.equal(d.querySelector('#categoryStrip .cat-coming-soon'), null, 'category cards never show a Coming-soon pill');
    assert.ok(catTiles.every(t => /Explore/.test(t.querySelector('.cat-shop').textContent)), 'every card keeps its Explore link');
    assert.ok(catTiles.every(t => w.getComputedStyle(t.querySelector('.cat-shop')).display !== 'none'), 'every Explore label is displayed');
    assert.ok(catTiles.every(t => !t.matches('.reveal, .reveal-scale')), 'category cards never wait for scroll-reveal');
    assert.match(storeHtml, /\.cat-tile:hover \{ transform: translateY\(-6px\); \}/, 'category-card hover effects remain unchanged');
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
    assert.match(storeHtml, /\.cat-shop \{[^}]*?min-height: 28px;/, 'all Explore labels share one row height');
    assert.match(storeHtml, /\.cat-shop \{[^}]*?margin-top: auto;/, 'Explore labels are pinned to the card bottom');
    assert.match(storeHtml, /\.category-strip:focus-visible \{[^}]*?outline: 2px solid #FFF;/, 'the keyboard-focusable row has a visible focus ring');
    assert.equal(d.getElementById('categoryStrip').getAttribute('tabindex'), '0', 'the category row is keyboard focusable');
    assert.ok(d.getElementById('categoryStrip').getAttribute('aria-label'), 'the category row is labelled for assistive tech');
    const categoryPictures = [...d.querySelectorAll('#categoryStrip .cat-thumb picture')];
    assert.equal(categoryPictures.length, 4, 'all four static category tiles retain their responsive picture markup');
    assert.deepEqual(categoryPictures.map(picture => picture.querySelector('img').getAttribute('alt')), ['Graphic Tees', 'Anime Shirts', 'Pants', 'Custom Stickers']);
    for (const picture of categoryPictures) {
      const source = picture.querySelector('source');
      const image = picture.querySelector('img');
      assert.equal(source.getAttribute('type'), 'image/webp');
      assert.match(source.getAttribute('srcset'), /-200\.webp 200w, [^,]+-500\.webp 500w/);
      // `sizes` now describes the real circle (150px at >=1024px, 104px below)
      // instead of a flat 116px, so the browser can drop to the 200w candidate
      // where it used to always take 500w. Task 1, 2026-11-23.
      assert.equal(source.getAttribute('sizes'), '(min-width: 1024px) 150px, 104px');
      assert.match(image.getAttribute('src'), /^\/images\/(?:graphic-tees|anime-shirts|pants|custom-stickers)\.jpg$/, 'JPEG fallback path remains intact');
      assert.equal(image.getAttribute('width'), '600');
      assert.equal(image.getAttribute('height'), '600');
      assert.equal(image.getAttribute('loading'), 'lazy');
      assert.equal(image.getAttribute('decoding'), 'async');
    }
    for (const file of ['graphic-tees-200.webp', 'graphic-tees-500.webp', 'anime-shirts-200.webp', 'anime-shirts-500.webp', 'pants-200.webp', 'pants-500.webp', 'custom-stickers-200.webp', 'custom-stickers-500.webp']) {
      assert.ok(existsSync(require.resolve('../public/images/' + file)), `${file} exists for its srcset candidate`);
    }
    assert.match(storeHtml, /hero-700\.webp 700w/, 'the existing hero 700px variant stays in its responsive srcset');
    // Task 2 (2026-11-23): a 390px phone at 2.6x DPR used to pull the 1363px
    // hero (96 KB) because `100vw` asked for ~1024 device px. The mobile-only
    // sources cap that at the 700px art (37 KB) — same crop, same look.
    assert.match(storeHtml, /<source media="\(max-width: 640px\)" srcset="\/images\/hero-700\.webp" type="image\/webp"/,
      'phones get the 700px hero as the only candidate');
    assert.match(storeHtml, /<source media="\(max-width: 640px\)" srcset="\/images\/hero-700\.jpg" type="image\/jpeg"/,
      'the JPEG fallback for phones is the 700px file too');
    const heroImgTag = (storeHtml.match(/<img src="\/images\/hero\.jpg"[^>]*>/) || [''])[0];
    assert.match(heroImgTag, /fetchpriority="high"/, 'the hero stays the highest-priority image');
    assert.match(heroImgTag, /width="1363" height="768"/, 'the hero reserves its intrinsic size');
    assert.match(storeHtml, /\.hero-media img \{[^}]*?height: auto;/, 'height:auto keeps aspect-ratio in charge of the hero box');
    assert.doesNotMatch(storeHtml, /\.hero-media img \{[^}]*max-height:\s*\d+vh/, 'no viewport-height clamp crops the campaign art or letterboxes the spray border');
    assert.match(storeHtml, /about-hero-500\.webp 600w/, 'the existing about 500px variant stays in its responsive srcset');
    console.log('✅ Category strip shows four Explore links: 2×2 phone grid + 4-col tablet/desktop layouts with aligned, pinned labels');

    // ---- Real Chromium: category strip geometry at phone/tablet/desktop widths ----
    const { launchChromium, waitForCatalog, settleLayout } = require('./fixtures/chromium');
    const browser = await launchChromium();
    try {
      // ---- UX-1: the fixed WhatsApp shortcut must never cover commerce CTAs.
      const overlapPage = await browser.newPage();
      const overlapWidths = [320, 360, 390, 540, 768, 1024, 1440];
      await overlapPage.setViewport({ width: overlapWidths[0], height: 900 });
      await overlapPage.goto(origin + '/product/1', { waitUntil: 'domcontentloaded' });
      await waitForCatalog(overlapPage);
      await overlapPage.waitForSelector('#page-product.active', { timeout: 20000 });
      await settleLayout(overlapPage);
      const productImagePriority = await overlapPage.evaluate(() => {
        const images = [...document.querySelectorAll('#page-product #galleryTrack img')];
        return { count: images.length, firstHigh: images[0]?.getAttribute('fetchpriority') === 'high', highCount: images.filter(image => image.getAttribute('fetchpriority') === 'high').length, firstLoading: images[0]?.getAttribute('loading') };
      });
      assert.ok(productImagePriority.count > 0);
      assert.equal(productImagePriority.firstHigh, true, 'the first visible detail image has high fetch priority');
      assert.equal(productImagePriority.highCount, 1, 'only one detail gallery image has high fetch priority');
      assert.equal(productImagePriority.firstLoading, 'eager');
      const assertNoWhatsAppOverlap = async (state, selector) => {
        for (const width of overlapWidths) {
          await overlapPage.setViewport({ width, height: 900 });
          await overlapPage.evaluate((actionSelector) => {
            const action = document.querySelector(actionSelector);
            if (action) action.scrollIntoView({ block: 'center', behavior: 'instant' });
          }, selector);
          await settleLayout(overlapPage);
          const geometry = await overlapPage.evaluate((actionSelector) => {
            const float = document.querySelector('.whatsapp-float');
            const floatStyle = getComputedStyle(float);
            const floatRect = float.getBoundingClientRect();
            const actions = [...document.querySelectorAll(actionSelector)].filter((el) => {
              const style = getComputedStyle(el), rect = el.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            });
            const overlaps = floatStyle.display !== 'none' && actions.some((el) => {
              const r = el.getBoundingClientRect();
              return r.left < floatRect.right && r.right > floatRect.left && r.top < floatRect.bottom && r.bottom > floatRect.top;
            });
            return { display: floatStyle.display, visibleActions: actions.length, overlaps };
          }, selector);
          assert.ok(geometry.visibleActions > 0, `${state} action is visible at ${width}px`);
          assert.equal(geometry.display, 'none', `${width}px ${state} hides the floating WhatsApp shortcut`);
          assert.equal(geometry.overlaps, false, `${width}px WhatsApp does not overlap a ${state} action`);
        }
      };
      await assertNoWhatsAppOverlap('product Add to Cart', '#page-product #addToCartBtn, #stickyCartBar .btn');
      await overlapPage.evaluate(() => { navigateTo('home'); window.scrollTo(0, 0); quickAdd(1); });
      await overlapPage.waitForFunction(() => document.getElementById('cartDrawer').classList.contains('open'));
      await assertNoWhatsAppOverlap('cart checkout', '#cartFooter button');
      await overlapPage.evaluate(() => startCheckout());
      await overlapPage.waitForSelector('#page-checkout.active', { timeout: 20000 });
      await assertNoWhatsAppOverlap('checkout Place Order', '#coPlaceBtn');
      for (const width of overlapWidths) {
        await overlapPage.setViewport({ width, height: 900 });
        await settleLayout(overlapPage);
        const trustLayout = await overlapPage.evaluate(() => {
          const strip = document.querySelector('#page-checkout .co-trust-strip');
          return { columns: getComputedStyle(strip).gridTemplateColumns.trim().split(' ').length, overflow: strip.scrollWidth > strip.clientWidth };
        });
        assert.equal(trustLayout.columns, width <= 380 ? 1 : 2, `${width}px checkout trust strip uses its responsive columns`);
        assert.equal(trustLayout.overflow, false, `${width}px checkout trust text stays inside the strip`);
      }
      await overlapPage.evaluate(() => { navigateTo('home'); window.scrollTo(0, 0); });
      assert.equal(await overlapPage.$eval('.whatsapp-float', (el) => getComputedStyle(el).display), 'flex', 'WhatsApp remains available away from commerce actions');
      await overlapPage.close();
      console.log('✅ Real Chromium — WhatsApp float stays clear of product, cart and checkout actions at 320–1440px');

      // ---- Mobile header: the logo row must stay on ONE line and inside the
      // ---- fixed 95px bar. Reported from Firefox on an Android phone that
      // ---- exposes a 343.6px CSS viewport: the full-size 128.75px logo plus
      // ---- four 44px tap targets needed 344.75px, so the row wrapped — and
      // ---- the wrapped second row did not fit the fixed-height header, so the
      // ---- icons were painted over the hero. Chrome never showed it because
      // ---- it laid that phone out at 360px, where the row still fit.
      for (const vw of [280, 300, 320, 344, 360, 375, 412, 640]) {
        const mhp = await browser.newPage();
        await mhp.setViewport({ width: vw, height: 800, isMobile: true, hasTouch: true });
        await mhp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(mhp);
        await settleLayout(mhp);
        const hm = await mhp.evaluate(() => {
          const rect = (sel) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          };
          const header = rect('.site-header');
          const logo = rect('.kage-logo img');
          const icons = rect('.nav-icons');
          const targets = [...document.querySelectorAll('.nav-icons > .nav-icon, .nav-icons > .hamburger')]
            .filter((el) => getComputedStyle(el).display !== 'none')
            .map((el) => el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height);
          const hero = document.querySelector('.hero-media img').getBoundingClientRect();
          return {
            header,
            logo,
            icons,
            targets: [...new Set(targets)],
            heroTop: hero.top,
            headerVar: getComputedStyle(document.documentElement).getPropertyValue('--header-h').trim(),
            docW: document.documentElement.scrollWidth,
            innerW: window.innerWidth
          };
        });
        const label = `${vw}px mobile header`;
        // A wrapped bar must grow, not overflow: below ~304px the row
        // legitimately stacks, and height:auto is what keeps the second row
        // inside it. Everywhere else the row stays on one line.
        if (vw <= 280) {
          assert.ok(hm.header.height > 96, `${label}: a wrapped bar grows with its content`);
          assert.ok(hm.icons.bottom <= hm.header.bottom + 0.5, `${label}: wrapped icons stay inside the grown header`);
        } else {
          assert.ok(Math.abs(hm.logo.top - hm.icons.top) < 3, `${label}: logo and icons stay on one row`);
          assert.equal(Math.round(hm.header.height), 95, `${label}: the single-row bar keeps its 95px height`);
        }
        // Inside the bar: the icons never spill out over the hero.
        assert.ok(hm.icons.bottom <= hm.header.bottom + 0.5, `${label}: icons stay inside the header (${hm.icons.bottom} > ${hm.header.bottom})`);
        assert.ok(hm.icons.bottom <= hm.heroTop + 0.5, `${label}: icons never paint over the hero`);
        // The tap targets are the thing that must not be sacrificed.
        assert.deepEqual(hm.targets, ['44x44'], `${label}: header tap targets stay 44x44`);
        // The measured header height keeps the hero clear of the fixed bar.
        assert.ok(Math.abs(parseFloat(hm.headerVar) - hm.header.height) < 1.5, `${label}: --header-h tracks the real header height`);
        assert.ok(hm.heroTop >= hm.header.bottom, `${label}: hero starts below the fixed header`);
        assert.equal(hm.docW, hm.innerW, `${label}: no horizontal page scroll`);
        await mhp.close();
      }
      console.log('✅ Real Chromium — mobile header keeps one row, 44px targets and its 95px bar at 280–640px');

      // ---- Mobile menu rows: the active/hover tint must not touch the label.
      // ---- The row used to have `padding: 10px 0`, so the pill's left edge
      // ---- sat exactly on the text (reported from the live site).
      {
        const mp = await browser.newPage();
        await mp.setViewport({ width: 412, height: 900, isMobile: true, hasTouch: true });
        await mp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(mp);
        await mp.click('#hamburger');
        await mp.waitForSelector('#navLinks.open');
        await settleLayout(mp);
        const row = await mp.evaluate(() => {
          const rowEl = document.querySelector('#navLinks a.active') || document.querySelector('#navLinks a');
          const r = rowEl.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(rowEl);
          const text = range.getBoundingClientRect();
          return { rowLeft: r.left, textLeft: text.left, inset: text.left - r.left, pad: getComputedStyle(rowEl).paddingLeft };
        });
        assert.ok(row.inset >= 12, `mobile menu label is inset from the row tint (${row.inset.toFixed(1)}px)`);
        assert.equal(row.pad, '16px', 'mobile menu rows keep their 16px horizontal padding');
        await mp.close();
        console.log('✅ Real Chromium — mobile menu labels sit inside the row highlight, not on its edge');
      }

      // ---- Search commits on Enter / the magnifier, never while typing.
      {
        const sp = await browser.newPage();
        await sp.setViewport({ width: 1280, height: 900 });
        await sp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(sp);
        await sp.click('#searchToggle');
        await sp.waitForFunction(() => document.getElementById('siteHeader').classList.contains('search-open'));
        await sp.type('#searchInput', 'wolf', { delay: 20 });
        await settleLayout(sp);
        const typed = await sp.evaluate(() => ({
          query: eval('searchQuery'),
          shop: document.getElementById('shopSection').classList.contains('shop-visible')
        }));
        assert.equal(typed.query, '', 'typing alone does not search');
        assert.equal(typed.shop, false, 'typing alone does not reveal the shop grid');
        await sp.keyboard.press('Enter');
        await sp.waitForFunction(() => document.getElementById('shopSection').classList.contains('shop-visible'));
        await settleLayout(sp);
        const committed = await sp.evaluate(() => ({
          query: eval('searchQuery'),
          cards: document.querySelectorAll('#collectionGrid .product-card').length,
          headerClosed: !document.getElementById('siteHeader').classList.contains('search-open')
        }));
        assert.equal(committed.query, 'wolf', 'Enter commits the search');
        assert.ok(committed.cards >= 1, 'Enter renders the matching results');
        assert.equal(committed.headerClosed, true, 'committing closes the open search field');
        // ...and the in-field magnifier commits too.
        await sp.evaluate(() => onSearchInput(''));
        await sp.click('#searchToggle');
        await sp.type('#searchInput', 'wolf', { delay: 20 });
        await sp.click('#searchSubmit');
        await sp.waitForFunction(() => eval('searchQuery') === 'wolf');
        assert.ok((await sp.$$('#collectionGrid .product-card')).length >= 1, 'the magnifier runs the search');
        await sp.close();
        console.log('✅ Real Chromium — search runs on Enter and the magnifier, not on every keystroke');
      }

      // ---- Desktop header: the links live in the hamburger panel at every
      // ---- width, so the bar itself is [logo] … [search + wishlist +
      // ---- account + cart + hamburger]. These checks pin that contract:
      // ---- no inline link row, a visible 44px hamburger, a closed panel by
      // ---- default, an open panel that lists all eight links under the bar
      // ---- and a working keyboard path through it.
      for (const vw of [1024, 1025, 1100, 1148, 1279, 1280, 1366, 1536, 1920]) {
        const hp = await browser.newPage();
        await hp.setViewport({ width: vw, height: 900 });
        await hp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(hp);
        await settleLayout(hp);
        {
          const closed = await hp.evaluate(() => {
            const rect = (el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            };
            const nav = document.getElementById('navLinks');
            const burger = document.getElementById('hamburger');
            const content = document.querySelector('#page-home .section-vibes > .container');
            const contentStyle = getComputedStyle(content);
            const contentRect = content.getBoundingClientRect();
            const buttons = [...document.querySelectorAll('.nav-icons > .nav-icon')]
              .filter((button) => getComputedStyle(button).display !== 'none');
            return {
              navDisplay: getComputedStyle(nav).display,
              navRect: rect(nav),
              burger: rect(burger),
              burgerDisplay: getComputedStyle(burger).display,
              ariaExpanded: burger.getAttribute('aria-expanded'),
              ariaControls: burger.getAttribute('aria-controls'),
              logo: rect(document.querySelector('.kage-logo img')),
              icons: rect(document.querySelector('.nav-icons')),
              buttons: buttons.map(rect),
              content: {
                left: contentRect.left + parseFloat(contentStyle.paddingLeft),
                right: contentRect.right - parseFloat(contentStyle.paddingRight)
              },
              header: {
                height: rect(document.querySelector('.site-header')).height,
                position: getComputedStyle(document.querySelector('.site-header')).position
              },
              categoryStrip: getComputedStyle(document.getElementById('categoryStrip')).display
            };
          });
          const label = `${vw}px`;
          assert.equal(closed.navDisplay, 'none', `${label}: the link list is collapsed, not an inline row`);
          assert.equal(closed.burgerDisplay, 'flex', `${label}: the hamburger is the nav entry point`);
          assert.equal(closed.ariaExpanded, 'false', `${label}: the closed menu reports aria-expanded=false`);
          assert.equal(closed.ariaControls, 'navLinks', `${label}: the hamburger controls the link list`);
          assert.ok(closed.buttons.every((button) => button.width === 44 && button.height === 44), `${label}: icon hit-target sizes stay unchanged`);
          assert.ok(Math.abs(closed.burger.width - 44) < 0.5 && Math.abs(closed.burger.height - 44) < 0.5, `${label}: the hamburger keeps its 44px target`);
          assert.ok(Math.abs(closed.logo.left - closed.content.left) < 0.5, `${label}: logo aligns to the page content left edge (${closed.logo.left}/${closed.content.left})`);
          assert.ok(Math.abs(closed.icons.right - closed.content.right) < 0.5, `${label}: icons align to the page content right edge (${closed.icons.right}/${closed.content.right})`);
          assert.ok(Math.abs(closed.burger.right - closed.icons.right) < 0.5, `${label}: the hamburger is the last item in the icon cluster`);
          assert.ok(Math.abs(closed.logo.height - 52.8) < 1, `${label}: logo is enlarged by about 20%`);
          const center = (r) => r.top + r.height / 2;
          assert.ok(Math.abs(center(closed.logo) - center(closed.buttons[0])) < 0.5, `${label}: logo and icons are vertically centred`);
          assert.ok(Math.abs(center(closed.logo) - center(closed.burger)) < 0.5, `${label}: logo and hamburger are vertically centred`);
          assert.equal(closed.header.height, 95, `${label}: header height stays unchanged`);
          assert.equal(closed.header.position, 'fixed', `${label}: header remains sticky`);
          assert.notEqual(closed.categoryStrip, 'none', `${label}: the category strip is not collapsed by the header change`);
        }

        // Open the panel and check it is a real, readable list under the bar.
        await hp.evaluate(() => document.getElementById('hamburger').focus());
        await hp.keyboard.press('Enter');
        await hp.waitForFunction(() => document.getElementById('navLinks').classList.contains('open'));
        await settleLayout(hp);
        {
          const open = await hp.evaluate(() => {
            const rect = (el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            };
            const nav = document.getElementById('navLinks');
            const burger = document.getElementById('hamburger');
            const links = [...nav.querySelectorAll(':scope > li > a')].filter((a) => a.getClientRects().length);
            const header = rect(document.querySelector('.site-header'));
            const inner = rect(document.querySelector('.site-header .nav-inner'));
            return {
              navDisplay: getComputedStyle(nav).display,
              navRect: rect(nav),
              header,
              inner,
              ariaExpanded: burger.getAttribute('aria-expanded'),
              ariaLabel: burger.getAttribute('aria-label'),
              burgerActive: burger.classList.contains('active'),
              bodyOverflow: document.body.style.overflow,
              links: links.map((a) => ({ text: a.textContent.trim(), rect: rect(a) })),
              linksOneColumn: links.every((a, i) => i === 0 || a.getBoundingClientRect().top > links[i - 1].getBoundingClientRect().top),
              searchVisible: !!document.getElementById('mobileSearch').getClientRects().length,
              icons: rect(document.querySelector('.nav-icons'))
            };
          });
          const label = `${vw}px open menu`;
          assert.equal(open.navDisplay, 'flex', `${label}: the panel becomes visible`);
          assert.equal(open.ariaExpanded, 'true', `${label}: aria-expanded follows the open state`);
          assert.equal(open.ariaLabel, 'Close menu', `${label}: the trigger relabels itself`);
          assert.equal(open.burgerActive, true, `${label}: the icon enters its X state`);
          assert.equal(open.bodyOverflow, 'hidden', `${label}: page scroll locks behind the panel`);
          // Every category is permanent: Shop All + 4 categories + Sale + 2 = 8.
          assert.equal(open.links.length, 8, `${label}: all eight links are in the panel`);
          assert.equal(open.linksOneColumn, true, `${label}: links stack in one column`);
          assert.equal(open.searchVisible, true, `${label}: the panel carries the search row on desktop too`);
          // The panel hangs off the 67px row (topbar 27px + row 67px = 94px),
          // i.e. it starts on the bar's 1px bottom border — never over it.
          assert.ok(open.navRect.top >= open.header.bottom - 1.5, `${label}: the panel drops below the fixed bar (${open.navRect.top} >= ${open.header.bottom})`);
          assert.ok(open.navRect.top <= open.header.bottom + 0.5, `${label}: the panel is glued to the bar, with no gap`);
          assert.ok(open.navRect.bottom <= 900 + 0.5, `${label}: the panel stays inside the viewport`);
          assert.ok(open.navRect.width >= 300, `${label}: the desktop panel is wide enough for its labels (${open.navRect.width}px)`);
          assert.ok(open.links.every((link) => link.rect.height >= 44), `${label}: each row keeps a 44px target`);
          assert.ok(open.links.every((link) => link.rect.left >= open.navRect.left - 0.1 && link.rect.right <= open.navRect.right + 0.1), `${label}: rows stay inside the panel`);
          // The panel hangs off the header's own right edge, so it lines up
          // with the icon cluster instead of floating somewhere in the page.
          assert.ok(Math.abs(open.navRect.right - open.icons.right) < 0.5, `${label}: the panel is right-aligned to the icons (${open.navRect.right}/${open.icons.right})`);
          assert.ok(open.navRect.right <= open.inner.right + 0.5, `${label}: the panel never overhangs the header row`);
        }

        // Escape closes it and hands focus back to the hamburger.
        await hp.keyboard.press('Escape');
        await hp.waitForFunction(() => !document.getElementById('navLinks').classList.contains('open'));
        const afterEscape = await hp.evaluate(() => ({
          focusId: document.activeElement.id,
          overflow: document.body.style.overflow,
          ariaExpanded: document.getElementById('hamburger').getAttribute('aria-expanded')
        }));
        assert.equal(afterEscape.focusId, 'hamburger', `${vw}px: Escape returns focus to the hamburger`);
        assert.equal(afterEscape.ariaExpanded, 'false', `${vw}px: Escape closes the panel`);
        assert.equal(afterEscape.overflow, '', `${vw}px: Escape releases the scroll lock`);

        if (vw === 1280) {
          // A menu link routes and closes the panel in one tap.
          await hp.click('#hamburger');
          await hp.waitForSelector('#navLinks.open');
          await settleLayout(hp);
          await hp.click('#navLinks a[data-route="contact"]');
          await hp.waitForFunction(() => document.getElementById('page-contact').classList.contains('active'));
          const routed = await hp.evaluate(() => ({
            open: document.getElementById('navLinks').classList.contains('open'),
            overflow: document.body.style.overflow,
            path: location.pathname
          }));
          assert.equal(routed.open, false, 'a panel link closes the menu');
          assert.equal(routed.overflow, '', 'a panel link releases the scroll lock');
          assert.match(routed.path, /\/contact$/, 'the panel link navigates');
          console.log('✅ Real Chromium — a desktop menu link routes and closes the panel');
          await hp.click('.kage-logo');
          await hp.waitForFunction(() => document.getElementById('page-home').classList.contains('active'));
        }
        console.log(`✅ ${vw}px real Chromium — links live in the hamburger panel; bar keeps logo + icons at 95px`);
        await hp.close();
      }

      // ---- The open panel is also reachable and closable by pointer, and the
      // ---- inner search field works from inside it at desktop width.
      {
        const mdp = await browser.newPage();
        await mdp.setViewport({ width: 1440, height: 900 });
        await mdp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(mdp);
        await mdp.click('#hamburger');
        await mdp.waitForSelector('#navLinks.open');
        await settleLayout(mdp);
        await mdp.click('#mobileSearch');
        await mdp.keyboard.type('wolf', { delay: 20 });
        await mdp.keyboard.press('Enter');
        await mdp.waitForFunction(() => eval('searchQuery') === 'wolf');
        const searched = await mdp.evaluate(() => ({
          open: document.getElementById('navLinks').classList.contains('open'),
          cards: document.querySelectorAll('#collectionGrid .product-card').length,
          shopVisible: document.getElementById('shopSection').classList.contains('shop-visible')
        }));
        assert.equal(searched.open, false, 'submitting the panel search closes the menu');
        assert.ok(searched.cards >= 1, 'submitting the panel search renders results');
        assert.equal(searched.shopVisible, true, 'submitting the panel search reveals the grid');
        // Outside click closes it too.
        await mdp.evaluate(() => onSearchInput(''));
        await mdp.click('#hamburger');
        await mdp.waitForSelector('#navLinks.open');
        await mdp.mouse.click(200, 600);
        await mdp.waitForFunction(() => !document.getElementById('navLinks').classList.contains('open'));
        assert.equal(await mdp.evaluate(() => document.getElementById('hamburger').getAttribute('aria-expanded')), 'false', 'an outside tap closes the panel');
        await mdp.close();
        console.log('✅ Real Chromium — desktop panel: outside tap closes it, its search row filters the grid');
      }

      for (const [vw, vh, mode] of [[320, 780, 'phone'], [360, 780, 'phone'], [414, 860, 'phone'], [599, 900, 'phone'], [768, 900, 'tablet'], [1440, 900, 'desktop']]) {
        const bp = await browser.newPage();
        await bp.setViewport({ width: vw, height: vh });
        await bp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(bp);
        await bp.evaluate(() => {
          allProducts.push({ ...allProducts[0], id: 987655, collection: 'pants', sizes: ['M'], size_stock: null, stock_qty: 3, in_stock: true });
          syncCollectionVisibility();
        });
        await settleLayout(bp);
        if (vw === 360) {
          await bp.waitForFunction(() => {
            return ['Anime Shirts', 'Custom Stickers'].every((alt) => {
              const image = [...document.querySelectorAll('#categoryStrip img')].find(candidate => candidate.alt === alt);
              return image && image.currentSrc;
            });
          }, { timeout: 10000 });
          const categorySources = await bp.evaluate(() => Object.fromEntries(
            ['Anime Shirts', 'Custom Stickers'].map(alt => [alt, [...document.querySelectorAll('#categoryStrip img')].find(image => image.alt === alt).currentSrc])
          ));
          assert.ok(categorySources['Anime Shirts'].endsWith('/anime-shirts-200.webp'), '360px 1x category tile selects the small WebP candidate');
          assert.ok(categorySources['Custom Stickers'].endsWith('/custom-stickers-200.webp'), '360px 1x category tile selects the small WebP candidate');
        }
        const m = await bp.evaluate(() => {
          const strip = document.querySelector('#page-home .category-strip');
          const tiles = [...strip.querySelectorAll('.cat-tile')];
          const labelOf = (t) => t.querySelector('.cat-shop');
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
        assert.ok(m.tiles.every((t) => Math.abs(t.labelH - 28) <= 1), `${vw}px: Explore labels have equal height (${m.tiles.map((t) => t.labelH)})`);
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

      // Category cards must render immediately, without scrolling or forcing
      // visibility classes, and remain stable through catalog refreshes.
      const pantsProduct = {
        id: 987655, name: 'Kage Cargo Pant', category: 'pants', price: 2499,
        fit: 'Relaxed', sizes: ['M', 'L'], stock_qty: 3, in_stock: true,
        front_image: '/images/pants.jpg'
      };
      for (const vw of [390, 1440]) {
        const pp = await browser.newPage();
        await pp.setViewport({ width: vw, height: 900 });
        let pantsCatalog = [pantsProduct];
        await pp.setRequestInterception(true);
        pp.on('request', request => {
          if (new URL(request.url()).pathname === '/api/products') {
            return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(pantsCatalog) });
          }
          return request.continue();
        });
        await pp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitForCatalog(pp);
        await pp.evaluate(() => { window.originalPantsTile = document.getElementById('catTilePants'); });
        for (const [state, catalog, stocked] of [
          ['stocked', [pantsProduct], true],
          ['sold out', [{ ...pantsProduct, stock_qty: 0, in_stock: false }], false],
          ['restocked', [pantsProduct], true],
          ['removed', [], false]
        ]) {
          pantsCatalog = catalog;
          if (state !== 'stocked') await pp.evaluate(() => loadProductsFromAPI());
          const beforeScroll = await pp.$$eval('#categoryStrip .cat-tile', tiles => tiles.map(tile => ({
            reveal: tile.matches('.reveal, .reveal-scale'),
            opacity: getComputedStyle(tile).opacity,
            visible: getComputedStyle(tile).display !== 'none'
          })));
          assert.equal(beforeScroll.length, 4);
          assert.ok(beforeScroll.every(tile => !tile.reveal && tile.opacity === '1'), `${vw}px ${state}: category cards never use scroll-reveal`);
          await pp.evaluate(() => document.getElementById('catTilePants').scrollIntoView({ block: 'center', behavior: 'instant' }));
          const card = await pp.evaluate(() => {
            const tile = document.getElementById('catTilePants');
            const label = tile.querySelector('.cat-shop');
            return {
              sameNode: tile === window.originalPantsTile,
              opacity: getComputedStyle(tile).opacity,
              visible: getComputedStyle(tile).display !== 'none',
              tag: tile.tagName,
              href: tile.getAttribute('href'),
              disabled: tile.hasAttribute('aria-disabled'),
              pointerEvents: getComputedStyle(tile).pointerEvents,
              label: label.textContent.trim(),
              labelDisplay: getComputedStyle(label).display,
              comingSoon: !!tile.querySelector('.cat-coming-soon'),
              navVisible: getComputedStyle(document.getElementById('navPantsItem')).display !== 'none'
            };
          });
          assert.equal(card.sameNode, true, `${vw}px ${state}: catalog refresh must preserve the existing tile`);
          assert.equal(card.opacity, '1', `${vw}px ${state}: scrolling never fades the card`);
          assert.equal(card.tag, 'A');
          assert.equal(card.href, '/collection/pants');
          assert.equal(card.disabled, false);
          assert.notEqual(card.pointerEvents, 'none');
          assert.equal(card.label, 'Explore');
          assert.notEqual(card.labelDisplay, 'none');
          assert.equal(card.comingSoon, false);
          assert.equal(card.navVisible, true, `${vw}px ${state}: Pants keeps its nav link regardless of stock`);
          assert.equal(card.visible, true, `${vw}px ${state}: the Pants card never disappears`);
          // All four categories are permanent, so the strip always shows four.
          assert.equal(beforeScroll.filter(tile => tile.visible).length, 4, `${vw}px ${state}: all four category cards render`);
          if (stocked) {
            await pp.click('#catTilePants');
          } else {
            await pp.goto(origin + '/collection/pants', { waitUntil: 'domcontentloaded' });
            await waitForCatalog(pp);
            // A real deep-link reload replaces the document, not the stock-sync function.
            await pp.evaluate(() => { window.originalPantsTile = document.getElementById('catTilePants'); });
          }
          assert.equal(new URL(pp.url()).pathname, '/collection/pants', `${vw}px ${state}: Explore opens Pants`);
          assert.equal(await pp.$eval('#shopSection', el => getComputedStyle(el).display), 'block');
          assert.equal(await pp.$eval('#page-coming-soon', el => el.classList.contains('active')), false);
          const gridText = await pp.$eval('#collectionGrid', el => el.textContent);
          assert.match(gridText, catalog.length ? /Kage Cargo Pant/ : /No pants available right now/i);
          if (state === 'sold out') {
            assert.equal(await pp.$eval('#collectionGrid .sale-flag', el => el.textContent), 'SOLD OUT');
            assert.equal(await pp.$eval('#collectionGrid .product-card-image img', el => getComputedStyle(el).opacity), '0.65');
          }
          await pp.evaluate(() => navigateTo('home'));
        }
        console.log(`✅ ${vw}px real Chromium — all four category cards render without scroll animation and survive every stock change`);
        await pp.close();
      }

      // Keyboard: the row is tabbable and shows a visible white focus ring.
      const kp = await browser.newPage();
      await kp.setViewport({ width: 360, height: 780 });
      await kp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      await waitForCatalog(kp);
      await kp.keyboard.press('Tab');
      assert.equal(await kp.evaluate(() => document.activeElement.classList.contains('skip-link')), true);
      await kp.keyboard.press('Enter');
      assert.equal(await kp.evaluate(() => document.activeElement.id), 'mainContent', 'keyboard skip focuses the main region');
      assert.equal(await kp.evaluate(() => location.hash), '#mainContent');
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

      // ================================================================
      // The /collection/* + search grid shows the home Best Sellers cards,
      // in real Chromium: 2 columns on phones (<600px), 3 on tablets, 4 on
      // desktop, with the home gaps and card proportions, equal-height
      // cards whose buttons share one line, and no horizontal page scroll.
      // ================================================================
      const apiProduct = (id, extra) => ({
        id, name: 'Product ' + id, price: 1499, sale_price: null, category: 'graphic-tees', fit: 'Regular',
        style: 'Typography', front_image: '/images/pants.jpg', back_image: null, stock_qty: 20, in_stock: true,
        avg_rating: null, review_count: 0, order_count: 100 - id, sizes: ['S', 'M', 'L'],
        created_at: '2026-01-01T00:00:00.000Z', ...extra
      });
      // Every state a card can be in, side by side: very long names and fit labels, a sale with big
      // numbers, low stock, sold out, reviews (few and many), price ranges (the two names that have
      // variants), 2-digit and 4-digit prices. Prices stay under the filter's default Rs. 10,000 cap.
      // order_count = 100 - id keeps Best Sellers in catalog order, so home and collection show the same 8 products.
      const stressCatalog = [
        apiProduct(1, { name: 'Kage Relaxed Tapered Cargo Pant — Extra Long Marketing Name Edition', price: 2499, category: 'pants', fit: 'Relaxed' }),
        apiProduct(2, { name: 'Tiny', avg_rating: 4.5, review_count: 2 }),
        apiProduct(3, { name: 'Wrath Silhouette Premium Heavyweight Tee', price: 9999, sale_price: 7499, stock_qty: 3, avg_rating: 4.9, review_count: 1200 }),
        apiProduct(4, { name: 'Sold Out Legend', stock_qty: 0, in_stock: false, fit: 'Oversized Boxy Relaxed Fit Edition' }),
        apiProduct(5, { name: 'Drift Oversized', price: 1199, fit: 'Oversized' }),
        apiProduct(6, { name: 'Supercalifragilisticexpialidocious-Oversized-Anime-Tee', fit: 'Supercalifragilisticexpialidocious', price: 9950, sale_price: 8999, category: 'anime' }),
        apiProduct(7, { name: 'Blade Wolf', price: 1149, avg_rating: 3.2, review_count: 7, stock_qty: 1 }),
        apiProduct(8, { name: 'Plain', price: 99, category: 'anime' }),
        apiProduct(9, { name: 'Page two A' }),
        apiProduct(10, { name: 'Page two B', price: 1000, sale_price: 750, category: 'anime' })
      ];
      const pageErrors = [];
      // Opens `route` at `vw` px (serving `catalog` instead of the live one when given) and waits until
      // `readySelector` is on screen: the route is applied after the catalog and the session check resolve.
      const openStore = async (vw, route, catalog, readySelector) => {
        const sp = await browser.newPage();
        sp.on('pageerror', (e) => pageErrors.push(`${vw}px ${route}: ${e.message}`));
        await sp.setViewport({ width: vw, height: 900 });
        if (catalog) {
          await sp.setRequestInterception(true);
          sp.on('request', (r) => (new URL(r.url()).pathname === '/api/products'
            ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) })
            : r.continue()));
        }
        await sp.goto(origin + route, { waitUntil: 'domcontentloaded' });
        await waitForCatalog(sp);
        await sp.waitForFunction((sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; }, { timeout: 20000 }, readySelector);
        await sp.evaluate(() => document.fonts.ready);   // web fonts change text wrapping: measure after they settle
        await settleLayout(sp);
        return sp;
      };
      for (const width of [360, 1440]) {
        const partialPage = await openStore(width, '/product/1', [apiProduct(1, {
          sizes: ['S', 'M', 'L'], size_stock: { S: 0, M: 2, L: 3 }, stock_qty: 5, in_stock: true
        })], '#addToCartBtn');
        const partialState = await partialPage.evaluate(() => {
          const small = document.querySelector('#detailSizePicker [data-size="S"]');
          const label = small.closest('.size-option').querySelector('.size-stock-status');
          const large = document.querySelector('#detailSizePicker [data-size="L"]');
          const smallRect = small.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
          return { smallDisabled: small.disabled, label: label.textContent,
            labelBelow: labelRect.top >= smallRect.bottom,
            largeDisabled: large.disabled, largeLabel: large.closest('.size-option').querySelector('.size-stock-status').textContent,
            button: document.getElementById('addToCartBtn').textContent,
            buttonDisabled: document.getElementById('addToCartBtn').disabled,
            overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.equal(partialState.smallDisabled, true);
        assert.equal(partialState.label, 'Sold Out');
        assert.equal(partialState.labelBelow, true, 'the Sold Out label sits below Small, not beside the entire product');
        assert.equal(partialState.largeDisabled, false);
        assert.equal(partialState.largeLabel, '');
        assert.equal(partialState.button, 'Add to Cart');
        assert.equal(partialState.buttonDisabled, false);
        assert.equal(partialState.overflow, false);
        await partialPage.close();
        console.log(`✅ ${width}px real Chromium — Small=0 labels only Small Sold Out; other sizes remain buyable`);
      }
      const measureGrid = (sp, gridSel) => sp.evaluate((sel) => {
        const grid = document.querySelector(sel);
        const cs = getComputedStyle(grid);
        const home = getComputedStyle(document.getElementById('bestSellersGrid'));
        const show = (selector) => { const el = document.querySelector(selector); return el ? getComputedStyle(el).display : null; };
        const cards = [...grid.querySelectorAll(':scope > .product-card')].map((card) => {
          const r = card.getBoundingClientRect();
          const btn = card.querySelector('.quick-view-btn');
          const b = btn.getBoundingClientRect();
          return {
            id: card.dataset.pid, html: card.outerHTML.replace(/\s(?:loading|fetchpriority)="[^"]*"/g, ''),
            top: r.top, left: r.left, right: r.right, w: r.width, h: r.height,
            imgW: card.querySelector('.product-card-image').getBoundingClientRect().width,
            imgH: card.querySelector('.product-card-image').getBoundingClientRect().height,
            btnTop: b.top, btnBottom: b.bottom, btnW: b.width, btnH: b.height, btnOpacity: getComputedStyle(btn).opacity
          };
        });
        return {
          columns: cs.gridTemplateColumns.trim().split(/\s+/).length,
          colGap: cs.columnGap, rowGap: cs.rowGap, homeColGap: home.columnGap, homeRowGap: home.rowGap,
          sidebar: show('#filterSidebar'), filterButton: show('.filter-toggle-btn'),
          cards, docW: document.documentElement.scrollWidth, innerW: window.innerWidth
        };
      }, gridSel);
      // Computed look of one card's parts (layout-dependent sizes excluded — those are compared as geometry).
      const STYLE_PARTS = {
        card: ['', ['display', 'flexDirection', 'backgroundColor', 'borderTopLeftRadius', 'borderTopWidth', 'borderTopColor', 'boxShadow', 'overflow', 'cursor']],
        image: ['.product-card-image', ['backgroundColor', 'position', 'overflow']],
        heart: ['.product-wishlist', ['position', 'top', 'right', 'width', 'height', 'borderTopLeftRadius', 'backgroundColor', 'color']],
        badge: ['.product-discount-badge', ['position', 'top', 'left', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'paddingTop', 'paddingLeft']],
        soldOut: ['.sale-flag', ['position', 'top', 'left', 'color', 'backgroundColor', 'fontSize', 'fontWeight']],
        lowStock: ['.low-stock-flag', ['position', 'bottom', 'left', 'color', 'backgroundColor', 'fontSize', 'fontWeight']],
        name: ['h3', ['fontFamily', 'fontSize', 'fontWeight', 'color', 'whiteSpace', 'textOverflow']],
        fit: ['.fit-label', ['fontSize', 'color']],
        rating: ['.card-rating', ['display', 'minHeight']],
        price: ['.price', ['fontSize', 'fontWeight', 'color']],
        original: ['.price .original', ['color', 'fontSize', 'textDecorationLine']],
        sale: ['.price .sale', ['color']],
        button: ['.quick-view-btn', ['display', 'minHeight', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderTopLeftRadius', 'paddingTop', 'paddingLeft', 'opacity']]
      };
      const styleSnapshot = (sp, gridSel, ids) => sp.evaluate((sel, pids, parts) => {
        const out = {};
        for (const id of pids) {
          const card = document.querySelector(`${sel} > .product-card[data-pid="${id}"]`);
          out[id] = {};
          for (const [part, [partSel, props]] of Object.entries(parts)) {
            const el = partSel ? card.querySelector(partSel) : card;
            out[id][part] = el ? Object.fromEntries(props.map((k) => [k, getComputedStyle(el)[k]])) : null;
          }
        }
        return out;
      }, gridSel, ids, STYLE_PARTS);
      const groupRows = (cards) => {
        const rows = [];
        for (const c of cards) {
          let row = rows.find((r) => Math.abs(r.top - c.top) <= 1);
          if (!row) { row = { top: c.top, cards: [] }; rows.push(row); }
          row.cards.push(c);
        }
        return rows.sort((a, b) => a.top - b.top);
      };
      const spread = (xs) => Math.max(...xs) - Math.min(...xs);
      const fmt1 = (xs) => xs.map((x) => +x.toFixed(1)).join('/');

      // ---- 1. Columns, gaps, equal heights and one button line — at every width, under stress ----
      const measuredCollection = {}, collectionStyles = {};
      const snapshotIds = ['3', '4', '5'];   // sale + low stock + reviews / sold out / price range
      for (const [vw, cols] of [[320, 2], [360, 2], [414, 2], [599, 2], [600, 3], [768, 3], [1023, 3], [1024, 4], [1025, 4], [1440, 4]]) {
        const sp = await openStore(vw, '/collection/all', stressCatalog, '#collectionGrid .product-card');
        const m = measuredCollection[vw] = await measureGrid(sp, '#collectionGrid');
        if (vw === 320) {
          const priorities = await sp.evaluate(() => {
            const images = [...document.querySelectorAll('#collectionGrid .product-card-image img')];
            const high = images.filter(image => image.getAttribute('fetchpriority') === 'high');
            return { count: images.length, highCount: high.length, firstIsHigh: high[0] === images[0], firstLoading: images[0]?.getAttribute('loading') };
          });
          assert.ok(priorities.count > 0, 'the collection grid renders product images');
          assert.equal(priorities.highCount, 1, 'one visible collection card is promoted');
          assert.equal(priorities.firstIsHigh, true, 'only the first collection product image is promoted');
          assert.equal(priorities.firstLoading, 'lazy', 'product-card images retain lazy loading even when the visible first image gets high priority');
        }
        if ([360, 414, 1440].includes(vw)) collectionStyles[vw] = await styleSnapshot(sp, '#collectionGrid', snapshotIds);
        const rows = groupRows(m.cards);
        assert.equal(m.cards.length, 8, `${vw}px: the first page shows 8 cards`);
        assert.equal(m.columns, cols, `${vw}px: the grid has ${cols} columns (got ${m.columns})`);
        assert.equal(rows[0].cards.length, cols, `${vw}px: the first row really holds ${cols} cards`);
        assert.ok(rows.every((r) => r.cards.length <= cols), `${vw}px: never more than ${cols} cards per row`);
        assert.equal(m.colGap, m.homeColGap, `${vw}px: column gap equals the home grid's (${m.colGap} vs ${m.homeColGap})`);
        assert.equal(m.rowGap, m.homeRowGap, `${vw}px: row gap equals the home grid's (${m.rowGap} vs ${m.homeRowGap})`);
        assert.ok(spread(rows[0].cards.map((c) => c.w)) <= 1, `${vw}px: equal column widths (${fmt1(rows[0].cards.map((c) => c.w))})`);
        rows.forEach((row, i) => {
          for (const [key, label] of [['h', 'card heights'], ['btnTop', 'button tops'], ['btnBottom', 'button bottoms'], ['btnH', 'button heights']]) {
            assert.ok(spread(row.cards.map((c) => c[key])) <= 1, `${vw}px row ${i + 1}: equal ${label} (${fmt1(row.cards.map((c) => c[key]))})`);
          }
        });
        assert.ok(m.cards.every((c) => Math.abs(c.imgH / c.imgW - 4 / 3) < 0.01), `${vw}px: image area keeps the home 3:4 proportion`);
        assert.ok(m.cards.every((c) => c.btnOpacity === '1' && c.btnH >= 43.5 && c.btnW > 60), `${vw}px: every Quick View button is visible, 44px tall and full width`);
        assert.ok(m.docW <= m.innerW, `${vw}px: no horizontal overflow (${m.docW} <= ${m.innerW})`);
        assert.ok(m.cards.every((c) => c.left >= -0.5 && c.right <= m.innerW + 0.5), `${vw}px: every card sits inside the viewport`);
        // The filter UI keeps its breakpoints: sidebar from 1025px, the Filter button below.
        assert.equal(m.sidebar !== 'none', vw >= 1025, `${vw}px: the filter sidebar shows only on desktop (${m.sidebar})`);
        assert.equal(m.filterButton !== 'none', vw < 1025, `${vw}px: the Filter button shows only below 1025px (${m.filterButton})`);
        console.log(`✅ ${vw}px real Chromium — collection grid: ${m.columns} cols, gap ${m.colGap}, card ${fmt1([m.cards[0].w])}px, row heights ${fmt1(rows.map((r) => r.cards[0].h))}, buttons share one line per row`);
        await sp.close();
      }

      // ---- 2. Same renderer, same classes, same look as Best Sellers ----
      // At 360 and 414px both grids are 2 columns with the same gap, so the same product is the same
      // card — pixel for pixel. At 1440px the sizes differ (the shop has a sidebar) but not the styling.
      for (const vw of [360, 414, 1440]) {
        const hp = await openStore(vw, '/', stressCatalog, '#bestSellersGrid .product-card');
        const home = await measureGrid(hp, '#bestSellersGrid');
        const homeStyles = await styleSnapshot(hp, '#bestSellersGrid', snapshotIds);
        await hp.close();
        const byId = (m) => Object.fromEntries(m.cards.map((c) => [c.id, c]));
        const homeCards = byId(home), colCards = byId(measuredCollection[vw]);
        assert.deepEqual(Object.keys(colCards).sort(), Object.keys(homeCards).sort(), `${vw}px: Best Sellers and the collection grid show the same products`);
        for (const id of Object.keys(colCards)) {
          assert.equal(colCards[id].html, homeCards[id].html, `${vw}px product ${id}: identical card markup (same renderer, same classes)`);
        }
        assert.deepEqual(collectionStyles[vw], homeStyles, `${vw}px: sale, sold-out and range cards are styled identically to their Best Sellers twins`);
        assert.ok(snapshotIds.every((id) => homeStyles[id].button && homeStyles[id].name && homeStyles[id].heart), `${vw}px: the sampled cards have all their parts`);
        if (vw < 1024) {
          assert.equal(home.columns, 2, `${vw}px: Best Sellers is 2 columns`);
          for (const id of Object.keys(colCards)) {
            for (const key of ['w', 'h', 'imgW', 'imgH', 'btnW', 'btnH']) {
              assert.ok(Math.abs(colCards[id][key] - homeCards[id][key]) <= 0.5,
                `${vw}px product ${id}: card ${key} is the same in both grids (collection ${colCards[id][key]} / home ${homeCards[id][key]})`);
            }
          }
          assert.equal(measuredCollection[vw].colGap, home.colGap, `${vw}px: same gap as home`);
        }
        console.log(`✅ ${vw}px real Chromium — collection cards are the Best Sellers cards: identical markup, identical computed styles${vw < 1024 ? ', identical sizes' : ''}`);
      }

      // ---- 3. No horizontal page scroll at 320 / 360 / 414 / 768 / 1024 / 1440, on every collection state ----
      const overflowReport = (sp) => sp.evaluate(() => {
        window.scrollTo(500, 0);
        const iw = window.innerWidth;
        const offenders = [];
        for (const el of document.querySelectorAll('#shopSection *')) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          if (r.left >= -0.5 && r.right <= iw + 0.5) continue;
          let clipped = false;   // sticks out only inside a box that clips it (e.g. a card's overflow: hidden)
          for (let a = el.parentElement; a && a.id !== 'shopSection'; a = a.parentElement) {
            if (getComputedStyle(a).overflowX === 'visible') continue;
            const ar = a.getBoundingClientRect();
            if (ar.left >= -0.5 && ar.right <= iw + 0.5) { clipped = true; break; }
          }
          if (!clipped) offenders.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}→${Math.round(r.right)}`);
        }
        return { scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth: iw, scrollX: window.scrollX, offenders: offenders.slice(0, 5) };
      });
      for (const vw of [320, 360, 414, 768, 1024, 1440]) {
        const rp = await openStore(vw, '/collection/all', null, '#collectionGrid .product-card');
        const states = [
          ['all', ''],
          ['anime', "navigateTo('collection', 'anime')"],
          ['graphic tees', "navigateTo('collection', 'graphic-tees')"],
          ['pants (empty state)', "navigateTo('collection', 'pants')"],
          ['sale', "navigateTo('collection', 'sale')"],
          ['search results', "onSearchInput('wolf')"],
          ['load more page', "onSearchInput(''); navigateTo('collection', 'all'); loadMore()"]
        ];
        for (const [state, action] of states) {
          if (action) await rp.evaluate(action);
          await settleLayout(rp);
          const o = await overflowReport(rp);
          assert.ok(o.scrollWidth <= o.innerWidth, `${vw}px ${state}: the page is not wider than the screen (${o.scrollWidth} <= ${o.innerWidth})`);
          assert.ok(o.bodyScrollWidth <= o.innerWidth, `${vw}px ${state}: <body> is not wider than the screen (${o.bodyScrollWidth})`);
          assert.equal(o.scrollX, 0, `${vw}px ${state}: the page cannot be scrolled sideways`);
          assert.deepEqual(o.offenders, [], `${vw}px ${state}: nothing in the shop sticks out of the viewport`);
        }
        await rp.close();
      }
      console.log('✅ No horizontal page scroll at 320 / 360 / 414 / 768 / 1024 / 1440px on all, anime, graphic tees, pants (empty), sale, search and page 2');

      // ---- 4. Header, sort, Filter button + drawer and pagination keep working (320px phone) ----
      {
        const fp = await openStore(320, '/collection/all', stressCatalog, '#collectionGrid .product-card');
        for (const sel of ['#collectionTitle', '#collectionDesc', '#resultCount', '#sortSelect', '.filter-toggle-btn', '#pagination']) {
          const box = await fp.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height, iw: innerWidth }; });
          assert.ok(box.w > 0 && box.h > 0 && box.l >= -0.5 && box.r <= box.iw + 0.5, `320px: ${sel} is visible and inside the screen (${JSON.stringify(box)})`);
        }
        assert.equal(await fp.$eval('#collectionTitle', (el) => el.textContent), 'FEATURED DROPS | NEW ARRIVALS');
        assert.equal(await fp.$eval('#resultCount', (el) => el.textContent), '10 results');
        assert.equal(await fp.$eval('#catalogShowing', (el) => el.textContent), 'Showing 8 of 10');
        // Sort: cheapest first (price range → its lowest price), and the grid really re-renders.
        await fp.select('#sortSelect', 'price-low');
        const sortedMins = await fp.evaluate(() => [...document.querySelectorAll('#collectionGrid .product-card')]
          .map((c) => getPriceRange(allProducts.find((p) => String(p.id) === c.dataset.pid)).min));
        assert.deepEqual(sortedMins, [...sortedMins].sort((a, b) => a - b), `sorting by price puts the cheapest first (${sortedMins})`);
        assert.equal(sortedMins[0], 99, 'the Rs. 99 product leads');
        await fp.select('#sortSelect', 'featured');
        // Filter button opens the drawer; Apply closes it.
        await fp.click('.filter-toggle-btn');
        await fp.waitForSelector('#filterDrawer.open');
        await settleLayout(fp);   // let the drawer finish sliding in before measuring / clicking inside it
        const drawerLeft = await fp.$eval('#filterDrawer', (el) => Math.round(el.getBoundingClientRect().left));
        assert.ok(drawerLeft >= 0, `the Filter drawer slides fully on screen (left ${drawerLeft})`);
        await fp.click('#filterDrawer .filter-drawer-footer .btn');
        await fp.waitForFunction(() => !document.getElementById('filterDrawer').classList.contains('open'));
        await settleLayout(fp);   // the drawer is a fixed layer until it has finished sliding out
        // Load more: reveals the remaining two products.
        await fp.click('#loadMoreBtn');
        await fp.waitForFunction(() => document.getElementById('catalogShowing').textContent === 'Showing 10 of 10');
        assert.equal(await fp.$$eval('#collectionGrid .product-card', (cards) => cards.length), 10, 'load more reveals the remaining two products');
        assert.equal(await fp.$eval('#loadMoreBtn', (el) => getComputedStyle(el).display), 'none', 'there is no Load more once everything is shown');
        await fp.mouse.move(0, 0);   // park the pointer: a card under it would show its hover lift
        await settleLayout(fp);
        const last = await measureGrid(fp, '#collectionGrid');
        const tail = last.cards.filter((card) => card.id === '9' || card.id === '10');
        assert.equal(tail.length, 2, 'both remaining products are rendered');
        assert.equal(groupRows(tail).length, 1, 'the two cards revealed by Load more share one row');
        assert.ok(spread(tail.map((c) => c.h)) <= 1 && spread(tail.map((c) => c.btnTop)) <= 1, 'and line up too');
        console.log('✅ 320px real Chromium — page header, result count, sort, Filter drawer and pagination all work');
        await fp.close();
      }

      // ---- 5. Real clicks and keys: heart, Quick View (even when sold out), Enter on a card; hover lift ----
      {
        const ip = await openStore(360, '/collection/all', stressCatalog, '#collectionGrid .product-card');
        const heart = '#collectionGrid .product-card[data-pid="2"] .product-wishlist';
        await ip.click(heart);
        assert.equal(await ip.$eval(heart, (el) => el.classList.contains('active')), true, 'a real tap on the heart saves the product');
        assert.equal(await ip.$eval('#wishlistCount', (el) => el.textContent), '1');
        assert.equal(new URL(ip.url()).pathname, '/collection/all', 'the heart does not open the product');
        assert.equal(await ip.$eval('#wishlistDrawer', (el) => el.classList.contains('open')), true, 'saving a favourite opens the favourites list');
        // The list slides in over the grid; wait for it to land before closing it and tapping again.
        await ip.waitForFunction(() => document.getElementById('wishlistDrawer').getBoundingClientRect().left <= 1);
        await ip.click('#wishlistDrawer .cart-close');
        await ip.waitForFunction(() => document.getElementById('wishlistDrawer').getBoundingClientRect().left >= window.innerWidth - 1);
        await ip.click(heart);
        assert.equal(await ip.$eval(heart, (el) => el.classList.contains('active')), false, 'a second tap removes it');
        assert.equal(await ip.$eval('#wishlistCount', (el) => el.textContent), '0');
        await ip.click('#collectionGrid .product-card[data-pid="4"] .quick-view-btn');   // the sold-out card
        assert.equal(new URL(ip.url()).pathname, '/product/4', 'Quick View opens the product page, sold out or not');
        await ip.evaluate(() => navigateTo('collection', 'all'));
        await ip.waitForSelector('#collectionGrid .product-card[data-pid="5"]', { visible: true });
        await ip.focus('#collectionGrid .product-card[data-pid="5"]');
        await ip.keyboard.press('Enter');
        assert.equal(new URL(ip.url()).pathname, '/product/5', 'Enter on a focused card opens its product page');
        await ip.evaluate(() => navigateTo('collection', 'all'));
        await ip.waitForSelector('#collectionGrid .product-card[data-pid="1"]', { visible: true });
        await ip.click('#collectionGrid .product-card[data-pid="1"] h3');
        assert.equal(new URL(ip.url()).pathname, '/product/1', 'tapping the card itself opens its product page');
        await ip.close();

        const dp = await openStore(1440, '/collection/all', stressCatalog, '#collectionGrid .product-card');
        await new Promise((resolve) => setTimeout(resolve, 1200));   // longer than any load-time card animation could run
        assert.equal(await dp.$$eval('#collectionGrid .product-card[style]', (cards) => cards.length), 0,
          'collection cards carry no inline styles, so their look (and hover lift) comes from the shared CSS only');
        const lift = async (selector) => {
          await dp.hover(selector);
          await settleLayout(dp);
          return dp.$eval(selector, (el) => new DOMMatrix(getComputedStyle(el).transform).m42);
        };
        assert.ok(await lift('#collectionGrid .product-card[data-pid="2"]') <= -4, 'a collection card lifts ~6px on hover, like a Best Sellers card');
        await dp.close();
        console.log('✅ 360px/1440px real Chromium — heart, Quick View, Enter key, card tap and hover lift work on collection cards');
      }
      assert.deepEqual(pageErrors, [], 'no script errors while the collection grid rendered in any of the above');
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
    const soldOutAdminRow = ad.querySelector('#productList .product-sold-out-badge').closest('.product-row');
    assert.equal(soldOutAdminRow.querySelector('.stock-label').textContent, 'Sold Out');
    assert.match(soldOutAdminRow.querySelector('.toggle-switch').getAttribute('aria-label'), /Mark In Stock/);
    assert.equal(soldOutAdminRow.querySelector('.toggle-switch').getAttribute('aria-pressed'), 'false');
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

    // Mutation responses are deliberately different from the authoritative
    // list, proving the panel reloads rather than patching its old local copy.
    {
      const savedFetch = aw.fetch;
      const savedConfirm = aw.confirm;
      const savedAlert = aw.alert;
      const reads = [];
      const writes = [];
      let authoritative = [];
      const fresh = { ...products[0], id: 987660, name: 'Fresh admin Pants', category: 'pants', sizes: ['M'], size_stock: null };
      try {
        aw.confirm = () => true;
        aw.alert = message => { throw new Error(message); };
        aw.fetch = async (url, options = {}) => {
          if (String(url).startsWith('/api/admin/products')) {
            assert.match(url, /^\/api\/admin\/products\?_=[0-9]+$/);
            assert.equal(options.cache, 'no-store');
            reads.push(url);
            return { ok: true, json: async () => authoritative };
          }
          if (String(url).startsWith('/api/products')) {
            writes.push(options.method);
            authoritative = options.method === 'DELETE' ? [] : [{ ...fresh,
              name: options.method === 'PUT' ? 'Fresh edited Pants' : fresh.name }];
            return { ok: true, json: async () => ({ ...fresh, name: 'Mutation response only' }) };
          }
          return { ok: false, json: async () => ({}) };
        };
        aw.populateCategorySelects();
        ad.getElementById('productCategoryFilter').value = '';
        aw.resetForm();
        aw.eval('formImageBlob = new Blob(["image"], { type: "image/webp" })');
        ad.getElementById('prodName').value = 'Admin Pants';
        ad.getElementById('prodCategory').value = 'pants';
        ad.getElementById('prodPrice').value = '2499';
        await aw.handleSaveProduct({ preventDefault() {} });
        assert.equal(reads.length, 1, 'create must reload the admin list');
        assert.match(ad.getElementById('productList').textContent, /Fresh admin Pants/);
        aw.editProduct(fresh.id);
        await aw.handleSaveProduct({ preventDefault() {} });
        assert.equal(reads.length, 2, 'update must reload the admin list');
        assert.match(ad.getElementById('productList').textContent, /Fresh edited Pants/);
        await aw.deleteProduct(fresh.id);
        assert.equal(reads.length, 3, 'delete must reload the admin list');
        assert.equal(aw.eval('products.length'), 0);
        assert.deepEqual(writes, ['POST', 'PUT', 'DELETE']);
      } finally {
        aw.fetch = savedFetch;
        aw.confirm = savedConfirm;
        aw.alert = savedAlert;
        aw.resetForm();
        aw.eval('products = ' + JSON.stringify(products) + '; filterProducts()');
      }
      console.log('✅ Admin creates, updates and deletes reload the API list with cache busting');
    }

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
    // Every category is permanent, so Pants sits in the nav in its canonical
    // order (between Anime Shirts and Custom Stickers) at all times.
    assert.deepEqual(visibleNavLinks.map(a => a.getAttribute('href')), [
      '/', '/collection/anime', '/collection/graphic-tees', '/collection/pants',
      '/custom-stickers', '/about', '/contact', '/tracking'
    ]);
    const pantsNavItem = navLinks.find(a => a.textContent.trim() === 'Pants');
    assert.ok(pantsNavItem, 'Pants nav link is in markup');
    assert.notEqual(pantsNavItem.closest('li').style.display, 'none', 'Pants nav is always shown');
    const cardTiles = [...d.querySelectorAll('#page-home .cat-tile')];
    assert.deepEqual(cardTiles.map(t => t.querySelector('.cat-name').textContent.trim()), ['Graphic Tees', 'Anime Shirts', 'Pants', 'Custom Stickers']);
    const cardRoutes = Object.fromEntries(cardTiles.filter(t => t.tagName === 'A').map(tile => [
      tile.querySelector('.cat-name').textContent.trim(), tile.getAttribute('href')
    ]));
    for (const name of ['Anime Shirts', 'Graphic Tees', 'Pants', 'Custom Stickers']) {
      assert.equal(visibleNavLinks.find(a => a.textContent.trim() === name).getAttribute('href'), cardRoutes[name], `${name} nav link matches its homepage card`);
    }
    const pantsTileNavCheck = d.getElementById('catTilePants');
    assert.ok(pantsTileNavCheck && pantsTileNavCheck.tagName === 'A' && !pantsTileNavCheck.hasAttribute('aria-disabled'), 'Pants tile is a real link');
    assert.equal(pantsNavItem.getAttribute('href'), pantsTileNavCheck.getAttribute('href'), 'Pants nav and card share the same collection route');
    const footerHeadings = [...d.querySelectorAll('.site-footer h3')].map(h => h.textContent.trim());
    assert.ok(!footerHeadings.includes('Shop'), 'footer has no Shop column');
    assert.equal(d.querySelectorAll('.site-footer a[href^="/collection/"]').length, 1, 'Pants is the only stock-aware footer collection link');
    assert.notEqual(d.getElementById('footerPantsItem').style.display, 'none', 'Pants footer link is always shown');
    assert.equal(d.querySelector('#footerPantsItem a').getAttribute('href'), '/collection/pants');
    assert.equal(d.querySelector('#navLinks .mobile-icons-row'), null, 'mobile menu has no extra track-order icon row below search');
    assert.equal(d.querySelectorAll('#navLinks .nav-icon').length, 0, 'mobile menu has no icon buttons below the search bar');
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
    assert.match(storeHtml, /\.nav-links\.open \{[\s\S]*?display: flex;[\s\S]*?max-height: calc\(100dvh - 95px\);[\s\S]*?overflow-y: auto;[\s\S]*?background-color: var\(--bg-primary\);[\s\S]*?z-index: 1001;/, 'open menu is an opaque, bounded panel below the header');
    assert.doesNotMatch(storeHtml, /@media \(max-width: 1023px\) \{\s*\.nav-links\.open \{/, 'the open panel is not gated behind a phone/tablet breakpoint any more');
    assert.match(storeHtml, /@media \(max-width: 768px\) \{\s*\.nav-links \{\s*position: absolute; top: 100%; left: 0; right: 0; width: 100%;\s*background: var\(--bg-primary\);/, 'phone/tablet menu spans the viewport with a solid background');
    assert.match(storeHtml, /@media \(max-width: 360px\) \{\s*\.site-header \{ height: auto; \}\s*\.site-header \.nav-inner \{ height: auto; min-height: 67px; flex-wrap: wrap; \}/, 'the 360px header lets its bar grow when the row wraps');
    assert.match(storeHtml, /@media \(max-width: 640px\) \{[\s\S]*?\.kage-logo \{[^}]*max-width: max\(80px, calc\(100vw - 224px\)\);/, 'the mobile logo shrinks so the row never wraps on normal phones');
    assert.match(storeHtml, /@media \(max-width: 640px\) \{[\s\S]*?\.kage-logo img \{[^}]*object-fit: contain;/, 'the shrunk logo scales instead of distorting');

    // FOUC guard: the main bundle is 146 KB, and before it applies the browser
    // paints the document with its own defaults - a blue "Skip to content" link
    // at the top, a full-size wordmark and bulleted nav. A tiny pre-paint
    // stylesheet must load FIRST to hold that back, and the main bundle must
    // release it (visibility inherits, so an explicit `visible` is required).
    // stitched() inlines the bundle, so assert order on the <link> position:
    // the guard must appear before the main stylesheet link in the source.
    const rawIndexHtml = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
    // Since 2026-11-23 the guard and the bundle are concatenated into ONE
    // inline <style> block at render time, so there is no request between the
    // HTML and the first paint and the guard can never arrive late.
    assert.ok(rawIndexHtml.includes('<!--__INLINE_CSS__-->'), 'the shell inlines its stylesheet at boot');
    assert.ok(!rawIndexHtml.includes('href="/pre-paint.css"'), 'the guard is no longer a separate link');
    assert.ok(!rawIndexHtml.includes('href="/storefront.css'), 'no render-blocking stylesheet link remains');
    const prePaint = readFileSync(join(__dirname, '..', 'public', 'pre-paint.css'), 'utf8');
    assert.ok(prePaint.length < 2048, `the pre-paint guard stays small enough to arrive in one round trip (${prePaint.length} B)`);
    for (const sel of ['.skip-link', '.topbar', '.hero-media', '.site-header', '.cart-drawer', '.cart-overlay', '.zoom-overlay']) {
      assert.ok(prePaint.includes(sel), `the guard hides ${sel} before CSS arrives`);
    }
    assert.match(prePaint, /html \{\s*background: #D9D4C8;/, 'the pre-CSS canvas is the brand background, not browser white');
    // Every guarded selector must be released by the main bundle.
    const release = storeHtml.match(/PRE-PAINT GUARD RELEASE[\s\S]*?\{\s*visibility: visible;\s*\}/);
    assert.ok(release, 'storefront.css carries the release block for the pre-paint guard');
    const releaseBlock = release[0];
    for (const sel of ['.skip-link', '.topbar', '.hero-media', '.site-header', '.cart-drawer', '.cart-overlay', '.zoom-overlay']) {
      assert.ok(releaseBlock.includes(sel), `the release block restores ${sel}`);
    }
    assert.match(storeHtml, /\.hamburger\.active svg line:nth-child\(2\) \{ transform: translateY\(6px\) rotate\(45deg\); \}/, 'the SVG hamburger animates into an X');
    assert.doesNotMatch(storeHtml, /\.hamburger\.active span:nth-child/, 'hamburger state does not target nonexistent spans');
    assert.doesNotMatch(storeHtml, /\.nav-links \{[^}]*display: flex !important;/, 'no breakpoint turns the link list back into an inline row');
    assert.doesNotMatch(storeHtml, /\.hamburger \{ display: none; \}/, 'the hamburger is never hidden — it is the only nav entry point');
    assert.match(storeHtml, /@media \(min-width: 1024px\) \{[\s\S]*?\.hamburger \{ display: flex; \}/, 'the desktop header shows the hamburger');
    assert.match(storeHtml, /@media \(min-width: 1024px\) \{[\s\S]*?\.nav-links\.open \{[\s\S]*?right: 32px;[\s\S]*?width: 320px;/, 'the desktop panel is anchored to the header right edge');
    assert.match(storeHtml, /\.mobile-search \{ display: block; \}/, 'the panel search row is shown at every width');
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
    // Mobile search bar: submitting via Enter or the search button closes the menu,
    // restores body scroll, and displays the matching search results.
    w.resetFilters();
    Object.defineProperty(w, 'innerWidth', { configurable: true, value: 390 });
    d.body.style.overflow = 'auto';
    hamburger.click();
    const mobileSearchInput = d.getElementById('mobileSearch');
    mobileSearchInput.value = 'wolf';
    mobileSearchInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(navList.classList.contains('open'), false, 'pressing Enter in mobile search closes the mobile menu');
    assert.equal(d.body.style.overflow, 'auto', 'pressing Enter in mobile search unlocks body scroll');
    assert.equal(shopVisible(), true, 'pressing Enter in mobile search reveals the shop grid');
    assert.equal(d.querySelectorAll('#collectionGrid .product-card h3').length, 1, 'mobile search filters the product grid');
    w.onSearchInput('');
    Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
    // Desktop uses the same menu, so the same open/close contract holds there.
    hamburger.click();
    assert.equal(navList.classList.contains('open'), true, 'the desktop menu opens from the hamburger');
    assert.equal(hamburger.getAttribute('aria-expanded'), 'true', 'desktop aria-expanded follows the open state');
    assert.equal(d.body.style.overflow, 'hidden', 'desktop menu locks page scroll while open');
    d.querySelector('#navLinks a[href="/about"]').click();
    assert.equal(navList.classList.contains('open'), false, 'a desktop menu link closes the menu');
    assert.equal(hamburger.getAttribute('aria-expanded'), 'false');
    assert.equal(d.body.style.overflow, 'auto', 'the desktop menu restores the previous scroll state');
    d.body.style.overflow = '';

    // Search submits on Enter or the magnifier — never while typing. Typing
    // used to re-render the grid on every keystroke (and on the plain homepage
    // it swapped the marketing sections for the shop mid-word).
    {
      w.resetFilters();
      Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
      const dInput = d.getElementById('searchInput');
      dInput.value = 'wolf';
      dInput.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal(w.eval('searchQuery'), '', 'typing does not search yet');
      assert.equal(shopVisible(), false, 'typing does not reveal the shop grid');
      dInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert.equal(w.eval('searchQuery'), 'wolf', 'Enter commits the search');
      assert.equal(shopVisible(), true, 'committing the search reveals the shop grid');
      assert.equal(d.querySelectorAll('#collectionGrid .product-card h3').length, 1, 'Enter runs the search');
      // The in-field magnifier is a real submit button for its own field.
      w.onSearchInput('');
      const submitIcon = d.getElementById('searchSubmit');
      assert.equal(submitIcon.tagName, 'BUTTON', 'the desktop search magnifier is a button');
      dInput.value = 'wolf';
      submitIcon.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(w.eval('searchQuery'), 'wolf', 'the magnifier commits the search');
      assert.equal(d.querySelectorAll('#collectionGrid .product-card h3').length, 1, 'the magnifier runs the search');
      w.onSearchInput('');
    }

    // The dropdown row's tint must not touch the label: the row carries real
    // horizontal padding, so the text sits inside the pill instead of flush
    // against its left edge (the reported "highlight touching the word").
    assert.match(storeHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.nav-links a \{ padding: 10px 16px;/,
      'mobile menu rows inset their label from the row tint');
    assert.doesNotMatch(storeHtml, /@media \(max-width: 768px\) \{[\s\S]*?\.nav-links a \{ padding: 10px 0;/,
      'mobile menu rows no longer zero their horizontal padding');

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
    // Scenario 19: order history lists every order, each expandable into detail
    // ---------------------------------------------------------------
    const acct = page(storeHtml, '/account'); windows.push(acct);
    await wait(100);
    const cw = acct.window, cd = cw.document;
    const ordersEl = () => cd.getElementById('acctOrders');

    // Unverified accounts get no list at all (the server sends an empty array)
    // and are pointed at the resend flow.
    cw.currentCustomer = { id: 7, email: 'unverified@kage.test', name: 'Unverified', email_verified: false };
    cw.updateVerifyBanner(false);
    cw.renderAccountOrders([], false);
    const banner = cd.getElementById('acctVerifyBanner');
    assert.equal(banner.hidden, false, 'the verify banner is visible for an unverified account');
    assert.match(banner.textContent, /Verify your email/i, 'the banner explains why history is hidden');
    assert.match(cd.getElementById('acctVerifyLink').textContent, /Resend/i, 'the banner offers a resend link');
    assert.match(ordersEl().textContent, /Verify your email to see your orders/i, 'the history area shows the verify state');
    assert.match(ordersEl().innerHTML, /data-action="resend-verification"/, 'the empty state links to the resend action');
    assert.doesNotMatch(ordersEl().textContent, /No orders yet/i, 'an unverified account is not told it has no orders');

    // Two orders, newest first — every one of them renders, not just the first.
    const history = [
      {
        order_number: 'KAGE-9002', status: 'shipped', payment_method: 'bank', payment_ref: 'TRX-77A',
        payment_verified: true, subtotal: 4200, shipping: 250, shipping_pending: false, total: 4450,
        created_at: '2026-10-12 09:30:00', address: '12 Jinnah Road, Block 4', city: 'Karachi', phone: '+92 300 1234567',
        notes: 'Leave with the guard', email: 'buyer@kage.test',
        items: [
          { id: 1, name: 'Kage Shadow Tee', size: 'M', qty: 2, unit: 1500, total: 3000, image: '/images/tee.jpg' },
          { id: 2, name: 'Kage Cargo Pants', size: 'L', qty: 1, unit: 1200, total: 1200, image: '' }
        ]
      },
      {
        order_number: 'KAGE-9001', status: 'awaiting_verification', payment_method: 'jazzcash', payment_ref: 'JC-5512',
        payment_verified: false, subtotal: 1500, shipping: 250, shipping_pending: false, total: 1750,
        created_at: '2026-10-11 10:00:00', address: '9 Mall Road', city: 'Lahore', phone: '+92 301 7654321',
        items: [{ id: 3, name: 'Ember Graphic Tee', size: 'S', qty: 1, unit: 1500, total: 1500, image: '' }]
      }
    ];
    cw.updateVerifyBanner(true);
    cw.renderAccountOrders(history, true);
    assert.equal(cd.getElementById('acctVerifyBanner').hidden, true, 'the banner hides once the email is verified');
    const cards = ordersEl().querySelectorAll('.order-card');
    assert.equal(cards.length, 2, 'every order in the history gets its own card');
    assert.match(ordersEl().textContent, /2 orders/, 'the list states how many orders there are');
    assert.match(cards[0].querySelector('.order-num').textContent, /KAGE-9002/, 'orders keep the server order (newest first)');
    assert.match(cards[1].querySelector('.order-num').textContent, /KAGE-9001/);
    assert.match(cards[1].querySelector('.order-status').textContent, /Awaiting payment/i, 'awaiting_verification has a readable label');
    assert.ok(cards[1].querySelector('.order-status').classList.contains('order-status-awaiting_verification'), 'awaiting_verification has its own pill style');
    assert.match(cards[0].querySelector('.order-total').textContent, /Rs\. 4,450/, 'the row shows the order total');

    // Collapsed by default, with real disclosure semantics.
    const firstRow = cards[0].querySelector('.order-row');
    const firstDetail = cards[0].querySelector('.order-detail');
    assert.equal(firstRow.getAttribute('aria-expanded'), 'false', 'rows start collapsed');
    assert.equal(firstRow.getAttribute('aria-controls'), firstDetail.id, 'the row names the panel it controls');
    assert.equal(firstDetail.hidden, true, 'the collapsed panel is hidden, not merely styled');
    assert.match(firstDetail.innerHTML, /Kage Shadow Tee/, 'the panel is populated up front');

    // Expanding shows items, sizes, quantities, line totals, money and address.
    firstRow.click();
    assert.equal(firstRow.getAttribute('aria-expanded'), 'true', 'clicking a row expands it');
    assert.equal(firstDetail.hidden, false, 'the expanded panel is shown');
    assert.ok(cards[0].classList.contains('is-open'), 'the card is marked open for styling');
    const detailText = firstDetail.textContent;
    assert.match(detailText, /Kage Shadow Tee/);
    assert.match(detailText, /Kage Cargo Pants/);
    assert.match(detailText, /Size M · Qty 2/, 'each line shows size and quantity');
    assert.match(detailText, /Rs\. 3,000/, 'each line shows its line total');
    assert.match(detailText, /Rs\. 1,500 each/, 'each line shows the unit price');
    assert.match(detailText, /Subtotal[\s\S]*Rs\. 4,200/, 'the summary names the subtotal');
    assert.match(detailText, /Delivery[\s\S]*Rs\. 250/, 'the summary names the delivery charge');
    assert.match(detailText, /Total[\s\S]*Rs\. 4,450/, 'the summary names the total');
    assert.match(detailText, /Bank transfer/, 'the payment method is spelled out');
    assert.match(detailText, /Payment verified/, 'the payment state is reported');
    assert.match(detailText, /Reference: TRX-77A/, 'the payment reference is shown');
    assert.match(detailText, /12 Jinnah Road, Block 4/, 'the delivery address is shown');
    assert.match(detailText, /Karachi/, 'the city is shown');
    assert.match(detailText, /\+92 300 1234567/, 'the delivery phone is shown');
    assert.match(detailText, /Leave with the guard/, 'order notes are shown');
    assert.match(detailText, /12 Oct 2026/, 'the order date is shown');
    assert.equal(firstDetail.querySelectorAll('.order-item').length, 2, 'one line per ordered item');
    assert.equal(firstDetail.querySelector('.order-item img').getAttribute('src'), '/images/tee.jpg', 'item thumbnails come from the stored order');
    assert.match(firstDetail.querySelector('.order-detail-track').getAttribute('href'), /\/tracking/, 'each order links to tracking');
    assert.equal(firstDetail.querySelector('button[data-pid="1"]') !== null, true, 'items whose product still exists link to the product page');

    // Collapsing again hides it; a second row expands independently.
    firstRow.click();
    assert.equal(firstRow.getAttribute('aria-expanded'), 'false');
    assert.equal(firstDetail.hidden, true, 'clicking an open row collapses it');
    cards[1].querySelector('.order-row').click();
    assert.equal(cards[1].querySelector('.order-detail').hidden, false, 'another order can be opened at the same time');
    assert.match(cards[1].querySelector('.order-detail').textContent, /JazzCash/, 'cash/wallet methods are labelled readably');

    // Totals for a phone-confirmed delivery stay honest.
    cw.renderAccountOrders([{
      order_number: 'KAGE-9003', status: 'pending', payment_method: 'cod', subtotal: 3000, shipping: 0,
      shipping_pending: true, total: 3000, created_at: '2026-10-13 12:00:00', address: '1 Sea View', city: 'Karachi',
      items: [{ id: 9, name: 'Kage Hoodie', size: 'XL', qty: 1, unit: 3000, total: 3000, image: '' }]
    }], true);
    const pendingCard = ordersEl().querySelector('.order-card');
    pendingCard.querySelector('.order-row').click();
    const pendingText = pendingCard.querySelector('.order-detail').textContent;
    assert.match(pendingText, /Confirmed by phone \(Rs\. 250 – Rs\. 500\)/, 'an unconfirmed delivery charge says so instead of "Rs. 0"');
    assert.match(pendingText, /Total \(before delivery\)/, 'the total is labelled as excluding delivery');
    assert.match(pendingText, /Cash on delivery/, 'cod is labelled readably');

    // Everything from the API is untrusted text.
    cw.renderAccountOrders([{
      order_number: 'KAGE-X<img src=x onerror="alert(1)">', status: 'pending', total: 100, subtotal: 100, shipping: 0,
      created_at: '2026-10-14 08:00:00', address: '<b>Bold</b> street', city: 'Karachi', notes: '</script><script>alert(2)</script>',
      payment_method: 'bank', payment_ref: '<i>ref</i>',
      items: [{ id: 5, name: '<img src=x onerror="alert(3)">', size: '<u>S</u>', qty: 1, unit: 100, total: 100, image: 'x" onerror="alert(4)' }]
    }], true);
    const hostileCard = ordersEl().querySelector('.order-card');
    hostileCard.querySelector('.order-row').click();
    assert.equal(hostileCard.querySelectorAll('img[src="x"]').length, 0, 'an injected img in a product name does not survive');
    assert.equal(hostileCard.querySelectorAll('b, u, i').length, 0, 'injected markup in address/size/ref is escaped');
    assert.match(hostileCard.textContent, /<b>Bold<\/b> street/, 'the address is shown as literal text');
    assert.match(hostileCard.querySelector('.order-detail').textContent, /Size <u>S<\/u>/, 'the size is shown as literal text');

    // A response of the wrong shape cannot crash the page.
    cw.renderAccountOrders(null, true);
    assert.match(ordersEl().textContent, /No orders yet/i, 'a null payload falls back to the empty state');

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
    // Scenario 19b: anonymous visits skip the session probe
    // ---------------------------------------------------------------
    // The session cookie is httpOnly; `kage.signed_in` (set by the server on
    // login, cleared on logout, no identity inside) is the readable hint the
    // storefront uses to decide whether /api/customers/me is worth a round trip.
    const anonVisit = page(storeHtml, '/', { browserCookies: true });
    windows.push(anonVisit);
    await ready(anonVisit.window);
    assert.equal(anonVisit.requests.some(r => r.url === '/api/customers/me'), false,
      'a first-time visitor must not request /api/customers/me');
    assert.equal(anonVisit.window.eval('currentCustomer'), null, 'and is treated as signed out');

    // The three boot GETs are started by the first statements of the bundle and
    // handed to the code that needs them — exactly once each, never duplicated
    // and never re-fetched after the early promise is consumed.
    for (const url of ['/api/products', '/api/category-cards', '/api/reviews/featured']) {
      assert.equal(anonVisit.requests.filter(r => r.url === url).length, 1,
        `${url} must be requested exactly once per visit`);
    }
    assert.equal(typeof anonVisit.window.earlyFetch, 'function', 'the early-fetch helper is part of the bundle');
    assert.equal(anonVisit.window.eval("consumeEarlyFetch('/api/products')"), null,
      'a consumed early request is never handed out twice');

    const hintedVisit = page(storeHtml, '/', { browserCookies: true, cookies: ['kage.signed_in=1'] });
    windows.push(hintedVisit);
    await ready(hintedVisit.window);
    assert.equal(hintedVisit.requests.filter(r => r.url === '/api/customers/me').length, 1,
      'a browser carrying the hint still asks the server who it is');

    // Hint lost but session alive: clicking the account icon probes once, so a
    // signed-in shopper is never shown the sign-in form.
    hintedVisit.window.document.cookie = 'kage.signed_in=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    assert.equal(hintedVisit.window.hasCustomerSessionHint(), false, 'the hint is gone');
    hintedVisit.window.eval('currentCustomer = null');
    let forcedProbe = 0;
    hintedVisit.window.fetch = (url, options) => {
      if (String(url) === '/api/customers/me') forcedProbe++;
      return fetch(origin + url, options);
    };
    await hintedVisit.window.handleAccountClick();
    assert.equal(forcedProbe, 1, 'opening the account view forces exactly one /api/customers/me probe');
    console.log('✅ Session hint: anonymous visits skip /api/customers/me, hinted ones probe, account click self-heals');


    // ---------------------------------------------------------------
    // Scenario 19c: password-reset GUI — no prompt(), Enter submits, and
    // every "we sent you an email" message says to check spam.
    // ---------------------------------------------------------------
    {
      const resetPage = page(storeHtml, '/', {
        fetchImpl: (url, options) => {
          if (String(url).startsWith('/api/auth/forgot-password')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, message: 'If an account exists, a reset link has been sent.' }) });
          }
          if (String(url).startsWith('/api/customers/login')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ customer: { id: 1, email: 'clan@kage.test', name: 'Clan' } }) });
          }
          return fetch(origin + url, options);
        }
      });
      windows.push(resetPage);
      await ready(resetPage.window);
      const rd = resetPage.window.document, rw = resetPage.window;

      // The reset request is a real form inside the account modal.
      const resetForm = rd.getElementById('custResetView');
      assert.ok(resetForm && resetForm.tagName === 'FORM', 'the forgot-password view is a real <form>');
      assert.equal(resetForm.dataset.form, 'cust-reset-request', 'the form is routed by the delegated submit listener');
      assert.equal(rd.getElementById('custLoginView').tagName, 'FORM', 'the sign-in view is a real <form> (Enter signs in)');
      assert.equal(rd.getElementById('custSignupView').tagName, 'FORM', 'the sign-up view is a real <form>');
      const bundle = readFileSync(join(__dirname, '..', 'public', 'storefront.js'), 'utf8');
      assert.doesNotMatch(bundle, /prompt\(/, 'the reset request no longer opens a window.prompt()');

      // Opening it hides the other views and starts from the sign-in email.
      rw.openCustModal();
      rd.getElementById('custLoginEmail').value = 'clan@kage.test';
      rd.querySelector('#custLoginView [data-action="request-pw-reset"]').click();
      assert.equal(rd.getElementById('custResetView').classList.contains('is-hidden'), false, 'the reset view opens');
      assert.equal(rd.getElementById('custLoginView').classList.contains('is-hidden'), true, 'the sign-in view hides');
      assert.equal(rd.getElementById('custResetEmail').value, 'clan@kage.test', 'the typed email is carried into the reset form');

      // Submitting (what Enter does) posts, and the reply says to check spam.
      rd.getElementById('custResetEmail').value = 'clan@kage.test';
      rd.getElementById('custResetView').dispatchEvent(new rw.Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 40 && rd.getElementById('custResetMsg').hidden; i++) await wait(50);
      const sentNote = rd.getElementById('custResetMsg');
      assert.equal(sentNote.hidden, false, 'the reset view confirms the request in-page');
      assert.match(sentNote.textContent, /Reset link sent/i);
      assert.match(sentNote.textContent, /spam/i, 'the confirmation tells the shopper to check the spam folder');
      assert.match(sentNote.textContent, /clan@kage\.test/, 'the confirmation names the address it was sent to');

      // An empty address is refused locally, without a request.
      const emptyPage = page(storeHtml, '/', {
        fetchImpl: (url, options) => {
          if (String(url).startsWith('/api/auth/forgot-password')) return Promise.reject(new Error('must not be called'));
          return fetch(origin + url, options);
        }
      });
      windows.push(emptyPage);
      await ready(emptyPage.window);
      const ed = emptyPage.window.document;
      emptyPage.window.openCustModal();
      emptyPage.window.showCustReset();
      ed.getElementById('custResetView').dispatchEvent(new emptyPage.window.Event('submit', { bubbles: true, cancelable: true }));
      await wait(120);
      assert.equal(ed.getElementById('custResetError').style.display, 'block', 'an empty email is refused in the form');
      assert.match(ed.getElementById('custResetError').textContent, /email/i);

      // Enter in the sign-in form submits it (native form submission).
      const enterPage = page(storeHtml, '/', {
        fetchImpl: (url, options) => {
          if (String(url).startsWith('/api/customers/login')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ customer: { id: 1, email: 'clan@kage.test', name: 'Clan' } }) });
          }
          return fetch(origin + url, options);
        }
      });
      windows.push(enterPage);
      await ready(enterPage.window);
      const ed2 = enterPage.window.document;
      enterPage.window.openCustModal();
      ed2.getElementById('custLoginEmail').value = 'clan@kage.test';
      ed2.getElementById('custLoginPassword').value = 'password12345';
      ed2.getElementById('custLoginView').dispatchEvent(new enterPage.window.Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 40 && ed2.getElementById('custOverlay').classList.contains('open'); i++) await wait(50);
      assert.equal(ed2.getElementById('custOverlay').classList.contains('open'), false, 'submitting the sign-in form signs the shopper in');
      assert.ok(enterPage.window.eval('currentCustomer'), 'the signed-in customer is stored');

      // The account page's change-password card is a form too (Enter submits).
      assert.equal(rd.querySelector('[data-form="account-password"]').tagName, 'FORM', 'the change-password card is a form (Enter submits)');

      // Account-page email messages mention spam as well.
      assert.match(bundle, /Check your inbox and spam folder for the verification link/, 'the signup toast says to check spam');
      assert.match(bundle, /and the spam folder, just in case/, 'the resend-verification toast says to check spam');
      console.log('✅ Password-reset GUI: real forms (no prompt), Enter submits, confirmations say to check spam');
    }

    // ---------------------------------------------------------------
    // Admin sign-in: the login card is a form (Enter signs in), and its
    // forgot-password link opens an in-card reset GUI that says to check spam.
    // ---------------------------------------------------------------
    {
      const adminPage = page(adminHtml, '/admin', {
        fetchImpl: (url, options) => {
          if (String(url).includes('/api/admin/me')) return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
          if (String(url).startsWith('/api/auth/forgot-password')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, message: 'If an account exists, a reset link has been sent.' }) });
          }
          return fetch(origin + url, options);
        }
      });
      windows.push(adminPage);
      for (let i = 0; i < 40 && adminPage.window.document.getElementById('loginPage').style.display !== 'flex'; i++) await wait(50);
      const aw = adminPage.window, ad = aw.document;
      assert.equal(ad.getElementById('loginView').tagName, 'FORM', 'the admin sign-in card is a real <form> (Enter signs in)');
      assert.equal(ad.getElementById('loginView').dataset.form, 'admin-login', 'it is routed by the delegated submit listener');
      const adminBundle = readFileSync(join(__dirname, '..', 'public', 'admin.js'), 'utf8');
      assert.doesNotMatch(adminBundle, /prompt\(/, 'the admin reset request no longer opens a window.prompt()');
      assert.doesNotMatch(adminBundle, /keydown', \(e\) => \{\s*if \(e\.key === 'Enter'\) handleLogin\(\);/, 'the duplicate per-field Enter handlers are gone');

      // The reset view replaces the sign-in view inside the same card.
      aw.showResetView();
      assert.equal(ad.getElementById('loginResetView').classList.contains('admin-hide'), false, 'the reset view opens');
      assert.equal(ad.getElementById('loginView').classList.contains('admin-hide'), true, 'the sign-in view hides');

      ad.getElementById('loginResetEmail').value = 'admin@kage.test';
      ad.getElementById('loginResetView').dispatchEvent(new aw.Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 40 && ad.getElementById('loginResetMsg').hidden; i++) await wait(50);
      const adminNote = ad.getElementById('loginResetMsg');
      assert.equal(adminNote.hidden, false, 'the admin reset view confirms the request');
      assert.match(adminNote.textContent, /Reset link sent/i);
      assert.match(adminNote.textContent, /spam/i, 'the admin confirmation says to check spam');

      // Back to sign in, and Escape also leaves the reset view.
      ad.querySelector('#loginResetView [data-action="show-login"]').click();
      assert.equal(ad.getElementById('loginView').classList.contains('admin-hide'), false, 'the back link returns to sign-in');
      aw.showResetView();
      ad.dispatchEvent(new aw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(ad.getElementById('loginResetView').classList.contains('admin-hide'), true, 'Escape returns to the sign-in view');
      // ...but only from the reset view: Escape on the sign-in card changes nothing.
      ad.dispatchEvent(new aw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(ad.getElementById('loginView').classList.contains('admin-hide'), false, 'Escape on the sign-in view is ignored');
      console.log('✅ Admin sign-in: form submit (Enter), in-card reset GUI and a check-spam confirmation');
    }

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

    // The shop really has that order. F16: the lookup is a CSRF-protected
    // POST whose body carries number + phone.
    const trackCsrfResponse = await fetch(`${origin}/api/csrf`);
    const trackCookie = (trackCsrfResponse.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
    const trackToken = JSON.parse(await trackCsrfResponse.text()).token;
    const tracked = await fetch(`${origin}/api/orders/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: trackCookie, 'X-CSRF-Token': trackToken },
      body: JSON.stringify({ number: fd.getElementById('confNumber').textContent.trim(), phone: '03001234500' })
    });
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
    // The Category group mirrors the navbar's categories — nothing else.
    assert.deepStrictEqual([...drawerBody.querySelectorAll('.fp-cat')].map(cb => cb.value).sort(),
      ['anime', 'graphic-tees', 'pants'], 'the Category filter lists exactly the navbar categories');
    assert.deepStrictEqual([...drawerBody.querySelectorAll('.fp-cat')].map(cb => cb.parentElement.textContent.trim()).sort(),
      ['Anime Shirts', 'Graphic Tees', 'Pants'], 'the labels match the navbar labels');
    for (const stale of ['Anime-Inspired', 'Japanese Art', 'Typography']) {
      assert.equal(drawerBody.querySelector(`.fp-cat[value="${stale}"]`), null, `the removed "${stale}" style option is gone`);
    }
    assert.ok(drawerBody.querySelector('.price-min') && drawerBody.querySelector('.price-max'), 'price filter is in the drawer');
    assert.ok(drawerBody.querySelector('.fp-size'), 'size filter is in the drawer');
    // Category filter: keep only Anime Shirts and the grid narrows to that
    // category (the same field the navbar's /collection/anime filters on).
    for (const cb of drawerBody.querySelectorAll('.fp-cat')) {
      cb.checked = cb.value === 'anime';
      cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    assert.ok(w.eval('getFilteredProducts().length > 0 && getFilteredProducts().every(p => p.collection === "anime")'),
      'the drawer category filter narrows the grid to the checked category');
    assert.equal(d.querySelector('#filterSidebar .fp-cat[value="anime"]').checked, true,
      'drawer changes sync to the desktop filter panel');
    // Ticking every category is the unfiltered state again (no phantom narrowing).
    for (const cb of drawerBody.querySelectorAll('.fp-cat')) {
      cb.checked = true;
      cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    assert.equal(w.eval('getFilteredProducts().length'), w.eval('allProducts.filter(p => currentCollectionFilter === "all" || p.collection === currentCollectionFilter).length'),
      'ticking all categories shows the full catalog again');
    // Unticking every category must not empty the grid (it never did, and a
    // stray untick should not look like a broken catalog).
    for (const cb of drawerBody.querySelectorAll('.fp-cat')) {
      cb.checked = false;
      cb.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    assert.ok(w.eval('getFilteredProducts().length > 0'), 'no category ticked keeps the full list');
    assert.equal(d.getElementById('filterBadge').textContent, '0', 'no ticks means no active category filter');
    // The checkboxes follow the route, so the panel never misstates the grid.
    w.navigateTo('collection', 'pants');
    assert.deepStrictEqual([...d.querySelectorAll('#filterSidebar .fp-cat:checked')].map(cb => cb.value), ['pants'],
      'opening a category ticks that category in the panel');
    assert.equal(w.eval('categoryFiltersFollowRoute()'), true,
      'a category route is at its own default state, not a filtered one');
    assert.equal(d.getElementById('filterBadge').textContent, '0',
      'merely following a category route is not an active filter');
    w.navigateTo('collection', 'all');
    assert.equal(d.querySelectorAll('#filterSidebar .fp-cat:checked').length, 3,
      'the All page ticks every category again');
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
    // Three category ticks are all on, so only size + price are active here.
    assert.equal(d.getElementById('filterBadge').textContent, '2',
      'size + price count as the two active filters — ticked categories are not filters');
    // Apply closes the drawer; Reset restores everything.
    [...drawer.querySelectorAll('button')].find(b => b.textContent.trim() === 'Apply').click();
    assert.equal(drawer.classList.contains('open'), false, 'Apply closes the Filter drawer');
    w.resetFilters();
    assert.equal(d.getElementById('filterBadge').textContent, '0', 'Reset Filters clears every remaining filter');
    assert.ok(w.eval('getFilteredProducts().length > 0'), 'the full catalog returns after reset');
    console.log('✅ Filter drawer opens and its category/price/size filters still work');

    // ---- FE-M6: no micro-typography — every readable font-size is >= 10px.
    {
      const re = /font-size:\s*([0-9.]+)(rem|px|em)/g;
      const tiny = [];
      let m;
      while ((m = re.exec(storeHtml))) {
        const px = m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
        if (px < 10 - 1e-9) {
          // The filter-checkbox ::after checkmark is a decorative glyph inside
          // a checkbox, not readable text — the only allowed sub-10px size.
          const context = storeHtml.slice(Math.max(0, m.index - 300), m.index);
          if (!context.includes('.filter-checkbox input[type="checkbox"]:checked::after')) {
            const lineStart = storeHtml.lastIndexOf('\n', m.index);
            tiny.push(storeHtml.slice(lineStart + 1, m.index + m[0].length).trim());
          }
        }
      }
      assert.deepEqual(tiny, [], `micro-typography must stay fixed (all readable text >= 10px): ${tiny.join(' | ')}`);
      assert.match(storeHtml, /\.nav-icon \.badge \{[\s\S]*?font-size: 0\.625rem;/, 'nav badge text is 10px');
      assert.match(storeHtml, /\.cart-item-remove \{[^}]*font-size: 0\.7rem;/, 'cart Remove button is 11.2px');
      assert.match(storeHtml, /\.quick-add \{[\s\S]*?font-size: 0\.7rem;/, 'Quick View / Add to Cart button is 11.2px');
    }
    console.log('✅ FE-M6 micro-typography: every readable font-size is >= 10px');

    // ---- A11Y-3: screen-reader announcements for dynamic updates.
    {
      assert.match(storeHtml, /<div id="srAnnounce" class="sr-only" aria-live="polite"><\/div>/, 'hidden polite live region exists');
      assert.match(storeHtml, /\.sr-only \{[\s\S]*?clip: rect\(0,0,0,0\);/, '.sr-only clips to 1px');
      assert.match(storeHtml, /id="resultCount" aria-live="polite"/, 'result count is a live status');
      assert.match(storeHtml, /id="checkoutError"[^>]*role="alert"/, 'checkout errors are assertive');
      assert.match(storeHtml, /id="trkError"[^>]*role="alert"/, 'tracking errors are assertive');
      assert.match(storeHtml, /function announce\(msg\)/, 'announce() helper exists');

      const live = page(storeHtml, '/', { browserCookies: true }); windows.push(live);
      const lw = live.window, ld = lw.document;
      await ready(lw);
      const said = () => ld.getElementById('srAnnounce').textContent;
      assert.equal(said(), '', 'live region starts empty');

      lw.eval(`announce('Hello screen reader')`); await wait(80);
      assert.equal(said(), 'Hello screen reader', 'announce() publishes');
      lw.eval(`announce('Hello screen reader')`); await wait(80);
      assert.equal(said(), 'Hello screen reader', 'a repeated message still lands');

      lw.showToast('Mirror check'); await wait(80);
      assert.equal(said(), 'Mirror check', 'showToast mirrors into the live region');

      const pid = lw.eval(`(function () {
        const p = allProducts.find(x => x.in_stock && x.sizes && x.sizes.length
          && (x.stock_qty == null || Number(x.stock_qty) > 1)
          && (!x.size_stock || Number(x.size_stock[x.sizes[0]] || 0) > 1));
        return p ? p.id : null;
      })()`);
      assert.ok(pid, 'a product with 2+ units in stock must exist for the quantity checks');
      lw.toggleWishlist(pid); await wait(120);
      assert.match(said(), /Saved .* to favourites\./, 'saving announces');
      lw.toggleWishlist(pid); await wait(120);
      assert.match(said(), /Removed .* from favourites\./, 'unsaving announces');

      const added = lw.eval(`(function () { const p = allProducts.find(x => x.id === ${pid}); return addToCart(p, p.sizes[0], 1); })()`);
      assert.equal(added, true, 'in-stock product goes into the cart');
      await wait(120);
      assert.match(said(), /added to cart/, 'cart add announces');
      lw.eval('changeCartQty(0, 1)'); await wait(120);
      assert.match(said(), /quantity 2\./, 'quantity change announces');
      lw.eval('removeFromCart(0)'); await wait(120);
      assert.match(said(), /Removed .* from cart\./, 'cart removal announces');

      lw.navigateTo('collection', 'all');
      lw.onSearchInput('wolf');
      assert.equal(ld.getElementById('resultCount').getAttribute('aria-live'), 'polite');
      assert.match(ld.getElementById('resultCount').textContent, /\d+ results?/, 'filtering updates the live result count');
      lw.onSearchInput('zzz-no-such-product');
      assert.equal(ld.getElementById('resultCount').textContent, '0 results');
      lw.onSearchInput('');

      lw.eval(`(function () { const p = allProducts.find(x => x.id === ${pid}); return addToCart(p, p.sizes[0], 1); })()`);
      lw.navigateTo('checkout');
      ld.getElementById('coName').value = 'Live Region';
      ld.getElementById('coEmail').value = 'live.region@kage.test';
      ld.getElementById('coPhone').value = '03001234501';
      ld.getElementById('coAddress').value = '1 Live St';
      ld.getElementById('coCity').value = 'Lahore';
      await lw.eval('placeOrder()'); await wait(120);
      assert.match(said(), /^Order KAGE-[A-Z0-9]{8} placed\./, 'order placement announces the order number');
    }
    console.log('✅ A11Y-3 announcements: toast/wishlist/cart/filter/order updates reach screen readers');

    // ---- A11Y-4/FE-M5: route-change focus + dialog focus (jsdom part).
    {
      const focus = page(storeHtml, '/'); windows.push(focus);
      const fw = focus.window, fd = fw.document;
      await ready(fw);
      assert.equal(fd.activeElement, fd.body, 'boot leaves focus alone (skip link stays first)');
      for (let i = 0; i < 60 && !fw.eval('bootNavComplete'); i++) await wait(50);
      assert.equal(fw.eval('bootNavComplete'), true, 'boot routing completes');
      assert.equal(fd.activeElement, fd.body, 'async boot restore still leaves focus alone');

      fw.navigateTo('contact');
      assert.equal(fd.activeElement, fd.getElementById('mainContent'), 'route change moves focus to main');

      fw.navigateTo('account');
      assert.ok(fd.getElementById('custOverlay').classList.contains('open'), 'logged-out account opens the login modal');
      await wait(120);
      assert.equal(fd.activeElement, fd.getElementById('custLoginEmail'), 'modal takes focus to its email field');
      fw.closeCustModal();
      assert.equal(fd.activeElement, fd.getElementById('mainContent'), 'closing the modal restores the previous focus');

      const pid = fw.eval('allProducts.find(p => p.in_stock).id');
      fw.openProductDetail(pid);
      assert.equal(fd.activeElement, fd.getElementById('mainContent'), 'product route moves focus to main');
      const galleryOpener = fd.getElementById('detailMainImage');
      galleryOpener.focus();
      fw.openImageZoom();
      assert.equal(fd.activeElement, fd.querySelector('#imageZoomOverlay .zoom-close'), 'zoom moves focus to its close button');
      fw.closeImageZoom();
      assert.equal(fd.activeElement, galleryOpener, 'closing zoom restores focus to the gallery');
    }
    console.log('✅ A11Y-4 route/dialog focus: main on route change, modal + zoom focus in and back');

    // ---- A11Y-4/FE-M5: Tab-wrap trapping (real Chromium — jsdom has no layout,
    // so the visibility filter would hide every control there).
    {
      const { launchChromium: launchTrap, waitForCatalog: waitTrapCatalog } = require('./fixtures/chromium');
      const trapBrowser = await launchTrap();
      try {
        const tp = await trapBrowser.newPage();
        await tp.setViewport({ width: 390, height: 844 });
        await tp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitTrapCatalog(tp);
        await tp.waitForFunction(() => { try { return eval('bootNavComplete') === true; } catch (e) { return false; } });
        const FOCUS_SEL = 'a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';

        const quickAdded = await tp.evaluate(() => {
          const p = allProducts.find(x => x.in_stock && x.sizes && x.sizes.length && (x.stock_qty == null || Number(x.stock_qty) > 0));
          if (!p) return false;
          quickAdd(p.id);
          return true;
        });
        assert.equal(quickAdded, true, 'a buyable product must exist for the drawer trap check');
        await tp.waitForFunction(() => document.getElementById('cartDrawer').classList.contains('open'));
        await tp.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('cart-close'));
        const wrapFwd = await tp.evaluate((sel) => {
          const box = document.getElementById('cartDrawer');
          const items = [...box.querySelectorAll(sel)].filter(el => el.getClientRects().length);
          items[items.length - 1].focus();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
          return { ok: document.activeElement === items[0], n: items.length };
        }, FOCUS_SEL);
        assert.ok(wrapFwd.n > 1, 'drawer has multiple focusable controls');
        assert.equal(wrapFwd.ok, true, 'Tab on the last drawer control wraps to the first');
        const wrapBack = await tp.evaluate((sel) => {
          const box = document.getElementById('cartDrawer');
          const items = [...box.querySelectorAll(sel)].filter(el => el.getClientRects().length);
          items[0].focus();
          const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'shiftKey', { value: true });
          document.dispatchEvent(ev);
          return document.activeElement === items[items.length - 1];
        }, FOCUS_SEL);
        assert.equal(wrapBack, true, 'Shift+Tab on the first drawer control wraps to the last');
        // Focus parked outside a modal overlay is pulled back inside on Tab.
        const pullIn = await tp.evaluate((sel) => {
          const box = document.getElementById('cartDrawer');
          const items = [...box.querySelectorAll(sel)].filter(el => el.getClientRects().length);
          document.activeElement.blur();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
          return document.activeElement === items[0];
        }, FOCUS_SEL);
        assert.equal(pullIn, true, 'Tab from outside the drawer lands on its first control');
        await tp.keyboard.press('Escape');
        await tp.waitForFunction(() => !document.getElementById('cartDrawer').classList.contains('open'));

        // Mobile menu: trapped while open, Escape returns focus to the hamburger.
        await tp.evaluate(() => document.getElementById('hamburger').focus());
        await tp.keyboard.press('Enter');
        await tp.waitForFunction(() => document.getElementById('navLinks').classList.contains('open'));
        const menuWrap = await tp.evaluate((sel) => {
          const box = document.getElementById('navLinks');
          const items = [...box.querySelectorAll(sel)].filter(el => el.getClientRects().length);
          items[items.length - 1].focus();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
          return { ok: document.activeElement === items[0], n: items.length };
        }, FOCUS_SEL);
        assert.ok(menuWrap.n > 1, 'menu has multiple focusable links');
        assert.equal(menuWrap.ok, true, 'Tab on the last menu link wraps to the first');
        await tp.keyboard.press('Escape');
        await tp.waitForFunction(() => !document.getElementById('navLinks').classList.contains('open'));
        const menuFocusBack = await tp.evaluate(() => document.activeElement.id === 'hamburger');
        assert.equal(menuFocusBack, true, 'Escape on the menu returns focus to the hamburger');

        // Zoom view: Tab stays inside, Escape restores focus to the gallery.
        await tp.goto(origin + '/product/1', { waitUntil: 'domcontentloaded' });
        await waitTrapCatalog(tp);
        await tp.waitForSelector('#page-product.active', { timeout: 20000 });
        await tp.evaluate(() => { document.getElementById('detailMainImage').focus(); openImageZoom(); });
        const zoomIn = await tp.evaluate(() => document.activeElement.classList.contains('zoom-close'));
        assert.equal(zoomIn, true, 'zoom moves focus to its close button');
        await tp.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
        const zoomStay = await tp.evaluate(() => document.activeElement.classList.contains('zoom-close'));
        assert.equal(zoomStay, true, 'Tab stays inside the zoom view');
        await tp.keyboard.press('Escape');
        await tp.waitForFunction(() => document.getElementById('imageZoomOverlay').hidden);
        const zoomBack = await tp.evaluate(() => document.activeElement.id === 'detailMainImage');
        assert.equal(zoomBack, true, 'closing zoom restores focus to the gallery');
      } finally {
        await trapBrowser.close();
      }
    }
    console.log('✅ A11Y-4 Tab traps: drawer wraps both ways, menu + zoom trap and restore focus');

    // ---- SEO-4 client: SPA navigations keep social meta in sync.
    {
      const seo = page(storeHtml, '/'); windows.push(seo);
      const sw = seo.window, sd = sw.document;
      await ready(sw);
      const meta = (attr, key) => sd.querySelector(`meta[${attr}="${key}"]`).content;
      // Homepage restore copy must match the served shell head.
      assert.equal(sd.title, sw.eval('HOME_SOCIAL_META.title'), 'restore title matches the shell');
      assert.equal(meta('name', 'description'), sw.eval('HOME_SOCIAL_META.description'), 'restore description matches the shell');
      assert.equal(meta('property', 'og:image:alt'), sw.eval('HOME_SOCIAL_META.imageAlt'), 'restore image alt matches the shell');
      assert.equal(sw.eval('defaultSocialImage()'), sw.location.origin + '/images/og-image.jpg', 'default social image is the absolute og-image');
      assert.match(storeHtml, /__SITE_URL__\/images\/og-image\.jpg/, 'shell og:image uses the site-url placeholder');

      const pid = sw.eval('allProducts.find(p => p.in_stock).id');
      const pname = sw.eval(`allProducts.find(p => p.id === ${pid}).name`);
      sw.openProductDetail(pid);
      assert.equal(sd.title, `${pname} | KAGE CULTURE`);
      assert.equal(meta('property', 'og:title'), `${pname} | KAGE CULTURE`, 'product og:title follows the route');
      assert.equal(meta('name', 'twitter:title'), `${pname} | KAGE CULTURE`);
      assert.match(meta('property', 'og:image'), /^https?:\/\//, 'product og:image is absolute');
      assert.equal(meta('property', 'og:type'), 'product');
      assert.ok(meta('name', 'description').length > 0 && meta('name', 'description').length <= 155, 'product description is snippet-length');
      assert.equal(meta('name', 'description'), meta('property', 'og:description'), 'description tags agree');
      assert.equal(meta('name', 'twitter:description'), meta('property', 'og:description'));

      sw.navigateTo('collection', 'anime');
      assert.equal(meta('property', 'og:title'), 'Anime Shirts | KAGE CULTURE');
      assert.equal(meta('name', 'description'), 'Shop anime-inspired shirts with original artwork, premium cotton, and everyday streetwear fits.');
      assert.equal(meta('property', 'og:type'), 'website');
      assert.match(meta('property', 'og:image'), /^https?:\/\//);

      sw.navigateTo('contact');
      assert.equal(meta('property', 'og:title'), sw.eval('HOME_SOCIAL_META.title'), 'content pages restore the homepage social title');
      assert.equal(meta('name', 'description'), sw.eval('HOME_SOCIAL_META.description'));
      assert.equal(meta('property', 'og:type'), 'website');

      sw.navigateTo('home');
      assert.equal(meta('property', 'og:title'), sw.eval('HOME_SOCIAL_META.title'), 'home restores the homepage social title');
      assert.equal(meta('property', 'og:image'), sw.eval('defaultSocialImage()'));

      // Let the product view's async review fetch settle before teardown:
      // closing the window with it in flight throws on the dead jsdom global.
      for (let i = 0; i < 60 && !sd.getElementById('reviewsList').textContent.trim(); i++) await wait(50);
      assert.ok(sd.getElementById('reviewsList').textContent.trim(), 'reviews settle before teardown');
    }
    console.log('✅ SEO-4 client: product/collection navigations sync social tags, home restores them');

    // ---- CONTENT-2 UI: subscribing surfaces the private unsubscribe link.
    {
      const nl = page(storeHtml, '/', { browserCookies: true }); windows.push(nl);
      const nw = nl.window, nd = nw.document;
      await ready(nw);
      const nlForm = nd.querySelector('.newsletter-form');
      nlForm.querySelector('input[type=email]').value = 'footer.link@kage.test';
      await nw.subscribeNewsletter({ preventDefault() {}, target: nlForm });
      const nlMsg = nlForm.parentElement.querySelector('.newsletter-msg');
      assert.match(nlMsg.textContent, /Welcome to the clan/i);
      const manageLink = nlMsg.querySelector('a[href^="/newsletter/unsubscribe?token="]');
      assert.ok(manageLink, 'subscribe success shows the private unsubscribe link');
      assert.match(manageLink.getAttribute('href'), /token=[0-9a-f]{48}$/);
    }
    console.log('✅ CONTENT-2 UI: the private unsubscribe link appears after subscribing');

    // ---- FE-H2: delegated clicks work in real Chromium under script-src-attr 'none'.
    {
      const { launchChromium: launchDel, waitForCatalog: waitDelCatalog } = require('./fixtures/chromium');
      const delBrowser = await launchDel();
      try {
        const dp = await delBrowser.newPage();
        await dp.setViewport({ width: 1280, height: 800 });
        await dp.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitDelCatalog(dp);
        await dp.waitForFunction(() => { try { return eval('bootNavComplete') === true; } catch (e) { return false; } });
        // The links live in the hamburger panel, so open it before clicking.
        await dp.click('#hamburger');
        await dp.waitForSelector('#navLinks.open');
        await dp.click('#navLinks a[data-route="contact"]');
        await dp.waitForFunction(() => document.getElementById('page-contact').classList.contains('active'));
        assert.match(dp.url(), /\/contact$/, 'delegated nav link routes in real Chromium');
        await dp.click('.kage-logo');
        await dp.waitForFunction(() => document.getElementById('page-home').classList.contains('active'));
        await dp.click('.product-card[data-action="open-product"]');
        await dp.waitForSelector('#page-product.active', { timeout: 20000 });
        assert.match(dp.url(), /\/product\/\d+/, 'delegated card click opens the detail view');
      } finally {
        await delBrowser.close();
      }
    }
    console.log('✅ FE-H2 delegation: nav + card clicks work in real Chromium under the locked CSP');

    assert.deepEqual(errors, []);
    // console.log('✅') packets were counted by the wrapper installed above.
    console.log(`\n${scenarioCount} frontend scenarios passed`);
  } finally {
    windows.forEach(win => win.window.close());
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
