# Multi-tenant release ledger

Started 2026-10-10 (Asia/Singapore). Source of truth: [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md). Evidence files are git-ignored under `output/qa/multi-tenant/`. No production test data is permitted.

## Release state

| Release | State | Evidence |
| --- | --- | --- |
| R0 | IN PROGRESS | PR #125 corrections already merged and deployed as `feb8707948231e4c55c48ee517de90146b1e9507`; goal and ledger publication pending. |
| R1 | NOT STARTED | Platform core, no production settings. |
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
