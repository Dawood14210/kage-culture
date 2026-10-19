// KAGE Culture admin bundle (PERF-1: extracted from admin.html).

    // ================================================================
    // CONSTANTS
    // ================================================================
    // Single source of truth for product categories (matches config.js on server).
    const CATEGORY_OPTIONS = [
      { value: 'graphic-tees', label: 'Graphic Tees' },
      { value: 'anime', label: 'Anime Shirts' },
      { value: 'pants', label: 'Pants' }
    ];
    function populateCategorySelects() {
      const targets = ['prodCategory', 'quickCategory', 'productCategoryFilter'];
      targets.forEach(function(id) {
        const sel = document.getElementById(id);
        if (!sel) return;
        const placeholder = sel.querySelector('option[value=""]');
        Array.from(sel.options).forEach(function(o){ if(o.value) sel.removeChild(o); });
        CATEGORY_OPTIONS.forEach(function(c){
          const opt = document.createElement('option');
          opt.value = c.value; opt.textContent = c.label;
          sel.appendChild(opt);
        });
        if (placeholder) sel.insertBefore(placeholder, sel.firstChild);
      });
    }

    // ================================================================
    // STATE
    // ================================================================
    let isLoggedIn = false;
    let products = [];
    let selectedProductIds = new Set();
    let visibleProductIds = [];
    let currentImageFiles = { front: null, back: null };
    // Extra gallery photos (up to 4 on top of front/back). Each item is either
    // an existing remote photo ({ url, blob: null }) or a fresh upload
    // ({ url: objectURL, blob }). originalExtraUrls remembers what the product
    // had when editing started, so removed photos can be deleted server-side.
    let extraImageItems = [];
    let originalExtraUrls = [];

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

    // /admin is an HTML response, so a normal page load already carries the
    // cookie; this covers a cleared/blocked/expired cookie by asking the small
    // no-store endpoint for a fresh token before the first state-changing
    // request. One in-flight request per page load.
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

    // Monkey-patch fetch to add the CSRF token to state-changing requests
    // (obtaining one first when the cookie is missing) and to bounce back to the
    // login screen when the session expires mid-use (any 401 from the API while
    // we believed we were logged in).
    window.fetch = async function(url, opts) {
      if (opts && opts.method && ['POST','PUT','PATCH','DELETE'].includes(opts.method.toUpperCase())) {
        if (!hasHeader(opts.headers, 'X-CSRF-Token')) {
          const token = await ensureCsrfToken();
          if (token) opts.headers = setHeader(opts.headers, 'X-CSRF-Token', token);
        }
      }
      let apiPath = '';
      try { const u = typeof url === 'string' ? url : (url && url.url) || ''; apiPath = u.startsWith('/api/') ? u : ''; } catch (e) {}
      const res = await _origFetch.call(this, url, opts);
      if (apiPath && res.status === 401 && isLoggedIn && typeof showLogin === 'function') showLogin();
      return res;
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

    // Inline SVG icon helper (references the sprite at the top of <body>)
    function icon(name) {
      return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
    }

    // Rating stars as SVG (filled up to `rating`, outline beyond; min 1 like before)
    function starRating(rating) {
      const n = Math.max(1, Math.min(5, Number(rating) || 0));
      let out = '';
      for (let i = 1; i <= 5; i++) out += '<svg class="icon' + (i <= n ? ' icon-fill' : '') + '" aria-hidden="true"><use href="#i-star"/></svg>';
      return out;
    }

    // ================================================================
    // DASHBOARD STATS
    // ================================================================
    async function loadDashboardStats() {
      try {
        const res = await fetch('/api/admin/stats/dashboard');
        if (!res.ok) return;
        const s = await res.json();
        document.getElementById('statProducts').textContent = s.products;
        document.getElementById('statOrders').textContent = s.orders;
        document.getElementById('statRevenue').textContent = fmtRs(s.revenue);
        document.getElementById('statPending').textContent = s.pendingOrders;
        // Low-stock card label follows the configured threshold (was hard-coded "<5")
        const lowLabel = document.querySelector('.low-stock-card .stat-label');
        if (lowLabel && s.lowStockThreshold != null) lowLabel.textContent = 'Low Stock (<' + s.lowStockThreshold + ')';
        // Recent orders
        const recentList = document.getElementById('recentOrdersList');
        if (recentList && s.recentOrders) {
          if (!s.recentOrders.length) {
            recentList.innerHTML = '<div class="empty-state">No orders yet.</div>';
          } else {
            let rhtml = '<div class="product-row header-row"><span>Order</span><span>Customer</span><span>Total</span><span>Status</span><span>Date</span></div>';
            s.recentOrders.forEach(o => {
              const st = (o.status || 'pending').toLowerCase();
              const statusLabel = {pending:'Pending',awaiting_verification:'Awaiting Payment',confirmed:'Confirmed',shipped:'Shipped',delivered:'Delivered',cancelled:'Cancelled'}[st] || st;
              const date = (o.created_at || '').replace('T', ' ').slice(0, 16);
              // data-label feeds the phone layout: the column legend is hidden
              // once rows wrap into cards, so each cell names itself.
              rhtml += '<div class="product-row recent-order-row" style="cursor:pointer;">'
                + '<div data-label="Order"><div class="p-name">' + esc(o.order_number) + '</div></div>'
                + '<div class="p-category" data-label="Customer">' + esc(o.customer_name) + '</div>'
                + '<div class="p-price" data-label="Total">' + fmtRs(o.total) + '</div>'
                + '<div class="status-cell" data-label="Status">'
                + '<span class="status-badge status-' + esc(st) + '">' + statusLabel + '</span></div>'
                + '<div class="p-category" data-label="Date">' + esc(date) + '</div>'
                + '</div>';
            });
            recentList.innerHTML = rhtml;
            recentList.querySelectorAll('.recent-order-row').forEach(r => r.addEventListener('click', function() { switchSection('orders'); }));
          }
        }
        // Low stock
        const lowEl = document.getElementById('statLowStock');
        if (lowEl) lowEl.textContent = s.lowStockCount || 0;
      } catch (err) {}
    }
    // Refresh dashboard stats after product/order changes
    function refreshStatsIfNeeded() { loadDashboardStats(); }

    // ================================================================
    // AUTH
    // ================================================================
    async function checkAuth() {
      try {
        const res = await fetch('/api/admin/me');
        if (res.ok) {
          const data = await res.json();
          isLoggedIn = true;
          document.getElementById('loginPage').style.display = 'none';
          document.getElementById('dashboard').style.display = 'flex';
          document.getElementById('adminEmail').textContent = data.admin.email;
          const topEmail = document.getElementById('adminEmailTop');
          if (topEmail) topEmail.textContent = data.admin.email;
          switchSection('dashboard');
          populateCategorySelects();
    loadProducts();
          loadOrders();
          loadDashboardStats();
        } else {
          showLogin();
        }
      } catch {
        showLogin();
      }
    }

    function showLogin() {
      document.getElementById('loginPage').style.display = 'flex';
      document.getElementById('dashboard').style.display = 'none';
      isLoggedIn = false;
    }

    async function requestPasswordReset(userType) {
      const email = prompt('Enter your email address:');
      if (!email) return;
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), user_type: userType })
        });
        const data = await res.json();
        alert(data.message || 'Check your email for reset instructions.');
      } catch (err) {
        alert('Connection error.');
      }
    }

    async function handleLogin() {
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const btn = document.getElementById('loginBtn');
      const errEl = document.getElementById('loginError');
      if (btn.disabled) return; // re-entrant Enter while a login is in flight

      if (!email || !password) {
        errEl.textContent = 'Please enter email and password.';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Signing in...';
      errEl.style.display = 'none';

      try {
        // NOTE: first-run bootstrap is NOT automatic — POST /api/admin/setup is
        // disabled unless ALLOW_ADMIN_SETUP=true (prevents first-visitor admin takeover).
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        if (res.ok) {
          checkAuth();
        } else {
          const data = await res.json();
          if (res.status === 429) {
            const retryAfter = res.headers && typeof res.headers.get === 'function'
              ? Number(res.headers.get('Retry-After'))
              : 0;
            let retryText = '';
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              if (retryAfter >= 60) {
                const minutes = Math.ceil(retryAfter / 60);
                retryText = ` Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
              } else {
                retryText = ` Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`;
              }
            }
            errEl.textContent = 'Too many attempts. Please try again later.' + retryText;
          } else {
            errEl.textContent = data.error || 'Login failed.';
          }
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.textContent = 'Connection error. Make sure the server is running.';
        errEl.style.display = 'block';
      }

      btn.disabled = false;
      btn.textContent = 'Sign In';
    }

    async function handleLogout() {
      try {
        // Make sure a CSRF token exists first (the no-store /api/csrf endpoint),
        // otherwise a 403 keeps the admin stuck in a half-logged-in state.
        await ensureCsrfToken();
        const res = await fetch('/api/admin/logout', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Logout failed. Please try again.');
          return;
        }
        showLogin();
      } catch (err) {
        alert('Connection error. Please try again.');
      }
    }

    // ================================================================
    // CHANGE PASSWORD
    // ================================================================
    function openChangePasswordModal() {
      const modal = document.getElementById('changePwModal');
      modal._previousFocus = document.activeElement;
      modal.style.display = 'flex';
      // Enter submits from any field (bound once; the modal lives after the script)
      if (!modal._enterBound) {
        modal._enterBound = true;
        modal.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleChangePassword(); } });
      }
      document.getElementById('changePwError').style.display = 'none';
      document.getElementById('currentPw').value = '';
      document.getElementById('newPw').value = '';
      document.getElementById('confirmPw').value = '';
      document.getElementById('currentPw').focus();
    }
    function closeChangePasswordModal() {
      document.getElementById('changePwModal').style.display = 'none';
      document.getElementById('changePwModal')._previousFocus?.focus();
    }
    async function handleChangePassword() {
      const cur = document.getElementById('currentPw').value;
      const nw = document.getElementById('newPw').value;
      const confirm = document.getElementById('confirmPw').value;
      const errEl = document.getElementById('changePwError');
      if (!cur || !nw || !confirm) {
        errEl.textContent = 'All fields are required.';
        errEl.style.display = 'block';
        return;
      }
      if (nw.length < 6) {
        errEl.textContent = 'New password must be at least 6 characters.';
        errEl.style.display = 'block';
        return;
      }
      if (nw !== confirm) {
        errEl.textContent = 'New passwords do not match.';
        errEl.style.display = 'block';
        return;
      }
      try {
        const res = await fetch('/api/admin/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: cur, newPassword: nw })
        });
        const data = await res.json();
        if (res.ok) {
          closeChangePasswordModal();
          alert('Password updated successfully!');
        } else {
          errEl.textContent = data.error || 'Failed to change password.';
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.textContent = 'Connection error.';
        errEl.style.display = 'block';
      }
    }

    // Allow Enter key on login — one handler per field (a document-level
    // handler fired TWICE for password-field Enter: both listeners saw the
    // bubbling event, double-posting /api/admin/login against the rate limit).
    document.getElementById('loginEmail').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });

    // ================================================================
    // PRODUCTS
    // ================================================================
    async function loadProducts() {
      try {
        // Admin-only endpoint: the public catalog omits internal columns such
        // as unit_cost, which the edit form and the P&L need.
        const res = await fetch('/api/admin/products?_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('Products request failed');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Unexpected products payload');
        products = data;
        const currentIds = new Set(products.map(p => Number(p.id)));
        selectedProductIds = new Set([...selectedProductIds].filter(id => currentIds.has(Number(id))));
        filterProducts();
      } catch (err) {
        document.getElementById('productList').innerHTML = '<div class="empty-state">Failed to load products. <button type="button" data-action="load-products">Retry</button></div>';
      }
    }

    function updateProductSelectionUI() {
      const count = selectedProductIds.size;
      const countEl = document.getElementById('selectedProductCount');
      const deleteBtn = document.getElementById('bulkDeleteProductsBtn');
      const selectVisible = document.getElementById('selectVisibleProducts');
      if (countEl) countEl.textContent = count + ' selected';
      if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.textContent = 'Delete selected (' + count + ')';
      }
      if (selectVisible) {
        const selectedVisible = visibleProductIds.filter(id => selectedProductIds.has(id)).length;
        selectVisible.checked = visibleProductIds.length > 0 && selectedVisible === visibleProductIds.length;
        selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleProductIds.length;
        selectVisible.disabled = visibleProductIds.length === 0;
      }
    }

    function toggleProductSelection(id, checked) {
      const productId = Number(id);
      if (checked) selectedProductIds.add(productId);
      else selectedProductIds.delete(productId);
      updateProductSelectionUI();
    }

    function toggleSelectVisibleProducts(checked) {
      visibleProductIds.forEach(id => {
        if (checked) selectedProductIds.add(id);
        else selectedProductIds.delete(id);
      });
      renderProductList(products.filter(p => visibleProductIds.includes(Number(p.id))));
    }

    async function deleteSelectedProducts() {
      const ids = [...selectedProductIds];
      if (!ids.length) return;
      if (!confirm('Delete ' + ids.length + ' selected product' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
      const button = document.getElementById('bulkDeleteProductsBtn');
      if (button) { button.disabled = true; button.textContent = 'Deleting…'; }
      try {
        const res = await fetch('/api/products/batch', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status !== 401) alert(data.error || 'Failed to delete selected products.');
          if (res.status === 409) await loadProducts();
          return;
        }
        const deleted = new Set((data.deletedIds || ids).map(Number));
        deleted.forEach(id => selectedProductIds.delete(id));
        await loadProducts();
        refreshStatsIfNeeded();
      } catch (err) {
        alert('Connection error while deleting selected products.');
      } finally {
        updateProductSelectionUI();
      }
    }

    function renderProductList(list2) {
      const arr = list2 || products;
      const list = document.getElementById('productList');
      visibleProductIds = arr.map(p => Number(p.id));
      if (arr.length === 0) {
        list.innerHTML = `
          <div class="product-row header-row">
            <span></span><span></span><span>Name</span><span>Price</span><span>Category</span><span>Stock</span><span>Actions</span>
          </div>
          <div class="empty-state">${products.length ? "No products match your filters." : "No products yet. Add your first product!"}</div>
        `;
        updateProductSelectionUI();
        return;
      }

      let html = `
        <div class="product-row header-row">
          <span></span><span></span><span>Name</span><span>Price</span><span>Category</span><span>Stock</span><span>Actions</span>
        </div>
      `;

      arr.forEach(p => {
        const thumbSrc = p.front_image || '';
        const catLabel = (CATEGORY_OPTIONS.find(c => c.value === p.category) || {}).label || p.category;
        const available = p.in_stock && (p.stock_qty == null || Number(p.stock_qty) > 0);
        const stockLabel = available ? 'In Stock' : 'Sold Out';
        const stockClass = available ? 'active' : '';
        const qtyText = p.size_stock
          ? Object.entries(p.size_stock).map(([size, qty]) => `${esc(size)} ${qty}`).join(' · ')
          : ((p.stock_qty != null && p.stock_qty !== '') ? p.stock_qty : '—');
        const isSelected = selectedProductIds.has(Number(p.id));

        html += `
          <div class="product-row" data-id="${p.id}">
            <input class="product-select" type="checkbox" aria-label="Select ${esc(p.name)}" ${isSelected ? 'checked' : ''} data-change="product-select" data-id="${p.id}" />
            <div class="thumb">
              ${thumbSrc ? `<img src="${esc(thumbSrc)}" alt="${esc(p.name)}" />` : '—'}
            </div>
            <div class="product-name-cell">
              <div class="p-name">${esc(p.name)}</div>
              ${available ? '' : '<span class="product-sold-out-badge">Sold Out</span>'}
            </div>
            <div class="p-price">${fmtRs(p.sale_price || p.price)}</div>
            <div class="p-category">${esc(catLabel)}</div>
            <div class="stock-toggle">
              <button class="toggle-switch ${stockClass}" data-action="toggle-stock" data-id="${p.id}" aria-label="${available ? 'Mark Sold Out' : 'Mark In Stock'}: ${esc(p.name)}" aria-pressed="${available}" title="${available ? 'Mark Sold Out without deleting' : 'Mark In Stock after restocking'}"></button>
              <span class="stock-label">${stockLabel}</span>
              <span class="stock-qty-display" data-action="start-stock-edit" data-id="${p.id}" title="${p.size_stock ? 'Click to edit stock for each size' : 'Click to edit stock quantity'}">${qtyText}</span>
            </div>
            <div class="actions">
              <button data-action="edit-product" data-id="${p.id}">Edit</button>
              <button class="delete-btn" data-action="delete-product" data-id="${p.id}">Delete</button>
            </div>
          </div>
        `;
      });

      list.innerHTML = html;
      updateProductSelectionUI();
    }

    // ================================================================
    // STOCK TOGGLE
    // ================================================================
    async function toggleStock(id) {
      try {
        const res = await fetch('/api/products/' + id + '/stock', { method: 'PATCH' });
        if (res.ok) {
          const data = await res.json();
          const p = products.find(x => x.id === id);
          if (p) p.in_stock = data.in_stock;
          await loadProducts();
        } else {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Failed to toggle stock.');
        }
      } catch (err) {
        alert('Failed to toggle stock.');
      }
    }

    // ================================================================
    // DELETE PRODUCT
    // ================================================================
    async function deleteProduct(id) {
      if (!confirm('Delete this product? This cannot be undone.')) return;
      try {
        const res = await fetch('/api/products/' + id, { method: 'DELETE' });
        if (res.ok) {
          selectedProductIds.delete(Number(id));
          await loadProducts();
          refreshStatsIfNeeded();
        } else {
          alert('Failed to delete product.');
        }
      } catch (err) {
        alert('Failed to delete product.');
      }
    }

    // ================================================================
    // EDIT PRODUCT (pre-fill form)
    // ================================================================
    function editProduct(id) {
      const p = products.find(x => x.id === id);
      if (!p) return;
      // Clear any in-progress Add-Product state first (pending image blob, stale
      // previews from the previous product, leftover success/error banners) —
      // otherwise an abandoned image upload silently overwrites this product.
      resetForm();

      document.getElementById('editId').value = p.id;
      document.getElementById('prodName').value = p.name;
      document.getElementById('prodCategory').value = p.category;
      document.getElementById('prodFit').value = p.fit || '';
      document.getElementById('prodPrice').value = p.price;
      document.getElementById('prodSalePrice').value = p.sale_price || '';
      document.getElementById('prodUnitCost').value = p.unit_cost || '';
      document.getElementById('prodDesc').value = p.description || '';

      // Sizes and stock. A product tracked per size shows each size's count. A
      // legacy single count shows on its only size; with several sizes it stays
      // shared until each size is entered.
      const productSizes = (p.sizes && p.sizes.length) ? p.sizes : ['L'];
      setFormSizes(productSizes);
      const legacyCount = (p.stock_qty != null && p.stock_qty !== '') ? Number(p.stock_qty) : null;
      if (p.size_stock) {
        renderSizeStockInputs(p.size_stock, '');
      } else if (productSizes.length === 1) {
        renderSizeStockInputs({ [productSizes[0]]: legacyCount }, '');
      } else {
        renderSizeStockInputs({}, legacyCount != null ? `This product has ${legacyCount} units shared across all sizes. Enter a count for each size to split it.` : '');
      }

      // Show the advanced fields when editing
      document.getElementById('extraFields').classList.add('show');

      // Front image preview (existing image)
      const frontPreview = document.getElementById('frontPreview');
      if (p.front_image) {
        frontPreview.innerHTML = `<img src="${esc(p.front_image)}" alt="Front" />`;
        frontPreview.classList.add('show');
        document.getElementById('frontUploadArea').classList.add('has-image');
        document.getElementById('frontIdle').style.display = 'none';
        document.getElementById('formImgChange').style.display = 'inline-block';
      }

      if (p.back_image) {
        document.getElementById('backPreview').innerHTML = `<img src="${esc(p.back_image)}" alt="Back" />`;
        document.getElementById('backUploadArea').classList.add('has-image');
      }

      // Existing gallery photos: editable like new ones — the × on a photo
      // drops it, and the save sends the removals to the server.
      originalExtraUrls = (Array.isArray(p.extra_images) ? p.extra_images : []).filter(Boolean);
      extraImageItems = originalExtraUrls.map(url => ({ url, blob: null }));
      renderExtraPreviews();

      document.getElementById('saveBtn').textContent = 'Update Product';
      document.getElementById('cancelBtn').style.display = 'block';
      switchSection('add');
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    // ================================================================
    // PRODUCT SIZES + PER-SIZE STOCK (product form)
    // ================================================================
    const STANDARD_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

    function selectedSizes() {
      return Array.from(document.querySelectorAll('#prodSizeChips .size-chip[aria-pressed="true"]')).map(b => b.dataset.size);
    }
    // Chips for the standard sizes plus any size the product already has (e.g. "One Size").
    function setFormSizes(sizes) {
      const all = [...STANDARD_SIZES];
      sizes.forEach(sz => { if (!all.includes(sz)) all.push(sz); });
      document.getElementById('prodSizeChips').innerHTML = all.map(sz =>
        `<button type="button" class="size-chip" data-size="${esc(sz)}" aria-pressed="${sizes.includes(sz)}">${esc(sz)}</button>`
      ).join('');
    }
    // Read the typed quantities so they survive a re-render.
    function readSizeStockInputs() {
      const values = {};
      document.querySelectorAll('#prodSizeStock input[data-size]').forEach(inp => { values[inp.dataset.size] = inp.value.trim(); });
      return values;
    }
    function renderSizeStockInputs(values, note) {
      const grid = document.getElementById('prodSizeStock');
      const sizes = selectedSizes();
      grid.innerHTML = sizes.length
        ? sizes.map(sz => {
            const v = values[sz];
            const shown = (v === undefined || v === null) ? '' : String(v);
            return `<label class="size-stock-cell"><span>${esc(sz)}</span><input type="number" min="0" step="1" inputmode="numeric" data-size="${esc(sz)}" value="${esc(shown)}" placeholder="e.g. 10" /></label>`;
          }).join('')
        : '<div class="size-stock-empty">Pick at least one size.</div>';
      document.getElementById('prodSizeStockNote').textContent = note || 'Real inventory count for each size. Drives the "Only N left" badges. Leave every box empty if you are not tracking stock yet.';
    }
    // Whole-number check for a typed quantity; returns the number or null.
    function parseSizeQty(text) {
      if (!/^\d+$/.test(text)) return null;
      return Number(text);
    }
    document.getElementById('prodSizeChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.size-chip');
      if (!chip) return;
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      renderSizeStockInputs(readSizeStockInputs(), '');
    });

    function resetForm() {
      document.getElementById('editId').value = '';
      document.getElementById('productForm').reset();
      document.getElementById('extraFields').classList.remove('show');
      document.getElementById('prodCategory').value = '';
      document.getElementById('prodFit').value = 'Regular';
      document.getElementById('prodUnitCost').value = '';
      document.getElementById('backPreview').innerHTML = '          <span class="hint" style="color:var(--text-muted)">Tap to upload back view</span>';
      document.getElementById('backUploadArea').classList.remove('has-image');
      const backErr = document.getElementById('backImgError');
      if (backErr) backErr.style.display = 'none';
      clearFormImage();
      clearFormExtras();
      document.getElementById('saveBtn').textContent = 'Add Product';
      document.getElementById('cancelBtn').style.display = 'none';
      document.getElementById('formSuccess').style.display = 'none';
      document.getElementById('formError').style.display = 'none';
      currentImageFiles = { front: null, back: null };
      // Reset sizes and stock inputs to the default single size
      setFormSizes(['L']);
      renderSizeStockInputs({}, '');
      // Hide the "live in shop" confirmation card along with everything else
      document.getElementById('formLiveCard').classList.remove('show');
    }

    // ================================================================
    // UPLOAD PREVIEW
    // ================================================================
    // Back-image upload: same validation + WebP compression as the front image.
    // (The old previewUpload stored the RAW file — large camera photos could
    // exceed the 8MB upload limit, and this area had no drag & drop, so dropping
    // a file made the browser navigate away from the admin.)
    async function handleFormBackImage(file) {
      const errEl = document.getElementById('backImgError');
      errEl.style.display = 'none';
      if (!file || !file.type.startsWith('image/')) {
        errEl.textContent = 'That file type is not supported. Please choose a photo (JPEG, PNG or WebP).';
        errEl.style.display = 'block';
        return;
      }
      const input = document.getElementById('backInput');
      if (input) input.value = ''; // allow re-picking the same file later
      const preview = document.getElementById('backPreview');
      const area = document.getElementById('backUploadArea');
      const rawUrl = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${rawUrl}" alt="Back preview" />`;
      area.classList.add('has-image');
      try {
        const optimized = await compressToWebP(file);
        currentImageFiles.back = optimized.blob;
        URL.revokeObjectURL(rawUrl);
        preview.innerHTML = `<img src="${URL.createObjectURL(optimized.blob)}" alt="Back preview" />`;
        const kb = Math.max(1, Math.round(optimized.blob.size / 1024));
        const type = optimized.blob.type.includes('webp') ? 'WebP' : 'JPEG';
        preview.innerHTML += `<div class="preview-meta">Optimized · ${optimized.width}px · ${type} · ${kb} KB</div>`;
      } catch (err) {
        currentImageFiles.back = null;
        URL.revokeObjectURL(rawUrl);
        preview.innerHTML = '<span class="hint" style="color:var(--text-muted);">Tap to upload back view</span>';
        area.classList.remove('has-image');
        errEl.textContent = 'Could not process that image. Please try a different photo.';
        errEl.style.display = 'block';
      }
    }

    // Simplified Add form: front-image upload (picker + drag & drop + auto-compress to WebP)
    let formImageBlob = null;

    async function handleFormFrontImage(file) {
      const errEl = document.getElementById('formImgError');
      errEl.style.display = 'none';
      if (!file || !file.type.startsWith('image/')) {
        errEl.textContent = 'That file type is not supported. Please choose a photo (JPEG, PNG or WebP).';
        errEl.style.display = 'block';
        return;
      }
      const idle = document.getElementById('frontIdle');
      const preview = document.getElementById('frontPreview');
      const changeBtn = document.getElementById('formImgChange');
      const area = document.getElementById('frontUploadArea');
      const meta = document.createElement('div');
      meta.className = 'preview-meta';

      // Immediate preview of the raw selection
      const rawUrl = URL.createObjectURL(file);
      idle.style.display = 'none';
      preview.innerHTML = `<img src="${rawUrl}" alt="Preview" />`;
      preview.classList.add('show');
      preview.appendChild(meta);
      meta.textContent = 'Optimizing…';
      changeBtn.style.display = 'inline-block';
      area.classList.add('has-image');

      try {
        const optimized = await compressToWebP(file);
        formImageBlob = optimized.blob;
        URL.revokeObjectURL(rawUrl);
        preview.innerHTML = `<img src="${URL.createObjectURL(optimized.blob)}" alt="Preview" />`;
        preview.classList.add('show');
        preview.appendChild(meta);
        const kb = Math.max(1, Math.round(optimized.blob.size / 1024));
        const type = optimized.blob.type.includes('webp') ? 'WebP' : 'JPEG';
        meta.textContent = `Optimized · ${optimized.width}px · ${type} · ${kb} KB`;
      } catch (err) {
        formImageBlob = null;
        clearFormImage();
        errEl.textContent = 'Could not process that image. Please try a different photo.';
        errEl.style.display = 'block';
      }
    }

    function clearFormImage() {
      formImageBlob = null;
      currentImageFiles.front = null;
      const input = document.getElementById('frontInput');
      if (input) input.value = '';
      const idle = document.getElementById('frontIdle');
      const preview = document.getElementById('frontPreview');
      const changeBtn = document.getElementById('formImgChange');
      const area = document.getElementById('frontUploadArea');
      const errEl = document.getElementById('formImgError');
      if (idle) idle.style.display = 'block';
      if (preview) { preview.innerHTML = ''; preview.classList.remove('show'); }
      if (changeBtn) changeBtn.style.display = 'none';
      if (area) area.classList.remove('has-image');
      if (errEl) errEl.style.display = 'none';
    }

    function setupFormFrontUpload() {
      const area = document.getElementById('frontUploadArea');
      const input = document.getElementById('frontInput');
      if (!area || !input) return;
      area.addEventListener('click', (e) => {
        if (e.target.closest('.btn-change')) return;
        input.click();
      });
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) handleFormFrontImage(input.files[0]);
      });
      ['dragenter', 'dragover'].forEach(ev => {
        area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(ev => {
        area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('dragover'); });
      });
      area.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFormFrontImage(f);
      });
    }

    function setupFormBackUpload() {
      const area = document.getElementById('backUploadArea');
      const input = document.getElementById('backInput');
      if (!area || !input) return;
      area.addEventListener('click', () => input.click());
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) handleFormBackImage(input.files[0]);
      });
      ['dragenter', 'dragover'].forEach(ev => {
        area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(ev => {
        area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('dragover'); });
      });
      area.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFormBackImage(f);
      });
    }

    // ================================================================
    // EXTRA GALLERY PHOTOS (product form)
    // ================================================================
    const MAX_EXTRA_IMAGES = 4;

    function renderExtraPreviews() {
      const wrap = document.getElementById('extraPreviews');
      const idle = document.getElementById('extraIdle');
      if (!wrap) return;
      wrap.innerHTML = '';
      extraImageItems.forEach((item, index) => {
        const thumb = document.createElement('div');
        thumb.className = 'extra-thumb';
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = 'Extra photo ' + (index + 1);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove extra photo ' + (index + 1));
        remove.addEventListener('click', (e) => { e.stopPropagation(); removeExtraPhoto(index); });
        thumb.appendChild(img);
        thumb.appendChild(remove);
        wrap.appendChild(thumb);
      });
      if (idle) idle.style.display = extraImageItems.length >= MAX_EXTRA_IMAGES ? 'none' : 'block';
    }

    function removeExtraPhoto(index) {
      const item = extraImageItems[index];
      if (!item) return;
      // Only fresh uploads hold a blob: URL; remote URLs are just dereferenced.
      if (item.blob && typeof item.url === 'string' && item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
      extraImageItems.splice(index, 1);
      renderExtraPreviews();
    }

    // Compress every picked/dropped file to WebP (same pipeline as front/back)
    // and add as many as the remaining capacity allows.
    async function handleFormExtraFiles(fileList) {
      const errEl = document.getElementById('extraImgError');
      errEl.style.display = 'none';
      const files = Array.from(fileList || []).filter(Boolean);
      const input = document.getElementById('extraInput');
      if (input) input.value = ''; // allow re-picking the same files later
      if (!files.length) return;
      if (extraImageItems.length >= MAX_EXTRA_IMAGES) {
        errEl.textContent = `A product can have at most ${MAX_EXTRA_IMAGES} extra photos. Remove one to add another.`;
        errEl.style.display = 'block';
        return;
      }
      let accepted = 0, skippedType = 0, skippedFull = 0, failed = 0;
      for (const file of files) {
        if (!file.type || !file.type.startsWith('image/')) { skippedType++; continue; }
        if (extraImageItems.length >= MAX_EXTRA_IMAGES) { skippedFull++; continue; }
        try {
          const optimized = await compressToWebP(file);
          extraImageItems.push({ url: URL.createObjectURL(optimized.blob), blob: optimized.blob });
          accepted++;
        } catch (err) { failed++; }
      }
      renderExtraPreviews();
      const problems = [];
      if (skippedType) problems.push(`${skippedType} file${skippedType > 1 ? 's were' : ' was'} not an image`);
      if (skippedFull) problems.push(`${skippedFull} skipped — max ${MAX_EXTRA_IMAGES} extra photos`);
      if (failed) problems.push(`${failed} could not be processed`);
      if (problems.length) {
        errEl.textContent = 'Some photos were not added: ' + problems.join(' · ') + '.';
        errEl.style.display = 'block';
      } else if (!accepted) {
        errEl.textContent = 'That file type is not supported. Please choose photos (JPEG, PNG or WebP).';
        errEl.style.display = 'block';
      }
    }

    function clearFormExtras() {
      extraImageItems.forEach(item => {
        if (item.blob && typeof item.url === 'string' && item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
      });
      extraImageItems = [];
      originalExtraUrls = [];
      const errEl = document.getElementById('extraImgError');
      if (errEl) errEl.style.display = 'none';
      renderExtraPreviews();
    }

    function setupFormExtraUpload() {
      const area = document.getElementById('extraUploadArea');
      const input = document.getElementById('extraInput');
      if (!area || !input) return;
      area.addEventListener('click', (e) => {
        if (e.target.closest('.extra-thumb')) return; // remove buttons handle themselves
        input.click();
      });
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
      input.addEventListener('change', () => handleFormExtraFiles(input.files));
      ['dragenter', 'dragover'].forEach(ev => {
        area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(ev => {
        area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove('dragover'); });
      });
      area.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFormExtraFiles(e.dataTransfer.files);
      });
    }

    // ================================================================
    // SAVE PRODUCT (Create / Update)
    // ================================================================
    async function handleSaveProduct(e) {
      e.preventDefault();
      const editId = document.getElementById('editId').value;
      const successEl = document.getElementById('formSuccess');
      const errorEl = document.getElementById('formError');
      const btn = document.getElementById('saveBtn');

      successEl.style.display = 'none';
      errorEl.style.display = 'none';

      if (btn.disabled) return; // Enter inside a text field can re-submit while a save is in flight

      const name = document.getElementById('prodName').value.trim();
      const price = document.getElementById('prodPrice').value;

      if (!name || !price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
        errorEl.textContent = 'Please fill in the product name and a valid price.';
        errorEl.style.display = 'block';
        return;
      }
      if (!editId && !formImageBlob) {
        errorEl.textContent = 'Please add a picture of the product.';
        errorEl.style.display = 'block';
        return;
      }
      const salePriceCheck = document.getElementById('prodSalePrice').value;
      if (salePriceCheck !== '' && (isNaN(parseFloat(salePriceCheck)) || parseFloat(salePriceCheck) <= 0 || parseFloat(salePriceCheck) >= parseFloat(price))) {
        errorEl.textContent = 'Sale price must be lower than the regular price.';
        errorEl.style.display = 'block';
        return;
      }

      const formData = new FormData();
      formData.append('name', name);
      const _catVal = (document.getElementById('prodCategory').value || '').trim();
      if (!_catVal) { errorEl.textContent = 'Please select a category.'; errorEl.style.display = 'block'; return; }
      formData.append('category', _catVal);
      formData.append('fit', document.getElementById('prodFit').value.trim() || 'Regular');
      formData.append('price', price);

      const salePrice = document.getElementById('prodSalePrice').value;
      // An empty field on edit means remove the discount, not retain the old price.
      if (editId || salePrice) formData.append('sale_price', salePrice);

      const unitCost = document.getElementById('prodUnitCost').value;
      if (unitCost) formData.append('unit_cost', unitCost);

      formData.append('description', document.getElementById('prodDesc').value.trim());

      const sizesOffered = selectedSizes();
      if (!sizesOffered.length) {
        errorEl.textContent = 'Pick at least one size.';
        errorEl.style.display = 'block';
        return;
      }
      formData.append('sizes', JSON.stringify(sizesOffered));

      // Stock per size: all or nothing. Empty boxes mean "not tracked" (create)
      // or "keep the current count" (edit).
      const typed = readSizeStockInputs();
      const filledSizes = sizesOffered.filter(sz => typed[sz] !== undefined && typed[sz] !== '');
      if (filledSizes.length) {
        const counts = {};
        for (const sz of sizesOffered) {
          const q = parseSizeQty(typed[sz] || '');
          if (q === null) {
            errorEl.textContent = typed[sz] ? `Stock for size ${sz} must be a whole number.` : `Enter a stock quantity for size ${sz}, or leave every size empty.`;
            errorEl.style.display = 'block';
            return;
          }
          counts[sz] = q;
        }
        formData.append('size_stock', JSON.stringify(counts));
      }

      // Picture (compressed to WebP client-side) and back image. Every blob
      // MUST be appended with an explicit filename: a nameless Blob is sent as
      // filename="blob", which the server's image-only upload filter rejects
      // (back-image saves used to fail with "Only image files are allowed").
      if (formImageBlob) formData.append('front_image', formImageBlob, 'pic-' + Date.now() + '.webp');
      if (currentImageFiles.back) formData.append('back_image', currentImageFiles.back, 'back-' + Date.now() + '.webp');

      // Extra gallery photos: new uploads, plus (on edit) the removal list for
      // any existing photo the admin deleted from the form.
      const newExtras = extraImageItems.filter(item => item.blob);
      const stamp = Date.now();
      newExtras.forEach((item, index) => formData.append('extra_images', item.blob, `extra-${stamp}-${index}.webp`));
      if (editId) {
        const keptUrls = extraImageItems.filter(item => !item.blob && item.url).map(item => item.url);
        const removedUrls = originalExtraUrls.filter(url => !keptUrls.includes(url));
        if (removedUrls.length) formData.append('remove_extra', JSON.stringify(removedUrls));
      }

      btn.disabled = true;
      btn.textContent = editId ? 'Updating…' : 'Adding…';

      try {
        let res;
        if (editId) {
          res = await fetch('/api/products/' + editId, { method: 'PUT', body: formData });
        } else {
          res = await fetch('/api/products', { method: 'POST', body: formData });
        }

        if (res.ok) {
          const product = await res.json();
          if (editId) {
            successEl.textContent = 'Product updated successfully!';
          } else {
            successEl.textContent = 'Product added — it\'s live in the shop.';
          }
          // resetForm() clears the live card, so show it afterwards for creates
          resetForm();
          if (!editId) {
            document.getElementById('formLcImg').src = product.front_image || '';
            document.getElementById('formLcName').textContent = product.name;
            document.getElementById('formLcPrice').textContent = fmtRs(product.sale_price || product.price);
            document.getElementById('formLiveCard').classList.add('show');
          }
          successEl.style.display = 'block';
          await loadProducts();
          refreshStatsIfNeeded();
        } else {
          const data = await res.json().catch(() => ({}));
          if (res.status !== 401) { // a 401 already bounced us back to the login screen
            errorEl.textContent = data.error || 'Failed to save product.';
            errorEl.style.display = 'block';
          }
        }
      } catch (err) {
        errorEl.textContent = 'Connection error. Make sure the server is running.';
        errorEl.style.display = 'block';
      }

      btn.disabled = false;
      btn.textContent = editId ? 'Update Product' : 'Add Product';
    }

    // ================================================================
    // QUICK UPLOAD (image + price)
    // ================================================================
    let quickImageBlob = null;
    let quickImageName = '';
    let quickUploading = false;

    function setupQuickUpload() {
      const zone = document.getElementById('uploadZone');
      const input = document.getElementById('quickImage');

      // Tap / click to open file picker
      zone.addEventListener('click', (e) => {
        if (e.target.closest('.preview-box')) return; // don't reopen picker from preview UI
        input.click();
      });
      zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) handleQuickFile(input.files[0]);
      });

      // Drag & drop (desktop)
      ['dragenter', 'dragover'].forEach(ev => {
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); });
      });
      ['dragleave', 'drop'].forEach(ev => {
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
      });
      zone.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleQuickFile(f);
      });
    }

    async function handleQuickFile(file) {
      const uzError = document.getElementById('uzError');
      uzError.style.display = 'none';

      if (!file.type.startsWith('image/')) {
        uzError.textContent = 'That file type is not supported. Please choose a photo (JPEG, PNG or WebP).';
        uzError.style.display = 'block';
        return;
      }

      quickImageName = file.name;

      // Immediate preview of the raw selection
      const rawUrl = URL.createObjectURL(file);
      document.getElementById('previewImg').src = rawUrl;
      document.getElementById('uzIdle').style.display = 'none';
      document.getElementById('previewBox').classList.add('show');
      document.getElementById('previewMeta').textContent = 'Optimizing…';

      try {
        const optimized = await compressToWebP(file);
        quickImageBlob = optimized.blob;
        URL.revokeObjectURL(rawUrl);
        document.getElementById('previewImg').src = URL.createObjectURL(optimized.blob);
        const kb = Math.max(1, Math.round(optimized.blob.size / 1024));
        const type = optimized.blob.type.includes('webp') ? 'WebP' : 'JPEG';
        document.getElementById('previewMeta').textContent =
          `Optimized · ${optimized.width}px · ${type} · ${kb} KB`;
        document.getElementById('uploadZone').classList.add('has-image');
      } catch (err) {
        quickImageBlob = null;
        URL.revokeObjectURL(rawUrl);
        document.getElementById('uzIdle').style.display = 'block';
        document.getElementById('previewBox').classList.remove('show');
        document.getElementById('uploadZone').classList.remove('has-image');
        uzError.textContent = 'Could not process that image. Please try a different photo.';
        uzError.style.display = 'block';
      }
    }

    // Resize to a max width and re-encode as WebP (canvas-based, no server deps)
    async function compressToWebP(file, maxWidth = 1200, quality = 0.82) {
      const img = await loadImageEl(file);
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('image has no dimensions');
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      let blob = await canvasToBlob(canvas, 'image/webp', quality);
      if (!blob || !blob.type.includes('webp')) {
        const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
        if (jpg) return { blob: jpg, width: w };
        throw new Error('encoding failed');
      }
      return { blob, width: w };
    }

    function loadImageEl(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
        img.src = url;
      });
    }

    function canvasToBlob(canvas, type, quality) {
      return new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), type, quality);
      });
    }

    function clearImageSelection() {
      quickImageBlob = null;
      quickImageName = '';
      const img = document.getElementById('previewImg');
      if (img && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      document.getElementById('quickImage').value = '';
      document.getElementById('uzIdle').style.display = 'block';
      document.getElementById('previewBox').classList.remove('show');
      document.getElementById('uploadZone').classList.remove('has-image');
      document.getElementById('uzError').style.display = 'none';
    }

    function productNameFromFile(filename) {
      let base = (filename || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
      if (!base) base = 'New Drop';
      return base.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 60) || 'New Drop';
    }

    async function handleQuickUpload() {
      if (quickUploading) return;
      const priceInput = document.getElementById('quickPrice');
      const price = parseFloat(priceInput.value);
      const successEl = document.getElementById('quickSuccess');
      const errorEl = document.getElementById('quickError');

      successEl.style.display = 'none';
      errorEl.style.display = 'none';

      if (!quickImageBlob) {
        errorEl.textContent = 'Please choose an image first.';
        errorEl.style.display = 'block';
        return;
      }
      if (!price || isNaN(price) || price <= 0) {
        errorEl.textContent = 'Please enter a valid price.';
        errorEl.style.display = 'block';
        return;
      }
      const stockInput = document.getElementById('quickStockQty');
      const stockValue = stockInput ? stockInput.value.trim() : '';
      if (stockValue !== '' && (!Number.isSafeInteger(Number(stockValue)) || Number(stockValue) < 0)) {
        errorEl.textContent = 'Stock quantity must be a whole number of zero or more.';
        errorEl.style.display = 'block';
        return;
      }

      const formData = new FormData();
      formData.append('name', productNameFromFile(quickImageName));
      const quickCat = document.getElementById('quickCategory');
      const quickSz = document.getElementById('quickSize');
      const _qCat = (quickCat && quickCat.value || '').trim();
      if (!_qCat) { errorEl.textContent = 'Please select a category.'; errorEl.style.display = 'block'; return; }
      formData.append('category', _qCat);
      formData.append('fit', 'Regular');
      formData.append('price', String(price));
      formData.append('sizes', JSON.stringify([(quickSz && quickSz.value) || 'L']));
      if (stockValue !== '') formData.append('stock_qty', String(Number(stockValue)));
      formData.append('front_image', quickImageBlob, 'drop-' + Date.now() + '.webp');

      quickUploading = true;
      const btn = document.getElementById('quickUploadBtn');
      btn.disabled = true;
      btn.classList.add('spinning');
      btn.innerHTML = '<span class="spinner"></span> Uploading…';

      try {
        const res = await fetch('/api/products', { method: 'POST', body: formData });
        if (res.ok) {
          const product = await res.json();
          successEl.textContent = 'Product added — it\'s now live in the shop.';
          successEl.style.display = 'block';
          document.getElementById('lcImg').src = product.front_image;
          document.getElementById('lcName').textContent = product.name;
          document.getElementById('lcPrice').textContent = 'Rs. ' + (product.sale_price || product.price);
          document.getElementById('liveCard').classList.add('show');
          clearImageSelection();
          priceInput.value = '';
          if (stockInput) stockInput.value = '';
          await loadProducts(); // keep the Products tab in sync
          refreshStatsIfNeeded();
        } else {
          let msg = 'Upload failed. Please try again.';
          try { const d = await res.json(); if (d.error) msg = d.error; } catch (e) {}
          errorEl.textContent = msg;
          errorEl.style.display = 'block';
        }
      } catch (err) {
        errorEl.textContent = 'Connection error. Check your connection and try again.';
        errorEl.style.display = 'block';
      } finally {
        quickUploading = false;
        btn.disabled = false;
        btn.classList.remove('spinning');
        btn.textContent = 'Upload';
      }
    }

    // ================================================================
    // ORDERS
    // ================================================================
    async function loadOrders() {
      try {
        const res = await fetch('/api/orders');
        if (!res.ok) throw new Error('Orders request failed');
        allOrders = await res.json();
        filterOrders();
      } catch (err) {
        allOrders = [];
        document.getElementById('ordersList').innerHTML = '<div class="empty-state">Failed to load orders. <button type="button" data-action="load-orders">Retry</button></div>';
      }
    }

        function filterOrders() {
      const status = document.getElementById('orderStatusFilter').value;
      const q = (document.getElementById('orderSearch') ? document.getElementById('orderSearch').value : '').toLowerCase().trim();
      let filtered = [...allOrders];
      if (status) filtered = filtered.filter(o => (o.status || 'pending').toLowerCase() === status);
      if (q) filtered = filtered.filter(o =>
        String(o.order_number || '').toLowerCase().includes(q) ||
        String(o.customer_name || '').toLowerCase().includes(q) ||
        String(o.phone || '').toLowerCase().includes(q) ||
        String(o.email || '').toLowerCase().includes(q));
      filtered.sort((a, b) => { const da = new Date(a.created_at || 0).getTime(); const db = new Date(b.created_at || 0).getTime(); return orderSortAsc ? da - db : db - da; });
      renderOrderList(filtered);
    }
    function toggleOrderSort() {
      orderSortAsc = !orderSortAsc;
      document.getElementById('orderSortLabel').innerHTML = (orderSortAsc ? icon('arrow-up') + ' Oldest' : icon('arrow-down') + ' Newest');
      filterOrders();
    }
    function exportOrdersCsv() {
      const st = document.getElementById('orderStatusFilter').value;
      window.location.href = '/api/orders/export/csv' + (st ? '?status=' + encodeURIComponent(st) : '');
    }
    function renderOrderList(orders) {
      const list = document.getElementById('ordersList');
      if (!orders.length) {
        list.innerHTML = '<div class="empty-state">' + (allOrders.length ? 'No orders match this status.' : 'No orders yet. Orders placed on the storefront will appear here.') + '</div>';
        return;
      }
      let html = `
        <div class="product-row header-row">
          <span>Order</span><span>Customer</span><span>Items</span><span>Total</span><span>Payment</span><span>Status</span>
        </div>
      `;
      orders.forEach(o => {
        const items = o.items || [];
        const count = items.reduce((s, i) => s + (i.qty || 1), 0);
        const date = (o.created_at || '').replace('T', ' ').slice(0, 16);
        const pay = o.payment_method === 'bank' ? 'Bank Transfer' : o.payment_method === 'jazzcash' ? 'JazzCash' : 'COD';
        const st = (o.status || 'pending').toLowerCase();
        const statusLabel = { pending:'Pending', awaiting_verification:'Awaiting Payment', confirmed:'Confirmed', shipped:'Shipped', delivered:'Delivered', cancelled:'Cancelled' }[st] || st;
        const payRef = o.payment_ref ? `<div class="p-category" style="font-size:0.65rem;color:var(--text-accent);">Ref: ${esc(o.payment_ref)}</div>` : '';
        const codBadge = o.payment_method === 'cod' && o.cod_confirmed ? `<div class="p-category" style="font-size:0.62rem;color:var(--text-success);">${icon('check')} COD Confirmed</div>` : '';
        const shippingPendingBadge = o.shipping_pending && o.status !== 'cancelled' ? `<div class="p-category" style="font-size:0.62rem;color:var(--text-accent);">Delivery charge pending</div>` : '';
        const verifiedBadge = o.payment_method !== 'cod' && o.payment_verified ? `<div class="p-category" style="font-size:0.62rem;color:var(--text-success);">${icon('check')} Payment Verified</div>` : '';
        const payOpts = o.payment_method !== 'cod'
          ? `<button data-action="verify-payment" data-id="${o.id}" data-value="${o.payment_verified ? 'false' : 'true'}" class="status-opt status-opt-confirmed">${icon('credit-card')} ${o.payment_verified ? 'Remove Verification' : 'Verify Payment'}</button>`
          : `<button data-action="cod-confirm" data-id="${o.id}" data-value="${o.cod_confirmed ? 'false' : 'true'}" class="status-opt status-opt-delivered">${icon('dollar')} ${o.cod_confirmed ? 'Undo COD Confirmation' : 'Mark COD Confirmed'}</button>`;
        html += `
          <div class="product-row order-row">
            <div data-label="Order">
              <div class="p-name">${esc(o.order_number)}</div>
              <div class="p-category">${esc(date)}</div>
            </div>
            <div data-label="Customer">
              <div class="p-name">${esc(o.customer_name)}</div>
              <div class="p-category">${esc(o.phone)}</div>
            </div>
            <div class="p-category" data-label="Items">${count} item${count === 1 ? '' : 's'}</div>
            <div data-label="Total"><div class="p-price">${fmtRs(o.total)}</div>${shippingPendingBadge}</div>
            <div class="p-category" data-label="Payment">${pay}${payRef}${codBadge}${verifiedBadge}</div>
            <div class="status-cell" data-label="Status">
              <span class="status-badge status-${esc(st)}">${statusLabel}</span>
              <div class="status-dropdown">
                <button class="status-dropdown-btn" data-action="status-dropdown" aria-label="Change status">▾</button>
                <div class="status-dropdown-menu">
                  ${payOpts}
                  <button data-action="order-status" data-id="${o.id}" data-status="confirmed" class="status-opt status-opt-confirmed">${icon('check')} Confirm</button>
                  <button data-action="order-status" data-id="${o.id}" data-status="shipped" class="status-opt status-opt-shipped">${icon('truck')} Mark Shipped</button>
                  <button data-action="order-status" data-id="${o.id}" data-status="delivered" class="status-opt status-opt-delivered">${icon('check-circle')} Delivered</button>
                  <button data-action="order-status" data-id="${o.id}" data-status="cancelled" class="status-opt status-opt-cancelled">${icon('x')} Cancel</button>
                  <button data-action="order-status" data-id="${o.id}" data-status="pending" class="status-opt status-opt-pending">${icon('rotate')} Reset to Pending</button>
                </div>
              </div>
            </div>
          </div>
        `;
      });
      list.innerHTML = html;
    }

    function toggleStatusDropdown(btn) {
      const menu = btn.nextElementSibling;
      const isOpen = menu.classList.contains('open');
      // Close all open menus first
      document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) menu.classList.add('open');
    }

    let updatingOrder = false;
    const STATUS_LABELS = { pending:'Pending', awaiting_verification:'Awaiting Payment', confirmed:'Confirmed', shipped:'Shipped', delivered:'Delivered', cancelled:'Cancelled' };
    async function updateOrderStatus(id, status) {
      if (updatingOrder) return;
      // Every transition emails the customer — confirm before mutating (Cancel
      // included; it used to be the only one with a dialog).
      const label = STATUS_LABELS[status] || status;
      const msg = status === 'cancelled'
        ? 'Cancel this order? Stock will be returned to inventory.'
        : `Mark this order as ${label}? The customer will receive a status email.`;
      if (!confirm(msg)) return;
      updatingOrder = true;
      // Close dropdown immediately
      document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      try {
        const res = await fetch('/api/orders/' + id + '/status', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        if (res.ok) {
          loadOrders();
          refreshStatsIfNeeded();
        } else if (res.status !== 401) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Failed to update status.');
        }
      } catch (err) {
        alert('Connection error.');
      } finally {
        updatingOrder = false;
      }
    }

    async function verifyPayment(id, verified) {
      if (updatingOrder) return;
      updatingOrder = true;
      document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      try {
        const res = await fetch('/api/orders/' + id + '/verify-payment', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verified })
        });
        if (res.ok) {
          loadOrders();
        } else if (res.status !== 401) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Failed to verify payment.');
        }
      } catch (err) {
        alert('Connection error.');
      } finally {
        updatingOrder = false;
      }
    }

    async function codConfirm(id, confirmed) {
      if (updatingOrder) return;
      updatingOrder = true;
      document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      try {
        const res = await fetch('/api/orders/' + id + '/cod-confirm', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed })
        });
        if (res.ok) {
          loadOrders();
        } else if (res.status !== 401) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Failed to confirm COD.');
        }
      } catch (err) {
        alert('Connection error.');
      } finally {
        updatingOrder = false;
      }
    }

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.status-dropdown')) {
        document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
      }
    });


    // ================================================================
    // PRODUCT SEARCH / FILTER
    // ================================================================
    function filterProducts() {
      const q = (document.getElementById('productSearch').value || '').toLowerCase().trim();
      const cat = document.getElementById('productCategoryFilter').value;
      let filtered = products;
      if (q) filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
      if (cat) filtered = filtered.filter(p => p.category === cat);
      renderProductList(filtered);
    }
    function clearProductFilters() {
      document.getElementById('productSearch').value = '';
      document.getElementById('productCategoryFilter').value = '';
      renderProductList(products);
    }

    // ================================================================
    // STOCK INLINE EDIT
    // ================================================================
    function startStockEdit(id, span) {
      const p = products.find(x => x.id === id);
      if (!p) return;
      // Per-size stock is edited in the product form, where each size is set separately.
      if (p.size_stock) { editProduct(id); return; }
      const current = (p.stock_qty != null && p.stock_qty !== '') ? p.stock_qty : '';
      span.outerHTML = '<div class="stock-qty-cell" data-editing="' + id + '">' +
        '<input class="stock-qty-input" type="number" min="0" step="1" value="' + current + '" data-keys="stock-edit" data-id="' + id + '" autofocus />' +
        '<button class="stock-qty-save" data-action="save-stock" data-id="' + id + '" title="Save">' + icon('check') + '</button>' +
        '<button class="stock-qty-cancel" data-action="cancel-stock" data-id="' + id + '" title="Cancel">' + icon('x') + '</button>' +
        '</div>';
      document.querySelector('[data-editing="' + id + '"] .stock-qty-input').focus();
    }
    async function saveStockEdit(id) {
      const cell = document.querySelector('[data-editing="' + id + '"]');
      if (!cell) return;
      const val = cell.querySelector('.stock-qty-input').value;
      // An empty box means "no change" — silently writing 0 would sell the
      // product out. Type a number (0 explicitly clears stock) to save.
      if (val === '') { cancelStockEdit(id); return; }
      try {
        const res = await fetch('/api/products/' + id + '/stock-qty', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stock_qty: Number(val) })
        });
        if (res.ok) { const data = await res.json(); const p = products.find(x => x.id === id); if (p) { p.stock_qty = data.stock_qty; p.in_stock = data.in_stock; } await loadProducts(); refreshStatsIfNeeded(); }
        else if (res.status !== 401) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to update stock.'); cancelStockEdit(id); }
      } catch (e) { alert('Connection error.'); cancelStockEdit(id); }
    }
    function cancelStockEdit(id) { filterProducts(); }

    // ================================================================
    // ORDER FILTER + SORT
    // ================================================================
    let allOrders = [];
    let orderSortAsc = false;

    // ================================================================
    // SALES SUMMARY
    // ================================================================
    async function loadSalesSummary() {
      try {
        const res = await fetch('/api/admin/stats/sales');
        if (!res.ok) return;
        const s = await res.json();
        document.getElementById('salesRevToday').textContent = fmtRs(s.revenueToday);
        document.getElementById('salesRevWeek').textContent = fmtRs(s.revenueWeek);
        document.getElementById('salesRevMonth').textContent = fmtRs(s.revenueMonth);
        const bs = document.getElementById('salesBestProduct');
        if (s.bestProduct && s.bestProduct.units > 0) { bs.innerHTML = esc(s.bestProduct.name) + '<span class="best-seller-units">(' + s.bestProduct.units + ' sold)</span>'; } else { bs.textContent = '—'; }
        const sc = document.getElementById('salesStatusCounts');
        const statuses = ['pending','awaiting_verification','confirmed','shipped','delivered','cancelled'];
        const colors = {pending:'dot-pending',awaiting_verification:'dot-pending',confirmed:'dot-confirmed',shipped:'dot-shipped',delivered:'dot-delivered',cancelled:'dot-cancelled'};
        const labels = {pending:'Pending',awaiting_verification:'Awaiting Payment',confirmed:'Confirmed',shipped:'Shipped',delivered:'Delivered',cancelled:'Cancelled'};
        sc.innerHTML = statuses.map(st => { const count = (s.ordersByStatus && s.ordersByStatus[st]) || 0; return '<span class="status-chip"><span class="dot ' + colors[st] + '"></span>' + count + ' ' + labels[st] + '</span>'; }).join('');
      } catch (err) {}
    }

    // ================================================================
    // REVIEW MODERATION
    // ================================================================
    let allReviews = [];
    let reviewFilter = 'pending';
    function setReviewFilter(f) { reviewFilter = f; document.querySelectorAll('.reviews-toolbar .period-btn').forEach(b => b.classList.toggle('active', b.dataset.rf === f)); renderReviews(); }
    async function loadReviews() {
      try {
        const res = await fetch('/api/reviews/all');
        if (!res.ok) { document.getElementById('reviewsList').innerHTML = '<div class="empty-state">Failed to load reviews.</div>'; return; }
        allReviews = await res.json(); renderReviews();
      } catch (e) { document.getElementById('reviewsList').innerHTML = '<div class="empty-state">Could not load reviews.</div>'; }
    }
    function productName(pid) { const p = products.find(x => String(x.id) === String(pid)); return p ? p.name : ('Product #' + pid); }
    function renderReviews() {
      const list = document.getElementById('reviewsList'); if (!list) return;
      const rows = allReviews.filter(r => r.status === reviewFilter);
      if (!rows.length) { list.innerHTML = '<div class="empty-state">No ' + reviewFilter + ' reviews.</div>'; return; }
      list.innerHTML = rows.map(r => '<div class="review-row"><div class="review-top"><span class="review-prod">' + esc(productName(r.product_id)) + '</span><span class="review-stars">' + starRating(r.rating) + '</span><span class="review-meta">' + esc(r.customer_name || 'Verified Buyer') + ' · ' + esc(r.order_number || '') + '</span></div>' + (r.comment ? '<p class="review-comment">' + esc(r.comment) + '</p>' : '<p class="review-comment dim">(no comment)</p>') + '<div class="review-actions">' + (r.status !== 'approved' ? '<button class="approve-btn" data-action="review-status" data-id="' + r.id + '" data-status="approved"">' + icon('check') + ' Approve</button>' : '') + (r.status !== 'rejected' ? '<button class="reject-btn" data-action="review-status" data-id="' + r.id + '" data-status="rejected"">' + icon('x') + ' Reject</button>' : '') + '<button class="delete-btn" data-action="delete-review" data-id="' + r.id + '">Delete</button></div></div>').join('');
    }
    async function setReviewStatus(id, status) {
      try {
        const res = await fetch('/api/reviews/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        if (res.ok) loadReviews();
        else if (res.status !== 401) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to update review.'); }
      } catch (e) { alert('Connection error.'); }
    }
    async function deleteReview(id) {
      if (!confirm('Delete this review permanently?')) return;
      try {
        const res = await fetch('/api/reviews/' + id, { method: 'DELETE' });
        if (res.ok) loadReviews();
        else if (res.status !== 401) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to delete review.'); }
      } catch (e) { alert('Connection error.'); }
    }

    // ================================================================
    // P&L REPORTS (Chart.js)
    // ================================================================
    let pnlChart = null;
    let pnlPeriod = 'daily';

    function setPnlPeriod(period) {
      pnlPeriod = period;
      // Scope to the P&L toggle — an unscoped '.period-btn' query also matched
      // the Reviews filter pills and stripped their active highlight.
      document.querySelectorAll('.period-toggle .period-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.period === period);
      });
      loadPnlStats();
    }

    function fmtRs(n) {
      return 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
    }

    async function loadPnlStats() {
      const emptyEl = document.getElementById('pnlEmpty');
      if (emptyEl) emptyEl.classList.remove('show');
      try {
        const res = await fetch('/api/admin/stats/pnl?period=' + pnlPeriod);
        if (!res.ok) return;
        const data = await res.json();

        // Summary cards populate regardless of whether Chart.js loaded — the
        // old `if (!window.Chart) return` up-front blanked the whole tab.
        document.getElementById('pnlRevenue').textContent = fmtRs(data.summary.revenue);
        document.getElementById('pnlCost').textContent = fmtRs(data.summary.cost);
        document.getElementById('pnlProfit').textContent = fmtRs(data.summary.profit);
        const profitEl = document.getElementById('pnlProfit');
        profitEl.style.color = data.summary.profit >= 0 ? 'var(--green)' : 'var(--red)';

        const hasData = data.revenue.some(v => v !== 0) || data.cost.some(v => v !== 0);
        if (!hasData) {
          if (pnlChart) { pnlChart.destroy(); pnlChart = null; }
          if (emptyEl) emptyEl.classList.add('show');
          return;
        }
        if (!window.Chart) return; // chart lib failed to load — keep the summary

        const ctx = document.getElementById('pnlChart').getContext('2d');
        if (pnlChart) pnlChart.destroy();

        pnlChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: data.labels,
            datasets: [
              {
                label: 'Revenue',
                data: data.revenue,
                borderColor: '#FFFFFF',
                backgroundColor: 'rgba(255,255,255,0.08)',
                borderWidth: 2,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true
              },
              {
                label: 'Cost',
                data: data.cost,
                borderColor: '#E8232F',
                backgroundColor: 'rgba(232,35,47,0.10)',
                borderWidth: 2,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true
              },
              {
                label: 'Profit',
                data: data.profit,
                borderColor: '#2EE6A8',
                backgroundColor: 'rgba(46,230,168,0.10)',
                borderWidth: 2.5,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 700, easing: 'easeOutQuart' },
            plugins: {
              legend: {
                position: 'top',
                labels: {
                  color: '#C9C9C9',
                  font: { family: 'Archivo', size: 11, weight: '600' },
                  usePointStyle: true,
                  pointStyle: 'line',
                  padding: 18,
                  boxWidth: 28
                }
              },
              tooltip: {
                backgroundColor: '#111111',
                titleColor: '#FFFFFF',
                bodyColor: '#D7D7D7',
                borderColor: '#2A2A2A',
                borderWidth: 1,
                padding: 12,
                displayColors: true,
                callbacks: {
                  label: (c) => ' ' + c.dataset.label + ': ' + fmtRs(c.parsed.y)
                }
              }
            },
            scales: {
              x: {
                grid: { color: 'rgba(255,255,255,0.05)' },
                ticks: { color: '#9A9A9A', font: { family: 'Archivo', size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
              },
              y: {
                grid: { color: 'rgba(255,255,255,0.07)' },
                ticks: {
                  color: '#9A9A9A',
                  font: { family: 'Archivo', size: 10 },
                  callback: (v) => 'Rs. ' + Number(v).toLocaleString('en-IN')
                }
              }
            }
          }
        });
      } catch (err) {
        // Non-fatal: leave the chart empty rather than breaking the tab
      }
    }

    // ================================================================
    // DARK MODE TOGGLE
    // ================================================================
    function toggleTheme() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('kage-admin-theme', 'light');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('kage-admin-theme', 'dark');
      }
      updateThemeIcon();
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = isDark ? '#F3F4F6' : '#0F1117';
    }
    function updateThemeIcon() {
      const icon = document.querySelector('.theme-toggle-icon');
      if (!icon) return;
      icon.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '\u263E' : '\u2600';
    }
    // Restore saved theme + icon on load
    (function() {
      const saved = localStorage.getItem('kage-admin-theme');
      if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      document.addEventListener('DOMContentLoaded', updateThemeIcon);
    })();

    // ================================================================
    // TABS
    // ================================================================
    const sectionTitles = {dashboard:'Dashboard',products:'Products',upload:'Quick Upload',add:'Add Product',orders:'Orders',reviews:'Reviews',reports:'Reports'};
    function switchSection(name) {
      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === name);
      });
      const titleEl = document.getElementById('sectionTitle');
      if (titleEl) titleEl.textContent = sectionTitles[name] || name;
      const mobileSection = document.getElementById('mobileAdminSection');
      if (mobileSection) mobileSection.value = name;
      const dashSection = document.getElementById('section-dashboard');
      if (dashSection) dashSection.classList.remove('active');
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      if (name === 'dashboard') { if (dashSection) dashSection.classList.add('active'); }
      else { const tabEl = document.getElementById('tab-' + name); if (tabEl) tabEl.classList.add('active'); }
      if (name === 'products') loadProducts();
      if (name === 'orders') loadOrders();
      if (name === 'reports') { loadPnlStats(); loadSalesSummary(); }
      if (name === 'reviews') loadReviews();
    }

    // ================================================================
    // INIT
    // ================================================================
    setupQuickUpload();
    setupFormFrontUpload();
    setupFormBackUpload();
    setupFormExtraUpload();
    checkAuth();

    // Keep keyboard focus within the password dialog; Escape restores focus.
    document.addEventListener('keydown', e => {
      const modal = document.getElementById('changePwModal');
      if (modal.style.display !== 'flex') return;
      if (e.key === 'Escape') { e.preventDefault(); closeChangePasswordModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll('button, input')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });

    // ================================================================
    // FE-H2: DELEGATED EVENTS — no inline handlers anywhere.
    // Clickables carry data-action="name" (+ data-* params); selects and
    // checkboxes carry data-change, text filters data-input, the product
    // form data-form, and the stock-edit box data-keys. Document-level
    // listeners route via closest(), so the innermost match wins. IDs are
    // Number()ed on the way in: several callees compare with === against
    // the numeric ids parsed from JSON. data-change and data-input stay
    // strictly separate because checkboxes fire both events.
    // ================================================================
    const ADMIN_ACTIONS = {
      'login': () => handleLogin(),
      'request-pw-reset': () => requestPasswordReset('admin'),
      'section': (el) => switchSection(el.dataset.section),
      'open-pw-modal': () => openChangePasswordModal(),
      'close-pw-modal': () => closeChangePasswordModal(),
      'change-pw': () => handleChangePassword(),
      'logout': () => handleLogout(),
      'theme': () => toggleTheme(),
      'clear-images': () => clearImageSelection(),
      'quick-upload': () => handleQuickUpload(),
      'clear-product-filters': () => clearProductFilters(),
      'delete-selected': () => deleteSelectedProducts(),
      'front-input': () => document.getElementById('frontInput').click(),
      'reset-form': () => resetForm(),
      'order-sort': () => toggleOrderSort(),
      'export-csv': () => exportOrdersCsv(),
      'review-filter': (el) => setReviewFilter(el.dataset.value),
      'pnl-period': (el) => setPnlPeriod(el.dataset.value),
      'load-products': () => loadProducts(),
      'load-orders': () => loadOrders(),
      'toggle-stock': (el) => toggleStock(Number(el.dataset.id)),
      'start-stock-edit': (el) => startStockEdit(Number(el.dataset.id), el),
      'save-stock': (el) => saveStockEdit(Number(el.dataset.id)),
      'cancel-stock': (el) => cancelStockEdit(Number(el.dataset.id)),
      'edit-product': (el) => editProduct(Number(el.dataset.id)),
      'delete-product': (el) => deleteProduct(Number(el.dataset.id)),
      'verify-payment': (el) => verifyPayment(Number(el.dataset.id), el.dataset.value),
      'cod-confirm': (el) => codConfirm(Number(el.dataset.id), el.dataset.value),
      'status-dropdown': (el) => toggleStatusDropdown(el),
      'order-status': (el) => updateOrderStatus(Number(el.dataset.id), el.dataset.status),
      'review-status': (el) => setReviewStatus(Number(el.dataset.id), el.dataset.status),
      'delete-review': (el) => deleteReview(Number(el.dataset.id)),
    };
    document.addEventListener('click', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const hit = e.target.closest('[data-action]');
      if (!hit) return;
      const fn = ADMIN_ACTIONS[hit.dataset.action];
      if (!fn) return;
      if (hit.tagName === 'A') e.preventDefault();
      fn(hit, e);
    });
    const ADMIN_CHANGES = {
      'section-select': (el) => switchSection(el.value),
      'filter-products': () => filterProducts(),
      'filter-orders': () => filterOrders(),
      'select-visible': (el) => toggleSelectVisibleProducts(el.checked),
      'product-select': (el) => toggleProductSelection(Number(el.dataset.id), el.checked),
    };
    document.addEventListener('change', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const hit = e.target.closest('[data-change]');
      if (!hit) return;
      const fn = ADMIN_CHANGES[hit.dataset.change];
      if (fn) fn(hit, e);
    });
    const ADMIN_INPUTS = {
      'filter-products': () => filterProducts(),
      'filter-orders': () => filterOrders(),
    };
    document.addEventListener('input', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const hit = e.target.closest('[data-input]');
      if (!hit) return;
      const fn = ADMIN_INPUTS[hit.dataset.input];
      if (fn) fn(hit, e);
    });
    document.addEventListener('submit', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const form = e.target.closest('[data-form]');
      if (!form) return;
      if (form.dataset.form === 'save-product') handleSaveProduct(e);
    });
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      const hit = t.closest('[data-keys]');
      if (!hit) return;
      if (hit.dataset.keys === 'stock-edit') {
        const id = Number(hit.dataset.id);
        if (e.key === 'Enter') saveStockEdit(id);
        else if (e.key === 'Escape') cancelStockEdit(id);
      }
    });

    // (Change-password Enter submit is bound in openChangePasswordModal() —
    // the modal markup lives after this script, so it doesn't exist yet here.)
  