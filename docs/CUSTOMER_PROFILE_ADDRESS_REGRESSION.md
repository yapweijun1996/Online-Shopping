# Customer Profile and address regression

Run `npm run test:customer-profile-address` with Node24 and an existing Playwright
installation/browser. Set `QA_PLAYWRIGHT_MODULE` to its absolute `index.mjs` path
when Playwright is outside this checkout. `QA_EXPECTED_HEAD` optionally rejects a
different commit; `QA_OUTPUT_DIR` optionally selects evidence output (default
`output/qa/customer-profile-address`). This command performs no installation.

Sixteen cases at390/1280px exercise the actual UI and browser local/session
storage, actual `Worker.fetch`/API and a temporary file-backed SQLite database.
The fixture creates one fictional category/product through authenticated local
Seller API calls. Credentials are generated in memory; contacts and addresses
are fictional. Browser external requests are blocked. One browser worker runs
sequentially; two pages share localStorage for address storage-event tests.
Temporary databases are removed on completion.

Criterion23 checks unsaved Profile route changes, browser Back, Settings return,
explicit Save/reload and Cart-origin edit/Save return with preserved cart and
session selection plus Checkout focus. Same-document navigation retains a dirty
Profile form without writing it to storage. Explicit reload restores only the
saved Profile. The existing specification does not define reload/close draft
protection: the report records observed behavior and leaves criterion23
UNVERIFIED. It does not introduce auto-save, a new discard policy or a prompt.
The PWA update guard has separate prior evidence.

Criterion24 checks Add/Edit cancellation, explicit saves, stable IDs/reload,
default selection/reload, Delete confirmation cancellation, confirmed default
deletion/fallback, chooser cancellation and final deletion/reload. Selected
addresses are edited both in the same page and through a second actual UI page.
Checkout then submits the latest selected address rather than another default;
the real request and SQLite delivery snapshot must match every address field.

Deleting the selected ID blocks checkout while a different default remains.
Reload must remain blocked. A defensive form submit and an empty address book
must produce no order POST and leave all six order-domain tables and cart
unchanged. Explicit replacement-address Save restores the intended selection;
the second local fictional order must snapshot that new address. Native dialog
responses are specified per Delete action, and unexpected dialogs fail the run.

Evidence records exact head, worktree status, application source hashes
before/after, browser version, per-case checks, storage snapshots, real Worker
requests, order-domain snapshots and screenshots. A partial/failed run must not be
reported as complete. The expected full count is six criterion23 behavior cases
and ten criterion24 cases across the two widths.

This is an independent browser command. Existing `npm test` and
`.github/workflows/verify.yml` do not run it or install Playwright. `npm run check`
checks application JavaScript but does not parse these `.mjs` QA scripts; check
this script explicitly with `node --check scripts/qa-customer-profile-address.mjs`.
No CI workflow or dependency is changed. Local execution does not prove a remote
CI run, physical installed-PWA behavior or production acceptance. The separate
18-item MVP denominator and payment/courier exclusions remain unchanged.
