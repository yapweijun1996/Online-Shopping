# Target architecture and implementation plan

Current status2026-11-05: Phase0 is independently verified at25ec84f and Phase1 company tools at08136e6. Real authenticated challenge/password review, explicit scope consent, transactional receipts and matching schema30 migrations are implemented. Safe development opt-in registers three company and four catalog safe-subset tools under current scope consent; production activation is rejected. Catalog safe-subset source707052c is independently verified; full variant/media/inventory expansion and the [media delivery plan](MEDIA-DELIVERY-PLAN.md) remain in progress. Actual synthetic snapshot restores and external epoch fencing passed; production multi-instance recovery remains unverified. API.md and10-FINAL-VALIDATION-REPORT.md give current paths, evidence and limits. The original design below is a historical snapshot, not current implementation status.

## Historical design snapshot

Status: **PROPOSED**, except the existing components identified in the audit and the isolated hash helper in the progress report. None of the proposed write tools is available. Baseline: `17bc1de65a83838e0332f2c2cc5271beac6a109b`.

```text
AI client -- OAuth + existing MCP transport --> tenant-bound tool registry
                                                |
                                                v
                                scope + current RBAC + operation policy
                                                |
                                   prepare immutable proposal
                                                |
                         first-party seller UI: fresh human review/approval
                                                |
                                recheck credentials + revision
                                                |
                            existing service + audit in one transaction
                                                |
                                tenant SQLite / PostgreSQL store
```

The existing connector remains the only MCP server. Tenant, issuer and resource come from the server's resolved shop, never tool arguments. The seller UI is independent of the model's content; it renders stored text as text and obtains old/new values from the server. KB-MCP can supply SOP or historical knowledge, but cannot provide authority or current commerce state. KB availability is never an authorization fallback.

## Change boundaries and invariants

Must change: introduce explicit, narrowly scoped opt-in, operation-specific human approval, immutable proposal and revision checks before any business mutation, plus bounded audit and both-database tests.

Must not change: the eight v1 tool names/schemas/responses/scopes; customer data redaction; tenant boundaries; existing OAuth grants; 48-hour computed `SUBMITTED` stock holds; order state machine, snapshots and server-calculated amounts; seller product history; existing retention and currency restrictions.

Each new scope is initially unavailable unless the new feature is explicitly enabled; an existing grant never acquires it. Enabling a flag alone must not create a grant. The consent UI must separately explain and explicitly select read and write authority, with write selections off by default.

No new write endpoint, tool, scope or migration is connected merely by adding the isolated `operation-envelope.js` helper. Its hash is neither a signature nor approval. Approver identity, session, stored proposal, policy, revocation and audit remain mandatory.

## Ordered phases

| Phase | Implementation and independent acceptance | Rollback |
| --- | --- | --- |
| 0 | Build a fail-closed feature flag, additive schema, immutable proposal persistence and policy registry. Add first-party password-bound, CSRF-protected human approval, expiry/replay handling and transactional commit. Prove existing tools unchanged, concurrent/rollback/security cases on both adapters, and no write by flag-off or a read grant. | [Rollback](08-ROLLBACK-PLAN.md); disable flag before considering schema-compatible binaries. |
| 1 | Company read/preview/commit via current settings service; expose only verified fields; use a revision that also changes for Seller Portal edits; separate high-risk currency policy. | Disable company tool policy; preserve prior values/ledger and follow coordinated restore procedure when needed. |
| 2 | Product create/update with validation, shared listing and history wrappers, and revision-safe seller concurrency. | Disable catalog policy; restore only via reviewed business operation or coordinated database restore. |
| 3 | Bounded staging, full image decoding/limits and gallery service; preview old/new image in trusted UI. | Disable upload/layout policies; expire staged blobs; preserve committed associations. |
| 4 | Inventory read/adjust and an atomic movement ledger covering every relevant stock mutation, including orders and seller UI. Preserve 48-hour computed holds. Clearly mark incomplete historical coverage. | Disable adjustment policy; no fabricated backfill or deletion of ledger evidence. |
| 5 | Only existing order decisions, using existing state machine and audit. Verify exact-once stock deduction and decisions. | Disable decision policy; do not reverse an order by restoring an old application alone. |
| 6 | Bounded analytics with independent synthetic fixture oracles and explicit currencies, time zone, definition and coverage. | Disable extended analytical tools; no data migration required unless separately justified. |
| 7 | Owner/client-bound operations get/cancel/audit projections with bounded retention and access checks. | Disable operation endpoints; retain audit evidence under established policy. |
| 8 | Document and test optional KB integration as untrusted knowledge only. | Disconnect knowledge integration; authorization continues to fail closed. |

Every phase requires schema/authorization contracts, positive and negative tests, audit correctness, rollback, and explicit risk review before the next. No phase is production approved by these documents.

## Critical dependency order

1. Design and test the trust boundary in [authorization](04-AUTHORIZATION-AND-APPROVAL.md), before granting write scopes.
2. Make product/company revisions authoritative across *all* writers, not only MCP. A timestamp which can repeat is not a safe revision fence.
3. Hold a verified platform tenant-lifecycle guard across the tenant commit, or implement an equivalent race-safe mechanism. An initial cached ACTIVE lookup alone cannot prove the shop stayed active during a write. The unregistered prototype locks the platform tenant row before entering the tenant transaction and has a synthetic two-database/two-connection suspension race test; integration, broader lock-order analysis and a separate-process/multi-instance test remain open.
4. Introduce the movement ledger only with a migration and an atomic plan for all current stock writers; do not claim history before its coverage date.
5. Resolve image decoding and the existing 64 KiB transport limit before accepting uploads.
6. Require a separate release decision, security review, migration/restore rehearsal and new authorization before any staging or production deployment.
