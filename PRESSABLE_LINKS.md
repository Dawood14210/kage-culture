# PRESSABLE LINKS — what every clickable thing does

**Scope:** every pressable element in the customer storefront (`public/index.html`) and the admin
panel (`public/admin.html`) of this repo.
**Commit examined:** `997bcc8` (branch `arena/53d9ef4a-kage-culture`), 2026-10-11.
**How it was verified:** code reading + jsdom probes that simulated real clicks (cookie-aware so
POSTs pass CSRF) + the repo's own suites (`npm test` → **57/57 API + 17/17 frontend** all green).

Legend: **✅** works as labelled · **⚠️** works but with a caveat · **🛑** dead/unreachable/broken.

---

## 0. Read this first — 8 findings

1. **🛑 The entire collection/shop grid is invisible.** `#shopSection` (index.html:3999) carries an
   inline `style="display:none;"` and **no code path ever removes it** (only CSS rule on it is
   `.shop-section { padding: … }` at :2122; nothing with `!important`). So every control that
   filters, sorts, paginates, searches, or shows a collection renders into a hidden section:
   *"Shop the Drops"*, Anime Shirts, Pants, "View All", "Explore Collection", the desktop/mobile
   search box, the filter sidebar/drawer, sort, next-page — all update URL, titles and the DOM, and
   the user sees nothing new. This is the single biggest issue in this report.
2. **✅ FIXED (2026-10-11) — was: the admin sign-in modal couldn't be opened.** The storefront modal
   and its handlers were dead code (nothing called them), so they were **deleted**; `/admin` keeps
   its own login page as the single entry (and `/admin.html` still 301-redirects to `/admin`).
   See `PROJECT_LOG.md` §19.
3. **⚠️ "Pants" nav link is a placeholder.** index.html:3804 links to `/collection/all`, so it
   opens "FEATURED DROPS | NEW ARRIVALS" (all products), not pants. It's also the only nav item
   without `data-nav`, so "Home" stays highlighted while you're "in Pants".
4. **⚠️ Graphic Tees always shows Coming Soon**, regardless of stock (hard-coded in
   `navigateTo()`: `if (filter === 'graphic-tees') target = 'coming-soon'`).
5. **⚠️ Two homepage loaders are dead code.** `loadNewArrivals()` and `loadCollections()` target
   `#newArrivalsGrid` / `#collectionsGrid`, which no longer exist in the markup — they silently
   no-op. Only Best Sellers and Recently Viewed render on Home.
6. **⚠️ Some content is unfinished**, visible to customers: Contact page shows
   *"Working hours: TODO — [hours not provided]"* (index.html:4648) and Shipping shows
   *"Free-shipping threshold: TODO"* (index.html:4426). Neither is clickable, but both are on
   customer-facing pages.
7. **⚠️ Deep link `/confirmation` lands on "Page not found"** unless an order was placed in this
   same tab (the view needs `lastOrder` in memory). Deep links to products/collections/content
   pages do work (`/product/11` → Skeleton Vibes, `/collection/anime` → grid rendered-but-hidden).
8. **ℹ️ The storefront's POST forms all work** end-to-end (verified in jsdom with real cookies):
   placing a COD order → `/confirmation` with order number + confirmation email, newsletter,
   "Notify Me", customer signup/login, review submit. The failures below are visual/reachability
   problems, not API problems.

---

## 1. Storefront — `public/index.html`

### 1.1 Header (visible on every page)

| Element | Line | Press → what happens |
|---|---|---|
| Skip to content (`#mainContent`) | 3746 | Jumps focus to `<main>` (keyboard users). |
| Logo (KAGE mark) | 3796 | `navigateTo('home')` → `/`. |
| **Home** | 3801 | `navigateTo('home')` → `/`; highlights "Home". |
| **Anime Shirts** | 3802 | `navigateTo('collection','anime')` → `/collection/anime`, title "ANIME SHIRTS", 7 cards filtered … **into the hidden grid** (finding #1). |
| **Graphic Tees** | 3803 | `navigateTo('collection','graphic-tees')` → `/collection/graphic-tees`, shows **Coming Soon** page (always). |
| **Pants** | 3804 | `navigateTo('collection','all')` → `/collection/all`, shows "FEATURED DROPS" (placeholder — finding #3). |
| **Custom Stickers** | 3805 | `navigateTo('custom-stickers')` → `/custom-stickers` brand page (hero only; no products). |
| **About** | 3806 | `/about` — brand story page. |
| **Contact** | 3807 | `/contact` — WhatsApp / Track Order / Instagram / Email cards. |
| **Track Order** | 3808 | `/tracking` — order lookup form. |
| Search icon (🔍) | 3821 | `toggleDesktopSearch()` — slides the header search field open/closed (≥1024px). |
| Track-order icon | 3822 | `navigateTo('tracking')`. |
| Wishlist heart (with counter) | 3823 | `toggleWishlistFilter()` — opens the Favourites drawer (saved items, localStorage). |
| Account icon | 3824 | `handleAccountClick()` — signed in → Account page; signed out → customer login/signup modal. |
| Cart icon (with counter) | 3825 | `toggleCart()` — opens the cart drawer. |
| Hamburger (mobile) | 3828 | `setMenuOpen()` — opens/closes the mobile nav drawer (closes on link click, outside tap, Escape). |
| Mobile search field | 3809 | `oninput → onSearchInput()` — same search path as desktop (hidden results, finding #1). |
| Mobile track-order icon | 3810 | `navigateTo('tracking')` + closes menu. |

### 1.2 Home page

| Element | Line | Press → what happens |
|---|---|---|
| Hero **"Shop the Drops"** | 3870 | `navigateTo('collection','all')` → `/collection/all`; grid is hidden (#1). |
| Category tile **Graphic Tees** | 3879 | → Coming Soon page. |
| Category tile **Pants** | 3887 | → `/collection/all` (all products). |
| Category tile **Anime Shirts** | 3895 | → `/collection/anime` (hidden grid). |
| Category tile **Custom Stickers** | 3903 | → `/custom-stickers` page. |
| **"Explore Collection"** (New Vibes block) | 3923 | `navigateTo('collection','anime')` (hidden grid). |
| **"View All"** (Best Sellers header) | 3979 | `navigateTo('collection','all')` (hidden grid). |
| Product cards in Best Sellers / Recently Viewed | JS `renderHomeProductCard` | Whole card & "Quick View" → `openProductDetail(id)`; heart → wishlist toggle; card click opens the product page. |
| **Retry** (only if catalog fails to load) | 3836 | Re-runs `loadProductsFromAPI()`; hidden otherwise. |

### 1.3 Collection / shop grid (includes filters, sort, pagination)

> All of these live inside the hidden `#shopSection` — the code runs, the user just can't see it.

| Element | Line | Press → what happens |
|---|---|---|
| **Filter** button | 4020 | `openFilterDrawer()` — opens the mobile filter drawer (also works when called). |
| Drawer backdrop | 4041 | `closeFilterDrawer()`. |
| Drawer **×** | 4045 | `closeFilterDrawer()`. |
| Drawer **Apply** | 4049 | closes the drawer + re-renders the grid. |
| **Next** (pagination) | 4032 | `nextPage()` — advances page, re-renders, scrolls to grid top. |
| Filter panel controls (checkboxes, price sliders, size/collection selects, **Reset Filters**) | JS `filterPanelHTML()` | Update `filterState` and re-render the grid live. |
| **Sort** dropdown | 4016 | Re-sorts the grid (featured / price ↑ / price ↓ / newest). |
| Collection tiles (if ever rendered) | JS `loadCollections()` | `navigateTo('collection', name)` — dead in practice (#5). |

### 1.4 Product cards (grid + related + recently viewed)

| Element | Behaviour |
|---|---|
| Card body / keyboard Enter | `openProductDetail(id)` → product page + `/product/<id>`. |
| Heart | `toggleWishlist(id, el)` — saved in `localStorage.kageWishlist`, red pop animation, counter updates. |
| **Add to Cart** | `quickAdd(id)` — adds the first in-stock size, toast "… added to cart (L)"; disabled/"Out of Stock" when sold out. |
| **Quick View** | `openProductDetail(id)`. |
| Card hover (desktop) / tap (touch) | Swaps front/back image. |

### 1.5 Product detail page

| Element | Line | Press → what happens |
|---|---|---|
| **← Back to collection** | 4233 | Returns to the collection you came from (or Home→grid). |
| Thumbnails / dots | 5735, JS | Switch gallery angle. |
| Main image | 4225 | Opens full-screen zoom (click backdrop, **×**, or Escape closes). |
| **− / +** qty | 4247/4249 | `detailChangeQty()` — clamped 1…per-size stock. |
| Size buttons | JS `renderSizePicker()` | Select size; sold-out sizes disabled with tooltip; "One Size" hides the picker. |
| **Add to Cart** (main + sticky bar) | 4252, 4307 | `detailAddToCart()` — adds chosen size/qty; button shows "Out of Stock" when none available. |
| Tabs: **Fabric & Care / Fit Guide / Shipping & Returns** | 4256-4258 | `switchTab()` — swaps the tab pane. |
| Review stars (1-5) | 4290 | Radiogroup: click/tap/drag or arrow keys; 44px targets. |
| **Submit Review** | 4299 | `submitReview()` → `POST /api/reviews`. Requires order number + phone from a **delivered** order; otherwise inline error. 4-5★ auto-approve, 1-3★ go to moderation. |
| Related products ("You might also like") | JS | Same product-card controls as §1.4. |
| Hidden review list section | 4276 | Appears once the product has (visible) reviews. |

### 1.6 Cart & wishlist drawers

| Element | Line | Press → what happens |
|---|---|---|
| Cart backdrop / **×** | 4320/4324 | `toggleCart()` — opens/closes; body scroll locks. |
| **− / +** per item | JS | `changeCartQty()` — clamped to per-size stock; going below 1 removes. |
| **Remove** | JS | Deletes the line item. |
| **Checkout** | 4329 | `startCheckout()` — closes the drawer, refuses if catalog didn't load or cart empty, else → `/checkout`. |
| Wishlist **Add to Cart** | JS | `quickAdd(id)` straight from the drawer. |
| Wishlist **Remove** | JS | Un-hearts the product + re-renders the drawer. |

### 1.7 Checkout / confirmation / tracking / reset

| Element | Line | Press → what happens |
|---|---|---|
| **← Back to shop** | 4157 | Home + `initShop('all')`. |
| **Place Order** | 4188 | `placeOrder()` → `POST /api/orders` (COD only) → clears cart → **Order Confirmed** page with number, status, "To be confirmed" delivery charge; seller gets an email. |
| **Track your order anytime** | 4213 | `goTrackOrder()` — opens `/tracking` and prefills the order number just placed. |
| **Continue Shopping** | 4214 | Home + `initShop('all')`. |
| **Track Order** (tracking form) | 4124 | `trackOrder()` → `GET /api/orders/track?number=&phone=`; renders timeline (or a cancelled terminal state); button re-enables on failure. |
| **Update Password** (reset page) | 4140 | `submitPasswordReset()` → `POST /api/auth/reset-password` with the token from the email link. |

### 1.8 Account & customer modals

| Element | Line | Press → what happens |
|---|---|---|
| **Save Changes** | 4356 | `saveAccountProfile()` → `PUT /api/customers/me` (name/phone/address/city). |
| **Update Password** | 4363 | `changeAccountPassword()` → same endpoint, password shape. |
| **Sign Out** | 4366 | `customerLogout()` → session cleared → Home + toast. |
| Customer modal **Sign In** | 6934 | `submitCustLogin()` → `POST /api/customers/login`. |
| **Create one / Sign in** toggle | 6936/6949 | Swap login ↔ signup panes. |
| **Forgot password?** | 6935 | `prompt()` for email → `POST /api/auth/forgot-password` → alert with the result. |
| Signup **Create Account** | 6948 | `submitCustSignup()` → `POST /api/customers/signup` (min 6-char password). |
| Modal backdrop / **×** | 6922/6924 | Close the modal. |
| ~~Admin modal **Sign In**~~ | — | **Removed 2026-10-11** as dead code (finding #2). Admin sign-in lives at `/admin` only. |

### 1.9 Content & special pages

| Page | Pressable things → effect |
|---|---|
| About `/about` | Static story; footer & nav only. |
| Contact `/contact` | WhatsApp card → `wa.me/923228042633`; **Order Support → Track Order** (`/tracking`); "message us on WhatsApp"; Instagram card → `instagram.com/kage__culture`; Email card → `mailto:kageculture01@gmail.com`; "← Back to Shop". |
| Shipping `/shipping` | Static policy (contains a leftover *"Free-shipping threshold: TODO"* line). |
| Returns `/returns` | Static policy + WhatsApp link + Back to Shop. |
| Terms `/terms` | Static + WhatsApp link + internal link to Returns + Back to Shop. |
| Privacy `/privacy` | Static + WhatsApp link + Back to Shop. |
| Custom Stickers `/custom-stickers` | Hero only ("Custom Orders Opening Soon"); no buttons of its own. |
| Coming Soon `/collection/graphic-tees` | **Notify Me** → `notifyMe()` → `POST /api/coming-soon` (email + category); "← Back to Home". |
| Page not found (any unknown path, e.g. `/kage-clothes`) | **Back to shop** → Home. |

### 1.10 Footer (every page)

| Element | Line | Press → what happens |
|---|---|---|
| Help links: About / Contact / Track Order / Shipping / Returns & Refunds / Privacy Policy / Terms of Service | 4063-4069 | SPA-navigate to the matching page. |
| Social icons: Instagram (`instagram.com/kage__culture`), Snapchat (`snapchat.com/add/kage_culture`), Email (Gmail compose to kageculture01@gmail.com), Etsy (`etsy.com/shop/kageinetsy22`), WhatsApp (`wa.me/923228042633`) | 4075-4087 | Open in a new tab. |
| @kage__culture handle | 4091 | Instagram profile, new tab. |
| **Subscribe** (newsletter) | 4098 | `subscribeNewsletter()` → `POST /api/newsletter` → inline "Welcome to the clan!" message. |
| Footer bottom Privacy / Terms | 4109/4111 | SPA-navigate. |
| Floating WhatsApp button | 6972 | Opens WhatsApp chat "I need help" — visible on every page. |

### 1.11 Storefront inputs that aren't links (for completeness)

- Desktop + mobile **search**: `oninput → onSearchInput()` filters the catalog, moves you Home and
  re-renders the grid — **results are invisible (finding #1)**; Enter does nothing, Escape closes the
  field when empty.
- **Sort** select, **filter** checkboxes/sliders/selects: live re-render of the hidden grid.
- ✓ Checkout fields (name, email, phone, address, city, notes) and the single **Cash on Delivery**
  radio: validated on Place Order (required fields + email shape; "Delivery charge — To be
  confirmed").
- ✓ Review name/comment/order-number/phone fields; newsletter + Notify-Me email fields.
- Cart & wishlist persist in `localStorage` (`kageCart`, `kageWishlist`), restore validates stock.

---

## 2. Admin panel — `public/admin.html`

### 2.1 Login & shell

| Element | Line | Press → what happens |
|---|---|---|
| **Sign In** | 1032 | `handleLogin()` → `POST /api/admin/login`; loads dashboard; button locks while in-flight. |
| **Forgot password?** | 1033 | `prompt()` email → `POST /api/auth/forgot-password` (`user_type:'admin'`). |
| Sidebar: **Dashboard / Products / Quick Upload / Add Product / Orders / Reviews / Reports** | 1042-1048 | `switchSection(name)` — swaps the tab, sets the title, refreshes data for that tab (products/orders/reviews/reports). |
| **Change Password** (sidebar + mobile) | 1052/1078 | Opens the change-password modal. |
| **Log Out** (sidebar + mobile) | 1053/1079 | `handleLogout()` → `POST /api/admin/logout` → login screen (refreshes CSRF first if missing). |
| **View Store** | 1060 | Opens `/` in a new tab. |
| **Theme toggle** | 1061 | Light/dark, saved in `localStorage.kage-admin-theme`. |
| **+ Add Product** (top bar) | 1066 | `switchSection('add')`. |
| Mobile section `<select>` | 1069 | `switchSection(value)`. |

### 2.2 Dashboard

| Element | Behaviour |
|---|---|
| Stat cards (Products, Orders, Revenue, Pending, Low Stock) | Read-only, refreshed from `/api/admin/stats/dashboard`. |
| Recent-orders rows | Clickable → jumps to the Orders tab. |

### 2.3 Products tab

| Element | Line | Press → what happens |
|---|---|---|
| Search box / category select | 1208/1209 | Live filter of the product list. |
| **Clear** | 1215 | Empties both filters. |
| **Select visible** checkbox | 1218 | Selects/deselects every visible row (tri-state). |
| Row checkbox | 1863 | Adds/removes that product from the selection. |
| **Delete selected (n)** | 1220 | Confirm dialog → `DELETE /api/products/batch` → refresh. |
| Stock switch per row | 1873 | `PATCH /api/products/:id/stock` — flip in/out of stock. |
| Stock number per row | 1875 | Inline editor (+/✓/×) → `PATCH /api/products/:id/stock-qty`; per-size products jump to the edit form instead. |
| **Edit** / **Delete** per row | 1878/1879 | Edit → loads the product into the Add/Edit form; Delete → confirm → `DELETE /api/products/:id`. |
| **Retry** (only on load failure) | 1763 | `loadProducts()`. |

### 2.4 Quick Upload tab

Upload zone (tap/drag, file input, `accept=image/*`) → preview, **Choose different** clears it,
price + category (Anime Shirts / Streetwear / Goofy Wears) + size + optional stock quantity,
**Upload** → `handleQuickUpload()` (compresses to WebP, `POST /api/products`), then a "● Live in
shop" card. Field errors are shown inline above the button.

### 2.5 Add / Edit Product tab

| Element | Line | Press → what happens |
|---|---|---|
| Front picture zone | 1261 etc. | Tap/drag to pick, or **Choose different** re-opens the picker. |
| Back picture / More photos (up to 4) | 1290-1330 | Extra angles; removable previews. |
| Category / Fit / Price / Sale price / Unit cost (COGS) | — | Form fields (COGS drives the Reports P&L). |
| Size chips S-XXL | 1309-1313 | Toggle which sizes exist; a stock box per selected size appears. |
| **Add Product / Save** | 1348 | `handleSaveProduct()` → create or `PUT` update; success/error banner; edit mode switches the button to "Save". |
| **Cancel** | 1349 | `resetForm()` — clears edit state (shown only while editing). |

### 2.6 Orders tab

| Element | Line | Press → what happens |
|---|---|---|
| Search / status select | 1368/1369 | Live filter by order #, name, phone, email / status. |
| Sort button (Newest ⇄ Oldest) | 1378 | `toggleOrderSort()`. |
| **Export CSV** | 1381 | Downloads `/api/orders/export/csv` (respects the status filter). |
| **Verify payment** / **COD confirm** per order | 2733/2734 | `PATCH …/verify-payment` · `PATCH …/cod-confirm` — toggles the flag. |
| Status dropdown → Confirmed / Shipped / Delivered / Cancelled / Pending | 2754-2758 | Confirm dialog ("customer will get an email"; Cancel returns stock) → `PATCH /api/orders/:id/status`. |
| **Retry** (only on failure) | 2684 | `loadOrders()`. |

### 2.7 Reviews tab

Pending / Approved / Rejected filter pills → per review **Approve**, **Reject**, **Delete**
(confirm) → `PATCH`/`DELETE /api/reviews/:id`, list reloads. Filled gold stars show the rating.

### 2.8 Reports tab

**Daily / Weekly / Monthly** toggle → `loadPnlStats()` (`GET /api/admin/stats/pnl?period=`) and
`loadSalesSummary()` (`/api/admin/stats/sales`): revenue today/week/month, best product, status
counts, P&L chart (Chart.js self-hosted at `public/vendor/chart.umd.min.js`).

### 2.9 Change-password modal

**×** / backdrop-adjacent close → `closeChangePasswordModal()`; **Update Password** →
`handleChangePassword()` → `POST /api/auth/change-password` (current + new + confirm, ≥6 chars,
Enter submits, focus trapped, Escape closes).

---

## 3. Everything dead or unreachable, in one list

| # | What | Where | Impact |
|---|---|---|---|
| 1 | `#shopSection` inline `display:none`, never shown | index.html:3999 | All collection browsing / search / filters / sort / pagination invisible; ~15 pressables affected |
| 2 | ~~Admin login modal never opened~~ | — | **Resolved 2026-10-11:** modal, CSS and handlers deleted; `/admin` is the only admin entry |
| 3 | `loadNewArrivals()`, `loadCollections()` write to non-existent `#newArrivalsGrid` / `#collectionsGrid` | index.html:5465, 5494 | Dead code, no New Arrivals / Collections sections |
| 4 | Old `notifyMe(btn, category)` variant unused after Custom Stickers trim | index.html:5089 | Harmless dead code |
| 5 | `Pants` → `/collection/all`, no `data-nav` | index.html:3804 | Wrong page + wrong highlight |
| 6 | Graphic Tees hard-forced to Coming Soon | `navigateTo()` | Category unreachable even with stock |
| 7 | Contact "Working hours: TODO", Shipping "Free-shipping threshold: TODO" | 4648, 4426 | Unfinished customer-facing copy |
| 8 | `/confirmation` deep link → not-found | index.html | Confirmation page only works right after checkout |

---

## 4. Verification notes

- `npm test` on this commit: **57/57 API + 17/17 frontend scenarios pass**.
- jsdom probe runs (cookie-aware, real server) pressed every header nav link, hero CTA, category
  tile, "View All", the vibes CTA, all five header icon buttons and every footer link; and ran the
  full order flow (add → checkout → place order → confirmation → track), Notify Me, newsletter,
  customer signup → account page, review validation, filter drawer, and deep links
  (`/product/11`, `/collection/anime`, `/shipping`, `/nonsense-path`).
- `#shopSection` stays `display:none` (inline) in all cases; grep over the whole repo finds no code
  that ever changes it, and no `!important` CSS overrides it. jsdom's computed style agrees.
