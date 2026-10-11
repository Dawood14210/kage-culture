# AGENTS.md — Instructions for AI coding sessions

## Read first, every session

1. **Read `AUDIT.md` at the start of every session.** It is the running security audit +
   fix log: what was already done, what's broken, and the prioritized work queue
   (C1 → H1–H4 → M1–M7 → L1–L7). Continue from the top of the "Remaining work" section
   unless the user says otherwise.

## Project orientation (quick facts)

- **Stack:** Express + vanilla-JS SPA storefront (`public/index.html`) + admin panel
  (`public/admin.html`), dual-backend DB in `database.js` (Turso in prod, sql.js local,
  in-memory fallback), deployed on Vercel serverless (`vercel.json`).
- **Config:** all magic numbers live in `config.js` — use them, don't hardcode.
- **Security invariants (do not regress):**
  - Session cookies (`kage.session`, `kage.cust`) MUST be signature-verified —
    see `readSignedSession()` in `middleware/auth.js`. Never trust a decoded
    base64 payload without verifying its HMAC.
  - Admin/product/order mutation routes require `requireCsrf` + `requireAuth`.
  - One-time data steps (demo seed, seed sale prices, unit-cost backfill) run
    **once per database** via `app_settings` keys — never per cold start. A
    shop's catalogue is owned by the admin panel; never re-seed or re-apply
    prices on boot.
  - `SESSION_SECRET` must be resolved through `utils/secret.js#getSessionSecret()`
    — never inline a `process.env.SESSION_SECRET || '...'` fallback anywhere.
    The dev fallback is allowed only when `NODE_ENV` is exactly `development`
    or `test`; every other case (including unset) exits at boot.

## Session conventions

- Dev server: port 3000 is often occupied — use `PORT=3999 node server.js` for testing.
- Background servers don't survive between tool calls in this environment — run the
  server and its tests in a single shell command, then kill it.
- Repo debris (`.tmp-*`, `screenshot-*.mjs`) is untracked and should stay uncommitted;
  deleting it is on the audit list (L1).
- When a work item from `AUDIT.md` is completed, update `AUDIT.md`: mark the item done
  and record what changed + how it was verified.

## Status snapshot (2026-09-23)

- ✅ CRITICAL admin auth bypass fixed in `middleware/auth.js` (HMAC verification,
  constant-time compare, 7/7 e2e tests passed).
- ✅ **Full audit queue cleared (2026-09-23):** C1 (admin setup gated behind
  `ALLOW_ADMIN_SETUP=true`, atomic insert, storefront auto-setup removed), H1
  (public order endpoint requires phone match), H2 (Vercel without Turso now
  fails loudly at boot — 503, no silent in-memory data loss), H3 (emails awaited
  before responding), H4 (audit clean, multer 2.x, /api/upload fileFilter),
  M1–M7, and L1/L3–L7. Details + verification in `AUDIT.md`.
- ✅ Permanent regression suite: `node tests/e2e.test.js` (14/14) — auth
  middleware, setup gate, order PII phone-gate, stock decrement, CSRF. Run it
  after any auth/order/database change.
- ✅ **Frontend FE-criticals fixed (2026-09-23, later session):** FE-C1 (product cards
  route through `openProductDetail`), FE-C2 (`GET/PUT /api/customers/me` implemented —
  PUT handles both profile + password-change shapes), FE-C3 (Chart.js self-hosted in
  `public/vendor/`, CSP-safe), FE-C4 (`/reset-password` view + flow), FE-H1 (grid attrs
  escaped). Test suite is now **28/28** in `tests/e2e.test.js`.
- ✅ **Wishlist heart UX (2026-09-25):** hearts turn red + pop once when favoriting
  (CSS in `public/index.html`; details in `AUDIT.md`).
- ✅ **Track-order page fixed (2026-09-25):** submit button re-enables after failed
  lookups, cancelled orders show a terminal state (not a live timeline),
  `awaiting_verification` maps to Confirmed with an explainer, dates humanized.
- ✅ **Responsive hardening (2026-09-25):** storefront ≤540px (track timeline stacks
  vertically, checkout rows collapse, nav-dropdown row heights fixed) + ≤360px header
  wrap; admin rows become wrap-cards ≤768px (column legend hidden), `user-scalable=no`
  removed. Suite is now **30/30** in `tests/e2e.test.js`.
- ✅ **Frontend repair (2026-10-10):** admin filters, stock/sale contract, Goofy Wears
  catalog, pagination, API failure state, cart/wishlist persistence, history/deep links,
  return messaging, dialog keyboard access, and dependency advisories addressed.
  Product image writes support Vercel's store-prefixed Blob token and fail clearly
  without storage; `npm test` covers 38 API + 10 DOM-level scenarios, including
  bulk product deletion and Quick Upload stock quantities. See `AUDIT.md`.
- ⬜ Remaining: FE-H2 CSP migration (do not drop unsafe-inline without replacing
  handlers), browser/device visual QA, dynamic-control a11y, FE-M6 typography, L2 media.
