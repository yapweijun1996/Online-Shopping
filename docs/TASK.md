# Executable task ledger

**Scope: the new Online Shopping MVP unless marked `SAMPLE`.** This file supersedes the former [TASKS.md](TASKS.md) checklist and retains its task IDs. `Recorded` means a planning decision exists, not that software implements it. `Verified` requires the stated evidence; `Released` requires deployed proof. Acceptance progress is counted from the 18 `AC` items in [SPEC.md](SPEC.md), not from task rows.

| ID | Priority / status | Depends on | Done condition and evidence needed |
| --- | --- | --- | --- |
| DOC-01 | P0 / Verified | — | Core goal, design, API, roadmap, task and progress documents describe the planned new app and separate `sample/`. Documentation audit and link checks. |
| DOC-02 | P0 / Verified | DOC-01 | [GOAL_PROMPT.md](GOAL_PROMPT.md) matches this project and is at most 2,000 characters; measured character count. |
| DEC-01 | P0 / Recorded | — | Seller-managed products and active-only public visibility are explicit in GOAL/SPEC/API; implement via API-03. |
| DEC-02 | P0 / Open | — | Record one policy for shop currency, mixed-currency carts, shipping charges, and delivery countries/postcodes; update SPEC/API before related writes. GST calculation is out of MVP scope. Blocks final catalog/checkout contract. |
| DEC-03 | P0 / Recorded | — | One super admin is bootstrapped from ignored server-side `.env`, with no built-in production credentials; implement via API-02. |
| DEC-04 | P0 / Open | — | Select hosting, database, session persistence, contact-data retention/deletion, backup and recovery policy. Needed before real-data release; stack choice precedes API-01. |
| DEC-05 | P1 / Open | — | Decide product image storage and initial catalog display; update catalog API and UI scope before image work. |
| API-01 | P0 / Planned | DEC-04 stack choice | Create new API entry point and private data store, separate from `sample/`; prove startup, health/readiness, and private database location. |
| API-02 | P0 / Planned | API-01, DEC-03 | Implement super admin login/session/logout, secure cookie/CSRF, generic rate-limited failures, and authorization on every seller endpoint; AC-01–02 tests. |
| API-03 | P0 / Planned | API-01–02, DEC-02 currency, DEC-05 if images used | Implement validated seller product CRUD/status and public active-only list/detail/search/category; AC-03–04 contract tests. |
| WEB-00 | P0 / Planned | API-02–03 | Build responsive seller login, SVG-icon collapsible side bar/mobile drawer, session-backed profile/sign-out menu, and product management with loading/error/empty/success states; phone/desktop browser checks. |
| WEB-01 | P1 / Planned | API-03 | Build original public discovery and product detail UI against the API; active-only and responsive browser checks. |
| WEB-02 | P1 / Planned | WEB-01 | Build cart and IndexedDB convenience persistence; reload and cache-failure browser checks for AC-05. |
| API-04 | P0 / Planned | API-03, DEC-02 | Validate buyer, destination, recipient, +60/+65 phones, assignments, quantities and consent; normalize phones, calculate server totals/snapshots without GST; AC-06–08 tests. |
| API-05 | P0 / Planned | API-04 | Commit order number, snapshots, first event and idempotency result atomically; retries/conflicts/failure tests for AC-09–10. |
| WEB-03 | P0 / Planned | WEB-02, API-04–05 | Build guest multi-destination checkout with Malaysia/Singapore phone country selection, field errors and confirmed same-browser receipt; AC-06–11 browser checks. |
| API-06 | P0 / Planned | API-05 | Implement seller queue/detail, revision-fenced confirm/reject and append-only audit; AC-12–13 authorization/state tests. |
| API-07 | P0 / Planned | API-02–06 | Cover invalid input, duplicate retries, concurrent decisions, access control and persistence failure; run affected regression suite. |
| WEB-04 | P0 / Planned | API-06 | Build `Sales Manager`, `Sales Orders`, and `Sales Order Confirmation` over one order state; phone/desktop review checks. |
| WEB-05 | P1 / Planned | WEB-04, AC-06 consent | Add seller-only official click-to-chat for an opted-in buyer; verify normalized URL and no automatic send. |
| WEB-06 | P1 / Planned | WEB-04 | Add individual contact/address copy controls with permission-sensitive visibility and success/failure feedback; browser clipboard checks. |
| PWA-01 | P0 / Planned | WEB-00–03 | Make seller and shop surfaces installable over HTTPS with separate manifests/scopes and correct icons; add safe offline shells, online-only order/review mutations, private-cache exclusion, and update/install checks for AC-17. |
| I18N-01 | P0 / Planned | WEB-00–03, API-03 | Implement English default and the six additional languages in the specified order across both surfaces. Translate core UI/error/accessibility text, format dates/numbers by locale, and support optional localized product text with English fallback; verify AC-18. |
| QA-01 | P0 / Planned | WEB-00–06, API-07, PWA-01, I18N-01 | Run main seller setup, guest checkout, receipt and seller review journeys in real browsers at phone and desktop widths; keyboard, overflow, console, PWA and seven-language checks for AC-15/17/18. |
| QA-02 | P0 / Planned | API-07, QA-01 | Verify frontend/API contracts and sensitive-data boundaries, including no public contact lookup and no private API caching. |
| OPS-01 | P0 / Planned | DEC-04, API-01 | Add chosen stack's CI/build checks, migrations, backup/restore, health/readiness, operational logs and rollback runbook; verify each against a release candidate. |
| REL-01 | P0 / Planned | QA-01–02, OPS-01, AC-16 | Inspect public files/artifact for secrets/PII; verify deployed version, health and rollback before marking any feature Released. No push or release is authorized by this documentation task. |
| DOC-03 | P1 / Planned | Implemented milestones | Keep README, design, API, SPEC, TASK and PROGRESS aligned with actual implementation, run commands and changed contracts. |
| SAMPLE-01 | P2 / Open, sample only | — | Repair or update the stale `sample/test/fulfillment.test.js` revision-snapshot assertion; rerun Node 24 suite. Current result: 31/32 pass, expected 2 rows but current append-only revisions produce 4. This is not an MVP acceptance item. |
| LATER-01 | Deferred | MVP complete; verified external format | Verify Ninja Van import requirements before proposing any CSV/Excel export or courier integration. |

## Resume point

Start with **DEC-04's local runtime/store/session choice**, then implement API-01/API-02 and WEB-00 as the first vertical seller setup slice. Resolve DEC-02 before persisting priced products or finalizing checkout behavior. Do not copy sample credentials, customer access links, logistics workflow, or UI into the new app.
