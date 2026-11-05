# MCP v2 validation report — security foundation

Date: 2026-11-05. **The complete Seller Operations Engine is not finished.** This report covers Phase 0. Company tools are in a separate development workspace; no domain tool is registered by default, and production v2 activation is rejected.

## A. Baseline

Repository: `yapweijun1996/Online-Shopping`. Isolated branch: `codex/mcp-v2-phase0`; baseline `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`. Latest source checkpoint: `25ec84f` (recorded timestamp expiry fix). Environment: persistent host `yapvmmcp`, Node 24.22.0, SQLite, a new password-protected UTF-8 PostgreSQL 16 loopback cluster and cached Playwright/Chromium. All test data is synthetic.

## B. Implementation

Implemented: default-off configuration, external restore epoch, source-derived build digest, schema 30 migrations, explicit OAuth scope consent, current scope/RBAC validation, immutable proposals, first-party review, single-use session/hash-bound challenges, fresh password verification, transactional commit and receipt replay. The existing eight read tools retain their contracts. The server-owned operation registry dispatches outside the tenant transaction, preserving platform-before-tenant lock order. Its application default is empty.

Schema 30 has SQLite migration, matching fresh PostgreSQL SQL and every supported PostgreSQL upgrade path. Imports exclude active v2 authority. Expired terminal proposals are redacted; only validated minimal receipts are stored. Receipt retention ends at original grant expiry plus 90 days; audit retention remains 90 days. Request maintenance is limited to successful authenticated operation data requests. The existing bounded cleanup CLI also supports feature-off cleanup and private suspended-shop hygiene without enabling business authority.

Changed areas: `src/mcp/`, config/database/migrations/import, tenant routing/guards, cleanup CLI and associated tests. Exact inventory: `git diff 1634735..25ec84f --stat`. No domain business adapter is accepted by this report.

## C. Executed verification

Private disposable connection values and epochs are intentionally omitted. All commands used Node 24 where applicable.

| Command / scope | Exit | Observed result |
| --- | --- | --- |
| `NODE_ENV=test SHOP_TEST_DATABASE_URL=<synthetic URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 'test/*.test.js'` at `25ec84f` | 0 | **1015 tests: 991 passed, 0 failed, 24 browser opt-ins skipped**, 162.082 s. `.local/manager-phase0-full-clock-fixed.tap`. |
| Snapshot restore + cleanup CLI + historical account upgrade + both review browser tests, PostgreSQL and `QA_PLAYWRIGHT_MODULE` enabled | 0 | **14 passed, 0 failed/skipped**, 6.942 s. `.local/manager-phase0-restore-cli-browser.tap`. Includes actual local HTTPS login/review and real SQLite/PG snapshot restore. |
| Exact PostgreSQL concurrent RPC commit case twice at frozen `39b204d` | 0, 0 | **1 passed** in each isolated run, 0 failures/skips. |
| Integrated config/storage/OAuth/v1 checkpoint `faed47b` | 0 | **68 passed**, 0 failed/skipped. |
| Real approval/engine/routes/browser checkpoint `e5a4b8a` | 0 | **24 passed**, 0 failed/skipped. |
| `npm run check` | 0 | JavaScript syntax checks passed. |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 vulnerabilities reported for the unchanged lockfile at execution time. |
| `python3 test/auto-update.test.py` | 0 | **39 passed**. |
| `python3 test/gcp-deploy.test.py` | 0 | **17 passed**. |
| `git diff --check` | 0 | Passed. |

The timestamp-fix approval/engine/registry targeted run independently passed **24/24**, 0 skipped, 9.923 s (`.local/manager-phase0-clock-fix.tap`). The full run at `39b204d` previously passed 1013 tests (989 passed, 24 skipped); the real timing defect described below was subsequently reproduced and fixed rather than hidden by that passing run.

### Failures found and resolved

- A pre-registry full run at `d7233f9` exited 1: **991 tests, 966 passed, 1 failed, 24 skipped**. A historical schema-22 fixture tried to drop `oauth_grant` before the new dependent v2 tables. The fixture now drops dependencies explicitly and closes its store in `finally`; original upgrade assertions remain intact.
- Actual PG dump/restore exposed readiness failure because PG16 flattened equivalent nested `BETWEEN` conditions. Shared DDL now uses explicit comparisons; restored catalog manifests match while removed indexes/weakened constraints are still rejected. Both raw restores revive old grants/tokens/sessions/approval rows, but a changed external epoch denies v2 writes and approval; adapter invocation remains zero.
- Independent review found anonymous/failed review requests could drive maintenance. Public assets and denied requests no longer trigger it; successful authenticated data requests still clean expired proposals.
- Intermittent broad-run commit failures were traced to two separate clock reads: approval expiry could be 300001 ms after its recorded creation time and was correctly rejected by the strict 300000 ms engine bound. Deterministic advancing-clock tests failed before the fix on both databases. Challenge/approval expiry now derives from the single recorded timestamp, preserving the strict bound. This was a real timing defect, not dismissed as pool contention or labelled flaky.

## D. Risks and limits

Cross-agent source review is not external penetration-test certification. Real AI-vendor OAuth interoperability, physical-device browsers, production capacity, coordinated multi-instance draining/epoch rotation and production restore are unverified. Filesystem checks cannot prove the epoch is outside every operational backup domain. Restored v1 credentials still need operational invalidation under the existing runbook; v2 epoch fencing does not replace that step. Every future business adapter still needs complete affected-set revisions, service-rule, privacy, concurrency and rollback verification. Media remains ineligible until byte validation and old/new review exist.

`11-SOURCE-SHA256SUMS.txt` identifies the original prototype and is historical, not the current integration manifest.

## E. Readiness and rollback

Development foundation: independently verified at `25ec84fd63f8e7801aa6cae92b041b237b6f8436`; final verification is recorded by exact snapshot above. Full MCP v2: incomplete. Staging/production writes: **not ready**; production activation is explicitly blocked. Schema 30 is a protected future release. Feature disablement cannot downgrade the schema; an old schema-29 binary rejects version 30. Synthetic snapshot recovery/fencing is verified, production coordinated rollback is not.

## F. Production safety

Accessed: local source/worktrees, synthetic databases, GitHub read-only fetch and KB-MCP context/skills. No push, main merge, deployment, production cleanup, production commerce-data access or service/timer/cron changes occurred in this run. Commits are local isolated development commits. No real secrets/customer data entered tests.

## G. Next actions

Continue the already authorized company tools and later phases after the verified foundation. Keep production disabled, preserve the eight v1 tools, and require phase acceptance before enabling business adapters. A development completion is not production release authorization.
