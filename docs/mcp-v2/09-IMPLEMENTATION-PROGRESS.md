# Implementation progress

The original prototype was developed from `17bc1de65a83838e0332f2c2cc5271beac6a109b` and merged in `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`. The next isolated phase-0 branch, `codex/mcp-v2-phase0`, starts at that merge. The expiry helper below is new local development work and is not part of that release.

| Phase | Status | Evidence / remaining acceptance |
| --- | --- | --- |
| Read-only discovery | **DONE** | [Architecture audit](01-CURRENT-ARCHITECTURE-AUDIT.md), source-reviewed business rules, KB context and baseline testing. |
| 0 — foundation | **IN PROGRESS; NOT ACCEPTED** | Unregistered canonical envelope, DDL, scope verifier, review page and prepare/approve/commit engine, tested with synthetic adapters on both databases and a browser mock. No application route, real business adapter, OAuth consent integration, application feature flag or schema migration. No new tool is reachable. |
| 1 — company | **NOT STARTED** | Requires phase 0 plus shared revision/currency-policy validation. |
| 2 — products | **NOT STARTED** | Requires phase 0 plus revision-safe service and history wrapping. |
| 3 — images | **NOT STARTED** | Requires phase 0 plus bounded stage, real decoding and old/new image review. |
| 4 — inventory | **NOT STARTED** | Requires phase 0 plus ledger covering current writers; preserve 48-hour holds. |
| 5 — orders | **NOT STARTED** | Requires phase 0 and an approved, revision-safe decision adapter. |
| 6 — analytics | **NOT STARTED** | Requires independent fixtures, bounded queries and metric-definition review. |
| 7 — operations and audit | **NOT STARTED** | Requires the actual operation lifecycle, per-resource authorization and retention design. |
| 8 — KB integration | **DESIGNED ONLY** | KB remains context only; no new online-shopping integration has been implemented. |

## Completed isolated code

`src/mcp/operation-envelope.js` validates a bounded JSON-only envelope and computes or verifies a SHA-256 digest over identity, tenant, client, grant, resource, policy, risk, revisions, expiry, idempotency binding, correlation and proposal. It rejects malformed Unicode, unsupported values, cyclic/ambiguous objects and oversize inputs. It has **no transport registration, OAuth change, persistence, human authentication, approval authority or mutation capability**. Hashes are not authentication. `test/mcp-operation-envelope.test.js` exercises its current contract.

`src/mcp/operation-schema.js` defines unregistered candidate tables for operation, explicit scope-consent evidence, approval challenges, approvals and metadata-only events. `test/mcp-operation-schema.test.js` exercises opt-in creation, constraints, idempotency uniqueness and injected rollback on disposable SQLite and PostgreSQL. It is not connected to application migrations or authorization, and constraints alone do not prove approval or protect against an improperly implemented writer.

`src/mcp/operation-policy.js` owns the draft tool/scope/RBAC mapping; `operation-authorization.js` requires live token/grant binding and separate v2 consent evidence. `operation-approval.js` and the unregistered `operation-review.*` page prototype show the complete server-stored proposal as text and require a same-origin seller session, CSRF, fresh password and exact hash. `operation-engine.js` prepares and commits stored proposals using a server-supplied adapter, checks approval and revision, enforces pending-operation quotas, and records outcome atomically. A required externally supplied epoch fences old operations and v2 consent after a synthetic rotation; a build digest also fences proposals across implementation changes. Their real provisioning, artifact verification and restore/rollout procedures are not implemented. Synthetic tests cover denial, replay, concurrent decisions/commits, expiry and audit rollback on both databases; a browser mock tests safe rendering and explicit actions. **No application route, actual domain adapter, trusted consent-record creation flow, integrated migration or complete affected-set revision fence exists.** These pieces must not be enabled independently. Media approvals are deliberately absent until image staging and old/new review exist.

Separate-process synthetic PostgreSQL tests observe the existing application advisory lock while a competing transaction revokes a grant, disables or downgrades an account, or deletes a session. A commit already holding the lock completes first; a revocation holding it first makes the later commit fail. This relies on **every writer using the application store lock** and does not prove safety against privileged direct SQL, other paths or an actual HTTP deployment.

`src/platform/tenant-operation-guard.js` is an unregistered PostgreSQL prototype that holds a fresh ACTIVE tenant-row lock around the tenant operation and binds the platform tenant revision into the proposal. A synthetic two-database test observes another OS process wait on the row lock during a tenant commit, and checks that suspension/resumption invalidates an earlier approval. It still needs application integration, a single-tenant guard, wider lock-order/deadlock and multi-instance/restore review.

`src/mcp/operation-expiry.js` adds an unregistered, explicitly invoked bounded expiry batch. Under a supplied tenant guard and tenant-store transaction it marks expired pending operations or approvals `EXPIRED`, consumes any approval and writes a metadata-only audit event atomically. It preserves the operation, proposal and idempotency evidence. Synthetic SQLite and PostgreSQL tests cover tenant isolation, batch bounds, replay evidence, concurrent calls and rollback on audit failure. It does not delete sensitive proposals, establish a retention horizon, run automatically, integrate with the app, or establish multi-instance safety independently of the supplied guard and store lock.

### Expiry prototype verification — 2026-11-05

The branch began at merge `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`. Tests used Node 24.22.0, in-memory SQLite and a newly initialized password-protected UTF-8 PostgreSQL 16 cluster on loopback, with synthetic data. `npm run check` exited 0. `NODE_ENV=test SHOP_TEST_DATABASE_URL=<disposable cluster> npm test` exited 0: **908 tests, 885 passed, 0 failed, 23 skipped**. The 23 skipped tests are browser opt-ins. After a final additional uniqueness assertion, `NODE_ENV=test SHOP_TEST_DATABASE_URL=<another disposable cluster> node --test --test-concurrency=1 test/mcp-operation-expiry.test.js` exited 0: **2 passed, 0 failed, 0 skipped**. Both new clusters were stopped afterward; the full suite started before the last assertion was added. No browser or restore rehearsal was performed for this helper.

The helper has no application caller, migration, scheduler or deployed state. Local rollback consists of removing this unregistered helper and its tests; transaction rollback on injected audit failure was exercised on both databases. This is not evidence of production restore or rollback readiness. Full proposal-data cleanup, idempotency retention policy, denial auditing, real integration and cross-process multi-instance verification remain open.

## Blockers before a write-capable foundation can be accepted

1. Integrate and test the first-party human review screen and server handler together, including actual authenticated routes, security headers, and a real seller session; the browser mock is not an integration test.
2. Finalize and migrate atomic operation/approval/audit storage in SQLite and PostgreSQL; implement bounded cleanup, denial auditing and idempotency retention, and prove import/restore cannot revive v2 consent or approvals even when the database is rolled back.
3. Integrate and independently verify the platform tenant-lifecycle guard and appropriate single-tenant behavior, including wider lock ordering, actual routes and multi-instance lifecycle. For each real adapter, revalidate the complete affected set and business rules inside commit. A product's own timestamp alone misses sibling listing changes.
4. Add explicitly consented scopes and a default-off application flag. Existing read grants and old tokens must remain read-only; test the actual OAuth and protocol paths.

These are outstanding implementation prerequisites, not claims that the existing read-only connector is broken. No later phase should be described as complete until its code, negative tests and rollback are independently verified.
