# Seller MCP approval review UI

The review header identifies the operation and shows the requesting app, shop, seller account and remaining time. **What will change** gives catalog updates a labelled Before and After comparison for each changed field, with a **Changed** badge. Each affected product has a collapsed **Unchanged fields (N)** disclosure when it has unchanged fields. Catalog creation displays the new product values. The summary covers name, SKU, price, stock, availability, category, description, options and variant information when provided.

Availability maps the product `active` flag to **Listed** or **Not listed**. MYR and SGD prices use their currency code and two decimal places. Other prices retain the source minor units and identify any missing currency or scale.

**Complete proposal & technical details** starts collapsed. It contains the full text-safe proposal, seller identity and status, IDs, image references and the exact expiry timestamp. The local time is displayed in the disclosure and the UTC timestamp is available on hover. The header chip refreshes every 30 seconds, uses a warning style below two minutes and reads **Expired** when the deadline passes. At expiry the page disables decision and image controls and requests a fresh preview. Submission checks the deadline again, including after background-tab timer delays. The server enforces the deadline.

## Images and acknowledgments

After complete manifest validation, an image-free proposal hides the viewer and says **No images**. The browser still verifies and acknowledges each PAGE.

The page loads each unique image automatically. After verifying the protected bytes and decoding and rendering the image, it sends the one-use ACK. Approval stays disabled until every image has an ACK. A failed image stays hidden and can be retried. Each Before and After side displays one preview per verified image and keeps a text label for each additional placement. **No photo selected** appears as a one-line chip. Previews use the verified protected image bytes, preserve the full image within a 320-pixel height cap (240 pixels on phones) and open the exact image viewer. UUIDs and image references are available in technical details. The summary beside the decision buttons uses the proposal's Before and After placements to say when the new main product photo also appears in the gallery.

The approval button reads **Approve description change**, **Approve image change** or **Approve change**, depending on the proposal. **Reject** is available for each. Both decisions use the current authenticated seller session, exact Origin, CSRF and an expiring single-use challenge bound to the operation and preview hash. The decision endpoint rejects a password field. The company currency change checkbox remains required for approval. Browser checks establish which exact bytes were delivered and rendered in the browser. They do not establish that the seller personally inspected them. See [the threat model](../threat-model.md).

## Appearance and limits

After the server confirms approval, the dialog shows **Approved** and **The product has not changed yet. Return to Claude to apply this change.** Rejection shows **Rejected** and **No change was made.** The inline live status is visually hidden once the dialog opens. The **Done** button or Escape closes the dialog and moves focus to that status for screen-reader access. Failed or expired decisions use the visible inline status.

The decision bar stays available at the bottom while scrolling. Below 640 pixels, the page reserves the fixed bar's full height, including its device safe-area padding, plus space to scroll the last content clear of the bar. The page reserves this space as soon as the bar appears, updates it when the image summary appears, and tracks later size changes. The buttons fill the bar and field and image comparisons stack vertically. The page uses the existing seller tokens via `../shop/tokens.css` for light and dark color schemes, with visible keyboard focus and reduced-motion support. The live status announces loading, errors, expiry and decision results.

## Browser checks and fixture screenshots

Set `QA_PLAYWRIGHT_MODULE` to an installed Playwright module's absolute `index.mjs` path. Use Playwright 1.49 or newer with its matching Chromium for browser clock and accessibility snapshot support. Without that variable these optional browser tests are skipped. Set `SHOP_TEST_DATABASE_URL` to a disposable PostgreSQL database URL whose database name includes `test`. Its user must be able to create and drop fixture databases. Do not use a production database. Run from the repository root:

```sh
NODE_ENV=test \
QA_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
node --test test/mcp-operation-review-browser.test.js test/mcp-operation-review-expiry-browser.test.js test/mcp-catalog-create-render-browser.test.js test/mcp-catalog-review-render-browser.test.js test/mcp-media-review-browser.test.js test/mcp-operation-review-app-browser.test.js test/mcp-review-entry-browser.test.js
```

`QA_APPROVAL_SCREENSHOT_DIR` is optional. When set, the general review browser fixture captures `approval-{width}-{light|dark}.png` at each of the fourteen viewport/color-scheme combinations. CREATE renderer fixtures also capture `approval-create-no-images-1280.png` and `approval-create-exact-image-390.png`. Run `node --test .ux-shots/shoot.mjs` with the same environment to refresh the catalog, media and approval dialog screenshots at 390×844, 768×1024 and 1440×900. Captures use synthetic proposal data and collapsed technical details. The catalog and media browser tests require 16 pixels between the footer and the decision bar at maximum scroll at 390×844. They exercise the initial layout, a 34-pixel bottom safe area using Chromium's `Emulation.setSafeAreaInsetsOverride`, a wrapped summary and a long approval label. The browser tests also cover one preview per asset per side, one automatic ASSET ACK per unique image, collapsed unchanged fields, named touch targets, responsive preview dimensions, horizontal overflow, expiry, image-free CREATE PAGE acknowledgment, the company currency checkbox, image integrity failures, decoder failure and retries. The screenshot fixture checks that the empty chip stays compact and the gallery placement is visible above the decision bar at all three viewports.

## Historical local verification (2026-11-08)

On 2026-11-08, the eight focused browser/route/entry files passed 26 tests with no skips on SQLite and disposable PostgreSQL. `npm run check` passed. The separately enabled `mcp-production-proxy.test.js` passed against isolated pinned Node/Caddy containers, including root and tenant token asset forwarding and single effective security headers. A separate real-app Chromium smoke exercised full proposal expansion, visible keyboard focus, mobile overflow and password approval; the response explicitly required a subsequent app commit. Screenshots are fixture evidence only, not production acceptance. The full repository suite was not run for this focused UI change.

## Independent validation (2026-11-08)

The final focused browser/entry/expiry run passed 33 tests with zero failures or skips on SQLite and disposable PostgreSQL. It covered root and tenant HTTPS login continuation, shared stylesheet delivery, image-free and decoded-image review, image failure/retry, full-proposal disclosure, responsive layout, expired proposals, expiry during pending delivery/acknowledgment and delayed decision responses. Syntax and whitespace checks passed. The actual native CREATE browser suite also passed 5/5 on both stores before the final expiry/layout cleanup; final native rerun and the full repository suite are recorded separately when complete. These isolated checks use synthetic accounts and products; no production seller approval is claimed.

## Known follow-ups (recorded 2026-11-19)

An independent screenshot-only review scored the redesigned page 82/100 (bar 85) after two rework
rounds. The structural defects it named (action-panel overlap, raw identifiers, duplicate previews,
tall empty state) were fixed and are covered by real-browser assertions. These smaller items remain
open by owner decision:

1. Desktop: a "No photo selected" Before column leaves a wide empty area next to a large After preview;
   render an absent previous image as a compact row above the new preview.
2. Image review: the protected "Exact image" viewer repeats the previewed image; collapse it behind an
   explicitly labelled disclosure without changing verification or acknowledgement behavior.
3. Success dialog wording: refine the Approved/Done copy and button label (the reviewer's suggestions
   conflicted between rounds).
