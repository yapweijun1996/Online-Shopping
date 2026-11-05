# Order decision MCP tools

This isolated Phase 5 implementation registers two decision tools under the existing safe v2 development gate. Production activation remains blocked. It uses the existing order state machine, mutation helper, inventory ledger and schema 33 indexes. It adds no migration, provider call, payment/refund/courier creation, WhatsApp action or deletion.

## Actual contracts and authority

[03-ORDERS-IMPLEMENTED.json](03-ORDERS-IMPLEMENTED.json) is exported from the actual trusted registry by `node scripts/export-orders-contracts.js`. Four input/output schemas and synthetic examples are validated and compared with genuine authenticated tools/list. Earlier proposed contracts remain historical.

Both orders.preview_decision and orders.commit_decision require fresh orders.decide consent and current orders.decide capability, with HIGH first-party password approval. OWNER/MANAGER are eligible. STAFF's existing portal shipping/delivery capability is unchanged and does not grant these MCP tools. The original eight schemas/results stay unchanged; existing inventory names remain available under their own fresh scopes. A grant with all implemented non-media scopes sees the prior 22 plus these 2. Disabled/production/Demo/explicit-empty constructors expose no new order authority; null registries remain invalid.

Preview's standard wrapper accepts idempotencyKey and input: UUID orderId, optional positive integer expectedRevision, and decision. Action is confirm/reject/cancel/ship/deliver only. Reject/cancel require reason; ship requires carrier and optional trackingNo; confirm/deliver accept no extra action fields. The shared existing validator checks exact allowed fields, trim/NFC normalization, control characters and normalized limits reason 500 / carrier 40 / tracking 60. Wire text is capped 4096 before normalization so valid existing whitespace/Unicode normalization is preserved. Null/absent/empty shipping tracking normalizes to null. Unrelated action fields remain rejected.

The old eight order reads omit both integer revision and complete hash. Clients therefore need not guess: absent expectedRevision captures the actual server integer and complete resource SHA at prepare. Supplied stale integers reject. The first-party review shows captured before integer/hash and exact proposed transition/stock effects. Commit always passes that stored actual integer to the existing CAS mutation helper. This protects preview→commit; it makes no promise about an earlier unfenced model read or inferred intent. There is no third read tool, clock input or legacy schema expansion.

Commit accepts only operationId and returns the standard receipt wrapper with orderId/orderNo/status/integer revision/resourceRevision hash, under 2 KiB. It never accepts a replacement action, identity, tenant, scope, adapter, amount, approval or password. No domain reason/carrier/tracking, customer fields or item text appear in its minimal receipt.

## Existing business behavior

| Action | From → to | Physical/computed effects |
| --- | --- | --- |
| confirm | SUBMITTED → CONFIRMED | Deduct finite physical quantity once per aggregated product; unlimited does not move. Release only the order's currently active computed hold. |
| reject | SUBMITTED → REJECTED | No physical movement; release currently active hold. Required existing domain reason. |
| cancel | CONFIRMED → CANCELLED | Restore finite quantity once; unlimited does not move. Restoration above 1,000,000 returns controlled 409 and rolls back every line. |
| ship | CONFIRMED → SHIPPED | No physical movement; remove confirmed-mode restriction fact, store validated manual carrier/tracking. |
| deliver | SHIPPED → DELIVERED | No stock movement. |

The 48-hour cutoff remains strict. A previously expired pending order can still confirm when physical stock suffices, even if other active holds mean resulting available stock is zero/shortfall positive. Confirmation checks physical stock, not a newly invented availability predicate. No stored reservation is created. Monetary amounts/currencies and order-item name/SKU/price/quantity snapshots are never repriced or rewritten. MYR/SGD, catalog repricing and snapshots are tested.

Frozen ORDER_TRANSITIONS, validateSellerDecision and planSellerDecision share the existing state/input rules with portal and tracking CSV. The shared planOrderStock provides the same insufficiency, overflow and unlimited behavior for preview and actual inventory write. Reservation cutoff/predicate is shared and computed once per phase/row set. Action-specific fields/from-state and supplied stale integers fail before expensive full graph reads.

The business order-decisions service owns SQL/proposal/apply; the adapter contains no commerce SQL. Apply calls applySellerDecision only, never the full getSellerOrder/decideSellerOrder wrapper that loads contacts/documents/media. Current server username remains the existing domain-event actor format; the immutable inventory context binds trusted human UUID/client/grant/operation/correlation. Order/stock/revision/movements/order_event/standard COMMIT audit share the engine transaction.

Raw normalized reason remains only in the expiring proposal and existing order_event policy. Manual carrier/tracking remains only in the proposal and existing shop_order fields. These values are not added to inventory movements, new MCP audit outcomes, logs, receipts or KB. Inventory reasons stay fixed ORDER_CONFIRM/ORDER_CANCEL with trusted IDs; standard fixed COMMIT audit joins by operation/correlation. No provider is contacted.

## Complete resource fence and bounded reads

Each prepare, current-revision check and commit captures a fresh server instant. A phase uses one consistent instant to classify 48-hour holds. Commit never reuses the preview instant as its eligibility clock. The SHA includes the safe order header and integer revision, destination IDs/positions, complete safe item snapshots and each affected product's complete inventory revision. That inventory revision binds physical quantity, monotonic stock revision, hashed display labels, ordered active-hold facts and confirmed-mode facts. The instant itself is not hashed: natural hold expiry changes the classified facts and therefore the revision. Stock ABA, checkout, another decision and relevant portal edits invalidate an approved proposal.

Queries explicitly select safe metadata. Customer contacts, addresses, notes, existing manual tracking fields, documents, images and BLOBs are neither loaded nor returned. New action fields are proposal data, never authority. Header money and item money are read as decimal text and checked for safe integer conversion, multiplication, currency equality and exact totals. Invalid legacy data fails closed with a controlled service error.

| New-channel budget | Bound and behavior |
| --- | --- |
| Target header | UTF-8 metadata preflight at most 1 KiB |
| Destinations / item lines / distinct products | At most 10 / 100 / 50; count before materializing the complete graph |
| Complete safe item source | At most 64 KiB UTF-8, preflight before line loading |
| Affected-product historical inventory facts | Joint budget of 10,000 lines / 4 MiB across all affected products, not a separate budget multiplied by product count |
| Complete proposal | At most 48 KiB JSON plus the existing canonical registry bounds |
| Receipt | Minimal closed schema, at most 2 KiB |

Over-budget reviews raise controlled `503 ORDER_DECISION_LIMIT`, with no operation or partial proposal. Unsafe source data raises `503 ORDER_DECISION_UNAVAILABLE`. The existing transport maps both to HTTP 503 `temporarily_unavailable`; it does not expose the internal domain code. These are MCP-channel limits: larger valid orders remain valid under existing portal services. There is no truncation and no new reservation or order-size business restriction. Joint source budgets include historical facts regardless of current activity. The existing schema-33 `order_item_inventory(product_id,id,delivery_id)` index is checked before graph reads; no migration is added. Synthetic query-plan tests verify order primary-key, destination/line and affected-product indexes while unrelated orders do not enter the affected-product budget.

## Verification and security cases

Tests use actual `Request` to `createApi`, genuine fresh OAuth grants, first-party password/Origin/CSRF challenges and the real services on disposable SQLite/PostgreSQL databases. Browser tests use local HTTPS and Chromium without backend or permission substitution. All five actions, customer status after fulfilment, commit replay and stock restoration are exercised. Untrusted reason/tracking text remains inert review data.

The security matrix covers these independent boundaries:

1. Closed schemas reject replacement identity, tenant, permission, adapter, amount, approval and unsupported action fields.
2. Missing scope, absent fresh consent, STAFF capability and Demo/default-off gates deny authority.
3. Expired/revoked access or grant and disabled/currently downgraded accounts deny preview or commit.
4. Cross-tenant, cross-client and another human's operation cannot be used or approved.
5. Approval requires the current owner's session, correct password, Origin, CSRF and exact immutable hash.
6. Optional stale order integers reject; absent integers capture actual server state.
7. Portal decisions, physical-stock ABA and checkout invalidate the complete resource fence.
8. Natural hold expiry invalidates approval; expired pending confirmation preserves existing physical-stock rules.
9. Unsupported from-state and action-specific invalid fields reject before expensive graph reads.
10. Concurrent confirm/cancel/checkout and duplicate commits cannot overwrite stock or repeat movements.
11. Insufficient stock on a later line and cancellation overflow roll back all lines; unlimited stock emits no artificial movement.
12. Injected ledger, domain-history or COMMIT-audit failures roll back order, stock, revision, movement and history together.

Independent fixtures also check MYR/SGD separation, immutable historical item/price snapshots after catalog repricing, safe-query spies, exact output contracts, byte/row caps and unchanged legacy inventory/order/tracking behavior. Query timings are local diagnostics, not production performance claims. The outside implementation summary records exact executed counts and the initial browser rate-limit fixture failure; the existing approval limiter was preserved.

## Acceptance and rollback

This checkpoint implements only the existing five seller decisions through the two approved tools. It does not accept future order actions, contact reads, refund automation, courier creation or any production rollout. Default registration remains subject to independent root review, the current safe-v2 development gate and fresh `orders.decide` authorization.

Operational rollback is to disable v2 or remove this trusted default pair through a reviewed release. No schema downgrade is required because this change adds no migration. Existing order events, ledger evidence and operation records must be retained under their existing policies; do not delete evidence or reverse stock by replaying commands. Already committed domain decisions remain committed. Deployment, multi-instance production behavior and external integrations are outside this synthetic checkpoint.
