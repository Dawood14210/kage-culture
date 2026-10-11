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
