# Customer discovery regression

Run `npm run test:customer-discovery` with the existing Node24 environment and an
existing Playwright installation/browser. If Playwright is outside this checkout,
set `QA_PLAYWRIGHT_MODULE` to its absolute `index.mjs` path. No browser installation
or cache cleanup is performed by the test.

Optional `QA_EXPECTED_HEAD` rejects a different checkout commit before running.
Optional `QA_OUTPUT_DIR` selects the evidence directory (default
`output/qa/customer-discovery-formal`). The JSON records the commit, worktree
status, source hashes before/after, actual API requests, database snapshots and
browser version. Use one browser worker and run this command sequentially with
other browser suites on a shared machine.

The test runs fourteen cases at390/1280px against actual `Worker.fetch`, the real
API and a temporary file-backed SQLite database. It creates55 fictional products,
checks53 active products across24/24/5 pages, name/SKU search, category
intersections,503 retry behavior, direct detail links and return context. The
database directory is removed on completion. Browser outbound requests are
blocked; there are no order writes, real credentials, messages or payments.

Two delayed-response cases per width hold an actual catalog API response after
the Worker boundary. A delayed reset error and a successful delayed append are
released after A→B→browser-history navigation. Exact product IDs, current status,
retry visibility and the next page must remain correct. This is the catalog
subset of criterion94; the broader rapid-navigation criterion stays UNVERIFIED.
One reset failure is injected after the real API response, and successful
responses retain the real API payload.

The return-context regression reproduces the defect fixed in `f172207`: same-filter
detail navigation used to reset a30-card catalog to its first24 cards and lose
scroll/focus. It now asserts all30 IDs, scroll within3px, the originating link's
focus, browser Back/Forward and a changed-filter history reload.

Catalog cards and public company information are retained snapshots. Same-filter
Back preserves them; an explicit Home/catalog request, filter request, pagination
or reload refreshes them. Product detail reopens with a current product GET. Cart,
checkout and final order submission validate current availability and server
prices. A retained card or Chat link can therefore show the previous price or
phone until that catalog/company snapshot refreshes. No real-time update contract
is implied by these tests.

This command does not certify physical installed PWA lifecycle, production
tenancy, provider behavior, submitted-order cancellation, all100 QA criteria or
the separate18-item production MVP denominator. Historical-source PWA upgrade
evidence must use complete committed assets, including app.js, rather than
changing version labels on one implementation.
