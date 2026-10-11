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
      // jsdom lacks object URLs, which the admin upload previews use.
      let objectUrlSeq = 0;
      w.URL.createObjectURL = () => 'blob:mock-object-url-' + (++objectUrlSeq);
      w.URL.revokeObjectURL = () => {};
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
    try {
      w.fetch = (url, options) => {
        if (url === '/api/reviews' && options?.method === 'POST') {
          sentReviews.push(JSON.parse(options.body));
          return Promise.resolve({ ok: true, json: async () => ({ message: 'Review pending approval.' }) });
        }
        return originalStoreFetch(url, options);
      };
      for (let rating = 1; rating <= 5; rating++) {
        // Native button click also covers keyboard activation (Enter/Space).
        starButtons[rating - 1].click();
        assert.equal(starButtons.filter(b => b.classList.contains('selected')).length, rating);
        assert.deepEqual(starButtons.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => Number(b.dataset.v)), [rating]);
        d.getElementById('rvOrder').value = 'KAGE-REVIEW';
        d.getElementById('rvPhone').value = '03001234567';
        await w.submitReview({ preventDefault() {}, target: reviewForm });
        assert.equal(sentReviews.at(-1).rating, rating, 'submitted rating must match clicked star');
        assert.equal(sentReviews.at(-1).product_id, 1);
        assert.equal(starButtons.some(b => b.classList.contains('selected') || b.getAttribute('aria-pressed') === 'true'), false, 'successful submit clears stars');
        assert.match(d.getElementById('rvError').textContent, /pending approval/);
      }
      starButtons[4].click();
      w.openProductDetail(2);
      assert.equal(starButtons.some(b => b.classList.contains('selected') || b.getAttribute('aria-pressed') === 'true'), false, 'switching product clears draft rating');
      const count = sentReviews.length;
      await w.submitReview({ preventDefault() {}, target: reviewForm });
      assert.equal(sentReviews.length, count, 'cannot submit without a rating');
      assert.match(d.getElementById('rvError').textContent, /select a star rating/);
    } finally {
      w.fetch = originalStoreFetch;
    }
    console.log('✅ Review stars 1–5 send the chosen rating; reset and product switching clear the picker');

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

    // Admin form: sizes chips and per-size counts are sent as one payload.
    aw.eval('products = ' + JSON.stringify(await (await fetch(origin + '/api/products')).json()) + '; filterProducts()');
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
    console.log('\n12/12 frontend scenarios passed');
  } finally {
    windows.forEach(win => win.window.close());
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
