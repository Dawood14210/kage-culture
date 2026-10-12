// Focused regressions for the public storefront navigation and customer copy.
// These checks intentionally run against the live SPA markup and seeded API data.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'storefront-regression-secret-0123456789';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { app, ensureReady } = require('../server');

const html = readFileSync(require.resolve('../public/index.html'), 'utf8');
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

    await check('Pants tile exists but is disabled (not a link) and absent from nav/footer until live', () => {
      const navLinks = [...d.querySelectorAll('#navLinks a, .site-footer a')].filter(a => a.offsetParent !== null && a.style.display !== 'none' && !a.closest('[style*="display: none"]'));
      assert.equal(navLinks.some(link => /^pants$/i.test(link.textContent.trim())), false, 'Pants must not appear in nav/footer links while out of stock');
      const pantsTile = d.getElementById('catTilePants');
      assert.ok(pantsTile, 'Pants tile must be present in the category strip');
      assert.equal(pantsTile.tagName, 'SPAN', 'Pants tile must NOT be an <a> link until live');
      assert.equal(pantsTile.getAttribute('aria-disabled'), 'true');
      assert.ok(pantsTile.querySelector('.cat-coming-soon'), 'Pants tile shows "Coming soon" pill');
    });

    await check('four category tiles in order Graphic Tees / Anime / Pants / Custom Stickers with responsive layouts', () => {
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

    await check('Graphic Tees with zero stock renders empty state, NOT Coming Soon', () => {
      w.eval(`allProducts.filter(product => product.collection === 'graphic-tees').forEach(product => {
        product.stock_qty = 0;
        product.in_stock = false;
      });`);
      w.navigateTo('collection', 'graphic-tees');
      // Page stays on home/shop, NOT on Coming Soon
      assert.equal(d.getElementById('page-coming-soon').classList.contains('active'), false,
        'graphic-tees must never display Coming Soon even when out of stock');
      assert.equal(d.getElementById('shopSection').classList.contains('shop-visible'), true);
      assert.match(d.getElementById('collectionGrid').textContent, /No graphic tees available right now/i,
        'out-of-stock graphic-tees shows empty state message');
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

    await check('adding a live pants product activates the Pants tile, nav link and footer link', () => {
      w.eval(`allProducts.push({
        id: 987655, name: 'Kage Cargo Pant', price: 2499, original_price: 2499,
        collection: 'pants', style: 'Everyday', fit: 'Relaxed',
        sizes: ['M','L'], images: ['data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"%3E%3C/svg%3E'],
        stock_qty: 3, in_stock: true, on_sale: false, sale_price: null, rating: null, review_count: 0
      });`);
      w.syncPantsCategoryVisibility();
      const tile = d.getElementById('catTilePants');
      assert.equal(tile.tagName, 'A', 'Pants tile must become an <a> once live');
      assert.equal(tile.getAttribute('aria-disabled'), null);
      assert.ok(!tile.querySelector('.cat-coming-soon') || tile.querySelector('.cat-coming-soon').style.display === 'none');
      const navItem = d.getElementById('navPantsItem');
      assert.ok(navItem && navItem.style.display !== 'none', 'Pants nav link visible when live');
      const footerItem = d.getElementById('footerPantsItem');
      assert.ok(footerItem && footerItem.style.display !== 'none', 'Pants footer link visible when live');
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
