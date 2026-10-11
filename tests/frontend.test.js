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
          reviewGets.push(String(url));
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
      assert.match(reviewGets.at(-1), /viewer_token=[a-f0-9]{48}/, 'the refetch carries the viewer token');
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
    w.eval('allProducts.push({ id: 999001, name: "Gallery Probe", price: 100, original_price: 100, fit: "Regular", collection: "anime", collections: [], style: [], rating: null, variants: null, desc: "", sizes: ["L"], images: ["/uploads/probe-front.webp", "/uploads/probe-back.webp"], in_stock: true, on_sale: false, sale_price: null, created_at: null, order_count: 0, stock_qty: 5, size_stock: null, sold_count: 0, avg_rating: null, review_count: 0 })');
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
    // Static CSS contracts: urgency separator, back link, gutters, footer.
    assert.match(storeHtml, /\.urgency-sold:not\(:first-child\)::before \{ content: '· '; \}/, 'sold-count dot only after another urgency item');
    assert.match(storeHtml, /\.detail-info \.back-link \{[\s\S]*?font-size: 14px;[\s\S]*?min-height: 44px;/, 'back link is 14px with a 44px tap height');
    assert.match(storeHtml, /@media \(max-width: 1024px\) \{\s*\.container \{ padding-left: 24px; padding-right: 24px; \}/, '24px gutters at 769–1024px');
    assert.match(storeHtml, /@media \(max-width: 768px\) \{\s*\.container \{ padding-left: 16px; padding-right: 16px; \}/, '16px gutters at ≤768px');
    assert.match(storeHtml, /\.product-detail-page \{ max-width: var\(--max-width\); margin-left: auto; margin-right: auto; \}/, 'product page capped at 1280px, centred');
    assert.match(storeHtml, /@media \(min-width: 481px\) \{\s*\.site-footer \{ padding-bottom: 80px; \}/, '80px footer bottom padding above 480px');
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
    console.log('\n15/15 frontend scenarios passed');
  } finally {
    windows.forEach(win => win.window.close());
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
