# Inventory delivery plan

Date:2026-11-05. Source audit:`70fd75c`. **Design decisions only; inventory tools, ledger and migration are not implemented by this document.** Work remains isolated and synthetic. Read-only analytics may proceed independently; physical inventory tools remain disabled until all writer and migration gates pass.

## Verified current behavior

`product.stock_quantity` is the on-hand source of truth: null means unlimited; finite values are integers0..1,000,000. Persistent writers are product creation, explicit product stock PATCH, order confirmation and cancellation. Portal edits, CSV import, variant creation, demo setup/reset and operator scripts reach these services. SQLite import and database restore are separate bulk-copy boundaries. Direct owner SQL is outside application coverage.

SUBMITTED orders compute holds for48hours, with a strict submitted-time cutoff. Checkout checks physical-minus-held without deducting physical stock. Confirmation deducts; cancellation of CONFIRMED restores; rejection/expiry release holds; shipping/delivery do not move stock. An expired pending order can still be confirmed if physical stock suffices. Preserve all of these rules.

Finite stock can be set below current holds today. Keep that behavior and report available=max(0,onHand-held), shortfall=max(0,held-onHand). Unlimited onHand/available remain null. Switching finite/unlimited is blocked while an involving order is CONFIRMED. Existing finite-to-finite edits remain permitted.

A confirmed quantity2, subsequent stock set1,000,000, then cancellation currently overflows the database maximum and rolls back. Replace the raw database error with a controlled409 stock-limit conflict in the shared service; never clamp quantities or partially cancel an order.

## Implementation decisions

- Keep one stock writer/planner under the business-service layer. Product creation/PATCH and order deduct/restore call it; MCP adapters do not copy stock SQL. Stock, stock revision, movement, existing product/order history and operation audit share one transaction. Audit failure must fail the entire writer, including ordinary portal writes with MCP disabled.
- Add an append-only movement ledger, per-product stock revision and explicit coverage metadata. Existing products start at a documented migration baseline without invented past movements. New products record initialization even for zero/unlimited. Existing product/order history keeps its current semantics and is not replaced by this ledger.
- Effective physical/mode changes advance stock revision; ordinary no-op setters do not append movement or advance stock revision. Preserve existing product timestamp/history behavior. New MCP no-op adjustment previews reject explicitly; an identical committed idempotent retry returns its original receipt.
- MCP adjustment reasons use a fixed, documented reason code such as COUNT_CORRECTION, RECEIPT, DAMAGE or OTHER. An optional bounded human-reviewed note lives only in the expiring proposal. Ledger/audit/read responses exclude freeform notes and personal data. Existing writers have fixed source-owned reason codes and trusted actor/source context; client input never supplies identity, source key or correlation.
- The ledger follows existing append-only product/order evidence behavior; do not silently apply MCP's90-day retention to commerce movements. The existing demo-reset exception explicitly clears dependent synthetic rows in order. Disabling MCP cannot disable all-writer movement recording.
- Application revision includes monotonic stock revision/current stock and bounded relevant computed-hold and confirmed-mode facts. It excludes the changing wall clock itself. Hold expiry, checkout, order decisions and stock ABA must invalidate relevant proposals. Reuse one trusted asOf/cutoff and existing stock-reservation definitions; no model time parameter controls eligibility.

## Four tools and dependencies

`inventory.summary` and `inventory.movements` require fresh inventory.read and current catalog.write capability. Adjustment preview/commit require inventory.adjust, current catalog.write and HIGH-risk first-party approval. OWNER/MANAGER are eligible; STAFF is not. Tenant/account/client/grant/epoch/build, configured ordinary-shop mode and lifecycle checks remain central and live.

Summary returns safe product identity, stock revision and complete revision hash, on-hand/held/available/shortfall, asOf,48-hour definition and coverage. Preview accepts the exact product, expected complete revision, proposed absolute nullable stock and reason. It shows authoritative before/after and hold/shortfall effects. Commit accepts operation ID only, revalidates and uses stored normalized values. Receipts contain only IDs/revision/optional movement ID, at most2KiB. Movement reads use explicit safe projections, stable bounded pages and honest coverage; they never read images, order contact data or freeform notes.

Catalog creation's initial stock automatically uses the shared initialization path. Existing-stock catalog fields stay rejected until a separately reviewed mixed catalog/inventory authority design exists; a ledger alone does not grant inventory.adjust. Analytics inventory-risk reads use the same availability/hold definitions and do not create movements.

## Delivery and acceptance order

1. Finalize exact DDL and assign the actual next migration after the media schema. Implement SQLite/PostgreSQL parity, all supported upgrades/readiness, permissions, import dependency order and synthetic dump/restore. Existing stock, order snapshots and history remain byte-for-byte equivalent; no authority is created by migration.
2. Integrate every enumerated writer and trusted actor context. Include ordinary edits, omitted/no-op stock, CSV blank versus absent fields, variant generation, demo reset and operator paths. Inject ledger/history/database failures and prove full rollback. Handle cancellation overflow with controlled409 on both databases.
3. Implement bounded summary/movement services and full revision logic. Set explicit active-member/row/byte caps; reject excess instead of partial totals. Measure real query plans with relevant product/order/status-time indexes. Test the strict48-hour boundary, below-hold shortfall and null mode.
4. Add trusted descriptors, exact machine schemas/examples, real OAuth/JSON-RPC and first-party approval/browser tests. Cover missing/invalid/unknown/cross-tenant input, scope/RBAC/revocation/downgrade, stale/ABA/hold-expiry, simultaneous portal/checkout/confirm/cancel and idempotency. One short line must roll back all order lines and evidence. Do not enable default registration before these gates pass.
5. Root independently verifies the frozen commits and full suite, then updates API/task/progress/validation/KB. Development acceptance does not authorize push, merge or deployment.

Rollback disables adjustment tools while retaining schema, ledger and all-writer recording. An old binary rejecting the newer schema is not a rollback plan. Use a compatible binary or an explicitly coordinated synthetic restore rehearsal and reconcile later writes; production restoration needs separate authorization.
