# Seller login and expired-session UI regression

Run `npm run test:seller-session-ui` with Node24 and an existing Playwright
installation/browser. `QA_PLAYWRIGHT_MODULE` may point to an absolute external
`index.mjs`; `QA_EXPECTED_HEAD` optionally rejects a different commit;
`QA_OUTPUT_DIR` selects output (default `output/qa/seller-session-ui`).
The command installs nothing and uses one cached Chromium worker sequentially.

Sixteen bounded cases at390/1280px use actual Seller UI, `Worker.fetch`, the real
API and disposable file-backed SQLite. Criterion41 covers native Enter login,
authenticated reload, keyboard Account/Sign out, revocation, signed-out reload
and keyboard re-login. Criterion45 covers forward/reverse focus order, Space/
Enter activation of password visibility, pressed-state/accessibility labels and
incorrect synthetic login recovery. Visibility uses deliberately invalid,
non-sensitive display text, never the authentication credential.

Criterion44 expires only the single disposable fixture session in local SQLite.
A real dirty product editor Save must receive401, clear the workspace, focus
Username and restore an enabled login form. Keyboard re-auth must load saved
data without replaying the rejected draft. A new, explicit authorized Save must
succeed and persist reload. A second fixture expiry tests reload authentication
failure and another keyboard re-auth. Clearing the rejected editor is observed
existing behavior; this test adds no draft preservation/discard policy.

Signed-out and expired browsers each send ten protected reads/mutations covering
session, products, categories, company settings, shop setup and an order decision.
Every request must return401/UNAUTHORIZED. Every business table (including gallery,
settings, setup and all six order-domain tables) is compared by row count/hash;
all must remain unchanged. Authentication/session/rate-limit bookkeeping is
excluded from the business-write assertion. The sole permitted business change
after provisioning is the later explicit authorized product-name Save.

The actual expired Save is checked by browser response status and the real
Worker/API status record. The UI handles401 without consuming its body;
Playwright body capture did not finish for that discarded response in a preserved
diagnostic run. The protected-request matrix explicitly consumes its JSON and
independently verifies UNAUTHORIZED codes. Service Workers are blocked in this
login scope, so keyboard navigation skips the disabled Check for updates control.

Credentials are randomly generated in memory for the temporary fixture. They are
assigned without password-containing fill traces; screenshots refuse any actual
fixture credential in the input. Artifacts omit passwords, hashes, cookies,
session identifiers, CSRF values and database files. Worker records contain only
method/path/query/body length/status. Errors are redacted. External requests are
blocked, and disposable browser contexts/databases are removed. No real account,
OTP, MFA, CAPTCHA, security challenge or production session is used.

The JSON records exact head, worktree status, source hashes before/after, browser,
per-case results, safe request records, business-table hashes and cleanup results.
Expected totals are six cases each for41/44 and four for45 across both widths.
Partial/failed runs remain labelled. Unexpected browser errors/dialogs fail.

This independent command is outside `npm test` and `.github/workflows/verify.yml`;
existing CI does not execute it or install Playwright. No CI, dependency,
application, credential authority or authentication policy changes are included.
Parse explicitly with `node --check scripts/qa-seller-session-ui.mjs` because
`npm run check` covers application `.js` files. Local passes do not certify real
accounts, physical devices, deployed authentication, tenant isolation, providers
or the remaining100/18-item production release gates.
