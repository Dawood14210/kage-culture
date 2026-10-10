# Admin Dashboard — Fault Audit

> **STATUS: FIXED (2026-10-10)** — every fault below was repaired in the same
> session, plus a separate pass over the Add-Product flow and an emoji→SVG icon
> conversion. See the **Resolution log** at the end for what changed and the
> live proof results. Original audit preserved below for context.

**Scope:** `public/admin.html` (2,626 lines) + backing API routes (`routes/admin.js`, `routes/orders.js`, `routes/products.js`, `routes/auth.js`, `routes/reviews.js`, `middleware/csrf.js`, `middleware/auth.js`, `middleware/rateLimit.js`, `config.js`).
**Method:** full static read-through (CSS, markup, ~1,300-line inline script, all routes), DOM id cross-check, inline-script syntax check (`node --check`), plus a live server boot (sql.js in-memory, UTC host) with real orders placed to prove/disprove each suspected fault.
**Date:** 2026-10-10 · Branch `arena/69aa2172-kage-culture` · No code was modified.

**Legend:** 🟥 high · 🟧 medium · 🟨 minor · ✅ verified clean

---

## 🟥 HIGH — data integrity / correctness

### H1. "Revenue Today" is permanently Rs. 0 (date-format comparison bug)
- `routes/admin.js:41-47` — boundaries built as `new Date(y,m,d).toISOString()` → `"2026-10-10T00:00:00.000Z"` (T, ms, Z), but `orders.created_at` is stored as `"YYYY-MM-DD HH:MM:SS"` (`routes/orders.js:42` — space, no T). SQLite compares the two strings lexicographically; at the first differing byte `' '` (0x20) < `'T'` (0x54), so **every row dated the same day as the boundary is excluded regardless of time**.
- **Proof (live):** two orders placed today → `stats/sales.revenueToday = 0` while `stats/dashboard.revenue = 650` and `revenueWeek = 1050`. On a UTC host (Vercel production), *all* of today's rows are excluded → revenue today is **always 0**, forever. Week/month lose the boundary day (Sunday / the 1st). On a non-UTC host the window instead drops the first hours of the local day — wrong either way.
- Same bug means week/month windows compare a UTC-derived boundary against local-day logic: the three "revenue" numbers on the Reports → Sales Summary (`salesRevToday/Week/Month`, `public/admin.html:2357-2373`) are all unreliable.

### H2. Cancelled orders are counted as revenue everywhere (except best-seller)
- `routes/admin.js:35` — dashboard Revenue = `SUM(total) FROM orders`, no status filter.
- `routes/admin.js:44-46` — Sales today/week/month: no status filter.
- `routes/admin.js:66` — P&L: `SELECT total, created_at, items_json FROM orders` — cancelled orders contribute revenue, cost **and profit**.
- Only `bestProduct` (`routes/admin.js:48`) excludes cancelled → the dashboard is internally inconsistent (3 revenue numbers, all wrong).
- **Proof (live):** after cancelling the only order, `stats/dashboard.revenue` stayed **650**, and P&L summary stayed `revenue 650 / cost 160 / profit 490`. `revenueWeek = 1050` includes the cancelled 650.

### H3. Cancel → Reset → Cancel cycle inflates stock
- `routes/orders.js:140-145` — stock is restored on any transition **into** `cancelled`, but never re-decremented when leaving `cancelled` (the "Reset to Pending" button `public/admin.html:2190` works from any status).
- **Proof (live):** product stock 10 → order qty 2 → 8 → cancel → 10 → reset to pending → 10 → cancel again → **12**. Two units created from nothing; each extra cycle adds more. The storefront then oversells.

### H4. Editing a product can upload the previous image blob / show stale previews
- `editProduct()` (`public/admin.html:1663-1704`) never clears `formImageBlob` (declared 1745, appended unconditionally at 1882) or `currentImageFiles.back`, and never resets `frontPreview`/`backPreview`/`frontIdle`/`formImgChange` when the edited product has **no** image.
- **Sequence:** Add Product → pick an image → abandon the form → Products → Edit an imageless product → Update → the stale blob is silently uploaded as its front image. Also: preview of product A stays on screen while editing product B without an image; error/success banners from the previous action are not cleared.

### H5. Enter on the password field submits login twice
- Two independent handlers: `public/admin.html:1553-1555` (`#loginPassword` keydown → `handleLogin()`) and the document-level handler `:2603-2606` (`Enter && !isLoggedIn → handleLogin()`); the event bubbles so **both fire per keypress**, and `handleLogin` has no in-flight guard (`btn.disabled` is set but never checked at entry).
- **Impact:** two concurrent `POST /api/admin/login` per Enter against `strictLimiter` = **10/min** (`config.js:24`) → ~5 Enter presses lock login out for a minute ("Too many attempts"). Enter in the email field fires only once (asymmetric behavior).

---

## 🟧 MEDIUM — broken or missing UI behavior

### M1. `awaiting_verification` orders render raw and unstyled
- Dashboard Recent Orders label map (`public/admin.html:1379`) **omits** `awaiting_verification` → falls back to `|| st` → shows the literal string `awaiting_verification` (proved live: orders list contains that status; the map has no entry).
- CSS has only 5 badge classes (`.status-pending/confirmed/shipped/delivered/cancelled`, `public/admin.html:498-502`) — **no `.status-awaiting_verification`** → the badge renders with the bare `.status-border` style in both Dashboard and Orders (the Orders label map at `:2168` is correct, the color is not).
- Bank/JazzCash orders always start as `awaiting_verification` (`routes/orders.js:43`), so this is the default state of every pre-payment order.

### M2. Session expiry is never handled after the initial load
- No fetch handler ever redirects to login on 401: `loadDashboardStats` silently `return`s (`:1364`, empty `catch {}` at `:1397`), `loadOrders` shows a Retry button that can never succeed (`:2131-2136`), `loadReviews` shows "Failed to load reviews" (`:2383`), `verifyPayment`/`updateOrderStatus` alert generic errors. The admin is stuck on a stale dashboard with no way back to the login screen except a manual reload.

### M3. P&L tab dies silently if Chart.js fails to load
- `loadPnlStats` (`public/admin.html:2416-2419`) does `if (!window.Chart) return;` **before fetching** → the summary cards (Revenue/Cost/Profit) never populate either, even though they don't need Chart. `loadDashboardStats`'s empty `catch` (`:1397`) similarly hides any dashboard failure. The vendor file exists (`public/vendor/chart.umd.min.js`, 205 KB), so this only bites when it fails to load — but then the whole Reports tab shows "—" with no error.

### M4. `setPnlPeriod` strips the Reviews filter pills' active state
- `:2404-2410` uses **unscoped** `document.querySelectorAll('.period-btn')`, but the Reviews toolbar buttons also have class `period-btn` (`:1259-1261`, `data-rf` not `data-period`). Clicking Daily/Weekly/Monthly in Reports removes `.active` from the Reviews pills (filter value unaffected — visual desync). `setReviewFilter` (`:2380`) is correctly scoped to `.reviews-toolbar`, so the break is one-directional.

### M5. `loadProducts` never checks `res.ok`
- `:1560-1568` assigns `products = await res.json()` unconditionally. On any non-200 JSON error, `products` becomes an object → `filterProducts()` throws (caught → generic "Failed to load products"), and later `products.find`/`.filter` calls (e.g. `productName()` used by Reviews `:2392`) cascade. Every other loader (`loadOrders`, `loadReviews`, `loadSalesSummary`, `loadDashboardStats`) checks `res.ok`.

### M6. Status changes email the customer with no confirmation (except Cancel)
- Dropdown items Confirm / Mark Shipped / Delivered / Reset to Pending execute the PATCH on a single click (`:2186-2190`); the backend emails the customer on every transition (`routes/orders.js:153-157`). **Proof (live):** the cancel→pending→cancel test produced 3 "Order Status Update" emails for one order. A misclick = an official email to the customer, repeatedly.

### M7. Payment verification is state-blind
- "✓ Verify Payment" is rendered for **every** order (`:2185`) regardless of current `payment_verified`, including COD orders where payment happens on delivery; the row never displays `payment_verified` (only `cod_confirmed` gets a badge, `:2171`). The backend supports `verified:false` / `confirmed:false` (`routes/orders.js:166,179`) but the UI offers no un-verify / un-confirm — only "COD Confirmed" once, no undo.

### M8. Stock inline editor + restock are dead code; quantities invisible in the list
- `startStockEdit`/`saveStockEdit`/`cancelStockEdit`/`restockProduct` (`:2313-2338`) have **zero call sites** — `renderProductList` (`:1570-1621`) renders only an In Stock/Sold Out toggle, never a quantity. Admins cannot see or change quantities in the Products list at all (only via the Edit form's `prodStockQty`), yet the dashboard advertises a "Low Stock (<5)" count they can't drill into.

### M9. Order CSV export exists but is unreachable
- `GET /api/orders/export/csv` (`routes/orders.js:124-135`) works (proved live: HTTP 200, correct CSV) but `admin.html` contains **zero references** — no Export button anywhere. Dead endpoint / missing feature.

---

## 🟨 MINOR

| # | Fault | Where |
|---|---|---|
| N1 | **Quick-upload products bypass inventory & size logic**: no `sizes` sent → backend defaults to S–XXL (all 5 sizes shown on storefront for what admin thinks is one item); no `stock_qty` → `null` → orders never decrement stock and the product is excluded from the Low-Stock count; `unit_cost` auto-filled with a fabricated `max(50, price×0.55)` estimate. | `routes/products.js:64-75`, `public/admin.html:2059` |
| N2 | **P&L "profit" is an estimate presented as exact**: cost falls back to 55% of price (min Rs. 50) whenever `unit_cost`/line-item cost is absent; combined with H2 (cancelled included) the Profit figure can't be trusted. | `routes/admin.js:77-80`, `routes/orders.js:39` |
| N3 | **Product rows show the category twice** (subtitle under the name *and* a Category column). | `public/admin.html:1597-1610` |
| N4 | **5 stat cards in a 4-column grid** — Low Stock card is orphaned alone on row 2 at 25% width. | `.dash-stats` `:465-467`, cards `:991-1027` |
| N5 | `handleLogout` ignores the response — a failed logout (403/500) still shows the login screen while the session cookie survives (reload = logged back in); a network throw skips `showLogin()` entirely. | `public/admin.html:1491-1494` |
| N6 | Review approve/reject/delete fail **silently** — no `else` branch for `!res.ok`, empty `catch {}` → no alert, no list reload. | `public/admin.html:2398-2399` |
| N7 | Enter behavior is inconsistent: email field → single attempt (often with empty password → validation error), password field → double (H5), change-password modal → Enter does nothing (must click). | `:1553`, `:2603`, modal `:2610+` |
| N8 | Dead markup/code: hidden `.tabs` strip (`.tabs`/`.tab` `display:none` `:190-191`) with `switchTab` still wired; `POST /api/upload` and `POST /api/admin/create` have no UI anywhere in `public/`. | grep-verified |
| N9 | Backend `GET /api/orders?search=&status=` supported (`routes/orders.js:107-118`) but the admin UI only filters client-side — no search box exists for orders (products have one, orders don't). | `public/admin.html:1236-1247` |
| N10 | Totals rendered as raw `` `Rs. ${o.total}` `` in Orders/Recent Orders (no `toLocaleString`) while stat cards use `fmtRs` — inconsistent number formatting. | `:1386`, `:2178` |
| N11 | Week definitions disagree: Sales summary week starts **Sunday** (`routes/admin.js:43`), P&L weekly buckets start **Monday** (`routes/admin.js:71`) — the same period means different things in two places on the same tab. | — |
| N12 | The hidden tab strip's first button still carries a stale `.active` class; harmless today only because the strip is permanently `display:none`. | `:1041-1048` |
| N13 | `low-stock-card` label hardcodes `"<5"`; it matches `config.LOW_STOCK_THRESHOLD: 5` today but will silently lie if the config changes. | `:1025`, `config.js:8` |

---

## ✅ Verified clean (checked, no fault)

- **CSRF**: `kage.csrf` cookie readable (no HttpOnly) by design; the fetch monkey-patch (`:1330-1345`) attaches `X-CSRF-Token` to every mutating request including FormData uploads; `requireCsrf` compares header to the raw cookie token consistently; explicit tokens on verify/cod-confirm are redundant but harmless. Login/setup are intentionally un-CSRF'd (credential endpoints, rate-limited).
- **XSS**: every dynamic insertion in the dashboard renderers goes through `esc()` (orders, products, reviews, dashboard, sales) or is a server-controlled enum/number; no unescaped `innerHTML` sink found.
- **DOM ids**: all 152 `getElementById`/literal `querySelector` targets exist (static + `id=` created in JS) — zero missing.
- **Inline script**: `node --check` clean (no syntax errors).
- **Auth routes**: first-run setup gated by `ALLOW_ADMIN_SETUP`, login behind `strictLimiter` (10/min), password reset behind `resetLimiter` (5/min) with hashed single-use tokens, change-password verifies the current password, admin create requires auth+CSRF.
- **Review routes**: PATCH/DELETE correctly guarded (`requireCsrf, requireAuth`), status enum validated.
- **`.tabs` hidden strip**: confirmed intentional (sidebar drives navigation) — the stale-active-tab candidate from earlier notes is invisible and harmless.
- **`verifyPayment`/`codConfirm` not refreshing dashboard stats**: non-issue — neither changes any value the stat cards display.
- **Frontend test suite**: 8/8 and API suite 33/33 pass (they don't cover the faults above; the stats endpoints are untested for cancelled/UTC-window behavior).

---

## Resolution log (2026-10-10) — all fixed

### Backend
| Fault | Fix | Proof (live server) |
|---|---|---|
| H1 date-format window bug | `routes/admin.js`: boundaries formatted `'YYYY-MM-DD HH:MM:SS'` via `toTs()` to match stored `created_at` | `revenueToday = 650` for an order placed today (was always 0) |
| H2 cancelled counted as revenue | `status != 'cancelled'` (param-bound) on dashboard revenue, all 3 sales windows, and P&L order scan | cancel → dashboard `0`, sales `0`, P&L `{0,0,0}` |
| H3 stock inflation cycle | `routes/orders.js`: leaving `cancelled` re-decrements stock (floor 0) | cycle 10→8→cancel→10→pending→8→cancel→**10 — balanced** |
| AP: `unit_cost` discarded on create | POST now accepts `unit_cost`, estimate only as fallback | created with `unit_cost=455` → stored 455 (was 55% of price) |
| AP: weak validation | POST/PUT: price must be finite >0, stock_qty/unit_cost non-negative numbers, sizes must parse — all 400; caps on name(120)/fit(60)/description(2000) | `price=abc`→400, `stock_qty=xyz`→400, `PUT price=abc`→400, `sale>=price`→400 |
| AP: files mutated before validation | PUT validates the body **before** persisting/removing images (invalid edits no longer delete the old image or orphan uploads) | — |
| N11 week mismatch | Sales week start moved to **Monday** (matches P&L buckets) | — |

### Frontend (`public/admin.html`)
| Fault | Fix |
|---|---|
| H4 stale image on edit | `editProduct()` now calls `resetForm()` first (clears blob, previews, banners); `resetForm` also hides the live card; create flow re-shows it after reset |
| H5 double login POST | global Enter handler removed; one handler per login field + `btn.disabled` re-entrancy guard |
| M1 `awaiting_verification` raw/unstyled | label added to dashboard map; `.status-awaiting_verification` CSS class added |
| M2 session expiry | fetch patch now returns-to-login on any mid-session 401; mutation alerts skip when already redirected |
| M3 P&L gated on Chart.js | fetch + summary cards run first; only the chart render checks `window.Chart` |
| M4 reviews pills de-highlighted | `setPnlPeriod` scoped to `.period-toggle .period-btn` |
| M5 `loadProducts` no `res.ok` | `res.ok` + `Array.isArray` check + Retry button (matches other loaders) |
| M6 status emails on misclick | `updateOrderStatus` confirms every transition (incl. Cancel) and states that the customer is emailed |
| M7 payment state-blind | menu is now state-aware: non-COD → Verify / Remove Verification; COD → Mark COD Confirmed / Undo; rows show a "Payment Verified" badge |
| M8 stock editor dead code | quantity rendered in the product list (`.stock-qty-display`) opening the inline editor; empty save = no change (was silently 0); `restockProduct` dead code removed |
| M9 CSV export unreachable | "Export CSV" button in the Orders toolbar (respects the status filter) |
| N3 duplicate category cell | subtitle category removed (column kept) |
| N4 5 cards in 4-col grid | `.dash-stats` uses `repeat(auto-fit, minmax(150px,1fr))` |
| N5 logout ignores failures | `handleLogout` checks the response, alerts errors, refreshes a missing CSRF cookie first |
| N6 silent review failures | approve/reject/delete alert on failure |
| N7 inconsistent Enter | email + password each submit; change-password modal Enter submits (bound in `openChangePasswordModal`, modal markup loads after the script) |
| N8/N12 dead tab strip | hidden `.tabs` markup, `.tabs`/`.tab` CSS and `switchTab()` removed (tab panels + sidebar untouched) |
| N9 no order search | search input filters by order #, name, phone, email client-side |
| N10 raw totals | `fmtRs()` used for order + product + live-card totals |
| N13 hard-coded `<5` | low-stock label set from `lowStockThreshold` returned by the API |

### Add-Product flow (found & fixed in this pass)
1. **Advanced fields were hidden on create** — Category/Fit/Sale/Unit Cost/Stock/Size/Back image only appeared when *editing*, so every new product silently became `category: anime` with untracked stock. `#extraFields` is now always visible.
2. **Unit Cost on create was discarded** (backend ignored it — see AP row above).
3. **No client-side sale-price check** — now validated against the regular price before submitting.
4. **Double-submit** — Enter inside name/price/description re-fired `handleSaveProduct` (same class as the login bug); added `btn.disabled` guard.
5. **Stale live-card** — after Cancel/Reset the "Live in shop" card could persist; reset now clears it (create shows it explicitly after reset).
6. **Quick Upload** hard-coded `category: 'anime'` and the 5-size default — now has Category and Size selects and sends `sizes` explicitly.
7. **Uncapped/invalid API input** — see backend validation rows.

### Icons
All emoji glyphs (sidebar ×7, View Store, stat cards ×5, upload cameras ×2, status menu ×7, sort arrows, stock editor, review actions, both live-card checks, modal close, rating stars) replaced with a **21-symbol inline SVG sprite** + `icon()` / `starRating()` helpers (feather-style, `stroke: currentColor`). Emoji scan of `admin.html` returns **zero** pictographic glyphs.

### Verification
- `npm test`: **33/33 API + 8/8 frontend** scenarios pass (jsdom reports no script errors).
- `node --check` on the extracted inline script: clean.
- Live proof script against a booted server: H1 ✓ H2 ✓ H3 ✓ unit_cost ✓ 4 validation 400s ✓ CSV 200 ✓ `awaiting_verification` flow ✓.

### Known remaining limitations (by design / data-dependent)
- P&L unit cost still falls back to 55% of price for **legacy rows created before this fix** (rows themselves are unchanged); new products store the admin-entered cost.
- Backend `/api/upload` and `POST /api/admin/create` remain endpoint-only (no UI); nothing in the app calls them.
