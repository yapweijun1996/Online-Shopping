# Progress

**As of 2026-09-25 (Asia/Singapore).** The new Online Shopping application is an **MVP in local development**. The separate `sample/` is a local PWA/API/SQLite prototype. Its functionality and test results do not count toward the new MVP.

## Evidence-based state

The denominator is the **18 independent AC-01–18 acceptance items** in [SPEC.md](SPEC.md). A planned design is not implementation; code without passing applicable checks is not verified; a local result is not released.

| New MVP state | Count | Basis |
| --- | ---: | --- |
| Planned | 18/18 | Requirements and acceptance gates recorded in SPEC, including PWA and seven-language UI. |
| Implemented | 1/18 | AC-01 seller sign-in/current-session/sign-out and configuration checks have runnable code. |
| Verified | 1/18 | AC-01 passed config/startup, API/session/CSRF, and browser login/reload/logout checks. This is local proof only. |
| Released | 0/18 | No new-app artifact, deployment, registry/tag/release, or deployed health/version proof exists. |

Documentation milestone **M0: 1/5 milestones verified** after the initial documentation audit and local commit. M1 is in progress; M2–M4 remain planned. This milestone count is separate from the 1/18 locally verified product acceptance count.

## Current development slice

| Check | Evidence and limit |
| --- | --- |
| Runtime/config | Node 24.20.0 syntax checks pass. The new-app scoped suite has 14/14 `node:test` checks passing, including cart storage-failure fallback, seven-language resource completeness, +60/+65 number normalization, manifest/icon integrity, production credential startup refusal, private database mode, health/readiness separation, session persistence, CSRF, logout, rate limiting, and static-file isolation. A root-wide `node --test` also collected the separate sample suite and reproduced its known 31/32 result; the project test script targets only `test/`. `npm audit --omit=dev` reported zero vulnerabilities for the one pinned runtime dependency. |
| Browser | Chromium seller login, reload persistence, account/profile, mobile drawer/Escape/focus return, language switch to Simplified Chinese, and logout worked at 390px and desktop widths. The measured 390px document had no horizontal overflow; a fresh run logged no console errors. This is a bounded seller-shell smoke, not AC-15/18 verification. |
| Security boundary | No credential is built into app source. Admin password is scrypt-hashed; server sessions use hashed tokens in private SQLite, `HttpOnly`/`SameSite=Strict` cookies, same-origin mutation checks and CSRF. Production hosting, multi-instance rate limiting, backup, retention, and deployment security remain unverified. |
| PWA shell | Local Chromium registered separate `/seller/` and `/shop/` workers. The observed caches contained only listed static assets and no `/api/` entries; both surfaces showed offline pages with no console errors or 390px overflow. Worker updates waited while old pages were controlled, then activated after navigation and removed old caches. Manifest PNG dimensions passed a file-level check. Install prompts and target-device behavior remain unverified. |
| Cart storage | Local Chromium saved a product ID/quantity pair to IndexedDB, reloaded, read the same pair, then cleared it. Tests confirmed page-memory behavior when IndexedDB is unavailable or opening throws. No product/cart UI or checkout exists yet, so AC-05 remains incomplete. |
| Phone normalization | A server helper accepts structurally valid +60/+65 numbers and returns E.164; tests reject unsupported countries, short numbers, extensions, and malformed input. The helper is not yet wired to an order API or browser form, so AC-06–07 remain incomplete. Number validity does not establish reachability or ownership. |

## Verification performed in this pass

| Check | Result and limit |
| --- | --- |
| Repository/rules/history | Inspected README, all first-party docs, source entry points/services, manifest, tests, ignore files, and Git state/history. No repository AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CI/release workflow, or tag was present. Only `.gitattributes` was tracked at audit start; `.gitignore`, README, docs, and `sample/` were untracked user work. |
| KB-MCP | Live status was healthy. Recall returned one related project-focus memory; unrelated results were not treated as repository facts. Current code and explicit local decisions remain authoritative. |
| Prototype tests | `sample/`: `npx --yes node@24 --test` on Node 24.20.0 ran 32 tests: 31 pass, 1 fail. `fulfillment.test.js:25` expects 2 delivery rows across the order but confirmation copies two rows into revision 2, so the unfiltered query sees 4. The later assertion also expects source revision 1 despite current confirmation revision 2; recheck after repairing the test. This is `SAMPLE-01`, not a new-MVP failure. |
| Prototype runtime/API | Started the sample with an in-memory SQLite database: `/health` returned 200 and an unauthenticated `/api/seller/me` returned 401. This does not prove production readiness or new-app behavior. |
| Prototype browser | At 390px width, viewed shop catalog/detail/cart and seller login/products. Cart add feedback appeared; checkout stayed disabled without an address. Observed no horizontal overflow or console warning/error on those visited states. This is a limited sample smoke, not a full checkout/order-review E2E or new-app UI verification. |
| Documentation | Checked 13 first-party Markdown files for relative links, 18 ordered acceptance IDs, the 1,787-character goal prompt, both PNG preview headers/dimensions, and the final documentation diff. These checks verify document consistency, not product behavior. |

## Open decisions, risks, and next work

- **DEC-04:** local Node 24/SQLite and persisted sessions are implemented. Production hosting/database, multi-instance behavior, real-data retention/recovery and backups remain unresolved; no deployment choice has been made.
- **DEC-02/DEC-05:** currency, shipping, delivery geography/postcodes, and product image handling remain unresolved. GST calculation is out of MVP scope; buyer and recipient phone support for +60/+65 is recorded. The open choices block final priced-catalog/checkout contract decisions.
- **SAMPLE-01:** one prototype test is stale against revisioned append-only snapshots. No prototype source or test repair is included in this documentation pass.
- PWA shells, offline fallback, and seven-language shell resources exist. Actual installability across target browsers, mutation behavior offline, and complete translation/browser QA remain unverified.
- No new-app production build, CI, complete browser E2E, migration/restore, secret scan, deployment, release, or rollback verification exists yet. Local seller smoke and sample checks cannot fill those gaps.

**Resume point:** await the DEC-02 commerce and DEC-05 image policy choices, then implement the seller product API and management UI (API-03/WEB-00). The independent PWA and cart storage groundwork is in place; connect the cart to real products only after catalog behavior is settled. Record implementation, verification, and release evidence per AC row as work proceeds.
