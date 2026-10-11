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
The manual `Set-Cookie: kage.session/kage.cust` blocks (admin login, customer signup/login) are gone; sessions rely solely on cookie-session's signed pair. Logout's `kage.cust` clear is kept.

### ✅ M4 — CSP cleanup — `server.js`
Removed unused `https://unpkg.com` from `scriptSrc` and dropped `scriptSrcAttr 'unsafe-inline'`. Also removed the dead Phosphor icons `<script>` tag from `index.html` (zero `ph-*` classes used) — one less third-party supply-chain surface.

### ✅ M5 — Generic 500s (FIXED) — all routes
Every `catch` now logs details server-side (`console.error`) and returns a generic message; the health check no longer echoes `err.message`.

### ✅ M6 — XSS escapes + keyboard a11y (FIXED) — `public/index.html`, `public/admin.html`
`esc()` applied to: gallery images & thumbnails, cart & checkout item images, wishlist drawer (name/fit/img, and removed the product-name-in-onclick injection vector), spirit selector/editorial/result images, hero tiles, collection tiles, admin product previews. Product cards/collection tiles/thumbnails got `role`/`tabindex`/`aria-label` + Enter/Space handlers; gallery dots are real `<button>`s with delegated click handling; quick-view buttons are focus-visible.

### ✅ M7 — Static caching — `server.js`
Immutable-ish assets (`images/`, fonts, icons) now cache `max-age=31536000`; HTML remains `no-cache, no-store`.

### ✅ L1 — Repo debris deleted
Removed: `.tmp-final-1786883984768/`, `.tmp-final-clean.js`, `.tmp-rewrite-spirit.js`, `screenshot-scroll.mjs`, `screenshot-ref.mjs`, `screenshot-phase2-debug.mjs`.

### ✅ L3 — database.js header comment corrected
No longer claims `kage.db` file persistence; documents that local sql.js is in-memory and resets on exit.

### ✅ L4 — Single canonical admin entry — `server.js`
`/admin.html` → 301 → `/admin` (redirect runs before the static middleware). `admin.html` is the login page, so it stays public by design; the APIs behind it are the protection.

### ✅ L5 — manifest theme_color
`#0D0D0D` → `#D9D4C8` (matches the site's warm light theme).

### ✅ L6 — SEO/a11y
Keyboard/AT access fixed (see M6). Sitemap left as-is: the storefront is a client-rendered SPA with in-page routing only (no per-product URLs exist), so there is nothing to list yet.

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
  shell with no 404. This is also what keeps the sitemap at `/` only (see L6) and the
  canonical/OG tags hardcoded to the vercel.app domain.
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
- Client pages/products/collections use URLs + Back/deep-link restoration; unknown paths
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
rendered non-native controls, broader SEO/server-rendered metadata, and L2 video
cold-start optimization. Do not mark these done without a browser/CSP migration.

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
(the old `cat-*.jpg` files stay on disk, unused). Layout: a single column below
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
request path and discloses that self-service unsubscribe is not available. The app uses
`kage.session`; `kage.cust` is only a legacy auth fallback/cleared on logout, not issued by
current login. No automated courier API/integration was found in this repo; the delivery
partner clause reflects the requested operational disclosure.

`tests/frontend.test.js` covers these policy details. `npm test` → 57/57 API + 17/17
frontend scenarios passed.

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
  ⬜ dynamic controls/remaining dialog semantics merit a full keyboard/browser pass.
- **FE-M7.** ✅ catalog failures are visible and disable cart/checkout until retry.

### 🔵 Low
- **FE-M6.** Micro-typography legibility (topbar/wordmark).
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
11. FE-H2 CSP migration, remaining a11y/visual checks, then L2 (deployment decision)
