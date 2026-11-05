# Inventory MCP tools

This isolated Phase4 implementation adds four tools under the existing safe v2 development gate. Production activation remains blocked. Schema32 all-writer stock evidence is reused; schema33 adds the justified order-source index. Catalog stock PATCH, order decisions and media authority are unchanged. No deployment is authorized.

## Actual contracts

[03-INVENTORY-IMPLEMENTED.json](03-INVENTORY-IMPLEMENTED.json) is generated from the actual trusted registry by `node scripts/export-inventory-contracts.js`. Schemas/examples are validated and compared with genuine authenticated `tools/list` output. Earlier proposed contracts remain design history.

| Tool | Fresh consent | Current capability | Behavior |
| --- | --- | --- | --- |
| inventory.summary | inventory.read | catalog.write | Complete current product stock snapshot and revision |
| inventory.movements | inventory.read | catalog.write | Bounded descending stock-revision pages with coverage |
| inventory.preview_adjustment | inventory.adjust | catalog.write | HIGH durable proposal without business effect or approval |
| inventory.commit_adjustment | inventory.adjust | catalog.write | Apply one approved stored adjustment or replay its receipt |

OWNER and MANAGER are eligible; STAFF is not. Current tenant, account/client/grant/token, scope consent, role, ordinary-shop mode, epoch/build and lifecycle fences remain central. Adjustment consent does not imply read consent. Explicit empty registries stay empty; disabled, Demo and production constructors expose no inventory tools. The original eight definitions/result schemas stay unchanged. Old grants expose no new tool; a grant with all implemented scopes sees the prior18 plus these4.

Summary accepts only UUID `productId`. It returns bounded product identity, physical `onHand`, monotonic `stockRevision`, complete `revision`, computed `held`, `available`, `shortfall`, active hold/confirmed order counts, trusted `asOf`,48-hour definition and coverage. Product text is untrusted data. Null onHand/available means unlimited; finite available clamps at zero for presentation while shortfall stays explicit.

Movements accepts `productId`, optional `limit`1..100 (default50), optional exclusive `beforeRevision`. Descending keyset pages return `nextBeforeRevision`; appended higher revisions cannot shift later lower pages. No unbounded total count is queried. Rows expose IDs, stock revision, kind, fixed source/reason, before/after quantity, signed nullable delta and time. They exclude actor/OAuth/order/correlation/source-key fields, names, freeform notes, contacts and media. Private ledger identity bindings remain retained.

Preview takes the standard `idempotencyKey` wrapper and `input`: UUID productId, complete expectedRevision, absolute nullable stockQuantity0..1,000,000, reasonCode COUNT_CORRECTION/RECEIPT/DAMAGE/OTHER, optional500-character note. Note is trimmed and lives only in the expiring proposal. Inputs cannot choose actor/source/time/tenant/role/scope/adapter/approval/password. Commit takes operationId only; receipt contains product/movement IDs, stock revision and complete revision under2KiB, with no note/name/SKU/price/contact.

No-op preview returns409 before persisting an operation. Legacy identical setters preserve their prior timestamp/history behavior. Unknown/malformed inputs and missing targets map to JSON-RPC -32602. Stale preview maps to -32009; stale approved commit returns `{operationId,error:"STALE_REVISION"}` and records CONFLICT without business effect. Invalid credentials retain401; missing authority/invalid approval403. Budget/index/data availability failures503 never return partial totals or silently truncate.

## Complete revision and time

The business service hashes safe reviewed labels/active state, physical stock, monotonic stock revision, coverage and complete ordered relevant order-line facts. Active holds are exactly SUBMITTED with strict submission time greater than trusted server time minus48hours. CONFIRMED facts bind the tracking-mode restriction. Line/delivery/order identity, quantity, status, order revision and submission time are included. Checkout, stock ABA, relevant decisions, reviewed-label edits and hold expiry invalidate affected proposals. Unrelated price/currency/media/description/product changes are excluded.

The clock itself is excluded. Reads stay stable while relevant state/membership stays stable; a hold expiring removes its fact and changes revision naturally. Every snapshot/planning/commit phase captures one internal server instant. Commit captures a fresh instant, never the preview's eligibility clock. The framework checks currentRevision; business apply captures fresh facts again, checks reviewed revision and uses its own same instant for planning/resulting receipt. This is consistent phase-snapshot semantics, not nanosecond-perfect eligibility at the physical COMMIT instruction. Tenant writers remain serialized. No public time argument controls eligibility.

## Shared behavior and evidence

The adapter contains no business SQL. `inventory-reads.js` owns SELECT snapshots/pages, planning and transaction-aware commit. `inventory.js` shares one pure quantity/mode planner with legacy writers. Its validated adjustment API alone enables MCP_ADJUST with a reviewed allowed reason and trusted engine account/client/grant/operation/correlation. Generic context still rejects MCP_ADJUST. No note reaches that primitive.

Stock, revision, movement, existing product history and standard operation COMMIT audit commit atomically. `trackStockUpdate` reuses private diff/append history functions with stock metadata only, avoiding full product/media/variant/description loads. Existing portal history stays unchanged. The authoritative reason is in inventory_movement; standard fixed-outcome COMMIT audit joins by operation ID with matching identity/correlation. No duplicated reason or freeform audit outcome is introduced.

Below-hold finite sets remain allowed; unlimited remains null. Finite/unlimited flips remain forbidden while an involving order is CONFIRMED. SUBMITTED holds never deduct physical stock. Existing confirm/cancel services remain unchanged. One approved adjustment applies once; concurrent confirmation either serializes after it or makes its revision stale. Failed business/ledger/history/audit transactions produce no successful effect/receipt.

Coverage reports APPLICATION_WRITERS, CREATED/MIGRATED origin, start instant, baseline and unavailable pre-coverage history. No past movement is invented. Owner SQL, uncovered external changes and coordinated restoration/reconciliation are not implied covered. Evidence follows application append-only commerce policy/Demo exception, not DB-owner tamper resistance. Notes are actually redacted with expired terminal proposals; minimal receipt/evidence follow existing retention. All-writer recording remains on with v2 disabled.

## Bounds and schema33

The entire per-product order-line source, including old/expired/non-holding lines, is capped10000. This conservative lifetime source budget can reject a popular product with no current holds; a later reviewed policy must address larger histories. Other products consume none of this limit. `order_item_inventory(product_id,id,delivery_id)` makes the capped count/ordered lookup selective. SQL conservatively preflights UTF8 metadata before materialization, cap4MiB; final canonical bytes are also checked. Unknown/noncanonical legacy facts fail closed. No partial hold totals are returned.

Missing/changed index definitions fail before source scans even on an already-open store. Reads/proposals/revisions/movement pages use explicit metadata, never customer names/contacts, order snapshot text, notes or media. Responses stay below64KiB and arrays at most100. Excess pages fail503 instead of broadening registry caps.

Schema33 is index-only. Frozen32 inventory table DDL, version and stored fingerprints are byte-for-byte unchanged. Explicit migration verifies source32 operation/media and inventory physical fingerprints, refuses preexisting index prototypes and advances33 transactionally. Readiness checks exact index definition/valid-ready state separately. Fresh two-store baselines, frozen32 golden upgrade, existing older paths, restricted roles, exact import, actual snapshot/dump-restore and index tamper denial are tested. Ledger history is not rebuilt.

## Acceptance matrix

| Case | Actual synthetic evidence |
| --- | --- |
| 1 Scope/consent | Real PKCE/password/consent/token; read-only cannot adjust; old eight retained; current consent denial |
| 2 Role | New MANAGER account changes temporary password and obtains fresh own OAuth/review/commit; STAFF downgrade denied |
| 3 Binding | Wrong tenant and different genuine OAuth client cannot commit another binding |
| 4 Revocation | Account/token/grant denial, including already-approved proposal |
| 5 Runtime | Ordinary configured mode, Demo/disabled/production and explicit empty/null constructors |
| 6 Human authority | No approval, wrong hash/password/session, missing Origin/CSRF, closed authority arguments; inert note |
| 7 Staleness | ABA, portal/labels, checkout, rejection/cancellation and naturally expired holds |
| 8 Policy | Zero/null, below-hold shortfall, confirmed mode restriction and no-op |
| 9 Concurrency | Duplicate commit one movement/history/audit; real confirm/adjust contiguous chain |
| 10 Atomicity/privacy | Ledger/history/COMMIT/read-audit failure rollback; note excluded and actually erased on expiry |
| 11 Bounds | Exact row boundary, unrelated history isolation, UTF8 preflight, SELECT-only/metadata-only spies, keyset, index denial/plans |
| 12 Contracts/browser | Actual descriptor export and default names; real HTTPS Chromium bothDB approval/commit/replay/storefront |

These are synthetic implementation checks, not production/vendor/edge certification. Root independently accepts frozen source. Rollback removes the four registrations while retaining compatible33/index/all-writer recording. An old32-only binary is not rollback. No production access, migration execution against a real shop, network fallback, deployment or push is authorized here.
