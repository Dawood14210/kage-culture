// KAGE Culture storefront bundle (PERF-1: extracted from index.html).
// First: the marquee top-up, which ran mid-parse from its own block.
// It only measures the topbar above it, so running at bundle start
// (end of body) keeps its seamless-loop guarantee.

      // Marquee top-up: the loop is seamless only while one group is at least
      // as wide as the viewport (the track shows group N while group N+1 slides
      // in). On very wide screens, clone items into BOTH groups until that
      // holds, keeping their widths identical so the -50% loop stays seamless.
      (function () {
        var track = document.querySelector('.topbar-track');
        if (!track) return;
        var groups = track.querySelectorAll('.topbar-group');
        if (groups.length < 2) return;
        var item = groups[0].querySelector('.topbar-item');
        if (!item) return;
        var need = Math.ceil(window.innerWidth / Math.max(item.offsetWidth, 1)) + 1;
        while (groups[0].children.length < need) {
          groups[0].appendChild(item.cloneNode(true));
          groups[1].appendChild(item.cloneNode(true));
        }
      })();
    
// ---- main storefront script (was the end-of-body inline block) ----

    let allProducts = [
      { id:1, name:'Shadow Fit', price:1499, fit:'Compression', collection:'compression', style:'Japanese Art', rating:4.6,
        desc:'4-way stretch muscle-fit compression shirt. Second-skin feel with maximum mobility.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EShadow Fit%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EShadow Back%3C/text%3E%3C/svg%3E'] },
      { id:2, name:'Oni Muscle Tee', price:1599, fit:'Compression', collection:'compression', style:'Anime-Inspired', rating:4.8, variants:[{label:'Black',price:1599},{label:'White',price:1699}],
        desc:'Sleeveless compression with bold contrast panels. For those who train until the mask drops.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EOni Front%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EOni Back%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%96%B2%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3ESide%3C/text%3E%3C/svg%3E'] },
      { id:3, name:'Kage Core Compression', price:1399, fit:'Compression', collection:'compression', style:'Typography', rating:4.4,
        desc:'Core compression layer — seamless, breathable, built for combat-level intensity.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3ECore%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3ECore Back%3C/text%3E%3C/svg%3E'] },
      { id:4, name:'Rising Vermillion', price:999, fit:'Regular', collection:'graphic-tees', style:'Japanese Art', rating:4.7, on_sale:true, sale_price:799,
        desc:'Heavyweight 220GSM cotton tee. A gradient sky turned crimson.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EVermillion%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EBack%3C/text%3E%3C/svg%3E'] },
      { id:5, name:'Blade Wolf', price:1149, fit:'Regular', collection:'graphic-tees', style:'Anime-Inspired', rating:4.9, variants:[{label:'Black',price:1149},{label:'Crimson',price:1199}],
        desc:'Silver ink on black — a lone wolf under a crescent moon.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EBlade Wolf%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EWolf Back%3C/text%3E%3C/svg%3E'] },
      { id:6, name:'Neon Fangs', price:1049, fit:'Regular', collection:'graphic-tees', style:'Anime-Inspired', rating:4.3,
        desc:'Electric strike — neon clash across heavyweight cotton.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3ENeon%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EFangs Back%3C/text%3E%3C/svg%3E'] },
      { id:7, name:'Shinobi Mark', price:999, fit:'Regular', collection:'graphic-tees', style:'Japanese Art', rating:4.5,
        desc:'Minimalist shinobi crest. High-contrast placement on premium 220GSM cotton.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EShinobi%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EShinobi Back%3C/text%3E%3C/svg%3E'] },
      { id:8, name:'Drift Oversized', price:1199, fit:'Oversized', collection:'oversized', style:'Typography', rating:4.2, variants:[{label:'Black',price:1199},{label:'Ash',price:1249}],
        desc:'Drop-shoulder, relaxed fit — heavyweight cotton.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EDrift%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EDrift Back%3C/text%3E%3C/svg%3E'] },
      { id:9, name:'Wrath Silhouette', price:1249, fit:'Oversized', collection:'oversized', style:'Anime-Inspired', rating:4.7, on_sale:true, sale_price:1099,
        desc:'Boxy, cropped oversized fit. Built for those who take up space.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EWrath%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EWrath Back%3C/text%3E%3C/svg%3E'] },
      { id:10, name:'Hollow Gaze', price:1149, fit:'Oversized', collection:'oversized', style:'Japanese Art', rating:4.6,
        desc:'Extended drop-shoulder with raw hem. Unsettling and calm.',
        sizes:['S','M','L','XL','XXL'],
        images:['data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%91%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EHollow%3C/text%3E%3C/svg%3E',
        'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 400%22%3E%3Crect fill=%22%23C4BEB0%22 width=%22300%22 height=%22400%22/%3E%3Ctext x=%22150%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2224%22%3E%E2%86%93%3C/text%3E%3Ctext x=%22150%22 y=%22220%22 text-anchor=%22middle%22 fill=%22%237A7468%22 font-family=%22sans-serif%22 font-size=%2210%22%3EHollow Back%3C/text%3E%3C/svg%3E'] }
    ];

    let cart = [];
    let shopStateReady = false;
    function persistShopState() {
      if (!shopStateReady) return;
      try {
        localStorage.setItem('kageCart', JSON.stringify(cart.map(i => ({ id: i.id, size: i.size, qty: i.qty }))));
        localStorage.setItem('kageWishlist', JSON.stringify([...wishlist]));
      } catch (e) { /* private mode / storage disabled */ }
    }
    function restoreShopState() {
      try {
        const saved = JSON.parse(localStorage.getItem('kageCart') || '[]');
        cart = Array.isArray(saved) ? saved.slice(0, 50).map(i => {
          const p = allProducts.find(x => x.id === Number(i.id));
          if (!p) return null;
          // Keep unavailable lines visible so a stock change is not a silent removal.
          const requested = Math.max(0, Math.floor(Number(i.qty) || 0));
          const qty = sizeAvailable(p, i.size) ? Math.min(maxQtyFor(p, i.size), requested) : requested;
          return qty ? { ...p, size: i.size, qty } : null;
        }).filter(Boolean) : [];
        const ids = JSON.parse(localStorage.getItem('kageWishlist') || '[]');
        wishlist.clear();
        if (Array.isArray(ids)) ids.forEach(id => {
          const p = allProducts.find(x => x.id === Number(id));
          if (p) wishlist.add(p.id);
        });
      } catch (e) { cart = []; wishlist.clear(); }
      shopStateReady = true;
      document.getElementById('wishlistCount').textContent = wishlist.size;
      updateCartUI();
      renderWishlistDrawer();
    }
    let currentProduct = null;
    let detailQty = 1;
    let detailSize = 'L';
    let detailAngle = 0;
    let currentCollectionFilter = 'all';
    let currentPage = 1;
    const perPage = 8;

    // The shop grid (#shopSection) replaces the marketing homepage while a
    // collection is open or a search is active. `shopCollectionMode` is set by
    // navigateTo()/initShop(); a non-empty search query counts as well, so the
    // grid is visible iff "collection view OR search results" is true.
    let shopCollectionMode = false;
    function applyShopVisibility() {
      const sec = document.getElementById('shopSection');
      if (!sec) return;
      const show = shopCollectionMode || searchQuery.trim() !== '';
      sec.classList.toggle('shop-visible', show);
      document.body.classList.toggle('showing-shop', show);
    }

    // ---------- Shop state: search / wishlist / filters ----------
    let searchQuery = '';
    const wishlist = new Set();
    let wishlistOnly = false;

    // Heart glyph for every wishlist button. Kept byte-identical to the navbar's
    // (same path, 20x20, stroked with currentColor) so the card and nav hearts
    // can never drift apart again; a saved item fills it via the `.active svg`
    // rule in the wishlist-icon block.
    const HEART_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    const filterState = {
      cats: new Set(['Anime-Inspired', 'Japanese Art', 'Typography']),
      priceMin: 0,
      priceMax: 10000,
      size: ''
    };

    function fmt(n) { return Number(n).toLocaleString('en-IN'); }

    // CSRF token helpers — the token lives in the kage.csrf cookie.
    const _origFetch = window.fetch;
    function getCsrfToken() {
      const cookies = document.cookie.split(';').map(c => c.trim());
      const csrfCookie = cookies.find(c => c.startsWith('kage.csrf='));
      return csrfCookie ? csrfCookie.split('=')[1] : '';
    }
    function hasHeader(headers, name) {
      if (!headers) return false;
      if (typeof headers.has === 'function') return headers.has(name);
      return Object.keys(headers).some(k => k.toLowerCase() === name.toLowerCase());
    }
    function setHeader(headers, name, value) {
      if (!headers) return { [name]: value };
      if (typeof headers.set === 'function') { headers.set(name, value); return headers; }
      headers[name] = value;
      return headers;
    }

    // Public cacheable API reads (/api/products, /api/products/:id, /api/reviews)
    // deliberately never send Set-Cookie, so a visitor whose cookie is missing
    // (fresh browser, cleared cookies, 24h expiry) asks the small no-store
    // /api/csrf endpoint for a token before the first state-changing request.
    // One in-flight request per page load; retried if it came back empty.
    let csrfTokenRequest = null;
    function ensureCsrfToken() {
      const existing = getCsrfToken();
      if (existing) return Promise.resolve(existing);
      if (!csrfTokenRequest) {
        csrfTokenRequest = _origFetch.call(window, '/api/csrf', { cache: 'no-store' })
          .then(res => (res && res.ok ? res.json() : null))
          .then(data => getCsrfToken() || (data && data.token) || '')
          .catch(() => getCsrfToken())
          .then(token => { if (!token) csrfTokenRequest = null; return token; });
      }
      return csrfTokenRequest;
    }

    // Monkey-patch fetch to automatically add the CSRF token to state-changing
    // requests, fetching one first when the cookie is not there yet.
    window.fetch = async function(url, opts) {
      if (opts && opts.method && ['POST','PUT','PATCH','DELETE'].includes(opts.method.toUpperCase())) {
        if (!hasHeader(opts.headers, 'X-CSRF-Token')) {
          const token = await ensureCsrfToken();
          if (token) opts.headers = setHeader(opts.headers, 'X-CSRF-Token', token);
        }
      }
      return _origFetch.call(this, url, opts);
    };

    // Escape user-provided text before injecting into innerHTML (prevents stored XSS)
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function placeholderImg(name) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect fill="#C4BEB0" width="300" height="400"/><text x="150" y="195" text-anchor="middle" fill="#4A4433" font-family="sans-serif" font-size="24">↑</text><text x="150" y="215" text-anchor="middle" fill="#7A7468" font-family="sans-serif" font-size="10">${esc(name)}</text></svg>`;
      return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    function getPriceRange(p) {
      if (p.variants && p.variants.length > 1) {
        const ps = p.variants.map(v => v.price);
        return { min: Math.min(...ps), max: Math.max(...ps), isRange: true, onSale: false };
      }
      const base = p.original_price || p.price;
      const sale = (p.on_sale || p.sale_price) && p.sale_price && p.sale_price < base;
      return { min: sale ? p.sale_price : p.price, max: sale ? base : p.price, isRange: false, onSale: !!sale };
    }

    function starsOnlyHtml(r) {
      const pct = Math.max(0, Math.min(5, r || 0)) / 5 * 100;
      return `<span class="star-rating" title="${(r || 0).toFixed(1)} / 5"><span class="stars-bg">★★★★★</span><span class="stars-fg" style="width:${pct}%">★★★★★</span></span>`;
    }

    function starsHtml(r, count) {
      if (!r || !count || count <= 0) return '';
      return starsOnlyHtml(r) + `<span class="rating-count">${count}</span>`;
    }

    // Real low-stock flag — only rendered when stock_qty is a real number at or below 5.
    function isAvailable(p) { return p.in_stock !== false && (p.stock_qty == null || Number(p.stock_qty) > 0); }

    // ---------- Per-size stock ----------
    // p.size_stock is {size: units} for products tracked per size, or null
    // when the product uses one shared stock count (p.stock_qty).
    function sizeQty(p, size) {
      return (p.size_stock && Object.prototype.hasOwnProperty.call(p.size_stock, size)) ? (Number(p.size_stock[size]) || 0) : null;
    }
    function sizeAvailable(p, size) {
      if (!isAvailable(p)) return false;
      if (p.size_stock) return (sizeQty(p, size) || 0) > 0;
      return true;
    }
    function maxQtyFor(p, size) {
      const q = p.size_stock ? (sizeQty(p, size) || 0) : (p.stock_qty ?? 99);
      return Math.min(99, Math.max(0, Number(q) || 0));
    }
    function anySizeAvailable(p) { return (p.sizes || []).some(s => sizeAvailable(p, s)); }
    function defaultSizeFor(p) {
      const sizes = (p.sizes && p.sizes.length) ? p.sizes : ['L'];
      return sizes.find(s => sizeAvailable(p, s)) || sizes[0];
    }

    function lowStockBadge(p) {
      const s = p.stock_qty;
      if (s != null && s !== '' && s > 0 && s <= 5) return `<span class="low-stock-flag">Only ${s} left</span>`;
      return '';
    }

    function detailPriceHtml(p) {
      const r = getPriceRange(p);
      if (r.isRange) return 'Rs. ' + fmt(r.min) + ' — Rs. ' + fmt(r.max);
      if (r.onSale) return 'Rs. ' + fmt(r.min) + ' <span class="original">Rs. ' + fmt(r.max) + '</span>';
      return 'Rs. ' + fmt(r.min);
    }

    // ---------- Navigation ----------
    // A category is "live" when it has at least one in-stock product.
    // Graphic Tees, Anime Shirts and Pants always show the shop grid, with
    // an empty state only when no products match. Sold-out items stay listed.
    const COMING_SOON_CATS = ['compression', 'oversized', 'sale'];
    const CATEGORY_NAMES = { 'anime': 'Anime Shirts', 'graphic-tees': 'Graphic Tees', 'pants': 'Pants', 'compression': 'Compression', 'oversized': 'Oversized', 'sale': 'Sale' };
    // The only slugs /collection/xxx accepts. Anything else — including the
    // removed themed pages — is treated like any unknown slug and lands on
    // the full catalog at /collection/all.
    const COLLECTION_FILTERS = ['all', 'new', 'sale', 'anime', 'graphic-tees', 'pants', 'compression', 'oversized'];
    // Mirrors config.js / admin CATEGORY_OPTIONS for test inspection.
    const CATEGORY_OPTIONS = [
      { value: 'graphic-tees', label: 'Graphic Tees' },
      { value: 'anime', label: 'Anime Shirts' },
      { value: 'pants', label: 'Pants' }
    ];
    window.CATEGORY_OPTIONS = CATEGORY_OPTIONS;
    window.CATEGORY_NAMES = CATEGORY_NAMES;
    window.COMING_SOON_CATS = COMING_SOON_CATS;
    // Promote these collections only when the loaded catalog has buyable stock.
    // Keep their links/nodes intact so direct routes and later restocks still work.
    function syncCollectionVisibility() {
      document.querySelectorAll('[data-stock-category]').forEach(item => {
        const live = productsLoadedFromApi && categoryHasLiveProducts(item.dataset.stockCategory);
        item.style.display = live ? '' : 'none';
      });
    }
    window.syncCollectionVisibility = syncCollectionVisibility;
    document.querySelector('.skip-link').addEventListener('click', () => {
      document.getElementById('mainContent').focus({ preventScroll: true });
    });
        let productsLoadedFromApi = false;
    function categoryHasProducts(filter) {
      if (!productsLoadedFromApi) return true;
      return allProducts.some(p => filter === 'sale'
        ? p.on_sale || (p.sale_price && p.sale_price < p.original_price)
        : p.collection === filter);
    }
    function categoryHasLiveProducts(filter) {
      // Before real data arrives, allProducts is the hardcoded fallback catalog
      // (which has products in every category) — defer to the grid then.
      if (!productsLoadedFromApi) return true;
      return allProducts.some(p => {
        const stocked = anySizeAvailable(p);
        if (filter === 'sale') return stocked && (p.on_sale || (p.sale_price && p.sale_price < p.original_price));
        return stocked && p.collection === filter;
      });
    }
    function setupComingSoon(filter) {
      const name = CATEGORY_NAMES[filter] || (filter || '').replace(/-/g, ' ').toUpperCase();
      const titleEl = document.getElementById('comingSoonTitle');
      const catEl = document.getElementById('comingSoonCategory');
      const msgEl = document.getElementById('comingSoonMsg');
      const emailEl = document.getElementById('comingSoonEmail');
      if (titleEl) titleEl.textContent = name.toUpperCase() + ' — COMING SOON';
      if (catEl) catEl.value = filter;
      if (msgEl) msgEl.textContent = '';
      if (emailEl) emailEl.value = '';
    }
    let restoringHistory = false;
    // Flipped once the synchronous boot routing AND the async deep-link restore
    // finish. Later navigateTo() calls are user-initiated, so they move focus
    // to the main content (A11Y-4 / FE-M5).
    let bootNavComplete = false;
    function routeFor(page, filter) {
      if (page === 'home') return '/';
      if (page === 'collection') return '/collection/' + encodeURIComponent(filter || 'all');
      if (page === 'product' && currentProduct) return '/product/' + currentProduct.id;
      if (page === 'reset') return location.pathname === '/reset-password' ? location.pathname + location.search : '/reset-password';
      if (page === 'verify') return location.pathname === '/verify-email' ? location.pathname + location.search : '/verify-email';
      return '/' + page;
    }
    function restoreRouteFromLocation() {
      restoringHistory = true;
      try {
        const path = decodeURIComponent(location.pathname);
        if (path === '/') navigateTo('home');
        else if (path.startsWith('/product/')) {
          const id = Number(path.slice('/product/'.length));
          if (Number.isInteger(id) && allProducts.some(p => p.id === id)) openProductDetail(id);
          else navigateTo('not-found');
        } else if (path.startsWith('/collection/')) {
          const slug = path.slice('/collection/'.length);
          if (COLLECTION_FILTERS.includes(slug)) navigateTo('collection', slug);
          else {
            // Unknown or removed collection slugs behave like any unknown
            // collection URL: land on the full catalog at /collection/all.
            history.replaceState(null, '', '/collection/all');
            navigateTo('collection', 'all');
          }
        } else if (path === '/confirmation') {
          if (lastOrder) navigateTo('confirmation');
          else {
            history.replaceState(null, '', '/tracking');
            navigateTo('tracking', null, { skipHistory: true });
          }
        } else if (path === '/reset-password') { navigateTo('reset'); initPasswordReset(); }
        else if (path === '/verify-email') { navigateTo('verify'); initEmailVerification(); }
        else if (path === '/account') {
          // A direct visit/bookmark must load the account data too — the page
          // used to sit on "Loading orders…" until the user navigated away and
          // back, which also hid the verify-your-email prompt.
          navigateTo('account');
          if (currentCustomer) loadAccountPage();
        }
        else if (['about','contact','shipping','returns','privacy','terms','tracking','custom-stickers','coming-soon'].includes(path.slice(1))) navigateTo(path.slice(1));
        else navigateTo('not-found');
      } catch (e) { navigateTo('not-found'); }
      finally { restoringHistory = false; }
    }
    window.addEventListener('popstate', restoreRouteFromLocation);

    // ---------- Client-side social meta (SEO-4) ----------
    // The server renders route-specific meta for product/collection URLs
    // (server.js resolveSeoPage); SPA navigations after first load keep the same
    // tags in sync so copied links unfurl correctly. Homepage defaults are
    // constants (NOT boot-captured: a deep-linked boot already carries
    // product/collection meta); content pages and home restore them, matching
    // what the server serves for those routes. Keep this copy identical to the
    // shell <head> — the SEO-4 regression test enforces parity on a '/' boot.
    const HOME_SOCIAL_META = {
      title: 'KAGE CULTURE \u2014 Engineered Fit. Original Art.',
      description: 'KAGE Culture \u2014 Premium streetwear. Anime inspired. Built for everyday. Shop oversized tees, graphic tees, and compression gear.',
      imageAlt: 'KAGE Culture campaign: a model in a white oversized tee printed with EVERYONE, mid-kick in front of a light wall covered in graffiti lettering',
      type: 'website'
    };
    function homeSocialMeta() {
      return { ...HOME_SOCIAL_META, image: defaultSocialImage() };
    }
    // Mirrors server.js COLLECTION_SEO — keep the copy in sync.
    const COLLECTION_SOCIAL = {
      all: { name: 'Shop All', description: 'Shop every KAGE Culture drop: premium streetwear, graphic tees, anime shirts, and pants made for everyday.' },
      new: { name: 'New Arrivals', description: 'Explore the latest KAGE Culture streetwear arrivals, featuring original art and everyday fits.' },
      sale: { name: 'Sale', description: 'Shop limited-time markdowns on KAGE Culture streetwear while selected pieces are still available.' },
      anime: { name: 'Anime Shirts', description: 'Shop anime-inspired shirts with original artwork, premium cotton, and everyday streetwear fits.' },
      'graphic-tees': { name: 'Graphic Tees', description: 'Discover original graphic tees from KAGE Culture, printed on premium cotton for everyday wear.' },
      pants: { name: 'Pants', description: 'Shop relaxed KAGE Culture pants, designed to pair with original graphic tees and streetwear drops.' },
      compression: { name: 'Compression', description: 'Explore KAGE Culture compression streetwear: engineered fits with original art and everyday comfort.' },
      oversized: { name: 'Oversized', description: 'Shop oversized KAGE Culture streetwear with relaxed silhouettes, premium fabrics, and original art.' }
    };
    function setSocialMeta(meta) {
      const set = (attr, key, value) => {
        if (value == null) return;
        const el = document.querySelector(`meta[${attr}="${key}"]`);
        if (el) el.content = value;
      };
      set('name', 'description', meta.description);
      set('property', 'og:type', meta.type);
      set('property', 'og:title', meta.title);
      set('property', 'og:description', meta.description);
      set('property', 'og:image', meta.image);
      set('property', 'og:image:alt', meta.imageAlt);
      set('name', 'twitter:title', meta.title);
      set('name', 'twitter:description', meta.description);
      set('name', 'twitter:image', meta.image);
    }
    function absoluteSocialImage(value) {
      const raw = String(value || '').trim();
      if (!raw) return null;
      try {
        const url = new URL(raw, location.origin + '/');
        return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
      } catch (_) { return null; }
    }
    function trimSocialDescription(value, fallback) {
      const clean = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const text = clean(value) || clean(fallback);
      if (text.length <= 155) return text;
      return text.slice(0, 154).trimEnd() + '\u2026';
    }
    function siteRootForMeta() {
      const configured = document.querySelector('meta[name="site-url"]')?.content || '';
      return /^https?:\/\//i.test(configured) ? configured.replace(/\/+$/, '') : location.origin;
    }
    function defaultSocialImage() {
      return siteRootForMeta() + '/images/og-image.jpg';
    }
    function syncSocialMetaForRoute(page, filter, target) {
      if (target === 'product' && currentProduct) {
        const pName = String(currentProduct.name || '').replace(/\s+/g, ' ').trim() || 'KAGE Culture';
        setSocialMeta({
          title: `${pName} | KAGE CULTURE`,
          description: trimSocialDescription(currentProduct.desc, `Shop ${pName} from KAGE Culture: premium streetwear with original art, made for everyday wear.`),
          image: absoluteSocialImage(currentProduct.images && currentProduct.images[0]) || defaultSocialImage(),
          imageAlt: pName,
          type: 'product'
        });
        return;
      }
      if (page === 'collection') {
        const info = COLLECTION_SOCIAL[filter] || COLLECTION_SOCIAL.all;
        // Newest-first like the catalog API, so the pick approximates the
        // server's newest-with-image choice for the same route.
        const pool = filter === 'sale'
          ? allProducts.filter(p => p.on_sale)
          : (filter === 'all' || filter === 'new') ? allProducts : allProducts.filter(p => p.collection === filter);
        let image = null;
        for (const p of pool) { image = absoluteSocialImage(p.images && p.images[0]); if (image) break; }
        setSocialMeta({
          title: `${info.name} | KAGE CULTURE`,
          description: trimSocialDescription(info.description),
          image: image || defaultSocialImage(),
          imageAlt: `${info.name} by KAGE Culture`,
          type: 'website'
        });
        return;
      }
      setSocialMeta(homeSocialMeta());
    }
    function navigateTo(page, filter, options = {}) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      if (page === 'collection') {
        // Deleted/unknown collection slugs render the full catalog instead of
        // a broken or half-filtered page (matches the deep-link handling above).
        filter = (filter && COLLECTION_FILTERS.includes(filter)) ? filter : 'all';
      }
      const isCollectionRoute = (page === 'collection');
      let target = page;
      if (page === 'collection') {
        if (COMING_SOON_CATS.includes(filter) && !categoryHasProducts(filter)) {
          target = 'coming-soon';
        } else {
          target = 'home';
        }
      }
      if (page === 'account') {
        if (!currentCustomer) { openCustModal(); document.getElementById('page-home').classList.add('active'); return; }
        target = 'account';
      }
      const t = document.getElementById('page-' + target);
      if (!t) { document.getElementById('page-home').classList.add('active'); return; }
      // Move the target page inside <main> so it renders in the correct layout position
      const mainEl = document.querySelector('main');
      if (mainEl && t.parentElement !== mainEl) {
        mainEl.appendChild(t);
      }
      t.classList.add('active');
      if (!restoringHistory && !options.skipHistory) {
        const url = routeFor(page, filter);
        if (url !== location.pathname + location.search) history.pushState(null, '', url);
      }
      // Keep share previews and canonical tags aligned with the visible SPA route.
      const configuredSiteUrl = document.querySelector('meta[name="site-url"]')?.content || '';
      const siteRoot = /^https?:\/\//i.test(configuredSiteUrl) ? configuredSiteUrl.replace(/\/+$/, '') : location.origin;
      const canonicalUrl = siteRoot + location.pathname;
      document.querySelector('link[rel="canonical"]').href = canonicalUrl;
      document.querySelector('meta[property="og:url"]').content = canonicalUrl;
      const collectionTitleName = filter === 'all' ? 'Shop All'
        : filter === 'new' ? 'New Arrivals'
          : (CATEGORY_NAMES[filter] || String(filter || '').replace(/-/g, ' '));
      document.title = isCollectionRoute ? `${collectionTitleName} | KAGE CULTURE`
        : target === 'home' ? 'KAGE CULTURE — Engineered Fit. Original Art.'
          : ((target === 'product' && currentProduct) ? `${String(currentProduct.name || '').replace(/\s+/g, ' ').trim()} | KAGE CULTURE` : target.replace(/-/g, ' ') + ' | KAGE CULTURE');
      syncSocialMetaForRoute(page, filter, target);
      window.scrollTo({ top: 0 });
      closeFilterDrawer();
            // Toggle body class for tracking page to disable footer watermark
            document.body.classList.toggle('showing-tracking', target === 'tracking');
      // Deactivate all nav links by default, then activate the matching one
      const navDeactivate = () => document.querySelectorAll('.nav-links a[data-nav]').forEach(a => a.classList.remove('active'));
      if (target !== 'home') {
        // The grid lives inside the home view — every other view hides it.
        shopCollectionMode = false;
        applyShopVisibility();
      }
      if (target === 'home') {
        if (!isCollectionRoute && !options.keepSearch) {
          // Landing on the plain homepage drops any leftover search text.
          document.querySelectorAll('#searchInput, #mobileSearch').forEach(inp => { if (inp) inp.value = ''; });
          searchQuery = '';
        }
        initShop(filter || 'all', { collection: isCollectionRoute });
      } else if (target === 'coming-soon') {
        navDeactivate();
        document.querySelectorAll('.nav-links a[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === filter));
        setupComingSoon(filter);
      } else if (target === 'checkout') {
        navDeactivate();
        if (!cart.length) { navigateTo('home'); return; }
        renderCheckout();
        autofillCheckoutFromAccount();
      } else if (target === 'confirmation') {
        navDeactivate();
        if (lastOrder) renderConfirmation(lastOrder);
      } else if (target === 'custom-stickers') {
        // Brand sections — just show the page, activate nav
        navDeactivate();
        document.querySelectorAll('.nav-links a[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === target));
      } else {
        // Content pages (returns, shipping, terms, privacy, contact, account)
        navDeactivate();
      }
      // User-initiated route changes move keyboard/screen-reader focus to the
      // main content. Boot routing is skipped: stealing focus on load would
      // strand the skip link behind the focused element. Runs last so it wins
      // over drawer focus restoration above.
      if (bootNavComplete) {
        var mainFocus = document.getElementById('mainContent');
        if (mainFocus && mainFocus.focus) mainFocus.focus({ preventScroll: true });
      }
    }

    // ---------- Checkout ----------
    let lastOrder = null;

    function cartItemUnavailable(item) {
      const p = allProducts.find(p => p.id === item.id);
      return !productsLoadedFromApi || !p || !(p.sizes || []).includes(item.size)
        || !sizeAvailable(p, item.size) || item.qty > maxQtyFor(p, item.size);
    }
    function cartHasUnavailableItems() { return cart.some(cartItemUnavailable); }

    function startCheckout() {
      const d = document.getElementById('cartDrawer');
      if (d.classList.contains('open')) toggleCart();
      if (!productsLoadedFromApi) { showToast('Shop temporarily unavailable. Please retry loading products.'); return; }
      if (!cart.length) { showToast('Your cart is empty.'); return; }
      if (cartHasUnavailableItems()) { showToast('Some items are unavailable. Remove them before checkout.'); return; }
      navigateTo('checkout');
    }

    function autofillCheckoutFromAccount() {
      if (!currentCustomer) return;
      const nameEl = document.getElementById('coName');
      const emailEl = document.getElementById('coEmail');
      const phoneEl = document.getElementById('coPhone');
      const addrEl = document.getElementById('coAddress');
      const cityEl = document.getElementById('coCity');
      if (nameEl && !nameEl.value && currentCustomer.name) nameEl.value = currentCustomer.name;
      if (emailEl && !emailEl.value && currentCustomer.email) emailEl.value = currentCustomer.email;
      if (phoneEl && !phoneEl.value && currentCustomer.phone) phoneEl.value = currentCustomer.phone;
      if (addrEl && !addrEl.value && currentCustomer.address) addrEl.value = currentCustomer.address;
      if (cityEl && !cityEl.value && currentCustomer.city) cityEl.value = currentCustomer.city;
    }

    function renderCheckout() {
      const wrap = document.getElementById('coItems');
      let sub = 0;
      wrap.innerHTML = cart.map((item) => {
        const unavailable = cartItemUnavailable(item);
        const t = item.price * item.qty; sub += t;
        return `<div class="co-item">
          <div class="co-item-img"><img src="${esc(item.images && item.images[0] ? item.images[0] : '')}" alt="${esc(item.name)}" width="52" height="60" sizes="52px" loading="lazy" decoding="async" /></div>
          <div class="co-item-info"><div class="co-item-name">${esc(item.name)}</div><div class="co-item-meta">Size ${esc(item.size)} · Qty ${item.qty}${unavailable ? ' · Unavailable' : ''}</div></div>
          <div class="co-item-price">Rs. ${t}</div>
        </div>`;
      }).join('');
      document.getElementById('coSubtotal').textContent = 'Rs. ' + fmt(sub);
      document.getElementById('coShipping').textContent = 'To be confirmed';
      document.getElementById('coTotal').textContent = 'Rs. ' + fmt(sub);
      document.getElementById('coPlaceBtn').disabled = !cart.length || cartHasUnavailableItems();
    }


    async function placeOrder() {
      const errEl = document.getElementById('checkoutError');
      errEl.style.display = 'none';
      if (!productsLoadedFromApi) { errEl.textContent = 'Shop temporarily unavailable. Please retry loading products.'; errEl.style.display = 'block'; return; }
      if (!cart.length || cartHasUnavailableItems()) {
        errEl.textContent = 'Some items are unavailable. Remove them before checkout.';
        errEl.style.display = 'block';
        return;
      }
      const f = {
        name: document.getElementById('coName').value.trim(),
        email: document.getElementById('coEmail').value.trim(),
        phone: document.getElementById('coPhone').value.trim(),
        address: document.getElementById('coAddress').value.trim(),
        city: document.getElementById('coCity').value.trim(),
        notes: document.getElementById('coNotes').value.trim(),
        payment_method: 'cod'
      };
      if (!f.name || !f.email || !f.phone || !f.address || !f.city) {
        errEl.textContent = 'Please fill in all required fields (name, email, phone, address, city).';
        errEl.style.display = 'block';
        return;
      }
      if (!/^\S+@\S+\.\S+$/.test(f.email)) {
        errEl.textContent = 'Please enter a valid email address.';
        errEl.style.display = 'block';
        return;
      }
      const btn = document.getElementById('coPlaceBtn');
      btn.disabled = true;
      btn.textContent = 'Placing order…';
      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...f, items: cart.map(i => ({ id: i.id, qty: i.qty, size: i.size })) })
        });
        const data = await res.json();
        if (res.ok) {
          lastOrder = data;
          cart = [];
          updateCartUI();
          navigateTo('confirmation');
          announce('Order ' + (data.order_number || '') + ' placed. Thank you for shopping with KAGE Culture.');
        } else {
          errEl.textContent = data.error || 'Could not place the order. Please try again.';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.textContent = 'Connection error. Make sure the server is running.';
        errEl.style.display = 'block';
      }
      btn.disabled = !cart.length || cartHasUnavailableItems();
      btn.textContent = 'Place Order';
    }

    function renderConfirmation(order) {
      document.getElementById('confName').textContent = order.customer_name;
      document.getElementById('confNumber').textContent = order.order_number;
      const statusLabels = { pending: 'Pending', awaiting_verification: 'Awaiting Payment Verification', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
      document.getElementById('confStatus').textContent = statusLabels[order.status] || order.status;
      const payLabel = order.payment_method === 'bank' ? 'Bank Transfer' : order.payment_method === 'jazzcash' ? 'JazzCash' : 'Cash on Delivery';
      document.getElementById('confPayment').textContent = order.payment_ref ? `${payLabel} (Ref: ${order.payment_ref})` : payLabel;
      document.getElementById('confAddress').textContent = order.address + ', ' + order.city;
      document.getElementById('confShipping').textContent = order.shipping_pending ? 'To be confirmed' : 'Rs. ' + fmt(order.shipping);
      document.getElementById('confTotal').textContent = 'Rs. ' + fmt(order.total);
      document.getElementById('confItems').innerHTML = (order.items || []).map(it => `
        <div class="conf-item">
          <span>${esc(it.name)}${it.size ? ' \u00b7 Size ' + esc(it.size) : ''} \u00d7 ${it.qty}</span>
          <span>Rs. ${it.total}</span>
        </div>`).join('');

    }


    function initShop(filter, opts = {}) {
      currentCollectionFilter = filter || 'all';
      currentPage = 1;
      // Only a collection route (or an active search) surfaces the grid — the
      // plain homepage keeps it hidden.
      shopCollectionMode = opts.collection === true;
      applyShopVisibility();
      const titles = { 'all':'FEATURED DROPS | NEW ARRIVALS','new':'NEW ARRIVALS','anime':'ANIME SHIRTS','graphic-tees':'GRAPHIC TEES','pants':'PANTS','sale':'ON SALE' };
const descs = { 'all':'Every drop, every fit.','new':'Fresh ink, just dropped.','anime':'Anime-inspired art on premium cotton. Each piece is unique — one size, one chance.','graphic-tees':'Original graphic designs on premium cotton.','pants':'Relaxed, everyday fits to match the drops.','sale':'Limited-time markdowns. When it\'s gone, it\'s gone.' };
      document.getElementById('collectionTitle').textContent = titles[filter] || titles.all;
      document.getElementById('collectionDesc').textContent = descs[filter] || '';
      const eb = document.getElementById('shopEyebrow');
      if (eb) eb.textContent = (filter === 'all' || filter === 'new') ? 'Fresh Ink' : 'Curated Drop';
      document.querySelectorAll('.nav-links a[data-nav]').forEach(a => {
        a.classList.toggle('active', a.dataset.nav === currentCollectionFilter);
      });
      renderCollectionGrid();
    }

    // ---------- Filtering ----------
    function getFilteredProducts() {
      const filter = currentCollectionFilter;
      const hasSearch = searchQuery.trim() !== '';
      let f = [...allProducts];
      if (filter && filter !== 'all' && !hasSearch) {
        if (filter === 'new') f = f.slice(0, 8);
        else if (filter === 'sale') f = f.filter(p => p.on_sale || (p.sale_price && p.sale_price < p.price));
        else if (['anime','graphic-tees','pants'].includes(filter)) f = f.filter(p => p.collection === filter);
      }
      if (hasSearch) {
        const q = searchQuery.trim().toLowerCase();
        f = f.filter(p => [
          p.name,
          p.desc,
          p.fit,
          p.collection,
          CATEGORY_NAMES[p.collection],
          p.style
        ].filter(Boolean).join(' ').toLowerCase().includes(q));
      }
      if (wishlistOnly) f = f.filter(p => wishlist.has(p.id));
      if (filterState.cats.size > 0 && filterState.cats.size < 3) {
        f = f.filter(p => filterState.cats.has(p.style));
      }
      f = f.filter(p => {
        const r = getPriceRange(p);
        return r.max >= filterState.priceMin && r.min <= filterState.priceMax;
      });
      if (filterState.size) f = f.filter(p => p.sizes && p.sizes.includes(filterState.size));
      const sort = document.getElementById('sortSelect').value;
      if (sort === 'price-low') f.sort((a,b) => getPriceRange(a).min - getPriceRange(b).min);
      else if (sort === 'price-high') f.sort((a,b) => getPriceRange(b).min - getPriceRange(a).min);
      else if (sort === 'newest') f.sort((a,b) => b.id - a.id);
      return f;
    }

    function countActiveFilters() {
      let c = 0;
      if (filterState.cats.size > 0 && filterState.cats.size < 3) c += 3 - filterState.cats.size;
      if (filterState.priceMin > 0 || filterState.priceMax < 10000) c += 1;
      if (filterState.size) c += 1;
      return c;
    }

    function renderCollectionGrid() {
      const filtered = getFilteredProducts();
      const grid = document.getElementById('collectionGrid');
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      currentPage = Math.min(currentPage, totalPages);
      const start = (currentPage - 1) * perPage;
      const pageItems = filtered.slice(start, start + perPage);

      document.getElementById('resultCount').textContent = total + ' result' + (total !== 1 ? 's' : '');
      document.getElementById('filterBadge').textContent = countActiveFilters();

      const progress = total > 0 ? ((start + pageItems.length) / total) * 100 : 100;
      document.getElementById('progressFill').style.width = Math.min(100, progress) + '%';
      document.getElementById('pageInfo').textContent = 'Page ' + currentPage + ' of ' + totalPages;
      document.getElementById('nextBtn').style.display = currentPage < totalPages ? 'flex' : 'none';

      // A category is empty only when there are no matching products.
      // Sold-out products remain browsable, including when every item is sold out.
      const isBrowsingCategory = currentCollectionFilter && ['anime','graphic-tees','pants','sale'].includes(currentCollectionFilter) && !searchQuery.trim() && !wishlistOnly && filterState.cats.size === 3 && filterState.priceMin === 0 && filterState.priceMax === 10000 && !filterState.size;
      if (isBrowsingCategory && filtered.length === 0) {
        const name = CATEGORY_NAMES[currentCollectionFilter] || currentCollectionFilter;
        grid.innerHTML = '<div class="no-results"><p>No ' + esc(name.toLowerCase()) + ' available right now.</p><p style="font-size:0.8rem;margin-top:0.5rem;color:var(--text-gray);">Check back soon for new drops.</p><p style="margin-top:1rem;"><button class="btn btn-primary btn-sm" data-route="collection" data-filter="all">Browse all shirts</button></p></div>';
        document.getElementById('resultCount').textContent = '0 results';
        document.getElementById('pageInfo').textContent = 'Page 1 of 1';
        document.getElementById('nextBtn').style.display = 'none';
        return;
      }
      if (pageItems.length === 0) {
        grid.innerHTML = '<div class="no-results"><p>No products match your filters.</p><p style="font-size:0.8rem;margin-top:0.5rem;color:var(--text-gray);">Try adjusting your selections.</p></div>';
        return;
      }

      // Same cards as the home Best Sellers: one shared renderer (renderProductCard).
      grid.innerHTML = pageItems.map(renderProductCard).join('');
      prioritizeFirstVisibleProductImage(grid);
    }

    function nextPage() {
      const total = getFilteredProducts().length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      if (currentPage < totalPages) { currentPage++; renderCollectionGrid(); window.scrollTo({ top: document.getElementById('collectionGrid').offsetTop - 80, behavior: 'auto' }); }
    }

    // ---------- Search ----------
    // ---------- Desktop header search: icon button opens the field (≥1024px) ----------
    function setDesktopSearch(open) {
      const header = document.getElementById('siteHeader');
      const btn = document.getElementById('searchToggle');
      const input = document.getElementById('searchInput');
      if (!header || !btn || !input) return;
      header.classList.toggle('search-open', open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) input.focus();
    }
    function toggleDesktopSearch() {
      const header = document.getElementById('siteHeader');
      setDesktopSearch(!(header && header.classList.contains('search-open')));
    }
    // Escape closes the field when it is empty and returns focus to the icon button
    function searchKeydown(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        onSearchInput(e.target.value);
        e.target.blur();
        if (e.target.value && e.target.value.trim()) {
          window.scrollTo({ top: 0, behavior: 'auto' });
        }
      } else if (e.key === 'Escape' && !e.target.value) {
        setDesktopSearch(false);
        const btn = document.getElementById('searchToggle');
        if (btn) btn.focus();
      }
    }
    function submitMobileSearch(e) {
      if (e) e.preventDefault();
      const input = document.getElementById('mobileSearch');
      const val = input ? input.value : searchQuery;
      onSearchInput(val);
      closeMenu();
      if (input) input.blur();
      if (val && val.trim()) {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    }
    function mobileSearchKeydown(e) {
      if (e.key === 'Enter') {
        submitMobileSearch(e);
      } else if (e.key === 'Escape') {
        closeMenu();
      }
    }
    // Blur closes the field when it is empty (focus staying in the header, e.g. on the icon button, keeps it open)
    function searchBlur() {
      setTimeout(() => {
        const header = document.getElementById('siteHeader');
        const input = document.getElementById('searchInput');
        if (!header || !input) return;
        if (!input.value && !header.contains(document.activeElement)) setDesktopSearch(false);
      }, 0);
    }

    function onSearchInput(v) {
      searchQuery = v || '';
      document.querySelectorAll('#searchInput, #mobileSearch').forEach(inp => {
        if (inp && inp.value !== searchQuery) inp.value = searchQuery;
      });
      currentPage = 1;
      if (searchQuery.trim() && !document.getElementById('page-home').classList.contains('active')) navigateTo('home', null, { keepSearch: true });
      // Typing shows the grid with the results; clearing the box on the plain
      // homepage brings the marketing sections back.
      applyShopVisibility();
      renderCollectionGrid();
    }

    // ---------- Wishlist ----------
    function toggleWishlist(id, el) {
      var saved = !wishlist.has(id);
      if (saved) wishlist.add(id); else wishlist.delete(id);
      if (el) {
        el.classList.toggle('active', saved);
        if (saved) {  // pop only when saving, not when unsaving or re-rendering
          el.classList.remove('pop');
          void el.offsetWidth;  // restart the animation on rapid re-saves
          el.classList.add('pop');
        } else {
          el.classList.remove('pop');
        }
      }
      document.getElementById('wishlistCount').textContent = wishlist.size;
      var wName = (allProducts.find(function (x) { return x.id === id; }) || {}).name || 'Product';
      announce(saved ? 'Saved ' + wName + ' to favourites.' : 'Removed ' + wName + ' from favourites.');
      persistShopState();
      if (wishlistOnly) renderCollectionGrid();
      // Saving a product shows the favourites list so the user sees it was added.
      if (saved) toggleWishlistFilter(true);
    }
    function toggleWishlistFilter(force) {
      var overlay = document.getElementById('wishlistOverlay');
      var drawer = document.getElementById('wishlistDrawer');
      var isOpen = drawer.classList.contains('open');
      var wantOpen = typeof force === 'boolean' ? force : !isOpen;
      if (wantOpen === isOpen) return;
      if (wantOpen && document.getElementById('cartDrawer').classList.contains('open')) toggleCart(false);
      if (isOpen) {
        overlay.classList.remove('open');
        drawer.classList.remove('open');
        document.body.style.overflow = '';
        drawer._previousFocus?.focus();
      } else {
        drawer._previousFocus = document.activeElement;
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-modal', 'true');
        drawer.setAttribute('aria-label', 'Favourites');
        document.body.style.overflow = 'hidden';
        overlay.classList.add('open');
        drawer.classList.add('open');
        renderWishlistDrawer();
        setTimeout(() => drawer.querySelector('.cart-close')?.focus(), 100);
      }
    }
    function renderWishlistDrawer() {
      var container = document.getElementById('wishlistItems');
      if (wishlist.size === 0) {
        container.innerHTML = '<div class="cart-empty"><span class="cart-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></span>No favourite picks yet.<br><span style="font-size:0.75rem;margin-top:0.3rem;display:block;">Tap the heart icon on any product to save it here.</span></div>';
        return;
      }
      var html = '';
      wishlist.forEach(function(id) {
        var p = allProducts.find(function(x) { return x.id === id; });
        if (!p) return;
        var img = (p.images && p.images[0]) || p.image || '';
        var available = anySizeAvailable(p);
        html += '<div class="cart-item"><div class="cart-item-image">' + (img ? '<img src="' + esc(img) + '" alt="' + esc(p.name) + '" />' : '') + '</div><div class="cart-item-info"><h4>' + esc(p.name) + '</h4><div class="cart-item-meta">' + esc(p.fit || '') + (available ? '' : ' · Sold Out — unavailable') + '</div><div class="cart-item-price">Rs. ' + (p.sale_price || p.price) + '</div></div><div style="display:flex;flex-direction:column;gap:0.3rem;"><button class="btn btn-sm btn-outline"' + (available ? '' : ' disabled') + ' data-action="quick-add" data-pid="' + p.id + '" style="font-size:0.7rem;">' + (available ? 'Add to Cart' : 'Sold Out') + '</button><button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.7rem;min-height:36px;" data-action="wishlist-remove" data-pid="' + p.id + '">Remove</button></div></div>';
      });
      container.innerHTML = html;
    }

    // ---------- Quick add ----------
    function quickAdd(id) {
      const p = allProducts.find(x => x.id === id);
      if (!p) return;
      if (!anySizeAvailable(p)) { showToast(p.name + ' is currently out of stock.'); return; }
      const size = defaultSizeFor(p);
      if (addToCart(p, size, 1)) showToast(p.name + ' added to cart (' + size + ')');
    }
    // Screen-reader announcements (A11Y-3): every toast is mirrored into the
    // visually-hidden live region. Clearing first and settling on a timer
    // re-announces even when the same message repeats back-to-back.
    function announce(msg) {
      var el = document.getElementById('srAnnounce');
      if (!el || !msg) return;
      clearTimeout(announce._tm);
      el.textContent = '';
      announce._tm = setTimeout(function () { el.textContent = msg; }, 50);
    }
    function showToast(msg) {
      announce(msg);
      let t = document.getElementById('toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast';
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(showToast._tm);
      showToast._tm = setTimeout(() => t.classList.remove('show'), 2200);
    }

    // ---------- Newsletter (real API) ----------
    async function subscribeNewsletter(e) {
      e.preventDefault();
      const form = e.target;
      const input = form.querySelector('input[type=email]');
      const msg = form.parentElement.querySelector('.newsletter-msg') || document.getElementById('newsletterMsg');
      if (!input || !input.value.trim()) return;
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: input.value.trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (msg) {
            msg.textContent = data.message || 'Welcome to the clan! Stay tuned for restock alerts and early drop access.';
            if (data.unsubscribe_url) {
              // Private one-click link (CONTENT-2): shown once, to whoever
              // holds the inbox. Bookmark it — it is the self-service exit.
              const link = document.createElement('a');
              link.href = data.unsubscribe_url;
              link.textContent = 'Private unsubscribe link (bookmark this page to leave anytime)';
              link.style.cssText = 'display:block;margin-top:0.4rem;font-size:0.7rem;color:var(--text-muted);';
              msg.appendChild(link);
            }
          }
          input.value = '';
        } else {
          if (msg) msg.textContent = data.error || 'Something went wrong. Try again.';
        }
      } catch (err) {
        if (msg) msg.textContent = 'Connection error. Please try again.';
      }
    }

    async function notifyMe(e) {
      e.preventDefault();
      const email = document.getElementById('comingSoonEmail');
      const cat = document.getElementById('comingSoonCategory');
      const msg = document.getElementById('comingSoonMsg');
      if (!email || !email.value.trim()) return;
      if (msg) { msg.textContent = ''; msg.className = 'coming-soon-msg'; }
      try {
        const res = await fetch('/api/coming-soon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.value.trim(), category: cat ? cat.value : '' })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (msg) msg.textContent = data.message || "You're on the list! We'll let you know when this drop lands.";
          email.value = '';
        } else {
          if (msg) msg.textContent = data.error || 'Something went wrong. Try again.';
        }
      } catch (err) {
        if (msg) msg.textContent = 'Connection error. Please try again.';
      }
    }

    // ---------- HOMEPAGE SECTION LOADERS ----------

    // ---------- THE product card ----------
    // Every product grid renders its cards through this ONE function: the home
    // Best Sellers and Recently Viewed, the product page's related items and the
    // /collection/* + search grid (#collectionGrid). All of those grids carry the
    // `product-grid` class, so a card has a single markup and a single set of CSS
    // wherever it shows up — change it here and every grid follows.
    function renderProductCard(p) {
      const imgs = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
      const img = imgs[0] || '';
      const range = getPriceRange(p);
      const discount = (range.onSale && range.max > 0)
        ? Math.round((1 - range.min / range.max) * 100)
        : 0;
      // Each amount is its own unit (see .amt / .original / .sale in the CSS), so on a
      // narrow card the price wraps between amounts, never inside one.
      const priceHtml = range.isRange
        ? `<span class="amt">Rs. ${fmt(range.min)} —</span> <span class="amt">Rs. ${fmt(range.max)}</span>`
        : range.onSale
          ? `<span class="original">Rs. ${fmt(range.max)}</span> <span class="sale">Rs. ${fmt(range.min)}</span>`
          : `Rs. ${fmt(range.min)}`;
      const isWishlisted = wishlist && wishlist.has(p.id);
      return `
        <div class="product-card" data-pid="${p.id}" role="link" tabindex="0" aria-label="View ${esc(p.name)}" data-action="open-product" data-pid="${p.id}" data-key="enter">
          <div class="product-card-image${anySizeAvailable(p) ? '' : ' sold-out'}">
            ${img ? `<img src="${esc(img)}" alt="${esc(p.name)}" width="600" height="800" sizes="(max-width: 768px) calc((100vw - 40px) / 2), (max-width: 1024px) calc((100vw - 80px) / 3), (max-width: 1279px) calc((100vw - 112px) / 4), 296px" loading="lazy" decoding="async" />` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:0.8rem;">No Image</div>`}
            <button class="product-wishlist ${isWishlisted ? 'active' : ''}" data-action="toggle-wish" data-pid="${p.id}" aria-label="Wishlist">
              ${HEART_SVG}
            </button>
            ${discount > 0 ? `<span class="product-discount-badge">-${discount}%</span>` : ''}
            ${anySizeAvailable(p) ? lowStockBadge(p) : '<span class="sale-flag">SOLD OUT</span>'}
          </div>
          <div class="product-card-body">
            <h3>${esc(p.name)}</h3>
            <p class="fit-label">${esc(p.fit || p.category || '')}</p>
            <div class="card-rating">${starsHtml(p.rating, p.review_count)}</div>
            <p class="price">
              ${priceHtml}
            </p>
            <button class="quick-view-btn" data-action="open-product" data-pid="${p.id}">Quick View</button>
          </div>
        </div>`;
    }
    function prioritizeFirstVisibleProductImage(grid) {
      if (!grid || !grid.getClientRects().length) return;
      if (/^\/product\//.test(location.pathname) && grid.closest('#page-home')) return;
      const image = [...grid.querySelectorAll('.product-card-image img')].find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      });
      if (!image) return;
      image.setAttribute('fetchpriority', 'high');
    }

    // The renderer used to be home-only; the old name still points at it.
    window.renderHomeProductCard = renderProductCard;

    // Load Best Sellers (sorted by order count if available, else newest)
    function loadBestSellers() {
      const grid = document.getElementById('bestSellersGrid');
      if (!grid) return;
      const sorted = [...allProducts].sort((a, b) => {
        const oa = a.order_count || 0;
        const ob = b.order_count || 0;
        if (ob !== oa) return ob - oa;
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      }).slice(0, 8);
      grid.innerHTML = sorted.map(renderProductCard).join('');
      prioritizeFirstVisibleProductImage(grid);
    }

    // Initialize all homepage sections after products load
    function initHomePageSections() {
      loadBestSellers();
      loadRecentlyViewed();
    }

    // ---------- Filter panel (sidebar + drawer share one markup) ----------
    function filterPanelHTML() {
      return `
        <div class="filter-section" data-group="cats">
          <button class="filter-head" type="button" data-action="filter-section"><span>Category</span><span class="chev">▾</span></button>
          <div class="filter-body filter-checkboxes">
            <label class="filter-checkbox"><input type="checkbox" class="fp-cat" value="Anime-Inspired" /> Anime-Inspired</label>
            <label class="filter-checkbox"><input type="checkbox" class="fp-cat" value="Japanese Art" /> Japanese Art</label>
            <label class="filter-checkbox"><input type="checkbox" class="fp-cat" value="Typography" /> Typography</label>
          </div>
        </div>
        <div class="filter-section" data-group="price">
          <h4>Price Range</h4>
          <div class="price-display">
            <span class="price-min-display">Rs. 0</span>
            <span class="price-max-display">Rs. 10,000</span>
          </div>
          <div class="slider-container">
            <div class="slider-track"></div>
            <div class="slider-range"></div>
            <input type="range" class="price-min" min="0" max="10000" value="0" step="50" />
            <input type="range" class="price-max" min="0" max="10000" value="10000" step="50" />
          </div>
        </div>
        <div class="filter-section" data-group="size">
          <h4>Size</h4>
          <select class="sort-select fp-size">
            <option value="">All Sizes</option>
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
            <option value="XL">XL</option>
            <option value="XXL">XXL</option>
          </select>
        </div>
        <button class="btn btn-outline btn-sm" data-action="reset-filters" style="width:100%;margin-top:0.25rem;">Reset Filters</button>`;
    }

    function readFiltersFromPanel(panel) {
      filterState.cats = new Set([...panel.querySelectorAll('.fp-cat:checked')].map(cb => cb.value));
      const mn = panel.querySelector('.price-min'), mx = panel.querySelector('.price-max');
      if (mn && mx) { filterState.priceMin = parseInt(mn.value); filterState.priceMax = parseInt(mx.value); }
      const sz = panel.querySelector('.fp-size');
      if (sz) filterState.size = sz.value;
    }

    function updateSliderVisuals(panel) {
      const mn = panel.querySelector('.price-min'), mx = panel.querySelector('.price-max'), r = panel.querySelector('.slider-range');
      if (!mn || !mx || !r) return;
      const min = parseInt(mn.value), max = parseInt(mx.value);
      const tot = parseInt(mn.max) - parseInt(mn.min);
      r.style.left = ((min - parseInt(mn.min)) / tot * 100) + '%';
      r.style.width = ((max - parseInt(mn.min)) / tot * 100 - (min - parseInt(mn.min)) / tot * 100) + '%';
      const mnd = panel.querySelector('.price-min-display'), mxd = panel.querySelector('.price-max-display');
      if (mnd) mnd.textContent = 'Rs. ' + min;
      if (mxd) mxd.textContent = 'Rs. ' + max;
    }

    function syncFiltersToPanels() {
      document.querySelectorAll('.filter-panel').forEach(panel => {
        panel.querySelectorAll('.fp-cat').forEach(cb => cb.checked = filterState.cats.has(cb.value));
        const mn = panel.querySelector('.price-min'), mx = panel.querySelector('.price-max');
        if (mn && mx) { mn.value = filterState.priceMin; mx.value = filterState.priceMax; }
        const sz = panel.querySelector('.fp-size');
        if (sz) sz.value = filterState.size;
        updateSliderVisuals(panel);
      });
    }

    function toggleFilterSection(btn) {
      const sec = btn.closest('.filter-section');
      if (sec) sec.classList.toggle('collapsed');
    }

    function setupFilters() {
      const sidebar = document.getElementById('filterSidebar');
      const drawerBody = document.getElementById('filterDrawerBody');
      if (sidebar) sidebar.innerHTML = filterPanelHTML();
      if (drawerBody) drawerBody.innerHTML = filterPanelHTML();

      document.addEventListener('change', function(e) {
        const panel = e.target.closest('.filter-panel');
        if (!panel) return;
        const t = e.target;
        if (t.classList.contains('fp-cat') || t.classList.contains('fp-size') || t.classList.contains('price-min') || t.classList.contains('price-max')) {
          readFiltersFromPanel(panel);
          syncFiltersToPanels();
          renderCollectionGrid();
        }
      });
      document.addEventListener('input', function(e) {
        const t = e.target;
        if (t.classList.contains('price-min') || t.classList.contains('price-max')) {
          const panel = t.closest('.filter-panel');
          if (!panel) return;
          const mn = panel.querySelector('.price-min'), mx = panel.querySelector('.price-max');
          if (mn && mx) {
            if (parseInt(mn.value) > parseInt(mx.value)) {
              if (t.classList.contains('price-min')) mn.value = mx.value;
              else mx.value = mn.value;
            }
          }
          updateSliderVisuals(panel);
        }
      });
      const sort = document.getElementById('sortSelect');
      if (sort) sort.addEventListener('change', () => renderCollectionGrid());
      syncFiltersToPanels();
    }

    function resetFilters() {
      filterState.cats = new Set(['Anime-Inspired', 'Japanese Art', 'Typography']);
      filterState.priceMin = 0;
      filterState.priceMax = 10000;
      filterState.size = '';
      filterState.sort = 'featured';
      wishlistOnly = false;
      const wn = document.getElementById('wishlistNav');
      if (wn) wn.classList.remove('active');
      const sort = document.getElementById('sortSelect');
      if (sort) sort.value = 'featured';
      document.querySelectorAll('#searchInput, #mobileSearch').forEach(inp => { if (inp) inp.value = ''; });
      searchQuery = '';
      applyShopVisibility();
      syncFiltersToPanels();
      renderCollectionGrid();
    }

    // ---------- Filter drawer (mobile) ----------
    function openFilterDrawer() {
      const drawer = document.getElementById('filterDrawer');
      drawer._previousFocus = document.activeElement;
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.setAttribute('aria-label', 'Filter products');
      document.getElementById('filterDrawer').classList.add('open');
      document.getElementById('filterOverlay').classList.add('open');
      document.body.style.overflow = 'hidden';
      const firstInput = drawer.querySelector('input, button, select, [tabindex]');
      if (firstInput) setTimeout(() => firstInput.focus(), 100);
    }
    function closeFilterDrawer() {
      const drawer = document.getElementById('filterDrawer');
      document.getElementById('filterDrawer').classList.remove('open');
      document.getElementById('filterOverlay').classList.remove('open');
      document.body.style.overflow = '';
      if (drawer._previousFocus && drawer._previousFocus.focus) {
        drawer._previousFocus.focus();
      }
    }

    // Detail page
    function openProductDetail(productId) {
      const p = allProducts.find(x => x.id === productId);
      if (!p) return;
      if (currentProduct && currentProduct.id !== p.id) {
        // A draft rating/order belongs to the previous product, not this one.
        document.querySelector('.review-form').reset();
        window.resetStarInput();
      }
      // A stale "Thanks for your review" from an earlier visit must not show
      // before any review is submitted on this page view.
      document.getElementById('rvError').style.display = 'none';
      currentProduct = p; detailQty = 1; detailSize = defaultSizeFor(p); detailAngle = 0;
      navigateTo('product');
      document.getElementById('detailName').textContent = p.name;
      document.getElementById('detailPrice').innerHTML = detailPriceHtml(p);
      document.getElementById('stickyPrice').textContent = 'Rs. ' + fmt(getPriceRange(p).min);
      document.getElementById('detailDesc').textContent = p.desc;
      document.getElementById('detailUrgency').innerHTML = '';
      document.getElementById('detailRating').innerHTML = p.review_count > 0
        ? `${starsOnlyHtml(p.avg_rating)} <span class="rating-avg">${Number(p.avg_rating).toFixed(1)}</span> <span class="rating-count">(${p.review_count} review${p.review_count > 1 ? 's' : ''})</span>`
        : '<span class="review-no">No reviews yet</span>';
      renderUrgency(p);
      trackRecentlyViewed(p.id);
      renderRelated(p);
      loadReviews(p.id);
      document.getElementById('detailQty').textContent = '1';
      const track = document.getElementById('galleryTrack');
      track.innerHTML = p.images.map((img,i) => `<img src="${esc(img)}" alt="${esc(p.name)} view ${i+1}" width="900" height="1200" sizes="(max-width: 768px) 92vw, (max-width: 1279px) 45vw, 600px" loading="${i>0?'lazy':'eager'}" decoding="async"${i===0?' fetchpriority="high"':''} />`).join('');
      track.style.transform = 'translateX(0)';
      const dc = document.getElementById('detailDots');
      if (p.images.length > 1) {
        dc.innerHTML = p.images.map((_,i) => `<button type="button" class="detail-dot ${i===0?'active':''}" data-idx="${i}" aria-label="Go to image ${i+1}"></button>`).join('');
        dc.style.display = 'flex';
      } else dc.style.display = 'none';
      const th = document.getElementById('detailThumbnails');
      th.innerHTML = p.images.map((img,i) => `<div class="detail-thumb ${i===0?'active':''}" role="button" tabindex="0" aria-label="View image ${i+1}" data-action="detail-angle" data-index="${i}" data-key><img src="${esc(img)}" alt="View ${i+1}" width="56" height="56" sizes="56px" loading="lazy" decoding="async" /></div>`).join('');
      renderSizePicker(p);
      setupGallerySwipe();
      renderDetailAvailability(p);
    }

    function renderDetailAvailability(p) {
      // Reflect stock state on both Add-to-Cart buttons (main + sticky bar)
      const mainBtn = document.getElementById('addToCartBtn');
      const stickyBtn = document.querySelector('#stickyCartBar .btn');
      const oos = !anySizeAvailable(p);
      [mainBtn, stickyBtn].forEach(b => {
        if (!b) return;
        b.disabled = oos;
        b.textContent = oos ? 'Sold Out' : 'Add to Cart';
      });
      document.querySelectorAll('#page-product .qty-btn').forEach(b => { b.disabled = oos; });
    }

    function switchDetailAngle(index) {
      if (!currentProduct || index < 0 || index >= currentProduct.images.length) return;
      detailAngle = index;
      document.getElementById('galleryTrack').style.transform = `translateX(-${index * 100}%)`;
      document.querySelectorAll('#detailDots .detail-dot').forEach((d,i) => d.classList.toggle('active', i === index));
      document.querySelectorAll('#detailThumbnails .detail-thumb').forEach((t,i) => t.classList.toggle('active', i === index));
    }
    // Dot + thumbnail clicks are delegated — dots are real <button>s now (a11y).
    document.addEventListener('click', (e) => {
      const dot = e.target.closest('#detailDots .detail-dot');
      if (dot) switchDetailAngle(parseInt(dot.dataset.idx, 10));
    });

    function detailChangeQty(d) {
      if (!currentProduct || !anySizeAvailable(currentProduct)) return;
      const cap = currentProduct ? Math.max(1, maxQtyFor(currentProduct, detailSize)) : 99;
      detailQty = Math.max(1, Math.min(cap, detailQty + d));
      document.getElementById('detailQty').textContent = detailQty;
    }
    function detailAddToCart() { if (currentProduct) addToCart(currentProduct, detailSize, detailQty); }

    // Size picker on the product page. One size is shown as plain text; several
    // sizes become selectable buttons, with sold-out sizes disabled.
    function renderSizePicker(p) {
      const block = document.getElementById('detailSizeBlock');
      const picker = document.getElementById('detailSizePicker');
      const note = document.getElementById('detailSizeNote');
      if (!block || !picker || !note) return;
      const sizes = (p.sizes && p.sizes.length) ? p.sizes : ['L'];
      // Stickers are sold as "One Size" — nothing to choose, so the block is hidden.
      const oneSizeOnly = sizes.length === 1 && sizes[0] === 'One Size';
      block.style.display = oneSizeOnly ? 'none' : '';
      if (oneSizeOnly) { picker.innerHTML = ''; note.textContent = ''; return; }
      if (sizes.length === 1) {
        picker.innerHTML = `<div class="size-single">${esc(sizes[0])}</div>`;
        note.textContent = sizeAvailable(p, sizes[0]) ? 'This is the only size available for this piece.' : 'Sold Out';
        return;
      }
      picker.innerHTML = sizes.map((s, i) => {
        const avail = sizeAvailable(p, s);
        const selected = s === detailSize;
        return `<div class="size-option"><button type="button" class="size-btn${selected ? ' selected' : ''}" data-size="${esc(s)}" aria-pressed="${selected}"${avail ? '' : ' disabled aria-describedby="detailSizeStatus' + i + '"'} title="${avail ? esc(s) : 'Sold out in ' + esc(s)}">${esc(s)}</button><span class="size-stock-status" id="detailSizeStatus${i}">${avail ? '' : 'Sold Out'}</span></div>`;
      }).join('');
      const left = sizeQty(p, detailSize);
      note.textContent = !anySizeAvailable(p) ? 'Sold Out' : (left != null && left > 0 && left <= 5) ? `Only ${left} left in size ${detailSize}` : '';
    }
    function selectDetailSize(size) {
      if (!currentProduct || !(currentProduct.sizes || []).includes(size) || !sizeAvailable(currentProduct, size)) return;
      detailSize = size;
      detailQty = Math.max(1, Math.min(detailQty, maxQtyFor(currentProduct, size)));
      document.getElementById('detailQty').textContent = detailQty;
      renderSizePicker(currentProduct);
    }
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('#detailSizePicker .size-btn');
      if (btn && !btn.disabled) selectDetailSize(btn.dataset.size);
    });

    let lastGallerySwipe = 0; // set after a real swipe so the zoom click is skipped

    // Tap/click the main image to open a full-screen zoom of the current angle.
    function openImageZoom() {
      if (!currentProduct) return;
      const src = currentProduct.images[detailAngle];
      if (!src) return;
      const overlay = document.getElementById('imageZoomOverlay');
      const img = document.getElementById('zoomImage');
      if (!overlay || !img) return;
      img.src = src;
      img.alt = currentProduct.name + ' — enlarged view';
      overlay._previousFocus = document.activeElement;
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      const closeBtn = overlay.querySelector('.zoom-close');
      if (closeBtn && closeBtn.focus) closeBtn.focus({ preventScroll: true });
    }
    function closeImageZoom() {
      const overlay = document.getElementById('imageZoomOverlay');
      if (!overlay || overlay.hidden) return;
      overlay.hidden = true;
      document.body.style.overflow = '';
      overlay._previousFocus?.focus();
    }
    // Escape (or a tap on the dark backdrop) closes the zoom view.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeImageZoom();
    });

    function setupGallerySwipe() {
      const el = document.getElementById('detailMainImage');
      if (el._swipeSetup) return;
      el._swipeSetup = true;
      let sx = 0, sy = 0, drag = false, ct = 0;
      const tk = document.getElementById('galleryTrack');
      el.addEventListener('touchstart', function(e) {
        if (!currentProduct || currentProduct.images.length <= 1) return;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY; drag = true;
        ct = -detailAngle * el.offsetWidth; tk.style.transition = 'none';
      }, { passive: true });
      el.addEventListener('touchmove', function(e) {
        if (!drag) return;
        const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
        if (Math.abs(dx) < Math.abs(dy)) return;
        e.preventDefault();
        tk.style.transform = `translateX(${ct + dx}px)`;
      }, { passive: false });
      el.addEventListener('touchend', function(e) {
        if (!drag || !currentProduct) return;
        drag = false; tk.style.transition = 'transform 0.25s ease';
        const dx = e.changedTouches[0].clientX - sx;
        const th = el.offsetWidth * 0.2;
        let na = detailAngle;
        if (dx < -th && detailAngle < currentProduct.images.length - 1) na = detailAngle + 1;
        else if (dx > th && detailAngle > 0) na = detailAngle - 1;
        if (Math.abs(dx) > 10) lastGallerySwipe = Date.now(); // swipe, not a tap
        switchDetailAngle(na);
      }, { passive: true });
      // Tap/click opens the zoom view — suppressed right after a swipe.
      el.addEventListener('click', function () {
        if (Date.now() - lastGallerySwipe < 400) return;
        openImageZoom();
      });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openImageZoom(); }
      });
    }

    function switchTab(el) {
      document.querySelectorAll('.tab-header').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.getElementById('tab-' + el.dataset.tab).classList.add('active');
    }

    // ---------- Reviews & Ratings ----------
    // Per-browser token identifying "this reviewer". Sent with review
    // submissions and review fetches so a reviewer instantly sees their OWN
    // pending review (only on this device) while it awaits moderation.
    function getReviewViewerToken() {
      let token = '';
      try { token = localStorage.getItem('kageReviewViewerToken') || ''; } catch (e) { /* private mode */ }
      if (!token) {
        const bytes = new Uint8Array(24);
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        try { localStorage.setItem('kageReviewViewerToken', token); } catch (e) { /* private mode */ }
      }
      return token;
    }

    async function loadReviews(productId) {
      let reviews = [];
      try {
        const res = await fetch('/api/reviews?product_id=' + encodeURIComponent(productId), {
          headers: { 'X-Viewer-Token': getReviewViewerToken() }
        });
        if (res.ok) reviews = await res.json();
      } catch (e) { reviews = []; }
      const section = document.getElementById('reviewsSection');
      const list = document.getElementById('reviewsList');
      const summary = document.getElementById('reviewSummary');
      if (!section || !list || !summary) return;
      section.style.display = '';
      if (!reviews.length) {
        summary.innerHTML = '<span class="review-no">No reviews yet.</span>';
        list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-gray);">Be the first to share your experience.</p>';
        return;
      }
      const sorted = [...reviews].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      list.innerHTML = sorted.map(rv => {
        // A pending review only ever reaches the person who wrote it — flag it
        // so they know it is not public yet.
        const pending = rv.status === 'pending';
        return `
        <div class="review-item${pending ? ' pending-own' : ''}">
          <div class="review-head">
            <span class="review-name">${esc(rv.customer_name || 'Verified Buyer')}</span>
            <span class="review-stars">${starsOnlyHtml(Number(rv.rating))}</span>
            ${pending ? '<span class="review-pending-tag" title="Only you can see this review until it is approved">Awaiting approval &middot; only visible to you</span>' : ''}
            <span class="review-date">${esc(String(rv.created_at || '').slice(0, 10))}</span>
          </div>
          ${rv.comment ? `<p class="review-comment">${esc(rv.comment)}</p>` : ''}
        </div>`;
      }).join('');
    }

    async function submitReview(e) {
      e.preventDefault();
      const errEl = document.getElementById('rvError');
      if (!currentProduct) return;
      const selected = document.querySelector('#starInput button[aria-checked="true"]');
      const rating = selected ? Number(selected.dataset.v) : 0;
      const comment = document.getElementById('rvComment').value.trim();
      const order = document.getElementById('rvOrder').value.trim();
      const phone = document.getElementById('rvPhone').value.trim();
      const name = document.getElementById('rvName').value.trim();
      errEl.style.color = 'var(--accent)';
      if (!rating) { errEl.textContent = 'Please select a star rating.'; errEl.style.display = 'block'; return; }
      if (!order || !phone) { errEl.textContent = 'Enter the order number and phone from your delivered order.'; errEl.style.display = 'block'; return; }
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await fetch('/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_id: currentProduct.id, order_number: order, phone, rating, comment, name, viewer_token: getReviewViewerToken() })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          // Adopt the server's token if it minted one (e.g. first review
          // from a browser with storage disabled) so later fetches still
          // match the reviews this device submitted.
          if (data.viewer_token) { try { localStorage.setItem('kageReviewViewerToken', data.viewer_token); } catch (e2) { /* private mode */ } }
          e.target.reset();
          window.resetStarInput();
          errEl.style.color = '#1a7f37';
          errEl.textContent = data.message || 'Thanks for your review!';
          errEl.style.display = 'block';
          // Re-fetch immediately so the new review shows up for this person
          // right away — auto-approved (4–5★) for everyone, pending ones at
          // least for the author.
          loadReviews(currentProduct.id);
        } else {
          errEl.textContent = data.error || 'Something went wrong. Please try again.';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.textContent = 'Connection error. Please try again.';
        errEl.style.display = 'block';
      }
      btn.disabled = false;
    }

    // Star picker for the review form. ONE value drives the fill — the
    // committed rating, or a live preview while a pointer is down/hovering —
    // so the row always lights continuously from star 1 up to that value
    // (press-hold/drag on touch previews 1..N, release commits N). Stars are
    // a radiogroup: arrow keys move the selection, each star is a 44×44
    // target, and per-star :hover never paints on touch devices.
    (function () {
      const wrap = document.getElementById('starInput');
      if (!wrap) return;
      const stars = Array.from(wrap.querySelectorAll('button[data-v]'));
      let selected = 0; // committed rating
      let preview = 0;  // transient value while pointer is down or hovering
      let holding = false;
      let lastPointerSelect = 0;

      function render() {
        const fill = preview || selected;
        stars.forEach((b, i) => {
          b.classList.toggle('lit', i < fill);
          b.setAttribute('aria-checked', String(i + 1 === selected));
          // Roving tabindex: the selected star (or the first) receives Tab.
          b.tabIndex = (selected ? i + 1 === selected : i === 0) ? 0 : -1;
        });
      }
      // Which star a horizontal pointer position maps to (1..5).
      function starFromX(x) {
        for (let i = stars.length - 1; i >= 0; i--) {
          if (x >= stars[i].getBoundingClientRect().left) return i + 1;
        }
        return 1;
      }
      function commit(v) {
        selected = Math.max(0, Math.min(5, v));
        preview = 0;
        render();
      }

      wrap.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('button[data-v]')) return;
        holding = true;
        if (wrap.setPointerCapture) { try { wrap.setPointerCapture(e.pointerId); } catch (err) {} }
        preview = starFromX(e.clientX);
        render();
        e.preventDefault(); // stop text selection / synthetic mouse events
      });
      wrap.addEventListener('pointermove', (e) => {
        if (holding) { preview = starFromX(e.clientX); render(); return; }
        if (e.pointerType === 'mouse') { preview = starFromX(e.clientX); render(); }
      });
      wrap.addEventListener('pointerup', (e) => {
        if (!holding) return;
        holding = false;
        if (preview) commit(preview); else render();
        lastPointerSelect = Date.now();
        const target = stars[Math.max(0, selected - 1)];
        if (target && target.focus) target.focus({ preventScroll: true });
      });
      // Cancel the preview when the gesture is interrupted or the pointer
      // leaves without committing.
      wrap.addEventListener('pointercancel', () => { holding = false; preview = 0; render(); });
      wrap.addEventListener('pointerleave', () => { if (!holding) { preview = 0; render(); } });

      // Keyboard / assistive-tech activation (Enter/Space fire click).
      wrap.addEventListener('click', (e) => {
        const star = e.target.closest('button[data-v]');
        if (!star) return;
        if (Date.now() - lastPointerSelect < 500) return; // pointer flow already committed
        commit(Number(star.dataset.v));
      });
      wrap.addEventListener('keydown', (e) => {
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(5, (selected || 0) + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(1, (selected || 5) - 1);
        else if (e.key === 'Home') next = 1;
        else if (e.key === 'End') next = 5;
        else return;
        e.preventDefault();
        commit(next);
        const target = stars[next - 1];
        if (target && target.focus) target.focus({ preventScroll: true });
      });

      window.resetStarInput = function () {
        selected = 0; preview = 0; holding = false;
        render();
      };
      render();
    })();


    // ---------- Related products ("You might also like") ----------
    function getRelatedProducts(p, n) {
      n = n || 4;
      const others = allProducts.filter(x => x.id !== p.id);
      const sameCol = others.filter(x => x.collection === p.collection);
      const rank = (arr) => arr.slice().sort((a, b) =>
        Math.abs((a.price || 0) - (p.price || 0)) - Math.abs((b.price || 0) - (p.price || 0)));
      const out = [];
      const used = new Set();
      for (const x of rank(sameCol.length ? sameCol : others)) {
        if (out.length >= n) break;
        if (!used.has(x.id)) { out.push(x); used.add(x.id); }
      }
      if (out.length < n) {
        for (const x of rank(others)) {
          if (out.length >= n) break;
          if (!used.has(x.id)) { out.push(x); used.add(x.id); }
        }
      }
      return out.slice(0, n);
    }

    function renderRelated(p) {
      const grid = document.getElementById('relatedGrid');
      const section = document.getElementById('sectionRelated');
      if (!grid || !section) return;
      const rel = getRelatedProducts(p, 4);
      // Hide the whole section (padding included) when there is nothing to show.
      if (!rel.length) { section.style.display = 'none'; return; }
      section.style.display = '';
      grid.innerHTML = rel.map(renderProductCard).join('');
    }

    // ---------- Recently viewed (session localStorage) ----------
    function trackRecentlyViewed(id) {
      try {
        let arr = [];
        try { arr = JSON.parse(localStorage.getItem('kageRv') || '[]'); } catch (e2) {}
        arr = [id, ...arr.filter(x => String(x) !== String(id))].slice(0, 8);
        localStorage.setItem('kageRv', JSON.stringify(arr));
      } catch (e) {}
    }

    function loadRecentlyViewed() {
      const section = document.getElementById('sectionRecentlyViewed');
      const grid = document.getElementById('recentlyViewedGrid');
      if (!section || !grid) return;
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem('kageRv') || '[]'); } catch (e) {}
      const items = arr.map(id => allProducts.find(x => String(x.id) === String(id))).filter(Boolean);
      if (!items.length) { section.style.display = 'none'; return; }
      // Exclude products already shown in Best Sellers so the section isn't redundant.
      const bsGrid = document.getElementById('bestSellersGrid');
      if (bsGrid) {
        const bsIds = new Set();
        bsGrid.querySelectorAll('[data-pid]').forEach(el => bsIds.add(String(el.dataset.pid)));
        // Fallback: derive best-seller ids from the same sort used in loadBestSellers().
        if (!bsIds.size && allProducts.length) {
          const sorted = [...allProducts].sort((a, b) => {
            const oa = a.order_count || 0, ob = b.order_count || 0;
            if (ob !== oa) return ob - oa;
            const da = a.created_at ? new Date(a.created_at).getTime() : 0;
            const db = b.created_at ? new Date(b.created_at).getTime() : 0;
            return db - da;
          }).slice(0, 8);
          sorted.forEach(p => bsIds.add(String(p.id)));
        }
        const fresh = items.filter(p => !bsIds.has(String(p.id)));
        if (!fresh.length) { section.style.display = 'none'; return; }
        section.style.display = '';
        grid.innerHTML = fresh.map(renderProductCard).join('');
        return;
      }
      section.style.display = '';
      grid.innerHTML = items.map(renderProductCard).join('');
    }

    // ---------- Stock urgency (real inventory only) ----------
    function renderUrgency(p) {
      const el = document.getElementById('detailUrgency');
      if (!el) return;
      const bits = [];
      const s = p.stock_qty;
      if (anySizeAvailable(p) && s != null && s !== '' && s > 0 && s <= 5) bits.push(`<span class="urgency-low">🔥 Only ${s} left in stock</span>`);
      if (p.sold_count > 0) bits.push(`<span class="urgency-sold">${p.sold_count} sold</span>`);
      el.innerHTML = bits.join(' ');
    }

    // ---------- Order tracking ----------
    function goTrackOrder() {
      navigateTo('tracking');
      if (lastOrder) document.getElementById('trkNumber').value = lastOrder.order_number;
    }

    async function trackOrder(e) {
      e.preventDefault();
      const err = document.getElementById('trkError');
      const result = document.getElementById('trkResult');
      err.style.display = 'none';
      const number = document.getElementById('trkNumber').value.trim();
      const phone = document.getElementById('trkPhone').value.trim();
      if (!number || !phone) {
        err.textContent = 'Please enter both your order number and phone number.';
        err.style.display = 'block';
        return;
      }
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await fetch('/api/orders/track?number=' + encodeURIComponent(number) + '&phone=' + encodeURIComponent(phone));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          err.textContent = data.error || 'Could not find that order. Please check and try again.';
          err.style.display = 'block';
          result.style.display = 'none';  // don't leave a previous order's details on screen
          return;
        }
        renderTracking(data);
      } catch (err2) {
        err.textContent = 'Connection error. Please try again.';
        err.style.display = 'block';
        result.style.display = 'none';
      } finally {
        btn.disabled = false;  // was skipped on the !res.ok path — one failed lookup bricked the button
      }
    }

    // Human-readable status labels — the admin/backend statuses shown to
    // customers. `awaiting_verification` gets its own copy so customers who
    // paid via JazzCash/bank understand what's happening instead of seeing
    // "Pending" forever; cancelled shows as a red badge, not a timeline.
    const TRACK_STATUS_LABELS = {
      pending: 'Pending',
      awaiting_verification: 'Verifying payment',
      confirmed: 'Confirmed',
      shipped: 'Shipped',
      delivered: 'Delivered',
      cancelled: 'Cancelled'
    };

    function renderTracking(o) {
      // Cancelled orders have no journey — show a clear terminal state instead
      // of an active "Pending" timeline (old bug: indexOf → -1 → clamped to 0).
      if (o.status === 'cancelled') {
        document.getElementById('trkResult').innerHTML = `
          <div class="track-result">
            <div class="track-top">
              <strong>Order ${esc(o.order_number)}</strong>
              <span class="track-status track-status-cancelled">Cancelled</span>
            </div>
            <div class="track-details">
              <div><span>Placed</span><span>${esc(formatTrackDate(o.created_at))}</span></div>
              <div><span>Delivery charge</span><span>${o.status === 'cancelled' ? 'Not charged' : o.shipping_pending ? 'To be confirmed' : 'Rs. ' + fmt(o.shipping)}</span></div>
              <div><span>${o.shipping_pending || o.status === 'cancelled' ? 'Items subtotal' : 'Total'}</span><span>Rs. ${o.total}</span></div>
            </div>
            <div class="track-items">${(o.items || []).map(it => `
              <div class="conf-item">
                <span>${esc(it.name)}${it.size ? ' · Size ' + esc(it.size) : ''} × ${it.qty}</span>
                <span>Rs. ${it.total}</span>
              </div>`).join('')}</div>
            <p class="track-help">This order was cancelled. If you weren't expecting this or have questions about a refund, WhatsApp us at +92 322 804 2633 with your order number.</p>
          </div>`;
        document.getElementById('trkResult').style.display = 'block';
        return;
      }
      const steps = ['pending', 'confirmed', 'shipped', 'delivered'];
      // Payment-first orders (JazzCash/bank) sit in `awaiting_verification`
      // before `confirmed` — without this they clamped to 0 and rendered as
      // an active "Pending" step.
      const idx = o.status === 'awaiting_verification' ? 1 : Math.max(0, steps.indexOf(o.status));
      const stepLabel = (s) => TRACK_STATUS_LABELS[s] || s;
      const timeline = steps.map((s, i) => `
        <div class="track-step ${i < idx ? 'done' : ''} ${i === idx ? 'active' : ''}">
          <span class="track-dot">${i <= idx ? '✓' : ''}</span>
          <span class="track-label">${stepLabel(s)}</span>
        </div>`).join('');
      const items = (o.items || []).map(it => `
        <div class="conf-item">
          <span>${esc(it.name)}${it.size ? ' · Size ' + esc(it.size) : ''} × ${it.qty}</span>
          <span>Rs. ${it.total}</span>
        </div>`).join('');
      document.getElementById('trkResult').innerHTML = `
        <div class="track-result">
          <div class="track-top">
            <strong>Order ${esc(o.order_number)}</strong>
            <span class="track-status">${esc(TRACK_STATUS_LABELS[o.status] || o.status)}</span>
            ${o.status === 'awaiting_verification' ? '<p class="track-help" style="margin-top:0.4rem;">We\'re verifying your payment — this usually takes a few hours. You\'ll get a confirmation email once it\'s confirmed.</p>' : ''}
          </div>
          <div class="track-timeline">${timeline}</div>
          <div class="track-details">
            <div><span>Placed</span><span>${esc(formatTrackDate(o.created_at))}</span></div>
            <div><span>Payment</span><span>${o.payment_method === 'bank' ? 'Bank Transfer' : o.payment_method === 'jazzcash' ? 'JazzCash' : 'Cash on Delivery'}</span></div>
            <div><span>Delivery charge</span><span>${o.status === 'cancelled' ? 'Not charged' : o.shipping_pending ? 'To be confirmed' : 'Rs. ' + fmt(o.shipping)}</span></div>
              <div><span>${o.shipping_pending || o.status === 'cancelled' ? 'Items subtotal' : 'Total'}</span><span>Rs. ${o.total}</span></div>
          </div>
          <div class="track-items">${items}</div>
          <p class="track-help">${o.shipping_pending ? 'We will contact you about the delivery charges. ' : ''}Questions about your order? WhatsApp us at +92 322 804 2633 with your order number.</p>
        </div>`;
      document.getElementById('trkResult').style.display = 'block';
    }

    // "2026-09-25 09:41:12" (UTC, DB format) → "25 Sep 2026, 2:41 pm" in the
    // visitor's local time. DB times are UTC (ISO with T→space swap).
    function formatTrackDate(dbTime) {
      if (!dbTime) return '';
      const d = new Date(String(dbTime).replace(' ', 'T') + 'Z');
      if (isNaN(d.getTime())) return String(dbTime);  // fall back to raw
      return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    // Cart
    function addToCart(product, size, qty) {
      if (!productsLoadedFromApi) { showToast('Shop temporarily unavailable. Please retry loading products.'); return false; }
      if (!isAvailable(product)) { showToast(product.name + ' is currently out of stock.'); return false; }
      if (!sizeAvailable(product, size)) { showToast(product.name + ' is sold out in size ' + size + '.'); return false; }
      const cap = maxQtyFor(product, size);
      const e = cart.find(i => i.id === product.id && i.size === size);
      if (e) {
        if (e.qty + qty > cap) { showToast('Not enough stock available.'); return false; }
        e.qty += qty;
      } else {
        if (qty > cap) { showToast('Not enough stock available.'); return false; }
        cart.push({ ...product, size, qty: Math.min(99, qty) });
      }
      updateCartUI();
      announce(product.name + ' added to cart (' + size + ')');
      const badge = document.getElementById('cartCount');
      badge.classList.add('bump');
      setTimeout(() => badge.classList.remove('bump'), 300);
      toggleCart(true);  // show the cart list so the user sees what was added
      return true;
    }
    function updateCartUI() {
      const c = cart.reduce((s,i) => s + i.qty, 0);
      document.querySelector('#cartFooter button').disabled = !cart.length || cartHasUnavailableItems();
      persistShopState();
      document.getElementById('cartCount').textContent = c;
      const items = document.getElementById('cartItems'), footer = document.getElementById('cartFooter');
      if (!cart.length) { items.innerHTML = '<div class="cart-empty"><span class="cart-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></span><p>Your cart is empty.</p></div>'; footer.style.display = 'none'; return; }
      footer.style.display = 'flex';
      let sub = 0;
      items.innerHTML = cart.map((item,i) => {
        const unavailable = cartItemUnavailable(item);
        const t = item.price * item.qty; sub += t;
        return `<div class="cart-item"><div class="cart-item-image"><img src="${esc(item.images[0])}" alt="${esc(item.name)}" width="55" height="55" sizes="55px" loading="lazy" decoding="async" /></div><div class="cart-item-info"><h4>${esc(item.name)}</h4><div class="cart-item-meta">Size: ${esc(item.size)} · ${esc(item.fit)}${unavailable ? ' · Sold Out — unavailable' : ''}</div><div class="cart-item-price">Rs. ${t}</div></div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.3rem;"><div class="cart-item-qty"><button data-action="cart-qty" data-index="${i}" data-delta="-1"${unavailable ? ' disabled' : ''}>−</button><span>${item.qty}</span><button data-action="cart-qty" data-index="${i}" data-delta="1"${unavailable ? ' disabled' : ''}>+</button></div><button class="cart-item-remove" data-action="cart-remove" data-index="${i}">Remove</button></div></div>`;
      }).join('');
      document.getElementById('cartSubtotal').textContent = 'Rs. ' + fmt(sub);
    }
    function removeFromCart(i) { var n = cart[i] ? cart[i].name : 'Item'; cart.splice(i,1); updateCartUI(); announce('Removed ' + n + ' from cart.'); }
    function changeCartQty(i,d) {
      if (!cart[i] || cartItemUnavailable(cart[i])) { showToast('This item is unavailable. Remove it from your cart.'); return; }
      if (cart[i].qty + d <= 0) { removeFromCart(i); return; }
      if (cart[i].qty + d > maxQtyFor(cart[i], cart[i].size)) { showToast('Not enough stock available.'); return; }
      cart[i].qty += d; updateCartUI(); announce(cart[i].name + ' quantity ' + cart[i].qty + '.');
    }
    function toggleCart(force) {
      const o = document.getElementById('cartOverlay'), d = document.getElementById('cartDrawer');
      const open = typeof force === 'boolean' ? force : !d.classList.contains('open');
      if (open === d.classList.contains('open')) return;
      // Only one drawer at a time: opening the cart closes the favourites list.
      if (open && document.getElementById('wishlistDrawer').classList.contains('open')) toggleWishlistFilter(false);
      o.classList.toggle('open', open); d.classList.toggle('open', open);
      document.body.style.overflow = open ? 'hidden' : '';
      if (open) {
        d._previousFocus = document.activeElement;
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-modal', 'true');
        d.setAttribute('aria-label', 'Shopping cart');
        const closeBtn = d.querySelector('button[data-action="toggle-cart"]');
        if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
      } else if (d._previousFocus && d._previousFocus.focus) {
        d._previousFocus.focus();
      }
    }

    // Mobile menu
    const hamburger = document.getElementById('hamburger');
    const navLinks = document.getElementById('navLinks');
    let menuPreviousBodyOverflow = '';
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.setAttribute('aria-controls', 'navLinks');
    hamburger.setAttribute('aria-label', 'Open menu');
    function setMenuOpen(open) {
      const wasOpen = navLinks.classList.contains('open');
      if (open && !wasOpen) {
        menuPreviousBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      } else if (!open && wasOpen) {
        document.body.style.overflow = menuPreviousBodyOverflow;
        menuPreviousBodyOverflow = '';
      }
      navLinks.classList.toggle('open', open);
      hamburger.classList.toggle('active', open);
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    hamburger.addEventListener('click', () => setMenuOpen(!navLinks.classList.contains('open')));
    // FE-H2: the old navLinks click listener lived here. It fired during the
    // bubble phase — before the document-level route handler — which inverted
    // the original navigate-then-close order (navigateTo clears body overflow
    // via closeFilterDrawer, so closing first lost the menu's saved value).
    // Every menu link now carries data-close-menu and the delegated handler
    // closes after navigating, exactly like the old inline wiring.
    document.addEventListener('pointerdown', event => {
      if (!navLinks.classList.contains('open')) return;
      if (navLinks.contains(event.target) || hamburger.contains(event.target)) return;
      closeMenu();
    });
    function closeMenu() { setMenuOpen(false); }
    // Escape path for the trapped menu: closing returns focus to the trigger.
    function closeMenuAndRefocus() { closeMenu(); if (hamburger && hamburger.focus) hamburger.focus(); }

    // ================================================================
    // PARALLAX WATERMARK
    // ================================================================

    // Init
    // Load products from API (overrides hardcoded defaults when server is running)
    let lastProductsFetchAt = 0;
    let productsFetchInFlight = false;
    async function loadProductsFromAPI() {
      if (productsFetchInFlight) return;
      productsFetchInFlight = true;
      lastProductsFetchAt = Date.now();
      try {
        // Default HTTP cache mode: revalidate via Cache-Control/ETag, never
        // persist the catalog in localStorage/sessionStorage across visits.
        const res = await fetch('/api/products');
        if (!res.ok) throw new Error('Catalog request failed');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Invalid catalog');
        // Map server products onto the hardcoded catalog art by name so
        // seeded items keep their rich visuals (SVG tees) instead of grey tiles.
        const artByAlt = {};
        for (const p of allProducts) artByAlt[p.name.trim().toLowerCase()] = p;
        allProducts = data.map(p => {
          const imgs = [p.front_image, p.back_image, ...(p.extra_images || [])].filter(Boolean);
          const art = artByAlt[(p.name || '').trim().toLowerCase()];
          const effective = p.sale_price && p.sale_price < p.price ? p.sale_price : p.price;
          return {
            id: p.id,
            name: p.name,
            price: effective,
            original_price: p.price,
            fit: p.fit || 'Regular',
            collection: p.category,
            drop: p.drop || '',
            style: p.style || (art ? art.style : ['Anime-Inspired','Japanese Art','Typography'][Math.abs(p.id) % 3]),
            rating: (p.avg_rating != null && p.review_count > 0) ? p.avg_rating : null, // real, from approved reviews only
            variants: art ? art.variants : null,
            desc: p.description || '',
            sizes: p.sizes || ['S','M','L','XL','XXL'],
            images: imgs.length ? imgs : (art ? art.images : [placeholderImg(p.name)]),
            in_stock: p.in_stock !== false && (p.stock_qty == null || Number(p.stock_qty) > 0),
            on_sale: !!(p.sale_price && p.sale_price < p.price),
            sale_price: p.sale_price && p.sale_price < p.price ? p.sale_price : null,
            created_at: p.created_at || null,
            order_count: p.order_count || 0,
            stock_qty: p.stock_qty,
            size_stock: p.size_stock || null,
            sold_count: p.sold_count || 0,
            avg_rating: (p.avg_rating != null && p.review_count > 0) ? p.avg_rating : null,
            review_count: p.review_count || 0
          };
        });
        productsLoadedFromApi = true;
        document.getElementById('productLoadError').hidden = true;
        restoreShopState();
        if (currentProduct && document.getElementById('page-product').classList.contains('active')) {
          const fresh = allProducts.find(p => p.id === currentProduct.id);
          if (fresh) {
            currentProduct = fresh;
            if (!sizeAvailable(fresh, detailSize)) detailSize = defaultSizeFor(fresh);
            detailQty = Math.max(1, Math.min(detailQty, maxQtyFor(fresh, detailSize)));
            document.getElementById('detailQty').textContent = detailQty;
            renderSizePicker(fresh);
            renderDetailAvailability(fresh);
            renderUrgency(fresh);
          }
        }
        if (document.getElementById('page-checkout').classList.contains('active')) renderCheckout();
        renderCollectionGrid();
        initHomePageSections();
        syncCollectionVisibility();
      } catch(e) {
        console.error('Could not load catalog:', e);
        productsLoadedFromApi = false;
        allProducts = [];
        document.getElementById('productLoadError').hidden = false;
        renderCollectionGrid();
        initHomePageSections();
        syncCollectionVisibility();
      } finally {
        productsFetchInFlight = false;
      }
    }

    // ================================================================
    // CUSTOMER ACCOUNTS
    // ================================================================
    let currentCustomer = null;

    async function checkCustomerAuth() {
      try {
        const res = await fetch('/api/customers/me');
        if (res.ok) {
          const data = await res.json();
          currentCustomer = data.customer || null;
          updateAccountUI();
          if (currentCustomer) updateVerifyBanner(currentCustomer.email_verified !== false);
        } else {
          currentCustomer = null;
          updateAccountUI();
        }
      } catch (e) {
        currentCustomer = null;
        updateAccountUI();
      }
    }

    function updateAccountUI() {
      const btn = document.getElementById('customerAccountBtn');
      if (!btn) return;
      if (currentCustomer) {
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.title = currentCustomer.name || currentCustomer.email;
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
              } else {
                btn.style.opacity = '0.6';
                btn.style.cursor = 'pointer';
                btn.title = 'Sign in';
                btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
              }
    }

    function handleAccountClick() {
      if (currentCustomer) {
        navigateTo('account');
        loadAccountPage();
      } else {
        openCustModal();
      }
    }

    function openCustModal() {
      document.getElementById('custOverlay')._previousFocus = document.activeElement;
      document.getElementById('custOverlay').classList.add('open');
      showCustLogin();
      setTimeout(() => document.getElementById('custLoginEmail').focus(), 80);
    }
    function closeCustModal() {
      document.getElementById('custOverlay').classList.remove('open');
      document.getElementById('custLoginError').style.display = 'none';
      document.getElementById('custSignupError').style.display = 'none';
      document.getElementById('custOverlay')._previousFocus?.focus();
    }
    function showCustLogin() {
      document.getElementById('custLoginView').style.display = '';
      document.getElementById('custSignupView').style.display = 'none';
      document.getElementById('custLoginError').style.display = 'none';
    }
    function showCustSignup() {
      document.getElementById('custLoginView').style.display = 'none';
      document.getElementById('custSignupView').style.display = '';
      document.getElementById('custSignupError').style.display = 'none';
    }

    async function requestCustomerPasswordReset() {
      const email = prompt('Enter your email address:');
      if (!email) return;
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), user_type: 'customer' })
        });
        const data = await res.json();
        alert(data.message || 'Check your email for reset instructions.');
      } catch (err) {
        alert('Connection error.');
      }
    }

    // ---------- Password reset (email link lands on /reset-password?token=...&type=...) ----------
    let resetToken = '';
    let resetUserType = 'customer';

    function initPasswordReset() {
      try {
        const params = new URLSearchParams(window.location.search);
        resetToken = params.get('token') || '';
        resetUserType = params.get('type') === 'admin' ? 'admin' : 'customer';
      } catch (e) { resetToken = ''; }
      const err = document.getElementById('rstError');
      if (!resetToken && err) {
        err.textContent = 'This reset link is missing its token. Request a new reset email and use the link inside it.';
        err.style.display = 'block';
      }
    }

    async function submitPasswordReset(e) {
      e.preventDefault();
      const err = document.getElementById('rstError');
      const msg = document.getElementById('rstMsg');
      err.style.display = 'none'; msg.style.display = 'none';
      const password = document.getElementById('rstPassword').value;
      const confirm = document.getElementById('rstConfirm').value;
      if (!resetToken) { err.textContent = 'Reset token missing — use the link from your reset email.'; err.style.display = 'block'; return; }
      if (!password || password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.style.display = 'block'; return; }
      if (password !== confirm) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, password, user_type: resetUserType })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          msg.textContent = data.message || 'Password reset! You can now log in.';
          msg.style.display = 'block';
          document.getElementById('rstPassword').value = '';
          document.getElementById('rstConfirm').value = '';
          resetToken = '';
        } else {
          err.textContent = data.error || 'Reset failed. The link may have expired — request a new one.';
          err.style.display = 'block';
        }
      } catch (e2) {
        err.textContent = 'Connection error. Please try again.';
        err.style.display = 'block';
      }
    }

    // ---------- Email verification (link lands on /verify-email?token=...) ----------
    let verifyToken = '';

    function initEmailVerification() {
      const err = document.getElementById('vfyError');
      const msg = document.getElementById('vfyMsg');
      if (err) { err.textContent = ''; err.style.display = 'none'; }
      if (msg) { msg.style.display = 'none'; }
      try { verifyToken = new URLSearchParams(window.location.search).get('token') || ''; } catch (e) { verifyToken = ''; }
      if (!verifyToken) {
        if (err) { err.textContent = 'This verification link is missing its token. Open the link from your verification email, or resend it from your account page.'; err.style.display = 'block'; }
        return;
      }
      verifyEmail();
    }

    async function verifyEmail() {
      const err = document.getElementById('vfyError');
      const msg = document.getElementById('vfyMsg');
      try {
        const res = await fetch('/api/auth/verify-email?token=' + encodeURIComponent(verifyToken));
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          verifyToken = '';
          await checkCustomerAuth();
          if (msg) { msg.textContent = data.message || 'Email verified! Your order history is now available.'; msg.style.display = 'block'; }
        } else if (err) {
          err.textContent = data.error || 'Verification failed. The link may have expired — resend it from your account page.';
          err.style.display = 'block';
        }
      } catch (e) {
        if (err) { err.textContent = 'Connection error. Please try again.'; err.style.display = 'block'; }
      }
    }

    async function resendVerificationEmail() {
      try {
        const res = await fetch('/api/customers/resend-verification', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        showToast(res.ok ? (data.message || 'Verification email sent. Check your inbox.') : (data.error || 'Could not send the verification email.'));
      } catch (e) { showToast('Connection error. Please try again.'); }
    }

    // Show/hide the "verify your email" banner on the account page.
    function updateVerifyBanner(verified) {
      const banner = document.getElementById('acctVerifyBanner');
      if (!banner) return;
      banner.hidden = !!verified;
    }

    async function submitCustLogin() {
      const email = document.getElementById('custLoginEmail').value.trim();
      const password = document.getElementById('custLoginPassword').value;
      const errEl = document.getElementById('custLoginError');
      const btn = document.getElementById('custLoginBtn');
      if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; errEl.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const res = await fetch('/api/customers/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Login failed.'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign In'; return; }
        currentCustomer = data.customer;
        updateAccountUI();
        closeCustModal();
        if (location.pathname === '/account') { navigateTo('account', null, { skipHistory: true }); loadAccountPage(); }
        showToast('Welcome back, ' + (currentCustomer.name || 'Clan Member') + '!');
      } catch (e) {
        errEl.textContent = 'Something went wrong. Please try again.'; errEl.style.display = 'block';
      }
      btn.disabled = false; btn.textContent = 'Sign In';
    }

    async function submitCustSignup() {
      const name = document.getElementById('custSignupName').value.trim();
      const email = document.getElementById('custSignupEmail').value.trim();
      const password = document.getElementById('custSignupPassword').value;
      const errEl = document.getElementById('custSignupError');
      const btn = document.getElementById('custSignupBtn');
      if (!email || !password) { errEl.textContent = 'Email and password are required.'; errEl.style.display = 'block'; return; }
      if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/customers/signup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name })
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Signup failed.'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create Account'; return; }
        currentCustomer = data.customer;
        updateAccountUI();
        closeCustModal();
        if (location.pathname === '/account') { navigateTo('account', null, { skipHistory: true }); loadAccountPage(); }
        showToast('Account created! Check your email to verify your address.');
      } catch (e) {
        errEl.textContent = 'Something went wrong. Please try again.'; errEl.style.display = 'block';
      }
      btn.disabled = false; btn.textContent = 'Create Account';
    }

    async function customerLogout() {
      try { await fetch('/api/customers/logout', { method: 'POST' }); } catch (e) {}
      currentCustomer = null;
      updateAccountUI();
      navigateTo('home');
      showToast('Signed out.');
    }

    async function loadAccountPage() {
      if (!currentCustomer) { openCustModal(); return; }
      document.getElementById('acctName').textContent = currentCustomer.name || 'Clan Member';
      document.getElementById('acctEmail').textContent = currentCustomer.email;
      document.getElementById('acctNameInput').value = currentCustomer.name || '';
      document.getElementById('acctPhone').value = currentCustomer.phone || '';
      document.getElementById('acctAddress').value = currentCustomer.address || '';
      document.getElementById('acctCity').value = currentCustomer.city || '';
      updateVerifyBanner(currentCustomer.email_verified !== false);
      // Load orders
      try {
        const res = await fetch('/api/customers/orders');
        if (!res.ok) throw new Error('Order history unavailable');
        const data = await res.json();
        const verified = data.email_verified !== false;
        updateVerifyBanner(verified);
        renderAccountOrders(data.orders, verified);
      } catch (e) {
        document.getElementById('acctOrders').textContent = 'Could not load your orders. Please try again later.';
      }
    }

    function renderAccountOrders(orders, verified) {
      const wrap = document.getElementById('acctOrders');
      if (!orders || !orders.length) {
        // SECURITY: until the email is confirmed the history stays hidden, so
        // the empty state explains why instead of looking like "no orders".
        wrap.innerHTML = verified === false
          ? '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.82rem;">Verify your email to see your orders.<br><a href="#" data-action="resend-verification" style="color:var(--accent);font-weight:700;text-decoration:underline;">Resend verification email</a></div>'
          : '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.82rem;">No orders yet. Time to shop!</div>';
        return;
      }
      wrap.innerHTML = orders.map(o => {
        const date = o.created_at ? new Date(o.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '';
        return `<div class="order-row">
          <span class="order-num">${esc(o.order_number)}</span>
          <span class="order-status ${esc(o.status)}">${esc(o.status)}</span>
          <span class="order-total">Rs. ${o.total}</span>
          <span class="order-date">${date}</span>
        </div>`;
      }).join('');
    }

    async function saveAccountProfile() {
      const msg = document.getElementById('acctProfileMsg');
      const body = {
        name: document.getElementById('acctNameInput').value.trim(),
        phone: document.getElementById('acctPhone').value.trim(),
        address: document.getElementById('acctAddress').value.trim(),
        city: document.getElementById('acctCity').value.trim()
      };
      try {
        const res = await fetch('/api/customers/me', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok) {
          currentCustomer = data.customer;
          document.getElementById('acctName').textContent = currentCustomer.name || 'Clan Member';
          msg.textContent = 'Profile saved!'; msg.className = 'acct-msg success';
        } else {
          msg.textContent = data.error || 'Failed to save.'; msg.className = 'acct-msg error';
        }
      } catch (e) {
        msg.textContent = 'Something went wrong.'; msg.className = 'acct-msg error';
      }
      setTimeout(() => { msg.textContent = ''; }, 3000);
    }

    async function changeAccountPassword() {
      const msg = document.getElementById('acctPwMsg');
      const currentPassword = document.getElementById('acctCurrentPw').value;
      const newPassword = document.getElementById('acctNewPw').value;
      if (!currentPassword || !newPassword) { msg.textContent = 'Both fields are required.'; msg.className = 'acct-msg error'; return; }
      if (newPassword.length < 6) { msg.textContent = 'New password must be at least 6 characters.'; msg.className = 'acct-msg error'; return; }
      try {
        const res = await fetch('/api/customers/me', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (res.ok) {
          msg.textContent = 'Password updated!'; msg.className = 'acct-msg success';
          document.getElementById('acctCurrentPw').value = '';
          document.getElementById('acctNewPw').value = '';
        } else {
          msg.textContent = data.error || 'Failed to update.'; msg.className = 'acct-msg error';
        }
      } catch (e) {
        msg.textContent = 'Something went wrong.'; msg.className = 'acct-msg error';
      }
      setTimeout(() => { msg.textContent = ''; }, 3000);
    }

    document.addEventListener('keydown', e => {
      const open = [
        ['#custOverlay.open .cust-card', closeCustModal],
        ['#filterDrawer.open', closeFilterDrawer],
        ['#wishlistDrawer.open', toggleWishlistFilter],
        ['#cartDrawer.open', toggleCart],
        ['#imageZoomOverlay:not([hidden])', closeImageZoom],
        ['#navLinks.open', closeMenuAndRefocus]
      ].map(([selector, close]) => ({ el: document.querySelector(selector), close })).find(x => x.el);
      if (!open) { if (e.key === 'Escape' && navLinks.classList.contains('open')) { closeMenu(); hamburger.focus(); } return; }
      if (e.key === 'Escape') { e.preventDefault(); open.close(); return; }
      if (e.key !== 'Tab') return;
      const focusables = [...open.el.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.getClientRects().length);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || !open.el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !open.el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
    const requestedPath = location.pathname;
    if (requestedPath === '/confirmation' && !lastOrder) history.replaceState(null, '', '/tracking');
    const initialPath = location.pathname;
    setupFilters(); updateCartUI();
    if (initialPath === '/tracking') navigateTo('tracking', null, { skipHistory: true });
    else if (initialPath === '/confirmation' && lastOrder) navigateTo('confirmation', null, { skipHistory: true });
    else navigateTo('home', null, { skipHistory: true });
    // Deep-link restore runs after the catalog loads; only then is boot routing
    // done. Resolve AND reject paths flip the flag so a failed boot fetch can
    // never wedge later navigations out of focus management.
    const finishBootRouting = () => {
      if (location.pathname === initialPath && initialPath !== '/') restoreRouteFromLocation();
      bootNavComplete = true;
    };
    Promise.all([loadProductsFromAPI(), checkCustomerAuth()]).then(finishBootRouting, finishBootRouting);

    // Auto-refresh the grid when the tab regains focus (e.g. after an admin upload)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastProductsFetchAt > 15000) loadProductsFromAPI();
    });

    // ================================================================
    // LAZY IMAGE LOADING
    // ================================================================
    function initLazyImages() {
      const imgs = document.querySelectorAll('img[data-src]');
      if (!imgs.length) return;

      const imgObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const img = entry.target;
            img.src = img.dataset.src;
            img.onload = () => img.classList.add('loaded');
            img.onerror = () => img.classList.add('loaded'); // show even on error
            img.removeAttribute('data-src');
            imgObserver.unobserve(img);
          }
        });
      }, { rootMargin: '200px 0px' });

      imgs.forEach(img => imgObserver.observe(img));
    }

    // ================================================================
    // HEADER SCROLL EFFECT
    // ================================================================
    const siteHeader = document.querySelector('.site-header');
    if (siteHeader) {
      let lastScrollY = 0;
      window.addEventListener('scroll', () => {
        const y = window.scrollY;
        if (y > 80) {
          siteHeader.style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)';
        } else {
          siteHeader.style.boxShadow = 'none';
        }
        lastScrollY = y;
      }, { passive: true });
    }

    // Publish the fixed header's real height (it wraps onto two rows on phones).
    if (siteHeader) {
      const syncHeaderHeight = () => document.documentElement.style.setProperty('--header-h', siteHeader.offsetHeight + 'px');
      syncHeaderHeight();
      if (window.ResizeObserver) new ResizeObserver(syncHeaderHeight).observe(siteHeader);
      else window.addEventListener('resize', syncHeaderHeight);
    }

    // ================================================================
    // FE-H2: DELEGATED EVENTS — no inline handlers anywhere.
    // Clickables carry data-route="page" (with optional data-filter,
    // data-close-menu, data-init-shop, data-load-account) or
    // data-action="name" (with data-* params). A single document
    // listener routes; closest() picks the innermost match, so a
    // control nested inside another (e.g. a wishlist heart inside a
    // product card) behaves exactly like its old stopPropagation().
    // (data-nav is a different, older namespace: the active-link key.)
    // ================================================================
    function handleDelegatedNav(el) {
      const filter = el.dataset.filter === '@current'
        ? currentCollectionFilter
        : (el.dataset.filter || undefined);
      navigateTo(el.dataset.route, filter);
      if (el.hasAttribute('data-close-menu')) closeMenu();
      if (el.hasAttribute('data-init-shop')) initShop(el.dataset.initShop);
      if (el.hasAttribute('data-load-account')) loadAccountPage();
    }

    // FE-H2 action table: static controls (batch B) and JS-rendered
    // templates (batch C) share these names. Unknown names are ignored.
    const DELEGATED_ACTIONS = {
      'toggle-cart': () => toggleCart(),
      'toggle-wishlist': () => toggleWishlistFilter(),
      'open-filter': () => openFilterDrawer(),
      'close-filter': () => closeFilterDrawer(),
      'close-filter-render': () => { closeFilterDrawer(); renderCollectionGrid(); },
      'reset-filters': () => resetFilters(),
      'detail-add': () => detailAddToCart(),
      'detail-qty': (el) => detailChangeQty(Number(el.dataset.delta || 1)),
      'start-checkout': () => startCheckout(),
      'place-order': () => placeOrder(),
      'next-page': () => nextPage(),
      'load-products': () => loadProductsFromAPI(),
      'account': () => handleAccountClick(),
      'go-track': () => goTrackOrder(),
      'resend-verification': () => resendVerificationEmail(),
      'request-pw-reset': () => requestCustomerPasswordReset(),
      'cust-show-login': () => showCustLogin(),
      'cust-show-signup': () => showCustSignup(),
      'cust-login': () => submitCustLogin(),
      'cust-signup': () => submitCustSignup(),
      'save-profile': () => saveAccountProfile(),
      'change-password': () => changeAccountPassword(),
      'customer-logout': () => customerLogout(),
      'cust-close': () => closeCustModal(),
      'cust-backdrop': (el, e) => { if (e.target === el) closeCustModal(); },
      'desktop-search': () => toggleDesktopSearch(),
      'mobile-search-submit': (el, e) => submitMobileSearch(e),
      'filter-section': (el) => toggleFilterSection(el),
      'tab': (el) => switchTab(el),
      'zoom-close': () => closeImageZoom(),
      // JS-rendered templates (batch C).
      'open-product': (el) => openProductDetail(Number(el.dataset.pid)),
      'quick-add': (el) => quickAdd(Number(el.dataset.pid)),
      'toggle-wish': (el) => toggleWishlist(Number(el.dataset.pid), el),
      'wishlist-remove': (el) => { toggleWishlist(Number(el.dataset.pid)); renderWishlistDrawer(); },
      'detail-angle': (el) => switchDetailAngle(Number(el.dataset.index)),
      'cart-qty': (el) => changeCartQty(Number(el.dataset.index), Number(el.dataset.delta)),
      'cart-remove': (el) => removeFromCart(Number(el.dataset.index)),
    };

    function handleDelegatedAction(el, e) {
      const fn = DELEGATED_ACTIONS[el.dataset.action];
      if (!fn) return;
      if (el.tagName === 'A') e.preventDefault();
      fn(el, e);
    }

    document.addEventListener('click', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const hit = e.target.closest('[data-route], [data-action]');
      if (!hit) return;
      if (hit.hasAttribute('data-route')) {
        e.preventDefault();
        handleDelegatedNav(hit);
      } else {
        handleDelegatedAction(hit, e);
      }
    });

    // Forms carry data-form; submit bubbles, so one listener routes all five.
    // Each handler calls preventDefault itself, as before.
    const DELEGATED_FORMS = {
      'newsletter': subscribeNewsletter,
      'tracking': trackOrder,
      'password-reset': submitPasswordReset,
      'review': submitReview,
      'notify': notifyMe,
    };
    document.addEventListener('submit', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const form = e.target.closest('[data-form]');
      if (!form) return;
      const fn = DELEGATED_FORMS[form.dataset.form];
      if (fn) fn(e);
    });

    // Keyboard activation for non-native controls: elements with data-key
    // fire their click path on Enter/Space, exactly like their old inline
    // onkeydown handlers. Native controls are skipped (they fire click on
    // their own), and role=link cards keep their Enter-only behavior via
    // data-key="enter" so Space still scrolls the page.
    document.addEventListener('keydown', (e) => {
      const key = e.key === 'Enter' ? 'enter' : e.key === ' ' ? 'space' : null;
      if (!key) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('button, a, input, select, textarea')) return;
      const hit = t.closest('[data-key]');
      if (!hit) return;
      if (key === 'space' && hit.dataset.key === 'enter') return;
      e.preventDefault();
      hit.click();
    });

    // Element events that do not delegate through bubbling (or predate the
    // data-action scheme): search fields and the about-page hero fallback.
    // This script runs after the markup, so the elements already exist.
    const searchInputEl = document.getElementById('searchInput');
    if (searchInputEl) {
      searchInputEl.addEventListener('input', (e) => onSearchInput(e.target.value));
      searchInputEl.addEventListener('keydown', searchKeydown);
      searchInputEl.addEventListener('blur', searchBlur);
    }
    const mobileSearchEl = document.getElementById('mobileSearch');
    if (mobileSearchEl) {
      mobileSearchEl.addEventListener('input', (e) => onSearchInput(e.target.value));
      mobileSearchEl.addEventListener('keydown', mobileSearchKeydown);
    }
    const aboutHeroImgEl = document.getElementById('aboutHeroImg');
    if (aboutHeroImgEl) {
      aboutHeroImgEl.addEventListener('error', () => {
        aboutHeroImgEl.style.display = 'none';
        document.getElementById('aboutHeroFallback').style.display = 'flex';
      });
    }

    // ================================================================
    // INITIALIZE ALL ENHANCEMENTS
    // ================================================================
    requestAnimationFrame(() => {
      initLazyImages();
    });
  