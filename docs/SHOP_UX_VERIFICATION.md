# Shop checkout and catalog UX verification — 2026-09-30

Changes: cart checkout resumes checkout after saving the first profile; an empty address book opens the address form directly; recipient phone uses the full available column; catalog search/category are shareable URL parameters restored on reload and browser history. Shop offline cache advances to v76.

Local release gates passed on Node 24.21.0: JavaScript syntax checks, 95 unit/API tests, Wrangler deployment dry-run. Production dependency audit reported zero vulnerabilities.

Chromium browser checks used only synthetic browser-local contacts and an isolated demo database. Verified cart quantity 2 and MYR 50.00 total after reload; interrupted profile setup and profile reload/save resume; repeated checkout and profile edit resume; direct empty-address form; Close/reopen; address save and reload persistence; populated chooser, Add address and Escape/reopen. Search tofu returned five results after reload; query/category direct links and Back/Forward passed at desktop and 375×812 mobile. Recipient phone measured 376px desktop and 343px mobile, without horizontal overflow. Browser console had no errors or warnings. No orders, payments or customer messages were submitted.

Browser checks exposed a double-validation race from handling both popstate and hashchange. The popstate filter handler now renders only catalog routes, leaving checkout hash routing to its existing handler.

Screenshots and browser execution evidence remain in the task workspace under output/playwright. Deployment and live verification are recorded in the task outcome.
