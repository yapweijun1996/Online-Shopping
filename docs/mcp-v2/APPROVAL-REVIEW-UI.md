# Seller MCP approval review UI

The first-party operation review page presents a business summary before the complete technical proposal. Catalog CREATE shows the new product; UPDATE shows before and after values, including every product in the complete catalog review projection. The summary covers name, SKU, price, stock, availability, category, description and options when provided. Availability maps the existing product `active` flag to **Listed** or **Not listed**; it does not describe stock. MYR and SGD prices are shown with their currency code and two decimal places. A missing currency is explicitly labelled as minor units with currency not provided; unknown currencies are not guessed or converted.

Full proposal details are initially collapsed. Expanding them exposes the complete text-safe proposal, including fields not recognized by the business summary. The summary is a reading aid, not a replacement for the bound proposal or an additional source of authorization.

Expiry is displayed in the seller browser's local date/time, with the exact UTC timestamp in its title. At expiry the page disables decision controls and image acknowledgments, clears the password and asks for a fresh preview. Submission checks the deadline again, including when a background-tab timer was delayed. Pending media verification or a failed decision request cannot reenable expired controls. Server-side expiry validation remains authoritative.

## Images and acknowledgments

Only after complete manifest validation, an image-free proposal hides the image viewer and explicitly says **No images**. PAGE delivery and acknowledgment still take place. The seller's media confirmation remains unchecked, and approval still requires the explicit confirmation and fresh password.

For proposals containing images, each exact ASSET must pass delivery integrity checks and browser decoding before its image acknowledgment is enabled. Switching references clears the previous image immediately. Failed delivery, verification or decoding hides the failed image, disables its acknowledgment and retains the **Image verification failed** status. Approval remains disabled until all unique images have been explicitly reviewed; a failure to revisit an already acknowledged image does not revoke its existing bound acknowledgment. Retry requests and decodes the image again; it does not acknowledge an image on the seller's behalf.

## Appearance and limits

The page loads canonical `../shop/tokens.css` through existing root and tenant static routes, with no review-specific stylesheet alias or proxy exception. Review-scoped semantic aliases reference canonical tokens for light and dark presentation, without a new hardcoded palette or script dependency. At 380–600 pixels the field column is at least 100 pixels wide; below 380 pixels each field label spans the row with Before/After values underneath. Browser regressions cover 320, 360, 379, 380, 390, 768 and 1440 pixel widths in both color schemes, readable labels, horizontal overflow, text-safe untrusted values and initially collapsed technical details.

This is a UI redesign only. Authentication, tenant routing, current-session and original-grant checks, origin/CSRF protection, fresh-password requirements, challenge expiry and single use, PAGE/ASSET proof binding, media acknowledgment, approval policy and server-side limits are unchanged. Browser decoding and acknowledgment do not prove human eyesight. Synthetic renderer fixtures are not evidence of actual CREATE/UPDATE authorization or production deployment. See [the threat model](../threat-model.md).

## Browser checks and fixture screenshots

Set `QA_PLAYWRIGHT_MODULE` to an installed Playwright module's absolute `index.mjs` path. Its matching Chromium browser must be available; deterministic expiry regressions require Playwright 1.45 or newer with browser clock support. Without that variable these optional browser tests are skipped. Set `SHOP_TEST_DATABASE_URL` to a disposable PostgreSQL database URL whose database name includes `test`; its user must be able to create and drop fixture databases. Do not use a production database. Run from the repository root:

```sh
NODE_ENV=test \
QA_PLAYWRIGHT_MODULE=/tmp/shop-approval-browser/node_modules/playwright/index.mjs \
QA_APPROVAL_SCREENSHOT_DIR=/tmp/approval-review-screenshots \
node --test test/mcp-operation-review-browser.test.js test/mcp-operation-review-expiry-browser.test.js test/mcp-catalog-create-render-browser.test.js test/mcp-catalog-review-render-browser.test.js test/mcp-media-review-browser.test.js test/mcp-operation-review-app-browser.test.js test/mcp-review-entry-browser.test.js
```

`QA_APPROVAL_SCREENSHOT_DIR` is optional. When set, the general review browser fixture captures `approval-{width}-{light|dark}.png` at each of the fourteen viewport/color-scheme combinations. CREATE renderer fixtures also capture `approval-create-no-images-1280.png` and `approval-create-exact-image-390.png`. Captures use synthetic proposal data and collapsed technical details; do not substitute production seller sessions or customer data. The remaining tests exercise image-free CREATE PAGE acknowledgment, password and checkbox requirements, full UPDATE summaries, image integrity failures, explicit image acknowledgment, decoder failure and retry behavior.

## Local verification

On 2026-11-08, the eight focused browser/route/entry files passed 26 tests with no skips on SQLite and disposable PostgreSQL. `npm run check` passed. The separately enabled `mcp-production-proxy.test.js` passed against isolated pinned Node/Caddy containers, including root and tenant token asset forwarding and single effective security headers. A separate real-app Chromium smoke exercised full proposal expansion, visible keyboard focus, mobile overflow and password approval; the response explicitly required a subsequent app commit. Screenshots are fixture evidence only, not production acceptance. The full repository suite was not run for this focused UI change.

## Independent validation (2026-11-08)

The final focused browser/entry/expiry run passed 33 tests with zero failures or skips on SQLite and disposable PostgreSQL. It covered root and tenant HTTPS login continuation, shared stylesheet delivery, image-free and decoded-image review, image failure/retry, full-proposal disclosure, responsive layout, expired proposals, expiry during pending delivery/acknowledgment and delayed decision responses. Syntax and whitespace checks passed. The actual native CREATE browser suite also passed 5/5 on both stores before the final expiry/layout cleanup; final native rerun and the full repository suite are recorded separately when complete. These isolated checks use synthetic accounts and products; no production seller approval is claimed.
