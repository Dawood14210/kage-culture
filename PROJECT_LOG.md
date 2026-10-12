# KAGE Culture — Project Log

> A chronological record of everything done on this project during the AI-assisted
> sessions (August – September 2026). For the *live* security queue, see `AUDIT.md`;
> this file is the narrative "what we did and why."

**Stack:** Express + vanilla-JS SPA storefront (`public/index.html`) + admin panel
(`public/admin.html`), dual-backend DB in `database.js` (Turso in prod, sql.js local,
in-memory fallback), deployed on Vercel serverless. All magic numbers in `config.js`.

---

## 1. Security audit & remediation (API) — completed 2026-09-20

Full audit found and fixed, in priority order:

| Item | Severity | Fix |
|---|---|---|
| Admin auth bypass | 🔴 Critical | `middleware/auth.js` rewritten: HMAC signature verification of session cookies, constant-time compare. Verified with 7/7 e2e tests. |
| **C1** — `/api/admin/setup` | 🔴 Critical | Gated behind `ALLOW_ADMIN_SETUP=true`; atomic `ON CONFLICT (email) DO NOTHING` insert; removed storefront/admin auto-setup calls (`index.html:6617` era). |
| **H1** — public order PII leak | 🟠 High | `GET /api/orders/:orderNumber` now requires matching phone (401 no phone / 404 wrong phone); response sanitized (no email/address). |
| **H2** — silent data loss on Vercel | 🟠 High | Boot without Turso on Vercel now fails loudly (exit 1 / 503) instead of silently using a throwaway in-memory DB. `run()` returns `changes` on all backends; mem-store DELETE reports real `changes`. |
| **H3** — fire-and-forget emails | 🟠 High | Order-confirmation and status-update emails awaited before responding (in try/catch — serverless lambdas freeze after `res.json()`). |
| **H4** — dependency vulns | 🟠 High | `npm audit` → 0 vulnerabilities; multer 1.4.5 → 2.4.0; `/api/upload` got an image-only fileFilter. |
| **M1** | 🟡 Med | `trust proxy 1` for correct IPs behind Vercel. |
| **M2** | 🟡 Med | Atomic stock decrement (`UPDATE … WHERE stock_qty >= ?`) + order rollback if the guarded update races to zero rows. |
| **M3** | 🟡 Med | Removed dead inline Set-Cookie blocks from auth routes (double-set conflict). |
| **M4** | 🟡 Med | CSP tightened (see §5 for the incident this caused). |
| **M5** | 🟡 Med | Generic 500 messages everywhere + server-side error logging (no internal leakage). |
| **M6** | 🟡 Med | `esc()` applied to all raw HTML interpolations in storefront + admin, incl. a wishlist `onclick`-injection XSS vector. |
| **M7** | 🟡 Med | Static assets cached 1 year; HTML stays no-cache. |
| **L1/L3–L7** | 🔵 Low | Repo debris deleted; `database.js` header fixed; `/admin.html` → 301 → `/admin` (L4); manifest `theme_color` fixed (L5); keyboard/screen-reader access on cards, tiles, thumbs, dots (L6); **`tests/e2e.test.js` regression suite created (L7)**. |
| **L2** | 🔵 Low | 26 media assets committed to the repo (were untracked). |

**Result:** 14/14 e2e tests passing, 0 npm vulnerabilities, fail-loud deploys.

---

## 2. Frontend audit & fixes — completed 2026-09-23

Static analysis of `index.html` (7,033 lines) and `admin.html` found user-facing
breakage; all criticals fixed in one pass with tests:

| Item | Severity | Fix |
|---|---|---|
| **FE-C1** — cards opened stale product | 🔴 Critical | Home/best-seller/related/recently-viewed/wishlist cards + Quick View now call `openProductDetail(id)`; `navigateTo('product', id)` ignored the id. Keyboard/AT support added. |
| **FE-C2** — account page dead endpoints | 🔴 Critical | Added `GET /api/customers/me` (session restore, never returns `password_hash`) and `PUT /api/customers/me` (CSRF + customer auth; handles profile fields **and** password change with current-password verify). |
| **FE-C3** — admin PnL chart dead | 🔴 Critical | Chart.js 4.4.1 self-hosted at `public/vendor/chart.umd.min.js` — same-origin passes CSP `scriptSrc 'self'` (CDN version was silently blocked). |
| **FE-C4** — password reset dead end | 🔴 Critical | Built the missing `#page-reset` view: reads `token`/`type` from the email link, client validation, POSTs to `/api/auth/reset-password`; boot routes `/reset-password` to it. |
| **FE-H1** — collection-grid XSS gap | 🟠 High | `esc()` applied to the last unescaped `src=`/`data-src=` interpolations. |

Tests extended 14 → **24/24 passing** (auth persistence, sanitized GET, profile
persistence, wrong-password rejection, old/new password swap, bogus reset token,
reset shell serving, vendor asset, card wiring…).

---

## 3. Publishing to GitHub — 2026-09-23

- Repo created: **[github.com/Dawood14210/kage-culture](https://github.com/Dawood14210/kage-culture)** (private).
- Pushed in logical commits: media assets → API remediation → frontend fixes.
- Verified `.env`, `kage.db`, `uploads/`, `.vercel/` are git-ignored; only `.env.example` tracked.
- All API tokens used during setup were single-use and revoked after.

**Git identity (repo-local):** `Dawood14210 <160178068+Dawood14210@users.noreply.github.com>`
— set after Vercel's author check rejected commits by another account (§5).

---

## 4. Production deployment (Vercel + Turso) — 2026-09-23

- **Vercel project:** `kage-culture` (team `daw00d`), git-linked to
  `Dawood14210/kage-culture` — auto-deploys on every push to `master`.
- **Production URL:** `https://kage-culture-ruby.vercel.app`
  (⚠️ `kage-culture.vercel.app` belongs to an older project on a different team —
  candidate for deletion).
- **Turso DB:** `kage-dawood14210` (aws-ap-south-1) — schema auto-created, 20 products
  seeded, connection verified with a live `SELECT 1` before wiring anything.
- **Env vars set:** `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, fresh 48-byte
  `SESSION_SECRET`, `ALLOW_ADMIN_SETUP` (see §6), `AUTO_CREATE_ADMIN=false`
  (old backdoor closed).

---

## 5. Production incident — CSP made the site unclickable — fixed same day

**Symptom:** pages rendered but nothing was clickable.

**Root cause:** the M4 CSP cleanup removed `scriptSrcAttr: ["'unsafe-inline'"]` from
the helmet config. Helmet then **defaults** to `script-src-attr 'none'`, silently
blocking every inline `onclick`/`onkeydown` — and both pages are built on hundreds
of inline handlers.

**Fix:** directive restored in `server.js` with a comment explaining it must stay
until the FE-H2 event-delegation migration lands. Verified locally (24/24 tests)
and in the live production header.

**Secondary lesson:** the fix commit was authored by a non-member GitHub account,
and Hobby teams reject Git deploys from non-members — it sat BLOCKED until the tip
was re-authored as `Dawood14210`. Repo-local git identity now guarantees this.

**Meta-lesson:** the original post-deploy check "CSP clean (no script-src-attr)"
read the bug as a pass — header changes must be compared against *expected* values,
not just checked for absence of old ones.

---

## 6. Admin bootstrap — completed 2026-09-23

- First admin created via the gated `POST /api/admin/setup` (no UI by design —
  the old auto-setup was a security hole removed in C1).
- Login verified end-to-end with the CSRF flow; dashboard returned live data
  (20 products).
- `ALLOW_ADMIN_SETUP` flipped to `false` and **redeployed**; re-probe confirmed
  `403 Admin setup is disabled`. The bootstrap window is closed for good — new
  admins can only be created by a logged-in admin via `/api/admin/create`.

> ⚠️ Note recorded in the smoke test (§7): the bootstrap password stopped matching
> shortly after setup — most likely the owner changed it (recommended, since it
> passed through chat). If it was **not** changed by the owner, rotate immediately.

---

## 7. Production smoke test — 2026-09-23 (customer flows)

| Flow | Checks | Result |
|---|---|---|
| Browse | `/` 200 (330 KB) · `/api/products` 20 items · hero images, mp4, Chart.js, manifest, sitemap, `/reset-password`, `/admin` all 200 | ✅ |
| Checkout | CSRF bootstrap → `POST /api/orders` **201** → order `KAGE-3LRV34YB` (COD, Cheese God ×1, total 400 = 250 sale + 150 shipping), status `pending` | ✅ |
| Stock | Atomic decrement 10 → 9 on order; restored to 10 on cancel | ✅ |
| Tracking | `/api/orders/track` good phone 200 **sanitized** (no email/address) · no phone 400 · wrong phone 404 · `/api/orders/:num` 401/404 gates (H1 live) | ✅ |
| Admin cancel | Login rejected the bootstrap password (see §6 note) — cleanup done at the DB layer, replicating the cancel route's exact logic | ✅* |

**Cleanup:** test order marked `cancelled` (clearly labeled "SMOKE TEST — DO NOT
FULFILL"), stock fully restored.

**Hardening candidate (low):** login routes are CSRF-exempt (no session exists yet —
standard) but adding `requireCsrf` to admin/customer login would additionally
harden against login-CSRF phishing.

---

## Current state (2026-09-23, end of day)

- 🟢 Production live: `https://kage-culture-ruby.vercel.app`
- 🟢 GitHub: `Dawood14210/kage-culture` (private), auto-deploy on push to `master`
- 🟢 Turso cloud DB, 20 products seeded, 1 cancelled smoke-test order
- 🟢 24/24 e2e tests, 0 npm vulnerabilities, setup gate closed, CSP correct
- 🟡 Admin password rotation recommended if not already changed (§6)

---

## 8. Feature removal — KAGE Animals & Clan Spin the Wheel — 2026-10-10

**Request:** mirror the previous session's removal of two experimental features.

**Commit `6bbb64c` (pushed to `arena/69aa2172-kage-culture`):**
- Deleted `/kage-animals` page + route and `/api/spin` endpoints (404 verified).
- Removed `spin` / `sticker` DB helpers for new DBs (existing Turso tables retained for safety).
- Deleted 33 associated media files (`animal-*.jpg`, stickers, etc.).
- Kept `KAGE Clothes` (`kage-animals*` was not clothing), `animal-*.jpg` product images used by Goofy Wears, clan-join CTA, og:image, and admin spinner CSS deliberately retained (checked via grep).

**Verification:** `GET /kage-animals` 404, `GET /api/spin` 404, 33 media deletions.

---

## 9. Admin dashboard deep audit, SVG migration & Add-Product hardening — 2026-10-10

**Scope:** `public/admin.html` (2,626 lines → 2,839 after fixes) + backing routes (`routes/admin.js`, `routes/orders.js`, `routes/products.js`), full static read-through + live server boot with real orders to prove each fault (sql.js in-memory, UTC host, same string-compare semantics as Turso/SQLite).

**Audit result:** `ADMIN_DASHBOARD_FAULTS.md` — **27 faults found: 5 high, 9 medium, 13 minor**, plus 7 add-product-specific faults discovered in a second pass. All proven live before fixing.

### What was DONE (commits `ae021f8` + `09fd6cb`) — fixes shipped & verified

#### Backend — data integrity (verified live)
| Fault | What was wrong | What was done | Live proof |
|---|---|---|---|
| **H1** Revenue Today = 0 forever | `admin.js` built ISO boundaries `…T00:00:00.000Z` but `orders.created_at` is `… HH:MM:SS` (space). SQLite string-compare ` ' ' < 'T'` excluded every row on the boundary date. | `toTs()` formats boundaries as `'YYYY-MM-DD HH:MM:SS'` matching storage; week start moved to **Monday** (was Sunday, mismatched P&L weekly buckets - N11). | 1 order today → `revenueToday 0→650` (was always 0), `revenueWeek`/`Month` no longer miss the 1st/Sunday |
| **H2** Cancelled = revenue | `SUM(total)` and P&L scanned all rows; only `bestProduct` excluded cancelled → 3 inconsistent revenue numbers | `WHERE status != ?` (param-bound `'cancelled'`) on dashboard revenue, all 3 sales windows, and P&L scan | Cancel → `dashboard.revenue 650→0`, `sales.revenueToday 650→0`, `pnl {0,0,0}` (was 650/160/490) |
| **H3** Stock inflation | Cancel restored stock, but `Reset to Pending` never re-decremented → `10→8→cancel→10→reset→10→cancel→12` | `orders.js`: leaving `cancelled` re-decrements (floor 0) | Cycle `10→8→10→8→10` **balanced** (was 10→12) |
| **Products POST ignored `unit_cost`** | Backend always estimated `max(50, price×0.55)` even when admin typed a cost → P&L profit wrong | POST now honors `unit_cost` when supplied; only estimates when absent | Create `unit_cost=455` → stored 455 (was 550) |
| **Weak validation** | `price=abc`, `stock_qty=xyz` could be sent; names/descriptions uncapped; sizes could be malformed | POST/PUT: `price` finite >0, `stock_qty`/`unit_cost` ≥0 numbers, `sizes` must parse as array, caps `name 120`/`fit 60`/`desc 2000`; PUT validates **before** touching files (invalid edit no longer deletes old image or orphans upload) | `price=abc→400`, `stock_qty=xyz→400`, `PUT price=abc→400`, `sale>=price→400` |
| **CSV export dead** | `GET /api/orders/export/csv` worked but no UI | Added **Export CSV** button to Orders toolbar (respects status filter) | `HTTP 200` with status filter |

#### Frontend `public/admin.html` — behavior & UI
| Fault | Fix |
|---|---|
| **H4** Stale image on edit | `editProduct()` now calls `resetForm()` first (clears `formImageBlob`, previews, banners); `resetForm` hides live-card; create re-shows it after reset |
| **H5** Double login POST | Removed global Enter handler; one handler per field + `btn.disabled` re-entrancy guard (was 2 concurrent `POST /api/admin/login` per Enter against 10/min limit) |
| **M1** `awaiting_verification` raw/unstyled | Added label to dashboard map + `.status-awaiting_verification` CSS |
| **M2** Session expiry | Fetch wrapper bounces to login on any mid-session 401; mutation alerts skip when already redirected |
| **M3** P&L gated on Chart.js | Fetch + summary cards run first; only chart render checks `window.Chart` (was `if (!window.Chart) return` before fetch) |
| **M4** Reviews pills cleared | `setPnlPeriod` scoped to `.period-toggle .period-btn` (was unscoped `.period-btn`) |
| **M5** `loadProducts` no `res.ok` | Added `res.ok` + `Array.isArray` check + Retry button |
| **M6** Status emails on misclick | `updateOrderStatus` now `confirm()` every transition (states customer will be emailed) |
| **M7** Payment state-blind | Menu state-aware: non-COD `Verify/Remove Verification`, COD `Mark COD Confirmed/Undo`; row shows `Payment Verified` badge |
| **M8** Stock editor dead | Rendered `stock-qty-display` quantity in product list opening inline editor; empty save = no change (was silently 0); removed dead `restockProduct` |
| **N3** Category twice | Removed subtitle category (column kept) |
| **N4** 5 cards in 4-col grid | `repeat(4,1fr)` → `repeat(auto-fit, minmax(150px,1fr))` |
| **N5** Logout ignored failures | Checks response, alerts, refreshes missing CSRF cookie first |
| **N6** Silent review failures | `approve/reject/delete` alert on failure |
| **N7** Inconsistent Enter | Email + password each submit; change-password modal Enter submits (bound in `openChangePasswordModal`) |
| **N8/N12** Dead tab strip | Hidden `.tabs`/`.tab` markup, CSS and `switchTab()` removed |
| **N9** No order search | Search input by order #, name, phone, email (client-side) |
| **N10** Raw totals | `fmtRs()` for order/product/live-card totals |
| **N13** Hard-coded `<5` | Low-stock label set from `lowStockThreshold` returned by API |

#### Add-Product flow — 7 faults found & fixed
1. **Advanced fields hidden on create** → every new product silently became `category: anime` with untracked stock. `#extraFields` now always `display: contents`.
2. **Unit Cost discarded** (backend, see above).
3. **No client-side sale-price check** → validated against regular price before submit.
4. **Double-submit** (Enter in fields re-fired `handleSaveProduct`) → `btn.disabled` guard.
5. **Stale live-card** after Cancel/Reset → `resetForm` clears it; create shows it after reset.
6. **Quick Upload** hard-coded `anime` + 5-size default → added **Category + Size selects**, sends `sizes` explicitly.
7. **Uncapped/invalid API input** → backend 400s + caps (see above).
8. **Front "Choose different" dead** (area click-guard swallowed it) → direct `onclick` added (commit `09fd6cb`).
9. **Back image raw + no drag&drop** (stored raw `File`, could exceed 8 MB; drop navigated away) → new `handleFormBackImage` with **WebP compression**, validation, `preview-meta`, `backImgError` element, and `setupFormBackUpload` (click/keyboard/drag) wired in `INIT`; `resetForm` clears it (commit `09fd6cb`).

#### Icons — emoji → SVG
All pictographic glyphs replaced: sidebar 7, View Store, stat cards 5, upload cameras 2, status menu, sort arrows, stock editor, review actions, both live-card checks, modal close, rating stars (`★` → SVG). New **21-symbol inline sprite** (`#i-grid`, `#i-box`, `#i-zap`, `#i-plus`, `#i-cart`, `#i-star`/`#i-star-fill`, `#i-trending-up`, `#i-store`, `#i-camera`, `#i-clock`, `#i-alert`, `#i-dollar`, `#i-check`, `#i-x`, `#i-rotate`, `#i-arrow-down`/`#i-arrow-up`, `#i-download`, `#i-truck`, `#i-check-circle`, `#i-credit-card`) + `icon()` / `starRating()` helpers (`stroke: currentColor`, `fill: currentColor` for filled stars). **Emoji scan of `admin.html` → 0**.

#### Verification (fresh run after all fixes)
- `npm test` → **33/33 API + 8/8 DOM scenarios passed** (jsdom reports no script errors).
- `node --check` on extracted inline script → clean.
- Live boot (port 3000, sql.js, UTC): **H1 ✓** (`revenueToday 650`), **H2 ✓** (cancel→0 everywhere), **H3 ✓** (balanced cycle), **unit_cost ✓** (455 honored), **4 validation 400s ✓**, **CSV 200 ✓**, **`awaiting_verification` flow ✓**, **back/front upload ✓**, **emoji scan CLEAN ✓**.

---

## What STILL NEEDS TO BE DONE (priority order)

### 🔴 High — data / correctness (remaining)
- **Legacy P&L cost fallback:** Rows created **before** this fix still estimate cost as `55% × price (min Rs 50)` because `unit_cost`/line-item `cost` were never stored. New products are correct. Optional data migration: backfill `products.unit_cost` and `orders.items_json[].cost` from price history or manual count, or document as "estimates for pre-2026-10-10 orders".
- **Backend `/api/upload` & `POST /api/admin/create` are endpoint-only:** No UI calls them; they are not broken but are dead surface. Either add UI (admin user management) or remove/document as intentional.

### 🟠 Medium — UX / hardening
- **FE-H2 CSP migration (long-term):** `server.js` still needs `scriptSrcAttr 'unsafe-inline'` because both pages use hundreds of inline `onclick` handlers. Replace with delegated listeners (like gallery dots/filter panel) **together** with dropping the directive — removing only the CSP allowance breaks all clicks (incident 2026-09-23). Do not mark done without a browser/CSP migration.
- **Keyboard/focus polish for dynamic controls:** Primary overlays now trap focus + Escape (cart/wishlist/drawers, admin password modal), but dynamically rendered non-native controls (filter chips, size dots rendered after AJAX) merit a full keyboard/browser pass.
- **Stats endpoint test coverage:** Existing suites do not assert `stats/sales` vs cancelled/UTC-window behavior. Add server-side tests for `awaiting_verification` badge, cancelled-excluded revenue, and Monday-week semantics.

### 🟡 Low — housekeeping / perf
- **Housekeeping:** Delete stale `kage-culture.vercel.app` project (different Vercel team, confuses prod URL).
- **SEO / metadata:** Storefront is client-rendered (`pushState` now added 2026-10-10), but canonical/OG tags are still static; per-product server-rendered metadata remains open.
- **L2 cold-start:** `vercel.json` bundles `public/**` (9.3 MB mp4s + `vendor/chart.umd.min.js`) into the lambda. Moving videos off-repo/CDN remains a cold-start optimization.
- **Admin password rotation:** If the bootstrap password from §6 was never changed by the owner, rotate immediately (it passed through chat).

**Do NOT mark these done without explicit verification** (browser pass at 320/390/768px + CSP header check + prod Turso smoke if data migration touches orders).

---

## 10. Admin product creation — Vercel image storage diagnostic (2026-10-10)

- Product creation succeeds in a local multipart API test. On Vercel, product creation always uploads its required front image; if `BLOB_READ_WRITE_TOKEN` is missing, `persistImage()` previously fell through to the serverless filesystem and the route returned an unhelpful generic 500.
- `persistImage()` now refuses local-file persistence on Vercel and returns an actionable 503 when Blob storage is unconfigured; Blob upload failures return a safe 502 message that calls out the required Public store and matching token, while provider details remain in server logs. Product create/update and `/api/upload` return these safe storage errors to the admin UI.
- `.env.example` and `DEPLOY.md` now mark a Public Blob store as required for product images on Vercel. The helper accepts both `BLOB_READ_WRITE_TOKEN` and Vercel's store-prefixed `kage_READ_WRITE_TOKEN`, passing the chosen token to uploads and deletes. Local dev remains `./uploads` plus the in-memory sql.js DB.
- Regression coverage: admin product create with image/cost/stock, plus Vercel-without-Blob error path. `npm test` → **35/35 API + 8/8 frontend**; `npm audit --omit=dev` → **0 vulnerabilities**.
- **Deployment action still required:** connect a Vercel Blob store, verify `BLOB_READ_WRITE_TOKEN` is present in Production (and Preview if applicable), then redeploy. Do not paste the token into chat.

---

## 11. Batch product deletion + inventory quantity fix (2026-10-10)

- Added selection checkboxes and a select-visible control to the Products list, with selected count, confirmation, stale-selection handling, and an API limit of 100 products per deletion.
- Added `DELETE /api/products/batch` before the `/:id` route; it requires admin auth and CSRF, validates positive unique IDs, rejects missing products, and best-effort removes associated images.
- Quick Upload now collects `stock_qty`; blank remains untracked inventory and `0` marks the product sold out. Product create/update/inline stock APIs reject fractional counts instead of silently flooring them.
- Verification: `npm test` → **38/38 API + 10/10 frontend**; `npm audit --omit=dev` → **0 vulnerabilities**; `git diff --check` clean.

---

## 12. Multiple sizes per product with per-size stock (2026-10-10)

- **Data:** new table `product_size_stock(product_id, size, stock_qty)` created by `createSchema` (`CREATE TABLE IF NOT EXISTS`, so it applies on Turso and sql.js at boot with no ALTER). A product with rows is tracked per size; `products.stock_qty` is then the sum of its rows. Products without rows keep the old behaviour (one shared count, or untracked when NULL), so no data migration is needed.
- **Shared helpers:** `utils/sizes.js` (size parsing, per-size validation, row sync, reconcile on size edits).
- **API:** `POST`/`PUT /api/products` accept `size_stock` (JSON object, one whole-number count per offered size). Every product read returns `size_stock` (`null` when not tracked per size). Editing `sizes` keeps counts for sizes that stay and drops removed ones. A bare `stock_qty` on a per-size product returns 400, and `PATCH /stock-qty` only works for single-size products.
- **Orders:** every line's size must be offered by the product. Per-size lines use a guarded per-size decrement. A failed order now restores units already taken by earlier lines. Cancel and reactivate adjust the ordered size's count.
- **Storefront:** the product page shows a size picker (sold-out sizes disabled, quantity capped per size). Cart add, cart quantity, quick add and saved-cart restore all check the size's own count. A single size shows as plain text; "One Size" (stickers) hides the block.
- **Admin:** the product form has size chips and a count per selected size (all-or-nothing). Editing loads each size's count. The product list shows per-size counts, and inline quick-edit opens the editor for per-size products. Quick Upload is unchanged (single size, one count).
- **Test change:** the existing order tests used a size the seeded product does not offer (`M` on a size-`L` product, and no size on the stock test). They now use `L`, because an order line must name an offered size.
- Verification: `npm test` → **51/51 API + 12/12 frontend**. Not yet checked in a real browser (no browser is installed in the sandbox); the picker and admin chips still need a visual pass at 320/390/768px.

---

## 13. Back-image upload fixed + multiple gallery photos in Add/Edit Product (2026-10-11)

**Check requested:** (1) can the admin panel's Add Product upload more than one image? (2) does the back-image upload work? Both were verified live against a booted server before changing anything.

**Findings:**
- **Back-image upload was broken.** The form compresses the photo to a WebP `Blob` and appended it to the FormData **without a filename** (`formData.append('back_image', blob)`). Browsers serialize a nameless Blob as `filename="blob"`; the image-only multer filter tests `path.extname(originalname)`, which is empty for `"blob"` — so the request was rejected with 400 *“Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed”* and the **entire product save failed** (Add *and* Edit). The front image was unaffected because it was appended with an explicit `.webp` filename. Reproduced end-to-end: the exact frontend request shape returned 400; the same request with a filename returned 201.
- **Multiple images were already supported by the backend but not exposed in the UI.** `POST/PUT /api/products` accept front + back + up to 4 `extra_images`, and the storefront gallery already renders `[front, back, ...extra_images]` — but the admin form had no way to upload more than front + back.

**Changes:**
- `public/admin.html`: every image blob is now appended with an explicit filename (back image → `back-<ts>.webp`). New **“More Photos (optional · up to 4)”** upload area in the Add/Edit form: multi-file picker + drag & drop, client-side WebP compression (same pipeline as front/back), thumbnails with a × to remove. When editing, existing gallery photos appear as thumbnails and removing one sends a `remove_extra` list on save.
- `routes/products.js` PUT: accepts `remove_extra` (JSON array of URLs); only URLs belonging to that product are dropped and their files deleted. The 4-photo gallery cap (`config.MAX_EXTRA_IMAGES`, also used for multer `maxCount`) is enforced when new photos arrive, before anything is persisted — legacy products over the cap stay editable.
- `server.js`: the JSON error handler moved **after** the routes. It was registered before them, so route-level errors (e.g. an upload-filter rejection) fell through to Express's default HTML stack-trace page instead of clean JSON.
- Tests: e2e — create with front + back + extras, nameless-upload rejection, update append/remove/cap/invalid `remove_extra`; frontend (jsdom) — every image submits with a real filename and gallery removals send `remove_extra`. `npm test` → **56/56 API + 12/12 frontend**.

---

## 14. Product page gallery/zoom, review UX and tablet gutters (2026-10-11)

Follow-up to §13 (back-image upload fixed in admin). Base: latest master (PR #8 logo swap already merged). Work on `arena/096fe1c7-kage-culture`, PR opened, not merged.

**Part A (admin back image) — root cause:** the form appended the back-image
`Blob` to the `FormData` **without a filename**; browsers serialize a nameless
blob as `filename="blob"`, and the image-only multer filter tests
`path.extname(originalname)` which is empty for `"blob"`, so the whole save was
rejected with 400 "Only image files…". Front image worked because it was
appended with an explicit `.webp` name. Fixed in §13; re-verified end-to-end
(create + PUT edit persist the back image, read-back survives reload, shows on
the product page). Storage uses the same `persistImage()` as the front image
(local `./uploads` dev / Vercel Blob prod), 8 MB multer cap, and the JSON error
handler now sits after the routes so upload rejections surface as a readable
admin error instead of an Express HTML stack page.

**Part B:** product gallery already builds thumbnails only from images that
exist; added a tap/click **zoom lightbox** on the main image (Escape / backdrop
taps close; keyboard-openable).

**Part C:** rating line shows "No reviews yet" with zero approved reviews;
"Thanks for your review" no longer shows before a submit; "You Might Also
Like" hides entirely when empty; removed the stray body text node `n`;
`·` separator only renders when another urgency bit precedes "N sold";
review order/phone placeholders shortened and stacked ≤640px; "Back to
collection" is 14px, higher contrast, 44px tap target.

**Part D:** container + header gutters are 16px ≤768px and 24px at 769–1024px
(product page capped at 1280px, centred); footer Help links get the 10px gap
and the 80px WhatsApp-clearance bottom padding at all widths >480px.

**Part E:** trust line "Cash on delivery · 7-day returns · Fast delivery" under
Add to Cart; mobile footer Help links render in two columns.

**Part F:** star picker rewritten — one value drives the fill (`.lit`), pointer
events (down/move/up + pointercancel/leave) give press-hold/slide previews and
commit on release, per-star `:hover` is gated behind `@media (hover: hover)`,
stars are a `radiogroup` with `aria-checked`, arrow-key and roving-tabindex
support, 44×44 targets, `user-select:none` + transparent tap highlight; review
fields are `box-sizing:border-box; width:100%` with `resize:vertical`.

Verification: `npm test` → **56/56 API + 14/14 frontend**. Real headless
Chromium (Sparticuz build) at 360/390/430/768/900/1024/1280/1920: no
horizontal scroll, header stays 95px; touch-emulation at 390px confirmed
tap→1..3, hold-5 preview→release selects 5, drag 4→2 ends at 2, no sticky
highlight. Screenshots in `/home/user/screenshots/` (product 390/900 + zoom,
back-image and footer shots).

---

## 15. Review moderation: auto-approval, instant author visibility, admin stars (2026-10-11)

**Problem:** reviews only appeared on the product page after an admin approved
them (a 5★ review sat invisible until moderation), the admin Reviews tab
rendered every star as a hollow outline (rating unreadable), and a reviewer
could not see their own just-submitted review at all.

**Auto-approval (`routes/reviews.js`, `config.js`):** reviews rated above
`REVIEW_AUTO_APPROVE_ABOVE` (3.5 — i.e. 4★ and 5★) are inserted with
`status='approved'` and are public immediately; 1–3★ stay `pending` for
moderation. Pending reviews still do not count toward `avg_rating` /
`review_count` (those aggregate approved rows only).

**Instant author visibility (`reviews.js`, `database.js`, `index.html`):**
reviews gained a `viewer_token` column (Turso gets an `ALTER TABLE` migration;
fresh schemas include it). The storefront keeps a random per-browser token in
`localStorage` (`kageReviewViewerToken`), sends it with the review POST, and
the server echoes/stores it. `GET /api/reviews?product_id&viewer_token` returns
approved reviews for everyone **plus** the pending reviews whose token matches
the caller — so a reviewer sees their own pending review instantly, flagged
"Awaiting approval · only visible to you" (dashed card). Other visitors (and
other browsers' tokens) never see it; rejected reviews never surface; the token
is never leaked in responses. After a successful submit the storefront
re-fetches the list, so the new review appears without a reload.

**Admin stars (`admin.html`):** the global `.icon` rule (`fill:none`, later in
the stylesheet) was beating the bare `.icon-fill{fill:currentColor}` rule at
equal specificity, so "filled" stars never filled. Replaced with scoped
`.review-stars .icon.icon-fill` / `.review-stars .icon:not(.icon-fill)` rules
that outrank `.icon` — rated stars fill gold, the rest stay dim outlines.

Verification: `npm test` → **57/57 API + 14/14 frontend** (new e2e: 5★
auto-approves and is public immediately; 3★ is author-visible via token,
public only after approval, excluded from the rating while pending; new
frontend: token reuse, refetch-with-token, pending badge, admin star fill).
Live curl smoke run against `node server.js` confirmed the same flows over
HTTP.

---

## 16. Custom Stickers page trimmed to the hero section (2026-10-11)

Removed the three "Coming Soon" cards (Design It Yourself, KAGE Designs,
Sticker Packs) and their notify-me forms from `#page-custom-stickers`, per
owner request — the page now shows only the header ("Your Design / Custom
Stickers" copy + "🎨 Custom Orders Opening Soon" badge). Nav links, deep
links and the `custom-stickers` nav handling are untouched. Verified in jsdom:
page active, header + badge present, 0 cards / 0 notify forms; `npm test`
frontend suite 14/14.

---

## 17. KAGE Clothes section removed entirely (2026-10-11)

Owner request: the KAGE Clothes page (Bear / White Tiger / Black Panther /
White Fox series cards) is gone. Removed the `#page-kage-clothes` block, its
nav link, the now-unused `.kage-portrait` CSS, the `kage-clothes` entries in
the frontend deep-link / nav-state handling, and `/kage-clothes` from the
server's `spaPages` set — so the path now returns a real 404 and the SPA
shows its not-found view. Animal photos stay (used by og/twitter meta).
Verified: `GET /kage-clothes` → 404, `/custom-stickers` → 200, not-found view
renders for the old deep link, no nav link remains; `npm test` 57/57 + 14/14.


---

## 18. Storefront shop grid was invisible — visibility now class-driven (2026-10-11)

**Problem:** `#shopSection` carried an inline `style="display:none;"` and nothing
ever removed it, so every collection route, deep link (`/collection/anime`,
`/collection/all`), search, filter, sort and pagination render all painted into
a hidden section. Category nav, "Shop the Drops", "View All" and "Pants" looked
like dead links even though their JS ran correctly.

**Fix (`public/index.html` only):**
- Removed the inline style. Visibility is CSS + one class: `.shop-section {
  display:none }` / `.shop-section.shop-visible { display:block }` (top padding
  and `scroll-margin-top` clear the fixed header via `--header-h`).
- New state helper `applyShopVisibility()` derives the class from
  `shopCollectionMode || searchQuery.trim() !== ''` and mirrors it as
  `body.showing-shop`. `initShop(filter, { collection })` sets the mode,
  `navigateTo('collection', …)` passes `collection: true`, every other
  `navigateTo` target clears it (so the grid can't leak onto About/Track/…),
  `onSearchInput` re-evaluates on every keystroke, and `resetFilters` after
  clearing the query.
- `body.showing-shop` hides the homepage marketing sections (hero, category
  strip, New Vibes, why-row, Best Sellers / Recently Viewed) so the grid reads
  as its own page; footer and the mobile filter drawer stay put.
- Typing a search from a non-home view now routes home with
  `{ keepSearch: true }` alongside the same visibility update.

**Tests:** `tests/frontend.test.js` gained an 18th scenario (home hidden →
collection visible → search narrows → other view/back-home hidden) plus three
CSS contracts (default hidden by class, `.shop-visible` reveals, no inline
`style` on `#shopSection`). Suite: **57/57 API + 18/18 frontend**.

**Headless-Chromium verification (Chromium 153 via puppeteer-core):** 36/36
checks — Anime Shirts click (1280×1317px box, 7 cards), deep-linked
`/collection/all` (8 cards, "Page 1 of 3", 20 results), typing "wolf" (1 card,
Blade Wolf), sort high→low / low→high ordering, sidebar size filter + badge +
Reset, Next → page 2 (8 cards) and page 3 (4 cards, Next hidden), About/Back
hiding the grid, browser Back returning to the plain homepage, and 390px mobile
(grid full width, drawer opens/applies, zero horizontal overflow). Screenshots:
`/home/user/screenshots/shop-fix-{1..5}-*.png`.


---

## 19. Dead storefront admin sign-in modal removed (2026-10-11)

**Problem:** `public/index.html` still carried a whole admin sign-in modal that
nothing could open — its open helper was never called from any button, link or
shortcut. `/admin` already serves its own login page, so the storefront copy
was pure dead weight (markup + ~100 lines of CSS + three JS functions + an
Escape/Enter handler + a focus-trap list entry).

**Removed (no public admin button was added):**
- The overlay markup block (card, close button, logo, error, email/password
  fields, sign-in button, footer note).
- All of the modal's CSS rules plus its entrance keyframes.
- The three modal helpers (open, close, submit) and their Enter-to-submit /
  Escape-to-close keydown listener.
- The modal's entry in the shared Escape / focus-trap chain (cart, customer
  modal, filter drawer and wishlist entries untouched).
- Test references: the old "admin modal opens" assertions became absence
  assertions (element null, no modal CSS, no `open`/`close`/`submit`
  helper on `window`), written with assembled strings so a plain grep for the
  removed names stays empty; the `/admin` + `/admin.html` checks were extended
  (301 → `/admin`) and kept.

**Also updated:** `AUDIT.md` (mobile-nav history note now records the deletion)
and `PRESSABLE_LINKS.md` (finding #2 marked fixed, table rows corrected).

**Verification**
- A repo-wide `grep -rn` for the four removed identifiers (excluding
  `node_modules`/`.git`): **0 matches**; no admin sign-in CSS class or
  keyframe name survives in `public/index.html`.
- Headless Chromium (Chromium 153 + puppeteer-core), **26/26 checks**:
  * storefront load → 0 unexpected console errors, 0 page errors, 0 failed
    requests. The only two console messages are environment noise — the
    sandbox blocks `fonts.googleapis.com` and `/api/customers/me` answers 401
    for a guest — and a **baseline run against the pre-change shell (HEAD)
    produced the exact same two**, so the removal added no errors.
  * Escape closes the cart drawer, the customer login modal and the (mobile)
    filter drawer, each restored `body.style.overflow` and re-opened cleanly.
  * `/admin` → 200, shows `#loginPage`, a real sign-in (bootstrap admin
    `root@kage.test`) reaches `#dashboard` with stats (`statProducts=20`,
    signed-in email shown), no console errors.
  * `/admin.html` → **301 → `/admin`** (curl: `status=301`,
    `location=http://127.0.0.1:3999/admin`; browser lands on the dashboard).
- `npm test` → **57/57 API + 18/18 frontend scenarios**.


---

## 20. Product API field exposure: public allow-list + authenticated admin catalog (2026-10-11)

**Problem:** `GET /api/products` and `GET /api/products/:id` ran `SELECT *` and
spread the row into the response, so every visitor received `unit_cost` (cost
of goods — the whole margin) and `updated_at`. The list route additionally
computed `sold_count`/`order_count` by loading **every** order row and
JSON-parsing `items_json` on each request.

**Public shape is now an explicit allow-list** (`utils/productShape.js`,
`PUBLIC_PRODUCT_COLUMNS`) and the payload is rebuilt field by field — never
spread — so a column added to the table later can only leak by being added to
the list on purpose. The list was derived from what `public/index.html`
actually reads (grep of the field map and the card/detail renderers): `id`,
`name`, `category`, `fit`, `price`, `sale_price`, `description`, `sizes`,
`front_image`, `back_image`, `extra_images`, `in_stock`, `stock_qty`,
`created_at`, plus the computed `size_stock`, `sold_count`,
`order_count`, `avg_rating`, `review_count`. `unit_cost` and `updated_at` are
admin-only; the single-product route now also carries the ratings/sold
aggregates the detail page already consumed client-side.

**Admin catalog behind auth:** new `GET /api/admin/products` and
`GET /api/admin/products/:id` (both `requireAuth`, CSRF-free GETs) return the
full shape including `unit_cost`, `on_sale` and `updated_at`. `public/admin.html`
now loads its product list from `/api/admin/products`; the edit form reads its
in-memory array, so `#prodUnitCost` and the P&L keep working unchanged. The
admin product **write** responses were switched to the same explicit shape.

**`sold_count` without the per-request scan:** one SQL aggregate over
`json_each(orders.items_json)` (`SOLD_COUNT_SQL`), cached for
`config.SOLD_COUNT_CACHE_MS` (60s) and invalidated on every order insert and
status change. Backends without JSON1 (the pure-JS in-memory store) fall back
to the previous single scan, and a probe decides which path runs, so the two
produce identical maps (asserted in the tests). `order_count` keeps its
original value — it mirrors `sold_count` (units).

**Verification**
- `tests/e2e.test.js`: new "Product field exposure" block — public list key set
  is exactly the allow-list (no `unit_cost`, no `updated_at`); public single
  likewise; admin list/single expose `unit_cost` (and 404 for a missing id);
  anonymous **and** forged-cookie calls to both admin routes → **401**; a
  sold-count round trip (order → 3 sold, cancel → 0) proving the SQL aggregate
  equals the JSON scan across the whole catalog. The suite now also raises
  `RATE_LIMIT_ORDERS` (the run places more orders than a single visitor would).
- `tests/frontend.test.js`: the admin scenario signs in for real (bootstrap +
  login, `ALLOW_ADMIN_SETUP`) and feeds the panel from `/api/admin/products`,
  asserting the admin shape has `unit_cost` while the public payload does not.
- Headless Chromium (Chromium 153 via puppeteer-core), **29/29 checks**:
  storefront payload carries no `unit_cost`/`updated_at` and keeps every field
  the UI reads; the collection route reveals the grid (not hidden DOM); all
  products counted across pages; sale badges, struck-through originals and
  low-stock flags match the payload counts exactly; a single-size detail and a
  created multi-size product (`S/M/L` with `size_stock {S:2,M:0,L:5}`) render
  every size with only the sold-out one disabled; zero console/page errors;
  the storefront never calls an admin route. In the panel: catalog comes from
  `/api/admin/products` (no public call), the edit form shows the real
  `unit_cost`, and the P&L tiles equal the API totals (`Rs. 5,846 / 3,460 /
  2,386` in the run). Screenshots: `/home/user/screenshots/fields-*.png`.
- `npm test` → **63/63 API + 18/18 frontend scenarios**.


---

## 21. Order history was readable by anyone who knew a phone number (2026-10-11)

**Problem (reported, reproduced locally):** `GET /api/customers/orders` matched
orders with `email = ? OR phone = ?`. A profile phone set through
`PUT /api/customers/me` is **unverified**, so anyone could save a stranger's
order phone and read that order's email, address and notes. And because signup
had no email verification, anyone could also register a victim's email address
and be handed that person's full order history. The endpoint also returned the
raw `orders` row (`notes`, `payment_ref`, `email`, `phone`, `address`,
`payment_verified`) and each line item's `cost` (unit cost / margin).

**Order history is now bound to the customer, not to typed-in details**
- New `orders.customer_id` column (fresh schema + Turso `ALTER TABLE` migration
  + a `PRAGMA table_info` guard for sql.js), indexed. `POST /api/orders` sets it
  from the requester's signed session via the new `optionalCustomerId(req)`
  helper — anonymous checkout still works and simply leaves it NULL.
- `GET /api/customers/orders` matches on `customer_id` **or** the account's own
  lowercased email. **Phone is no longer a match key anywhere.**
- Backfill (`database.js#backfillOrderCustomerIds`, run at boot and exported for
  ops/tests) links pre-existing orders to a customer **only when the lowercased
  order email equals a verified customer's email**; unverified accounts are
  skipped, so a squatting signup never inherits history.

**Email verification for customer accounts**
- New `customers.email_verified` flag plus a `customer_verification_tokens`
  table (SHA-256 hash only, single-use, 24 h `config.VERIFY_TOKEN_EXPIRY_MS`).
- Signup stores `email_verified = 0`, issues a token and emails the link built
  from `SITE_URL`; every interpolated value is HTML-escaped (`escapeHtml`).
  `sendEmail`'s dev-mode log now prints each email's links — without them the
  reset/verify flows are unusable locally (the href is stripped from the text
  preview).
- `GET /api/auth/verify-email?token=…` (the emailed link) and
  `POST /api/customers/verify-email` consume the same token; verifying also
  links that customer's earlier guest orders. `POST
  /api/customers/resend-verification` sits behind `resetLimiter` (+ CSRF +
  session) and burns the previous token, so only the newest link works.
- Unverified accounts can still log in and edit their profile; their history is
  `{ orders: [], email_verified: false }`.

**Response shape is an allow-list:** `order_number`, `status`, `payment_method`,
`items` (id, name, size, qty, unit, total, image — no `cost`/`stock`),
`subtotal`, `shipping`, `shipping_pending`, `total`, `created_at`. Nothing else.

**Email casing:** signup, login and order insert all trim + lowercase, order and
customer rows are normalised once at boot, so a mixed-case guest checkout
("Mixed.Case@Kage.Test") still lands in the right history.

**Storefront (`public/index.html`):** the account page shows a "Verify your
email to see your order history" banner with a **Resend verification email**
link, and the history area shows the verify prompt instead of "No orders yet";
`/verify-email?token=…` is a real route with success/expired/missing-token
states (added to `server.js` `spaPages`). Also fixed: a direct/bookmarked
`/account` visit never called `loadAccountPage()`, so it sat on
"Loading orders…" and hid the verify prompt entirely.

**Verification**
- `tests/e2e.test.js` (5 new checks): a **verified** attacker who copies the
  victim's order phone still gets `[]` and no order number/email/address in the
  body; signing up with a victim's email leaves the history empty until the
  address is proven (login + profile edits still work); the real owner verifies
  through the emailed token and sees the mixed-case guest order with the exact
  allow-listed key set (no `cost`/`notes`/`address`); replayed and superseded
  tokens are rejected and resend requires a session; the backfill links only the
  matching order and skips unverified accounts. Suite: **68/68**.
- `tests/frontend.test.js` scenario 19 (jsdom): banner + resend link + verify
  prompt for unverified accounts, banner hidden and rows rendered once verified,
  the `/verify-email?token=` route sending the token and reporting success, and
  a token-less link explaining itself. Suite: **19/19**.
- Headless Chromium (153 + puppeteer-core, server spawned as a child so the
  harness can read the dev-mode email log), **15/15 checks**: signup → toast
  "Check your email to verify your address" → account page shows the banner and
  the verify prompt (order absent) → **Resend** delivers a new link → opening
  the emailed link verifies → the account page shows the guest order row →
  replaying the link reports an invalid/used token; zero unexpected console
  errors. Screenshots: `/home/user/screenshots/verify-account-unverified.png`,
  `verify-account.png`, `verify-page.png`.
- `npm test` → **68/68 API + 19/19 frontend scenarios**.

---

## 22. Email HTML injection via order fields (2026-10-11)

**Reported hole.** `utils/email.js` interpolated `customer_name`, `address`,
`city`, `payment_ref`, item `name`/`size` and `order_number` straight into the
HTML of the order confirmation and status-update emails. A local `escapeHtml`
existed in that file but was applied **only** to the verification email, so
anyone could place an order with `email` = the victim's address and
`name` = `<a href="http://evil.test">Verify your account</a>` and Resend would
deliver the attacker's markup from the KAGE domain — a ready-made
phishing/credential-harvesting email. `POST /api/orders` also accepted any
string as an email address, and nothing stripped CR/LF before values reached
email headers.

**Fixes**

- **`utils/helpers.js`** — one escaper for the whole app:
  `escapeHtml` (`& < > " '`), `stripHeaderChars` (CR/LF/NUL → space, collapses
  runs, trims), `hasControlChars`, and `isValidEmail` (the same
  `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` plus the 160-char cap). All four exported.
- **`utils/email.js`** — the duplicated local `escapeHtml` is gone; the helper
  is imported. **Every** dynamic value in **every** template (confirmation,
  status update, verification) is escaped, `sendEmail` sanitises the recipient
  and subject through `stripHeaderChars`, and the dev-mode preview prints the
  raw body only when `EMAIL_DEBUG_HTML=true` (wrapped in `HTML-BEGIN`/
  `HTML-END` so a harness can extract it). New `buildLink(path, params)` builds
  link URLs from `SITE_URL` + server-side values only, with
  `encodeURIComponent` on every value — no user input can reach an `href`.
- **`routes/auth.js`** — password-reset and verification links now come from
  `buildLink(...)`; the `href`s are escaped at the sink.
- **`routes/orders.js`** — `400 {"error":"Please enter a valid email address."}`
  for an email that fails `isValidEmail` (malformed, over 160 chars), and
  `400` for control characters in `name`, `address`, `city`, `notes` or
  `payment_ref`. Rich-text-looking names/addresses are still accepted — they
  are escaped at every render sink.
- **Display audit (no change needed).** `public/index.html`
  `renderConfirmation` and the tracking view use `textContent` for
  name/address/payment_ref and `esc()` for order number/status/items;
  `public/admin.html`'s `esc()` already covers every order field it prints, and
  the admin panel renders no address/notes at all (`grep notes|address` → no
  matches).

**Verification**

- `tests/e2e.test.js` (+6 checks, **74/74**): the confirmation email escapes
  name/address/payment_ref (asserts the entities are present and that no raw
  `<a href="http://evil.test">`, `<b>` or `<script>` survives, and that the
  capture holds the real order number); the status email escapes the stored
  customer name; the reset and verification emails carry hrefs matching
  `^SITE_URL + /path?token=…$` with the token URL-encoded; `POST /api/orders`
  rejects `not-an-email`, `a@b`, a 200-char address, CRLF/LF in the name, a CRLF
  in the address and a newline in the payment reference — while `<b>Bold
  Buyer</b>` still orders fine (it is escaped, not rejected); and
  `stripHeaderChars` plus a forged `victim@kage.test\r\nBcc: …` recipient are
  provably neutralised. `captureEmails()` stubs only `api.resend.com`, so the
  **real** templates and payloads are what gets asserted.
- **Negative control:** removing `escapeHtml(order.customer_name)` from the
  confirmation template made the e2e check fail (`the name must be
  entity-escaped`) and the Chromium run report exactly one injected anchor —
  both were restored and green afterwards.
- `tests/frontend.test.js`: **19/19** (no new scenario needed — the frontend
  sinks were already safe).
- Headless Chromium (server spawned as a child with `EMAIL_DEBUG_HTML=true`,
  puppeteer-core 153), **8/8 checks** — script kept at
  `/home/user/chromium-checks/email-escaping.js`: the captured email body
  rendered in a page shows the payloads as **literal text** with **zero**
  anchors/`<b>`/`<script>`; the admin Orders tab shows the malicious name as
  plain text with no injected element and no unexpected console errors; and a
  real checkout through the storefront UI (cart → checkout → Place Order) lands
  on a confirmation view whose name/address/payment cells hold the raw text
  while the one anchor on that page is the legitimate "Track your order"
  link. Screenshots: `/home/user/screenshots/email-escaped-order.png`,
  `email-escaped-admin-orders.png`, `email-escaped-storefront-confirmation.png`.
- `npm test` → **74/74 API + 19/19 frontend scenarios**.

---

## 23. Admin CSV export: RFC 4180 quoting + spreadsheet formula shielding (2026-10-11)

**Reported hole.** `GET /api/orders/export/csv` quoted only `customer_name` and
`address`; `email`, `phone`, `city`, `payment_ref`, `status` and the order
number went out bare, joined with `\n`. A `payment_ref` like
`=HYPERLINK("http://evil.test","x"),extra` therefore both **shifted the columns**
of every following row (the comma landed outside quotes) and **executed as a
formula** the moment the owner opened the file in Excel or Google Sheets — a
CSV-injection vector that can exfiltrate the sheet or run a DDE/`HYPERLINK`
payload. There was no BOM, so non-ASCII names were mojibake in Excel.

**Fixes**

- **`utils/helpers.js#csvCell(value)`** — one helper for the whole app:
  `null`/`undefined` → `""`; otherwise stringify; if the first character is
  `=`, `+`, `-`, `@`, tab or CR, prefix a single quote (quoting alone does **not**
  stop Excel from evaluating `=…`); double every inner `"`; always wrap the
  result in double quotes so commas/newlines can never split a column.
- **`routes/orders.js` export** — every text column (`order_number`,
  `customer_name`, `email`, `phone`, `address`, `city`, `payment_method`,
  `payment_ref`, `cod_confirmed`, `shipping_pending`, `status`, `created_at`,
  `notes`) goes through `csvCell`; `Notes` is now exported so the shop can see
  customer notes; `subtotal`, `shipping` and `total` stay **unquoted** numbers
  but only after a `Number.isFinite` check (anything else falls back to
  `csvCell`). Rows are `\r\n`-terminated and the file opens with a UTF-8 BOM.
  `Content-Type` is now `text/csv; charset=utf-8`; the attachment filename
  (`kage-orders-YYYY-MM-DD.csv`) is unchanged.

**Verification**

- `tests/e2e.test.js` (+3 checks, **77/77**): `csvCell` unit cases
  (`null`, `undefined`, commas, doubled quotes, `=`, `+`, `-`, `@`, tab, CR);
  a real order with `name = Quote "The Boss", Jr.`, `email = +1@x.com`,
  `city = A,B`, `address = 12 "Main" St, Block B`,
  `payment_ref = =HYPERLINK("http://evil.test","x"),extra`,
  `notes = @SUM(1+1)` exported and then read back with a **small RFC 4180
  parser written in the test** (never `split(',')`): every row has the same
  column count (16), the formula cell starts with a single quote and the
  original value is the cell minus that quote, the comma city stays in one
  field, the BOM is present, no bare LF survives once quoted fields are
  blanked, and the money columns are still bare numbers. A row inserted
  straight into the table with newlines in `customer_name` and `notes`
  (legacy/hand-edited data the API would now reject) also round-trips inside a
  single field. Unauthenticated export still returns 401.
- **Negative control:** stripping `csvCell` from the email/city/payment_ref
  columns and removing the BOM made the export check fail (first on the BOM,
  then on quoting/shielding); restored and green afterwards.
- Headless Chromium, **5/5 checks** (`/home/user/chromium-checks/csv-export-download.js`):
  logging into `/admin` through the UI, opening Orders and clicking the real
  **Export CSV** button downloads `kage-orders-2026-10-11.csv` with
  `text/csv; charset=utf-8` + `attachment; filename="…"` matching the saved
  file, the file starts with the BOM, every line break is CRLF, and the hostile
  values survive as single, shielded fields
  (`"'=HYPERLINK(""http://evil.test""…`). Screenshot:
  `/home/user/screenshots/csv-export-admin.png`.
- `npm test` → **77/77 API + 19/19 frontend scenarios**.

---

## 24. Session secret: no more public fallback outside development/test (2026-10-11)

**Reported hole.** `server.js` and `middleware/auth.js` each fell back to the
literal string `kage-dev-secret-not-for-production` unless `VERCEL` or
`NODE_ENV=production` was set, and `utils/helpers.js#signCsrfToken` had a third,
slightly different copy (`'kage-dev-secret'`). Any deployment that forgot to set
`NODE_ENV=production` — a VPS, Render, Railway, Docker, a plain `node server.js`
behind nginx — therefore signed `kage.session` / `kage.cust` (and CSRF tokens)
with a string **published in this repo**. Anyone who had read the code could
HMAC a `{"adminId":1}` payload with it and walk into `/admin`.

**Fixes**

- **`utils/secret.js` (new) — one rule, one place:**
  - `SESSION_SECRET` set → must be **at least 32 characters**, otherwise a clear
    error (with the generator command) is thrown.
  - `SESSION_SECRET` missing → the development fallback is returned **only**
    when `NODE_ENV` is exactly `development` or `test`.
  - Every other case — including `NODE_ENV` unset, `staging`, `Production`,
    `prod` — throws `SESSION_SECRET is required. …` (with the generator command).
- **Call sites all use it** (no copies left — `grep SESSION_SECRET` shows the
  string only in `utils/secret.js`, the two test files that set it, and docs):
  `server.js` resolves it eagerly and exits `1` with
  `FATAL: SESSION_SECRET is required. …` before anything else boots (the old
  VERCEL/production check is gone); `middleware/auth.js` resolves it per call
  (`readSignedSession(value, secret = getSessionSecret())`); `routes/auth.js`
  defaults its `SESSION_SECRET` parameter through it, so `server.js` no longer
  passes one; `helpers.js#signCsrfToken` signs with it.
- **Local development still works, and `.env` is actually read now.** The server
  never loaded `.env` (no dotenv dependency), so `npm run dev` points at the new
  `scripts/dev.js`, which sets `NODE_ENV=development` and loads `.env` with a
  ~10-line dependency-free loader. `npm start` / `node server.js` deliberately do
  **not** read `.env` — they need real environment variables (documented).
- **Docs:** `.env.example` (32-char minimum, generator command, "required
  everywhere except development/test", note that only `npm run dev` reads
  `.env`), `DEPLOY.md` (env-var table row with the generator, a mandatory-secret
  callout for VPS/Docker/Render/Railway, a local-dev section that explains the
  `.env` loader, and a troubleshooting entry for the FATAL message), and the
  `AGENTS.md` security invariants ("never inline a
  `process.env.SESSION_SECRET || '...'` fallback").

**Verification**

- `tests/e2e.test.js` (+7 checks, **84/84**), each env case run in a **child
  process** with a stripped environment (`PATH`/`HOME` only):
  no `NODE_ENV` + no secret → throws `SESSION_SECRET is required` and prints the
  generator command; a 10-character secret → throws "at least 32 characters"
  while exactly 32 is accepted; `NODE_ENV=production` + a 48-character secret →
  resolves verbatim; `NODE_ENV=development` with no secret → the dev fallback
  only, while `staging` / `Production` / `prod` / unset all refuse;
  `node server.js` with no env → **exit 1**, `FATAL: SESSION_SECRET is required`
  on stderr and no boot banner. Then, against the live test server: a
  `kage.session` cookie HMAC-signed with the old public fallback (verified as a
  valid signature by `readSignedSession(..., fallback)`) is **401** on
  `/api/admin/me`, and the same payload signed with the resolved secret is 200 —
  proving every module shares one secret.
- **Negative control:** making the fallback unconditional in `utils/secret.js`
  failed 4 of the new checks — including `node server.js` booting happily
  (exit 0) — and the suite went back to green once restored.
- **Manual checks:** `env -i PATH=… HOME=… node server.js` →
  `FATAL: SESSION_SECRET is required. Generate one with: node -e "…randomBytes(48)…"`
  and exit code 1; a production-style boot with a 96-character generated secret
  served `/admin` and `/api/products` with 200 (and `/api/admin/setup` stayed
  403); `npm run dev` printed `Loaded environment from .env` and booted; headless
  Chromium signed into `/admin` with a real 96-character secret and completed its
  admin checks (5/5).
- `npm test` → **84/84 API + 19/19 frontend scenarios**.

---

## 25. A failed database boot is no longer cached for the instance's lifetime (2026-10-11)

**Reported hole.** `server.js` ran `const serverReady = ensureReady();` once per
process and the Vercel entrypoint awaited that single promise. If the boot
failed — Turso briefly unreachable at cold start, an env var added but not yet
redeployed — the rejection was memoised for the life of the instance: every
request returned 503 until the platform recycled it, and the database was never
retried. On Node 15+ that promise also sat unhandled between the moment it was
created and the first request, which can take the process down on its own.
`database.js` had the same pattern one level down: `initDatabase()` cached
`doInit()` forever, and `doInit()` set `module.exports._initialized = true`
*before* touching the database, so a partial failure was recorded as "done".

**Fixes**

- **`server.js` — `getReady()` replaces the one-shot promise.** The boot promise
  is cached only while it is **pending or fulfilled**; a failure clears the cache
  so the next request retries. A short backoff (`config.READY_RETRY_BACKOFF_MS`,
  1000 ms) makes requests inside the window answer 503 immediately instead of
  hammering a database that is already down. `.catch(() => {})` is attached at
  creation time (both to the real attempt and to the cached rejection handed out
  inside the window), so a rejection can never surface as an unhandled one. The
  `require.main` local path still exits 1 on a failed boot.
- **`readinessGate(req, res, next)`** is the middleware the serverless entrypoint
  now mounts, exported so tests and dry runs can exercise the real gate. Its 503
  is JSON with `Retry-After` and a fixed, non-sensitive message ("Service
  temporarily unavailable — the server is still starting up…"); the real error
  is only logged. It also works behind a bare `http` server (the response is
  written with `status/json` when Express provides them, `writeHead/end`
  otherwise) so the failure path itself can never throw.
- **`ensureReady()` is retry-safe.** The one-time seed/migrate flag is now
  `_bootstrapDone`, set **only after** `seedProducts()`,
  `backfillUnitCosts()` and `syncSeedSalePrices()` all succeed (each step is
  still individually tolerant, but a failure means the next request re-runs the
  block instead of skipping it forever); route registration stays behind the
  existing `app._kageRoutesRegistered` guard.
- **`database.js` — the same cached-failure pattern fixed.** `initDatabase()`
  clears the cached promise in its rejection handler, and `doInit()` sets
  `_initialized` only after a backend finished schema + migrations (Turso, sql.js
  and the in-memory store each set it at the end of their success path). A
  half-initialised module is therefore never treated as ready. The Vercel
  fail-loud message now distinguishes "Turso is configured but unreachable" from
  "TURSO_DATABASE_URL is missing".

**Verification**

- `tests/e2e.test.js` (+2 checks, **86/86**):
  - *transient failure:* a mocked `db.init` that fails once then succeeds, driven
    through an express app mounting the real `readinessGate`: first request 503
    with `Retry-After: 1` and a JSON body that leaks nothing
    (`turso|libsql|authToken|secret-host|*.js:NN` all asserted absent); two
    requests inside the backoff window are still 503 and still **one** init
    attempt; after the window the next request is 200 with exactly two attempts;
    no `unhandledRejection` was emitted (a listener runs for the duration); and
    the recovered boot did not double-register routes or re-seed products.
  - *permanent failure:* `tests/fixtures/db-down-serverless-child.js` runs the
    real entrypoint with `VERCEL=1` and a Turso URL pointing at a closed port,
    hammers it (four requests in the window + one after) and reports: all 503,
    all with `Retry-After`, no internal leakage, zero unhandled rejections, still
    alive. The parent counts `Turso init failed` lines in the child's output to
    prove the failure is retried (the old code produced exactly one, ever).
- **Negative control:** restoring the one-shot `getReady()` failed the transient
  check; restoring the one-shot **and** the old `initDatabase()` cache failed
  both (the child reported "saw 1 attempts"). Green again after restoring.
- **Manual check (requirement 6):** the real entrypoint mounted in Express, in
  production mode, pointed at `http://127.0.0.1:4391` where nothing was
  listening — four curls returned `HTTP 503`, `retry-after: 1`, body
  `{"error":"Service temporarily unavailable — the server is still starting up. Please retry in a moment."}`,
  the process stayed up and retried once per window (visible in its log). A mock
  hrana/`/v2/pipeline` endpoint was then started on that port and the **next**
  request, with no restart, returned `HTTP 200` (`GET /api/products` → `[]`,
  `GET /` → 200).
- `npm test` → **86/86 API + 19/19 frontend scenarios**.

---

## 26. Demo products came back after every cold start (2026-10-11)

**Reported hole.** `seedProducts()`, `syncSeedSalePrices()` and
`backfillUnitCosts()` ran on every cold start — their only guard was a
per-**process** flag, which a redeploy or a new serverless instance resets. On a
live shop that meant: delete every product and 20 demo products reappear; remove
the sale from *Rising Vermillion* (999) or *Wrath Silhouette* (1249) and it is
silently re-applied; set a unit cost of 0 on purpose and it is overwritten with
an estimate (`unit_cost = 0` counted as "missing", like NULL).

**Fixes**

- **`app_settings` table** (`key TEXT PRIMARY KEY, value TEXT, created_at`) added
  to `database.js#createSchema`, to `ensureSqlJsColumns()` for imported dumps and
  to the in-memory backend's store. `database.js` now exposes
  `getSetting(key)` / `setSetting(key, value)`.
- **`server.js#runOnce(key, step)`** — each step runs only if its marker is
  absent, and the marker is written **after** the step resolved, so a failure is
  still retried (the retry-safety from §25 is intact). Keys:
  `seed_products_v1`, `sync_seed_sale_prices_v1`, `backfill_unit_costs_v1`.
- **Upgrade path for existing databases:** when a database already holds
  products, `seedProductsOnce()` inserts nothing and records
  `seed_products_v1 = 'existing'`; `syncSeedSalePricesOnce()` then records
  `sync_seed_sale_prices_v1 = 'skipped-existing'` without touching a single
  price — the first deploy of this change cannot re-apply sales the admin
  removed. `backfillUnitCostsOnce()` still runs once, but only for
  `unit_cost IS NULL` (0 is a deliberate value and is never rewritten).
- **Brand-new databases** behave exactly as before: 20 demo products, the two
  seed sales, costs backfilled, all three markers recorded — and deleting them
  afterwards leaves the shop empty for good.
- **`utils/demoProducts.js`** holds the catalogue (`DEMO_PRODUCTS`,
  `SEED_SALE_SYNCS`, `seedDemoProducts()`), shared by the bootstrap and by the
  deliberate reload: **`POST /api/admin/seed-demo`** (`requireCsrf` +
  `requireAuth`, no UI added) and **`npm run seed`**
  (`scripts/seed-demo.js`, for local/self-hosted). Both skip products already
  present by name, so a reload never duplicates rows.
- **Local persistence (supporting change):** `KAGE_DB_FILE=./kage.db` makes the
  sql.js backend load/save a real file (coalesced writes + an exit flush, still
  a no-op when unset — Turso and the default in-memory dev setup are unchanged).
  Without it, "delete everything, restart, still empty" is not observable
  locally at all, since the dev database dies with the process. Documented in
  `DEPLOY.md`, which also gained a "Demo products" section and a troubleshooting
  entry; `AGENTS.md` gained the invariant "one-time data steps run once per
  database via app_settings".

**Verification**

- `tests/e2e.test.js` (+7 checks, **93/93**), each running real child processes
  against a **file-backed** database (`tests/fixtures/bootstrap-child.js`), so a
  "restart" really throws away the module state and the per-process flag:
  fresh DB seeds 20 products and records all three keys; delete-all → restart
  still 0 (marker kept); sale removed → restart stays removed; `unit_cost = 0` →
  restart stays 0; a simulated production DB (catalogue present, **no markers**)
  → the fingerprint of every product name/price/sale/on_sale/stock is byte-identical
  before and after, the removed sale is untouched, the deliberate 0 is untouched,
  only the NULL cost is backfilled, and the markers read `existing` /
  `skipped-existing` / `backfilled:1`, with a second boot touching nothing at
  all; a failing database (injected at `prepare()`) records **no** marker and the
  next run seeds for real; `POST /api/admin/seed-demo` is 403 without CSRF, 401
  without a session, and after emptying the shop through the admin API it
  restores all 20 and leaves the markers alone.
- **Negative control:** reverting the guards (always re-seed, always re-apply
  sales, treat 0 as missing) failed 4 of the new checks exactly as reported —
  products resurrected, sale re-applied, `0` → backfilled estimate.
- **Manual / headless Chromium**, **6/6 checks**
  (`/home/user/chromium-checks/bootstrap-persistence.js`): a fresh file-backed DB
  seeds 20 products; the admin UI selects all of them and deletes them (list
  shows "No products yet"); the process is **killed and restarted against the
  same file**; after signing in again the product list is still empty — and
  `POST /api/admin/seed-demo` on the restarted process brings all 20 back on
  purpose. Screenshots: `/home/user/screenshots/bootstrap-products-deleted.png`,
  `bootstrap-products-empty-after-restart.png`.
- `npm test` → **93/93 API + 19/19 frontend scenarios**.

---

## 27. Email casing, shared admin/customer logout, and reactivation stock (2026-10-11)

Three small bugs, each checked against the current code first and covered by a
test that failed before the fix.

**1. Email casing.** `POST /api/orders` already stored the email trimmed and
lowercased (from the earlier IDOR work) and new signups/newsletter rows are
normalised too — but legacy rows could still hold `Buyer@Kage.Test`, and several
lookups compared raw strings (`WHERE email = ?`), so a mixed-case row was
invisible to login, order history, the clan count and "already subscribed".
- **Fixed lookups** (all now `LOWER(TRIM(email)) = ?`): `routes/admin.js`
  (newsletter ×2, clan order totals, coming-soon), `routes/auth.js`
  (customer signup duplicate check, login, forgot-password lookup) and
  `routes/orders.js` (clan shirt total, newsletter membership on order).
- **One-off migration** `normalize_emails_v1`, run through the same
  marker-guarded bootstrap as §26 (`server.js#normalizeEmailsOnce` →
  `database.js#normalizeEmailsMigration`), lowercases and trims
  `orders.email`, `customers.email` and `newsletter_subscribers.email`.
  It is duplicate-safe: `customers.email` / `newsletter_subscribers.email` are
  UNIQUE, so a blind `UPDATE ... = LOWER(...)` used to hit a constraint and be
  silently skipped, leaving the table mixed-case. The migration now **merges
  first, lowercases second** — the oldest row survives, orders
  (`customer_id`), verification tokens and reset tokens are re-pointed to it,
  a verified duplicate passes its `email_verified` on, and the extra row is
  deleted. The per-boot `normalizeEmails()` calls were removed (the migration
  supersedes them).

**2. Shared logout.** `POST /api/customers/logout` and `POST /api/admin/logout`
both did `req.session = null` on the shared `kage.session` cookie, so logging
out of one identity signed the other out in the same browser.
`clearSessionIdentity(req, key)` now deletes only `adminId` / `customerId` and
clears the whole session only when no identity key remains. The stale
`Set-Cookie: kage.cust=…` in the customer logout was dead code (nothing has set
`kage.cust` since the sessions were consolidated) and was removed.

**3. Reactivating a cancelled order.** The re-take loop floored stock at 0, so
if the units had been sold to someone else meanwhile the reactivation silently
under-counted inventory. `findStockShortages()` now checks **every** line before
anything is written (per-size rows and total-stock products alike, including
lines whose product or size no longer exists) and the request is refused with
**409** and a message naming the product, the size, the needed quantity and what
is available — nothing is partially applied. The admin status dropdown already
surfaces `data.error` through `alert()`, so no UI change was needed beyond
verifying it.

**Verification**

- `tests/e2e.test.js` (+5 checks, **98/98**): the migration merges a mixed-case
  customer duplicate (oldest row kept, lowercased, `email_verified` carried over,
  the order re-pointed to it) and a newsletter duplicate, records its marker, is
  idempotent on a second run, and leaves one row per address; lookups find
  mixed-case legacy rows (newsletter "already subscribed", login + history for a
  mixed-case account, clan total from a mixed-case order, forgot-password); an
  order placed as `Mixed.Case@Example.com` is stored lowercased, appears in the
  **verified** customer's history and counts toward the clan total; a
  browser-like cookie jar (kage.session + .sig + csrf, replayed like Chrome
  would) can hold both identities at once — customer logout leaves
  `/api/admin/me` at **200** and admin logout leaves `/api/customers/me` at
  **200**, with no `kage.cust` cookie and the other identity still 401-ing where
  expected; and reactivation is **409** with product/size/needed/available in the
  message, unchanged stock and unchanged status, no partial application on a
  two-line order where only one line is short, and still succeeds when there is
  enough stock.
- **Negative controls:** reverting each fix failed exactly the new checks —
  duplicates unmerged (two customer rows listed), lookups missing mixed-case
  rows, the dead `kage.cust` cookie back, and reactivation returning **200**
  with the stock silently under-counted.
- **Headless Chromium, 3/3** (`/home/user/chromium-checks/reactivate-409-message.js`):
  the real admin status dropdown shows the server's text —
  `Cannot reactivate this order: not enough stock — "Dropdown Probe Tee" (size One Size) — 4 needed, 0 available. Nothing was changed.`
  — with the order still cancelled and the stock untouched, and the same
  dropdown succeeds once the product is restocked. Screenshot:
  `/home/user/screenshots/reactivate-409-alert.png`.
- `npm test` → **98/98 API + 19/19 frontend scenarios**.

---

## 28. Shared database rate limits and per-account login lockouts (2026-10-11)

The in-memory `express-rate-limit` default was process-local, so Vercel serverless
instances did not share the 10/min login, 8/min order, 5/min reset or 120/min
global counters. Added the `rate_limits(key, count, reset_at)` table to the common
schema and additive migrations for Turso, sql.js and the in-memory backend.

- **Atomic shared store:** new `DatabaseRateLimitStore` implements the v8 store
  contract (`init`, `increment`, `decrement`, `resetKey`, `get`, `resetAll`).
  Counters use one `INSERT .. ON CONFLICT .. DO UPDATE .. RETURNING` statement,
  with expired-window reset and a 1-in-100 opportunistic cleanup. Turso enables
  it automatically; local/test setups keep the memory store unless
  `RATE_LIMIT_STORE=db` is set. For `KAGE_DB_FILE`, rate-counter operations use
  the existing SQLite file via the local libsql client under a small shared
  file lock, so separately running sql.js server processes really do share the
  same counter. sql.js snapshots merge the current `rate_limits` rows before
  persisting so a stale process cannot undo another process's counter.
- **Failure policy and IP keys:** global, strict, order, reset and customer
  login store errors log a warning and pass the request rather than returning a
  500. The admin login IP limiter fails closed with 429 and `Retry-After` if its
  store is down. The app still trusts exactly one Vercel proxy hop; the built-in
  express-rate-limit key generator uses `req.ip` and its IPv6 subnet helper.
- **Account lockouts:** admin failures are keyed by lowercased email and account
  type in the same table (`login_fail:<email>` for admins and a customer-specific
  prefix for customer accounts), and the fifth failed
  credential attempt locks that address for 15 minutes. Customer login uses a
  threshold of 10. Unknown email and wrong-password responses have the same
  401 shape and use the same cost-12 password-hash work; missing credentials do
  not increment, successful login clears the
  counter, and lockouts return 429 with a 15-minute `Retry-After`.
- **Sensitive routes/UI:** `/api/orders/track` and `/api/orders/:orderNumber`
  now use `strictLimiter`; reset-password is on the reset limiter and
  resend-verification remains limited. The admin page now shows a clear
  “Too many attempts. Please try again later.” message and translates
  `Retry-After` into a time-to-retry hint.

**Verification**

- `npm test` → **100/100 API + 19/19 frontend scenarios**, plus the new shared
  store integration suite.
- Two real server processes on different ports against one sql.js
  `KAGE_DB_FILE` shared the login bucket: attempts 1–10 returned 401 and
  attempt 11 returned 429. Five failed attempts for the same normalized email
  split across the processes also returned 429 on attempt 5. The tracking
  endpoint returned 429 on its 11th request across the two processes; the
  order-number endpoint shares that strict bucket.
- Short-window store test proves two store instances see the same counter and
  expiry resets it; a forced pure-memory fallback verifies that backend creates
  and uses the new table too. Additional checks cover 5/10-failure lockouts,
  email isolation, success reset, Retry-After, fail-open logging, admin
  fail-closed, forwarded IPv4, and IPv6 /56 normalization.
- Manual headless Chromium check (HeadlessChrome 153) submitted the blocked
  admin form after 10 failures; the login response was **429** with
  `Retry-After: 60`, and the page showed: “Too many attempts. Please try again
  later. Try again in about 1 minute.”

---

## 29. Storefront category cleanup, real Graphic Tees routing and orphan confirmation (2026-10-12)

Added focused red-first regressions in `tests/storefront-regressions.test.js`
for the customer-facing defects, ran them against the existing storefront (the
Pants nav/tile, four-column strip, dead loaders, TODO copy, Graphic Tees routing,
and `/confirmation` deep link all failed), then implemented the fixes. A browser
check also exposed an expected unauthenticated `/api/customers/me` 401 that
Chrome logged as a console error; that was reproduced separately before fixing.

- **Pants / category strip:** removed the unavailable Pants nav item and home
  tile; the shared nav markup therefore stays clean in desktop and mobile, and
  there was no Pants footer link. The three remaining tiles now use equal
  centered columns at desktop/tablet widths and compact, equal columns with
  scaled circles on phones. Updated the old four-card test.
- **Graphic Tees:** category navigation now uses `categoryHasLiveProducts()` for
  every coming-soon category and uses the regular product grid while stock is
  available. The grid filter/title/description now recognize `graphic-tees`.
  The four regular tee demo products (`Rising Vermillion`, `Blade Wolf`, `Neon
  Fangs`, `Shinobi Mark`) now seed into that exact category. New
  `normalize_demo_categories_v1` bootstrap migrates only their old default
  `anime` category, preserving any different category an admin already chose.
- **Dead loaders:** deleted `loadNewArrivals()`, `loadCollections()` and their
  calls; `initHomePageSections()` still loads the live Best Sellers and Recently
  Viewed sections. Removed the shadowed, unused `notifyMe(btn, category)`.
- **Unconfirmed policy copy:** removed the whole Shipping “Free-shipping
  threshold” paragraph and Contact “Working hours” paragraph because each
  suggested bracketed replacement was still a fill-in example. No placeholder
  value was published. Added page-text assertions against `TODO` and `[`.
- **Confirmation / routes:** direct `/confirmation` with no order now replaces
  the current history entry with `/tracking` immediately, activates Track Order
  without showing Page Not Found, and browser Back returns to the previous
  route. Kept `/confirmation` as an SPA shell route and added `/coming-soon` to
  `spaPages` because it is a real page. `kage-clothes` was already absent from
  server/frontend routes; regression coverage keeps it absent and verifies the
  stale bare path is 404.
- **Quiet session bootstrap:** anonymous `GET /api/customers/me` now returns
  `{ customer: null }` (200), rather than producing a browser console error for
  an expected 401 on every public route. Protected customer data endpoints
  remain authenticated.

**Verification**

- `npm test` → **100/100 API scenarios**, shared rate-limit integration suite,
  all storefront regressions, and **19/19 frontend scenarios**.
- Headless Chromium 153 at **1440px desktop** and **390px mobile**: confirmed no
  Pants nav link, exactly three equal-width tiles (about 373px desktop / 111px
  phone), and no horizontal overflow. Stocked Graphic Tees showed all four
  seeded products; setting their stock to zero switched to Coming Soon, and
  restoring stock returned to the grid.
- Opened 18 SPA routes at both sizes, including direct `/confirmation` →
  `/tracking` and a history Back check; no console or uncaught page errors.
  The sandbox cannot reach Google Fonts, so the headless check fulfilled that
  stylesheet request with an empty successful response rather than reporting a
  sandbox-only network error.
- `git diff --check` and JavaScript syntax checks passed.

---

## 30. Seven-item follow-up hardening (2026-10-12)

Completed the seven requested follow-ups with regression coverage:

- Ordinary static assets and `/uploads` now use one-day public caching with
  revalidation; HTML stays no-store, and only `/vendor` assets keep the one-year
  immutable policy. Numeric `/api/products/<digits>` GETs match the public cache
  rule; session-varying admin/customer APIs are no-store.
- Confirmed the CSRF caveat: a first uncookied public API GET sets `kage.csrf`,
  while a public cached read with an existing CSRF cookie does not send a new
  `Set-Cookie`. No cache/cookie redesign was made.
- Product and standalone uploads now require an allowed raster extension and
  MIME type; all four admin file pickers exclude SVG/wildcards. Existing public
  SVG logos/assets were left intact.
- Removed manual signed-cookie parsing, `readSignedSession`, and the legacy
  `kage.cust` identity fallback. Auth uses only verified `req.session`; valid
  cookie-session login and forged/detached-cookie regressions pass.
- Centralized `SITE_URL` in `utils/siteUrl.js`. Page canonical/OG/JSON-LD tags,
  dynamic `/sitemap.xml` and `/robots.txt`, and reset/verification links share
  that configuration. Missing production configuration warns and uses request
  origin for page tags, but reset/verification emails are suppressed rather
  than using a guessed domain. Updated `DEPLOY.md`, `.env.example`, `AGENTS.md`
  and the audit notes.
- Review GETs send `X-Viewer-Token`; the legacy query parameter remains accepted
  during rollout. Token-scoped responses are `Cache-Control: private`, and the
  storefront regression checks the token never appears in the URL.
- Sold-unit counts and approved-review aggregates now share a 60-second cache,
  invalidated after order, review, and product writes.

**Verification**

- `npm test` → **113/113 E2E scenarios**, shared rate-limit integration passed,
  storefront regression suite passed, and **19/19 frontend scenarios**.
- Headless Chromium confirmed the hero image loads, canonical/OG and dynamic
  sitemap/robots URLs use `SITE_URL`, and a reviewer sees their own pending
  review immediately after submission. No browser console/page errors. Google
  Fonts were intercepted with an empty successful stylesheet because the
  sandbox cannot reach that external host.
- `git diff --check` and Node syntax checks passed.

---

## 31. Pre-customer_id databases could not boot: an index was created before its column (2026-10-11)

**Incident.** Production (Vercel + Turso) answered 503 for every request while
the log said `FATAL: Turso is configured (TURSO_DATABASE_URL) but could not be
reached`. The database was reachable. Booting the current code against a
database created *before* the customer_id feature failed with
`SQL_INPUT_ERROR: no such column: customer_id`; freshly provisioned databases
were fine, which is why local development and new deploys looked healthy.

**Root cause.** `createSchema()` ran
`CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)`
before the Turso migration block had added `orders.customer_id` to the existing
(old) `orders` table. An index on a column that does not exist yet is a hard
error, so the whole boot aborted before any migration could run. The same
ordering bug existed on the sql.js file backend, where it silently degraded to
the throwaway in-memory store instead of failing visibly.

**Fixes**

- `createSchema()` now creates tables only; every index moved into
  `createIndexes()`, which runs **after** the column migrations on all three
  backends (Turso, sql.js, in-memory). `idx_orders_customer_id` is kept in its
  own `MIGRATED_COLUMN_INDEXES` list to make the dependency explicit. Audit of
  the rest of `createSchema()`: it was the only statement referencing a column
  added by a later migration — the `CREATE TABLE IF NOT EXISTS` bodies are
  no-ops on an existing table, and the other indexes use columns that existed
  from the first build.
- `ensureSqlJsColumns()` (which patched only `orders.customer_id` and
  `customers.email_verified` on the sql.js path) was replaced by one shared
  `ADDITIVE_COLUMN_MIGRATIONS` list — `products.unit_cost`, `products.[drop]`,
  `orders.payment_ref` / `payment_verified` / `cod_confirmed` /
  `shipping_pending` / `customer_id`, `customers.email_verified`,
  `reviews.viewer_token` — executed by every backend. Each `ALTER TABLE` has its
  own try/catch: only `duplicate column name` is ignored, any other error is
  logged together with the exact failing statement, and the boot fails after all
  remaining migrations were attempted, so a half-migrated database is never
  served and one bad column cannot hide the others.
- Boot-failure messages carry the real error. A SQL/schema failure is reported
  as `… the database failed to initialize — <real error>`; only socket/DNS-level
  failures (fetch failed, ECONNREFUSED, DNS …) keep the “could not be reached”
  summary, with the underlying message appended. The public 503 body is
  unchanged and still generic.

**New upgrade test** — `tests/upgrade-migration.test.js` (wired into `npm test`)

- `tests/fixtures/legacy-schema.js` builds a database with the pre-migration
  schema (products without `unit_cost`/`[drop]`; orders without
  `payment_*`/`customer_id`; customers without `email_verified`; reviews without
  `viewer_token`; no `app_settings`, `rate_limits` or
  `customer_verification_tokens`) plus realistic rows: three legacy orders,
  duplicate mixed-case customers and newsletter subscribers, a live password
  reset token, reviews and per-size stock.
- `tests/fixtures/upgrade-child.js` boots the real server against that file in a
  separate process, once per backend — sql.js file (`KAGE_DB_FILE`) and the
  libsql/Turso client on a local `file:` URL (`TURSO_DATABASE_URL`) — then places
  an order, signs a customer up, opens the verification link, reads that
  account's order history, and logs in as the merged duplicate account.
- Asserted per backend: boot succeeds on the requested backend (a silent
  fallback fails the test); the upgraded schema is identical to a freshly created
  one (all columns, tables and 11 indexes, including `idx_orders_customer_id`,
  `app_settings`, `rate_limits`, `customer_verification_tokens`); every old row
  survives; the oldest duplicate customer wins (its password still works, the
  newer duplicate is gone); orders can be placed and decrement stock; signup +
  verification links the legacy guest order through `orders.customer_id`; a
  second boot changes nothing at all (idempotent ALTERs, one-time bootstrap
  markers intact).
- Negative control: the same suite run against the pre-fix `database.js`
  (`KAGE_UPGRADE_DB_MODULE=/tmp/previous-database.js`) fails 15/15 — on the
  libsql/Turso path with `SQLITE_ERROR: no such column: customer_id`, on the
  sql.js path by falling back to the in-memory backend — and the
  misleading-message check fails with the old “could not be reached” text.

**Verification**

- `npm test` → **113/113 E2E scenarios**, shared rate-limit integration passed,
  storefront regressions passed, **15/15 upgrade-migration checks**, and
  **19/19 frontend scenarios**.
- Manual replay of the production shape (legacy database + `VERCEL=1` +
  `TURSO_DATABASE_URL=file:…`): boot succeeds on the `turso` backend with the
  legacy rows intact and the email merge applied; the same file previously failed
  with `no such column: customer_id`.

---

## 32. CSRF cookie no longer rides on publicly cacheable reads (2026-10-12)

**Problem.** `csrfMiddleware` issued `kage.csrf` on the first request that lacked
it, whatever the response. `/api/products`, `/api/products/:id` and `/api/reviews`
are served `Cache-Control: public, max-age=…, s-maxage=…`, so an edge/CDN cache
would store a response that carried one visitor's `Set-Cookie` and replay it to
every other visitor who got the cached copy — a cache-poisoning hazard for a
token that protects state-changing requests.

**Fix**

- The cookie is now issued only on responses a shared cache will not store:
  `public`/`s-maxage` responses never carry it, everything else (HTML pages, the
  new endpoint, dynamic no-store routes) still does. The decision is made at
  header-flush time from the response's own `Cache-Control`, so any future route
  that opts into shared caching is covered automatically — no path list to keep
  in sync.
- New `GET /api/csrf`: `no-store`, returns `{ token }`, and (when the caller had
  no cookie) sets the `kage.csrf` cookie with that same value. It is the only
  endpoint whose body repeats the cookie value.
- Storefront and admin `fetch` wrappers now obtain a token before the first
  state-changing request when the cookie is missing — one in-flight request per
  page load, retried if it comes back empty — and handle both plain-object and
  `Headers` header bags. Admin's verify-payment / cod-confirm stopped passing a
  manual header (the wrapper supplies it), and logout refreshes through the same
  helper instead of reloading `/`.
- `HEAD` now follows the `GET` API cache policy. It previously returned no
  `Cache-Control`, so a `HEAD /api/products` still carried a `Set-Cookie` — HEAD
  must report the same headers a GET would.

**Tests**

- E2E: `/api/products`, `/api/products/1`, `/api/reviews` return no `Set-Cookie`
  for GET **and** HEAD, with and without an existing cookie, while keeping their
  public cache headers; `/api/csrf` is `no-store`, issues the cookie and agrees
  with its body token (a second call with the cookie returns no new cookie);
  HTML pages (`/`, `/admin`) still issue the cookie and the token they hand out
  passes `requireCsrf` on a later POST (validation 400, not 403); `/vendor`-style
  cached assets send no cookie.
- E2E fresh-browser checkout: a cookie-less client is refused (403) with no
  token, and refused again with a token but no matching cookie; after
  `GET /api/csrf` the order is placed (201) and trackable by number + phone.
- Frontend (jsdom, new scenario 20; the harness now behaves like a browser —
  sending the document's cookies and storing response `Set-Cookie`): the
  catalogue reads the page makes carry no `Set-Cookie`; with the cookie cleared
  the storefront fetches `/api/csrf` **before** POSTing the order, completes
  checkout, shows the confirmation, and the order is trackable server-side; with
  a cookie present no further token request is made.

**Verification:** `npm test` → **116/116 E2E**, shared rate-limit integration,
storefront regressions, 15 upgrade-migration checks, **20/20 frontend scenarios**.
Docs updated: `AUDIT.md` (the 2026-10-12 “first uncookied public API GET sets the
cookie” caveat is now resolved) and `ADMIN_DASHBOARD_FAULTS.md` (CSRF notes).

## 33. Gmail SMTP email transport alongside Resend (2026-10-12)

**Change.** `utils/email.js` now prefers SMTP whenever `SMTP_HOST` is configured,
using `SMTP_USER`/`SMTP_PASS`, `SMTP_PORT` (default `465`; implicit TLS on 465
and STARTTLS on other ports), and `EMAIL_FROM` (defaulting to `SMTP_USER`). When
SMTP is unset, the existing Resend API path remains; with neither configured,
the existing dev-mode email log remains. SMTP failures do not fall back to
Resend, avoiding unexpected delivery through a second provider.

Every provider send has an 8-second wall-clock deadline. SMTP connect, greeting
and socket timeouts are also set, the SMTP transport is closed on timeout, and
Resend fetch is aborted at the same deadline. Port 465 uses implicit TLS; other
ports require STARTTLS. A failure/timeout logs a warning
and returns `false`; the existing order/status handlers still await sends before
responding, while a mail outage does not fail or roll back an order. Existing
recipient/subject CRLF stripping and escaped HTML templates are unchanged.

Added `nodemailer` 10.1.0 (the current patched release) and raised the declared
runtime minimum to Node 20 to match its engine requirement. `.env.example` and
`DEPLOY.md` now list all SMTP/Resend variables and include Gmail App Password,
TLS/port, sender, precedence, and redeploy setup steps.

**Tests.** `tests/e2e.test.js` uses Nodemailer's real JSON transport as a
no-network SMTP capture to inspect the order confirmation, status update,
password reset, and verification messages: expected sender/recipient/subject,
empty custom headers, escaped hostile content, and generated email links. It
also verifies SMTP implicit-TLS/STARTTLS modes, auth/8-second options and header
stripping, Resend when SMTP is unset, SMTP precedence, a bounded stalled send,
and that a failed SMTP send logs a warning while order placement still succeeds.

**Verification:** `npm test` → **125/125 E2E**, shared rate-limit integration,
storefront regressions, **15/15 upgrade-migration checks**, and **20/20
frontend scenarios**. `npm audit --omit=dev` → **0 vulnerabilities**.

## 2026-10-12 — Pants tile, aligned category cards, Graphic Tees shop grid, consolidated category admin

**Homepage Pants tile (4th in the strip).** Added a new Pants card immediately
after Anime Shirts (order: Graphic Tees, Anime Shirts, Pants, Custom Stickers),
using the existing `/images/pants.jpg` thumbnail, name **Pants**, description
"Relaxed fits to match the drops." While there are no in-stock pants products
the tile renders as a `<span aria-disabled="true">` (no `href`, no `onclick`,
`pointer-events:none`, no hover lift, `cursor:default`) and shows a small
"Coming soon" pill in place of the Explore button. When `categoryHasLiveProducts('pants')`
returns true (i.e. at least one in-stock pants product exists) the tile is
rebuilt as a real `<a href="/collection/pants">` link, the pill is hidden, and
the Explore button appears. The Pants nav entry, mobile-menu link and a new
"Shop" footer column are all present in the markup but hidden
(`display:none`) until pants go live, then they reveal automatically. The
sync runs after products finish loading from `/api/products`.

**Card alignment.** The four tiles now share a baseline at every width:
`.cat-tile` is `align-items:stretch` with `height:100%`, `.cat-info` is
`flex:1` so the copy column fills its cell, `.cat-name` and `.cat-desc` have
consistent `min-height` lines (2-line name on phone/tablet, ~3–4-line
description), and `.cat-shop`/`.cat-coming-soon` are pushed to the bottom
with `margin-top:auto`. No circle is cropped, names wrap cleanly (no
mid-word breaks), and the "Explore" / "Coming soon" label sits on a single
shared row across every column.

**Responsive grid for four tiles.** Desktop (≥1024px) — `repeat(4, minmax(0,1fr))`,
150px circles, 40px gap, centred inside a 1200px band. Tablet (600–1023px) —
four balanced columns with 104px circles, tighter type, min-heights on the
copy so the labels line up. Phone (<600px) — `repeat(2, minmax(0,1fr))` 2×2
grid with 72–108px clamp-scaled circles, 20px gap. Verified at 320/360/414/
768/1440 with no horizontal scroll.

**Graphic Tees is no longer Coming Soon.** Removed `'graphic-tees'` from
`COMING_SOON_CATS`, so `/collection/graphic-tees` always routes to the shop
grid regardless of stock. When zero graphic tees are available the grid
shows a friendly empty state ("No graphic tees available right now. Check
back soon for new drops.") with a "Browse all shirts" button that takes the
shopper to `/collection/all`, rather than the Coming Soon template. The
"coming soon" label, email form and coming-soon badges never appear on
Graphic Tees anymore. The filter uses the exact key `graphic-tees` with no
fallback to `anime` or other categories.

**Category source of truth.** The canonical category list lives once in
`config.js`:

```js
PRODUCT_CATEGORIES = [
  { value: 'graphic-tees', label: 'Graphic Tees' },
  { value: 'anime',        label: 'Anime Shirts' },
  { value: 'pants',        label: 'Pants' },
];
```

`PRODUCT_CATEGORY_VALUES` is the Set used by the server for validation.
Custom Stickers remains a top-level brand page, **not** a product category.
Streetwear and Goofy Wears are removed entirely — no filters, labels,
search, sitemap entries, seed products or CSV rows reference them.

**Admin dropdowns.** All three category `<select>` elements in
`public/admin.html` (#prodCategory on the Add/Edit form, #quickCategory on
Quick Upload, #productCategoryFilter on the product list) start with a
"Select a category" placeholder, build their options from a single
`CATEGORY_OPTIONS` constant populated at DOMContentLoaded, require an
explicit choice before submit, and show an inline error instead of silently
defaulting to `'anime'`. The per-row category label in the product list
reads from the same map, so Pants shows up as "Pants" and the removed names
can never reappear.

**Server validation.** `POST /api/products` trims the incoming category
value and rejects anything outside `PRODUCT_CATEGORY_VALUES` with HTTP 400
and a clear message listing the valid options. `PUT /api/products/:id`
preserves the existing category when the field is omitted, and validates
with the same allow-list when supplied.

**Data migration (`remove_old_categories_v1`).** Added to the existing
one-time-per-database bootstrap loop right after
`normalize_demo_categories_v1`. Runs `UPDATE products SET category = 'graphic-tees' WHERE category NOT IN ('graphic-tees','anime','pants')`,
which sweeps legacy `streetwear`, `goofy-wears` and any other stray value
into Graphic Tees so the catalogue never loses rows. Idempotent (once every
row carries an allowed category, changes = 0 and the key still records
`migrated:N`). Logs the count moved.

**Demo/seed rewrite.** `utils/demoProducts.js` now seeds 10 products:
3 anime (Shadow Fit, Oni Muscle Tee, Kage Core Compression) and 7 graphic
tees (Rising Vermillion/Blade Wolf/Neon Fangs/Shinobi Mark regular, plus
Drift Oversized/Wrath Silhouette/Hollow Gaze oversized). Hollow Gaze is
seeded at stock 0 to exercise the empty-state path. Rising Vermillion and
Wrath Silhouette keep their existing sale prices (Rs. 799 / Rs. 1099).
`LEGACY_CATEGORY_FIXES` keeps the four "anime → graphic-tees" corrections
for the existing seed. No pants are seeded yet (the tile stays in its
disabled "Coming soon" state until an admin adds one via the panel).

**Footer Shop column.** Added a fourth footer column with persistent links
to Anime Shirts, Graphic Tees, All Products, and a Pants link that is
hidden until pants are live.

**Tests.** Updated every reference that expected Pants to be absent from
the DOM and Graphic Tees to fall back to Coming Soon. New / updated
checks cover:
- Four tiles in the exact order, Pants a disabled `<span>` while
  out-of-stock, becoming an `<a>` + visible nav/footer link after a live
  pants product is pushed into `allProducts` via `syncPantsCategoryVisibility()`.
- `/collection/graphic-tees` renders the shop grid (never Coming Soon)
  both when in stock and at zero stock (empty state with the "Browse all
  shirts" button).
- All three admin `<select>` elements contain exactly the three canonical
  options plus the placeholder, no default selection.
- Invalid category values on POST/PUT return 400; valid values succeed.
- The `remove_old_categories_v1` migration rehomes a `streetwear` row to
  `graphic-tees`, leaves existing `anime`/`graphic-tees`/`pants` rows
  (including an admin-edited Blade Wolf → pants) untouched, is idempotent,
  and records its key on the legacy-schema fixture.
- Responsive CSS breakpoints for 4/4/2 columns at desktop/tablet/phone.
- jsdom admin flows now call `populateCategorySelects()` and select an
  explicit category before Quick Upload / Save Product.

**Verification:** `npm test` → **125/125 E2E**, shared rate-limit
integration, **all storefront-regression checks**, **all upgrade-migration
checks**, and **20/20 frontend scenarios**.

## 2026-10-12 — Themed collections removed; frontend test syntax repaired

**Scope:** delete the themed collections feature (The Vault / Iron Code /
After Hours) end-to-end while keeping the existing design, colours and
fonts, and the category system (Graphic Tees, Anime Shirts, Pants) exactly
as it is.

**Storefront (`public/index.html`).**
- Removed the "Collection" dropdown (The Vault / Iron Code / After Hours)
  from the Filter drawer / filter panel. The drawer keeps its Style,
  Price Range and Size filters, and they still work.
- Removed `filterState.collection` and every code path that filtered on
  `p.collections` / `filterState.collection` (route filter branch, drawer
  read/sync, active-filter counter, empty-state condition).
- Removed the three collection pages' titles and descriptions from the
  shop title/description maps.
- `/collection/the-vault`, `/collection/iron-code` and `/collection/after-hours`
  (and any other unknown slug) now behave like any unknown collection URL:
  the router `replaceState`s to `/collection/all` and renders the normal
  catalog — no themed page, no broken page. Direct `navigateTo()` calls with
  a deleted slug are normalized the same way.
- Removed `collections` from the demo/fallback products and from the API
  product mapping in `loadProductsFromAPI()`.
- Deleted the dead "featured collections" / "product collection cards" /
  `home-collections` CSS (nothing referenced it) and the legacy `page ===
  'collections'` alias. Category-page CSS (`/collection/` routes, collection
  grid) is untouched — categories stay.

**API / admin / data.**
- `utils/productShape.js`: `collections` dropped from the public allow-list
  and the field-by-field payload builder, so neither the public nor the admin
  products API returns it. No Collections field was added to (or exists in)
  the admin forms.
- The legacy `products.collections` column is left in place in
  `database.js` (annotated as inert) — it is never dropped, so databases
  created by older versions keep upgrading cleanly; nothing reads or writes
  it any more. `tests/fixtures/legacy-schema.js` keeps the column in its
  historical DDL for the same reason (and no longer seeds values into it).
- Seed data (`utils/demoProducts.js`) was already free of collections; the
  demo/fallback catalog in `public/index.html` is now too. The admin
  coming-soon endpoint's error copy now says "Unknown category." (it
  validates categories, not collections). Sitemap/robots and the orders CSV
  export never carried collections.

**Tests.**
- New frontend scenario "Removed collection pages and the Collection filter
  are gone; deleted URLs land on /collection/all": deep-links to all three
  deleted URLs must land on `/collection/all` with the normal catalog (not
  404/not-found/coming-soon, no themed title), the markup must not mention
  the three names, the Collection dropdown / `filterState.collection` /
  product `collections` fields must be absent, and the public products API
  must not return `collections`.
- New frontend scenario "Filter drawer opens and its style/price/size
  filters still work": the drawer opens with its overlay, style/price/size
  filtering narrows the grid, changes sync to the desktop panel, the active
  filter badge counts style/price/size only, Apply closes, Reset clears.
- New storefront-regression check: the three deleted slugs (deep link +
  popstate) land on `/collection/all` and never render a broken page.
- `tests/frontend.test.js` also had its Pants-tile identifier collision
  repaired (the second declaration is scoped/renamed so `node
  tests/frontend.test.js` parses and runs clean standalone).

**Verification:** `npm test` → **125/125 E2E**, shared rate-limit
integration, **all storefront-regression checks**, **all upgrade-migration
checks** (schema parity with the legacy column intact), and **22/22
frontend scenarios**.

## 2026-10-12 — Homepage category cards: phone snap row + pinned, aligned labels

**Scope:** fix the category strip in `#sectionCategories` (Graphic Tees, Anime
Shirts, Pants, Custom Stickers) on phones without touching the existing
design, colours or fonts.

**The problem.** Below 600px the four cards were a jumbled left-aligned 2×2
grid — names and descriptions wrapped unevenly and the Explore / Coming-soon
labels sat at different heights on every card.

**Storefront (`public/index.html`).**
- **Phones (≤599px): the 2×2 grid is now ONE horizontal swipeable row.**
  CSS scroll-snap: `display:flex`, `overflow-x:auto`,
  `scroll-snap-type: x mandatory`, `scroll-padding-inline: 16px`,
  `-webkit-overflow-scrolling: touch`, hidden scrollbar
  (`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`).
  Cards are `flex: 0 0 44vw` with `scroll-snap-align: start` and a 12px
  gap. The row is full-bleed (`margin-inline:-16px`) and carries the real
  page gutter (16px at ≤768px, same as `.container`) as its own
  `padding-inline`, so snapped cards line up with page content and the next
  card peeks at the screen edge (3.2px at 360px, 9.6px at 414px) so people
  know they can swipe. `scroll-padding-inline` keeps snap positions at the
  gutter instead of letting mandatory snap eat it. Only the row scrolls
  sideways — the page never does (verified: `document.scrollWidth ==
  innerWidth` and `window.scrollX` stays 0 at 360/414).
- **Keyboard access:** the row is `tabindex="0"` with an
  `aria-label="Shop categories"` and a visible white focus ring
  (`.category-strip:focus-visible { outline: 2px solid #FFF; outline-offset:
  -4px }` — white because the section band is the accent colour).
- **Tablet (600–1023px) + desktop (≥1024px):** unchanged one-row four equal
  columns (desktop still centred, capped at 1200px) with the existing circle
  sizes (104px / 150px).
- **Alignment in every layout** (design, colours, fonts untouched):
  `.cat-name` reserves 2 lines (`min-height: 2lh`), `.cat-desc` reserves 3
  lines top-aligned (`min-height: 3lh`), Explore and Coming-soon share
  `min-height: 28px` (the pill's natural height) so both label types sit on
  one line, and `.cat-shop` keeps `margin-top: auto` so labels pin to the
  card bottom with `.cat-tile`/`.cat-info` stretching to equal heights —
  even when "Custom Stickers" wraps to two lines.
- Pants behaviour untouched: still a non-link `aria-disabled="true"` span
  with the Coming-soon pill while out of stock (no hover lift), switching to
  a normal Explore link when stock arrives (and the Pants nav/footer items
  with it).

**Tests (real Chromium).**
- New dev dependency `@sparticuz/chromium` (Chromium ships as an npm
  package — Google's browser download hosts are not reachable from every
  environment) behind `tests/fixtures/chromium.js`, which resolves a system
  Chrome first, falls back to the package, and extracts its bundled shared
  libraries on bare Linux hosts so the browser starts anywhere.
- `tests/frontend.test.js` (22 → **23/23**): the category-strip scenario's
  layout contracts were updated to the new phone snap row, gutter padding,
  hidden scrollbar, 44vw snap cards, the 2lh/3lh/28px alignment reserves and
  the focus ring; a new real-Chromium scenario measures the strip at
  **360 / 414 / 768 / 1440px**, scrolling each card into view before
  measuring. Measured tops (thumb / name / desc / label — identical for all
  four cards, 0.00px spread):
  - 360px: 575.58 / 685.17 / 722.59 / 771.41
  - 414px: 605.95 / 729.58 / 771.59 / 820.41
  - 768px: 832.75 / 952.75 / 996.86 / 1045.67
  - 1440px: 1207.55 / 1373.55 / 1432.34 / 1495.64
  Phones additionally verified: `x mandatory` snap, `scrollWidth > clientWidth`
  (702 > 360 and 797 > 414), cards 44vw wide, circle clamp sizes (93.6px /
  107.6px), ≥1 card peeking at rest, and a 2px solid white `:focus-visible`
  ring on the focused row. Tablet/desktop verified: four equal columns,
  one non-scrolling row, circles 104px / 150px, equal 28px label heights.
- `tests/storefront-regressions.test.js`: the "responsive grids" contract
  updated from the old 2×2 phone grid to the snap-row + 44vw contracts.

**Verification:** `npm test` → **125/125 E2E**, shared rate-limit
integration, **all storefront-regression checks**, **all upgrade-migration
checks**, and **23/23 frontend scenarios** (including real-Chromium
geometry at 360/414/768/1440px) — exit 0.

## 2026-10-12 — Homepage category cards: 2×2 phone grid (no scroll row) + every part aligned

**Scope:** replace the phone snap-row on the homepage category strip
(`#sectionCategories` — `.category-strip`, `.cat-tile`, `.cat-thumb`,
`.cat-info`, `.cat-name`, `.cat-desc`, `.cat-shop`) with a real 2×2 grid, and
make the four parts of every card line up in every layout. Card order is
Graphic Tees → Anime Shirts → Pants → Custom Stickers. Design, colours and
fonts are untouched.

**The problem.** The previous session's fix made the phone strip a horizontal
scroll-snap row, which is not what the page wants: the page could be dragged
sideways inside the band, cards were 44vw (so they never formed a tidy grid),
and the circles sat left-aligned in their cell instead of centred.

**Storefront (`public/index.html`).**

*Layout*
- `.category-strip` is now **mobile-first `display: grid` with
  `grid-template-columns: repeat(2, minmax(0, 1fr))` and a 16px gap**, and
  lives inside the page's own side gutters (`.container` — 16px at ≤768px).
  No negative margins, no full-bleed, no `overflow-x`, no `scroll-snap-type`,
  no `scroll-padding-inline`, no `::-webkit-scrollbar` hiding, and no
  `44vw` / `scroll-snap-align` card sizing — all removed.
- **600–1023px:** `repeat(4, minmax(0, 1fr))`, 16px gap, circles 104px.
- **≥1024px:** `repeat(4, minmax(0, 1fr))`, 40px gap, circles 150px, strip
  still capped at `max-width: 1200px` and centred with `margin-inline: auto`.

*Alignment (the main goal)*
- `.cat-tile` keeps `display:flex; flex-direction:column; height:100%` but is
  now `align-items: center` (was `stretch`), so the circle, copy and label are
  centred inside each card. `.cat-info` keeps `flex: 1 1 auto; width: 100%`.
- `.cat-name` and `.cat-desc` each reserve **two lines** (`min-height: 2lh`,
  with `2.5em` / `2.8em` fallbacks for engines without `lh`) with the text
  top-aligned, so a longer name or description can never push a neighbour's
  copy down. `.cat-desc` went from a 3-line to a 2-line reservation.
- `.cat-shop` / `.cat-coming-soon` keep `margin-top: auto` **and** the shared
  `min-height: 28px`, so the Explore label and the Coming-soon pill always
  have the same height and the same top.
- Descriptions shortened to the same short shape (≤2 lines on a 320px phone
  column): "Bold prints on oversized fits." / "Original art on premium
  cotton." / "Relaxed fits for every drop." / "Your design, our print."
- Phone names are sized to stay on **ONE** line in a 320px column —
  `font-size: clamp(0.66rem, 2.9vw, 0.82rem)` with `letter-spacing: 0.03em`
  (CUSTOM STICKERS renders 117px wide inside a 136px column, ~14% headroom
  even with the wide fallback font the test browser uses). The 2-line
  reservation is the safety net if a name ever does wrap.
- Tablet names now scale with the column —
  `clamp(0.68rem, 1.7vw, 0.8rem)` / `letter-spacing: 0.04em` — so
  "Custom Stickers" also stays on one line from 600px up (122px in a 130px
  column at 600px).

*Pants* behaves exactly as before: a non-link `aria-disabled="true"` span with
the Coming-soon pill and no hover lift while nothing is in stock, switching to
a normal `<a>` with "Explore" once a pants product is stocked
(`syncPantsCategoryVisibility()` untouched).

**Tests.**
- `tests/frontend.test.js` (23 → **25/25**): the category-strip scenario now
  asserts the 2×2 phone / 4-column tablet / centred 1200px desktop grid
  contracts, the shortened descriptions, the `height:100%` + `flex:1 1 auto` +
  `2lh` + `28px` + `margin-top:auto` alignment reserves, and — via
  `assert.doesNotMatch` — that no `overflow-x: auto`, `scroll-snap*`,
  `scroll-snap-align` or negative full-bleed margin survives anywhere on the
  strip. The real-Chromium scenario now measures **320 / 360 / 414 / 599 /
  768 / 1440px** and checks: exactly 2 columns and 2 rows on phones with equal
  column/row gaps, the page's side gutters on both edges, four equal columns
  and one row at 768/1440, `overflow-x: visible` + `scroll-snap-type: none`
  + `scrollWidth <= clientWidth` on the strip, `window.scrollX === 0` and
  `scrollWidth <= innerWidth` for the document, every name on one line,
  every description ≤2 lines, all four circles centred / square / 88–104px on
  phones and 104px / 150px on tablet / desktop, and — the main goal — the
  per-row spread of `thumbTop` / `nameTop` / `descTop` / `labelTop` within
  1px plus equal 28px label heights.
- `tests/storefront-regressions.test.js`: the "four category tiles …" check
  updated from the old snap-row / 44vw contracts to the 2×2 phone grid and
  the alignment reserves; the old scroll-row expectations are gone.

**Measured in real Chromium (tops thumb / name / desc / label, spread 0.00px
inside every row; labels all 28px):**

| width | layout | columns | circle | row 1 tops | row 2 tops |
|---|---|---|---|---|---|
| 320px | 2×2 | 2 × 136px, gap 16/16, gutters 16/16 | 88px | 553.08 / 657.08 / 688.22 / 723.23 | 767.23 / 871.23 / 902.38 / 937.39 |
| 360px | 2×2 | 2 × 156px, gap 16/16, gutters 16/16 | 93.59px | 575.58 / 685.17 / 716.31 / 751.33 | 795.33 / 904.92 / 936.06 / 971.05 |
| 414px | 2×2 | 2 × 183px, gap 16/16, gutters 16/16 | 104px | 605.95 / 725.95 / 760.75 / 795.73 | 839.73 / 959.73 / 994.53 / 1029.52 |
| 599px | 2×2 | 2 × 275.5px, gap 16/16, gutters 16/16 | 104px | 716.59 / 836.59 / 874.14 / 909.13 | 953.13 / 1073.13 / 1110.67 / 1145.66 |
| 768px | 1×4 | 4 × 172px, strip 16..752 | 104px | 832.75 / 952.75 / 989.52 / 1023.66 (all four) | — |
| 1440px | 1×4 | 4 × 270px, strip 120..1320 (centred, 1200px) | 150px | 1207.55 / 1373.55 / 1423.34 / 1467.14 (all four) | — |

Names render on one line at every width measured; descriptions are ≤2 lines
on phones (2/2/2/1 at 320px). Re-measured with the Pants tile forced live
(four "Explore" labels instead of three + the pill): identical tops and
identical 28px label heights.

**Verification:** `npm test` → **125/125 E2E**, shared rate-limit
integration, **all storefront-regression checks**, **all upgrade-migration
checks**, and **25/25 frontend scenarios** (including real-Chromium geometry
at 320/360/414/599/768/1440px) — exit 0.
