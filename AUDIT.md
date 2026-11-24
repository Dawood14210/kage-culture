# KAGE CULTURE — Website Audit & Fix Log

> Audit date: 2026-09-20 (API/server) · Frontend audit: 2026-09-23 (storefront + admin
> panel) · Scope: Express API + vanilla-JS SPA storefront + admin panel, dual-backend DB
> (Turso / sql.js / in-memory), deployed on Vercel serverless.
>
> Status legend: ✅ fixed · ⬜ open · 🔴 critical · 🟠 high · 🟡 medium · 🔵 low

---

## Completed work

### ✅ 1. Full security & quality audit (this conversation)
Audited: `server.js`, `config.js`, `database.js`, all `routes/*`, `middleware/*`, `utils/*`,
`vercel.json`, `.env.example`, `.gitignore`, `public/*` (index.html, admin.html, robots, sitemap,
manifest, images), dependency advisories, repo hygiene.

### ✅ 2. CRITICAL: Admin auth bypass — FIXED (`middleware/auth.js`)
**Was:** `requireAuth` / `requireCustomerAuth` base64-decoded the session cookie payload and
trusted `adminId` / `customerId` **without verifying the HMAC signature**. Anyone could send
`Cookie: kage.session=<base64({"adminId":1})>.x` and get full admin access
(product CRUD, all orders/PII, CSV export, uploads). Same flaw for customer impersonation
via `kage.cust`.

**Fix (single file, +42/−17):**
- Added `readSignedSession(value, secret)` — verifies `HMAC-SHA256(payload, SESSION_SECRET)`
  using **constant-time** comparison (`crypto.timingSafeEqual`), parses JSON only after the
  signature passes, rejects arrays/non-objects.
- Both middlewares now **fail closed**: malformed, unsigned, tampered, or wrong-secret
  cookies → 401. Primary `req.session` path (cookie-session) unchanged.
- Exported `readSignedSession` for testing.

**Verification — 7/7 live end-to-end tests passed** (server on :3999, sql.js backend):

| Scenario | Result |
|---|---|
| Valid admin cookie pair | 200 ✅ |
| Tampered payload + stolen `.sig` | 401 ✅ |
| Forged inline `adminId=1` (the old exploit) | 401 ✅ |
| Wrong-secret signature | 401 ✅ |
| No cookie | 401 ✅ |
| Customer session on admin route | 401 ✅ |
| Customer session on customer route | 200 ✅ |

### 🔎 Discovery from testing (important context)
The manual inline-signed `Set-Cookie` in `routes/auth.js` (admin login ~line 45, customer
login ~line 125) is **dead code**: cookie-session's middleware commit overwrites it, so
browsers actually receive cookie-session's pair (`kage.session` payload + separate
`kage.session.sig`, signed by keygrip with the same secret). Live auth flows through
`req.session` (cookie-session verifies its own signature). The hardened fallback in
`middleware/auth.js` covers the inline format anyway (fail closed).

---

## Completed work — 2026-09-23 session (all C1, H1–H4, M1–M7, L1/L3–L7)

### ✅ C1 — Admin bootstrap race + storefront auto-setup (FIXED)
- `POST /api/admin/setup` is now **opt-in**: disabled with 403 unless `ALLOW_ADMIN_SETUP=true` (`.env.example` documents it — enable only while creating the first admin, then remove).
- Insert made atomic: `INSERT ... ON CONFLICT (email) DO NOTHING`; the `changes` count decides success, so two concurrent setups can no longer both win. Works on all three backends (Turso/sql.js/mem honor the UNIQUE email constraint; mem-store now also reports real DELETE/UPDATE `changes`).
- Removed the auto-setup calls from the storefront login modal (`public/index.html`) and the admin login page (`public/admin.html`).

### ✅ H1 — Public order PII leak (FIXED) — `routes/orders.js`
`GET /api/orders/:orderNumber` now requires `?phone=` matching the order phone (same last-10-digit normalization as `/track`); missing phone → 401, wrong phone → 404, and the response is the same sanitized payload `/track` returns (no email/address/notes). Admin routes (`GET /api/orders`, CSV export) unchanged.

### ✅ H2 — Vercel-without-Turso silent data loss (FIXED) — `database.js`
Without `TURSO_DATABASE_URL` on Vercel, DB init now **throws FATAL**; `server.js` exits 1 locally and the serverless entry returns **503** with the reason instead of serving the lossy in-memory store. Also fixed while there: mem-store `DELETE` always reported `changes: 0`, and Turso/sql.js `run()` now return `changes` (rowsAffected / getRowsModified) — required by the atomic stock decrement below.

### ✅ H3 — Emails may never send on serverless (FIXED) — `routes/orders.js`
Order-confirmation and status-update emails are now **awaited before `res.json()`** (wrapped in try/catch so a mail outage can't fail the request).

### ✅ H4 — Dependencies & upload filter (FIXED)
- `npm audit fix` → **0 vulnerabilities** (qs/body-parser/express chain resolved).
- **multer 1.4.5-lts.1 → 2.4.0**.
- `/api/upload` now has the same JPEG/PNG/GIF/WebP/SVG `fileFilter` as the product routes (previously accepted any file type).

### ✅ M1 — trust proxy — `server.js`
`app.set('trust proxy', 1)` so express-rate-limit sees real client IPs behind Vercel (the 120/min global limit can no longer knock out the whole site).

### ✅ M2 — Atomic stock decrement (FIXED) — `routes/orders.js`
Stock is now decremented with `UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?`; if the guarded update matches 0 rows, the order row is deleted and the customer gets a 400. No more oversell race.

### ✅ M3 — Dead inline session cookies removed — `routes/auth.js`
The manual `Set-Cookie: kage.session/kage.cust` blocks (admin login, customer signup/login) are gone; sessions rely solely on cookie-session's signed pair. A 2026-10-12 follow-up removed the unused `kage.cust` auth fallback and clear code; only `req.session` populated by cookie-session carries identity now.

### ✅ M4 — CSP cleanup — `server.js`
Removed unused `https://unpkg.com` from `scriptSrc` and dropped `scriptSrcAttr 'unsafe-inline'`. Also removed the dead Phosphor icons `<script>` tag from `index.html` (zero `ph-*` classes used) — one less third-party supply-chain surface.

### ✅ M5 — Generic 500s (FIXED) — all routes
Every `catch` now logs details server-side (`console.error`) and returns a generic message; the health check no longer echoes `err.message`.

### ✅ M6 — XSS escapes + keyboard a11y (FIXED) — `public/index.html`, `public/admin.html`
`esc()` applied to: gallery images & thumbnails, cart & checkout item images, wishlist drawer (name/fit/img, and removed the product-name-in-onclick injection vector), spirit selector/editorial/result images, hero tiles, collection tiles, admin product previews. Product cards/collection tiles/thumbnails got `role`/`tabindex`/`aria-label` + Enter/Space handlers; gallery dots are real `<button>`s with delegated click handling; quick-view buttons are focus-visible.

### ✅ M7 — Static caching — `server.js`
Original audit result: immutable-ish assets (`images/`, fonts, icons) cached for one year and HTML stayed no-store. The 2026-10-12 follow-up now gives ordinary static assets and `/uploads` one-day public caching with revalidation, keeps HTML no-store, and reserves one-year immutable caching for `/vendor`.

### ✅ L1 — Repo debris deleted
Removed: `.tmp-final-1786883984768/`, `.tmp-final-clean.js`, `.tmp-rewrite-spirit.js`, `screenshot-scroll.mjs`, `screenshot-ref.mjs`, `screenshot-phase2-debug.mjs`.

### ✅ L3 — database.js header comment corrected
No longer claims `kage.db` file persistence; documents that local sql.js is in-memory and resets on exit.

### ✅ L4 — Single canonical admin entry — `server.js`
`/admin.html` → 301 → `/admin` (redirect runs before the static middleware). `admin.html` is the login page, so it stays public by design; the APIs behind it are the protection.

### ✅ L5 — manifest theme_color
`#0D0D0D` → `#D9D4C8` (matches the site's warm light theme).

### ✅ L6 — SEO/a11y
Keyboard/AT access fixed (see M6). The 2026-10-12 follow-up replaced the hard-coded crawler files with dynamic `/sitemap.xml` and `/robots.txt` endpoints derived from `SITE_URL` (or the request origin fallback); canonical, Open Graph and JSON-LD site URLs use the same configuration.

**SEO-2 — dynamic sitemap (2026-10-14):** `/sitemap.xml` now includes the homepage and public content/policy/contact/tracking pages (including Custom Stickers), product detail URLs for every listed product (including sold-out items), and only collection/category routes backed by products (including `all`, `new`, and an active `sale` route). Product entries carry a normalized `<lastmod>` from `products.updated_at`; entries have explicit change frequency and priority. `SITEMAP_CACHE_MS` is ten minutes and drives both in-process product-data caching (with concurrent-request coalescing) and public `max-age`/`s-maxage` headers. The product read is a single narrow query. Empty or failed databases still return all static URLs; the Vercel readiness gate allows sitemap/robots requests to reach those fallbacks. `robots.txt` references the sitemap and disallows `/admin` and `/api`.

**Verification:** `PORT=3999 npm test` passes all six suites. E2E checks strictly parse the XML, require a seeded product and sold-out product URL, verify product `<lastmod>`, collection and static URLs, no private/admin URLs or unescaped XML ampersands, and the 10-minute cache header. A serverless DB-outage fixture confirms sitemap and robots still return static content.

**SEO-1 / SEO-4 / SEO-3 — server-rendered metadata and structured data (2026-10-15):** Product and collection routes now render route-specific titles, ~155-character descriptions, canonical URLs, Open Graph and Twitter metadata with absolute product-front/collection imagery. Product metadata and JSON-LD use the explicit public product shape; Product offers report PKR and stock-aware `InStock`/`OutOfStock`, and approved reviews alone contribute aggregate/review schema. Organization JSON-LD is preserved, WebSite JSON-LD is present, and product/collection pages add BreadcrumbList data. Dynamic JSON-LD encodes `<` as the JSON Unicode escape for U+003C; untrusted metadata content is HTML-escaped. A missing numeric product lookup returns the SPA shell with HTTP 404; homepage tags remain unchanged, and SPA product/collection title updates match server titles.

**Verification:** `PORT=3999 npm test` passes all six suites. E2E validates product/collection metadata, valid JSON-LD, hostile product/review strings, approved-only rating data, sold-out availability, omitted admin fields, missing-product 404, and unchanged homepage tags; frontend tests pin client-side title parity.

### ✅ L7 — Regression tests added — `tests/e2e.test.js`
Framework-free (`node tests/e2e.test.js`), boots the real app on an ephemeral port with the in-memory fallback. **14/14 passing**: auth-middleware regression suite (valid/forged/tampered/no-cookie/customer-on-admin-route), admin setup gating, order PII phone-gate (401/404/200-sanitized), `/track`, stock decrement 4→3 + over-stock 400, CSRF on admin mutation.

### Verification summary (this session)
- `node tests/e2e.test.js` → **14/14 passed** (twice, after each refactor).
- `node --check` on all JS files → clean.
- Live boot on :3999 → storefront 200, `/admin.html` 301→`/admin`, `/admin` 200, health ok, images `cache-control: public, max-age=31536000`.
- `VERCEL=1` without Turso → FATAL boot error, exit 1; `db.init()` rejects.
- `npm audit --omit=dev` → 0 vulnerabilities.

### ⚠️ Deployment notes
- Set `ALLOW_ADMIN_SETUP=true` **once** on a fresh DB to create the first admin, then remove it.
- `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are now **hard requirements** on Vercel — deploys without them will 503 by design.

### ✅ Production deployed — 2026-09-23
- **Vercel project:** `kage-culture` (team `daw00d`, `prj_EfYzamAT9c0sM6dFm7f3mpwc0HN4`) — was already git-linked to `Dawood14210/kage-culture`; framework `express`, Node 24.x.
- **Production URL:** `https://kage-culture-ruby.vercel.app` (NOTE: `kage-culture.vercel.app` belongs to an older project on a *different* Vercel team — candidates for deletion to avoid confusion).
- **Deploy:** commit `33a27e2` via API — READY. Env vars upserted: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, fresh `SESSION_SECRET` (48-byte random), `ALLOW_ADMIN_SETUP=true` (until first admin is created), `AUTO_CREATE_ADMIN=false` (old backdoor closed).
- **Turso:** `kage-dawood14210` (aws-ap-south-1) — schema created, seeded 20 products, verified live (`SELECT 1` ok, products API serves from cloud DB).
- **Live checks passed:** storefront 200 (one transient 503 on the very first cold hit), health ok, setup gate open (400 not 403), order PII phone-gate 401, vendor Chart.js 200, `/reset-password` shell present, `/admin.html` 301 → `/admin`.

### 🔴 Prod incident (same day) — CSP `script-src-attr` omission made the site unclickable
The M4 CSP cleanup removed `scriptSrcAttr: ["'unsafe-inline'"]`; helmet then defaulted to
`script-src-attr 'none'`, silently blocking **every inline `onclick`/`onkeydown`** — pages
rendered but nothing was clickable. Shipped in `33a27e2`, caught by the user within the hour,
fixed in `3e7ee39` (directive restored, with a comment in `server.js` explaining it must stay
until FE-H2's event-delegation work lands). Verified live: header now includes
`script-src-attr 'unsafe-inline'`.
- **Deploy-author lesson:** Hobby teams reject Git-triggered deploys whose commit author is not
  a team member (the `4d4211c` build sat BLOCKED for this). Repo-local git identity is now
  `Dawood14210 <160178068+Dawood14210@users.noreply.github.com>` — keep using it for commits.
- The original "CSP clean (no script-src-attr)" check above **read the bug as a pass** — header
  changes must be compared against expected values, not just the absence of old ones.

### ✅ Production smoke test — 2026-09-23 (customer flows, after CSP fix)
- **Browse:** `/` 200 (330 KB), `/api/products` 200 (20 products), all key assets 200
  (hero images, mp4, `/vendor/chart.umd.min.js`, manifest, sitemap, `/reset-password`, `/admin`).
- **Checkout:** CSRF bootstrap → `POST /api/orders` 201 → `KAGE-3LRV34YB` (COD, Cheese God ×1,
  total 400 = 250 sale price + 150 shipping), status `pending`, stock decremented 10 → 9 atomically.
- **Tracking:** `/api/orders/track` good phone 200 (**sanitized payload — no email/address**);
  no phone 400; wrong phone 404; `/api/orders/:num` 401 without phone / 404 wrong phone
  (H1 verified live).
- **Cleanup:** test order marked **cancelled**, stock restored 10/10 (done at DB layer,
  replicating the cancel route's logic).
- **Observation:** admin API login 401'd during cleanup — the admin password no longer matches
  the bootstrap value. Most likely the owner changed it (recommended, since it passed through
  chat). **If the owner did NOT change it, rotate immediately** and treat it as a compromise.
- **Hardening candidate (low):** login routes are CSRF-exempt (no session yet) — fine, but adding
  `requireCsrf` to admin/customer login would also harden against login-CSRF phishing. Next pass.

---

## Frontend audit — 2026-09-23 (storefront + admin panel)

> Scope: `public/index.html` (7,033 lines) and `public/admin.html` read end-to-end;
> every client `fetch()` cross-checked against the routes that actually exist; rendering
> sinks, event wiring, forms, a11y, PWA/SEO files reviewed. **Static analysis only — no
> browser session**, runtime rendering was not visually verified. Line numbers refer to
> the files as of this audit and will drift after fixes.
>
> Already confirmed healthy (no action): CSRF fetch monkey-patch on both pages;
> no `eval`/`document.write`/`new Function`; no `innerHTML` of raw query params;
> storefront no longer auto-calls `/api/admin/setup` (comment at `index.html:6618`);
> `esc()` coverage is good everywhere except FE-H1 below; skip-link, aria-labels,
> real `<button>` gallery dots, keyboard handlers on collection cards, and the
> reduced-motion query are all in place.

### 🔴 FE-C — Functional bugs (user-facing breakage)

**FE-C1. Home/related/recently-viewed/wishlist product cards open a stale product page**
`public/index.html:5867, 5883` — `renderHomeProductCard` builds cards with
`onclick="navigateTo('product', ${p.id})"`, but `navigateTo()` (`index.html:4934`)
**ignores the id** for the `product` page. Only `openProductDetail(id)` (6149) populates
name/price/gallery, so clicking any homepage, related, recently-viewed or wishlist-drawer
card shows the *previously viewed* product (or a blank one). The collection grid does it
correctly (5684). → Route these cards through `openProductDetail(${p.id})`.

**FE-C2. Customer account features call endpoints that don't exist**
`index.html:6655, 6834, 6859` call `GET /api/customers/me` (session restore) and
`PUT /api/customers/me` (profile save; same URL reused for password change) — **no such
routes exist** in `routes/*` (only `GET /api/customers/orders`, `routes/orders.js:185`).
Consequences: after any reload a logged-in customer appears logged out; "Save Changes"
and the password change on the account page always fail. → Add the routes
(`requireCsrf` + `requireCustomerAuth`) or remove/repurpose the UI.

**FE-C3. Chart.js blocked by CSP — admin Reports chart never renders**
`admin.html` (~1236) loads `https://cdn.jsdelivr.net/npm/chart.js@4.4.1`, but `scriptSrc`
(`server.js:36`) allows only `'self'`, `'unsafe-inline'`, `fonts.googleapis.com`. jsdelivr
is whitelisted for *styles/fonts* but not scripts, so the PnL chart is silently dead in
production. → Add the CDN to `scriptSrc` or (better) self-host `chart.umd.min.js`.

**FE-C4. Password reset dead-ends**
`routes/auth.js:119` emails links to `/reset-password?token=…&type=…`, but there is **no
reset UI anywhere**: no `page-reset-*` view in index.html, zero `URLSearchParams` usage,
and the catch-all route serves the home shell. Users cannot complete resets. → Build a
reset view that reads `token`/`type` and POSTs to `/api/auth/reset-password`.

### 🟠 FE-H — Security hardening

**FE-H1. Unescaped attribute interpolation in the collection grid (gap vs M6)**
`index.html:5684-5685` — `src="${front}"` and `data-src="${back}"` skip `esc()`. M6 fixed
these exact patterns everywhere else (gallery, cart, checkout, wishlist, spirit images)
but missed the two here. Admin-controlled input today; same stored-XSS pattern. →
Wrap with `esc()`.

**FE-H2. CSP relies on `'unsafe-inline'` for scripts**
`server.js:36` — unavoidable while both pages use hundreds of inline `onclick` handlers,
but it largely negates XSS protection. Long-term: delegate events (gallery dots and the
filter panel already do), then drop the directive and nonce what remains.

> ⚠️ **Incident 2026-09-23:** dropping `scriptSrcAttr` from the helmet config *instead of*
> migrating handlers first defaulted it to `'none'` and made production unclickable.
> The directive must stay until every inline handler is replaced by delegated listeners.

### 🟡 FE-M — UX / quality

- **FE-M1. No URL routing or history** — "pages" never touch `pushState`; browser Back
  exits the site, products can't be deep-linked, and every unknown path serves the home
  shell with no 404. At the time, this also left the sitemap at `/` only and canonical/OG
  tags hardcoded to the vercel.app domain; routing and crawler coverage were fixed later
  (see FE-M1 completion and L6 / SEO-2).
- **FE-M2. Cart & wishlist are memory-only** — a refresh loses both (only recently-viewed
  persists, via `kageRv` localStorage). Persisting the cart is cheap and high-value.
- **FE-M3. `renderCheckout()` stacks listeners** — attaches a new `change` listener to
  the payment radios on every render (`index.html:5012-5018`). Move to one-time
  delegation (the filter panel already does this correctly).
- **FE-M4. Cart badge never bumps** — `addToCart` animates `document.querySelector('.badge')`
  (~6470), the first `.badge` in the DOM, which is the mobile *wishlist* badge — not a
  cart badge at all.
- **FE-M5. Accessibility gaps** — topbar/nav/footer links, category tiles and spirit
  cards are `<a onclick>`/`<div onclick>` with no `href`/`tabindex` (3735-3759, 3824-3840,
  5443); the star-rating input is span-only; `admin.html:5` sets `user-scalable=no`;
  only the admin sign-in overlay (since removed — see `PROJECT_LOG.md` §19) handled Escape;
  the customer login, wishlist drawer and most
  other overlays don't, and none trap focus.
- **FE-M6. Typography below legibility** — topbar at `0.4rem` (≈6px), logo wordmark 7px,
  "CULTURE" at 3.5px. Intentional micro-branding, but "CULTURE" is effectively invisible.
- **FE-M7. Silent failure state** — `loadProductsFromAPI` swallows errors (`catch(e){}`),
  leaving the hardcoded fallback catalog with no offline banner; users can add fallback
  items to a cart that can never be ordered.
- **FE-M8. Minor** — manifest `background_color` still dark `#0D0D0D` vs the fixed
  `theme_color` (residual L5); `Rs. ${n}` totals unformatted while `fmt()` exists;
  confirmation page re-triggers the spin popup on every render; 9.3 MB of hero videos
  bundled into the lambda via `vercel.json` (overlaps L2).

### ✅ Wishlist heart UX — 2026-09-25 (red fill + pop animation)
Not from the audit queue — user-requested polish. Two changes in `public/index.html`:
- **Red heart (previous turn):** favoriting turned the heart brand-brown because the
  active rules used `--accent`. Added `--heart-red: #DC2626` and applied it to
  `.wishlist-icon.active` and `.product-grid .product-wishlist.active` (incl. border);
  SVG fill follows via `currentColor`. Hover on `.wishlist-icon` intentionally still
  uses `--accent`.
- **Pop animation (this turn):** new `@keyframes heart-pop` (scale 0.6 → 1.35 → 0.9 → 1,
  0.35s ease-out) applied to the **SVG only** (`.wishlist-icon.pop svg, .product-wishlist.pop
  svg`) so the round button background stays put. Gated behind a `.pop` class that
  `toggleWishlist` adds only when **saving** — never when unsaving or on grid re-renders —
  with a `void el.offsetWidth` reflow restart so rapid re-saves re-pop. Reduced-motion
  users are covered by the existing global `prefers-reduced-motion` kill-switch.
- **Verification:** suite item 12 added (`heart-pop` keyframe, `.pop` gating, save-only
  trigger) — **27/27 passed**.
- **Docs:** AGENTS.md status snapshot updated to 27/27; FE-M2 note added below.

### ✅ Topbar marquee + nav  button — 2026-09-25 (user request)
- **Removed** the `Track Order` / `Help` links from the top utility bar (`.topbar-links`
  markup + its CSS deleted). `Help` never pointed anywhere useful (it navigated home);
  the tracking page itself is untouched and still reachable.
- **New Track Order nav button** (no emoji — a wifi/signal-line SVG in the same stroke
  style as the other nav icons): desktop `nav-icons` cluster + mobile `mobile-icons-row`,
  both `navigateTo('tracking')` (mobile also `closeMenu()`), `aria-label="Track Order"`.
  The mobile dropdown's text link stays. Footer/confirmation links unchanged.
- **Infinite welcome marquee:** the olive band now loops `ようこそ Welcome to KAGE
  Culture` forever. Two identical `.topbar-group`s in a `max-content` track animating
  `translateX(0 → -50%)` (28s linear) — the loop point is invisible because group N's
  tail (including its `·` separator) matches group N+1's head. A tiny boot script
  clones items into both groups when one group would be narrower than the viewport
  (ultra-wide seamlessness), and `prefers-reduced-motion` freezes the track. Kept
  inside `<header>` so the sticky header is unaffected; `.topbar` keeps its olive
  band styling.
- **Verification:** 27/27 suite + live boot on :4123 — shell 200, marquee items served,
  0 `topbar-links` remnants, 2 `aria-label="Track Order"` buttons, health ok.
- **Track icon artwork (later, same day):** user supplied a circular aviation-badge
  logo (gstatic thumbnail, 260×280 JPEG) to use as the Track Order icon. Edited it to
  fit the 24px-icon system with ImageMagick: chopped the watermark strip (bottom
  30px), grayscale + 62% threshold, `morphology Close disk:2` to heal JPEG mush,
  white → transparent, trim, resize x36, center-padded to 40×40, tinted `#3D3931`
  (the nav icon color). Saved as `public/images/track-order.png` (1.1 KB); both nav
  buttons now use `<img width=22 height=22>` + `.nav-icon img { display:block }`.
  Verified: asset 200 `image/png` with the M7 1-year cache rule, 2 shell refs,
  27/27 tests. Note: fixed color (unlike `currentColor` SVGs), so it won't shift
  hue on hover; icon is cached by URL — rename the file if the artwork changes.

### ✅ Track-your-order page fixed — 2026-09-25 (user request)
Found and fixed four client-side bugs in `public/index.html` (the API itself was
sound — phone-gated, sanitized, verified in the earlier prod smoke):
1. **Submit button bricked after any failed lookup** — `trackOrder`'s early
   `return` on `!res.ok` skipped the re-enable, so one wrong phone number
   disabled the Track button until a full page reload. Now re-enabled in a
   `finally`; stale results are also hidden on error so a previous order's
   details can't linger next to an error message.
2. **Cancelled orders rendered an active "Pending" timeline** —
   `steps.indexOf('cancelled')` → −1 → clamped to 0 → green checkmark on a
   dead order. Cancelled now renders a terminal state: red **Cancelled**
   badge (new `.track-status-cancelled` rule), placed-date/total/items, and a
   refund-questions help line — no timeline.
3. **`awaiting_verification` (every JazzCash/bank order) showed as
   "Pending" forever** — mapped to the **Confirmed** step (index 1) with a
   "we're verifying your payment…" explainer; status badge now uses a
   `TRACK_STATUS_LABELS` map (humanized labels for all six backend statuses).
4. **Raw DB timestamp shown** — "2026-09-25 09:41:12" UTC. New
   `formatTrackDate()` renders "25 Sep 2026, 2:41 pm" in the visitor's local
   time (DB times are UTC ISO with a T→space swap; falls back to raw on parse
   failure).
- **Verification:** suite item 13 added (finally-guard present; cancelled →
  `.track-status-cancelled`; `awaiting_verification ? 1 :` mapping; labels +
  date formatter exist) — **28/28 passed**; live boot on :4123 serves all four
  fixes in the shell.

### ✅ Responsive hardening pass — 2026-09-25 (user request)
User asked to "keep the mobile and PC views separate" → clarified as **make the site
properly responsive on both**. The site already had a solid base (breakpoints at
1024/900/768/640, stacking checkout, hamburger nav) — this pass fixed the audited gaps:

**Storefront (`public/index.html`)**
- **Track timeline overflowed phones** — 4 status labels in one flex row + horizontal
  connector line. New ≤540px block stacks it vertically (steps become rows, connector
  becomes a vertical line, first step's connector hidden).
- **Checkout on phones** — ≤540px: page padding tightened, form/summary `min-width:0`
  (grid-blowout guard), `.co-row` (expiry/CVV-style pairs) collapses to 1 column.
- **Nav dropdown rows** — the `min-height:44px` on mobile dropdown links stretched the
  icon-row/search `<li>`s to full header height on narrow screens; ≤540px now zeroes
  `li` min-height and re-applies 44px only to `li:has(.nav-icon)`.
- **Ultra-narrow phones (≤360px)** — `.nav-inner` wraps instead of overflowing; the
  micro-logo shrink is intentional branding, left alone.

**Admin (`public/admin.html`)**
- **`user-scalable=no` removed** from the viewport meta (FE-M5 item; pinch-zoom is an
  accessibility right).
- **Product/order/recent rows** assumed a ~700px 6-col grid (`60px 1fr 100px 100px
  100px auto`) — on phones they squeezed/overflowed. ≤768px: rows become wrap-friendly
  flex cards, the column-label header-row hides (meaningless once rows wrap), thumbs
  shrink to 38px, action buttons right-align, PnL summary goes single-column, filter
  search input takes full width. Deliberately **flex-wrap, not `overflow-x:auto`**:
  the order status dropdown menu is `position:absolute`, and an overflow-x container
  forces overflow-y too (CSS quirk), which would clip the open menu.
- ≤640px: tighter `.main-content` padding + smaller top-bar title.

**Verification:** suite items 14–15 added (storefront ≤540/≤360 blocks + co-row stack;
admin wrap-cards, legend hidden, no zoom lock) — **30/30 passed**; live boot on :4123 —
shell 200 with all 3 new storefront rules served, `/admin` 200 with wrap rule + zero
`user-scalable=no`, health ok. No browser/device session yet — recommend a quick
DevTools-device-mode pass on iPhone SE / 390px widths before calling it done.

---

## Frontend repair pass — 2026-10-10

- Admin product search/category now render the filtered list; order filtering/sorting retain
  fetched orders and include `awaiting_verification`. Sale prices can be cleared from the
  admin form; API validates discounts and returns the real catalog stock state.
- Storefront now filters Goofy Wears correctly, includes low-price stickers, clamps
  pagination after filters, shows real sale badges, and never offers zero-stock items.
  Catalog failures display an alert and block shopping instead of selling mock data.
  Cart/wishlist persist as IDs and quantities, then hydrate against current API prices
  and inventory (unavailable/removed products are dropped).
- Client pages/products/category listings use URLs + Back/deep-link restoration; unknown paths
  return HTTP 404. Relative media paths were made root-relative for deep links.
  Canonical/OG and password-reset defaults now point to the documented production host.
- Returns messaging now matches the 7-day policy. Checkout payment listeners and gallery
  swipe listeners no longer multiply. Cart badge animation, keyboard-operable review
  stars, navigable links, and Escape/focus management for drawers/dialogs were improved.
  Theme background, money formatting, and repeated confirmation-spin popup were fixed.
- `npm audit fix` cleared four new production dependency advisories (1 critical, 2 high,
  1 moderate). `npm test` → 38/38 API + 10/10 DOM-level scenarios; production audit → 0.
  Product-create tests cover local image persistence, missing-token and store-prefixed-token
  paths; product admin tests cover batch deletion and Quick Upload stock submission.
  Production verification is still needed.

### ✅ Browser-based responsive repair — 2026-10-10

Captured real headless Chromium renders of storefront and authenticated admin at 320,
390, 600, 768 and 1440 CSS px. Fixed defects that DOM-only tests had missed:

- Storefront mobile CSS hid `.nav-icons` including its hamburger, making all navigation
  unreachable. Keep the hamburger plus cart/wishlist visible, enlarge their touch targets,
  track `aria-expanded`, allow Escape to dismiss, and constrain the dropdown height on
  short screens. Header wordmark lettering is now readable at phone sizes.
- Filter, cart and wishlist drawers were positioned offscreen by fixed desktop offsets;
  at ≤768px their `width:100%` exceeded the offset and covered the page even while
  closed. Translate by their own width instead. Verified closed rects start at the
  viewport edge, while opened drawers occupy the viewport at 320/390/768px.
- Admin had an extra closing `</div>` that put its tab content outside `.main-content`;
  authenticated Products/Orders/Reports displayed beside the header in a narrow column.
  Fixed nesting and made `.main-wrapper` grow to fill the desktop flex row. Phones now
  get a section selector plus password/logout controls instead of a hidden-only sidebar.
- Fixed white-on-white admin labels (product names/prices, upload prompts, P&L headings),
  a stray CSS brace, and the 320px Reports period buttons that forced horizontal overflow.
- Chromium checks of the authenticated dashboard and all major tabs at 320, 390, 768 and
  1440px now show document width matching viewport. Storefront menu, Escape, cart and
  filter interactions were exercised at 320/390/768px; `npm test` passes 33/33 API
  and 8/8 DOM scenarios. Production and physical-device QA remain separate.

Still open: **FE-H2** (remove inline handlers and `'unsafe-inline'` together — removing
only the CSP allowance breaks all clicks), remaining keyboard polish for dynamically
rendered non-native controls, and L2 video cold-start optimization. Do not mark these
done without a browser/CSP migration.

> Update 2026-10-19: FE-H2's handler migration is done including the
> browser/CSP proof (scenario 37, `script-src-attr 'none'` live) — only the
> `script-src` remainder (inline `<script>` blocks) still waits on PERF-1.
> Keyboard polish for dynamic controls shipped with it (`data-key`
> delegation). L2 still open, re-scoped below.

---

### ✅ Review star-picker regression — 2026-10-11

The picker highlighted every star through the chosen rating, but submit read the
*first* highlighted button, silently posting 1 star for every selection. Submit now
reads the uniquely `aria-pressed="true"` button. Draft ratings clear when switching
products; focused stars have a visible outline. Frontend tests click and submit all
five ratings and verify the actual payload/reset. API tests verify delivered-order
and phone/product checks, duplicate rejection, pending moderation, admin approval,
and the public review/product-average result. `npm test` → 53/53 API + 12/12 DOM scenarios.

### ✅ Product-card alignment (Quick View / Add to Cart) — 2026-10-11

Cards in a grid row were already stretched to equal height, but each card's *body* only
grew to fit its own content, so a product with reviews (an extra star row), a sale price,
or an empty fit label pushed its button lower than its neighbours'. With a single product
that never showed; adding a second one put two cards side by side and the Quick View
buttons sat up to 46px apart. Cards are now flex columns, the body fills the remaining
height (`flex: 1 1 auto`), and the button is pinned with `margin-top: auto` while the
price keeps a 12px minimum gap above it. The rating markup is wrapped in `.card-rating`,
which reserves its line even when a product has no reviews yet, so titles and prices line
up as well. Verified in headless Chromium at 360/390/412/768/1024/1440px against seeded,
mixed, all-reviewed and no-review catalogs — every row aligned, no horizontal overflow
(rows were misaligned in all of those cases before the change). `npm test` → 57/57 API +
15/15 DOM scenarios; the new frontend scenario asserts the reserved rating row and the
pinned button.

### ✅ Homepage category cards refreshed + Graphic Tees / Pants added — 2026-10-11

The dark olive category band now carries four cards in the order Anime Shirts,
Graphic Tees, Custom Stickers, Pants, each keeping the existing `.cat-tile`
structure (circle thumb + name + description + Explore link). Images moved to
`anime-shirts.jpg`, `graphic-tees.jpg`, `custom-stickers.jpg` and `pants.jpg`
(the old `cat-*.jpg` files were removed in the 2026-10-12 unused-asset cleanup). Layout: a single column below
800px (stacked row cards, 96px circles) and a 2x2 grid from 800px up — the
`max-width: 768px` and `min-width: 769px` breakpoints moved to 799px/800px, and
the base strip is `1fr` so four cards can never fall into a 3+1 orphan row.
Verified in headless Chromium at 320/360/390/412/430/480/600/768/799/800/900/
1023/1024/1200/1440/1920px: correct column count, no horizontal overflow, no
text/image overlap, circles stay square at 96/140/170px. `npm test` → 57/57 API
+ 16/16 DOM scenarios (new scenario pins the card order, image paths, links and
the 800px breakpoint). **Open:** the Pants card has no category of its own yet —
its Explore link points at `/collection/all` as a placeholder; Graphic Tees
routes to `/collection/graphic-tees`, which intentionally shows Coming Soon.

### ✅ Responsive gutters for policy/contact pages — 2026-10-11

Returns, Shipping, Terms, Privacy and Contact now share `.content-page`. The shared
layout keeps the original top offset, bottom padding, 720px maximum width and centering,
with 16px inline padding below 600px and 20px from 600px up. The repeated policy copy,
heading, back-link and Contact text styles moved into scoped classes without changing
their declarations. Track Order remains on its existing `.tracking-page` layout.

`tests/frontend.test.js` verifies all five page classes, the responsive gutter/box-model
contract at 360, 414, 768 and 1440px, and that Track Order remains outside the new styles.
`npm test` → 57/57 API + 17/17 frontend scenarios. A Chromium screenshot check could not
launch in this sandbox because system `libnspr4.so`, `libnss3.so` and `libnssutil3.so` are
missing; the requested-width check is therefore CSS-contract/geometry testing, not a
browser-rendered visual comparison.

### ✅ Mobile navigation menu — 2026-10-11

The public navigation is ordered Home, Anime Shirts, Graphic Tees, Pants, Custom Stickers,
About, Contact and Track Order. Category links mirror the homepage cards (Graphic Tees
uses `/collection/graphic-tees`; Pants temporarily uses `/collection/all`). Removed the
Admin item and originally kept the storefront admin sign-in modal as well as the existing
`/admin` login entry; that storefront modal was later deleted as dead code (nothing ever
opened it) — see `PROJECT_LOG.md` §19. Header Wishlist, Account and Cart remain visible on mobile; the menu’s icon
row now contains only Track Order.

The hamburger SVG animates into an X and updates `aria-expanded`. The open menu is an
opaque, bounded panel; opening it locks body scrolling and closing restores the previous
inline overflow value. It closes on menu-link click, Escape and outside pointer/tap.
Desktop horizontal-nav rules and the desktop-only hiding of mobile rows remain intact.

`tests/frontend.test.js` checks category route parity, admin entry points, menu state,
scroll restoration and CSS breakpoint contracts at 360, 414, 768 and 1440px. `npm test`
→ 57/57 API + 17/17 frontend scenarios. Viewport assertions are CSS/DOM contract tests,
not browser-rendered screenshots (Chromium is unavailable in this sandbox due to missing
NSPR/NSS system libraries).

### ✅ Shared footer polish — 2026-10-11

The footer is one global, body-level component outside the route-specific `.page` views;
renamed its stale "Footer (home)" comment and kept this single copy shared across Returns,
Shipping, Terms, Privacy, Contact and Track Order. Privacy and Terms now have a visible
middle-dot separator and 44px minimum-height link targets. Social glyphs use one olive
accent treatment with a subtle focus/hover tint; the Etsy text glyph is replaced by its
SVG mark and Snapchat uses the recognizable ghost silhouette. Existing social
`aria-label`s are unchanged.

Fixed the 481–768px padding override that could reduce the footer clearance below the
mobile WhatsApp button's footprint. Footer bottom padding now reserves the mobile button,
its 20px viewport offset, 16px gap and safe-area inset through 768px; wider layouts reserve
the 60px button, 24px offset and 16px gap. `tests/frontend.test.js` verifies the single
footer across routes, social/accessibility markup, separators/tap targets, horizontal-fit
and WhatsApp-clearance CSS/geometry contracts at 360, 414, 768 and 1440px. `npm test` →
57/57 API + 17/17 frontend scenarios. These are DOM/CSS contract checks rather than
browser-rendered screenshots; Chromium cannot launch in this sandbox because NSPR/NSS
system libraries are missing.

### ✅ Contact cards and Track Order mobile action — 2026-10-11

Replaced the Contact page’s WhatsApp, support and Instagram emojis with matching theme-colored
inline SVGs; added an Email icon/card linking to `mailto:kageculture01@gmail.com`. Contact
Instagram now links to the existing footer URL and displays `@kage__culture` in both places;
the JSON-LD `sameAs` value was synchronized to that URL as well. The repo cannot confirm
whether the Instagram account itself is the intended one, so owner verification is still
needed. Order Support’s primary link now routes to `/tracking`, with its existing WhatsApp
route retained as the secondary “or message us on WhatsApp” action.

All four cards share equal grid rows, style, hover treatment and a visible keyboard-focus
outline. A Working hours line deliberately remains `TODO — [hours not provided]`; no hours
were inferred. The Track Order button stretches to the form width through 768px while its
desktop `align-self:flex-start` styling remains unchanged.

`tests/frontend.test.js` verifies card/link destinations, handle parity, SVG presence, TODO,
focus/size CSS contracts and responsive widths at 360, 414, 768 and 1440px. `npm test` →
57/57 API + 17/17 frontend scenarios. Viewport tests are DOM/CSS geometry contracts, not
browser screenshots; Chromium cannot launch here because NSPR/NSS system libraries are
missing.

### ✅ Shipping, returns, and policy copy — 2026-10-11

Shipping now lists Bank Transfer with the same post-order account-details wording as
checkout, and a Delivery Charges section shows the configured flat fee of Rs. 150. No
free-shipping threshold exists in `config.js` or checkout, so the page marks that detail
as a TODO for owner confirmation. JazzCash account references are clearly labeled and
all displayed phone numbers use `+92 322 804 2633`; WhatsApp URLs retain the normalized
`wa.me/923228042633` digits. Owner confirmation is still needed on whether the JazzCash
account number is also the WhatsApp number.

Returns now explicitly exclude custom-designed items and custom stickers unless defective
or wrong; the existing 7-day return window and 48-hour defective/wrong-item window remain
unchanged. Terms, Privacy, Returns and Shipping all use the `Policy` eyebrow label.
`tests/frontend.test.js` covers these copy, fee/config, number/link and label contracts.
`npm test` → 57/57 API + 17/17 frontend scenarios. These are DOM/CSS assertions, not
rendered screenshots; Chromium cannot launch here because NSPR/NSS system libraries are
missing.

### ✅ COD-only storefront + post-order delivery charge confirmation — 2026-10-11

The customer-facing checkout, footer, product shipping tab, Shipping policy and Terms show
only Cash on Delivery; checkout submits `payment_method: 'cod'` and no longer renders
non-COD radios or payment-reference controls. Historical/admin payment handling and refund
instructions remain intact.

Per the owner's direction, delivery charges are confirmed with customers after order
placement instead of adding an unconfirmed flat fee. Checkout shows “To be confirmed” and
an items subtotal; the order API stores `shipping = 0`, `total = subtotal`, and a new
`shipping_pending` flag. Confirmation UI, email and tracking all explain the pending charge;
the admin orders list and CSV mark it pending. Existing orders retain their stored shipping
amounts, and Turso gets a safe schema migration for the new flag. The Shipping page says
we will contact customers about delivery charges. The free-shipping-threshold TODO remains
unresolved. `npm test` → 57/57 API + 17/17 frontend scenarios.

### ✅ Privacy & Terms policy copy — 2026-10-11

`public/index.html` now dates the Terms and Privacy pages October 2026. Terms refer to
“this website,” state that Pakistan law governs, and link the custom-designed/custom-sticker
exception (returnable only if defective or wrong) to the Returns page. Both pages carry a
short legal-review disclaimer.

The Privacy page now covers order and customer-account data (including hashed account
passwords), newsletter/product-notification signups, requested courier-partner sharing,
and the cookies verified in the app: `kage.session` for customer/admin sessions and
`kage.csrf` for CSRF protection. It no longer says information is used “solely” for order
fulfillment, and retains the no-sale statement.

Implementation check: `/api/newsletter` stores subscriber emails; there is no newsletter
campaign sender or unsubscribe endpoint/UI. The policy offers WhatsApp as a manual removal
request path and discloses that self-service unsubscribe is not available. The app uses `kage.session`, signed and verified by cookie-session before it populates `req.session`; auth middleware no longer decodes raw cookie payloads, and the legacy `kage.cust` fallback is removed. No automated courier API/integration was found in this repo; the delivery partner clause reflects the requested operational disclosure.

`tests/frontend.test.js` covers these policy details. `npm test` → 57/57 API + 17/17
frontend scenarios passed.

## Follow-up hardening — 2026-10-12

- Ordinary static assets and uploads use one-day public caching with revalidation;
  HTML is no-store, while `/vendor` retains version-pinned one-year immutable caching.
  Numeric `/api/products/<digits>` reads get the public API policy; admin/customer
  APIs are no-store.
  **Updated 2026-10-12 (later session):** the earlier caveat — “a first uncookied
  public API GET still sets the CSRF cookie” — is gone. `kage.csrf` is now issued
  only on responses a shared cache will not store (HTML pages, the no-store
  `GET /api/csrf`, other dynamic routes); `/api/products`, `/api/products/:id` and
  `/api/reviews` never send `Set-Cookie`, with or without an existing cookie, so an
  edge cache can never replay one visitor's cookie to another. The middleware
  decides at header-flush time from the response's own `Cache-Control`, so any
  future route that opts into `public`/`s-maxage` is covered automatically.
  Clients with no cookie ask the no-store `GET /api/csrf` for a token before their
  first state-changing request (storefront/admin fetch wrappers do this).
- Product and standalone upload filters accept raster image extensions/MIME types
  only; SVG remains available as an existing public logo/asset, not as an upload.
- Auth middleware now reads identity exclusively from signed `req.session` state.
  The manual signed-cookie fallback and dead `kage.cust` fallback/helpers are gone;
  forged and detached cookie tests still return 401.
- `SITE_URL` is centralized for canonical/OG/JSON-LD tags, dynamic sitemap/robots,
  and reset/verification links. Missing production `SITE_URL` logs a warning and
  page tags fall back to request origin; reset/verification messages are not sent
  with a guessed domain. See `DEPLOY.md` and `.env.example`.
- Review GETs send `X-Viewer-Token`; a query token remains temporarily accepted
  and token-scoped responses are `private`. Sold-unit and approved-review maps
  share a 60-second cache, invalidated by order, review, and product writes.

**Verification:** `npm test` passes (116/116 E2E, shared rate-limit integration,
storefront regression, 15 upgrade-migration checks, 20/20 frontend scenarios).
Headless Chromium confirmed the hero image loads, canonical/OG and dynamic
sitemap/robots use `SITE_URL`, and a reviewer sees their own pending review
immediately after submission. The CSRF/set-cookie policy is covered by:
`/api/products`, `/api/products/1` and `/api/reviews` returning no `Set-Cookie`
(cookie-less and cookie-carrying clients), the no-store `/api/csrf` response, the
HTML page responses that still hand a fresh visitor its cookie, an API-level
cookie-less checkout, and a DOM-level fresh-browser checkout that fetches
`/api/csrf` before the order POST.

### ✅ Pants homepage card visibility and Explore label — 2026-10-12

Reproduced the reported issue in real Chromium: with an empty Pants category the
original tile revealed normally, but a stocked catalog replaced its `<span>` with
an `<a>`. The scroll-reveal observer still watched the removed node, leaving the
new clickable card at `opacity: 0`.

The Pants card is now a permanent `<a href="/collection/pants">`, with the same
visible Explore label as the other cards regardless of stock. Removed the unused
Coming-soon pill and disabled-card styles. Catalog refreshes no longer replace the
card, preserving its observer target, reveal state and keyboard focus. Empty Pants
opens the regular category grid and its existing empty state. The stock-aware
Pants navigation/footer links and the responsive category layout are unchanged.
This supersedes the older disabled-Pants-card behavior recorded in the category
strip work.

**Verification:** `npm test` passes all suites (125/125 E2E, shared rate-limit
integration, storefront regressions, upgrade migrations, 26/26 frontend scenarios).
New browser regressions at 390px and 1440px check natural scroll reveal without
forcing `.visible`, catalog refreshes through stocked/sold-out/restocked/removed
states, Explore labels, mouse/keyboard routing and empty grids. Existing real-browser
category alignment checks pass at 320/360/414/599/768/1440px. `git diff --check` is clean.

### ✅ Category cards without scroll-reveal — 2026-10-12

Removed the `reveal` class from all four homepage category cards (Graphic Tees,
Anime Shirts, Pants and Custom Stickers). They now render immediately without
waiting for a scroll observer or fading/sliding into place. Hover effects,
Explore links, stock-aware Pants navigation and responsive layouts are unchanged;
other sections retain their existing scroll animations.

Updated the DOM/browser regressions to assert that category cards never use
scroll-reveal classes and are fully opaque before scrolling at 390px and 1440px,
including catalog stock changes. The geometry helper no longer forces a `visible`
class onto category cards. `node tests/storefront-regressions.test.js` and
`node tests/frontend.test.js` pass (26/26 frontend scenarios, including real-browser
alignment checks at 320/360/414/599/768/1440px). `git diff --check` is clean.

### ✅ Admin product/order tables de-jumbled — 2026-10-12

The admin panel's tables shared one `auto`-terminated grid template
(`28px 54px minmax(120px,1fr) 90px 105px 130px auto`) across products, orders
and recent orders, which produced the jumbled layout:

- **Legend didn't line up with the data.** The trailing `auto` track resolved to
  the legend's "Actions" (~56px) in the header row and to the Edit/Delete pair
  (~108px) in every data row, so the shared `1fr` name track ended up ~45px
  narrower in the header — Price/Category/Stock labels sat 45px to the right of
  the columns they name (measured in Chromium at 1440/1160/1059px).
- **Orders shared the seven-column products template** (no checkbox/thumb, six
  cells), crushing Order/Customer/Items into each other and wrapping the order
  number onto two lines.
- **Dashboard recent orders** inherited the same template (five cells) and the
  Date cell was pushed into an unaligned second row.
- **Products overflowed the page** between 901–1024px (measured 15px at 950px,
  64px at 901px) and the top bar overflowed just above the phone breakpoint
  (9px at 901px).
- On phones the 768px block applied one card layout that was immediately
  overridden by the later responsive pass (two competing mobile layouts), and
  the order rows lost their column labels entirely when the legend hid.
- The stock cell's quantity line was centre-aligned under the toggle, reading
  as a stray floating number ("0", "7"), and the bulk toolbar's "0 selected"
  floated mid-bar.

Fixes in `public/admin.html`: one column template per table (fixed-width action
track, `minmax(0,max-content)` for order numbers), numeric right-aligned price
column, products list scrolls inside its own container at tablet widths and
becomes wrap cards ≤900px while orders/recent-orders become labelled cards
≤1060px (their `position:absolute` status menus must never sit inside an
`overflow` container), stock quantity left-aligned with the toggle and
right-aligned on cards, labelled order cards (`data-label`), the duplicate
mobile block removed, top bar wraps ≤1060px, and the "Back Image / More Photos"
fields share one row instead of leaving a dead half-row.

Verified in real Chromium at 1440/1160/1100/1060/1024/950/901/900/768/414px:
legend-vs-cell drift `0px` at every width (was up to 45px), no page overflow at
any width (was 15px at 950px / 64px at 901px), no wrapped order numbers.
`npm test` → **127/127 API + 28/28 frontend** scenarios, including a new
regression check ("admin tables keep one column template per table and collapse
safely") that fails against the previous markup.

### ✅ Favicon + app icons replaced — 2026-10-12

All icons were downscales of the full brand seal, so the brush frame filled in at
tab size (16px) and the mark read as a grey blob; `admin.html` also loaded its own
copies from `/images/` while the storefront used the root files, so the two had
drifted. Rebuilt the set from `public/images/logo/kage-icon-light.svg` (moved to `source/kage-icon-light.svg` on 2026-10-12): the 影
glyph is isolated from the frame by component analysis and scaled up inside a
brand tile, the red seal dot is kept from 32px up, small frames are supersampled
and downscaled for smooth strokes, and maskable app icons keep the mark inside the
safe zone. Deleted the duplicate `/images/favicon*` + `/images/apple-touch-icon`
files and pointed `admin.html` at the shared root set. New E2E check verifies
every declared icon (status, MIME, PNG/ICO dimensions, no duplicate paths) —
`npm test` → 128/128 API + 28/28 frontend. A cache-refresh follow-up serves
this set through `*-v2` URLs from both pages and versions the manifest, Windows
tile, and structured-data app-icon URLs too, so a browser holding the old
`/favicon.ico` or `/images/icon-192.png` can no longer mask the deployed artwork.

### ✅ Open Graph / Twitter image — absolute, sized, lightweight — 2026-10-12

Finding (no earlier entry; recorded here when fixed): `og:image` and `twitter:image`
pointed at the relative path `/images/animal-white-tiger.jpg`. Social crawlers need
an absolute URL, and the file was 3.4 MB (and PNG-encoded despite the `.jpg` name),
which is too heavy for most link-preview fetchers. Also missing: image dimensions
and alt text.

Fixed: new `public/images/og-image.jpg` (1200×630 progressive JPEG, 119,069 bytes),
cropped from `hero.jpg` (hero unchanged). `index.html` now uses
`__SITE_URL__/images/og-image.jpg` for both tags (the server substitutes the origin),
and adds `og:image:width`, `og:image:height` and `og:image:alt`.

Verified: the homepage and `/product/1` render absolute og/twitter image URLs;
the image returns 200 `image/jpeg`; `npm test` passes (128/128 API, storefront,
rate-limit, migration, 28/28 frontend).

The old `animal-white-tiger.jpg` (3.38 MB) was deleted after the owner confirmed
that no live product row or Vercel Blob object uses it. `kage-icon-light.svg`, the
favicon source artwork, moved out of the served tree to `source/kage-icon-light.svg`.

### ✅ Sold-out inventory remains visible — 2026-10-13

**Audit before changes.** Public product list/detail queries already returned
all products through the public allow-list, including `in_stock=false` and
zero-quantity products. `getFilteredProducts()` and its price/newest sorts did
not remove items based on stock, but `renderCollectionGrid()` replaced an
all-sold-out category with "No X available right now" and incorrectly reported
zero results. Coming Soon routing also tested in-stock membership, hiding an
all-sold-out sale. The shared card renderer already showed SOLD OUT and kept
cards/Quick View clickable, but did not dim images. Detail Add-to-Cart buttons
were disabled with "Out of Stock" text; quantity controls stayed enabled and
single-size explanatory copy could claim availability. Wishlist quick-add
buttons remained enabled, and cart hydration silently discarded unavailable
lines. An already-open detail/checkout could keep stale stock state on refetch.
Admin already had In Stock / Sold Out labels but no product badge or explanation
that toggling stock preserves the storefront listing.

**Fixes.** Category empty states now require an actually empty matching list;
Coming Soon tests product membership rather than purchase availability. No
stock-based filtering/sorting was added. Shared product cards use per-size-aware
availability for SOLD OUT and image-only dimming (opacity 0.65), without changing
geometry, colors, responsive breakpoints or click behavior. Detail main/sticky
buttons now read Sold Out and disable alongside quantity and size controls;
gallery/description remain intact and false low-stock urgency is suppressed.
Catalog refetches resync open detail controls, wishlist, cart and checkout.
Wishlist buttons disable/label Sold Out. Unavailable cart lines are retained,
labelled and removable; checkout entry, submission and quantity changes reject
them using the current catalog rather than stale snapshots. The admin list adds
a Sold Out badge, explicit switch action/pressed-state attributes, and short
instructions for marking sold out without deletion and restocking.

**Server/security review.** No backend route or inventory-helper changes were
needed. Product mutations keep `requireCsrf` + `requireAuth`; public product
payloads remain allow-listed. `/stock` pauses sales without erasing pooled or
per-size quantities and refuses to enable zero inventory; `/stock-qty` derives
availability from quantity and preserves the per-size edit restrictions.
Guest order placement retains its existing CSRF/rate-limit protection and
rejects sold-out items (including mixed carts) before creating/decrementing
anything. Existing atomic guarded decrements, rollback tests, backend constants
in config.js, public cache headers and ETags are unchanged.

**Verification.** New live-API cases cover pooled, untracked and per-size stock:
manual Sold Out still returns list/detail payloads without unit_cost; missing
CSRF/auth still rejects stock mutations; sold-out and mixed-cart orders return
400 with no new order or stock decrement; toggles preserve inventory, reject
zero stock, and quantity restocking restores availability. DOM tests cover
all-sold-out category/sale/search and every existing sort, direct product links,
normal gallery/description, disabled main/sticky/size/quantity controls, stock
changes on open detail/checkout, wishlist/cart unavailability across reloads,
and admin badges/switches. Real Chromium at 390px/1440px confirms the Pants grid
still shows sold-out cards and image opacity is 0.65; existing mobile/grid/header
and admin layout checks still pass. Server and suite run together in one shell:

```sh
PORT=3999 NODE_ENV=test node server.js > /tmp/kage-server.log 2>&1 & server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
PORT=3999 npm test
```

All five test files pass: **132/132 API**, shared rate-limit, storefront
regressions, upgrade migrations, **31/31 frontend** scenarios. Tests retain
their isolated ephemeral-port API servers; the standalone smoke server runs on
3999 and is stopped by the shell trap.

**Assumptions.** Sold Out is a purchase-availability state, not deletion and not
an instruction to erase existing inventory. Stock-aware Pants nav/footer
visibility is unchanged from the prior request; its Explore card/direct category
route always works, including when all Pants are sold out. Normal category,
search, size/price filters, pagination and sort semantics still apply. Deleted
products may still be removed from saved cart/wishlist state.

### ✅ Partial per-size Sold Out labels and restocking — 2026-10-13

**Follow-up bug.** The edit route summed per-size stock correctly, but retained
`in_stock=false` when a previously depleted product was restocked through the
admin form (which does not send an availability field). Thus Small could stay
at zero and Medium/Large have stock while the product remained globally Sold
Out. Zero-count size buttons were disabled but lacked visible per-size labels.

**Fix.** Product PUT now clears the automatic sold-out flag when editing moves
inventory from zero to a positive total, unless `in_stock` is explicitly supplied.
A manually paused product with existing positive inventory remains paused during
edits. Cards/detail/wishlist continue to test whether any offered size is
buyable, not Small or the currently selected size alone. Disabled size buttons
now have a visible Sold Out label directly underneath, linked with
`aria-describedby`; available sizes have no Sold Out label. No authorization,
public allow-list, stock decrement, category or layout breakpoints changed.

**Verification.** API regression creates all-zero S/M/L inventory, restocks to
S=0/M=2/L=3 via authenticated/CSRF-protected PUT and verifies public availability;
Small orders reject, Medium orders succeed, depletion marks the product Sold
Out, and explicit/manual pauses remain respected. DOM coverage verifies
S=0/L>0 keeps cards and Add-to-Cart available, selects a stocked size, labels
only unavailable sizes, and switches to product-wide Sold Out only after all
sizes empty. Real Chromium at 360px and 1440px checks that Small's label is
below its disabled button, Large stays enabled and unlabelled, Add-to-Cart stays
enabled, and there is no page overflow. Server on PORT=3999 and `PORT=3999 npm
test` run in one shell with cleanup: all five files pass (133/133 API and
31/31 frontend scenarios, plus rate-limit/storefront/migration suites).

### ✅ Targeted AUDIT_REPORT.md follow-up — 2026-10-13

**Verified before editing; scope limited to REPO-1, PERF-2, PERF-5, A11Y-5 and
CONTENT-1.** No auth/session, CSRF, seeding, secret resolution, inventory mutation,
public product allow-list or CSP changes. Existing colors, typography, category
card markup/images, layouts and responsive breakpoints remain unchanged.

- **REPO-1 — fixed.** Whole-repository recursive grep (excluding `.git`, installed
  dependencies and caches) included `server.js`, manifest, both HTML files and
  tests. Only historical docs named the legacy files; no active reference or
  explicit route depended on them. SHA-256 of both ICOs was
  `4724bf2ecfcefb9a7dc068f518dffe82ed2e4684af62eeabcf015d6f11cd7724`.
  Deleted byte-identical `public/favicon.ico` and unreferenced
  `public/favicon-48x48.png` (16,501 bytes combined). Added a pre-static
  `/favicon.ico` → 301 → `/favicon-v2.ico` route for implicit browser requests.
  E2E verifies redirect/location, final 200/MIME/identical bytes, removed files,
  legacy PNG 404, and all HTML/manifest icon URLs and dimensions.
- **PERF-2 — fixed.** Whole-repository grep confirmed Zen Brush existed only in
  the storefront Google Fonts request and historical audit text, not any CSS
  font-family declaration. Removed only `&family=Zen+Brush`; retained used
  Archivo/Noto Serif JP families, weights and `display=swap`.
- **PERF-5 — already satisfied; regression coverage added.** Both `index.html`
  and `admin.html` already had `display=swap` on every Google Fonts stylesheet,
  preconnects to both Google font hosts, and `crossorigin` on the gstatic hint.
  No admin markup change was warranted. New tests inspect every font link on
  both pages, enforce swap/preconnect/crossorigin, and reject Zen Brush requests.
- **A11Y-5 — fixed focus behavior; href already correct.** The existing skip link
  already targeted the unique `#mainContent` main region (not `#main-content`).
  Kept that consistent ID/href, added `tabindex="-1"`, and wired click activation
  to focus the main without suppressing the anchor's normal fragment scrolling.
  DOM coverage checks target uniqueness/focus; real Chromium tabs to the skip
  link and presses Enter, verifying main focus and the fragment.
- **CONTENT-1 — fixed missing surfaces.** Pants nav/footer were already driven
  by live stock, but its tile was always shown; Graphic Tees nav/tile were always
  shown. There is no existing Graphic Tees footer link, so none was added.
  Marked these five existing promotion nodes with `data-stock-category` and
  generalized the catalog-success/failure visibility sync. Visibility requires
  loaded API data and the existing per-size-aware `categoryHasLiveProducts` /
  `anySizeAvailable` helpers; fallback data never promotes these collections.
  Empty, sold-out or manually paused collections hide from these surfaces;
  restocks reveal the same nodes automatically on catalog load/refetch.
  Routes, collection grids and their existing empty states remain intact; sold-out
  products are still browsable through deep links/search. This supersedes earlier
  requirements in this log that the Pants home Explore card always stay visible.

**Verification.** `npm ci --no-audit --no-fund` installed the lockfile dependencies
without changing it. New DOM catalog-refresh coverage exercises both collections:
empty/deleted, pooled/untracked stock, manual pause, zero stock, S=0/M>0,
all-zero size stock, restock, API failure/retry and existing empty/sold-out routes.
The real API visibility-refetch test now also checks the Pants tile. Updated
Chromium coverage at 390px/1440px verifies promotion visibility and real direct
reloads for empty/sold-out Pants; stocked four-card geometry still passes at
320/360/414/599/768/1440px. The complete suite passed in one shell with the
PORT=3999 smoke server and cleanup:

```sh
PORT=3999 NODE_ENV=test node server.js > /tmp/kage-server.log 2>&1 & server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
PORT=3999 npm test
```

All five files pass: **133/133 API**, shared rate-limit, storefront regressions,
upgrade migrations and **31/31 frontend** scenarios. Tests retain their isolated
API ports; server log confirms the standalone server booted on 3999 and shut down
via SIGTERM. `git diff --check` passes.

**Assumptions.** “Products exist” for promotion means at least one buyable product,
not merely a stored/sold-out row. A manually paused product is not buyable even
with positive quantity; an untracked product is buyable when the existing stock
helper permits it. Automatic updates use the existing load/refetch lifecycle,
not new realtime polling. No live production inventory was changed or inspected;
fixtures cover the empty-category behavior. No Graphic Tees footer entry is
invented, and unrelated collections/surfaces remain unchanged. Initial loading
and catalog failures keep these promotions hidden until valid data arrives.

### ✅ A11Y-1 / A11Y-2 — contrast and keyboard focus — 2026-10-13

**Theme clarification.** The request described a dark storefront, but this checkout
has the warm beige/taupe storefront and light + dark admin modes. The owner selected
**preserve existing themes** before changes. No theme conversion, typography,
spacing, layout, catalogue, API/auth/session/CSRF, database, seeding, secrets or CSP
changes were made. Darken foregrounds on light surfaces; lighten on dark surfaces.

**A11Y-1 — verified and fixed.** WCAG sRGB relative luminance uses the 0.04045 gamma
breakpoint and `(Llighter + 0.05) / (Ldarker + 0.05)`; translucent surfaces/text are
alpha-composited before measuring. Storefront gray really was **2.49:1** on the
page and **1.99:1** on cards. Muted text also failed on cards/panels. Admin muted/dim
failed in both modes. Some status colors, white-on-white dark-mode buttons, and
white text on transparent light-mode hover controls also failed.

- Adjusted storefront muted/gray and semantic status text; primary/secondary/dim
  and all background tokens remain unchanged. Preserved decorative accent/hover
  colors and introduced a foreground-only hover token where the tint needs it.
- Adjusted admin muted/dim in each mode. Added theme-aware accent/success/danger/
  warning/info/purple foreground tokens without changing decorative accent,
  border, status-tint or stock-switch colors. Inverse control text now contrasts
  with the theme's primary surface and the existing fixed charcoal hover surface.
- The admin chart-empty overlay and password-modal card now use theme-aware
  background tokens so their inherited text remains readable in dark mode;
  the light-mode surfaces stay the same. The chart overlay retains 92% opacity.
- Placeholders use the accessible dim token with explicit opacity 1 (including
  browsers whose UA stylesheet otherwise dims placeholders).
- **498 conservative token/background pairs** pass the stricter **4.5:1** threshold
  for every size, which also exceeds the requested large-text **3:1**. This checks
  every ordinary foreground against *all* base surfaces, even combinations not
  currently used; explicit inverse, tinted status and inherited-hover pairs are
  checked separately. Minima: storefront **4.537**, admin light **4.549**, admin
  dark **4.881**. Primary → secondary → muted → dim luminance hierarchy is tested.

**A11Y-2 — verified and fixed.** Parsed every CSS rule, including nested media rules.
The existing generic storefront ring lost to more specific form resets and later
`:focus` rules; admin explicitly suppressed keyboard input/select/textarea outlines.
Added exact, final `:focus-visible` counterparts for **16 storefront / 12 admin
selectors** (including grouped selectors), using 2px accent outlines + 2px offset.
Removed admin's `:focus-visible { outline:none }` form override. All admin rings use
its accessible foreground-accent token. Category-tile rings are white against the
olive band, matching the existing category-strip ring.

`public/focus-modality.js` tracks pointerdown/keydown on the document. Because native
`:focus-visible` can also match pointer-clicked text inputs, a narrowly scoped
pointer-only `:focus` / `:focus-within` reset suppresses rings (including contact-card
ancestor rings); Tab restores them. Those two explicitly pointer-only rules are
intentional non-keyboard exclusions in the reset test. They cannot suppress keyboard
rings. The deferred, same-origin script is referenced by both HTML pages; CSP stays
unchanged. Existing hover/border feedback remains intact.

**Permanent tests.** `tests/fixtures/a11y.js` parses embedded CSS through the existing,
lockfile-pinned jsdom CSSOM dependency (no new package), resolves light/dark tokens,
computes WCAG contrast and composites alpha. `tests/a11y.test.js` rejects any pair
under 4.5, undefined/uncovered text tokens, collapsed hierarchy, and any ordinary
outline reset without an explicit visible counterpart. Known-ratio assertions test
the math. Real Chromium exercises all **40 theme/selector contexts** with click and
Tab, checking the actual outline cascade, input-text/placeholder contrast and
placeholder opacity. Decorative heart/star tokens are explicitly identified as
non-body text; this is not a claim of complete-site WCAG conformance (image-backed
text, decorative artwork/icons, disabled states and physical-device QA remain
separate). `package.json` adds this sixth suite to `npm test`.

**Full verification — passed.** Server and tests ran in one shell, on PORT=3999,
with cleanup; log confirms server startup and SIGTERM shutdown:

```sh
PORT=3999 NODE_ENV=test node server.js > /tmp/kage-server-a11y-final.log 2>&1 & server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
PORT=3999 npm test
```

All six suites pass: **133/133 API**, rate-limit, storefront regressions, upgrade
migrations, **31/31 frontend**, and contrast/focus (**148 storefront + 175 admin
light + 175 admin dark pairs**, 40 Chromium focus contexts). Existing responsive
Chromium checks still pass. JS syntax checks and `git diff --check` pass.

**Files changed:** `public/index.html`, `public/admin.html`, `public/focus-modality.js`
(new), `tests/a11y.test.js` (new), `tests/fixtures/a11y.js` (new), `package.json`,
`AUDIT.md`, `AGENTS.md`. Assumption: all body/secondary token combinations get 4.5:1
rather than relying on a font-size exemption; preserve both admin themes and the
current storefront palette. No changes to production data or dependencies.

**Full before/after ratio ledger.** Values below come from the original files read
before editing and the final tokens. `B` aliases are local to each theme table.
Tinted checks list their inherited base surface. Duplicate-color surfaces have
identical ratios and are grouped for readability. Newly named semantic tokens list
the original token/literal source; extra literal variants are listed separately.
Rounded display values do not determine pass/fail.


#### Storefront — warm light theme

Background groups (aliases have identical values and ratios):

- **B1:** `--bg-primary` = `#D9D4C8`.
- **B2:** `--bg-secondary`, `--bg-card`, `--bg-card-image` = `#C4BEB0`.
- **B3:** `--bg-card-hover` = `#CBC5B6`.
- **B4:** `--bg-glass` = `rgba(217,212,200,0.9)`.
- **B5:** `--bg-panel` = `#CFC9BA`.

Each cell is **before → after**, in contrast-ratio units (`:1`). Transparent base
surfaces are composited over the page. Body/secondary checks use unrounded values.

| Foreground / original source | Before color | After color | B1 | B2 | B3 | B4 | B5 |
|---|---|---|---:|---:|---:|---:|---:|
| `--text-primary` | `#1A1815` | `#1A1815` | 11.98 → 11.98 | 9.57 → 9.57 | 10.29 → 10.29 | 11.98 → 11.98 | 10.73 → 10.73 |
| `--text-secondary` | `#3D3931` | `#3D3931` | 7.77 → 7.77 | 6.20 → 6.20 | 6.67 → 6.67 | 7.77 → 7.77 | 6.96 → 6.96 |
| `--text-muted` | `#5C564C` | `#4F493F` | 4.91 → 6.02 | 3.92 → 4.81 | 4.22 → 5.18 | 4.91 → 6.02 | 4.40 → 5.39 |
| `--text-dim` | `#504C47` | `#504C47` | 5.76 → 5.76 | 4.60 → 4.60 | 4.95 → 4.95 | 5.76 → 5.76 | 5.16 → 5.16 |
| `--text-gray` | `#8A8578` | `#514C43` | 2.49 → 5.76 | 1.99 → 4.60 | 2.14 → 4.95 | 2.49 → 5.76 | 2.23 → 5.16 |
| `--text-success` (was `#2E7D32`) | `#2E7D32` | `#1B5520` | 3.47 → 6.00 | 2.77 → 4.79 | 2.98 → 5.16 | 3.47 → 6.00 | 3.10 → 5.37 |
| `--text-warning` (was `#fbbf24`) | `#fbbf24` | `#5C3D00` | 1.13 → 6.69 | 1.11 → 5.34 | 1.03 → 5.75 | 1.13 → 6.69 | 1.01 → 5.99 |
| `--text-info` (was `#60a5fa`) | `#60a5fa` | `#123C78` | 1.72 → 7.31 | 1.37 → 5.84 | 1.48 → 6.28 | 1.72 → 7.31 | 1.54 → 6.54 |
| `--text-purple` (was `#c084fc`) | `#c084fc` | `#50257F` | 1.79 → 7.43 | 1.43 → 5.93 | 1.54 → 6.38 | 1.79 → 7.43 | 1.60 → 6.65 |
| `--text-danger` (was `#DC2626`) | `#DC2626` | `#951919` | 3.27 → 5.84 | 2.61 → 4.66 | 2.81 → 5.02 | 3.27 → 5.84 | 2.92 → 5.23 |
| `--text-accent-hover` (was `--accent-hover`) | `#5A5240` | `#423C2D` | 5.23 → 7.41 | 4.18 → 5.92 | 4.49 → 6.37 | 5.23 → 7.41 | 4.68 → 6.64 |
| `--accent` | `#4A4433` | `#4A4433` | 6.56 → 6.56 | 5.24 → 5.24 | 5.63 → 5.63 | 6.56 → 6.56 | 5.87 → 5.87 |

Explicit tinted/control pair checks (identical-value underlays are grouped).
These include background-only hover rules that inherit their base text color:

| Foreground | Background | Underlay group | Before → after |
|---|---|---|---:|
| `--text-primary` | `var(--bg-primary)` | B1 | 11.98 → 11.98 |
| `--text-primary` | `var(--bg-secondary)` | B1 | 9.57 → 9.57 |
| `--text-primary` | `#fff` | B1 | 17.72 → 17.72 |
| `--text-secondary` | `rgba(255,255,255,0.92)` | B1 | 11.16 → 11.16 |
| `--text-secondary` | `rgba(255,255,255,0.92)` | B2 | 10.99 → 10.99 |
| `--text-secondary` | `rgba(255,255,255,0.92)` | B3 | 11.04 → 11.04 |
| `--text-secondary` | `rgba(255,255,255,0.92)` | B5 | 11.07 → 11.07 |
| `--heart-red` | `#FFF` | B1 | 4.83 → 4.83 |
| `--text-gray` | `rgba(255,255,255,0.9)` | B1 | 3.55 → 8.21 |
| `--text-gray` | `rgba(255,255,255,0.9)` | B2 | 3.48 → 8.06 |
| `--text-gray` | `rgba(255,255,255,0.9)` | B3 | 3.50 → 8.11 |
| `--text-gray` | `rgba(255,255,255,0.9)` | B5 | 3.51 → 8.14 |
| `--accent` | `#FFF` | B1 | 9.70 → 9.70 |
| `--text-primary` | `var(--bg-panel)` | B1 | 10.73 → 10.73 |
| `--text-warning` | `rgba(251,191,36,0.15)` | B1 | 1.10 → 6.52 |
| `--text-warning` | `rgba(251,191,36,0.15)` | B2 | 1.10 → 5.38 |
| `--text-warning` | `rgba(251,191,36,0.15)` | B3 | 1.03 → 5.73 |
| `--text-warning` | `rgba(251,191,36,0.15)` | B5 | 1.00 → 5.93 |
| `--text-info` | `rgba(59,130,246,0.15)` | B1 | 1.50 → 6.39 |
| `--text-info` | `rgba(59,130,246,0.15)` | B2 | 1.23 → 5.23 |
| `--text-info` | `rgba(59,130,246,0.15)` | B3 | 1.31 → 5.58 |
| `--text-info` | `rgba(59,130,246,0.15)` | B5 | 1.36 → 5.78 |
| `--text-purple` | `rgba(168,85,247,0.15)` | B1 | 1.54 → 6.41 |
| `--text-purple` | `rgba(168,85,247,0.15)` | B2 | 1.26 → 5.24 |
| `--text-purple` | `rgba(168,85,247,0.15)` | B3 | 1.35 → 5.59 |
| `--text-purple` | `rgba(168,85,247,0.15)` | B5 | 1.40 → 5.80 |
| `--text-success` | `rgba(34,197,94,0.15)` | B1 | 3.19 → 5.52 |
| `--text-success` | `rgba(34,197,94,0.15)` | B2 | 2.62 → 4.54 |
| `--text-success` | `rgba(34,197,94,0.15)` | B3 | 2.79 → 4.83 |
| `--text-success` | `rgba(34,197,94,0.15)` | B5 | 2.90 → 5.01 |
| `--text-gray` | `var(--bg-card-image)` | B1 | 1.99 → 4.60 |
| `--text-accent-hover` | `var(--accent-glow)` | B1 | 4.39 → 6.22 |
| `--text-accent-hover` | `var(--accent-glow)` | B2 | 3.55 → 5.04 |
| `--text-accent-hover` | `var(--accent-glow)` | B3 | 3.80 → 5.39 |
| `--text-accent-hover` | `var(--accent-glow)` | B5 | 3.95 → 5.60 |
| `--accent` | `#EFE9DA` | B1 | 8.01 → 8.01 |
| `--accent` | `rgba(74,68,51,0.08)` | B1 | 5.84 → 5.84 |
| `--accent` | `rgba(74,68,51,0.08)` | B2 | 4.71 → 4.71 |
| `--accent` | `rgba(74,68,51,0.08)` | B3 | 5.05 → 5.05 |
| `--accent` | `rgba(74,68,51,0.08)` | B5 | 5.25 → 5.25 |
| `--text-warning` | `rgba(160, 130, 40, 0.12)` | B1 | 1.02 → 6.07 |
| `--text-warning` | `rgba(160, 130, 40, 0.12)` | B2 | 1.20 → 4.94 |
| `--text-warning` | `rgba(160, 130, 40, 0.12)` | B3 | 1.12 → 5.28 |
| `--text-warning` | `rgba(160, 130, 40, 0.12)` | B5 | 1.08 → 5.49 |
| `--accent` | `var(--bg-secondary)` | B1 | 5.24 → 5.24 |
| `--accent` | `var(--bg-primary)` | B1 | 6.56 → 6.56 |

Additional original green foreground variant: account-success / delivered-order text
used `#4ade80`, while confirmation/notification success used `#2E7D32` (the source
shown above). Both now use `--text-success`. Ratios for the former variant:

| Original foreground | Background | Before → after |
|---|---|---:|
| `#4ade80` → `--text-success` | `--bg-primary` | 1.18 → 6.00 |
| `#4ade80` → `--text-success` | `--bg-secondary` | 1.06 → 4.79 |
| `#4ade80` → `--text-success` | `--bg-card-hover` | 1.01 → 5.16 |
| `#4ade80` → `--text-success` | `--bg-glass` | 1.18 → 6.00 |
| `#4ade80` → `--text-success` | `--bg-panel` | 1.06 → 5.37 |
| `#4ade80` → `--text-success` | `rgba(34,197,94,0.15)` over `--bg-primary` | 1.08 → 5.52 |
| `#4ade80` → `--text-success` | `rgba(34,197,94,0.15)` over `--bg-secondary` | 1.12 → 4.54 |
| `#4ade80` → `--text-success` | `rgba(34,197,94,0.15)` over `--bg-card-hover` | 1.05 → 4.83 |
| `#4ade80` → `--text-success` | `rgba(34,197,94,0.15)` over `--bg-panel` | 1.02 → 5.01 |

#### Admin — light

Background groups (aliases have identical values and ratios):

- **B1:** `--bg`, `--bg-dark`, `--bg-surface` = `#F3F4F6`.
- **B2:** `--bg-card`, `--bg-sidebar` = `#FFFFFF`.
- **B3:** `--bg-elevated` = `#F9FAFB`.
- **B4:** `--bg-chart-overlay` = `rgba(249,250,251,0.92)`.

Each cell is **before → after**, in contrast-ratio units (`:1`). Transparent base
surfaces are composited over the page. Body/secondary checks use unrounded values.

| Foreground / original source | Before color | After color | B1 | B2 | B3 | B4 |
|---|---|---|---:|---:|---:|---:|
| `--text-primary` | `#111827` | `#111827` | 16.12 → 16.12 | 17.74 → 17.74 | 16.98 → 16.98 | 16.91 → 16.91 |
| `--text-secondary` | `#4B5563` | `#4B5563` | 6.87 → 6.87 | 7.56 → 7.56 | 7.23 → 7.23 | 7.20 → 7.20 |
| `--text-muted` | `#9CA3AF` | `#626B78` | 2.31 → 4.90 | 2.54 → 5.39 | 2.43 → 5.16 | 2.42 → 5.14 |
| `--text-dim` | `#D1D5DB` | `#667080` | 1.34 → 4.55 | 1.47 → 5.01 | 1.41 → 4.79 | 1.40 → 4.77 |
| `--text-accent` (was `--accent`) | `#10B981` | `#046C4E` | 2.30 → 5.85 | 2.54 → 6.44 | 2.43 → 6.16 | 2.42 → 6.14 |
| `--text-accent-hover` (was `--accent-hover`) | `#059669` | `#045C43` | 3.42 → 7.29 | 3.77 → 8.02 | 3.61 → 7.68 | 3.59 → 7.65 |
| `--text-success` (was `--green`) | `#10B981` | `#046C4E` | 2.30 → 5.85 | 2.54 → 6.44 | 2.43 → 6.16 | 2.42 → 6.14 |
| `--text-warning` (was `#D97706`) | `#D97706` | `#854D0E` | 2.89 → 6.23 | 3.19 → 6.85 | 3.05 → 6.56 | 3.04 → 6.53 |
| `--text-info` (was `#2563EB`) | `#2563EB` | `#1D4ED8` | 4.70 → 6.09 | 5.17 → 6.70 | 4.95 → 6.41 | 4.93 → 6.39 |
| `--text-purple` (was `#8B5CF6`) | `#8B5CF6` | `#6D28D9` | 3.85 → 6.46 | 4.23 → 7.10 | 4.05 → 6.80 | 4.04 → 6.77 |
| `--text-danger` (was `--red`) | `#EF4444` | `#B91C1C` | 3.42 → 5.88 | 3.76 → 6.47 | 3.60 → 6.19 | 3.59 → 6.17 |
| `--text-danger-hover` (was `--red-hover`) | `#DC2626` | `#991B1B` | 4.39 → 7.55 | 4.83 → 8.31 | 4.62 → 7.95 | 4.60 → 7.92 |

Explicit tinted/control pair checks (identical-value underlays are grouped).
These include background-only hover rules that inherit their base text color:

| Foreground | Background | Underlay group | Before → after |
|---|---|---|---:|
| `--text-on-primary` | `--text-primary` | B1 | 17.74 → 17.74 |
| `--text-on-primary-hover` | `#374151` | B1 | 10.31 → 10.31 |
| `--text-on-danger` | `--red` | B1 | 3.76 → 4.71 |
| `--text-on-accent` | `--accent` | B1 | 2.54 → 6.99 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B3 | 17.01 → 17.01 |
| `--text-primary` | `var(--bg)` | B1 | 16.12 → 16.12 |
| `--text-danger` | `var(--red-subtle)` | B1 | 3.17 → 5.46 |
| `--text-danger` | `var(--red-subtle)` | B2 | 3.48 → 5.99 |
| `--text-danger` | `var(--red-subtle)` | B3 | 3.34 → 5.74 |
| `--text-primary` | `var(--bg-elevated)` | B1 | 16.98 → 16.98 |
| `--text-on-primary` | `var(--text-primary)` | B1 | 17.74 → 17.74 |
| `--text-muted` | `var(--bg-elevated)` | B1 | 2.43 → 5.16 |
| `--text-primary` | `var(--bg-card)` | B1 | 17.74 → 17.74 |
| `--text-success` | `var(--green-bg)` | B1 | 2.15 → 5.46 |
| `--text-success` | `var(--green-bg)` | B2 | 2.35 → 5.98 |
| `--text-success` | `var(--green-bg)` | B3 | 2.26 → 5.73 |
| `--text-muted` | `var(--bg-surface)` | B1 | 2.31 → 4.90 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B1 | 2.77 → 5.95 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B2 | 3.02 → 6.50 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B3 | 2.90 → 6.24 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B1 | 3.42 → 5.74 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B2 | 3.74 → 6.28 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B3 | 3.59 → 6.03 |
| `--text-info` | `rgba(59,130,246,0.10)` | B1 | 4.22 → 5.47 |
| `--text-info` | `rgba(59,130,246,0.10)` | B2 | 4.61 → 5.98 |
| `--text-info` | `rgba(59,130,246,0.10)` | B3 | 4.43 → 5.74 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B1 | 6.11 → 6.11 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B2 | 6.68 → 6.68 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B3 | 6.41 → 6.41 |
| `--text-secondary` | `var(--bg-elevated)` | B1 | 7.23 → 7.23 |
| `--text-on-danger` | `var(--red)` | B1 | 3.76 → 4.71 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B1 | 16.20 → 16.20 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B2 | 17.74 → 17.74 |
| `--text-dim` | `var(--bg-chart-overlay)` | B1 | 1.40 → 4.77 |
| `--text-dim` | `var(--bg-chart-overlay)` | B2 | 1.42 → 4.81 |
| `--text-dim` | `var(--bg-chart-overlay)` | B3 | 1.41 → 4.79 |
| `--text-on-accent` | `var(--accent)` | B1 | 2.54 → 6.99 |
| `--text-accent-hover` | `var(--accent-bg)` | B1 | 3.19 → 6.80 |
| `--text-accent-hover` | `var(--accent-bg)` | B2 | 3.50 → 7.44 |
| `--text-accent-hover` | `var(--accent-bg)` | B3 | 3.35 → 7.14 |
| `--text-success` | `rgba(16,185,129,0.10)` | B1 | 2.11 → 5.36 |
| `--text-success` | `rgba(16,185,129,0.10)` | B2 | 2.31 → 5.86 |
| `--text-success` | `rgba(16,185,129,0.10)` | B3 | 2.22 → 5.63 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B1 | 3.10 → 5.32 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B2 | 3.39 → 5.83 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B3 | 3.25 → 5.59 |
| `--text-success` | `rgba(16,185,129,0.2)` | B1 | 1.93 → 4.91 |
| `--text-success` | `rgba(16,185,129,0.2)` | B2 | 2.10 → 5.33 |
| `--text-success` | `rgba(16,185,129,0.2)` | B3 | 2.02 → 5.13 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B1 | 2.66 → 4.57 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B2 | 2.89 → 4.97 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B3 | 2.78 → 4.78 |

#### Admin — dark

Background groups (aliases have identical values and ratios):

- **B1:** `--bg`, `--bg-dark` = `#0F1117`.
- **B2:** `--bg-card`, `--bg-surface` = `#1A1D27`.
- **B3:** `--bg-sidebar` = `#14161F`.
- **B4:** `--bg-elevated` = `#222633`.
- **B5:** `--bg-chart-overlay` = `rgba(34,38,51,0.92)` (before: `rgba(249,250,251,0.92)`).

Each cell is **before → after**, in contrast-ratio units (`:1`). Transparent base
surfaces are composited over the page. Body/secondary checks use unrounded values.

| Foreground / original source | Before color | After color | B1 | B2 | B3 | B4 | B5 |
|---|---|---|---:|---:|---:|---:|---:|
| `--text-primary` | `#F0F1F5` | `#F0F1F5` | 16.72 → 16.72 | 14.90 → 14.90 | 15.98 → 15.98 | 13.36 → 13.36 | 1.09 → 13.65 |
| `--text-secondary` | `#A1A7B5` | `#A1A7B5` | 7.83 → 7.83 | 6.97 → 6.97 | 7.48 → 7.48 | 6.25 → 6.25 | 1.95 → 6.39 |
| `--text-muted` | `#6B7280` | `#9299A6` | 3.90 → 6.59 | 3.48 → 5.87 | 3.73 → 6.30 | 3.12 → 5.26 | 3.92 → 5.38 |
| `--text-dim` | `#4B5563` | `#8B93A3` | 2.50 → 6.11 | 2.22 → 5.44 | 2.39 → 5.84 | 1.99 → 4.88 | 6.12 → 4.99 |
| `--text-accent` (was `--accent`) | `#34D399` | `#34D399` | 9.82 → 9.82 | 8.75 → 8.75 | 9.38 → 9.38 | 7.84 → 7.84 | 1.56 → 8.01 |
| `--text-accent-hover` (was `--accent-hover`) | `#6EE7B7` | `#6EE7B7` | 12.38 → 12.38 | 11.03 → 11.03 | 11.83 → 11.83 | 9.89 → 9.89 | 1.24 → 10.11 |
| `--text-success` (was `--green`) | `#34D399` | `#34D399` | 9.82 → 9.82 | 8.75 → 8.75 | 9.38 → 9.38 | 7.84 → 7.84 | 1.56 → 8.01 |
| `--text-warning` (was `#D97706`) | `#D97706` | `#FCD34D` | 5.92 → 13.09 | 5.28 → 11.66 | 5.66 → 12.51 | 4.73 → 10.45 | 2.58 → 10.68 |
| `--text-info` (was `#2563EB`) | `#2563EB` | `#93C5FD` | 3.65 → 10.46 | 3.25 → 9.32 | 3.49 → 10.00 | 2.92 → 8.36 | 4.19 → 8.54 |
| `--text-purple` (was `#8B5CF6`) | `#8B5CF6` | `#C4B5FD` | 4.46 → 10.22 | 3.97 → 9.11 | 4.26 → 9.77 | 3.56 → 8.17 | 3.43 → 8.34 |
| `--text-danger` (was `--red`) | `#F87171` | `#FC8080` | 6.82 → 7.67 | 6.08 → 6.84 | 6.52 → 7.33 | 5.45 → 6.13 | 2.24 → 6.26 |
| `--text-danger-hover` (was `--red-hover`) | `#EF4444` | `#FC8080` | 5.01 → 7.67 | 4.47 → 6.84 | 4.79 → 7.33 | 4.01 → 6.13 | 3.05 → 6.26 |

Explicit tinted/control pair checks (identical-value underlays are grouped).
These include background-only hover rules that inherit their base text color:

| Foreground | Background | Underlay group | Before → after |
|---|---|---|---:|
| `--text-on-primary` | `--text-primary` | B1 | 1.13 → 15.72 |
| `--text-on-primary-hover` | `#374151` | B1 | 10.31 → 10.31 |
| `--text-on-danger` | `--red` | B1 | 2.77 → 6.41 |
| `--text-on-accent` | `--accent` | B1 | 1.92 → 9.23 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B4 | 11.51 → 11.51 |
| `--text-primary` | `var(--bg)` | B1 | 16.72 → 16.72 |
| `--text-danger` | `var(--red-subtle)` | B1 | 6.21 → 6.99 |
| `--text-danger` | `var(--red-subtle)` | B2 | 5.45 → 6.13 |
| `--text-danger` | `var(--red-subtle)` | B3 | 5.89 → 6.62 |
| `--text-danger` | `var(--red-subtle)` | B4 | 4.87 → 5.48 |
| `--text-primary` | `var(--bg-elevated)` | B1 | 13.36 → 13.36 |
| `--text-on-primary` | `var(--text-primary)` | B1 | 1.13 → 15.72 |
| `--text-muted` | `var(--bg-elevated)` | B1 | 3.12 → 5.26 |
| `--text-primary` | `var(--bg-card)` | B1 | 14.90 → 14.90 |
| `--text-success` | `var(--green-bg)` | B1 | 8.34 → 8.34 |
| `--text-success` | `var(--green-bg)` | B2 | 7.25 → 7.25 |
| `--text-success` | `var(--green-bg)` | B3 | 7.87 → 7.87 |
| `--text-success` | `var(--green-bg)` | B4 | 6.45 → 6.45 |
| `--text-muted` | `var(--bg-surface)` | B1 | 3.48 → 5.87 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B1 | 4.95 → 10.94 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B2 | 4.29 → 9.49 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B3 | 4.67 → 10.31 |
| `--text-warning` | `rgba(251,191,36,0.10)` | B4 | 3.82 → 8.44 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B1 | 4.06 → 9.32 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B2 | 3.57 → 8.19 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B3 | 3.85 → 8.84 |
| `--text-purple` | `rgba(139,92,246,0.10)` | B4 | 3.20 → 7.34 |
| `--text-info` | `rgba(59,130,246,0.10)` | B1 | 3.29 → 9.42 |
| `--text-info` | `rgba(59,130,246,0.10)` | B2 | 2.88 → 8.26 |
| `--text-info` | `rgba(59,130,246,0.10)` | B3 | 3.11 → 8.93 |
| `--text-info` | `rgba(59,130,246,0.10)` | B4 | 2.58 → 7.39 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B1 | 7.16 → 7.16 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B2 | 6.30 → 6.30 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B3 | 6.80 → 6.80 |
| `--text-secondary` | `rgba(107,114,128,0.10)` | B4 | 5.65 → 5.65 |
| `--text-secondary` | `var(--bg-elevated)` | B1 | 6.25 → 6.25 |
| `--text-on-danger` | `var(--red)` | B1 | 2.77 → 6.41 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B1 | 14.94 → 14.94 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B2 | 12.98 → 12.98 |
| `--text-primary` | `rgba(255,255,255,0.05)` | B3 | 14.10 → 14.10 |
| `--text-dim` | `var(--bg-chart-overlay)` | B1 | 6.12 → 4.99 |
| `--text-dim` | `var(--bg-chart-overlay)` | B2 | 6.18 → 4.93 |
| `--text-dim` | `var(--bg-chart-overlay)` | B3 | 6.15 → 4.96 |
| `--text-dim` | `var(--bg-chart-overlay)` | B4 | 6.22 → 4.88 |
| `--text-on-accent` | `var(--accent)` | B1 | 1.92 → 9.23 |
| `--text-accent-hover` | `var(--accent-bg)` | B1 | 10.52 → 10.52 |
| `--text-accent-hover` | `var(--accent-bg)` | B2 | 9.14 → 9.14 |
| `--text-accent-hover` | `var(--accent-bg)` | B3 | 9.93 → 9.93 |
| `--text-accent-hover` | `var(--accent-bg)` | B4 | 8.13 → 8.13 |
| `--text-success` | `rgba(16,185,129,0.10)` | B1 | 8.60 → 8.60 |
| `--text-success` | `rgba(16,185,129,0.10)` | B2 | 7.52 → 7.52 |
| `--text-success` | `rgba(16,185,129,0.10)` | B3 | 8.14 → 8.14 |
| `--text-success` | `rgba(16,185,129,0.10)` | B4 | 6.71 → 6.71 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B1 | 6.39 → 7.19 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B2 | 5.65 → 6.36 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B3 | 6.08 → 6.84 |
| `--text-danger` | `rgba(239,68,68,0.08)` | B4 | 5.07 → 5.70 |
| `--text-success` | `rgba(16,185,129,0.2)` | B1 | 7.17 → 7.17 |
| `--text-success` | `rgba(16,185,129,0.2)` | B2 | 6.25 → 6.25 |
| `--text-success` | `rgba(16,185,129,0.2)` | B3 | 6.77 → 6.77 |
| `--text-success` | `rgba(16,185,129,0.2)` | B4 | 5.61 → 5.61 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B1 | 5.54 → 6.23 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B2 | 4.90 → 5.51 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B3 | 5.26 → 5.92 |
| `--text-danger` | `rgba(239,68,68,0.2)` | B4 | 4.43 → 4.98 |

#### Additional literal/state source variants

These rows distinguish pre-fix colors that shared a semantic role; the main
matrices above use the original token (or the stated representative literal).
All columns below use the same theme background groups as above.


**index, light:**

| Source (before → after) | B1 | B2 | B3 | B4 | B5 |
|---|---:|---:|---:|---:|---:|
| review pending tag: `#7A6320` → `--text-warning` | 3.91 → 6.69 | 3.12 → 5.34 | 3.36 → 5.75 | 3.91 → 6.69 | 3.50 → 5.99 |

**admin, light:**

| Source (before → after) | B1 | B2 | B3 | B4 |
|---|---:|---:|---:|---:|
| approved review action: `#059669` → `--text-success` | 3.42 → 5.85 | 3.77 → 6.44 | 3.61 → 6.16 | 3.59 → 6.14 |
| rejected review action: `#DC2626` → `--text-danger` | 4.39 → 5.88 | 4.83 → 6.47 | 4.62 → 6.19 | 4.60 → 6.17 |
| pending dropdown hover: `#F0AD4E` → `--text-warning` | 1.77 → 6.23 | 1.95 → 6.85 | 1.86 → 6.56 | 1.85 → 6.53 |
| confirmed dropdown hover: `#5DADE2` → `--text-info` | 2.23 → 6.09 | 2.46 → 6.70 | 2.35 → 6.41 | 2.34 → 6.39 |

**admin, dark:**

| Source (before → after) | B1 | B2 | B3 | B4 | B5 |
|---|---:|---:|---:|---:|---:|
| approved review action: `#059669` → `--text-success` | 5.01 → 9.82 | 4.46 → 8.75 | 4.79 → 9.38 | 4.00 → 7.84 | 3.05 → 8.01 |
| rejected review action: `#DC2626` → `--text-danger` | 3.91 → 7.67 | 3.48 → 6.84 | 3.73 → 7.33 | 3.12 → 6.13 | 3.91 → 6.26 |
| pending dropdown hover: `#F0AD4E` → `--text-warning` | 9.70 → 13.09 | 8.64 → 11.66 | 9.27 → 12.51 | 7.75 → 10.45 | 1.58 → 10.68 |
| confirmed dropdown hover: `#5DADE2` → `--text-info` | 7.67 → 10.46 | 6.84 → 9.32 | 7.34 → 10.00 | 6.13 → 8.36 | 1.99 → 8.54 |

The dark admin password-modal card formerly forced a white surface while
inheriting the dark theme’s light `--text-primary`; it now uses `--bg-card`.
Heading/label contrast: **1.13 → 14.90:1**.

Unchanged non-token text on solid surfaces was also checked:

| Foreground | Background | Before → after |
|---|---|---:|
| `#FFF` | `#4A4433` | 9.70 → 9.70 |
| `#FFF` | `#5A5240` | 7.73 → 7.73 |
| `#FFF` | `#1A1815` | 17.72 → 17.72 |
| `rgba(255,255,255,0.6)` | `#4A4433` | 4.69 → 4.69 |
| `#F5F5F5` | `#0A0A0A` | 18.16 → 18.16 |
| `#FFF` | `#E21B23` | 4.76 → 4.76 |
| `#EFE9DA` | `#4A4433` | 8.01 → 8.01 |
| `#75251C` | `#FFF1EE` | 9.36 → 9.36 |

## Remaining work (priority order)

*API-side queue (C1, H1–H4, M1–M7, L1/L3–L7) completed 2026-09-23. FE-criticals
(FE-C1–C4) + FE-H1 also completed 2026-09-23 — suite now 24/24. Open:*

### 🔴 Critical — ✅ ALL FIXED (2026-09-23, with tests)
- **FE-C1.** ✅ Home/related/recently-viewed/wishlist cards now call `openProductDetail(${p.id})`
  (both the card div and the Quick View button in `renderHomeProductCard`); cards got
  `role="link"`/`tabindex`/Enter handler too. Test: shell must not contain the old
  `navigateTo('product', ...)` wiring.
- **FE-C2.** ✅ Added `GET /api/customers/me` (session restore, `requireCustomerAuth`, never
  returns `password_hash`) and `PUT /api/customers/me` (`requireCsrf` + `requireCustomerAuth`)
  handling both shapes the UI sends: profile fields (name/phone/address/city) and password
  change (`currentPassword`+`newPassword` → bcrypt verify → rehash). Tests: 401 unauthed,
  sanitized GET, profile persists, wrong current password → 401, old login dies + new works.
- **FE-C3.** ✅ Chart.js 4.4.1 self-hosted at `public/vendor/chart.umd.min.js` (~200 KB);
  `admin.html` now loads `/vendor/chart.umd.min.js` — same-origin, allowed by `scriptSrc 'self'`.
  Tests: asset served as JS w/ 1y cache; admin shell references vendor path, not the CDN.
- **FE-C4.** ✅ Built the reset view: `#page-reset` in the SPA (new-password + confirm form),
  `initPasswordReset()` reads `token`/`type` from the URL, `submitPasswordReset()` POSTs to
  `/api/auth/reset-password`; boot code routes `/reset-password` to the view. The CSRF
  monkey-patch + `csrfMiddleware` cookie make the POST work straight from the email link.
  Tests: bogus token → 400; `/reset-password?token=…` serves the shell with the view + JS.

### 🟠 High
- **FE-H1.** ✅ `esc()` applied to `src="${front}"` / `data-src="${back}"` in the
  collection-grid template — M6 parity reached across all rendering sinks.
- **FE-H2.** Drop script `'unsafe-inline'` via event delegation (long-term).

### 🟡 Medium
- **FE-M1.** ✅ pushState, Back, product/collection deep links, HTTP 404 (2026-10-10).
- **FE-M2.** ✅ cart/wishlist localStorage IDs rehydrated from the live API (2026-10-10).
- **FE-M3.** ✅ one delegated payment-radio listener; gallery swipe listener also guarded.
- **FE-M4.** ✅ cart badge animation targets `cartCount`.
- **FE-M1b (new, fixed 2026-10-11).** ✅ `#shopSection` was inline `display:none`
  forever — the whole collection/search/filter/sort/pagination surface rendered
  into a hidden section. Visibility is now class-driven (`applyShopVisibility()`
  → `.shop-visible` when a collection route or a non-empty search query is
  active; cleared on every other `navigateTo` target), homepage marketing
  sections step aside via `body.showing-shop`, and the grid clears the fixed
  header with `--header-h` padding + `scroll-margin-top`. Covered by frontend
  scenario 18 (57/57 API + 18/18 frontend) and a 36-check headless-Chromium run
  (1280px + 390px). Details in `PROJECT_LOG.md` §18.
- **FE-M5.** ✅ native links/review buttons and Escape/focus trap for primary overlays;
  ✅ dynamic controls/remaining dialog semantics closed 2026-10-18 (with A11Y-4):
  zoom view + mobile menu joined the trapped set, zoom saves/restores focus,
  menu Escape returns focus to the hamburger, and user-initiated route changes
  move focus to `#mainContent` (boot routing excluded so the skip link stays
  first). Verified in jsdom + real Chromium — see the 2026-10-18 entry.
- **FE-M7.** ✅ catalog failures are visible and disable cart/checkout until retry.

### 🔵 Low
- **FE-M6.** ✅ Micro-typography legibility (2026-10-18). The original complaint
  (topbar 0.4rem, 7px text wordmark, 3.5px CULTURE) was already gone — topbar is
  0.7rem since the marquee rework and the logo is a 44px image. Bumped the six
  remaining sub-10px text rules to ≥10px: nav badge 8px→10px (16px circle→18px
  pill so two-digit counts fit), discount badge / fit tag / payment pills /
  sale flag 8–8.8px→10.4px, filter badge 9.6px→10px, size-stock status /
  order-status pills 9.6px→10.4px, cart Remove + wishlist Add-to-Cart +
  Quick View buttons 9.6px→11.2px. Only the decorative checkbox ✓ glyph stays
  sub-10px (not readable text). Regression: frontend scenario 32 scans every
  `font-size` in the shell and fails on any readable size <10px. `npm test`
  passes all six suites (135/135 API, 32/32 frontend).
- **FE-M8.** ✅ manifest background, formatted totals and confirmation popup fixed (2026-10-10).
- **L2.** ~~Untracked product images/videos (9.3 MB of mp4s)~~ ✅ committed
  2026-09-23 (commit 663df0c) and pushed to `Dawood14210/kage-culture`. Residual:
  `vercel.json` bundles all of `public/**` (incl. 9.3 MB mp4s + vendor Chart.js) into
  the lambda — moving videos off-repo/CDN remains a cold-start optimization.

---

## Suggested fix order

1. ~~Fix `requireAuth` / `requireCustomerAuth` signature verification~~ ✅ done
2. ~~C1 — gate admin setup, remove storefront auto-setup~~ ✅ done
3. ~~H1 — lock down `GET /api/orders/:orderNumber`~~ ✅ done
4. ~~H4 — `npm audit fix` + multer 2.x + `/api/upload` fileFilter; M1 `trust proxy`~~ ✅ done
5. ~~H2, H3 — data-loss + email reliability on serverless~~ ✅ done
6. ~~Then mediums/lowers in order of annoyance~~ ✅ done (API side)
7. ~~FE-C1 + FE-C2 — broken storefront flows customers hit every day~~ ✅ done (24/24 tests)
8. ~~FE-C3 + FE-C4 — CSP-blocked admin chart; reachable-but-dead password reset~~ ✅ done
9. ~~FE-H1 (esc the grid attrs)~~ ✅ done; FE-H2 long-term alongside event delegation
10. ~~FE-M1 + FE-M2 — routing and cart persistence~~ ✅ done (2026-10-10)
11. ~~FE-H2 CSP migration, remaining a11y/visual checks, then L2 (deployment decision)~~ ✅ done 2026-10-19 (FE-H2 delegation + PERF-1 split + strict CSP; L2 assessed — no action, see PERF-4/L2 entry)
12. ~~SEO-2 — dynamic product/category sitemap with caching and crawler fallbacks~~ ✅ 2026-10-14
13. ~~SEO-1 / SEO-4 — server-rendered product/collection metadata; SEO-3 — structured data~~ ✅ 2026-10-15

## 2026-10-16 follow-up — CONV-2 / UX-1 / PERF-3

- **CONV-2:** Added an accessible text trust list directly after Place Order: Cash
  on Delivery, Secure checkout, a `/returns` link labelled “Easy returns ·
  7-day window · eligible items,” and WhatsApp support at +92 322 804 2633. It keeps the store's
  actual qualifications: COD only; delivery charge confirmed by location; sale
  items are final sale except if defective; custom designs/stickers are
  non-returnable unless defective or wrong; return shipping is customer-paid
  unless defective. The checkout does not imply free returns or a fixed shipping
  charge. The strip stacks below 381px and remains two columns above that.
- **UX-1:** The floating WhatsApp action hides whenever product, checkout, cart,
  or wishlist-drawer controls are present, at every viewport width. Headless
  Chromium verifies the product Add to Cart/sticky CTA, cart checkout button and
  Place Order remain unobscured at 320, 360, 390, 540, 768, 1024 and 1440px; the
  shortcut remains available on the home page.
- **PERF-3:** Product upload paths were inspected before changing images:
  `routes/products.js` accepts raster uploads up to 8MB in memory and
  `persistImage()` stores the original buffer at local `/uploads` or in Vercel
  Blob. No resizer is installed; `sharp` is absent and would add a heavy native
  dependency, so uploads remain untouched and their URLs/cart behavior are
  preserved. Product cards, gallery, related/recent cards and cart thumbnails
  now include display dimensions, responsive `sizes`, lazy loading and async
  decoding; the first detail-gallery image is eager/high priority, while the
  first visible grid image gets high priority without overriding its existing
  lazy loading. Gallery swipe/auto-scroll is unchanged. Category photos use new
  200w/500w WebP candidates in `<picture>` while retaining each JPEG fallback;
  existing hero-700 and about-hero-500 `srcset` variants are preserved.
- **390×844, DPR 1 image response-body bytes:** fresh headless Chromium pages,
  cache disabled, the same in-memory seeded catalog/API, and identical harness
  for `HEAD:public/index.html` (before) and the working tree (after). Totals sum
  decoded bodies from completed HTTP `Image` responses after catalog load/network
  idle; these are body sizes, not compressed wire-transfer sizes. Inline data
  URIs are excluded (the seeded demo products use inline SVG placeholders). Home
  loaded 7 HTTP images and `/product/1` loaded 6 in both runs. Home:
  **311,808 → 113,325 bytes** (−198,483; **63.7%**). `/product/1`:
  **243,572 → 106,197 bytes** (−137,375; **56.4%**). The savings are from
  responsive WebP category candidates; uploaded product images are not resized
  at upload time.
- Regression coverage: checkout policy/link and image-attribute DOM checks,
  real-Chromium responsive `currentSrc`/priority and overlap checks. Targeted
  `PORT=3999 node tests/frontend.test.js` passes **31/31** scenarios; final
  `PORT=3999 npm test` passes all six scripts (E2E, rate-limit, storefront,
  migration, frontend/Chromium, and accessibility).

## 2026-10-18 follow-up — remaining-queue sweep (FE-M6, A11Y-3, …)

- **FE-M6 (done, see Remaining-work entry):** all readable storefront text is
  now ≥10px; frontend scenario 32 scans every `font-size` in the shell.
- **A11Y-3 (done):** added a visually-hidden `#srAnnounce` live region
  (`aria-live="polite"`, new `.sr-only` clip rule) plus an `announce()` helper
  that clears and settles on a 50ms timer so repeated messages re-announce.
  Every `showToast()` call now mirrors into the region (covers quick-add,
  stock errors, newsletter/notify/review/account/order feedback); wishlist
  save/remove, cart add/quantity/remove, and order placement announce with
  product names and the real order number. `#resultCount` is a polite live
  status; `#checkoutError`/`#trkError` are `role="alert"`. Regression:
  frontend scenario 33 checks the markup contracts and drives announce, toast,
  wishlist, cart, filter and a real browserCookies checkout end to end.
  `npm test` passes all six suites (135/135 API, 33/33 frontend).
- **A11Y-4 + FE-M5 remainder (done):** audited first — cart/wishlist/filter
  drawers, the customer modal and the admin password dialog already had
  Tab-wrap traps, Escape and focus return. Gaps closed: the image zoom view
  now saves/restores focus and is trapped (it already moved focus to its
  Close button); the mobile menu is trapped and its Escape path returns focus
  to the hamburger (kept via `closeMenuAndRefocus`); user-initiated
  `navigateTo()` calls move focus to `#mainContent`, gated on a
  `bootNavComplete` flag that flips only after the async deep-link restore
  finishes (resolve and reject paths), so boot never steals the skip link.
  Regression: frontend scenario 34 — jsdom asserts boot leaves focus on
  `body`, route/modal/zoom focus in and back; real Chromium asserts drawer
  Tab-wrap both ways, outside-focus pull-in, menu wrap + Escape-to-hamburger,
  and zoom Tab containment + Escape-to-gallery. `npm test` passes all six
  suites (135/135 API, 34/34 frontend).
- **SEO-4 client part (done; server part was done 2026-10-15):** SPA
  navigations now sync `description`, `og:title/description/image/image:alt`,
  `og:type` and the `twitter:*` tags (previously only `canonical`, `og:url`
  and `document.title` moved). Product routes mirror the server format
  (`name | KAGE CULTURE`, ~155-char description, absolute front image,
  `og:type=product`); collection routes mirror `COLLECTION_SEO` copy with a
  newest-with-image pick approximating the server's; home/content routes
  restore hardcoded homepage defaults (deliberately not boot-captured — a
  deep-linked boot already carries route meta — with a parity test against
  the `/` shell). Regression: frontend scenario 35 drives
  product→collection→contact→home asserting every tag, plus a review-settle
  wait that fixed a teardown race (closing the window with the review fetch
  in flight threw on the dead jsdom global). `npm test` passes all six
  suites (135/135 API, 35/35 frontend).
- **CONTENT-2 unsubscribe (done; campaigns still need provider decision D3):**
  every newsletter row now carries `unsubscribed` + a 192-bit
  `unsubscribe_token` (fresh schema, additive migration, unique index, and a
  one-time `backfill_newsletter_tokens_v1` bootstrap step that runs after the
  email merge; full-scan + per-id UPDATE so the mem backend's `col = ?`-only
  WHERE shim stays correct). `POST /api/newsletter` returns the private
  manage link for new, already-subscribed and resubscribed addresses (lazy
  token repair for stragglers); clan-join inserts include a token.
  `GET /newsletter/unsubscribe?token=` renders a prefetch-safe confirm page
  (masked address, no-store, full address never echoed) and
  `POST /api/newsletter/unsubscribe` performs the idempotent removal —
  deliberately CSRF-exempt since the token is the credential (documented in
  code). Subscribe UI shows the private link once; Privacy policy updated.
  Regression: 2 e2e checks (full flow incl. prefetch-safety, masking,
  resubscribe; lazy repair + backfill idempotence), upgrade-suite token
  checks on both SQL backends, frontend scenario 36 for the UI link.
  `npm test` passes all six suites (137/137 API, 36/36 frontend).
- **FE-H2 event delegation (done; full `script-src` cleanup waits on PERF-1):**
  all 168 inline handlers are gone — 109 in `index.html` (93 click, 8 key,
  5 submit, 2 input, 1 blur, 1 image-error) and 59 in `admin.html` (50
  click, 5 change, 2 input, 1 key, 1 submit). Clickables carry
  `data-route` (nav; named to avoid the older `data-nav` active-link key)
  or `data-action` with params; one document click listener routes via
  `closest()`, so nested controls keep their old `stopPropagation`
  semantics. Keyboard activation for non-native controls goes through one
  keydown listener (`data-key`, with `data-key="enter"` preserving the
  product cards' Enter-only `role=link` behavior); forms route through one
  submit listener (`data-form`); admin selects/checkboxes/filters/stock
  input use strictly-separated `data-change`/`data-input`/`data-keys`
  listeners (checkboxes fire both `input` and `change`), with ids
  `Number()`ed for the strict-equality lookups. Two traps found by the
  suite: the old `navLinks` bubble listener fired before the document
  router, inverting the navigate-then-close order that `closeFilterDrawer`'s
  unconditional overflow reset depends on (removed; `data-close-menu`
  closes after navigating), and `toggleCart`'s close-button selector
  queried `[onclick*=]` (now `[data-action=]`). `script-src-attr` is now
  explicitly `'none'` — injected `onclick=` attributes cannot execute —
  while `script-src` keeps `'unsafe-inline'` only for the `<script>` blocks
  themselves until PERF-1 externalises them. Regression: e2e zero-handler
  scan of `/` and `/admin` plus CSP header assertions, and frontend
  scenario 37 proving delegated nav/card clicks work in real Chromium
  under the locked policy. `npm test` passes all six suites (139/139 API,
  37/37 frontend).
- **PERF-1 shell split (done; completes the FE-H2/SEC-1 end goal):**
  `index.html` 346KB → 71KB and `admin.html` 181KB → 30KB — CSS/JS now
  live in `storefront.css/js` and `admin.css/js`, extracted byte-exact
  (the mid-page marquee block merged at bundle head; its seamless-loop
  guarantee only measures the topbar above it, so end-of-body timing is
  equivalent). Only `application/ld+json` data blocks stay inline
  (CSP-exempt). The server hashes all four bundles at boot, substitutes
  `?v=` tokens into both pages (`/admin` now renders from a template
  with the same no-store headers), and serves hashed URLs immutable for
  a year (unhashed fall through to the daily static handler). Tests: a
  shared `stitch` fixture reassembles both pages byte-identically for
  jsdom (used by the frontend, storefront-regression and a11y suites);
  e2e JS/CSS assertions fetch the bundles; new checks pin the hashed
  references, immutability semantics, and a 120KB shell cap. With every
  executable script same-origin, `script-src` dropped `'unsafe-inline'`
  (and the dead `fonts.googleapis` entry) to plain `'self'` —
  `script-src-attr` stays `'none'`, and the e2e CSP check pins both on
  `/` and `/admin`. All real-Chromium scenarios pass under the strict
  policy. `style-src 'unsafe-inline'` remains (inline `style=`
  attributes throughout the markup — a separate, much larger
  migration). `npm test` passes all six suites (141/141 API, 37/37
  frontend).
- **PERF-4/L2 lambda bundle (assessed 2026-10-19 — no action):** the
  report's 9.3MB premise is stale: `public/` is 1.86MB total with zero
  mp4s (L2's videos are gone from the repo), and the PERF-1 split added
  only ~2KB net (bundle banners). The only remaining lever is replacing
  the catch-all `routes` entry with `rewrites` + relocating `server.js`
  so Vercel serves static files without invoking the lambda — but that
  cannot be verified without a Vercel deploy, a mistake there is a total
  outage (same class as the 2026-09-23 incident), and the payoff is ~200ms
  of occasional cold-start latency on an already-small bundle. No safe
  partial step exists either: with the catch-all in place, excluding any
  file from `includeFiles` 404s it (the lambda serves all static via
  `express.static` and reads the templates + bundles at boot). Revisit
  only with preview-deploy verification; if done, keep the HTML
  templates and the four hashed bundles in `includeFiles`.
- **D1/CONV-1 delivery band (done 2026-10-19):** owner set Rs. 250–450.
  Checkout, confirmation, tracking, the Shipping policy and the order
  email show the band through one `DELIVERY_FEE_BAND` const instead of
  "To be confirmed"; the exact fee depends on the city and is confirmed
  by phone before dispatch. The API still stores `shipping = 0` with
  `shipping_pending` until the admin confirms the real fee, and the
  admin "Delivery charge pending" badge is unchanged. Regression:
  frontend delivery-copy assertions updated to the band, e2e asserts the
  pending email carries it.
- **D2/ANALYTICS-1 Umami Cloud (done 2026-10-19):** the deferred tracker
  tag renders on the storefront only when `UMAMI_WEBSITE_ID` is set (id
  shape validated; unset or hostile values render nothing). CSP allows
  `cloud.umami.is` for scripts and beacons; the admin panel carries no
  analytics; the Privacy policy discloses the cookieless tracking.
  Regression: e2e pins `script-src 'self' https://cloud.umami.is` and
  covers set/unset/hostile-id/admin-exclusion; frontend asserts the
  disclosure. Operator step: add the site in the Umami Cloud dashboard
  and set `UMAMI_WEBSITE_ID` on Vercel (documented in `.env.example`).
- **D3/CONTENT-2 campaigns (closed 2026-10-19 — decided SMTP-only):**
  owner chose no bulk sending; the newsletter stays notify-only and no
  campaign code was added. The manage-link-in-response design stands
  (possession only permits unsubscribing, reversible by resubscribing).
- **Contact details (done 2026-10-19):** Instagram verified as
  `@kage_culture` (single underscore — fixed in the contact card, footer
  icon and JSON-LD `sameAs`); working hours published as "Monday to
  Saturday, 11am to 8pm (Pakistan time). Sunday closed." with a
  `.contact-working-hours` rule; JazzCash confirmed identical to the
  WhatsApp number (+92 322 804 2633), no code change (no account number
  is displayed anywhere — recorded here for future payment UI).
- **SEC-2 HSTS preload (assessed 2026-10-19 — no action):** optional and
  informational; preload is effectively irreversible and the audit
  requires confirmed subdomains first. Helmet's default HSTS stays.
  Revisit only if the brand commits to HTTPS-everywhere including all
  subdomains.
- **Mobile header wrap (done 2026-11-22 — reported from Firefox on Android):**
  the storefront header wrapped on Firefox but not Chrome, and the wrapped
  second row was painted over the hero. Root cause was not browser-specific:
  the row is `[logo][wishlist · account · cart · hamburger]`, the four tap
  targets are a fixed 176px, the gutters 32px and the logo 8px of padding +
  an 8px gap — 224px of furniture. With its 128.75px artwork the row needed
  **344.75px**, so it wrapped on any viewport narrower than that. Chrome laid
  the phone out at 360px (row fit, looked fine); Firefox exposed a **343.6px
  CSS viewport** (1080 device px ÷ DPR 3 minus a classic scrollbar), which is
  1.15px short — hence the wrap. The second half of the bug was the fixed
  `height: 95px` bar: the wrapped row is ~127px tall, so the icons overflowed
  the header's box and painted over the hero (the `--header-h` script measured
  the box, not the overflowing content). Fixed in `public/storefront.css`:
  ≤640px caps the logo at `max(80px, calc(100vw - 224px))` with
  `object-fit: contain`, so only the logo gives way and only by the exact
  deficit (no change at ≥360px, one tidy row below that); ≤360px sets
  `height: auto` on the bar and `min-height: 67px` on the row so a genuinely
  wrapped bar (~304px and below) grows and keeps its icons inside it. The
  44×44 tap targets are untouched. Regression: frontend real-Chromium scenario
  walks 280/300/320/344/360/375/412/640px asserting one row, icons inside the
  bar and above the hero, 44×44 targets, `--header-h` matching the real
  height, and no horizontal scroll; e2e/frontend CSS contracts updated to the
  new rules.
- **Menu highlight inset + submit-only search (done 2026-11-22):** two
  storefront UX fixes reported together.
  *(a) Menu highlight touching the label.* On phones the dropdown row tint
  (`background: var(--bg-secondary)` on hover) began exactly at the text: the
  ≤768px rule set `.nav-links a { padding: 10px 0 }`, zeroing the horizontal
  padding the base rule gives (12px). The pill therefore clipped "HOME" on its
  left edge and the labels did not line up with each other. Now `padding: 10px
  16px`, matching the menu panel's own 16px so every label shares one left
  edge with 16px of tint on either side. Desktop is untouched (the ≥1024px
  rule sets its own `padding: 8px 0` for the centred underline links).
  *(b) Search ran on every keystroke.* Both fields had an `input` listener
  wired straight to `onSearchInput()`, so each character re-rendered the grid —
  and from the plain homepage it swapped the marketing sections for the shop
  mid-word. The `input` listeners are gone; search now commits only on Enter,
  the in-field magnifier, or the header search button. One shared
  `submitDesktopSearch()` serves all three desktop paths (commit, close the
  open field, blur, scroll to top) so they cannot drift, and the desktop
  magnifier changed from a decorative `pointer-events: none` `<span>` into a
  real `<button id="searchSubmit">` (36px hit area, `aria-label`), matching the
  mobile field's existing button. Clearing the box still restores the
  homepage, because `onSearchInput('')` remains the reset path.
  Regression: frontend scenario asserts typing leaves `searchQuery` empty and
  the grid hidden while Enter/the magnifier commit and render results, plus
  real-Chromium checks that menu labels are inset ≥12px and both submit paths
  work end to end.
- **Storefront logo swapped to the Pagoda Emblem (done 2026-11-22):** the header
  wordmark is now the supplied square emblem instead of the 影 KAGE — CULTURE —
  lockup.
  *Archival (nothing lost).* The outgoing artwork moved with `git mv` to
  `source/kage-horizontal-light-2026-11-22.svg` (still in the repo, still
  restorable by pointing the `<img>` back at it). The new artwork's full
  resolution master is `source/kage-mark-pagoda-source.png` (835×835, ink on
  alpha), derived from the 1536×1024 upload.
  *Compression.* The upload was an opaque 1.81 MB PNG whose cream plate is not
  the site background (`#FAF7EC` vs `#D9D4C8`), so pasting it as-is would have
  shown a visible box. Luminance is a direct measure of ink coverage on a flat
  plate, so the artwork was recovered as **black ink on transparency**
  (`alpha = (247 - luminance) / 233`), cropped to the mark + 2% padding, and
  encoded at 384px — enough for the 52px emblem on a 3× screen (156 device px)
  with headroom. A 64-colour palette PNG beats every alternative here and is
  indistinguishable at display size (flattened RMSE 2.3/255; the residual is
  dither noise in the semi-transparent spray):
  - served asset `kage-mark-light.png` — **14,368 B**, down from 1,892,738 B
    (**99.2% smaller**), and less than half the 34,836 B SVG wordmark it
    replaces;
  - lossy WebP was *bigger* (58 KB at 384px) — dither noise is expensive in
    lossy codecs and cheap in a palette — so the `<picture>`/WebP source was
    dropped rather than shipped;
  - full-lossless PNG24 was 96 KB, so the palette is doing the real work.
  *Layout.* A 1:1 mark needs different sizing than a 4:1 wordmark: 52px in the
  mobile row, 60px on desktop (`≥1024px`), and 44px at `≤360px` so the emblem
  still fits the 67px row and the bar is not pushed taller. `.kage-logo img`
  pins the height and lets the width follow the image's own ratio.
  *Verification.* Real Chromium at 280/320/344/360/412/768/1280px: header stays
  95px, logo and icons share one centre line, everything stays inside the bar,
  the hero clears it, no horizontal scroll, and `--header-h` tracks the real
  height. Emblem renders 156 device px from a 384px source at 3× DPR. Frontend
  37/37 (assertions updated from the old 52.8px wordmark to the 60px emblem,
  and "same row" now compares centre lines, since the emblem is taller than the
  44px icon targets); rest of `npm test` unchanged at 141/142 with the known
  pre-existing `seed-demo` storage failure.
- **Per-product Fabric & Care / Fit Guide (done 2026-11-22):** the detail page's
  Fabric & Care and Fit Guide tabs were the same hardcoded copy for every
  product. Both are now per-product fields, editable when adding **and** editing
  a product in the admin panel.
  *Backend.* Two nullable `TEXT` columns, `fabric_care` and `fit_guide`, added to
  the products `CREATE TABLE` and to `ADDITIVE_COLUMN_MIGRATIONS` so existing
  databases pick them up on boot. They are ordinary *public* fields — added to
  `PUBLIC_PRODUCT_COLUMNS`, so they ship in the storefront payload as well as the
  admin one (`PUBLIC_PRODUCT_SELECT` / `ADMIN_PRODUCT_SELECT` derive from that
  list, so no query strings needed editing). POST and PUT both accept them,
  capped at 2,000 characters per field; empty means `NULL`.
  *Semantics.* On PUT, an **omitted** field keeps its stored value and an
  explicitly **empty** field clears to `NULL` — so the panel always sends both,
  and clearing a textarea really restores the site default instead of silently
  keeping the old text. The Quick Upload path deliberately still sends neither.
  *Normalisation.* Browsers and undici serialise multipart fields with CRLF, so
  Enter arrived as `\r\n`. Both fields now pass through one `cleanDetailCopy()`
  helper (`\r\n?` → `\n`, trim, cap, empty → `NULL`) so the stored value matches
  what was typed, and the storefront splits on either line ending anyway.
  *Storefront.* `openProductDetail()` now calls a new `renderDetailTabs()`: one
  `<li>` per line, each row `esc()`-escaped, with a typed leading `-`, `•` or `*`
  stripped so the admin can type bullets naturally. Blank lines are skipped.
  *Fallback.* The shipped markup in `index.html` is the site's generic copy and
  is captured once on first render, so a product with no saved text shows the
  default — and browsing a customised product *then* a plain one restores the
  default instead of leaking the previous product's copy into the next. The
  tabs are never hidden.
  *Gotcha found while testing.* The storefront does not use the API payload
  directly; `loadProductsFromAPI()` rebuilds each product from a field
  whitelist. The new columns had to be added there too, or the API returned them
  and the UI silently never saw them.
  *Admin UI.* Two full-width textareas under Description with a
  "one point per line" hint, prefilled on edit and cleared by `resetForm()`
  (which calls `form.reset()`); both are appended to the same `FormData` used
  for create and update.
  *Verification.* New `tabs` frontend scenario (custom copy renders, bullets
  stripped, plain product keeps the generic list, A→plain→B does not leak,
  `<img onerror>` payload stays literal text) and a new e2e check (create →
  public payload → partial edit keeps the other field → empty clears to `NULL` →
  5,000 characters truncate to 2,000). `npm test` 142/143 — the only failure is
  the known pre-existing `seed-demo` storage one that needs
  `BLOB_READ_WRITE_TOKEN`; frontend 37/37.
- **All four categories are permanent (done 2026-11-23):** the homepage strip was
  showing only three cards because Graphic Tees and Pants were stock-gated —
  each hid its nav link, home card and footer link whenever the loaded catalog
  had no buyable stock in that category.
  *Why it looked like a bug.* The gate fired on **stock**, not on existence, and
  stock decrements with every order. As each demo tee sold down to zero the
  Graphic Tees card quietly disappeared — so the live site showed Pants (which
  still had units) and hid Graphic Tees, the inverse of a fresh catalogue. Since
  the two gated cards sat in slots 1 and 3 of a 2×2 mobile grid, their absence
  also shifted the remaining cards around between visits.
  *Fix.* All four are unconditional now.
  - `index.html`: the `style="display:none;"` that shipped on the two nav links,
    the two home cards and the Pants footer link is gone, so the markup is valid
    HTML and correct before a single byte of JS runs.
  - `storefront.js`: `syncCollectionVisibility()` no longer hides anything; it
    only clears a leftover `display:none` on a catalog refresh, so the cards
    cannot go missing even if something sets one. The now-unused
    `categoryHasLiveProducts()` helper was deleted rather than left as dead
    gating.
  - The nodes keep `data-stock-category`, which costs nothing and keeps the
    guard working.
  *Behaviour with no stock.* The card still shows and still links to a real
  route: a sold-out category lists its products flagged SOLD OUT, and a category
  with no products at all lands on the grid's existing "No pants available right
  now" empty state with a Browse-all link. Nothing routes to Coming Soon —
  `graphic-tees` was already excluded from `COMING_SOON_CATEGORIES` and `pants`
  never qualified.
  *A real failure the old gate hid.* With the catalog request failing, the old
  code hid both cards; now they stay put and only the product grid shows the
  load error, which is the honest signal.
  *Verification.* Real Chromium at 390px and 1440px: four cards, 2×2 on mobile
  and one four-across row on desktop, equal widths, no horizontal scroll. Also
  probed a catalog containing only anime products (all four still shown) and an
  outright fetch failure (all four still shown), plus the empty-Pants deep link
  (empty state, not Coming Soon). Seven assertions across
  `tests/storefront-regressions.test.js` and `tests/frontend.test.js` were
  rewritten from "hidden when empty" to "always shown", and the header test no
  longer toggles the Pants link — it now measures the real eight-link row.
  `npm test` **143/143** (the previously flaky `seed-demo` storage check passed
  this run too), frontend 37/37.
- **Homepage category photos are editable (done 2026-11-23):** the four photos in
  the home page's category strip were hard-coded `<picture>` elements with
  bundled WebP crops, so changing one needed a deploy.
  *Admin panel.* A new **Homepage Cards** section (sidebar entry + option in the
  mobile section picker) lists all four cards with their current photo and a
  **Change photo** button. Uploading a replacement shows a "Custom photo" badge
  and switches the button to **Replace photo**; **Reset to default** appears
  only while an override is in place, so the state is visible at a glance.
  *Storage.* Each override is one `app_settings` key
  (`category_card.<id>.image`), reusing the existing key/value store rather than
  a new table. Uploads go through the same `persistImage` path as product
  photos, so they land in Vercel Blob in production and `/uploads` locally.
  Reset **deletes the key** and the old object, which is why the bundled file is
  never overwritten: `del` on Blob is one-way, so treating `public/images` as an
  immutable default makes reset deterministic instead of destructive.
  *Storefront.* `syncCategoryCardPhotos()` reads `/api/category-cards` alongside
  each catalog refresh and swaps the image. A custom photo replaces the whole
  `<picture>` element — leaving it in place would keep the bundled WebP crops on
  screen, since `<picture>` wins over the `<img>` fallback. Reset restores the
  captured original markup verbatim, crops and all. Any failure (non-OK, network)
  leaves the bundled photos untouched; a missing photo is not worth an error
  banner to a shopper.
  *Security.* The stored value ends up in an `<img src>`, so `isAcceptableImageUrl`
  accepts only a same-origin `/uploads/…` path (no `..`) or an absolute `https:`
  URL and rejects everything else — `javascript:`, `data:`, protocol-relative
  `//host`, plain `http:`, and any quote that could break out of the attribute.
  An unusable stored value resolves to the bundled photo, so a corrupted or
  tampered row degrades to a correct card instead of broken markup. Uploads
  reuse the existing raster-only filter (SVG refused) and `requireAuth` +
  `requireCsrf`; an unknown card id is a 404.
  *Verification.* New e2e check covers the four defaults, upload → public
  endpoint agrees → the file is really served → unknown id 404 → SVG 400 →
  unauthenticated 401 → reset restores `/images/pants.jpg`, plus a unit check
  that 15 hostile URL shapes are refused and fall back. New frontend scenario
  covers custom swap (dropping `<picture>`), alt text, the route still working,
  other cards untouched, reset restoring the captured markup byte-for-byte,
  malformed payloads being ignored, and a non-OK response keeping the bundled
  art. Real Chromium at 360/768/1440px: single column, two columns, then four,
  no horizontal scroll, 44px touch targets. `npm test` **145/145**, frontend
  **79/79**.
  *Also fixed:* the frontend suite's closing line hard-coded "37/37" while 79
  scenarios actually ran. It now counts the `✅` lines it prints, so the summary
  cannot drift again.

## 2026-11-23 follow-up — skeleton loading screens + action spinners

**Problem.** Every slow path was silent. The storefront painted empty grids while
`/api/products` was in flight, the account page sat blank until order history
arrived, tracking showed nothing between submit and result, and every action that
took more than a moment only disabled its button (or, worse, closed its dropdown
and left no trace at all). The CSS already shipped `.skeleton` /
`skeleton-shimmer` primitives, but nothing used them; the admin panel had exactly
one spinner, hard-wired to Quick Upload.

**Storefront (`public/storefront.js`, `public/storefront.css`).**
* `setButtonLoading(btn, on, label)` — the one spinner primitive. It disables the
  button, sets `aria-busy`, swaps the label for `<span class="spinner">` + a
  text label, and restores the **exact** original `innerHTML`/`disabled` state
  afterwards, so no flow leaks a half-rendered button. Wired into: place order,
  login, signup, logout, save profile, change password, resend verification,
  request password reset, reset password, review submit, tracking submit each
  newsletter/notify form, Load more, and the catalog Retry button.
* Skeletons: `skeletonProductCards` / `skeletonReviewRows` / `skeletonOrderRows`
  / `skeletonTrackCard`, painted into `#bestSellersGrid`, `#collectionGrid`,
  `#reviewsList`, `#acctOrders` and `#trkResult`. The collection/best-seller
  skeletons are only painted when nothing is on screen yet (first load, or a
  retry after an outage) — a seed-painted or already-loaded grid keeps its real
  cards, so the instant seed paint is never replaced by a flash of placeholders.
  `withFullCatalog()` now marks the grid `aria-busy` and skeletons an *empty*
  grid only, so a filter applied before the last catalog page lands no longer
  blanks the page.
* Photos decode asynchronously, so card and gallery `<img>` carry `.img-skel`
  (the shimmer) until `load`/`error` fires; a capture-phase listener removes it
  for every image, and a post-render sweep covers cache hits.
* Detail reviews reveal the section immediately with two skeleton rows and swap
  in real reviews (or the empty state) when the fetch settles. Tracking shows a
  skeleton card under the form while the lookup runs.
* `prefers-reduced-motion: reduce` stops both the shimmer and the ring.

**Admin (`public/admin.js`, `public/admin.css`).**
* `btnLoading()` (same restore-exact-markup contract) drives Save/Update Product
  and bulk delete; `busyButton()` covers row-level icon buttons (stock toggle,
  delete, order status/payment/COD, review approve/reject/delete) with an
  in-place spinning ring, driven by a promise-aware `ASYNC_ACTIONS` allow-list in
  the delegated click handler.
* Skeletons for every list that starts empty: dashboard stat values and Recent
  Orders, Products, Orders, Reviews, Homepage Cards, plus the sales-summary and
  P&L numbers. `aria-busy` is set on the list and cleared in `finally`.
* A 2px top progress bar (`#adminBusyBar`) is ticked by the existing `fetch`
  wrapper for *every* API call, so actions whose button lived in a dropdown that
  just closed still show activity. It appears after a 140 ms delay, so cache hits
  never flash.
* Homepage-card photo upload/reset now dims the card frame, spins a ring over it
  and prints "Uploading…" / "Resetting…" in the card status line — client-side
  compression makes those cycles the slowest in the panel.

**Accessibility.** Decorative skeleton nodes are `aria-hidden` and text-free;
loading state is conveyed with `aria-busy` on the container and the button, so a
screen reader is not read a wall of empty boxes. Nothing relies on colour alone.

**Verification.** All skeletons/spinners are pure decoration on top of the
existing markup contracts: `npm test` **165/165** and the frontend suite
**80/80** stay green, including the grid/card, lazy-image, offline-catalog and
hidden-home-reviews assertions. Two static guards were kept honest (the served
`#collectionGrid` must stay an empty `.product-grid`, and `trackOrder`'s
`finally` must still contain `btn.disabled = false`). A jsdom probe with a held
`/api/products` response confirmed 8 skeleton cards + `aria-busy="true"` on both
grids, replaced by real cards with the attribute cleared on resolution, and a
held tracking request confirmed the skeleton card plus a spinning
`Tracking…` button.

---

## 2026-11-23 performance pass — Tasks 1–4 (photos, hero, data requests, first paint)

Owner-supplied performance review, worked one task per commit. Baseline before
this pass: home page **4105 KB**, with first paint at **1184 ms** on a throttled
390x844 slow-4G profile; the PageSpeed report's headline complaints were a 3.6 MB homepage photo,
a full-size desktop hero served to phones, and a 3.9 s data-request dependency
chain.

### ✅ Task 1 — Category-card photos are optimised on upload (`utils/categoryCardImage.js`)
**Was.** The admin homepage-card uploader stored whatever the owner selected, and
the homepage rendered it at 95–150 px. A 1122x1126 PNG (3.6 MB) was being served
into a 95 px circle: `#sectionCategories` alone was 3.7 MB of the 4.0 MB page.

**Fix.** A new `utils/categoryCardImage.js` shrinks the file at upload time —
`sharp` re-encodes to WebP, longest edge ≤ 600 px, quality ladder 78 → 72 → 66 → 60
until the main image is under 100 KB, plus a 300 px variant under 48 KB, both
stored through `storeProcessedImage`. `routes/admin.js` uses it and records the
real dimensions + variants in `app_settings` (`category_card.<id>.meta` =
`{v, width, height, variants}`); `utils/categoryCards.js` turns that into
`srcset`/`width`/`height` on the public card payload, and `public/storefront.js`
renders them with `sizes="(min-width: 1024px) 150px, 104px"` (the CSS circle
width). Unsupported/corrupt buffers fall back to the old `persistImage` path
(upload still succeeds), and `scripts/convert-category-cards.js`
(`npm run convert-cards`, `--dry-run` supported) backfills photos already stored
the old way — idempotent, it skips cards that already have a `meta` row.

**Verified.** Convert script: `3.62 MB → 21.3 KB (598x600, 99.4% saved)`, no-op on
re-run. Live upload through the admin route: 3000x3000 input stored as a 300 px
variant + ≤600 px main, both WebP. Phone profile: page **4105 KB → 403 KB**, the
Pants tile **3709 KB → 7.2 KB** (`-300.webp`, 1122x1126 PNG into a 95 px box).
Desktop pixel diff of the category band: identical.

### ✅ Task 2 — Phones get the 700 px hero (`public/index.html`, `public/storefront.css`)
**Was.** The hero shipped 700w/1376w candidates but no `(max-width: 640px)` source
at all, so a 390 px phone downloaded the 1363 px `hero.webp` (96 KB) — and the
`<img>` had no `width`/`height`, so the box was reserved by `aspect-ratio` alone.

**Fix.** Two `(max-width: 640px)` `<source>`s (WebP + JPEG) for `hero-700.*`, and
`width="1363" height="768"` on the `<img>` paired with `height: auto` in
`.hero-media img` (a presentation height attribute otherwise beats
`aspect-ratio` and stretches the picture to `56vh` — this was caught in review).

**Verified (headless Chromium).** 390x844 and 360x800@3x now fetch
`hero-700.webp` — natural 700x391, same rendered box (390x219 / 360x203),
**96.2 KB → 37.3 KB**. 1440x900 still gets `hero.webp` and renders identically.
Screenshots before/after are byte-for-byte the same look.

### ✅ Task 3 — Data requests start with the bundle, anonymous visits skip the session probe
**Was.** `Promise.all([loadProductsFromAPI(), checkCustomerAuth()])` ran at the
*end* of a 45 KB bundle, and the category-card and featured-review fetches only
started from the code paths that consumed them. On slow 4G the four API requests
therefore began at 1589/1590/1877/1878 ms — effectively a chain — for a page whose
catalog was already painted from the inlined seed.

**Fix (four parts).**
1. `public/storefront.js` now issues the three public GETs in its **first
   statements** (`earlyFetch()` + `consumeEarlyFetch()`), and every consumer awaits
   the existing promise instead of issuing its own; nothing is fetched twice and a
   consumer that never runs cannot leave an unhandled rejection. Boot's two
   category-card calls share one request until boot routing settles
   (`settleBootCards()`), after which each refresh asks again so an admin photo
   swap still appears without a reload.
2. `GET /api/customers/me` is no longer called for anonymous visitors. The session
   cookie is (correctly) httpOnly, so `routes/auth.js` now also sets a readable
   companion cookie `kage.signed_in=1` on customer login/signup and clears it on
   logout — it carries no identity, id or token. `checkCustomerAuth()` skips the
   probe when the hint is absent, and `handleAccountClick()` forces one probe
   before showing the sign-in form, so a lost hint can never strand a signed-in
   shopper. Blocked/unknown cookies fail open (probe as before).
3. `GET /api/category-cards` reads all twelve `category_card.*` settings in **one**
   query instead of twelve sequential `getSetting()` round trips (twelve network
   hops per page view on Turso), and its cache header moved from
   `s-maxage=10, swr=30, must-revalidate` to `s-maxage=60, stale-while-revalidate=300`
   — four rarely changed pictures, so a photo swap may take up to a minute.
4. The shell preconnects to the Blob photo origin (`BLOB_PUBLIC_HOST`, else the
   store id inside `BLOB_READ_WRITE_TOKEN`) — server-injected, absent locally
   where uploads are same-origin, and the token itself never reaches the page.
   `<link rel="preload" as="fetch">` was tried first and **dropped**: the three
   endpoints are `must-revalidate`, so Chrome could not reuse the preload and the
   later fetch revalidated anyway — the hints only competed with the CSS/JS for
   bandwidth.

**Verified.** Throttled 390x844 slow-4G: API requests go from five (1589, 1590,
1877, 1878) to **three, all starting at ~1544 ms**, and the page is 344.6 KB;
desktop 1440: 133.1 → 130.5 KB, three requests at ~38 ms. Paint metrics did not
move in this step (first paint 1184 → 1184 ms, CLS 0.0040): the page still waits
for 32 KB of render-blocking CSS, which is the next task.

> Measurement note: the LCP numbers in this log come from a CDP harness that first
> added `startTime + loadTime`, double-counting the image download and inflating
> every value by ~800 ms on slow-4G. The harness now uses `renderTime ||
> startTime`; the figures above are the corrected ones (LCP == FCP at 1184 ms,
> because the whole page paints in one go when the stylesheet lands). CLS stays 0.0040. `npm test` **169/169** and the
frontend suite **81/81** (new checks: the hint cookie is set by login, cleared by
logout, never by an anonymous probe; the shell substitutes its preconnect token in
every branch and never leaks the token; category cards keep their new header; a
first-time visitor makes no `/api/customers/me` request while a hinted browser
does, and each boot GET is requested exactly once).

### ✅ Task 4 — First paint no longer waits for the stylesheet (`server.js`, `public/index.html`)
**Was.** Two render-blocking requests (the 1.3 KB pre-paint guard and the 32 KB
`storefront.css`) sat between the HTML and the first pixel. On a throttled
390x844 slow-4G profile nothing painted until **1184 ms**, and FCP == LCP: the
whole page appeared at once when the stylesheet landed. Blocking the stylesheet
by hand dropped first paint to 232–412 ms, which is what this task recovers
without giving up any styling.

**Fix.** `renderStorefrontHtml()` now concatenates `pre-paint.css` and
`storefront.css` into a single `<style>` block injected at the
`<!--__INLINE_CSS__-->` token in the head. The CSP keeps `style-src 'self'` and
adds exactly one `'sha256-<base64>'` for that block (computed at boot from the
same bytes, so an edit can never drift), and the two `<link rel="stylesheet">`
tags are gone. The standalone files are still served (immutable `?v=` caching,
the jsdom fixture, and a rollback path). `/storefront.css` cannot be cached
across documents any more, but the shell is an SPA: the second page view is a
pushState navigation, and repeat visits revalidate the document with a 304, so
no CSS bytes are re-sent.

**Two traps found while verifying (both fixed):**
1. The HTML parser normalises CRLF to LF *inside* `<style>`, so a hash taken over
   the raw file bytes never matched the parsed block. Chrome silently dropped the
   whole stylesheet and rendered an unstyled page — which is exactly what the
   first measurement showed (FCP 388 ms, CLS 0). `INLINE_CSS` is normalised to LF
   before hashing and injecting, and a headless check now asserts
   `document.styleSheets.length === 1`, the brand canvas colour and a fixed
   header on `/`, `/product/1` and `/about`.
2. Painting before JavaScript revealed a 15 px jump: the hero clears the fixed
   header with `padding-top: calc(var(--header-h, 80px) …)`, and `--header-h` is
   only published by script — the header is actually 95 px at every breakpoint,
   so the page shifted 15 px when that measurement landed (CLS 0.0199). `:root`
   now declares `--header-h: 95px`; the ResizeObserver still re-measures for the
   360 px wrap case. CLS is back to the pre-change 0.0040 (the remaining shift is
   the pre-existing text/category swap when the catalog lands).

**Verified.** Throttled 390x844 slow-4G: **first paint 1184 → 500 ms**, LCP
**1184 → 832 ms** (the hero is now bandwidth-bound, not CSS-bound), CLS 0.0040,
341 KB, no console errors, one stylesheet in `document.styleSheets`. Desktop
1440x900: LCP 220 → ~150-280 ms. Full-page screenshots at 390 and 1440 are
unchanged, `/product/1` and `/about` render styled and console-clean. `npm test`
**169/169**, frontend **81/81** — including a new e2e contract that the inline
block is byte-identical to `pre-paint.css` + `\n` + `storefront.css` normalised
to LF, that the CSP allows exactly that hash (and never `'unsafe-inline'`), and
that no render-blocking stylesheet link remains.

### ✅ Task 5 — Dead-code audit of the storefront bundle (almost nothing was dead)
**Method.** Three independent passes over `public/storefront.js` (166 functions,
164 KB raw / 45 KB gzip):
1. **Static reachability** — every function, top-level binding and `data-action` /
   `data-route` key cross-checked against its declaration, the templates in
   `public/index.html`, the strings the JS builds, and the two test suites.
2. **Runtime coverage** — Chrome's precise JS coverage over three full passes:
   a home-page load; every route (`/`, `/collection/anime`, `/product/1`,
   `/about`, `/contact`, `/returns`, `/shipping`, `/terms`, `/privacy`,
   `/tracking`, `/account`, `/checkout`, `/wishlist`) plus the JS-driven route
   changes; and every overlay/flow that is not a route (mobile menu, search,
   cart, wishlist, account modal, signup/login, review submission, tracking,
   filter/sort/search on the grid).
3. **DOM-liveness** — every `getElementById`/`querySelector('#…')` target checked
   against the markup and the strings the JS builds; every id that no longer
   exists exposes a dead branch.

**Result: the bundle is live code.** 166/166 functions are referenced, 37/37
delegated actions and all routes have handlers, every declared binding is read,
and no function is unreachable. A home-page load executes ~68% of the file's
bytes; the rest is the other routes' code, which is a *code-splitting*
opportunity, not dead weight. `public/admin.js` (98 functions) audits the same.

**Removed (the only genuinely dead code found):**
* `window.renderHomeProductCard = renderProductCard` and its "the old name still
  points at it" comment — a public alias left over from when the card renderer
  was home-only. Nothing in the page, the templates or the suites called it; the
  frontend suite now asserts it stays gone instead of asserting it equals the
  renderer.
* `|| document.getElementById('newsletterMsg')` in `subscribeNewsletter()` — a
  fallback for an element that has not existed in the markup for a long time
  (`form.parentElement.querySelector('.newsletter-msg')` is the live target).
* `window.settleBootCards = function () {…}` — only ever called from inside the
  bundle, so it is now a plain `function settleBootCards()` instead of a global.

**Verified.** `npm test` **169/169**, frontend **81/81** after the removals; the
diff is 2 insertions / 4 deletions in `public/storefront.js`. The measurement is
the point of this entry: the next byte-class win in this bundle is splitting the
route-specific half out of boot (rejected for this pass — too invasive for the
risk budget), not deleting more code.

### ✅ Task 6 — Accessibility: the tree is well-formed now, and the fixes were invisible
**Why PageSpeed said "Accessibility tree is not well-formed".** That string is
Lighthouse's `agent-accessibility-tree` audit
(`core/audits/agentic/agent-accessibility-tree.js`). It is not a bespoke check:
it re-runs axe-core and **fails if any of 34 specific rules fail** (`button-name`,
`link-name`, `label`, all the `aria-*` name/role/attribute rules, `tabindex`,
`duplicate-id-aria`, `svg-img-alt`, …). Two of them were failing on the live
homepage, so the audit could not pass no matter what the rest of the tree looked
like:
* `button-name` (critical) — the two icon-only `.cart-close` buttons in the cart
  and wishlist drawers had no accessible name.
* `aria-prohibited-attr` (serious) — `#categoryStrip` carried `aria-label="Shop
  categories"` but `aria-label` is **prohibited on a generic `div`**, so the name
  was discarded. This is exactly the "ARIA attribute that does not match the
  element" class of fault the task asked about.

The rest of the candidate causes in the brief were already clean and stayed
clean: no focusable element inside an `aria-hidden` subtree, exactly one `main`
landmark, no `aria-labelledby`/`describedby`/`controls` pointing at a missing id,
no invalid role parent/child pairs, no duplicate ids in ARIA references.

**Method.** axe-core 4.14.1 (tags `wcag2a wcag2aa wcag21a wcag21aa
best-practice`) at **390x844 (DPR 2.625) and 1440x900**, over 20 states: `/`,
`/product/:id`, `/collection/:cat`, cart drawer (with items), wishlist drawer
(with items), mobile menu, desktop search, `/checkout`, `/tracking`, `/account`
(both the sign-in dialog and the forced signed-in view), `/reset-password`,
`/verify-email`, `/order-confirmed`, `/returns`, `/shipping`, `/terms`,
`/privacy`, `/contact`, `/about`, 404. Plus a CDP accessibility-tree probe
(unnamed controls, focusable-in-`aria-hidden`, invalid roles, dangling ARIA
references, landmark/`h1` structure), and the repo's own `tests/a11y.test.js`.

**Before (homepage, identical at both widths).**

| rule | impact | nodes |
|---|---|---|
| `button-name` | critical | `.cart-close[data-action="toggle-cart"]`, `.cart-close[data-action="toggle-wishlist"]` |
| `label-content-name-mismatch` | serious | `#wishlistNav`, `button[title="Cart"]`, every `.product-card[aria-label="View …"]` |
| `region` | moderate | `.whatsapp-float` (last floating action, outside every landmark) |
| `aria-prohibited-attr` *(needs review)* | serious | `#categoryStrip` |
| `color-contrast` *(needs review)* | serious | `.why-item h3/p` — axe cannot resolve a gradient background |

Once the home page was clean, the same harness over the other routes added:
`page-has-heading-one` (collection, checkout, tracking, reset, verify — no `h1`
on those routes at all), `heading-order` (collection filter headings, content
pages, contact cards, cart/wishlist drawer item names), `link-in-text-block`
(returns/terms/privacy) and `aria-dialog-name` (the sign-in card).

**Fixes — one line each.**
1. `button-name` — the cart and wishlist close buttons now say "Close cart" /
   "Close wishlist" (`type="button"`, decorative `<svg aria-hidden="true">`).
2. `aria-prohibited-attr` — `#categoryStrip` is a `role="region"` labelled "Shop
   categories", so the `aria-label` is legal and the strip is a named landmark
   (its `tabindex="0"` is the scrollable-region keyboard affordance and stays).
3. `region` — the WhatsApp button sits inside `<aside class="whatsapp-dock"
   aria-label="WhatsApp support">`; the link keeps its class, so every
   `body:has(…) .whatsapp-float` rule still applies and the fixed positioning is
   unchanged.
4. `label-content-name-mismatch` (nav) — the visible count badge is now part of
   the name: "Wishlist, 0 items" / "Shopping cart, 0 items", re-synced by
   `syncBadgeLabel()` whenever the count changes.
5. `label-content-name-mismatch` (cards) — the card's `aria-label="View …"` is
   gone; a `role="link"` card is named by its own content, so the announced name
   now *is* the visible text (name, fit, rating, price).
6. `aria-dialog-name` — the sign-in/sign-up card is `aria-label="Sign in or
   create an account"`.
7. `link-in-text-block` — inline body links (`.link-accent`) are underlined; this
   is the **only visible pixel change** in the task. The storefront accent
   `#4A4433` sits at **1.09:1** against the surrounding body copy `#4F493F`
   (both pass 6.5:1 against the page background, so the text was readable — it
   was only *unmarked*), and WCAG 1.4.1 needs a non-colour cue or a colour
   change, which would have altered the palette.
8. `page-has-heading-one` — every route now has exactly one `h1`: the collection,
   tracking, reset, verify, checkout and confirmation titles were `h2`; the
   account page gained an `sr-only` "Your account" `h1`.
9. `heading-order` — the levels below those `h1`s were renumbered so no page
   skips a level: filter sections `h4 → h2`, content-page sections
   `h3 → h2` (27 headings), contact cards `h3 → h2`, checkout sections
   `h3 → h2`, cart/wishlist drawer headers `h3 → h2` and their line items
   `h4 → h3`, account cards `h3 → h2`. Every affected stylesheet selector was
   retargeted with `:is(h2, h3)`/`:is(h2, h4)` in the same commit, so the
   declarations that style them are byte-for-byte the same.
10. `color-contrast` (needs review, 6 nodes) — verified by hand instead of
    "fixed": the section's background is `--bg-secondary` `#C4BEB0` with a 1 px
    `--border-subtle` hairline (that hairline is *why* axe cannot resolve a
    gradient). `#1A1815` headings measure **9.57:1** and `#3D3931` body copy
    **6.20:1** on that background — both pass AA.

**No visual change — checked, not assumed.** The task's constraint was "fix
without changing the visual design", so the change was verified by diffing every
element's painted geometry and computed type between `ba934a7` and the working
tree: 13 routes x 2 viewports, capturing tag-independent signatures (rect,
font-size/weight/family/line-height/letter-spacing, colour, decoration, margins,
padding, transform, display). Every route is identical except three known items:
the intentional `.link-accent` underline, the new zero-height `.whatsapp-dock`
aside, and the new `id="cartNav"`/`sr-only` nodes. The top-bar marquee was not
touched (only skipped in the diff because its position is animation-dependent).

**After.** axe-core **0 violations in all 20 states at both widths** (the two
needs-review items are the manual contrast verification above and nothing else);
accessibility-tree probe **0 problems** (one `h1` per rendered page, every
control named, one `main`, no aria-hidden focus traps, no dangling references);
`tests/a11y.test.js` unchanged and green (148/175/175 contrast pairs, every
outline reset paired, 41 selectors re-tested by real click + Tab). Full suite
before and after: `npm test` **169/169** API, rate-limit, regressions, upgrade
migration and mail suites, frontend **81/81**, a11y **all green** (the two h3
selectors in the frontend suite that referenced the renumbered content-page
headings were widened to `h2, h3` in the same commit).

**After deploying:** nothing to run — this is static markup and CSS, and the CSP
`style-src` hash is recomputed from the CSS bytes at boot. Re-run PageSpeed
Insights on the deployed URL to see Accessibility 100 and "Accessibility tree is
well-formed"; the only thing to eyeball is the new underline on the five inline
links in Returns/Terms/Privacy, in case the owner prefers a different
non-colour cue.

### ✅ The Filter panel's categories are the navbar's categories (owner request)
**Reported:** "change the categories to the ones in the navbar" (screenshot of the
shop sidebar showing *Anime-Inspired / Japanese Art / Typography*).

**What was wrong.** The sidebar's Category group was a leftover *style*
taxonomy — `Anime-Inspired`, `Japanese Art`, `Typography` — that **no product
has**. `mapApiProducts()` invented a `style` for every product
(`['Anime-Inspired','Japanese Art','Typography'][id % 3]`), so the filter
picked up a synthetic value and the list looked real. The real taxonomy is the
one the navbar links to: **Graphic Tees · Anime Shirts · Pants**
(`CATEGORY_OPTIONS`, mirroring the admin form and the API's validation).

**Fix.** `FILTER_CATEGORIES` is now derived from `CATEGORY_OPTIONS` and the
panel markup is generated from it, so the filter lists exactly the navbar
categories and a new category appears in both places or neither. The filter
compares against `p.collection` — the same field `/collection/<slug>` and the
navbar already filter on — instead of the invented `style`, which is gone
along with the fake fallback in `mapApiProducts()` and its use in the search
haystack.

Two behaviour details that follow:

- **The checkboxes follow the route.** Opening a category ticks that category
  (All/New/Sale tick all three), so the panel never claims to be filtering by
  something the grid is not.
- **"Is the panel untouched?" is answered against the route, not a tick
  count.** The friendly *"No pants available right now"* empty state and the
  active-filter badge both use `categoryFiltersFollowRoute()`; before, a
  deep link to an empty category showed the generic "No products match your
  filters" and reported two filters active on a page nobody had filtered.

**Kept deliberately:** no category ticked means *no narrowing* (the full list),
which is how this filter has always behaved — unticking everything must not
look like an empty catalog.

**Verified.** `npm test` **171/171**, frontend **84/84** (the drawer scenario now
pins the three options, their labels, that the stale styles are gone, that a
single tick narrows to that category, that ticking all three restores the
catalog, that no tick keeps it, and that the ticks track the route), a11y
green. Checked in Chromium at 1366 px and 390 px: the sidebar and the mobile
Filter drawer both list the three navbar categories.

### ✅ Order history shows every order and opens into full order detail (owner request)
**Reported:** "make it so that when a customer has logged in then they can see all
their orders and also full details of their orders".

**What was wrong.** Two things, both on `/account`:

1. the API (`GET /api/customers/orders`) returned a *summary* only — number,
   status, payment method, items, subtotal/shipping/total, date — so the page
   had nothing to show for the delivery address, phone, notes, payment
   reference or whether the payment had been verified;
2. the page rendered those summaries as one flat, non-interactive
   `.order-row` strip: no item list, no sizes, no quantities, no line totals,
   no address, and nothing to click.

**Fix.**

- `sanitizeCustomerOrder()` now also returns `address`, `city`, `phone`,
  `notes`, `customer_name`, `payment_ref`, `payment_verified` and
  `cod_confirmed` (all `null`-safe), on top of the existing allow-list. It is
  still an allow-list: `customer_id`, `items_json`, cost and stock never leave
  the server.
- Each order is an expandable card: a `<button aria-expanded aria-controls>`
  header (number / status pill / total / date + item count) over a panel with
  the item table (thumbnail, name, **size, quantity, unit price, line total**),
  a summary (subtotal, delivery — "Confirmed by phone (Rs. 250 – Rs. 500)" while
  it is pending — and total), the payment method plus reference and verified
  state, the delivery address and phone, notes, and a Track-this-order link.
  Collapsed rows keep their markup in the DOM, so opening is instant and the
  panel is a plain `hidden` toggle rather than an animation.
- Every value from the API is passed through `esc()`.
- New `.order-status.awaiting_verification` pill (that status previously had
  **no** styling at all, so it rendered as bare text), 44px tap targets, and a
  ≤640px layout that keeps the total pinned right and the item row on one line.

**New endpoint, `GET /api/customers/orders/:number`.** Full detail for one order
for API clients, scoped to the caller's own history: another customer's number
answers **404** (not 403) so it cannot be used to enumerate order numbers,
unverified accounts get **403**, and anonymous callers **401**.

**Verification gate unchanged (deliberately).** An unverified account still
gets an empty list — the address may not be theirs — with the existing banner
and a resend link; the empty state now says *"Verify your email to see your
orders"* instead of the misleading "No orders yet". `tests/e2e.test.js` keeps
its anti-takeover checks for this.

**Verified.** `npm test` **171/171** API (new check: every owned order is
listed newest-first, the detail endpoint returns the delivery/payment facts,
a stranger's number is 404, unverified is 403, anonymous is 401, tracking still
needs the phone) and frontend **84/84** (rewritten scenario 19: two orders both
render, rows are collapsed by default, expanding shows sizes/qty/line
totals/subtotal/delivery/total/address/notes/reference, pending delivery
labelled honestly, hostile `items_json`/address/notes values are escaped, a
`null` payload falls back to the empty state). a11y suite green — audited as
part of the same change: the new Track-this-order hover was reworked to
ink-on-transparent (accent text on an accent fill measured 1.00:1, and an accent
tint behind accent text 4.46:1, both under the floor), and the contrast harness
now excludes the four `--text-on-*` inverse tokens from the blanket
token × surface sweep, since they exist only on explicit fills (CTA, status
pills) and were being checked against surfaces they never sit on. Rendered in
Chromium at 1280px and 390px.

### ✅ Transactional emails restyled for readability (owner request)
**Reported:** "can you change the style of the email sent currently it is difficult
to read the text" (with a screenshot of the order-status email).

**What was wrong.** The old templates were 15px copy in a 560px card on the dark
olive canvas (#D9D4C8), with muted greys that were genuinely hard to read:
the small print #8A8578 on white measured **3.68:1** and the panel labels
#504C47 on #C4BEB0 **4.6:1** — both below the 4.5:1 AA floor at those sizes.
They also asked for `font-family:'Archivo'`, a webfont mail clients never load,
so text fell back to whatever the client had.

**Fix — one shared layout, `emailShell()` in `utils/email.js`, used by all four
templates** (order confirmation, status update, verification, password reset;
the reset template is now `passwordResetEmailHtml()`, shared by the customer and
admin flows instead of being inlined in `routes/auth.js`):

- light "paper" ground (#EFEBE2) with a white 600px card — a document, not a
  dimmed poster; 4px olive rule across the top keeps the brand;
- 16px body copy at 1.65 line-height, 15px table cells, 13px small print;
- AA/AAA colours throughout: ink #1A1815 on white **17.7:1**, muted #5A5445 on
  white **7.5:1** (6.2:1 on the panel), white on olive CTA **9.7:1**;
- a client-safe font stack (system UI → Segoe → Roboto → Helvetica → Arial), no
  webfont dependency;
- table-based layout with `role="presentation"`, explicit widths, a mobile
  viewport meta and `color-scheme: light only`, so Gmail/Outlook/iOS render the
  same card; order numbers use `white-space: nowrap` so they never break;
- content upgrades: the status email explains what the new status means ("Your
  order is on its way…") and gains a **Track Order** button (SITE_URL-only, no
  guessed links); confirmations gain a real totals table with an emphasised
  total row; reset/verify emails get a button *plus* the pasteable link, and the
  reset email states the password minimum. All customer values stay escaped.

**Verified.** Rendered all four templates in Chromium at 600px and 390px
(screenshots in the PR); `npm test` **170/170** API (a new check pins the
layout/contrast contract for every template), frontend **84/84**, a11y green.

### ✅ Password reset has a real GUI, Enter signs in, and mail messages say to check spam (owner request)
**Asked for:** "add a gui for the reset password and also make it so when i press
enter it signs in also add a message that says check spam whenever a mail is sent
on whichever section".

**1. Reset-password GUI.** Both "Forgot password?" links opened a browser
`prompt()` and then an `alert()`. They now open real, in-page forms:

- Storefront: the account modal gained a third view (`#custResetView`, a
  `<form data-form="cust-reset-request">`) with an email field, **Send Reset
  Link**, an inline error area and a "Back to sign in" link. The sign-in email
  is carried over, and the view is reachable from both the modal link and the
  old `data-action="request-pw-reset"` delegate. No `prompt()`/`alert()`
  remains in `storefront.js`.
- Admin panel: `#loginResetView` (`data-form="admin-reset-request"`) swaps into
  the same login card, with the same fields/behaviour, a back link and Escape
  to return. No `prompt()`/`alert()` remains in that flow either.
- Both show an in-page confirmation instead of an alert, and the branded
  `.cust-note` / `.sent-note` block keeps the design language. The set-password
  page (`/reset-password?token=…`) already existed and is unchanged — verified
  end to end with a real token.

**2. Enter signs in.** The views were plain `<div>`s with click-only buttons
(the sign-in flow had no key handling at all). They are now real `<form>`s, so
Enter in any field submits: storefront sign-in, sign-up, reset request; admin
sign-in and reset request; and the account page's change-password card. The
admin's two per-field `keydown` handlers were deleted — they would have fired
*in addition to* the native submit and double-posted against the login rate
limit. Submits are cancelled before the async handlers run (that was a real bug
found while testing: without `preventDefault()` the browser performed a native
submit and reloaded the page). Enter now produces exactly one
`POST /api/customers/login` / `/api/admin/login` in Chromium.

**3. "Check spam" wherever mail is sent.** The hint is tied to the branch that
actually sends, never to the generic anti-enumeration answer:

- reset request → *"Reset link sent. Check your inbox and the spam folder — it
  can take a minute to arrive."* (unknown address still gets the identical
  generic line, so no account enumeration);
- signup → *"…Check your inbox and spam folder for the verification link…"*;
- resend verification → *"…Check your inbox — and the spam folder, just in
  case."*;
- the in-page reset confirmation and both panels' toasts carry the same advice.

**Verified.** Real Chromium: storefront + admin reset requests fire once on
Enter with no native reload, the confirmation renders (desktop and 390px phone,
card 359px, no horizontal scroll), and a token from a real reset email drove
`/reset-password` to a successful update followed by an admin sign-in with the
new password. Frontend **84/84** (two new scenarios: storefront reset GUI / Enter
/ spam copy, and the admin card), `npm test` **169/169** API, a11y suite green
(181 contrast pairs).

### ✅ Navigation links moved into the hamburger panel at every width (owner request)
**Asked for:** "make the navbar options into hamburger options like they were
before". The Phase 2 header had put the eight links back inline in a centred
row above 1023 px (`.nav-links { display: flex !important }` in the
`@media (min-width: 1024px)` block) and hid the hamburger there.

**Change.** The panel is now the only home for the links, mobile *and* desktop:

- `.nav-links.open` moved out of `@media (max-width: 1023px)` into the base
  sheet, so one open-state rule serves every width (opaque, `max-height:
  calc(100dvh - 95px)`, internal scroll, `z-index: 1001`).
- The ≥1024 px block no longer turns the list into a row; it hides nothing and
  keeps the hamburger (`display: flex`). `display: flex !important` and
  `.hamburger { display: none }` are gone — a test now fails if either returns.
- Desktop panel: right-aligned to the icon cluster (32 px gutter, 24 px at
  1024 px exactly), 320 px wide, 12 px padding, rounded, 44 px rows with the
  panel's own tinted hover pill. The unused compact-desktop link-gap/type
  rules (`18px`/`16px` gaps, 12 px tracking hacks) were deleted.
- The panel's search row is no longer mobile-only: `.mobile-search` is `block`
  (it lives inside the hidden panel, so nothing shows until the menu opens) and
  is 100 % wide, which gives desktop users search inside the menu too. The bar's
  search icon still opens the wide inline field.
- Logo, icon buttons, cart/wishlist counts, the 95 px bar, the marquee and
  `#categoryStrip` are untouched.

**Behavior carried over unchanged:** hamburger toggle, `aria-expanded` /
`aria-controls` wiring, X animation, body scroll lock, outside-tap close,
Escape → focus back to the trigger, Tab trap, and `data-close-menu` on link
click. All of it now also runs at desktop widths (the JS never had a width
check — only the CSS did).

**Verified.** Real Chromium at 1024/1025/1100/1148/1279/1280/1366/1536/1920:
list collapsed (`display: none`), 44 px hamburger last in the icon cluster,
panel opens under the bar right-aligned to the icons, all eight links stacked
with 44 px rows, Escape/outside tap/link click all close it. Screenshots at
1366x780, 1440x900 and 390x844 (closed + open) show the same header bar as
before with the links in the panel. `npm test` **169/169**, frontend **82/82**
(the desktop nav scenario was rewritten for the panel contract and the new
desktop open/close/search checks were added), a11y suite green.

### ✅ Hero restored to the full 16:9 campaign frame (live-site regression)
**Reported from the deployed site:** "the hero image is messed up". It came from
the Nov 23 Phase 2 batch, not from the perf pass — the pass changed no hero
pixels (verified by rendering `67e87c8` and `de90b12` side by side: identical
geometry, 388 px frame at 1366x693 in both).

**Cause.** `2e0760b` added `max-height: 56vh` to `.hero-media img`. The campaign
art is 16:9, so on a landscape screen the frame collapsed from 768 px to 388 px
and `object-fit: cover` zoomed the photo ~2x, cutting the model and most of the
wall art. The spray-paint border is drawn for 16:9 and is `object-fit: contain`,
so it was also letterboxed inside the wide frame instead of hugging the photo.

**Fix.** Removed the clamp: the hero is the art's own 16:9 box again (1366 x 768
at that width, 219 px on a 390 px phone — phones were never clamped, so they are
unchanged) and the border frames the picture again. `height: auto` stays: the
`width`/`height` attributes added for CLS are presentational height hints and
would beat `aspect-ratio` without it. A new test fails the build if any
`max-height: Nvh` clamp returns to `.hero-media img`.

**Header left alone.** The 影 KAGE — CULTURE — wordmark (`25f5ceb`) is unchanged
on the owner's instruction; the header renders exactly as it did before this
commit (95 px bar, logo 52.8 px desktop).

**Verified.** Rendered against the pre-Phase-2 tree (`2e0760b~1`) at 1366x693:
hero frame 768 px, hero block 1102 px, copy offset 875 px — identical to that
tree (388 / 722 / 495 before the fix). Mobile 390x844: full 16:9 hero, wordmark
logo, 44 px targets, one row. `npm test` **169/169**, frontend **81/81**, a11y
suite green.
