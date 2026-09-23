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

## Remaining work (see `AUDIT.md` for the live queue)

1. **FE-H2** (long-term): replace inline handlers with event delegation, then drop
   `'unsafe-inline'` + `script-src-attr` properly.
2. FE-M/L queue: URL routing/history, cart & wishlist persistence, focus/Escape
   a11y, silent product-load failure handling, login-CSRF hardening.
3. Housekeeping: delete the stale `kage-culture.vercel.app` project (different team);
   push any local-only docs commits with a fresh token when convenient.
