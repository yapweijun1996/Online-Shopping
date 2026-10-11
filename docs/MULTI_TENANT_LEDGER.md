# Multi-tenant release ledger

Started 2026-10-10 (Asia/Singapore). Source of truth: [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md). Evidence files are git-ignored under `output/qa/multi-tenant/`. No production test data is permitted.

## Release state

| Release | State | Evidence |
| --- | --- | --- |
| R0 | DEPLOYED, VERIFIED | [PR #126](https://github.com/yapweijun1996/Online-Shopping/pull/126), merge `ada984ba9feab52cb7f22abf4bf2e205af238092`; deployed log followed by `up_to_date`; 10 production probes and zero restarts. |
| R1 | DEPLOYED, VERIFIED | [PR #127](https://github.com/yapweijun1996/Online-Shopping/pull/127), merge `71f5d27b1abc1471e6b7e8da740138dd122a58b2`; branch/PR CI green. |
| R2 | RESTORED, DEPLOYED, VERIFIED | PR #131 merge `a6e9304`; branch/PR/main CI green; MT-01 and actual Chrome installed-update checks pass, D0-26 restart history retained. |
| R3 | DEPLOYED, VERIFIED | PR #130 merge c8bb3e8; branch/PR/main CI green; real backup/upgrade rehearsal pass; production MT-01, up_to_date and legacy backup pass. |
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
| MT-01 | Rollback recovery `6429c89` deployed then up_to_date; ten probes/manifest identities pass, applications zero restarts, protected PostgreSQL/tunnel identity/start/count unchanged. PostgreSQL historical count 2 retained under D0-26. R2 restoration `a6e9304` deployed/up_to_date; ten probes and Chrome installed-update pass. | PASS WITH D0-26 |
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
| MT-12 | Four/five database real Docker archives/restore proofs pass on f7237f1. Installed legacy production backup and isolated restore pass on R3 c8bb3e8. | PASS |
| MT-13 | Real second-shop failure restores and verifies both attempted databases after stopping named runner; third shop untouched. f7237f1 real Compose proof and 36 operator tests pass. | PASS |
| MT-14 | R1 platform tests 21/21 as the non-superuser CREATEDB/CREATEROLE role with self-grant; accepted X6 documented. | PASS |
| MT-15 | Timer eviction/reopen tests pass. Isolated twenty-shop load/connection/eviction harness prepared with independent review and 5/5 safety tests; actual mixed traffic and sampled <=80/100 PostgreSQL connections remain unavailable. | BLOCKED REHEARSAL |
| MT-16 | In-process outage, interruption reconciliation and concurrent-create tests pass; all five real-stack drills remain required. | BLOCKED REHEARSAL |
| MT-17 | Independent R1/R2/R3 source reviews have zero open P0/P1/P2 after fixes. Whole R4 final-diff review and real-stack validation remain required. | PARTIAL; BLOCKED FINAL DIFF |
| MT-18 | API, threat model, deployment/recovery, phase/onboarding and owner checklist/validated CSV updated. Final activation statuses/entry-point docs remain gated. | PARTIAL |
| MT-19 | Section 7 A fails; no secrets/platform objects/admin tunnel/DNS/bootstrap were created in production. | BLOCKED PRECONDITIONS |
| MT-20 | Installed controller retained unchanged; replacement waits for verified R4 deployment. | BLOCKED PRECONDITIONS |
| MT-21 | Private BLOCKED checkpoint `~/Library/Application Support/Online-Shopping/handover/multi-tenant-20261011.md`: directory 0700, file 0600, secret-value scan zero. Activation access fields explicitly marked unavailable. | CHECKPOINT VERIFIED; FINAL PENDING |
| MT-22 | Executor created no production QA shops/sellers/orders and performed no production platform sign-in/enrolment. Final database counts unavailable. | NO QA WRITES; COUNTS BLOCKED |
| MT-23 | All R0/R1/R2/rollback merges had green branch/PR/main CI; R3 capacity preparation branch CI 497/497, 31 updater tests and zero audit findings. R3 actual gate passed, latest source branch/PR CI green; ledger-head CI required before merge. | PASS FOR MERGED RELEASES |
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

## Owner option A recovery check — 2026-10-11 11:35

- The owner selected A (continue the full release after Docker recovery). The read-only recovery check did not reopen the gate: Docker socket `_ping` failed to connect and the project `SELECT 1` command returned `Cannot connect to the Docker daemon`. Both public readiness requests returned Cloudflare `error code: 502`. Host load was 269.84/156.67/93.90. Raw private `resumed-audit-1.json`; readiness and container health from the 02:05 checkpoint are historical, not current evidence.
- `orb status` returned `Running`, but this does not establish Docker readiness. The correctly named project LaunchAgents `com.gmb01.online-shopping.auto-update` and `com.gmb01.online-shopping.backup` had no running PID. A scoped process check found no task-created rehearsal, browser, backup or updater command still running; no process was stopped. Other projects and system processes were not changed.
- Remote main remains `62159f62a100c47091ad60b3e3897940c5431999`. R2 restoration PR #131 remains draft/mergeable at `8a7a0312cdfb4a72f7dfca6f1d9594f9bc9298d1`, with both verify checks successful. R3 remains unmerged. No new production deployment, secret, platform object, tunnel, controller replacement or business write was attempted during unsafe host load.
- Follow-up audit at 11:39:23: both public readiness requests returned HTTP 530 / Cloudflare 1033; Docker `_ping` exceeded five seconds, `SELECT 1` exceeded twelve seconds and `orb status` exceeded five seconds. Load declined to 64.67/131.49/99.60 but remains unsafe for rehearsal load or deployment. State still records R2 as current, `failed_release_waiting` for `62159f6`, no pending deployment. Raw private `resumed-audit-1-final.json`; the collection process completed. Container health/restart counts cannot currently be inspected. The existing rollback is already merged; no additional revert was made.
- D0-25: Interpret A as resuming the authorized release once its runtime prerequisite is restored. Keep section 2.2 effective: restarting shared OrbStack can affect other projects and is outside this release's authority. No permission denial occurred. Preserve the existing blocked checkpoint and update its private handoff with the regression; use a fresh successful deep execution probe, safe load, rollback deployment and complete MT-01 as the next gate.

## Recovery execution and image permissions — 2026-10-11 12:20

- Docker recovered: socket `_ping` OK; project `SELECT 1` returned in 0.37 seconds; both public readiness endpoints returned 200 on old R2. No shared-host restart was performed by the executor. The installed controller `--retry` completed a verified legacy backup (`/Users/yapweijun/Backups/Online-Shopping/online-shopping-20261011T042210Z-fd3385.dump`) and built the rollback candidate, but candidate startup exited immediately; automatic rollback restored healthy R2 and recorded `rolled_back`. Raw `recovery-controller-resumed.log` in the primary execution worktree.
- Root cause: the executor's earlier `umask 077` for private logs propagated into Git checkout. Release `62159f6` has directories 0700 and files 0600; Docker COPY retained root ownership and those permissions. A secret-free, network-none import as the image's Node user reproduced EACCES on `/app/src/server.js`. This is an application image permission defect, not a denied tool authorization. Existing release checkouts, secrets and protected services were not modified.
- D0-26: Preserve cumulative restart history from external host recovery. Before this deployment, backend=1, PostgreSQL=2, frontend/tunnel=0. Record the deviation explicitly; do not claim cumulative zero or reset/recreate protected containers. Verify PostgreSQL/tunnel ID, StartedAt and RestartCount remain unchanged for each release; newly recreated application containers must stay at RestartCount=0 throughout deployed/up_to_date and MT-01. Independent read-only reviewer confirmed this interpretation. Private `recovery-predeploy-baseline.json` in the primary execution worktree.
- D0-27: Make image code readable independently of checkout umask while preserving root ownership, non-root execution and denied code writes. Add only `chmod -R a+rX` over image code/package paths before USER node; no secret path, host permission or production privilege is changed. Future controller invocations create log files separately at 0600 and use the normal subprocess umask rather than applying a private-log umask to checkout.
- Real regression proof: build the corrected image from copied tracked source with directories 0700/files 0600, then run without network or credentials. UID=1000 imports all server modules; code/package files remain owned by root, read access succeeds, write access is refused, `/data` remains writable, server.js is 0644. `image-permissions-proof.json` and build log in this worktree's ignored output. Syntax, backend-image test (1/1), updater tests (21/21) and diff checks pass; fresh full branch/PR CI remains required before merging.
- Independent read-only image-fix review: no concrete P0/P1/P2 finding; the change adds read/traversal permissions only, retains USER node and does not touch secret mounts or protected services. Rollback deployment and R2 restoration remain gated on observed production verification.

## Rollback verified and R2 restoration resumed — 2026-10-11 12:37

- Recovery [PR #133](https://github.com/yapweijun1996/Online-Shopping/pull/133) merged as `6429c89f185bd75abcde8d819c11e3de21661d69`; branch/PR/main CI `38111731667` / `38111751134` / `38111870425` successful. Remote main verified. The scheduled installed controller recorded `deployed` at 12:36:10 SGT; a subsequent authorized poll recorded `up_to_date`, no pending deployment.
- MT-01 recovery: ten read-only probes and unchanged manifest id/scope/start_url passed on SHA `6429c89`; both applications run with zero restarts, backend/PostgreSQL healthy, frontend/tunnel healthchecks unconfigured. PostgreSQL/tunnel ID, StartedAt and RestartCount are unchanged from the predeploy baseline (PostgreSQL retains historical count 2 under D0-26). Raw primary-worktree `rollback-permissions-production.json` and `recovery-current-poll.log`; no cumulative-zero claim.
- R2 restore reconciles this verified main, retaining the Dockerfile readability fix and both incident timelines. Its application/routing source otherwise remains the already verified R2. R3 operations and activation wiring are excluded. Fresh full branch/PR CI and production browser/update verification are required for this restoration.

## R3 reconciliation after recovery — 2026-10-11 12:43

- R2 restoration PR #131 merged as `a6e9304382b0897a77e09c0b32d507f302a38896`, branch/PR CI `38112222822` / `38112224642` green; main CI/deploy verification pending. Private production Chrome preparation passed on recovered R1 `6429c89`: v143/v134 active, both PWAs installed, no page/unexpected console errors. Raw `r2-restoration-browser-prepare.json`. No production login or business write.
- Reconcile the operations branch with that restored main. Keep R3 COPY of restore-smoke and the recovered image readability fix; preserve this complete execution ledger plus the new main recovery records. Draft PR #130 remains gated on R2 production and real-compose operations proof. Protected-file diff remains empty.

## R2 restored and verified — 2026-10-11 12:51

- R2 restoration PR #131 main `a6e9304382b0897a77e09c0b32d507f302a38896`: branch/PR/main CI `38112222822` / `38112224642` / `38112381110` success. Installed controller log records deployed; scheduled next poll records up_to_date, no pending deployment. Raw `r2-restoration-controller.log`, `r2-restoration-production.json`.
- MT-01: both hosts health/ready report a6e9304; pages/catalog 200, seller session 401; resolved legacy manifest identities/scopes/start URLs unchanged; application restarts zero; protected PostgreSQL/tunnel ID, StartedAt and restart counts unchanged (historical PG count 2, D0-26).
- Production Chrome verifies catalog, seller login, v144/v135 active, manifests unchanged and no page/unexpected console errors. The naturally updated prepared profile did not capture an offer; exact released R1 worker/assets were replayed only inside the disposable profile, then both live R2 updates were visibly offered once per version. Actual installed PWAs were uninstalled after verification. Raw `r2-restoration-browser-verified.json`, `r2-restoration-browser-replay.log`; no production authentication or mutation.
- R3 candidate 2c1f294 branch/PR CI `38112474249` / `38112476405` green. Actual rehearsal backup/restore gate is still pending; host load spiked to 74 during recovery/build, so heavy work was deferred until load fell below ten. No other project or global VM was changed.
- Independent full-diff reviewer identified a P2 recovery-code loss if the first post-enrolment shop-list request fails. Fix immediately displays the one-time recovery dialog before that read; subsequent read errors cannot discard it. Real browser error-path verification follows in rehearsal.

## Independent review recovery fixes — 2026-10-11 12:54

- Fix two additional purge P2s: a database drop followed by a role/audit failure made fresh-backup retry impossible; custom container/owner settings were not propagated to the backup subprocess. The purge now pins the same container ID/owner for all operations and persists the verified archive, tenant revision and target in a private checkpoint before any drop. Retry verifies that checkpoint/archive and proceeds with idempotent drops without a fresh backup. Private flock serializes same-tenant operator processes; registry lock still prevents console races; SQL lock wait is bounded. Never execute production purge in this goal.
- Fix setup P2: CREATE DATABASE succeeds independently of REVOKE, so interrupted setup could not recover. Strictly inspect existing platform role flags/ownership first, then idempotently revoke only platform PUBLIC privileges and inspect the final boundary. Foreign owner/roles remain refused; existing passwords are never changed.
- `python3 test/auto-update.test.py`: 35/35 passed. Meaningful added cases cover retry after a dropped database, foreign target, archive tampering, recovery from interrupted platform privilege setup and rejection of unrelated ownership. Real-stack recovery verification and fresh full CI remain required.

## Actual backup proof normalization — 2026-10-11 13:02

- Real rehearsal legacy/platform archives restore successfully, but the first tenant failed schema-hash equality. Exact metadata comparison isolates one CHECK: PostgreSQL expands BETWEEN into nested AND in the source, while dump/restore reparses associative AND flat. Columns, indexes, triggers, functions and row proofs remain equal; no application data/schema defect.
- D0-28: use PostgreSQL `pg_get_constraintdef(oid, true)` for engine deparsing with operator precedence retained. It removes parser-only Boolean grouping without omitting constraints, names, predicates, bounds or any other schema/data proof. A real isolated restore proves the full canonical schema hashes equal. Added PostgreSQL regression checks equivalent nested/flat expressions match while changed bounds differ. Full backup/restore rehearsal must now pass.
- Independent source review at 49991bf: zero open P0/P1/P2 after four code and one private-argv documentation fixes; independent offline regressions and complete purge partial-drop retry reproduction passed. Real-stack backup, browser, drills/capacity remain pending.

- Canonical CHECK proof passes all four actual legacy/platform/alpha/bravo archives and isolated restores. The next gate exposed macOS path alias validation: directory.resolve() uses /private/var, whereas manifest.absolute() retained /var. Fix canonicalizes the manifest parent and still rejects escaped directories or symlinked manifest files. Added the alias/escape/file-symlink regression; 36/36 updater/operator tests pass. Full operations rerun remains required.

## R3 real operations gate passed — 2026-10-11 13:10

- `python3 scripts/qa-rehearsal-operations.py` on source `f7237f15cde61758178ec2ced197e64030cc514e`: completed successfully in the isolated real Compose stack. Four legacy/platform/alpha/bravo custom archives were restored and verified by complete schema hashes and per-table row counts; a platform table introduced after backup was removed by transactional restore. Five-database manifest after adding charlie also verified. MT-12 rehearsal gate passed.
- MT-13: real named runner upgraded alpha 23→24, failed on bravo's fixture constraint, stopped/removed before recovery; both attempted databases restored and verified in reverse order, alpha extra DDL removed, charlie untouched at 23. All three versions and owner-role isolation verified; only fictional rehearsal fixtures were repaired to 24 and maintenance exited. Raw `r3-operations-restored-cycle4.log`, immutable `r3-operations-f7237f1-verified.json`; four-database and five-database manifest archives retained privately in rehearsal operations directory.
- Latest source branch/PR CI [38113747858](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38113747858) / [38113750163](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38113750163) successful. Fresh ledger-head CI is required before merging PR #130. R2 production is verified; R3 production and installed-controller single-database backup remain pending.

- Independent read-only review of f7237f1 alias handling relative to aff6926: no open P0/P1/P2; parent normalization remains confined and manifest file symlinks rejected. Reviewer did not perform production writes or substitute source review for rehearsal evidence.

## R3 merge and R4 rehearsal preparation — 2026-10-11 13:14

- R3 PR #130 merged normally as `c8bb3e8ec772fc8e2ab419f65fae247cd3dd93d5`, remote main verified. Final branch/PR CI `38114014630` / `38114018308` success, 36 updater/operator tests, full PostgreSQL Node suite and zero audit findings. Main CI/deployment/production backup are pending; no controller replacement.
- R4 owner browser, five real fault drills and standalone interrupted provisioner harness moved into scripts after R3 merge. Independent read-only review cleared draft findings. The kill drill persists its operation code before launch, matches exact argv with NUL separators, and observes committed PROVISIONING plus real provisioner catalog-lock wait before SIGKILL; it never assumes a role already exists.
- D0-29: Add actual fictional purge retry proof to the isolated rehearsal: retain a platform dependency owned by a newly created tenant role, prove database drop succeeds but role drop stops, remove only that dependency and retry from the identical verified archive/checkpoint. Restart only the inspected rehearsal backend to close tenant pools first. Production purge remains prohibited and unexecuted. Browser/drills/capacity/operator proof remain pending execution.

## R3 production verified — 2026-10-11 13:17

- PR #130 merge `c8bb3e8ec772fc8e2ab419f65fae247cd3dd93d5` [main CI 38114123030](https://github.com/yapweijun1996/Online-Shopping/actions/runs/38114123030) success. Installed controller recorded deployed, next authorized poll up_to_date, no pending deployment. Full MT-01 read-only probes and manifest identity checks pass, apps zero restarts, protected PostgreSQL/tunnel unchanged from D0-26 baseline. Raw `r3-production-controller.log`, `r3-production-next-poll.log`, `r3-production.json`.
- Installed `auto-update.py --backup` succeeded: `/Users/yapweijun/Backups/Online-Shopping/online-shopping-20261011T051652Z-5cbfba.dump`, isolated restore verified; raw `r3-production-backup.log`. MT-12 and R3 post-deploy gate pass; installed controller still unchanged.
- R4 independent review found two harness P2s, fixed before actual execution: persist code/archive directory before create and reconcile unknown outcome; inspect exact exited QA backend with every mount/network/secret boundary before recovering a durable stopped/restart intent. New safety regression rejects stopped PostgreSQL and wrong-network backend; 6/6 pass. No production platform or QA writes.

## R4 real journey, faults and final review corrections — 2026-10-11 13:25

- `node scripts/qa-rehearsal-browser.mjs` source 76e1816: ten complete Chrome journey groups pass, real TOTP/recovery sign-in, two shops/roles, forced passwords, sample CSV, mobile guest order/confirmation, lifecycle/account/audit; 360/390/768/1280 px, labels/landmarks/keyboard/touch checks, zero page/console/CSP errors. Follow-up list failure preserves one-time recovery codes. Raw `r4-owner-journey.json`, `r4-owner-journey-cycle1.log`. MT-03/04/05 rehearsal pass.
- `node scripts/qa-rehearsal-drills.mjs`: all five genuine faults pass (isolated shop DB down, platform DB down with legacy unaffected, concurrent same-code one winner, real provisioner SIGKILL at committed reservation/catalog-lock wait, actual backend restart during create). Each recovers/retries; private intents cleared. Raw `r4-failure-drills.json`, `r4-failure-drills-cycle1.log`. MT-16 pass.
- Actual fictional purge drops the fixture DB, fails on a role-owned platform dependency, then succeeds using the identical original verified archive/checkpoint after that dependency is removed. PURGED and exactly one audit row verified. Raw `r4-purge-recovery.json`, `r4-purge-recovery-cycle1.log`; no production purge.
- First capacity run completes twenty shops/forty readers/60 seconds: 21,989 requests, sampled peak 68/100. The next phase fails; no complete capacity report is written and cold intent is recovered. Raw `r4-capacity-cycle1.log`. Do not claim MT-15 passed.
- Final independent whole diff review identifies P1 cache invalidation racing an in-flight tenant/alias SELECT, allowing stale ACTIVE or pre-rename metadata to refill. Fix generation checks/retries and refuse repeated mutation churn. Bounded expired cache values remain probe hints only; fresh metadata always decides routing. Same-IP/same-code cold readers share a metadata lookup, but every genuinely unknown attempt still consumes its own quota. Concurrent suspend/alias/rename, forty warm-refresh/cold readers and forty same-code unknown attempts have meaningful regressions. Capacity rerun remains required.
- Fix QA-only schema fixture P2: require fixtureadmin, explicit QA admin port and known mode before configuration/DB open; modify only alpha/bravo/charlie. Production-like or unknown-mode subprocesses are rejected before database access. No production schema/data/credential change.
