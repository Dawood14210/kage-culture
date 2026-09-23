# KAGE CULTURE — Website Audit & Fix Log

> Audit date: 2026-09-20 · Scope: Express API + vanilla-JS SPA storefront + admin panel,
> dual-backend DB (Turso / sql.js / in-memory), deployed on Vercel serverless.
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

---

## Remaining work (priority order)

*Nothing open — C1, H1–H4, M1–M7 and L1/L3–L7 were all completed on 2026-09-23 (see
"Completed work — 2026-09-23 session" above). Only **L2** remains, and it's a
deployment decision, not a code fix:*

- **L2.** ~25 product images/videos (9.3 MB of mp4s) are **untracked** — a deploy from
  another machine 404s them. Commit, or move videos off-repo. Note `vercel.json`
  bundles all of `public/**` into the lambda (slows cold starts).

---

## Suggested fix order

1. ~~Fix `requireAuth` / `requireCustomerAuth` signature verification~~ ✅ done
2. ~~C1 — gate admin setup, remove storefront auto-setup~~ ✅ done
3. ~~H1 — lock down `GET /api/orders/:orderNumber`~~ ✅ done
4. ~~H4 — `npm audit fix` + multer 2.x + `/api/upload` fileFilter; M1 `trust proxy`~~ ✅ done
5. ~~H2, H3 — data-loss + email reliability on serverless~~ ✅ done
6. ~~Then mediums/lowers in order of annoyance~~ ✅ done (except L2, above)
