# Multi-tenant release ledger

Started 2026-10-10 (Asia/Singapore). Source of truth: [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md). Evidence files are git-ignored under `output/qa/multi-tenant/`. No production test data is permitted.

## Release state

| Release | State | Evidence |
| --- | --- | --- |
| R0 | DEPLOYED, VERIFIED | [PR #126](https://github.com/yapweijun1996/Online-Shopping/pull/126), merge `ada984ba9feab52cb7f22abf4bf2e205af238092`; deployed log followed by `up_to_date`; 10 production probes and zero restarts. |
| R1 | DEPLOYED, VERIFIED | [PR #127](https://github.com/yapweijun1996/Online-Shopping/pull/127), merge `71f5d27b1abc1471e6b7e8da740138dd122a58b2`; branch/PR CI green. |
| R2 | REVERTED ON MAIN; PRODUCTION ROLLBACK PENDING | 482 unit tests; 108 real Caddy checks; two installed PWAs with standalone offline launch and controlled rename; baseline pass-set retained. |
| R3 | SOURCE PREPARED; REAL-STACK GATE BLOCKED | Operations and migration recovery; remote CI green, Docker rehearsal remains unavailable. |
| R4 | PARTIALLY PREPARED; ACTIVATION NOT STARTED | Capacity harness and owner checklist prepared; real rehearsal, drills, capacity and activation remain gated. |

## Decisions and environment — 2026-10-10

- D0-01: `origin/main` already includes the reviewed corrections via [PR #125](https://github.com/yapweijun1996/Online-Shopping/pull/125). Branch the executor worktree from that main, preserve the other session checkout and branch. Worktree: `/Users/yapweijun/Documents/GitHub/Online-Shopping-mt`; R0 branch `feat/mt-r0-docs`.
- D0-02: The routed investigation, architecture and verification files are absent in the repository; applicable global copies were read from `/Users/yapweijun/.codex/instruction-modules/`.
- D0-03: Bounded KB reuse retrieval found no applicable Online-Shopping implementation record; use inspected source, current runtime and this goal. Other-project search hits are not release authority.
- D0-04: Frontend and tunnel containers have no configured Docker healthcheck. Record running state, zero restarts and public probes instead of falsely reporting a Docker healthy field. Keep protected service definitions unchanged.
- D0-05: Run every existing script directly with a scrubbed environment, no credentials, disposable tests only. Exported snippets with exit 0 are module-load checks, not browser scenario passes; argument-gated operational scripts are prerequisites failures, not functional regressions.
- D0-06: Preserve project commit attribution using `Co-Authored-By: Codex <noreply@openai.com>`.
- `compose_violations`: postgres/tunnel and existing secrets/volumes/networks must be unchanged; new services/secrets allowed; application services may not add privileges, host namespaces, outside-release bind mounts or non-loopback ports. Read `deploy/auto-update.py:116`.
- Production baseline: updater `up_to_date`, current `feb8707948231e4c55c48ee517de90146b1e9507`; backend and postgres healthy; frontend and tunnel running; all restart counts 0; `SHOW max_connections` = 100; load averages 61.83/49.94/33.71. Heavy work runs serially.
- Node `v24.21.0`; disposable PostgreSQL 16 on loopback port 55432; Playwright installed outside the repository. Private scratch paths recorded only in local evidence.

## R0 baseline scripts

Command environment: Node 24, `NODE_ENV=test`, disposable `SHOP_TEST_DATABASE_URL`, external `QA_PLAYWRIGHT_MODULE`, no production credentials. Runner: `python3 output/qa/multi-tenant/run-baseline.py`. All scripts present on initial main were invoked before code changes.

| Script | Command | Result |
| --- | --- | --- |
| `scripts/check.js` | `node scripts/check.js` | PASS |
| `scripts/database-evidence.js` | `node scripts/database-evidence.js` | BASELINE FAILURE (exit 1) |
| `scripts/demo-gallery-assets.py` | `python3 scripts/demo-gallery-assets.py` | BASELINE FAILURE (exit 1) |
| `scripts/gallery-gesture-browser-check.js` | `node scripts/gallery-gesture-browser-check.js` | PASS (module load only) |
| `scripts/import-sqlite.js` | `node scripts/import-sqlite.js` | BASELINE FAILURE (exit 1) |
| `scripts/prepare-postgres-schema-proof.mjs` | `node scripts/prepare-postgres-schema-proof.mjs` | PASS |
| `scripts/qa-checklist.js` | `node scripts/qa-checklist.js` | PASS |
| `scripts/qa-customer-discovery.mjs` | `node scripts/qa-customer-discovery.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-customer-profile-address.mjs` | `node scripts/qa-customer-profile-address.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-draft-browser.mjs` | `node scripts/qa-draft-browser.mjs` | PASS |
| `scripts/qa-followup-browser.mjs` | `node scripts/qa-followup-browser.mjs` | PASS |
| `scripts/qa-image-save-ownership.mjs` | `node scripts/qa-image-save-ownership.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-input-create-races.mjs` | `node scripts/qa-input-create-races.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-integrated-repair.mjs` | `node scripts/qa-integrated-repair.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-navigation-races.mjs` | `node scripts/qa-navigation-races.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-priority-browser.mjs` | `node scripts/qa-priority-browser.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-priority-probe.mjs` | `node scripts/qa-priority-probe.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-pwa-lifecycle.mjs` | `node scripts/qa-pwa-lifecycle.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-pwa-seller-followup.mjs` | `node scripts/qa-pwa-seller-followup.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-seller-catalog-state.mjs` | `node scripts/qa-seller-catalog-state.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-seller-session-ui.mjs` | `node scripts/qa-seller-session-ui.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-session-history-races.mjs` | `node scripts/qa-session-history-races.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-share-ui-branches.mjs` | `node scripts/qa-share-ui-branches.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa-usability-palette.mjs` | `node scripts/qa-usability-palette.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa94-finite.mjs` | `node scripts/qa94-finite.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa94-git-assets.mjs` | `node scripts/qa94-git-assets.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa94-pwa.mjs` | `node scripts/qa94-pwa.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa94-shop-upgrade.mjs` | `node scripts/qa94-shop-upgrade.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/qa94-support.mjs` | `node scripts/qa94-support.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/replace-catalog.mjs` | `node scripts/replace-catalog.mjs` | BASELINE FAILURE (exit 1) |
| `scripts/reset-seller-password.js` | `node scripts/reset-seller-password.js` | BASELINE FAILURE (exit 2) |
| `scripts/seed-demo-products.js` | `node scripts/seed-demo-products.js` | BASELINE FAILURE (exit 1) |
| `scripts/upgrade-database.mjs` | `node scripts/upgrade-database.mjs` | BASELINE FAILURE (exit 1) |
| `test/browser/catalog-density.js` | `node test/browser/catalog-density.js` | PASS (module load only) |
| `test/browser/product-layout.js` | `node test/browser/product-layout.js` | PASS (module load only) |
| `test/browser/product-share.js` | `node test/browser/product-share.js` | PASS (module load only) |
| `test/browser/seller-e2e.js` | `node test/browser/seller-e2e.js` | PASS (module load only) |
| `test/browser/seller-pdf.js` | `node test/browser/seller-pdf.js` | PASS (module load only) |
| `test/browser/seller-stale.js` | `node test/browser/seller-stale.js` | PASS (module load only) |
| `test/browser/worker-harness.mjs` | `node test/browser/worker-harness.mjs` | BASELINE FAILURE (exit 1) |

Actual browser pass-set: `scripts/qa-draft-browser.mjs` and `scripts/qa-followup-browser.mjs`. Preserve these through each release. `scripts/check.js`, `scripts/prepare-postgres-schema-proof.mjs`, and `scripts/qa-checklist.js` also passed. Most other QA scripts import removed `src/worker.js`; no stale Worker script was repaired. Raw diagnostics: `output/qa/multi-tenant/baseline/`.

## Acceptance evidence

| Item | Current evidence | Status |
| --- | --- | --- |
| MT-01 | At 02:05 both public readiness endpoints return 200 on R2, four containers running with zero restarts; backend/PostgreSQL healthy. Rollback recovery main `62159f6` remains undeployed: updater `failed_release_waiting`, no pending deployment, Docker exec and production backup exceed deadlines. Historical full baseline remains recorded. | BLOCKED ROLLBACK DEPLOYMENT |
| MT-02 | R1 disabled-config tests, CI without platform secrets, and inert production deployment. | PASS |
| MT-03 | Authentication/replay/lockout/recovery/CSRF/reset tests pass; real rehearsal enrolment/sign-in is unavailable. | BLOCKED REHEARSAL |
| MT-04 | Console source prepared and independently reviewed; 360–1280 px, keyboard/a11y and CSP browser journey unverified. | BLOCKED REHEARSAL |
| MT-05 | Own-role creation, forced password change, no-store and one-time response API tests pass; console creation needs rehearsal. | BLOCKED REHEARSAL |
| MT-06 | `tenant-routing.test.js`: full matrix, streamed POST, no rejected tenant store opens, cache/probe bounds and eviction identity. R1/R2 full suite. | PASS |
| MT-07 | R1 PostgreSQL negative isolation suite, same identifiers, cookies/CSRF/access keys, default protection and quick-login denial. | PASS |
| MT-08 | Exact-count guard and Chrome installed/offline/update/rename plus legacy pass-set. Production root Chrome update verified with controlled prior-release replay. | PASS |
| MT-09 | Same-profile Chrome model/UI checks for two shops; default keys and independent active caches preserved. `r2-tenant-browser.json`. | PASS |
| MT-10 | Real Caddy image/stub backend, 108 host/privacy/redirect/crawler/static/body checks. `r2-caddy-routing.json`. | PASS |
| MT-11 | Serial ACTIVE worker, fresh status, paused drain, isolated synthetic provider errors and idle pool tests pass. Connection capacity proof unavailable. | PARTIAL; BLOCKED CAPACITY |
| MT-12 | Owner-side proofs, native transactional restore and updater tests pass. Mandatory multi-database Docker backup/restore and R3 legacy production backup unverified. | BLOCKED REAL STACK |
| MT-13 | Upgrade/recovery source and unknown-outcome/runner-stop/intent tests pass. Real second-shop failure/partial restore is prepared, unexecuted. | BLOCKED REAL STACK |
| MT-14 | R1 platform tests 21/21 as the non-superuser CREATEDB/CREATEROLE role with self-grant; accepted X6 documented. | PASS |
| MT-15 | Timer eviction/reopen tests pass. Isolated twenty-shop load/connection/eviction harness prepared with independent review and 5/5 safety tests; actual mixed traffic and sampled <=80/100 PostgreSQL connections remain unavailable. | BLOCKED REHEARSAL |
| MT-16 | In-process outage, interruption reconciliation and concurrent-create tests pass; all five real-stack drills remain required. | BLOCKED REHEARSAL |
| MT-17 | Independent R1/R2/R3 source reviews have zero open P0/P1/P2 after fixes. Whole R4 final-diff review and real-stack validation remain required. | PARTIAL; BLOCKED FINAL DIFF |
| MT-18 | API, threat model, deployment/recovery, phase/onboarding and owner checklist/validated CSV updated. Final activation statuses/entry-point docs remain gated. | PARTIAL |
| MT-19 | Section 7 A fails; no secrets/platform objects/admin tunnel/DNS/bootstrap were created in production. | BLOCKED PRECONDITIONS |
| MT-20 | Installed controller retained unchanged; replacement waits for verified R4 deployment. | BLOCKED PRECONDITIONS |
| MT-21 | Private BLOCKED checkpoint `~/Library/Application Support/Online-Shopping/handover/multi-tenant-20261011.md`: directory 0700, file 0600, secret-value scan zero. Activation access fields explicitly marked unavailable. | CHECKPOINT VERIFIED; FINAL PENDING |
| MT-22 | Executor created no production QA shops/sellers/orders and performed no production platform sign-in/enrolment. Final database counts unavailable. | NO QA WRITES; COUNTS BLOCKED |
| MT-23 | All R0/R1/R2/rollback merges had green branch/PR/main CI; R3 capacity preparation branch CI 497/497, 31 updater tests and zero audit findings. R3 remains draft/conflicting, no merge attempted. | PASS FOR MERGED RELEASES |
| MT-24 | Mandarin BLOCKED checkpoint report delivered, distinguishing historical success, current outage and missing activation; final activated report remains gated. | BLOCKED REPORT DELIVERED; FINAL PENDING |

`python3 test/auto-update.test.py`: 21/21 passed (`baseline-updater.log`). `NODE_ENV=test npm test` with scratch PostgreSQL: 453/453 passed, no skips, 42.8 s (`baseline-unit.log`).

## Blockers

Reliable Docker exec/start operations within deployment deadlines are unavailable. Read-only query APIs and public readiness recovered, but deployment/backup still fail. See the production incident and latest checkpoint below. Historical baseline failures do not block unrelated work.

## R0 release evidence — 2026-10-10

- MT-01: read-only curl smoke on both legacy hosts after R0: all expected statuses, health/ready SHA `ada984ba9feab52cb7f22abf4bf2e205af238092`, unchanged resolved manifests; updater log contains `deployed` and state is `up_to_date`; container restart counts 0. Raw `r0-production.json`.
- MT-23: branch push and PR CI passed; [merge push CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38058401394) passed; `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities (`baseline-audit.log`).
- D0-07: Require CSRF even on platform password sign-in via an encrypted, five-minute, host-only `platform_login` challenge cookie and `GET /api/v1/platform/csrf`. Session mutations still use the existing `X-CSRF-Token` header. No platform secret is configured in R1–R3 production compose.
- D0-08: A successful password step never clears TOTP failures; only a completed second factor does. Otherwise an attacker knowing the password could repeatedly restart login and evade the account lockout.
- D0-09: Encoded dot segments are rejected at the raw Node HTTP target while the platform is enabled, before WHATWG normalization; tests keep the original target as evidence because Fetch Request itself normalizes dot segments. Disabled-platform behavior is preserved.
- R1 slice: `NODE_ENV=test ... node --test --test-concurrency=1 test/platform-admin.test.js test/platform-shops.test.js test/tenant-routing.test.js`: 13/13 passed, no skips (`r1-targeted.log`). Browser, edge and rehearsal evidence are still pending.


## R1 merge gate — 2026-10-10

- D0-10: Manual purge retains the registry row and aliases in terminal PURGED state. It frees a capacity slot but codes remain permanently unavailable. PROVISIONING/ACTIVE/SUSPENDED/FAILED/DELETING all count toward twenty. Purge is not usable until R3 ships verified tenant-backup support; it fails closed in earlier staged releases and is never run on production by this executor.
- MT-02/03/05/06/07: `NODE_ENV=test SHOP_TEST_DATABASE_URL=<scratch> npm test`: 474/474 passed, no skips, 30.7 s (`r1-final-unit.log`); includes RFC vectors, replay/lockout/recovery, all-write Origin/CSRF checks, disabled configuration, exact-host denial, streamed rewrite, cache/probe bounds, store-identity handler rebuild and PostgreSQL tenant isolation.
- MT-14: `test/platform*.test.js` (21/21) run with non-superuser CREATEDB/CREATEROLE and `createrole_self_grant='set, inherit'`: passed (`r1-final-nonsuperuser.log`). Test mutation of a tenant schema uses its own role, not a hidden superuser.
- R1 failure handling: runtime/operator tests 5/5 pass. Platform outage leaves legacy health/readiness/catalog up and recovers after backoff; incompatible platform version is refused unchanged; raw encoded traversal is refused before Fetch normalization; setup rejects unsafe files and keeps credentials off argv (`r1-final-unit.log`).
- Baseline browser pass-set still passes: `qa-draft-browser.mjs`, `qa-followup-browser.mjs` (`r1-qa-draft-browser.log`, `r1-qa-followup-browser.log`). Untouched exported snippets remain module-load evidence only.
- `npm run check`: passed; `python3 test/auto-update.test.py`: 21/21; `npm audit --omit=dev --audit-level=high`: zero vulnerabilities; `git diff --check`: passed (`r1-final-*.log`). No main database schema, production compose settings or protected files changed.
- Browser/edge, operator stack and full console accessibility evidence remain pending R2/R4; unit checks do not claim those acceptance items complete.

- Independent R1 review: reproduced a concurrent platform-outage pool retirement race (P2), fixed by capturing pool identity and retiring once with immediate backoff. Six concurrent real scratch-DB outage requests now all return 503 PLATFORM_UNAVAILABLE (`r1-outage-race.log`). Also fixed loss of one-time passwords if the follow-up detail request fails: display the secret dialog before querying detail. Console CSS is self-contained because the dedicated admin edge serves only platform paths. Full real-browser proof remains R4.

- Independent R1 review closed three P2 findings: concurrent outage response race, loss of one-time UI credentials, and non-ASCII CSRF byte-length mismatch (now 403 rather than RangeError/500; `r1-csrf-bytes.log` 7/7). No P0/P1 found. The post-reservation provisioner read now occurs inside the transaction so a read failure rolls back the reservation. Remaining P2 decision: a platform outage that prevents the failure marker can require backend restart to reconcile PROVISIONING; close with in-process recovery and MT-16 drills before R4 activation. This staged gap is not enabled in production R1.
- A flaky bootstrap test assumed the first of two different concurrent usernames would win the advisory lock. Corrected to concurrent identical configured bootstraps, then a different bootstrap to prove it cannot replace the existing account; production selection behavior unchanged.


## R2 decisions — 2026-10-10

- D0-11: Keep the seller's existing static `/shop/tokens.css` exception under tenant prefixes too; it is the authoritative shared palette-token file, and exposing static CSS adds no buyer API access.
- D0-12: Caddy static files must honor unknown/suspended/deleting/alias states too. Add a public, empty `/<code>/api/v1/tenant-access` availability probe before static/entry handling; it uses registry metadata without opening a tenant store. Caddy overwrites `X-Tenant-Original-Uri`; alias redirects preserve that same-prefix path/query, while rejected entries show a neutral HTML message. No cookie or authentication capability is added.
- R1 merge `71f5d27b1abc1471e6b7e8da740138dd122a58b2` confirmed by remote main and GitHub PR state. Initial merge guard used a mistyped SHA and made no change; corrected to the verified full head. No permission denial occurred.

- MT-01 R1: ten curl probes passed; health/readiness SHA `71f5d27b1abc1471e6b7e8da740138dd122a58b2`, original manifest id/scope/start_url preserved, all four containers running and zero restarts (backend/postgres healthy; frontend/tunnel healthchecks unconfigured). Updater moved deployed to up_to_date. Raw `r1-production.json`.
- MT-23 R1: [main CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38061092236) success. No platform settings were added to production.


## R2 verification — 2026-10-10

- Real Caddy image: `QA_BACKEND_IMAGE=<R1 image> QA_FRONTEND_IMAGE=online-shopping-frontend:mt-r2-qa node scripts/qa-caddy-routing.mjs`: 108 checks passed (`r2-caddy-routing.json`). Found and corrected ambiguous two-argument Caddy `redir`; explicit wildcard now returns the intended tenant entry 302.
- Chrome browser fixture uses only synthetic SQLite stores and disposable Docker containers/network. D0-13: self-signed TLS is treated as secure only for its three loopback-mapped, random-port QA origins and their disposable certificate SPKI pins through Chrome flags; no host trust-store or production TLS change. Two tenant PWAs installed and uninstalled through Chrome DevTools PWA commands. Final run: 14 checks, two installations, standalone offline application launches, protected update and controlled rename (`r2-tenant-browser.json`).
- Independent R2 review found and fixed two P1s: positive-cache refreshes consuming the unknown-code limiter, and installed old-code workers discarding followed rename redirects. Failed platform lookups also refund temporary probe reservations. Regression tests cover sustained two-shop/shared-IP access, outage recovery and controlled alias navigation. Reviewer independently confirmed fixes.
- Browser bootstrap tolerates unavailable localStorage; tenant offline pages without a valid cached scope fail closed before palette/state imports. Default offline startup retains its unchanged empty scope. PWA auto-update throttle keys resolve the worker pathname so two shops in one tab cannot throttle each other.

- Final R2 gate: `NODE_ENV=test SHOP_TEST_DATABASE_URL=<scratch> npm test`: 482/482 pass, no skips, 30.8 s (`r2-final-unit.log`); targeted rerun after the final fixes: 31/31 (`r2-final-targeted.log`). `npm run check`, `python3 test/auto-update.test.py` (21/21), dependency audit (zero), `git diff --check` pass. Both real Caddy configurations validate.
- All twelve initial baseline passes still pass (`r2-baseline/results.json`), including both browser scenarios. Seven exported snippets remain module-load checks.
- Independent reviewer final read-only R2 review: zero open P0/P1/P2, including lightweight independent reproductions of the two corrected P1 scenarios. Complete R3/R4 diff review remains required before activation.

- Production read-only Chrome preparation: legacy shop v143 and seller v134 active, both PWAs installed in the separate QA profile, no page or unexpected console errors (`r2-production-browser-prepare-r2.json`). No login, order, seller or shop mutation. Post-deploy verification must show the new versions and one visible offer per app.


## R2 production and R3 operations — 2026-10-11

- MT-01 R2: merge `1fef9aead7bb3a6aa8b1b4110c85e04cddfaff56`, [main CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38064232372) green; updater deployed then up_to_date. Ten read-only probes and unchanged manifest identities passed, all four containers zero restarts (`r2-production.json`).
- MT-08 R2: Chrome activates shop v144 and seller v135 without page/console errors. The initial observer missed transient update UI and did not claim success. After bounded diagnostics and independent operations work, the final run replayed the exact R1 worker/assets only in the private browser profile, then fetched the live R2 update: one visible version identity per surface, both PWAs uninstalled, catalog/seller login rendered (`r2-production-browser-replay-r2.json`). No production login or business mutation.
- D0-14: Pre-stage a secret-free, project-scoped `deployment_state` volume in R3, read-only in the backend. Platform secrets and admin tunnel still wait for R4. The host-only operator helper controls maintenance in the volume; no HTTP control endpoint. It survives backend and updater restart.
- D0-15: Multi-database restore must not erase writes committed after a backup. Before a pending schema upgrade, refuse business routes, drain requests/provisioning and background platform work, pause the WhatsApp worker, then take snapshots. Keep maintenance through migration and candidate health validation. Atomically clear restore intent and record resume before reopening traffic, on both success and failure recovery. Ordinary schema-matched releases and legacy single-database operation keep the prior behavior.
- D0-16: Back up/upgrade initialized non-default ACTIVE/SUSPENDED/DELETING databases. FAILED/PROVISIONING are unavailable, count toward capacity, and retry through fresh provisioning rather than unprotected migration. Unknown commit outcomes restore every attempted database from the deployment's verified backup. Restore failure retains maintenance and the distinct `migration_restore_failed` status.
- Independent R3 review identified and drove fixes for post-backup write loss, durable main-upgrade intent, platform owner-role restore validation, stale ACTIVE worker snapshots and failure-path resume ordering. Final review is pending real-stack verification and the final diff.
- R3 targeted tests: 21/21, no skips (`r3-targeted.log`): numbered migrations/rollback, timer eviction/reopen, interrupted provisioning reconciliation, per-shop serial worker and synthetic provider isolation. Updater tests 25/25 (`r3-updater.log`), expanded recovery fixtures in progress.
- Rehearsal setup uses actual production compose under `online-shopping-rehearsal`, own volume/secrets and loopback TLS rules; both tunnels disabled. The setup script verified provisioner flags, database ownership and PUBLIC CONNECT denial. Fixed a QA key-file buffering error and recreated only rehearsal applications.
- Heavy rehearsal operations paused when host load rose from approximately 6 to 86 and Docker became unresponsive. Stopped task-created operation processes and requested stop of rehearsal application containers; no production/other-project service or host VM changed. Resume serially after the host recovers. This is not an authorization denial or a fabricated BLOCKED result.

## Production incident and rollback — 2026-10-11

- After the previously verified R2 deployment, both public `/ready` endpoints failed twice; HTTP 530 persisted while installed state still reported R2 `up_to_date`. Applied section 8 immediately: independent executor rollback worktree `/Users/yapweijun/Documents/GitHub/Online-Shopping-mt-rollback`, branch `codex/mt-r2-rollback`, reverted merge `1fef9aead7bb3a6aa8b1b4110c85e04cddfaff56`.
- [PR #129](https://github.com/yapweijun1996/Online-Shopping/pull/129) merged with merge commit `3bddb42b8340a9a7ca951429f88f49157ee84ee2`; branch CI `38067308433`, PR CI `38067336715`, and main CI `38067456877` all green. `git ls-remote origin refs/heads/main` verified the remote result. No CI bypass.
- Heavy own QA was canceled. The bounded rehearsal app-stop request timed out; a stopped container state is not claimed. Other projects, VMs, LaunchAgents, existing secrets, production data and private updater state were not modified.
- D0-17: Keep emergency rollback in a separate owned worktree so R3 cannot enter it. R3 remains uncommitted and gated on real-stack proof; R2 must be restored through a later normal verified PR before continuing releases.
- 00:24: `docker --context orbstack version --format '{{.Server.Version}}'` exceeded an eight-second diagnostic deadline. 00:27: both public readiness checks still 530. 00:29: updater became `check_failed`; private stderr reports `Auto-update failed: TimeoutExpired`. Host load ranged approximately 77–196 during this interval. No claim that R2 caused the host failure.
- BLOCKED prerequisite: responsive OrbStack Docker daemon and safe host load. This prevents actual rollback deployment, R3 backup/restore verification, R4 rehearsal/drills/capacity and activation. Recovering the whole OrbStack VM could affect other projects and is outside the launch authority. Continue independent source/docs work; retry project checks after new recovery evidence, never bypass a denied action.

## R3 recovery hardening — 2026-10-11

- `python3 test/auto-update.test.py`: 30/30 passed in 0.09 s (`r3-updater.log`). Includes named runner intent before create, lost-start handling, runner stop before restore, main unknown outcome, preserved terminal failure states, clear-intent-before-unpause crash recovery, and logical Compose volume source mapped to the project-scoped physical name.
- Independent read-only R3 reviewer: no remaining concrete P0/P1/P2 finding in the current source. Lightweight independent simulations confirmed role validation, runner cleanup order, and no stale restore after unpause interruption. Real Docker/PostgreSQL/browser gate remains unpassed; this review does not claim MT-12/13 complete.
- D0-18: Resolve deployment volume identity from rendered top-level `volumes[source].name`, reject external/cross-project/missing names, and mount that physical volume in the operator helper. This follows the real installed Compose layout.

- R3 targeted Node regressions: `node --test --test-concurrency=1 --test-name-pattern='deployment maintenance|maintenance waits|owner sample CSV' test/server.test.js test/whatsapp-outbox.test.js test/product-import.test.js`: 3/3 passed in 1.32 s (`r3-maintenance-targeted.log`). The first new HTTP fixture accidentally blocked readiness schema probes as well as the intended catalog query; narrowed the barrier to the catalog query and added a five-second test timeout with cleanup. No production code/check was weakened.
- All changed JavaScript/Python syntax and `git diff --check` passed. R3 preparation commit `cf4b194` was pushed to the owned branch for remote CI only; it is not authorized to merge past the failed production/real-stack gate.

- R3 remote CI on `42d644a` found one real legacy-grant regression: schema-upgrade fixtures use a disposable database name, so checking exactly `online_shopping` incorrectly omitted application grants. Replace five repeated predicates with one static guard: superuser-operated legacy upgrades only, explicitly excluding generated tenant database names. Actual tenant upgrades continue under their own non-superuser role and cannot grant the legacy role. Targeted real scratch PostgreSQL checks cover the original schema-20 upgrade, own-role tenant upgrade with denied legacy access, and stale worker status.
- Source snapshot proof now has an overall 180-second deadline, including already buffered evidence, and a 360-second remote idle transaction timeout. `python3 test/auto-update.test.py`: 31/31 passed, including the independent reviewer’s buffered-ready-at-181s reproduction.
- R3 source commit `487098b9e97dda9a915a42968f6e5200b0f42cf1`: [branch CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38068816848) green; 491/491 Node tests, zero skips, 59.1 s; 31/31 updater tests; syntax checks and dependency audit (zero vulnerabilities). Raw `r3-ci-green.log`. This is source evidence only; no R3 merge or production deployment.
- Native disposable PostgreSQL 16 probe exercised the same `OwnerPostgres.backup`, snapshot proof and transactional clean restore with local tool prefixes: schema/table hashes and rows matched after restore; a table introduced after backup was removed; owner-role execution succeeded. Its database, role and scratch archives were removed. This does not replace the mandatory Docker rehearsal proof.
- Prepared `qa-rehearsal-operations.py` to exercise the actual updater maintenance helper, named migration runner and stop-before-restore path; platform restore also proves removal of extra schema objects. The script remains unexecuted because Docker is unavailable.
- 00:52: Docker socket `curl --max-time 5 --unix-socket "$HOME/.orbstack/run/docker.sock" http://localhost/_ping` still timed out (exit 28). Installed updater still `check_failed`, current SHA still R2, rollback main remains undeployed. Load fell to approximately 18; public readiness did not return 200. No denied call occurred and no host-wide recovery was attempted.
- Independent rehearsal-script review found a P1: the legacy scratch restore smoke inherited the live maintenance flag and would reject its catalog request. A dedicated `restore-smoke.mjs` now uses a new private temporary maintenance path, disables platform bootstrap and cleans up its own server/directory. The real backend flag is never removed. Regression through the actual HTTP adapter proves scratch smoke succeeds while the original backend still answers 503 (2/2 targeted checks, `r3-restore-smoke.log`).
- Rehearsal recovery fixes: load and restore the previous controller intent before new fixtures; use unique report/backup directories; checkpoint before mutation; stop named writers in `finally`, including timeout. The fixture's synthetic failing constraint is repeatable. These source changes still require real-stack execution.

## BLOCKED checkpoint — 2026-10-11 01:04

- R3 [draft PR #130](https://github.com/yapweijun1996/Online-Shopping/pull/130), head `7f369d890805ce83d4d5452693c750e166db473e`; remote branch SHA verified. [Latest branch CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38069878464) passes 492/492 Node tests, zero skips, 51.0 s; 31 updater tests, syntax and audit (zero). Raw `r3-ci-latest.log`. GitHub reports conflicting with the emergency-reverted main; reconcile only after the separately restored R2 is deployed/verified. No R3 merge or pull-request merge CI claimed.
- Independent latest rehearsal-source reviewer confirmed the maintenance-smoke P1 and both QA recovery P2s closed; timeout invokes runner cleanup in its independent lightweight reproduction. No open source finding, but real Docker evidence is still missing.
- After five bounded daemon diagnostics plus a return after independent source/doc work, `_ping` still times out (exit 28), both public readiness probes remain 530, installed updater remains `check_failed` on R2 with no pending deployment. `production-incident-latest.json`; host load approximately 21, system memory free percentage 50. Missing prerequisite, not a denied call. Do not repeat unchanged retries or attempt host-wide recovery outside authority.
- Exact blocked project command: `docker --context orbstack version --format '{{.Server.Version}}'`; after Docker recovery, the authorized resume command is `python3 "$HOME/Library/Application Support/Online-Shopping/auto-deploy/auto-update.py" --retry`. Verify the already merged rollback and MT-01 before any later release. Never edit updater state.
- D0-19: Reserve `platformowner` as the planned bootstrap username; do not create it or its password before section 7 A passes. Handoff clearly marks the planned console and credentials unavailable.
- Private checkpoint handoff written and read back; 0700 directory/0600 file; expected contents present and production-secret value scan zero. Existing pre-R2 legacy archive and proof exist at 0600. Section 7 B backup/snapshot has not been run.
- Own native PostgreSQL on loopback 55432 was positively stopped via `pg_ctl -D <private-scratch>/pg -m fast -t 30 stop`; only its disposable cluster directory was deleted. Rehearsal containers/volumes could not be torn down while Docker is unresponsive; scratch bind files remain private until project-scoped teardown succeeds. Exact deferred cleanup: `cd /Users/yapweijun/Documents/GitHub/Online-Shopping-mt && python3 scripts/qa-rehearsal.py stop`. No other project was changed.
- Ledger-only R3 head `ff043e06c000d7213163e743021a2fb820d7b3b8`: [CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38070345293) success; remote branch SHA verified. The original `docs/tenant-onboarding-fixes` checkout remains clean and on its original branch; planned production secret paths do not exist.
- D0-20: Prepare a separate owned recovery worktree `/Users/yapweijun/Documents/GitHub/Online-Shopping-mt-r2-restore`, branch `codex/mt-r2-restore`, [draft PR #131](https://github.com/yapweijun1996/Online-Shopping/pull/131). Head `a48e8b4f167482d4c70c826872d85d2debb56dd8` matches verified R2 source exactly except retained incident documentation and the already verified browser update observer. Syntax/diff checks pass; fresh branch/PR CI is running. It must remain draft until rollback deployment and all MT-01 checks pass. No R3 operations or production platform wiring enter it; no merge attempted.

## Capacity preparation and blocked audit — 2026-10-11

- Second consecutive goal-turn audit, 01:14:48 SGT: Docker socket `_ping` exceeded five seconds (exit 28), both public `/ready` probes returned 530; installed updater still `check_failed` on R2, no pending deployment, checked 17:12:57 UTC. Host load 17.13/25.52/29.80. Raw private `blocked-audit-2.json`. No permission denial occurred; global VM recovery remains outside authority.
- [R2 restore draft PR #131](https://github.com/yapweijun1996/Online-Shopping/pull/131) head `a48e8b4f167482d4c70c826872d85d2debb56dd8`: [branch CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38070500030) and [PR CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38070525559) green, 482 Node tests without skips, 21 updater tests and zero audit findings. Rollback deployment/MT-01 still block making it ready or merging.
- D0-21: Prepare the explicitly required MT-15 load script while Docker is unavailable. Use only private scratch secrets, inspected rehearsal containers/volumes/networks, disabled tunnels and the chosen loopback TLS listener. Refuse excessive host load, non-idle production state, heavy updater activity or the independently running backup job. Do not lock or modify the production controller.
- D0-22: ACTIVE workers poll every fifteen seconds, so a cold-shop idle proof first suspends one non-default rehearsal shop; the worker then skips it. Keep the remaining nineteen under mixed buyer/seller load for six minutes, check idle pool removal and zero database connections, resume, and verify catalog/seller routes reopen. Twenty-shop concurrent traffic is a separate preceding phase. This changes only fictional rehearsal fixtures. The standalone fixture resets the rehearsal administrator/TOTP and runs after owner-browser fixtures; it never signs into production.
- `node scripts/qa-rehearsal-capacity.mjs` source prepared: twenty-shop creation/limit rejection, forty concurrent readers, all-client `pg_stat_activity` samples every 500 ms against a required `max_connections=100`, failure above 80, source SHA and aggregate private report written only after complete success. No execution or MT-15 pass is claimed.
- Independent harness review identified two P2s: lost suspend response/process interruption left a cold shop unrecoverable, and a separate production backup LaunchAgent could overlap load while updater state remained `up_to_date`. Both fixed: private intent is written before suspension and restored from the committed status/revision on the next run; both jobs are inspected. Final independent read-only review has no remaining concrete P0/P1/P2 and confirms API/cookie/CSRF contracts and fixture isolation; no Docker/browser/database operation performed by the reviewer.
- `/opt/homebrew/opt/node@24/bin/node --test test/rehearsal-safety.test.js`: 5/5 passed, no skips (`r4-capacity-safety.log`). Covers escaped/symlinked secrets, real tunnel credentials, production volumes/networks/secrets, public listeners, pending deployment/backup and unknown suspend outcome recovery. `npm run check`, both new scripts' `node --check`, `python3 test/auto-update.test.py` (31/31) and `git diff --check` pass. Full remote CI remains required before any release; real-stack gates remain unchanged.
- Capacity preparation source `db06afc357f51c4fb68e9e656e191ff0a3420b06`: [branch CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38072307946) green, 497/497 Node tests, zero skips, 60.0 s; 31 updater tests, syntax and zero audit findings. Raw `r4-capacity-ci.log`; remote branch SHA verified. R3 remains draft/conflicting and unmerged, R2 restoration remains draft; no production gate reopened.

## Third goal-turn runtime audit — 2026-10-11 02:05

- This goal turn made concrete progress: recovered Docker query access, verified and removed only the rehearsal project's containers/volumes, diagnosed the incomplete rollback checkout, merged a green-CI recovery PR, and reconciled the R2 restore draft. The underlying prerequisite still fails: project Docker execution cannot finish reliably within controller deadlines. It has recurred on three consecutive goal turns; no required independent implementation/check remains that can unlock deployment without external runtime recovery.
- 01:41:29: `_ping` returned `OK`, server 29.4.0 responded and both public `/ready` endpoints returned 200 on the existing R2. Read-only diagnosis found rollback release `3bddb42b8340a9a7ca951429f88f49157ee84ee2` had correct HEAD but no Git index/zero tracked entries after an interrupted checkout. Live R2 checkout remained clean. Raw `blocked-audit-3.json`.
- D0-23: Preserve the incomplete release and advance the already merged rollback through a normal documentation-only recovery PR, obtaining a fresh release directory without editing/deleting existing release checkouts, images or backups. [PR #132](https://github.com/yapweijun1996/Online-Shopping/pull/132) merged as `62159f62a100c47091ad60b3e3897940c5431999`; branch CI `38073104108`, PR CI `38073108081`, [main CI](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38073265431) green. Remote main verified; fresh release checkout clean and both images built, Caddy valid.
- Authorized installed-controller `--retry` ended with `TimeoutExpired` during the following legacy backup (180-second controller deadline), no cutover. A subsequent scheduled updater job ended in `build_failed`, then `failed_release_waiting` for `62159f6`; its observed PID 45751 is terminal and LaunchAgent is not running. No background deployment is claimed live from a state file alone. Private raw `recovery-controller.log` and `recovery-update*.log`.
- Latest bounded read-only probe: `docker --context orbstack exec online-shopping-production-postgres-1 psql -XqAt -U online_shopping -d postgres -c 'SELECT 1;'` exceeded eight seconds; only that diagnostic CLI was terminated by its subprocess deadline. The previous PostgreSQL diagnostic finished; its observation timeout was not treated as completion or restarted. No production write or global recovery was performed.
- 02:05:20: both public readiness endpoints still return 200 with R2 SHA `1fef9aead7bb3a6aa8b1b4110c85e04cddfaff56`; four production containers running, restart counts zero, backend/PostgreSQL healthy. Installed state `failed_release_waiting`, failed target `62159f6`, no pending deployment. Load 8.50/7.73/8.29 on ten available cores. Raw `blocked-runtime-3-final.json`. Rollback verification, R3 real backup/restore, R4 owner/drills/capacity and section 7 A remain unavailable.
- R2 restore draft [PR #131](https://github.com/yapweijun1996/Online-Shopping/pull/131), reconciled head `8a7a0312cdfb4a72f7dfca6f1d9594f9bc9298d1`: branch CI `38073964097` and PR CI `38073967388` success; source still equals verified R2 except ledger/observer, no R3 operations or activation wiring. It remains draft and unmerged until rollback is deployed/up_to_date and all MT-01 checks pass.
- D0-24 / BLOCKED: Do not weaken backup proof, alter installed state/release checkouts, install the new controller before its ordered gate, or restart the global VM affecting other projects. Resume only after the host operator restores reliable Docker execution: pass the exact read-only probe above, run the authorized installed-controller `--retry`, verify target `62159f6` deployed/up_to_date and full MT-01, then continue R2/R3/R4 in order. No permission denial occurred. Private handoff records this prerequisite and exact commands.
