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
- **Live checks passed:** storefront 200 (one transient 503 on the very first cold hit), health ok, setup gate open (400 not 403), order PII phone-gate 401, vendor Chart.js 200, CSP clean (no unpkg / no script-src-attr), `/reset-password` shell present, `/admin.html` 301 → `/admin`.

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
  only the admin-login overlay handles Escape — customer login, wishlist drawer and most
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

---

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
- **FE-M1.** URL routing/history (pushState, deep links, real 404) — unblocks the
  sitemap half of L6.
- **FE-M2.** Persist cart (and wishlist) to localStorage.
- **FE-M3.** De-duplicate checkout payment-radio listeners.
- **FE-M4.** Fix cart-badge bump selector.
- **FE-M5.** A11y: focusable nav/tiles, Escape + focus-trap on all overlays, remove
  `user-scalable=no` from admin.
- **FE-M7.** Surface product-load failures instead of silently serving the fallback
  catalog.

### 🔵 Low
- **FE-M6.** Micro-typography legibility (topbar/wordmark).
- **FE-M8.** manifest `background_color` vs light theme; `fmt()` on totals; spin popup
  re-trigger on confirmation re-render.
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
10. FE-M1 + FE-M2 — routing and cart persistence (biggest UX wins)
11. Remaining FE-Ms in order, then L2 (deployment decision)
