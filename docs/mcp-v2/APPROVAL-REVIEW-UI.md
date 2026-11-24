# Seller MCP approval review UI

The review header leads with the action, product name and SKU when available. It then shows the requesting app, shop, seller account and remaining time. **What will change** gives catalog updates a labelled Before and After comparison for each changed field, with a **Changed** badge. Each affected product has a collapsed **Unchanged fields (N)** disclosure when it has unchanged fields. Catalog creation displays the new product values. The summary covers name, SKU, price, stock, availability, category, description, options and variant information when provided.

Availability maps the product `active` flag to **Listed** or **Not listed**. MYR and SGD prices use their currency code and two decimal places. Other prices retain the source minor units and identify any missing currency or scale.

**Complete proposal & technical details** starts collapsed. It contains the full text-safe proposal, seller identity and status, IDs, image references and the exact expiry timestamp. The local time is displayed in the disclosure and the UTC timestamp is available on hover. The header chip refreshes every 30 seconds, uses a warning style below two minutes and reads **Expired** when the deadline passes. At expiry the page disables decision and image controls and requests a fresh preview. Submission checks the deadline again, including after background-tab timer delays. The server enforces the deadline.

## Images and acknowledgments

After complete manifest validation, an image-free proposal hides the viewer and says **No images**. The browser still verifies and acknowledges each PAGE.

The browser fetches each unique protected image, verifies its bytes, decodes it, and sends the one-use ACK. Approval requires all PAGE and ASSET acknowledgments, including images in collapsed sections. An image that fails verification stays hidden and offers its own retry. The verified-image count tracks delivery, while the business summary separately describes how many photos are added and whether the main photo changes.

Gallery additions lead with new photos in proposed order and collapse existing photos. When the first gallery photo is also the main image, one preview carries both labels. Replacements retain a Before and After comparison. A confirmation of the existing layout shows the current gallery and preserves its main image and order. Selecting a preview opens the verified image in a modal that supports previous/next controls, arrow keys, Escape and focus return. UUIDs and exact references remain available under technical details.

The approval button identifies the action or photo count. **Reject** is available for each proposal. Both decisions use the current authenticated seller session, exact Origin, CSRF and an expiring single-use challenge bound to the operation and preview hash. The decision endpoint rejects a password field. The company currency change checkbox remains required for approval. Browser checks establish which exact bytes were delivered and decoded. See [the threat model](../threat-model.md).

## Appearance and limits

If the proposal request fails with a network or server error, **Try again** reloads the same proposal. Sellers without a session are directed to sign in. An expired or invalid proposal directs the seller to ask the connected app for a fresh preview.

While a decision is pending, the decision panel announces **Approving…** or **Rejecting…** and disables both decision buttons. If the response is lost, **Check status** reads the current server state before the page allows another decision.

A confirmed approval opens an **Approved** dialog with the operation type and product name when available. The checkmark draws in two steps unless the seller prefers reduced motion. **Continue** or Escape dismisses the dialog and returns focus to the visible status. That status identifies the requesting app and distinguishes approval from application. An unchanged-gallery confirmation records the seller's decision and leaves the gallery as shown. A rejection, expiry, uncertain response, or subsequent status check does not show the approval confirmation. Reloading reads the authorized server state without exposing the approved or closed proposal again. **Applied** requires a committed state.

The review page is available in English and Simplified Chinese. The approval confirmation follows the Seller Studio language preference in all seven supported languages. The top controls can change the review language and switch between light, dark, and system themes. The storefront-authored product name and SKU remain as provided. The responsive review uses the Seller Studio tokens, a compact gallery grid, visible focus, and reduced-motion support. The decision bar reserves its full measured height and device safe area so the last photo and footer remain reachable on small screens.

## Browser checks and fixture screenshots

Set `QA_PLAYWRIGHT_MODULE` to an installed Playwright module's absolute `index.mjs` path. Use Playwright 1.49 or newer with its matching Chromium for browser clock and accessibility snapshot support. Without that variable these optional browser tests are skipped. Set `SHOP_TEST_DATABASE_URL` to a disposable PostgreSQL database URL whose database name includes `test`. Its user must be able to create and drop fixture databases. Do not use a production database. Run from the repository root:

```sh
NODE_ENV=test \
QA_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
node --test test/mcp-operation-review-browser.test.js test/mcp-operation-review-expiry-browser.test.js test/mcp-catalog-create-render-browser.test.js test/mcp-catalog-review-render-browser.test.js test/mcp-media-review-browser.test.js test/mcp-operation-review-app-browser.test.js test/mcp-review-entry-browser.test.js test/mcp-photo-approval-matrix-browser.test.js
```

`QA_APPROVAL_SCREENSHOT_DIR` is optional. When set, the general review browser fixture captures `approval-{width}-{light|dark}.png` at each of the fourteen viewport/color-scheme combinations, plus `approval-success-{390|1440}-{light|dark}.png` for the approval confirmation. CREATE renderer fixtures also capture `approval-create-no-images-1280.png` and `approval-create-exact-image-390.png`. Run `node --test .ux-shots/shoot.mjs` with the same environment to refresh the catalog, media and approval dialog screenshots at 390×844, 768×1024 and 1440×900. Captures use synthetic proposal data and collapsed technical details. The catalog and media browser tests require 16 pixels between the footer and the decision bar at maximum scroll at 390×844. They exercise the initial layout, a 34-pixel bottom safe area using Chromium's `Emulation.setSafeAreaInsetsOverride`, a wrapped summary and a long approval label. The browser tests also cover one preview per asset per side, one automatic ASSET ACK per unique image with the viewer collapsed, collapsed unchanged fields, named touch targets, responsive preview dimensions, horizontal overflow, expiry, image-free CREATE PAGE acknowledgment, the company currency checkbox, image integrity failures, decoder failure and retries. The empty Before row and full-width After preview are checked at 390, 768 and 1440 pixels. The screenshot fixture also checks that the gallery placement is visible above the decision bar at all three viewports.

The photo matrix runs both themes and both languages at 320, 390, 720, 768 and 1440 CSS pixels, plus a synthetic four-image addition at 390 pixels. Set `PHOTO_APPROVAL_NATIVE_ZOOM=1` to exercise Chrome's 200% page zoom in an isolated browser profile and `PHOTO_APPROVAL_SCREENSHOTS` for the matrix output directory.

## Historical local verification (2026-11-08)

On 2026-11-08, the eight focused browser/route/entry files passed 26 tests with no skips on SQLite and disposable PostgreSQL. `npm run check` passed. The separately enabled `mcp-production-proxy.test.js` passed against isolated pinned Node/Caddy containers, including root and tenant token asset forwarding and single effective security headers. A separate real-app Chromium smoke exercised full proposal expansion, visible keyboard focus, mobile overflow and password approval; the response explicitly required a subsequent app commit. Screenshots are fixture evidence only, not production acceptance. The full repository suite was not run for this focused UI change.

## Independent validation (2026-11-08)

The final focused browser/entry/expiry run passed 33 tests with zero failures or skips on SQLite and disposable PostgreSQL. It covered root and tenant HTTPS login continuation, shared stylesheet delivery, image-free and decoded-image review, image failure/retry, full-proposal disclosure, responsive layout, expired proposals, expiry during pending delivery/acknowledgment and delayed decision responses. Syntax and whitespace checks passed. The actual native CREATE browser suite also passed 5/5 on both stores before the final expiry/layout cleanup; final native rerun and the full repository suite are recorded separately when complete. These isolated checks use synthetic accounts and products; no production seller approval is claimed.

## Known follow-ups (recorded 2026-11-19)

Resolved on `approval-followups`.
