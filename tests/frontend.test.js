// DOM-level interaction regressions for the static storefront and admin panel.
// Run with `npm test` (jsdom is a dev dependency; no browser download required).
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
let origin;
function page(html, path = '/', { storage = {}, offline = false } = {}) {
  return new JSDOM(html, {
    url: origin + path, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
      w.fetch = (url, options) => {
        if (offline && url === '/api/products') return Promise.reject(new Error('offline'));
        return fetch(origin + url, options);
      };
    }
  });
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
    const store = page(storeHtml); windows.push(store);
    const w = store.window, d = w.document;
    await ready(w);
    w.navigateTo('collection', 'goofy-wears');
    assert.equal(d.querySelector('#collectionTitle').textContent, 'GOOFY WEARS');
    assert.equal(d.querySelector('#resultCount').textContent, '10 results');
    assert.ok([...d.querySelectorAll('#collectionGrid .product-card h3')].every(x =>
      ['Melting', 'Robo Bro', 'All-Seeing Eye', 'Cheese God', 'Duck Off', 'Banana Flex', 'Alien Sightings', 'Pizza Lover', 'Frog Energy', 'Skeleton Vibes'].includes(x.textContent)));
    assert.equal(d.querySelector('#collectionGrid .quick-add:disabled') !== null, true);
    w.quickAdd(14); // Melting has zero stock.
    assert.equal(w.eval('cart.length'), 0);
    console.log('✅ Goofy Wears filters correctly; sold-out items cannot be added');

    w.navigateTo('home');
    w.nextPage();
    const size = d.querySelector('#filterSidebar .fp-size');
    size.value = 'XL';
    size.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(d.querySelector('#pageInfo').textContent, 'Page 1 of 1');
    assert.ok(d.querySelector('#collectionGrid .product-card'));
    assert.ok(w.eval('renderHomeProductCard(allProducts.find(p => p.name === "Wrath Silhouette"))').includes('class="product-discount-badge"'));
    console.log('✅ Filters clamp pagination; homepage sale badge is displayed');

    w.quickAdd(20);
    w.toggleWishlist(20);
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

    w.openProductDetail(20);
    assert.equal(w.location.pathname, '/product/20');
    w.navigateTo('tracking');
    assert.equal(w.location.pathname, '/tracking');
    w.history.back();
    await wait(100);
    assert.equal(d.querySelector('#page-product').classList.contains('active'), true);
    const deepLink = page(storeHtml, '/product/20'); windows.push(deepLink);
    await ready(deepLink.window);
    await wait(100);
    assert.equal(deepLink.window.document.querySelector('#detailName').textContent, 'Cheese God');
    assert.equal(deepLink.window.document.querySelector('.hero-media img').getAttribute('src'), '/images/hero.jpg');
    console.log('✅ Product deep links, media, and browser Back work');

    const bad = await fetch(origin + '/does-not-exist');
    assert.equal(bad.status, 404);
    const offline = page(storeHtml, '/', { offline: true }); windows.push(offline);
    await ready(offline.window);
    assert.equal(offline.window.document.getElementById('productLoadError').hidden, false);
    assert.equal(offline.window.document.querySelectorAll('#collectionGrid .product-card').length, 0);
    console.log('✅ Unknown paths return 404; catalog outages show a warning, not fake products');

    const admin = page(adminHtml, '/admin'); windows.push(admin);
    await wait(100);
    const aw = admin.window, ad = aw.document;
    const products = await (await fetch(origin + '/api/products')).json();
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

    const originalAdminFetch = aw.fetch;
    let quickUploadBody = null;
    try {
      aw.eval('quickImageBlob = new Blob(["mock image"], { type: "image/webp" }); quickImageName = "quantity-test.webp"');
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

    // The menu toggle must remain operable, and hidden admin tabs must stay
    // inside the main column (not become siblings in the dashboard flex row).
    d.getElementById('hamburger').click();
    assert.equal(d.getElementById('navLinks').classList.contains('open'), true);
    assert.equal(d.getElementById('hamburger').getAttribute('aria-expanded'), 'true');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(d.getElementById('navLinks').classList.contains('open'), false);
    assert.match(storeHtml, /\.cart-drawer\.open \{ transform: translateX\(0\); \}/);
    assert.match(storeHtml, /\.filter-drawer\.open \{ transform: translateX\(0\); \}/);
    for (const section of ['products', 'orders', 'reports', 'add']) {
      assert.equal(ad.getElementById('tab-' + section).parentElement.className, 'main-content');
    }
    aw.switchSection('reports');
    assert.equal(ad.getElementById('mobileAdminSection').value, 'reports');
    assert.equal(ad.getElementById('tab-reports').classList.contains('active'), true);
    console.log('✅ Mobile navigation and admin tab layout stay reachable');

    assert.deepEqual(errors, []);
    console.log('\n10/10 frontend scenarios passed');
  } finally {
    windows.forEach(win => win.window.close());
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
