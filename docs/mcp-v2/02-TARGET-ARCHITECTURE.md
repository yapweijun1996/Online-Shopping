# Target architecture and implementation plan

Current source implements all 32 tools at shop schema 34. All new flags default OFF; production accepts only the complete reviewed `seller-operations-v1` profile with actual production mode, trusted proxy, HTTPS/manual password setup, immutable backend/source and codec pins, and a dynamically checked external epoch. [Production activation](13-PRODUCTION-ACTIVATION.md) is separately owner-authorized and remains pending integrated business/native/TLS, artifact/lifecycle canary and exact-main CI/release gates. [Isolated validation](10-FINAL-VALIDATION-REPORT.md) records historical source counts, not successor acceptance. See [recovery](PRODUCTION-RECOVERY.md) for matched backend/codec/configuration recovery, rollback epoch rotation and quarantined MCP-OFF first fallback. Historical design statements below apply only to their named source.

The reviewed [catalog expansion plan](CATALOG-EXPANSION-PLAN.md) defines union snapshots/projections, fixed constructor-selected dual-scope HIGH update policy, trusted listing identity, exact engine/review changes and phased two-store acceptance. Stock adjustments remain separate inventory operations; newborn staged-image composition is not implied.

The catalog successor selects one pair per CREATE/UPDATE name at construction. `MCP_V2_CATALOG_MEDIA_CREATE_ENABLED` and `MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED` remain independent default-off development/test flags; production requires both enabled within the complete validated profile and manual password login. Every full-profile operation is HIGH with both catalog.write and media.write, including metadata-only UPDATE and image-free CREATE. There is no caller-selected profile or MEDIUM fallback. In development, flag-off preserves the restricted pair while denying pending full-profile operations; flag-on denies review/commit of old safe pending proposals. CREATE binds catalog/catalog and an absent server-generated product/listing identity. EMPTY_BEFORE has no DB snapshot/assets but still requires a PAGE ACK and fresh password. Existing-target byte loading retains its real B1 revision separately from the composite. See [CREATE](CATALOG-MEDIA-CREATE-RUNTIME.md), [UPDATE](CATALOG-MEDIA-UPDATE-RUNTIME.md) and [validation](10-FINAL-VALIDATION-REPORT.md).

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


## Implemented catalog expansion profile

The implemented catalog profiles use one constructor-selected pair per name. Full CREATE/UPDATE require both catalog.write and media.write, current catalog.write RBAC and HIGH human approval. Their separate default-off development/test flags never enable each other; production requires both in the complete profile. In development, safe profiles remain with the corresponding flag off; switching profiles cannot reinterpret an existing pending proposal.

Use one immutable composite revision for operation and descriptor, including the current catalog/media facts and canonical literal labels/true visibility projection. Keep the raw media snapshot revision for exact byte loading. Reuse shared listing, option, gallery, inventory and history services. CREATE reserves no domain rows: bind exact absent server UUIDs and either a real existing target closure or an explicit empty BEFORE; commit supplies real creation time and appends according to the existing service. Existing stock changes belong to the separate HIGH inventory adjustment policy.

Catalog image effects contain no STAGE upload or newborn image composition in this expansion. Protected compact pages must bind actual before/after SKU/name, role and main visibility, plus ordered listing gallery keys. Every page and old/new full-image delivery still requires hash/decode/one-use ACK, unchecked acknowledgment and fresh human password; a zero-image create still needs its page proof. Existing default DIRECT media grammar and original eight tools stay compatible. These implemented policies do not prove live activation; see the activation record for production acceptance and release evidence.
