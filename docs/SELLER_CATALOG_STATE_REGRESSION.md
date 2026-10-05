# Seller availability and category regression

Run `npm run test:seller-catalog-state` with Node24 and an existing Playwright
installation/browser. `QA_PLAYWRIGHT_MODULE` can point to an external absolute
`index.mjs`; `QA_EXPECTED_HEAD` optionally rejects a different commit;
`QA_OUTPUT_DIR` selects evidence output (default `output/qa/seller-catalog-state`).
The command installs nothing and uses one cached Chromium worker sequentially.

Sixteen cases at390/1280px exercise actual Seller/Customer UI and `Worker.fetch`,
the real API and a temporary file-backed SQLite database. Fixtures use generated
in-memory credentials, fictional categories/products and the existing icon PNG.
No real accounts, contacts, payments, logistics or production data are used.
External browser requests are blocked; temporary databases are removed.

Criterion49 covers product deactivation/Undo, activation/Undo, persisted
availability after reload and a stale Undo after another actual Seller page
changes availability. API/SQLite and fresh Customer catalog/detail/image
responses must agree with the active flag. SKU/name/description/category/price/
currency/image bytes and the other product must remain unchanged. Successful
Undo restores the previous flag and keyboard focus; stale Undo fetches the latest
flag and sends no PATCH when that flag has changed. Undo controls are page-local
and do not persist reload. This is not an atomic read/write or ABA-race proof.

Criterion56 covers category create/label edit/immutable code/reload, unused
category deactivation, referenced category deactivation and reactivation. The
existing [API contract](API.md#managed-categories-and-company-settings) says that
deactivation prevents new assignments without deleting/hiding already-assigned
products. The test uses that rule rather than creating a cascade or new policy.
Inactive categories are excluded from new-product options; the existing editor
keeps its assigned inactive code. API create/move to an inactive code fail400
without product/order changes. Re-enabling permits a new inactive fictional
product assignment and preserves every original product.

Fresh Customer category labels/filter results and detail/purchase controls remain
available for an active product in an inactive category. A label edit changes
the public display label, while the product keeps its stable category code.
Customer checks deliberately use the actual Home action to refresh the catalog;
same-document/same-filter catalogs remain snapshots under the existing contract.
API/detail/image checks do not certify cached images on a device or CDN.

The JSON records exact head, worktree status, source hashes before/after,
browser version, actual mutation payloads/statuses, API/SQLite states, Worker
requests and screenshots. All six order-domain tables must remain unchanged.
Eight cases per criterion across both widths constitute the complete bounded run;
partial or failed runs must remain labelled. Unexpected dialogs fail the test.

This command is independent of `npm test` and `.github/workflows/verify.yml`;
existing CI does not execute it or install Playwright. No CI/dependency changes
are included. Parse the new harness explicitly with
`node --check scripts/qa-seller-catalog-state.mjs`, since `npm run check` covers
application `.js` files. Local passes do not certify remote CI, physical devices,
production tenancy, provider behavior or the remaining100/18-item release gates.
