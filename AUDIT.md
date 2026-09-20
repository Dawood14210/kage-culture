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

## Remaining work (priority order)

### 🔴 Critical

**C1. Admin bootstrap race + storefront auto-setup** — `routes/auth.js:16-27`
`POST /api/admin/setup` is check-then-insert with no locking: two concurrent requests on a
fresh DB both create admins. Worse, `public/index.html:6617` makes the *storefront* login
modal call setup automatically — whoever logs in first on a fresh / in-memory deployment
becomes admin (every Vercel cold start without Turso).
→ Gate bootstrap behind an explicit env-gated one-time action; use atomic insert
(`INSERT ... ON CONFLICT DO NOTHING` semantics). Remove the auto-setup call from
`public/index.html:6617` (and same pattern in `admin.html:1409`).

### 🟠 High

**H1. Public order endpoint leaks PII** — `routes/orders.js:58`
`GET /api/orders/:orderNumber` returns name, address, city, payment method/ref with **no
auth and no phone check**. `/track` requires matching phone — do the same here.

**H2. Vercel-without-Turso silently loses all data** — `database.js`
The pure-JS mem-store fallback resets on every cold start, and its regex "SQL" shim silently
mangles queries (`GROUP BY`, `ORDER BY`, multi-arg `UPDATE` WHEREs; `DELETE` always reports
0 changes) → orders/stats/clan/spin logic quietly wrong.
→ Fail loudly at boot (or gate the site) when `VERCEL && !TURSO_DATABASE_URL`.

**H3. Emails may never send on serverless** — `routes/orders.js:96` (+ status emails)
Fire-and-forget promises **after** `res.json()`; Vercel can freeze the function before they
resolve. → `await` before responding or use `waitUntil`.

**H4. Dependencies & upload filter**
- `npm audit`: 3 moderate via `qs`/`express` → `npm audit fix`
- **multer 1.4.5-lts.1** has known 2025 DoS CVEs → upgrade to `^2.0.2`
- `/api/upload` (`routes/admin.js:55`) has **no `fileFilter`** — only the products route
  validates image type. Add the same JPEG/PNG/GIF/WebP/SVG filter.

### 🟡 Medium

- **M1.** Rate limiting is IP-keyed behind Vercel's proxy — add `app.set('trust proxy', 1)`;
  without it all visitors share the proxy IP and the 120/min global limit can knock the
  whole site over (`server.js`).
- **M2.** Stock decrement not atomic (`routes/orders.js:44-46`): SELECT-then-UPDATE race →
  overselling. Use a transaction / `UPDATE ... WHERE stock_qty >= ?`.
- **M3.** Dead inline session cookies (see discovery above): remove the manual
  `Set-Cookie` blocks in `routes/auth.js` (lines ~45, ~125) — also resolves the missing
  `Secure` flag and double-set issues.
- **M4.** CSP (`server.js:34`): remove unused `https://unpkg.com` from `scriptSrc`;
  drop `scriptSrcAttr 'unsafe-inline'`.
- **M5.** 500s return raw `err.message` across all routes — leaks SQL/paths. Return generic
  messages; log details server-side.
- **M6.** XSS consistency: most rendering uses `esc()` (good), but `innerHTML`
  interpolations skip it at `index.html:5018` (cart), `:5105` (confirmation),
  `:6169/6177` (image URLs in attributes), `admin.html:1628/1636`. Inputs are
  admin-controlled today — fix the pattern before it becomes stored XSS.
- **M7.** Static caching: `server.js:76` sets `maxAge: 0` for all static assets — cache
  immutable `images/` + fonts for a year.

### 🔵 Low / Hygiene

- **L1.** Repo debris — delete or gitignore: `.tmp-final-1786883984768/`,
  `.tmp-final-clean.js`, `.tmp-rewrite-spirit.js`, `screenshot-*.mjs`.
- **L2.** ~25 product images/videos (9.3 MB of mp4s) are **untracked** — a deploy from
  another machine 404s them. Commit, or move videos off-repo. Note `vercel.json`
  bundles all of `public/**` into the lambda (slows cold starts).
- **L3.** `database.js` header comments claim sql.js "file persistence (kage.db)" but
  `save()` is a no-op — local dev data resets every run. Fix comment or implement save.
- **L4.** `/admin.html` is served statically without auth (only the `/admin` route is
  guarded). APIs still protected — harmless but unintended.
- **L5.** `public/manifest.json` `theme_color` `#0D0D0D` (dark) contradicts the site's
  `#D9D4C8` (warm light).
- **L6.** SEO/a11y: sitemap lists only `/` while products are client-rendered; product
  cards / gallery dots are `div onclick` without keyboard handlers; quick-view buttons
  invisible until hover.
- **L7.** Zero tests — at minimum add permanent regression tests for `requireAuth` /
  `requireCustomerAuth` (see verification table above) and order placement.

---

## Suggested fix order

1. ~~Fix `requireAuth` / `requireCustomerAuth` signature verification~~ ✅ done
2. C1 — gate admin setup, remove storefront auto-setup
3. H1 — lock down `GET /api/orders/:orderNumber`
4. H4 — `npm audit fix` + multer 2.x + `/api/upload` fileFilter; M1 `trust proxy`
5. H2, H3 — data-loss + email reliability on serverless
6. Then mediums/lowers in order of annoyance
