# Inventory all-writer foundation

This isolated schema32 implementation adds commerce evidence and shared stock mutation services. It does not register inventory MCP tools, change authority, enable existing-stock catalog mutations, or authorize a release. Production, push and deployment remain outside this checkpoint.

## Balance and evidence

`product.stock_quantity` remains the sole current on-hand balance. Null means unlimited; finite balances are integers0..1,000,000. `inventory_state.revision` is a monotonic stock revision, not another balance. `inventory_movement` records physical or tracking-mode changes. `inventory_coverage` makes the beginning of coverage explicit.

The31→32 migration first validates the exact existing operation/media fingerprint, then creates the inventory schema and baseline in one transaction. Every existing product gets MIGRATED coverage with its actual stock at migration time and revision0. It receives no invented historical movement. New products receive CREATED coverage and an INITIALIZED movement at revision1, including zero and unlimited stock. Initial product timestamps retain existing service behavior.

Effective changes advance the stock revision once and append one movement. Setting an identical value, omitting stock from a PATCH, or editing unrelated metadata does neither. Existing product timestamps and product-history semantics remain unchanged. A stock ABA change therefore advances twice even when the final balance equals the initial balance.

Movement kinds are INITIALIZED, SET, TRACKING_ENABLED, TRACKING_DISABLED, ORDER_CONFIRMED and ORDER_CANCELLED. Finite transitions record their exact signed delta; initialization and unlimited/finite mode transitions have a null delta. Source-owned reason codes are PRODUCT_CREATE/PRODUCT_SET, CSV_CREATE/CSV_SET, DEMO_CREATE, OPERATOR_CREATE/OPERATOR_SET and ORDER_CONFIRM/ORDER_CANCEL. Source/reason combinations are checked by both shared service dispatch and DDL. COUNT_CORRECTION, RECEIPT, DAMAGE, OTHER and MCP_ADJUST are reserved in the frozen schema for the separately reviewed adjustment service; the current trusted-context API rejects MCP_ADJUST and exposes no adjustment authority.

Evidence is append-only at the application boundary. Like existing commerce history, the application/database owner can modify tables directly; this is not tamper-proof storage or a complete history of owner SQL. The existing explicit Demo reset exception deletes synthetic movements, state and coverage before their order/product parents, then initializes the fictional catalog again. It checks persisted Demo mode and rolls back all deletions if reseeding fails. Disabling MCP does not disable inventory recording.

## One business writer

`src/inventory.js` owns the sole application stock UPDATE. Product creation initializes through it; explicit product stock PATCH uses it; order confirmation and cancellation use it after aggregating quantities per product across deliveries. Existing portal, CSV import, variant generator, Demo setup/reset, catalog creation and operator scripts reach those services. CSV blank stock means unlimited; an absent stock column preserves stock. Unchanged import rows remain unchanged.

The service joins the existing store transaction. SQLite uses BEGIN IMMEDIATE; PostgreSQL uses the existing transaction-scoped writer advisory lock. Balance, movement, stock revision and existing product/order history commit together. A late ledger/history failure rolls back all lines, metadata and evidence. Initializer failure also rolls back the newly inserted product and listing.

Trusted context is a copied immutable scalar snapshot in module-private AsyncLocalStorage. Product/history and order wrappers resolve the exact current server-provided username to the seller account UUID. Unknown direct legacy callers retain the fixed INTERNAL/business-service label; their raw username is never written to the ledger. Demo and operator labels are fixed in source. Catalog apply passes only the engine's authenticated account/client/grant/operation/correlation fields through a narrow wrapper around its unchanged product/history service call. Request bodies, descriptions, CSV cells and order cancellation notes never supply this context. Optional freeform notes do not enter inventory movements.

Direct service calls remain business primitives, not authorization APIs. The context helper does not authenticate a caller or choose a tenant/store. Future inventory MCP tools must enforce current scopes, capability, tenant/lifecycle fences and human approval before invoking the same service.

## Preserved stock policy

SUBMITTED orders hold quantities for48hours using the existing strict submission-time cutoff. Checkout does not deduct physical stock. Confirmation deducts finite stock; cancellation of a CONFIRMED order restores finite stock. Unlimited products create no physical order movement. Rejecting, hold expiry, shipping and delivery do not move stock. Existing order item name/price/currency snapshots are not rewritten.

Manual finite stock may remain below computed holds. The service does not clamp, reject or subtract holds from such a set. Null↔finite tracking changes remain blocked while an involving order is CONFIRMED. Finite-to-finite changes remain allowed. Existing insufficient-stock confirmation returns409 INSUFFICIENT_STOCK.

Cancellation that would restore a finite balance above1,000,000 now returns409 STOCK_LIMIT_CONFLICT. It never clamps or partially restores an order. This is the intentional error-handling change from a raw constraint error; balances and order states remain rolled back. Stock revision exhaustion returns409 STOCK_REVISION_LIMIT; absent coverage returns503 INVENTORY_UNAVAILABLE rather than silently manufacturing a baseline.

## Schema, import and restore

The inventory schema is generated once for SQLite/PostgreSQL by `inventory-schema.js`. Global32 fresh and upgrade paths use the same DDL. `inventory_schema` stores an exact source-DDL digest and a catalog manifest covering inventory columns, constraints and indexes. Readiness detects actual physical changes; startup does not recompute or adopt stored metadata. Partial/unversioned inventory prototypes are rejected. The separate operation/media fingerprint remains unchanged.

SQLite→PostgreSQL import copies exact coverage, state and movements after products and orders, in FK order. It does not reconstruct or discard inventory evidence. Destination schema metadata remains its fresh compatible metadata. A late import failure rolls back all imported rows. Existing live MCP authority/byte exclusions remain in effect.

Actual private SQLite snapshots and PostgreSQL custom dump/restore tests preserve balances, revisions, movements, coverage and schema readiness. They prove dataful synthetic round trips, not coordinated production recovery. Restoring a prior snapshot revives prior commerce state and loses later writes unless operators separately reconcile them. External epoch rotation, all-instance drain, credential invalidation and reconciliation remain operational release requirements; inventory evidence alone cannot make a restore safe.

Rollback keeps compatible schema32 and all-writer recording, while leaving future adjustment tools disabled. An old binary rejecting32 is not a rollback strategy. Direct SQL and external operators bypassing the service remain outside application coverage. Inventory read projections, complete hold-aware proposal revisions, adjustment tools, browser review and default registration are separate acceptance batches.
