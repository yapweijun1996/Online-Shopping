# Seller Portal E2E and UX Review

Date: 2026-09-27 (Asia/Singapore)
Build tested: Seller PWA v59, repository baseline `8850a98`
Scope: seller sign-in, navigation, products, categories, company settings, order search/detail/decision, account menu, language switch, and responsive layout.

The repository advanced to `b81da4c` during this audit. That commit increments the Seller service worker to v60 and changes shared/shop assets; it does not change the seller product, order, settings, or navigation logic cited below. The v60 browser build was not retested.

## Fix follow-up (2026-09-28)

SP-01 through SP-10 were fixed in Seller PWA v65 and deployed to the public Demo on 2026-09-28. The findings below describe the original v59 behavior; the deployment evidence and remaining browser-verification limit are recorded below.

| Finding | Local fix and verification |
| --- | --- |
| SP-01 | Product edit omits unchanged availability from partial updates and synchronizes the open checkbox after a card toggle. In an isolated Demo browser, activating the open product and then saving a description kept it active; deactivating it updated the open checkbox. |
| SP-02 | Dirty product, category, and company forms now ask before navigation; product form switching and cancellation are also guarded. In the isolated browser, Stay retained the exact product/category/company draft, Discard navigated, browser history navigation preserved a draft on cancellation, sign-out was cancelled, and reload raised a `beforeunload` warning with the draft retained. |
| SP-03 | Product create/update confirmation now appears immediately under the form heading and receives focus. In the isolated browser, the message was visible at 1280 × 720 (y=154–199) and 390 × 720 (y=149–193), with the status region exposed to assistive technology. |
| SP-04 | Dashboard now reads shop setup state: an unconfigured local shop showed first-time setup; configured Demo and Production shops showed shop name, mode, and Products/Orders/Settings entry points. Configured Company settings placed editable settings first and hid first-time guidance. |
| SP-05 | Empty direct-child status paragraphs no longer render or reserve height. Browser DOM checks measured `display: none` and 0 px height for empty Products and Sales Orders messages; populated messages retain the existing card style. |
| SP-06 | Product action names now include name and SKU; category controls include category code. The isolated browser accessibility tree identified each target, including after category list rendering. |
| SP-07 | Demo order details now show a simulation notice, replace fake phone values with “Not available in Demo,” and omit copy and WhatsApp actions. A separate isolated Production order still exposed real-value copy actions and the opted-in WhatsApp link. |
| SP-08 | The product search input now shows “Name or SKU” and retains a programmatic label. At 320 px the settled page had 320 px scroll width and a 162 px input; at 390 px and desktop the hint remained visible. |
| SP-09 | A successful availability change now shows product-specific Undo inside that card and keeps it on screen. In isolated Demo browser testing, Deactivate changed the card to Inactive, Undo restored Active, and the affected product remained in place. The Undo control names the product and SKU. |
| SP-10 | The Seller PWA's always-visible app-version/check footer was removed from the work area. Check for updates is in Account; a waiting worker displays a compact update notice in normal page flow at 320 px. Later hides it, a view change reveals it again, and manual Check for updates reports status inside Account. A separate 390 px headless Chrome run completed a simulated v64→v65 installation and reload; details are below. |

The user-requested visual workflow used Codex CLI `gpt-6-luna` to capture baseline screenshots, generate [a visual proposal](../ui/seller-layout-proposal.png) and [implementation spec](../ui/seller-layout-proposal.md), then capture [mobile Products](../ui/seller-after-products-mobile.png), [mobile Orders](../ui/seller-after-orders-mobile.png), and [desktop Products](../ui/seller-after-products-desktop.png) after implementation. The proposal is an illustration; the after images are running local app screenshots. JavaScript syntax checks and all 89 repository tests passed against the local working tree. The two code-backed risks below were subsequently fixed and exercised in an isolated browser.

## Test method and result

- Inspected the deployed Demo seller portal in the Codex in-app browser at mobile (498 px and 320 px) and desktop (1440 px) widths. No deployed products, categories, settings, or orders were changed.
- Ran write-path tests against the same repository build on an isolated local Demo database in the in-app browser. The temporary database and test tabs were removed after testing.
- Completed: sign in/out; create an inactive product; search it; activate it and verify it appears in the public shop; deactivate it and verify it disappears; create and deactivate a category; save default currency and verify the next product form uses it; create a simulated customer order; confirm it as seller; verify the pending queue empties and the confirmed order remains in Sales Orders.
- Checked product creation/editing, order rejection and confirmation dialogs, required rejection reason, order filtering, profile dialog, language menu, and key mobile/desktop layouts without committing additional deployed data.
- The in-app browser's automated pointer click did not reliably activate controls during this run. Keyboard activation (`Enter`) worked and was used for interactive assertions. This is a test-tool limitation, not counted as a portal defect.

| Workflow | Browser result |
| --- | --- |
| Seller sign-in, account profile, sign-out | Passed in isolated local Demo. |
| Product create, search, activate/deactivate, public visibility | Passed; SP-01, SP-03, SP-08, and SP-09 were found while testing. |
| Category create/edit/deactivate and company default currency | Passed in isolated local Demo. |
| Customer simulated checkout → seller pending review → confirm → all-order lookup | Passed in isolated local Demo. |
| Order number search, detail, confirmation/rejection dialog and empty-reason validation | Passed on deployed Demo without final decisions. |
| Mobile/desktop navigation, language switch, layout | Core routes worked; SP-02, SP-04, SP-05, and SP-06 were found. |

### Highest priority

| Rank | Finding | Severity | Why it matters |
| --- | --- | --- | --- |
| 1 | [SP-01](#sp-01-product-save-can-reverse-a-newer-availability-change) | P1 | A routine edit can silently reverse a newer storefront availability change. |
| 2 | [SP-02](#sp-02-navigation-discards-unsaved-product-edits) | P1 | Sellers can lose work merely by moving to another section. |
| 3 | [SP-03](#sp-03-product-save-success-is-off-screen) | P2 | A successful save looks unfinished, inviting repeated submissions or confusion. |

## Findings

### SP-01 Product save can reverse a newer availability change

**Severity:** P1 · **Evidence:** reproduced in isolated browser E2E.

1. Open an inactive product in Edit product; the form's Active in shop checkbox is unchecked.
2. Use the product card's Activate action while the edit form remains open. The card changes to Active, but the edit checkbox remains unchecked.
3. Save the form without changing that checkbox. The card changes back to Inactive.

The form captures `active` when editing starts, the quick toggle only reloads the list, and the subsequent full save sends the stale form value. See `public/seller/products.js:204-237` and `public/seller/products.js:296-319`. The reverse sequence could silently reactivate a product that was just deactivated; this direction follows from the same code path and was not separately executed.

**Fix and acceptance:** Synchronize the open form after a quick status change, or use a product revision and reject stale full saves. Saving an unrelated field must preserve the latest availability unless the seller explicitly changed the form checkbox; a conflict must be explained before overwriting it.

### SP-02 Navigation discards unsaved product edits

**Severity:** P1 · **Evidence:** reproduced on deployed Demo without saving data.

Change an existing product's Name in the edit form, navigate to Sales Orders, then return to Products. The form is closed and the draft is gone; no warning or recovery appears. Route changes replace the mounted content in `public/seller/app.js:110-161`, and navigation commits the hash change in `public/seller/app.js:209-223`. The product form has no dirty-state guard.

**Fix and acceptance:** Guard route changes, browser back/reload, and sign-out when a form is dirty, or retain a recoverable draft. Choosing Stay must keep the exact entered values; choosing Discard must navigate. Check product, category, and company forms.

### SP-03 Product save success is off-screen

**Severity:** P2 · **Evidence:** reproduced in isolated browser E2E at 1280 × 720.

After creating a product, the portal reopens it in Edit product and focuses SKU. The status text says “Product saved,” but its box began at viewport y=1048 while the viewport height was 720. The seller sees the form again without the success message. `public/seller/products.js:316-319` resets/reopens the form; `public/seller/index.html:94-115` places `#product-status` after the long form.

**Fix and acceptance:** Announce success at the form heading or in a visible toast and keep it available to assistive technology. After create/update at mobile and desktop sizes, the confirmation must be visible without scrolling and clearly distinguish the saved state from a still-dirty form.

### SP-04 Configured shop still shows first-time setup dashboard

**Severity:** P2 · **Evidence:** deployed Demo dashboard and Company settings inspected.

The dashboard says “Choose Demo ... or Production” and offers Shop setup even though Company settings confirms that Paws & Whiskers Pet Shop is already configured in Demo mode. The dashboard always renders the same setup text and button in `public/seller/app.js:150-161`; it does not read setup state. The configured setup panel also repeats first-time guidance above editable company settings on mobile.

**Fix and acceptance:** Render configured shop name/mode plus useful entry points or status on the dashboard. Show setup choices only before setup; after setup, present the configuration as completed and place editable settings first.

### SP-05 Empty status paragraphs render as blank cards

**Severity:** P2 · **Evidence:** visible on deployed Products, Sales Orders, and Sales Order Confirmation at mobile and desktop widths.

An empty bordered card appears between the toolbar and content. The direct-child `#product-status` and `#order-message` paragraphs are empty, but `#workspace-content.panel > p` still applies 26 px padding, border, and white background. See `public/seller/index.html:114-126` and `public/seller/style.css:44-48`.

**Fix and acceptance:** Hide empty status elements or style only non-empty status messages. When there is no message, no blank card or vertical gap should appear; loading, success, and error messages must remain visible.

### SP-06 Repeated action names lack item context for assistive technology

**Severity:** P2 · **Evidence:** deployed accessibility tree.

Every product card exposes identical “Edit product” and “Deactivate” button names, and category rows expose repeated “Save” and “Available for new products” controls. A screen-reader user navigating by controls cannot tell which record an action will affect. See `public/seller/products.js:149-154` and `public/seller/settings.js:57-65`.

**Fix and acceptance:** Include the product name/SKU or category code in each control's accessible name while keeping the short visible label. A controls list must identify the target record for every repeated action.

### SP-07 Demo order detail offers copy actions for fake contact values

**Severity:** P2 · **Evidence:** deployed Demo order detail and source inspection.

The seller detail displays `DEMO-NO-CONTACT` under Buyer WhatsApp phone and Recipient phone and still offers Copy for both. The order is identified only by a `DEMO-` number; the seller view does not display a plain-language simulation notice. The API already returns `simulation: true` for Demo orders (`src/seller-orders.js:19-25`), but `public/seller/orders.js:178-205` does not use it.

**Fix and acceptance:** Display a clear “Simulated order — no contact or delivery” notice and suppress copy/contact actions for placeholder values. Real orders with valid authorized details must retain their normal copy actions.

### SP-08 Product search has no visible input hint

**Severity:** P3 · **Evidence:** deployed Products page at 320 px, 498 px, and 1440 px.

The field appears as an empty box beside Search. Its “Search products” label is visually hidden and there is no placeholder or nearby hint. Sellers cannot tell that names and SKUs are searchable; the backend matches those two fields (`src/products.js:169-185`). See `public/seller/index.html:87-91`.

**Fix and acceptance:** Add a visible label or compact hint such as “Search name or SKU.” It must remain readable at 320 px and retain the programmatic label.

### SP-09 Availability toggle gives no undo or confirmation

**Severity:** P3 · **Evidence:** isolated browser E2E.

Activate/Deactivate immediately patches the product and changes its public visibility. The action is reversible, but no confirmation or undo control is offered. See `public/seller/products.js:149-154` and `public/seller/products.js:233-237`.

**Fix and acceptance:** Provide an undo action with a clear product-specific result, or a confirmation for deactivation. A seller must be able to recover an accidental toggle without searching for the product again.

### SP-10 App version footer competes with seller work

**Severity:** P3 · **Evidence:** deployed Seller PWA v59 Orders view at mobile width and [baseline screenshot](../ui/seller-before-footer-mobile.png).

The persistent footer exposes the app version, Check for updates, and available-update actions at the bottom of ordinary seller work. At narrow widths these controls wrap across several lines and draw attention away from the order/product task. Showing an available update is useful; keeping version metadata visible during routine work is unnecessary.

**Fix and acceptance:** Put manual update checks in Account and show a compact, normal-flow notice only when an update is ready. The notice must fit narrow widths without overlap; update checking and installation must remain reachable. The local v64 implementation passed the waiting-worker, account status, dismissal, and 320 px layout checks. A later isolated headless Chrome run confirmed cancellation, activation, reload, and notice removal for a simulated v64→v65 upgrade; it does not establish the behavior of the currently deployed v60 client after a real release.

## Code-backed risk follow-up (2026-09-28)

These risks were identified from the original code paths, then reproduced with controlled browser and API conditions on an isolated local Demo database.

1. **Product search response race — released in v65:** `load()` now assigns each request a sequence number and ignores stale success/error responses. Pagination uses the last submitted search term, even when the input contains an unsubmitted draft. A headless Chrome run held search A, completed search B, then released A; the visible result stayed on B. The same run changed the input without submitting and verified that Load more requested the applied query.
2. **Main image removal recovery — released in v65:** The form now waits for gallery details, explains why the main-image removal control is disabled while extra photos exist, and enables it after the last gallery photo is removed. If another session adds a gallery photo after the form loads, the server's `imageDataUrl` rejection produces an actionable message and refreshes the gallery instead of a generic error. In the isolated browser, gallery-first removal saved successfully; the concurrent-add case kept the main image and showed the recovery guidance.

## PWA upgrade and v65 Demo release (2026-09-28)

- An isolated Chrome session with a temporary Demo database installed a simulated v64 Seller worker, discovered a waiting v65 worker through Account, and showed the [ready notice at 390 × 720](../ui/seller-update-ready-v65-mobile.png). Cancelling the install confirmation kept v64 and left the update available. Accepting it activated v65, reloaded the page, cleared the notice, and produced the [updated screen](../ui/seller-updated-v65-mobile.png). No public Demo data was changed.
- This test exposed a PWA state bug: the old worker becoming `redundant` was treated as failure of the new worker. The shared PWA handler now associates activation and failure with the selected waiting worker and prevents an in-flight update check from replacing “Updating…” or re-enabling Check for updates. A focused regression covers old-worker redundancy and one reload. The exact browser flow passed again after the fix.
- Local gates passed: `npm run check` (JavaScript syntax), `npx -y node@24 --run test` (90/90), `npm run worker:check` (Cloudflare dry-run, 51 public assets, 2141.47 KiB upload), and `git diff --check`. Wrangler authentication is available. The configured target remains the public Demo Worker `online-shopping` with `SHOP_MODE=demo` and the existing `ShopStore` Durable Object binding; no secrets or deployment configuration were changed.
- Cloudflare deployment `d11d862e-265f-4d24-a311-1f052dbaf3aa` uploaded the v65 build to `https://online-shopping.onemap-token-proxy.workers.dev`. Public `/ready` returned ready, `/seller/sw.js` served v65, `/shop/sw.js` served v71, and the public `/shared/pwa.js` SHA-256 matched the local file. A previously open in-app-browser v59 Seller page found waiting v65 through its Check for updates button. The browser automation stalled on its native install confirmation, so the UI-driven accept/reload sequence was **not** verified on that old page. A separate tab used browser diagnostics to send `SKIP_WAITING` to the already-waiting v65 worker; the worker activated, removed old Seller caches, and a reload displayed the [live v65 seller login screen](../ui/seller-v65-live-login.jpg) without the persistent version footer. No public Demo order or catalog data was changed. The old-tab dialog may require manual dismissal/reload. The full update UI flow remains verified only in the isolated v64→v65 Chrome test.

## Verification boundaries

The deployed Demo was inspected without changing its data. All follow-up writes used isolated local Demo databases. The latest risk follow-up exercised a product with a main image and gallery photo, as well as a concurrent gallery addition; it did not exercise arbitrary file uploads through the browser picker. Real customer contact, offline transitions, and the actual deployed old-client confirmation/reload interaction were not exercised. The isolated Chrome run did exercise final installation with a simulated v64 baseline. The live v59 client detected waiting v65, and browser diagnostics activated it; this does not establish that the old UI confirmation path works. Pointer activation in a normal human browser remains untested. The checked pages showed no stable horizontal overflow at 320 px after responsive transitions settled. Browser-visible findings are limited to the tested versions and workflows.
