# Verification plan

Status: planned tests below are **NOT RUN** unless listed in [validation](10-FINAL-VALIDATION-REPORT.md). Use synthetic records and a disposable SQLite database plus a private disposable UTF-8 PostgreSQL 16 cluster. Never run test fixtures against KB-API or a real shop.

For every new tool cover valid/invalid input, missing/revoked auth, missing scope and RBAC, tenant/resource ownership, unknown resource, output schema and response bound. Mutation tools additionally cover approval, expiry/hash mismatch/replay, stale revision, idempotency, simultaneous commits, audit and database-failure rollback. Confirm no secret, contact data or image bytes leak to audit.

Required phase checks:

- **0:** existing eight contract schemas and redaction unchanged; flag-off/write-scope rejection; existing grants remain read-only; explicit consent; human UI independently authenticated; all lifecycle transitions and terminal-state guards; token revoke, account disable/role downgrade and cross-tenant denial after approval; changed preview/hash, single-use, concurrency and failed-audit rollback on both databases.
- **1:** allowlisted current settings, currency conflict and high-risk approval, portal/MCP revision race, no historical currency rewrite.
- **2:** create/update validation, SKU/category/variants/company currency, audit wrapper, active visibility, stale Portal edit and immutable order snapshot.
- **3:** byte-signature and complete decoder checks, malformed/oversize/image bomb, stage checksum and expiry, foreign product/tenant, original preservation and atomic rollback; browser proves old/new approval preview.
- **4:** null/unlimited, no negative quantity, 48-hour submitted-order hold, stock adjustment followed by order confirmation, confirmed cancellation, ledger completeness since cutover and concurrency.
- **5:** every allowed and forbidden transition, required reason/tracking, one execution and event, stock deduction/restore once, rollback and stale revision.
- **6:** independently computed synthetic fixture values for accepted statuses, UTC+8 boundaries, MYR/SGD, grouping, comparisons and partial coverage; match Seller Dashboard for overlapping definitions.
- **7–8:** operation ownership, cancel/commit race, audit projection and retention, KB unavailable or containing adversarial instructions.

End-to-end: create product → upload → review/approve → publish; replace main image → verify storefront → restore; stale price update rejection; stock adjustment → order confirmation; grant revocation before commit; dashboard/analytics comparison; company consistency; parallel portal/MCP changes.

The final root suite enables `QA_PLAYWRIGHT_MODULE`, `MEDIA_COORDINATOR_CONTAINER_TEST=1`, `MEDIA_TOOLS_NATIVE_BROWSER_TEST=1`, `CATALOG_MEDIA_NATIVE_BROWSER_TEST=1`, `CATALOG_MEDIA_CREATE_NATIVE_BROWSER_TEST=1` and `MCP_CROSS_DOMAIN_NATIVE_BROWSER_TEST=1`, with the private synthetic PostgreSQL URL and Node24. Cross-domain acceptance validates actual successful schemas for every new24 tool plus per-name missing bearer/closed input/read-only scope and10 unknown-operation checks per store. Aggregate/singleton reads have no mutation CAS/idempotency key or arbitrary resource selector; record those as N/A. Existing family tests cover applicable RBAC/tenant/stale/rollback/audit cases. Descriptor equality is distinct from actual response validation. Record actual full counts only after execution.

Discover and record exact repository commands. Run `npm run check`, `NODE_ENV=test npm test`, focused MCP/OAuth tests, both database migrations, browser UI/E2E, dependency audit, static security analysis, bounded performance and restore rehearsal. A skipped, unavailable or unrun test is BLOCKED/NOT RUN, never passed. Record command, environment, exit code, count and tested commit.
