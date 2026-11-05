# Implementation progress

Updated 2026-11-05. Baseline `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`; active isolated branch `codex/mcp-v2-phase0`. Foundation source checkpoint `25ec84fd63f8e7801aa6cae92b041b237b6f8436` is independently verified. **The complete MCP v2 project is not finished. No production action is authorized by this progress report.**

| Phase | State | Evidence / next acceptance |
| --- | --- | --- |
| Read-only audit | Complete at original snapshot | Architecture audit distinguishes source evidence and historical KB; initial prototype merged previously at `1634735`. |
| 0 — security foundation | **Verified in isolated development** | Default-off/prod-blocked config, explicit OAuth consent, schema30, authentic first-party challenge/password approval, platform lifecycle fence, immutable operation engine, minimal receipts, bounded cleanup/CLI, gated trusted registry, actual snapshot restore. Independent full suite **1015 total, 991 passed, 0 failed, 24 browser opt-ins skipped**. See validation report for separately executed browser tests and limits. |
| 1 — company | **In progress, separate worktree** | Reuse settings validation and currency rules; all-writer affected-set revision, owner-only policy, dedicated human currency acknowledgment, authenticated read entry and actual MCP tests. Not accepted or globally registered yet. |
| 2 — products | Not started | Shared listing/variant revisions, current business services, SKU/history and concurrent portal protection. |
| 3 — images | Not started | Byte decoding, bounded staged storage, checksums and old/new image approval; media operations remain ineligible. |
| 4 — inventory | Not started | Ledger across all stock writers; preserve verified computed48-hour SUBMITTED holds. |
| 5 — orders | Not started | Existing decisions/state machine only; stock deduction exactly once and explicit human approval. |
| 6 — analytics | Not started | Independent metric fixtures, currencies, UTC+8, bounded date/query coverage. |
| 7 — operations/audit | Not started | Resource-bound inspection/cancellation/audit tools; foundation maintenance is not their implementation. |
| 8 — KB integration | Designed only | KB remains untrusted knowledge, never live-state or authorization authority. |

## Verified foundation behavior

- `readConfig` exposes v2 only after explicit development opt-in, an HTTPS seller origin, password login and canonical external epoch. Production activation is rejected. Source/public/package contents determine the build digest; operator labels cannot supply it.
- SQLite and PostgreSQL use schema30, with matching fresh SQL and all supported PostgreSQL10-29 upgrade paths. A preliminary optional-extension checkpoint was replaced by proper migrations to follow repository rules. Empty new tables confer no scopes. Import excludes active v2 consent, requests, operations, approval and challenges.
- New scopes require separately recorded consent bound to tenant/account/client/grant/auth-version/epoch/time. Legacy tokens and grants never gain writes by scope-string edits or refresh.
- Real application routes serve the first-party review. Exact Origin/CSRF, current authenticated session, fresh password and a one-use operation/session/hash-bound challenge are mandatory. Locks are released during password verification, then account, grant, tenant revision and password identity are rechecked under the platform-first fence.
- The engine persists immutable canonical proposals, uses only their server-stored changes, validates resource revisions, consumes approval and records outcome atomically. Registry dispatch occurs outside the v1 tenant transaction to preserve lock order. Only server code can supply adapters; the default registry has no domain tools.
- Adapters must convert results to a validated minimal receipt (<=2KiB). Expired terminal proposals are redacted; authorized replays return receipts without applying again. Receipts survive to original grant expiry plus90days; audit remains90days. Maintenance is bounded and occurs after locks; anonymous/failed review requests cannot drive it. Existing CLI supports repeated feature-off cleanup with a private hygiene-only guard for suspended tenants.
- Actual SQLite and PostgreSQL snapshot restores were exercised. A different external epoch denies restored v2 authority even though rows physically reappear. A PostgreSQL deparser/fingerprint mismatch and a1ms approval timestamp defect were found, reproduced and fixed without weakening checks.

## Independent evidence and limits

Latest full command: Node24.22.0, `NODE_ENV=test SHOP_TEST_DATABASE_URL=<private disposable URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 'test/*.test.js'`, exit0, **1015 tests /991 passed /0 failed /24 skipped**,162.082s. Targeted timestamp-fix approval/engine/registry tests:24/24. Actual snapshot/CLI/accounts/both review browsers:14/14. Syntax, dependency audit (0 reported vulnerabilities), updater39/39 and GCP deployment17/17 checks passed. Exact snapshots and earlier failed runs are retained in [validation report](10-FINAL-VALIDATION-REPORT.md).

Source reviews are independent cross-agent reviews, not external security certification. Production artifacts, physical devices, external OAuth vendors, operational backup-domain separation and coordinated multi-instance restore/epoch rotation remain unverified. A schema29 binary rejects30; flags cannot downgrade databases. New business phases still require their own service, privacy, concurrency, rollback and negative tests before acceptance.
