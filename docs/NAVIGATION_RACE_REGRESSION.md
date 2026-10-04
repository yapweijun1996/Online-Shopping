# Missing-route navigation race regression

Criterion94 is "Rapid navigation and stale response recovery". Prior evidence covers Customer catalog reset/append history races and Seller order detail A-to-B races at their original source heads. This command supplements those checks with the explicit missing-route matrix below; it does not certify all routes or all100 criteria.

On unchangedca882f1, repeated390/1280 tests reproduced stale Seller callbacks changing the current route/title, overwriting a newly opened product draft, appending an old Company setup card into Dashboard, reporting old save results on another settings page, mutating detached components and throwing an unhandled settings error. The common workspace root remains connected when its children are replaced, so root.isConnected alone does not identify the mounted form.

Product, Company and category callbacks now check their own mounted form/view. Product save completions also retain the initiating route sequence. A committed API write still completes normally; the stale callback cannot reset a later editor or navigate/focus a different page. Mutation bookkeeping still finishes. API authorization, business rules, currency/prices, order policies and CI are unchanged. Seller app/worker versions advance together to86; Shop remains110.

Run `scripts/qa-navigation-races.mjs` with `QA_PLAYWRIGHT_MODULE` pointing to the existing cached Playwright module, `QA_EXPECTED_HEAD` set to the exact source commit and `QA_OUTPUT_DIR` set to the evidence destination. `QA_CASE_FILTER` optionally selects a bounded diagnostic subset; it cannot produce the full42-case acceptance result.

|Cases|Routes and delayed replies|Checks|
|---|---|---|
|C1-C2|Customer detail A200→B; A503→B→history A|Selected product, document title, status and focus stay current|
|C3-C5|A recommendations200→B; detail200→Settings; recommendations503→Catalog→history A|Correct related IDs, hidden detail and optional-response isolation|
|C6|Current B503→Retry|Exact selected B recovers|
|S1-S3|Seller edit A200→B; A503→New; A200→Dashboard→A remount|Current fields, empty editor and detached component protection|
|S4-S6|Committed A save200→Company; A save200→B draft; real stale409→Dashboard→A remount|No stale navigation, status, field or focus changes; committed result remains in SQLite|
|E1-E2|Company setup200→Dashboard; settings503→B edit|No old setup append or late error in current page|
|E3-E5|Company save200→Categories; category load200→Company; category save200→Company|Status isolation and no detached list mutation|
|D1-D3|Dashboard setup200→B→Dashboard; product panel200→Company; order panel503→B→Dashboard|Current shell/panels and detached panel isolation|
|D4|Current Dashboard product panel503→Retry|Panel recovers correctly, including empty order state|

All21 cases run at390/1280, serially in one cached Chromium browser worker. Responses pass through the actual Worker and API before controlled delivery. Synthetic503 applies only to GET responses; Save200 and409 are actual API results. Independent cases use a real full-page reload; this avoids inheriting the intentionally corrupted source-state of a preceding reproduction. Real native discard confirmations are accepted only for synthetic fixtures. No browser install/GC or Printform suite is run.

The harness checks current route/title/fields/status/focus, detached DOM observations, actual committed fixture writes, unchanged prices/currencies and unchanged order tables. API logs retain only method/path/query/body size/status. Random synthetic credentials and tokens are never serialized. Browser contexts, servers and in-memory databases close after each width.

Out of scope:401/session/authorization transitions, async file-reader/image-upload races, zoom/dialog lifecycle races, arbitrary combined back/forward/locale/offline failures, Customer checkout/Profile/address save races, physical devices/installed PWAs/Safari/real Edge, production/provider behavior and broad performance stress. Catalog/order tests are not recounted at the new head. Criterion94 remains overallUNVERIFIED with a scoped matrix result; all deployed statuses remainUNVERIFIED. New Seller86 native PWA upgrade is not certified by this SW-blocked matrix.
