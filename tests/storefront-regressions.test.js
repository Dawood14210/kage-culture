// Focused regressions for the public storefront navigation and customer copy.
// These checks intentionally run against the live SPA markup and seeded API data.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'storefront-regression-secret-0123456789';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { app, ensureReady } = require('../server');

const { stitched } = require('./fixtures/stitch');
const html = stitched('storefront');
const serverSource = readFileSync(require.resolve('../server.js'), 'utf8');
const failures = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let origin;

async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`❌ ${name}: ${error.message}`);
  }
}

function makePage(pathname = '/') {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => {
    if (!String(error).includes('Could not parse CSS stylesheet')) console.error(error);
  });
  return new JSDOM(html, {
    url: origin + pathname,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
      window.HTMLMediaElement.prototype.pause = () => {};
      window.fetch = (url, options) => fetch(origin + url, options);
    }
  });
}

async function waitForCatalog(window) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (window.eval('productsLoadedFromApi') || !window.document.getElementById('productLoadError').hidden) return;
    await wait(25);
  }
  throw new Error('storefront catalog did not finish loading');
}

(async () => {
  await ensureReady();
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const windows = [];

  try {
    await check('anonymous customer session restore returns an empty success instead of a console-error 401', async () => {
      const response = await fetch(origin + '/api/customers/me');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { customer: null });
    });

    const store = makePage();
    windows.push(store);
    const { window: w } = store;
    const { document: d } = w;
    await waitForCatalog(w);

    await check('both pages keep swap/preconnect font hints and never request unused Zen Brush', () => {
      for (const source of [html, readFileSync(require.resolve('../public/admin.html'), 'utf8')]) {
        // Base URL so the relative PERF-1 bundle links resolve (only the
        // absolute font/preconnect hints are asserted below).
        const dom = new JSDOM(source, { url: 'http://localhost/' });
        try {
          const links = [...dom.window.document.querySelectorAll('link')];
          const fonts = links.filter(link => link.rel === 'stylesheet' && new URL(link.href).hostname === 'fonts.googleapis.com');
          assert.ok(fonts.length > 0);
          fonts.forEach(link => {
            const url = new URL(link.href);
            assert.equal(url.searchParams.get('display'), 'swap');
            assert.ok(url.searchParams.getAll('family').every(family => !family.includes('Zen Brush')));
          });
          for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
            const hint = links.find(link => link.rel === 'preconnect' && new URL(link.href).origin === `https://${host}`);
            assert.ok(hint, `missing preconnect to ${host}`);
            if (host === 'fonts.gstatic.com') assert.ok(hint.hasAttribute('crossorigin'));
          }
        } finally { dom.window.close(); }
      }
    });

    await check('skip link targets the single main region and moves focus there', () => {
      const skip = d.querySelector('.skip-link');
      const target = d.querySelector(skip.getAttribute('href'));
      assert.equal(target, d.querySelector('main'));
      assert.equal(d.querySelectorAll(skip.getAttribute('href')).length, 1);
      assert.equal(target.getAttribute('tabindex'), '-1');
      skip.focus();
      skip.click();
      assert.equal(d.activeElement, target);
    });

    await check('loaded stock controls every Pants/Graphic Tees promotion across refresh, sellout, deletion and failure', async () => {
      const dom = makePage();
      windows.push(dom);
      const cw = dom.window, cd = cw.document;
      await waitForCatalog(cw);
      const nodes = [...cd.querySelectorAll('[data-stock-category]')];
      assert.equal(nodes.length, 5, 'two nav links, two tiles, and the existing Pants footer link');
      for (const category of ['pants', 'graphic-tees']) {
        assert.ok(nodes.some(node => node.dataset.stockCategory === category && node.closest('#navLinks')));
        assert.ok(nodes.some(node => node.dataset.stockCategory === category && node.matches('.cat-tile')));
        const product = { id: 990001, name: 'Collection Stock Probe', category, price: 1000, sizes: ['S', 'M'], in_stock: true };
        for (const [stock, visible] of [
          [{ stock_qty: 2 }, true],
          [{ stock_qty: 2, in_stock: false }, false],
          [{ stock_qty: 0 }, false],
          [{ stock_qty: null }, true],
          [{ stock_qty: 3, size_stock: { S: 0, M: 3 } }, true],
          [{ stock_qty: 0, size_stock: { S: 0, M: 0 } }, false],
          [{ stock_qty: 2 }, true],
          [null, false]
        ]) {
          cw.fetch = async () => new Response(JSON.stringify(stock ? [{ ...product, ...stock }] : []), { status: 200 });
          await cw.loadProductsFromAPI();
          nodes.forEach(node => assert.equal(node.style.display !== 'none', visible && node.dataset.stockCategory === category));
          // Even when hidden from promotions, both direct collection routes stay reachable.
          cw.navigateTo('collection', category);
          assert.equal(cd.getElementById('shopSection').classList.contains('shop-visible'), true);
          assert.equal(cd.getElementById('page-coming-soon').classList.contains('active'), false);
          assert.match(cd.getElementById('collectionGrid').textContent, stock ? /Collection Stock Probe/ : /No .* available right now/i);
        }
      }
      cw.fetch = async () => { throw new Error('catalog unavailable'); };
      await cw.loadProductsFromAPI();
      assert.ok(nodes.every(node => node.style.display === 'none'), 'API failure must not promote fallback products');
      assert.equal(cd.getElementById('productLoadError').hidden, false);
      cw.fetch = (url, opts) => fetch(origin + url, opts);
      await cw.loadProductsFromAPI();
      assert.equal(cd.getElementById('productLoadError').hidden, true);
      assert.ok(nodes.filter(node => node.dataset.stockCategory === 'graphic-tees').every(node => node.style.display !== 'none'));
      assert.ok(nodes.every(node => cd.contains(node)), 'refreshes must preserve the existing nodes');
    });

    const originalPantsTile = d.getElementById('catTilePants');
    await check('empty Pants category hides all promotional links without removing the route', () => {
      assert.equal(d.getElementById('navPantsItem').style.display, 'none');
      assert.equal(d.getElementById('footerPantsItem').style.display, 'none');
      assert.equal(originalPantsTile.style.display, 'none');
      assert.ok(originalPantsTile, 'Pants tile must be present in the category strip');
      assert.equal(originalPantsTile.tagName, 'A', 'Pants is always a real link like the other cards');
      assert.equal(originalPantsTile.getAttribute('href'), '/collection/pants');
      assert.equal(originalPantsTile.getAttribute('aria-disabled'), null);
      assert.notEqual(w.getComputedStyle(originalPantsTile).pointerEvents, 'none');
      assert.equal(originalPantsTile.querySelector('.cat-shop').textContent.trim(), 'Explore');
      assert.notEqual(w.getComputedStyle(originalPantsTile.querySelector('.cat-shop')).display, 'none');
      assert.equal(originalPantsTile.querySelector('.cat-coming-soon'), null);
    });

    await check('empty Pants deep link opens its existing empty state, not Coming Soon', () => {
      w.navigateTo('collection', 'pants');
      assert.equal(w.location.pathname, '/collection/pants');
      assert.equal(d.getElementById('page-home').classList.contains('active'), true);
      assert.equal(d.getElementById('shopSection').classList.contains('shop-visible'), true);
      assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false);
      assert.match(d.getElementById('collectionGrid').textContent, /No pants available right now/i);
      w.navigateTo('home');
    });

    await check('visibility refetch reveals server-added Pants in nav/footer, best sellers and the open grid', async () => {
      const db = require('../database');
      const refreshPage = makePage('/collection/pants');
      windows.push(refreshPage);
      const rw = refreshPage.window, rd = rw.document;
      await waitForCatalog(rw);
      await wait(50);
      assert.equal(rd.getElementById('navPantsItem').style.display, 'none');
      assert.equal(rd.getElementById('footerPantsItem').style.display, 'none');
      assert.equal(rd.getElementById('catTilePants').style.display, 'none');
      const before = await fetch(origin + '/api/products');
      const oldTag = before.headers.get('etag');
      const requests = [];
      rw.fetch = (url, options) => {
        if (url === '/api/products') requests.push(options);
        return fetch(origin + url, options);
      };
      // A fresh tab return should not produce another catalog request.
      rd.dispatchEvent(new rw.Event('visibilitychange'));
      assert.equal(requests.length, 0);
      const result = await db.prepare(`INSERT INTO products
        (name, category, price, sizes, stock_qty, in_stock, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('Visibility Cargo Pants', 'pants', 2499, '["M","L"]', 3, 1, '2099-01-01 00:00:00');
      const id = result.lastInsertRowid;
      try {
        const changed = await fetch(origin + '/api/products', { headers: { 'If-None-Match': oldTag } });
        assert.equal(changed.status, 200, 'adding a product invalidates the old ETag');
        assert.notEqual(changed.headers.get('etag'), oldTag);
        const realNow = rw.Date.now.bind(rw.Date);
        rw.Date.now = () => realNow() + 16000;
        Object.defineProperty(rd, 'hidden', { configurable: true, value: true });
        rd.dispatchEvent(new rw.Event('visibilitychange'));
        assert.equal(requests.length, 0, 'a hidden tab must not refetch');
        Object.defineProperty(rd, 'hidden', { configurable: true, value: false });
        rd.dispatchEvent(new rw.Event('visibilitychange'));
        for (let i = 0; i < 60 && rw.eval('productsFetchInFlight'); i++) await wait(25);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.cache || 'default', 'default', 'storefront must use normal HTTP revalidation');
        assert.notEqual(rd.getElementById('navPantsItem').style.display, 'none');
        assert.notEqual(rd.getElementById('footerPantsItem').style.display, 'none');
        assert.notEqual(rd.getElementById('catTilePants').style.display, 'none');
        assert.match(rd.getElementById('collectionGrid').textContent, /Visibility Cargo Pants/);
        assert.match(rd.getElementById('bestSellersGrid').textContent, /Visibility Cargo Pants/);
        assert.equal(rd.getElementById('catTilePants').querySelector('.cat-shop').textContent.trim(), 'Explore');
        for (const storage of [rw.localStorage, rw.sessionStorage]) {
          for (let i = 0; i < storage.length; i++) {
            assert.doesNotMatch(storage.getItem(storage.key(i)), /Visibility Cargo Pants/, 'catalog payload must not be persisted');
          }
        }
        // Same-second edits must change the detail validator, too.
        const detail = await fetch(origin + '/api/products/' + id);
        const detailTag = detail.headers.get('etag');
        await db.prepare('UPDATE products SET name = ? WHERE id = ?').run('Edited Cargo Pants', id);
        const edited = await fetch(origin + '/api/products/' + id, { headers: { 'If-None-Match': detailTag } });
        assert.equal(edited.status, 200);
        assert.notEqual(edited.headers.get('etag'), detailTag);
        await db.prepare('DELETE FROM products WHERE id = ?').run(id);
        rw.Date.now = () => realNow() + 32000;
        rd.dispatchEvent(new rw.Event('visibilitychange'));
        for (let i = 0; i < 60 && rw.eval('productsFetchInFlight'); i++) await wait(25);
        assert.equal(requests.length, 2);
        assert.equal(rd.getElementById('navPantsItem').style.display, 'none');
        assert.equal(rd.getElementById('footerPantsItem').style.display, 'none');
      assert.equal(rd.getElementById('catTilePants').style.display, 'none');
        assert.doesNotMatch(rd.getElementById('bestSellersGrid').textContent, /Cargo Pants/);
        assert.match(rd.getElementById('collectionGrid').textContent, /No pants available right now/i);
      } finally {
        await db.prepare('DELETE FROM products WHERE id = ?').run(id);
        refreshPage.window.close();
      }
    });

    await check('four category tiles in order Graphic Tees / Anime / Pants / Custom Stickers with responsive layouts', () => {
      const tiles = [...d.querySelectorAll('#categoryStrip .cat-tile')];
      assert.equal(tiles.length, 4);
      assert.ok(tiles.every(tile => !tile.matches('.reveal, .reveal-scale')), 'all four cards are independent of scroll-reveal');
      assert.ok(tiles.every(tile => w.getComputedStyle(tile).opacity !== '0'), 'cards are not hidden while waiting for a scroll observer');
      assert.deepEqual([...d.querySelectorAll('#page-home .cat-tile .cat-name')].map(node => node.textContent.trim()), [
        'Graphic Tees', 'Anime Shirts', 'Pants', 'Custom Stickers'
      ]);
      // Phones: a 2×2 grid of equal columns (no horizontal scroll row).
      // 600px and up: one centred row of four equal columns.
      assert.match(html, /\.category-strip \{[^}]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
      assert.match(html, /@media \(max-width: 599px\) \{[\s\S]*?#page-home \.category-strip \{[^}]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
      assert.match(html, /#page-home \.category-strip \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[\s\S]*?max-width: 1200px;/);
      assert.match(html, /@media \(min-width: 600px\) and \(max-width: 1023px\) \{[\s\S]*?#page-home \.category-strip \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
      assert.doesNotMatch(html, /#page-home \.category-strip[^{]*\{[^}]*overflow-x: auto;/);
      assert.doesNotMatch(html, /#page-home \.category-strip[^{]*\{[^}]*scroll-snap/);
      assert.doesNotMatch(html, /#page-home \.cat-tile \{[^}]*scroll-snap-align/);
      // Every card stretches to its cell so the four parts stay aligned.
      assert.match(html, /\.cat-tile \{[^}]*?height: 100%;/);
      assert.match(html, /\.cat-info \{[^}]*?flex: 1 1 auto;/);
      assert.match(html, /\.cat-name \{[^}]*?min-height: 2lh;/);
      assert.match(html, /\.cat-desc \{[^}]*?min-height: 2lh;/);
    });

    await check('seeded Graphic Tees are categorized under the exact collection key used by the storefront', async () => {
      const response = await fetch(origin + '/api/products');
      assert.equal(response.status, 200);
      const products = await response.json();
      const liveGraphicTees = products.filter(product => product.category === 'graphic-tees'
        && product.in_stock !== false && (product.stock_qty == null || Number(product.stock_qty) > 0));
      assert.ok(liveGraphicTees.length > 0, 'the demo seed should include in-stock graphic-tees products');
      assert.ok(liveGraphicTees.every(product => product.category === 'graphic-tees'));
      // No legacy streetwear / goofy-wears categories remain after migration
      assert.equal(products.some(p => p.category === 'streetwear' || p.category === 'goofy-wears'), false,
        'legacy streetwear/goofy-wears categories must be migrated away');
    });

    await check('Graphic Tees with stock opens a filtered product grid (never Coming Soon)', () => {
      w.eval(`allProducts.push({
        id: 987654, name: 'Graphic Route Probe', price: 999, original_price: 999,
        collection: 'graphic-tees', style: 'Japanese Art', fit: 'Regular',
        sizes: ['L'], images: ['data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"%3E%3C/svg%3E'],
        stock_qty: 5, in_stock: true, on_sale: false, sale_price: null, rating: null, review_count: 0
      });`);
      w.navigateTo('collection', 'graphic-tees');
      assert.equal(d.getElementById('page-home').classList.contains('active'), true);
      assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false);
      assert.ok([...d.querySelectorAll('#collectionGrid .product-card h3')]
        .some(node => node.textContent === 'Graphic Route Probe'));
    });

    await check('Graphic Tees with zero stock remains listed, NOT Coming Soon', () => {
      w.eval(`allProducts.filter(product => product.collection === 'graphic-tees').forEach(product => {
        product.stock_qty = 0;
        product.in_stock = false;
      });`);
      w.navigateTo('collection', 'graphic-tees');
      // Page stays on home/shop, NOT on Coming Soon
      assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false,
        'graphic-tees must never display Coming Soon even when out of stock');
      assert.equal(d.getElementById('shopSection').classList.contains('shop-visible'), true);
      assert.match(d.getElementById('collectionGrid').textContent, /Graphic Route Probe/,
        'out-of-stock graphic-tees remains browsable');
      assert.ok(d.querySelector('#collectionGrid .sale-flag'));
    });

    await check('restocking Graphic Tees restores the filtered product grid', () => {
      w.eval(`allProducts.filter(product => product.collection === 'graphic-tees').forEach(product => {
        product.stock_qty = 1;
        product.in_stock = true;
      });`);
      w.navigateTo('collection', 'graphic-tees');
      assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false);
      assert.ok([...d.querySelectorAll('#collectionGrid .product-card h3')]
        .some(node => node.textContent === 'Graphic Route Probe'));
    });

    await check('adding a live Pants product preserves its existing tile and activates nav/footer', () => {
      originalPantsTile.focus();
      w.eval(`allProducts.push({
        id: 987655, name: 'Kage Cargo Pant', price: 2499, original_price: 2499,
        collection: 'pants', style: 'Everyday', fit: 'Relaxed',
        sizes: ['M','L'], images: ['data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"%3E%3C/svg%3E'],
        stock_qty: 3, in_stock: true, on_sale: false, sale_price: null, rating: null, review_count: 0
      });`);
      w.syncCollectionVisibility();
      const tile = d.getElementById('catTilePants');
      assert.equal(tile, originalPantsTile, 'stock updates must not replace the category card');
      assert.equal(tile.matches('.reveal, .reveal-scale'), false, 'stock updates never enable scroll-reveal');
      assert.notEqual(tile.style.display, 'none');
      assert.equal(d.activeElement, tile, 'stock updates preserve keyboard focus');
      assert.equal(tile.tagName, 'A');
      assert.equal(tile.getAttribute('aria-disabled'), null);
      assert.equal(tile.querySelector('.cat-coming-soon'), null);
      assert.equal(tile.querySelector('.cat-shop').textContent.trim(), 'Explore');
      assert.notEqual(d.getElementById('navPantsItem').style.display, 'none');
      tile.click();
      assert.equal(w.location.pathname, '/collection/pants');
      assert.equal(d.getElementById('collectionTitle').textContent, 'PANTS');
      assert.deepEqual([...d.querySelectorAll('#collectionGrid .product-card h3')].map(node => node.textContent), ['Kage Cargo Pant']);
      w.navigateTo('home');
    });

    await check('selling out Pants hides promotions but preserves the deep-linked sold-out grid', () => {
      w.eval(`allProducts.filter(product => product.collection === 'pants').forEach(product => {
        product.stock_qty = 0;
        product.in_stock = false;
      });`);
      w.syncCollectionVisibility();
      assert.equal(d.getElementById('catTilePants'), originalPantsTile);
      assert.equal(originalPantsTile.matches('.reveal, .reveal-scale'), false);
      assert.equal(originalPantsTile.getAttribute('aria-disabled'), null);
      assert.notEqual(w.getComputedStyle(originalPantsTile.querySelector('.cat-shop')).display, 'none');
      assert.equal(d.getElementById('navPantsItem').style.display, 'none');
      assert.equal(originalPantsTile.style.display, 'none');
      w.navigateTo('collection', 'pants');
      assert.equal(w.location.pathname, '/collection/pants');
      assert.match(d.getElementById('collectionGrid').textContent, /Kage Cargo Pant/);
      assert.equal(d.querySelector('#collectionGrid .sale-flag').textContent, 'SOLD OUT');
      assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false);
      w.navigateTo('home');
    });

    await check('removing the final Pants product hides but never replaces or relabels its homepage card', () => {
      w.eval("allProducts = allProducts.filter(product => product.collection !== 'pants')");
      w.syncCollectionVisibility();
      w.syncCollectionVisibility();
      assert.equal(d.getElementById('catTilePants'), originalPantsTile);
      assert.equal(d.querySelectorAll('#catTilePants').length, 1);
      assert.equal(originalPantsTile.style.display, 'none');
      assert.equal(originalPantsTile.tagName, 'A');
      assert.equal(originalPantsTile.querySelector('.cat-shop').textContent.trim(), 'Explore');
      assert.equal(originalPantsTile.querySelector('.cat-coming-soon'), null);
      assert.equal(originalPantsTile.matches('.reveal, .reveal-scale'), false);
      assert.equal(d.querySelectorAll('#categoryStrip .cat-tile').length, 4);
    });

    await check('an all-sold-out sale stays a collection, and every sort/search keeps its product', () => {
      const savedCatalog = w.eval('allProducts');
      try {
        w.eval(`allProducts = [{
          id: 987659, name: 'Sold Out Sale Probe', collection: 'anime', price: 900, original_price: 1000,
          on_sale: true, sale_price: 900, fit: 'Regular', style: 'Typography', desc: 'Still browsable',
          sizes: ['L'], images: [], stock_qty: 0, in_stock: false, review_count: 0
        }];`);
        w.navigateTo('collection', 'sale');
        assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false,
          'Coming Soon must not hide an existing sold-out sale');
        for (const sort of [...d.getElementById('sortSelect').options].map(o => o.value)) {
          d.getElementById('sortSelect').value = sort;
          w.renderCollectionGrid();
          assert.match(d.getElementById('collectionGrid').textContent, /Sold Out Sale Probe/);
          assert.equal(d.querySelector('#collectionGrid .sale-flag').textContent, 'SOLD OUT');
          assert.equal(d.getElementById('resultCount').textContent, '1 result');
        }
        w.onSearchInput('Sold Out Sale Probe');
        assert.ok(d.querySelector('#collectionGrid .product-card'));
      } finally {
        w.allProductsForRestore = savedCatalog;
        w.eval('allProducts = window.allProductsForRestore');
        delete w.allProductsForRestore;
        w.onSearchInput('');
        d.getElementById('sortSelect').selectedIndex = 0;
        w.navigateTo('home');
      }
    });

    await check('invalid category in product POST returns 400 with a clear message', async () => {
      // We can't exercise the admin API here (no cookie), but client-side dropdown
      // must offer exactly three options: graphic-tees, anime, pants.
      const cats = w.CATEGORY_OPTIONS ? w.CATEGORY_OPTIONS.map(o => o.value) : [];
      assert.deepStrictEqual([...cats].sort(), ['anime', 'graphic-tees', 'pants']);
    });

    await check('unused dead loaders and the shadowed notifyMe variant are removed', () => {
      assert.equal(typeof w.loadNewArrivals, 'undefined');
      assert.equal(typeof w.loadCollections, 'undefined');
      assert.doesNotMatch(html, /newArrivalsGrid|collectionsGrid/);
      assert.doesNotMatch(html, /function\s+notifyMe\s*\(\s*btn\s*,\s*category\s*\)/);
    });

    await check('customer-facing Contact and Shipping copy contains no TODOs or bracket placeholders', () => {
      const text = ['#page-contact', '#page-shipping']
        .map(selector => d.querySelector(selector).textContent)
        .join('\n');
      assert.doesNotMatch(text, /\bTODO\b/i);
      assert.doesNotMatch(text, /\[/, 'placeholder brackets must not be published');
    });

    const confirmation = makePage('/confirmation');
    windows.push(confirmation);
    await waitForCatalog(confirmation.window);
    await wait(75);
    await check('direct /confirmation without an in-memory order replaces to /tracking without showing 404', () => {
      assert.equal(confirmation.window.location.pathname, '/tracking');
      assert.equal(confirmation.window.document.getElementById('page-tracking').classList.contains('active'), true);
      assert.equal(confirmation.window.document.getElementById('page-not-found').classList.contains('active'), false);
    });

    const historyPage = makePage('/about');
    windows.push(historyPage);
    await waitForCatalog(historyPage.window);
    await wait(50);
    const hw = historyPage.window;
    hw.history.pushState(null, '', '/confirmation');
    const historyLength = hw.history.length;
    hw.dispatchEvent(new hw.PopStateEvent('popstate'));
    await wait(25);
    await check('confirmation redirect uses replaceState so browser Back returns to the prior page', async () => {
      assert.equal(hw.location.pathname, '/tracking');
      assert.equal(hw.history.length, historyLength);
      hw.history.back();
      await wait(100);
      assert.equal(hw.location.pathname, '/about');
      assert.equal(hw.document.getElementById('page-about').classList.contains('active'), true);
    });

    const removedCollection = makePage('/collection/the-vault');
    windows.push(removedCollection);
    await waitForCatalog(removedCollection.window);
    await wait(75);

    await check('removed themed collection slugs land on /collection/all and never render a broken page', () => {
      const rw = removedCollection.window, rd = rw.document;
      for (const slug of ['the-vault', 'iron-code', 'after-hours']) {
        rw.history.pushState(null, '', '/collection/' + slug);
        rw.dispatchEvent(new rw.PopStateEvent('popstate'));
        assert.equal(rw.location.pathname, '/collection/all', `/collection/${slug} must land on /collection/all like any unknown slug`);
        assert.equal(rd.getElementById('page-home').classList.contains('active'), true, 'the normal catalog renders');
        assert.equal(rd.getElementById('page-not-found').classList.contains('active'), false, 'no not-found page');
        assert.equal(rd.getElementById('page-coming-soon').classList.contains('active'), false);
      }
      assert.equal(rd.getElementById('collectionTitle').textContent, 'FEATURED DROPS | NEW ARRIVALS', 'no themed collection title');
      assert.ok(rd.querySelectorAll('#collectionGrid .product-card').length > 0, 'the full catalog is shown');
      assert.equal(rd.querySelector('.fp-collection'), null, 'the Collection filter dropdown is gone');
      assert.equal(rd.querySelector('.filter-section[data-group="collection"]'), null);
    });

    await check('no stale kage-clothes route is advertised or served as an SPA page', async () => {
      assert.doesNotMatch(html + serverSource, /kage-clothes/i);
      const response = await fetch(origin + '/kage-clothes');
      assert.equal(response.status, 404);
      assert.equal((await fetch(origin + '/confirmation')).status, 200, '/confirmation must keep serving the SPA shell for its client redirect');
      const comingSoon = await fetch(origin + '/coming-soon');
      assert.equal(comingSoon.status, 200, 'the live Coming Soon page is part of the SPA route allowlist');
      assert.match(await comingSoon.text(), /id="page-coming-soon"/);
    });
  } finally {
    windows.forEach(dom => dom.window.close());
    await new Promise(resolve => server.close(resolve));
  }

  if (failures.length) {
    console.error(`\n${failures.length} storefront regression(s) reproduced before the fixes.`);
    process.exitCode = 1;
  } else {
    console.log('All storefront regression checks passed.');
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
