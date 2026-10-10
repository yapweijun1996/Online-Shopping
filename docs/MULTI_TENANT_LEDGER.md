# Multi-tenant release ledger

Started 2026-10-10 (Asia/Singapore). Source of truth: [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md). Evidence files are git-ignored under `output/qa/multi-tenant/`. No production test data is permitted.

## Release state

| Release | State | Evidence |
| --- | --- | --- |
| R0 | DEPLOYED, VERIFIED | [PR #126](https://github.com/yapweijun1996/Online-Shopping/pull/126), merge `ada984ba9feab52cb7f22abf4bf2e205af238092`; deployed log followed by `up_to_date`; 10 production probes and zero restarts. |
| R1 | IN PROGRESS | Platform core, no production settings. |
| R2 | NOT STARTED | Browser and edge. |
| R3 | NOT STARTED | Operations. |
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
| MT-01 | Baseline curl: both hosts health/ready 200 with current SHA, shop/seller shells 200, public catalog 200, unauthenticated seller session 401; both manifests resolve id/scope/start_url to original `/shop/` and `/seller/`. `production-baseline.json`. | BASELINE PASS |
| MT-02 | Pending the required release and real-stack evidence. | PENDING |
| MT-03 | Pending the required release and real-stack evidence. | PENDING |
| MT-04 | Pending the required release and real-stack evidence. | PENDING |
| MT-05 | Pending the required release and real-stack evidence. | PENDING |
| MT-06 | Pending the required release and real-stack evidence. | PENDING |
| MT-07 | Pending the required release and real-stack evidence. | PENDING |
| MT-08 | Pending the required release and real-stack evidence. | PENDING |
| MT-09 | Pending the required release and real-stack evidence. | PENDING |
| MT-10 | Pending the required release and real-stack evidence. | PENDING |
| MT-11 | Pending the required release and real-stack evidence. | PENDING |
| MT-12 | Pending the required release and real-stack evidence. | PENDING |
| MT-13 | Pending the required release and real-stack evidence. | PENDING |
| MT-14 | Pending the required release and real-stack evidence. | PENDING |
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

## R2 emergency rollback — 2026-10-11

- Production stop condition: after previously verified R2 deployment `1fef9aead7bb3a6aa8b1b4110c85e04cddfaff56`, both public `/ready` endpoints failed on two consecutive read-only checks; the second check returned Cloudflare HTTP 530. The updater still reported `up_to_date` at that SHA and had not rolled back. Per goal section 8, revert the R2 merge through normal CI and a merge-commit PR before investigating.
- Host load reached approximately 100 with memory pressure; heavy task-created QA work was stopped. A bounded request to stop the rehearsal application containers timed out because the Docker daemon was unresponsive; their stopped state is not claimed. Other containers, VMs, LaunchAgents and production state were not modified.
- This rollback removes R2 application changes only. It does not modify production data, main schema, existing secrets, the protected PostgreSQL or tunnel service definitions. Uncommitted R3 work is preserved in the separate execution worktree.
- D0-17: Use a separate executor-owned rollback worktree and branch from the deployed R2 merge so no R3 changes can enter the emergency rollback. CI is still mandatory. Production restoration remains pending observed readiness and updater/container evidence.
