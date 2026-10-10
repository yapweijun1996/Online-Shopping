# Multi-tenant release ledger

Started 2026-10-10 (Asia/Singapore). Source of truth: [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md). Evidence files are git-ignored under `output/qa/multi-tenant/`. No production test data is permitted.

## Release state

| Release | State | Evidence |
| --- | --- | --- |
| R0 | DEPLOYED, VERIFIED | [PR #126](https://github.com/yapweijun1996/Online-Shopping/pull/126), merge `ada984ba9feab52cb7f22abf4bf2e205af238092`; deployed log followed by `up_to_date`; 10 production probes and zero restarts. |
| R1 | DEPLOYED, VERIFIED | [PR #127](https://github.com/yapweijun1996/Online-Shopping/pull/127), merge `71f5d27b1abc1471e6b7e8da740138dd122a58b2`; branch/PR CI green. |
| R2 | REVERTED ON MAIN; PRODUCTION ROLLBACK PENDING | 482 unit tests; 108 real Caddy checks; two installed PWAs with standalone offline launch and controlled rename; baseline pass-set retained. |
| R3 | IN PROGRESS | Operations and migration recovery; real-stack checks in progress. |
| R4 | NOT STARTED | Rehearsal, hardening and activation. |

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
| MT-01 | Current production readiness is BLOCKED by Docker/host unavailability; R2 was reverted through green CI in PR #129. Historical baseline curl: both hosts health/ready 200 with current SHA, shop/seller shells 200, public catalog 200, unauthenticated seller session 401; both manifests resolve id/scope/start_url to original `/shop/` and `/seller/`. `production-baseline.json`. | BASELINE PASS |
| MT-02 | R1 disabled-config tests, CI without platform secrets, and inert production deployment. | PASS |
| MT-03 | Pending the required release and real-stack evidence. | PENDING |
| MT-04 | Pending the required release and real-stack evidence. | PENDING |
| MT-05 | Pending the required release and real-stack evidence. | PENDING |
| MT-06 | `tenant-routing.test.js`: full matrix, streamed POST, no rejected tenant store opens, cache/probe bounds and eviction identity. R1/R2 full suite. | PASS |
| MT-07 | R1 PostgreSQL negative isolation suite, same identifiers, cookies/CSRF/access keys, default protection and quick-login denial. | PASS |
| MT-08 | Exact-count guard and Chrome installed/offline/update/rename plus legacy pass-set. Production root Chrome update verified with controlled prior-release replay. | PASS |
| MT-09 | Same-profile Chrome model/UI checks for two shops; default keys and independent active caches preserved. `r2-tenant-browser.json`. | PASS |
| MT-10 | Real Caddy image/stub backend, 108 host/privacy/redirect/crawler/static/body checks. `r2-caddy-routing.json`. | PASS |
| MT-11 | Pending the required release and real-stack evidence. | PENDING |
| MT-12 | Pending the required release and real-stack evidence. | PENDING |
| MT-13 | Pending the required release and real-stack evidence. | PENDING |
| MT-14 | R1 platform tests 21/21 as the non-superuser CREATEDB/CREATEROLE role with self-grant; accepted X6 documented. | PASS |
| MT-15 | Pending the required release and real-stack evidence. | PENDING |
| MT-16 | Pending the required release and real-stack evidence. | PENDING |
| MT-17 | Pending the required release and real-stack evidence. | PENDING |
| MT-18 | Pending the required release and real-stack evidence. | PENDING |
| MT-19 | Pending the required release and real-stack evidence. | PENDING |
| MT-20 | Pending the required release and real-stack evidence. | PENDING |
| MT-21 | Pending the required release and real-stack evidence. | PENDING |
| MT-22 | Pending the required release and real-stack evidence. | PENDING |
| MT-23 | Pending the required release and real-stack evidence. | PENDING |
| MT-24 | Pending the required release and real-stack evidence. | PENDING |

`python3 test/auto-update.test.py`: 21/21 passed (`baseline-updater.log`). `NODE_ENV=test npm test` with scratch PostgreSQL: 453/453 passed, no skips, 42.8 s (`baseline-unit.log`).

## Blockers

None recorded. Historical baseline failures above do not block unrelated work.

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
