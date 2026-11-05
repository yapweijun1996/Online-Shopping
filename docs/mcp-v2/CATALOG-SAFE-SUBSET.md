# Catalog tools: staged safe subset

Status: **Phase2 IN PROGRESS**, not full variant/media/inventory acceptance. `catalogCreateTool()` and `catalogUpdateTool()` export four server-owned preview/commit descriptors. Importing the module registers nothing. Default wiring remains the previously reviewed company tools; production v2 activation remains blocked. The eight v1 tool schemas are unchanged.

## Freshness and review

A real preview captures its internal revision under the tenant lifecycle fence and shared writer transaction. Clients submit intended product fields, not `expectedRevision` or a relabeled v1 timestamp. The first-party human sees authoritative normalized before/after and the complete shared-listing effect; commit checks the captured token again. This guarantees freshness from preview to commit, not rejection of every change since an earlier model read. A future separate v2 snapshot contract would be needed for that stronger pre-preview requirement.

Create uses logical resource `catalog` with a content-derived catalog-root token. Revision scans explicit product/listing/category/option metadata in pages of at most200 rows, hashes canonical records individually, stops at a cumulative8MiB metadata budget, and rejects more than10,000 products/listings/dictionary rows or60,000 option mappings. A create preview requires fewer than10,000 existing products so its resulting receipt can still be computed within the bound. Root invalidation is deliberately conservative: unrelated catalog or confirmed-stock writes can invalidate a pending create.

Update hashes the complete current listing/group component, mappings, referenced and proposed option type/value metadata, category state, company default currency, gallery IDs/layout/presence metadata and desired-SKU uniqueness predicate. At most300 members are permitted; larger sets fail closed before unbounded detail helpers. This captures sibling shared-text and option-label changes even when the target timestamp is unchanged. Review payloads above48KiB or the framework node bound reject rather than hide effects. Shared before/after is accompanied by all affected member IDs/SKUs and explicit per-member before/after overrides for historical divergent copies. Only supplied shared fields propagate; an explicit parent-equal field can still normalize divergent members. Option review resolves full server-owned type/value names, codes and active flags for each of at most6 before/after choices; it never relies on truncated derived labels or opaque IDs alone.

Preview/revision use explicit metadata `SELECT` projections, never image/thumbnail byte columns or `SELECT * FROM product`. They do not mutate business tables. Existing commit/history services remain responsible for their normal bounded detail reads; no gallery algorithm or media behavior is modified by this phase.

## Shared services and validation

`prepareProductCreate` / `prepareProductUpdate` retain the original product validation and currency/category/group/stock-tracking checks; portal create/update call the same helpers. `prepareProductOptions` shares option validation and derived-label planning with `setProductOptions`. Shared SKU and legacy-label uniqueness checks retain database constraints as final enforcement. Label prechecks mirror the actual dialect index (SQLite NOCASE; PostgreSQL lower), including labels derived from options.

Normalization remains the existing uppercase safe SKU/group, bounded text, minor-unit price, company/existing currency and option rules. Omitted update fields are preserved. Unknown identity, actor, authority, media and existing-stock fields reject. A valid but missing product UUID rejects through the existing HTTP200 JSON-RPC -32602 Invalid params transport before an operation is persisted. No categories or options are silently created. Tenant-owned IDs resolve only through the current tenant store.

Commit passes only stored normalized create input or update **patch** through `createProduct` / `updateProduct`, wrapped in `trackCreate` / `trackUpdate` with a server-resolved actor. It does not copy unchanged stock back through a full after-object. Service result is checked against the reviewed after-state before the minimal receipt is accepted. Product/listing changes, existing product history, approval consumption and operation audit share one transaction. Existing product history records the edited target; this phase does not fabricate per-sibling historical events. The existing product-history field set also omits option mappings: an option-only edit with an unchanged clipped label can have no product UPDATED event; the operation COMMIT audit still records the approved mutation. This preserves current service history behavior and does not claim complete per-option history coverage.

Receipt contains only `productId`, `listingId` and a revision hash. Product prose, SKU/price, images and other domain result fields are not persisted in the replay receipt.

## Dependency matrix

| Change | Phase2 behavior | Dependency before expansion |
| --- | --- | --- |
| New standalone SKU / first SKU in an empty group | Supported with existing category/currency/options rules | Existing human approval and `catalog.write` |
| New SKU initial stock | Explicitly shown, `null` remains existing unlimited default;0–1,000,000 supported | Creation policy only; no fabricated movement history |
| Existing listing text/category, variant price/active/SKU | Supported with complete affected-component review | Current `catalog.write`/RBAC/consent |
| Existing-group options | Existing choice, inactive-current-choice, type-set, unique combination and derived-label rules | Dictionary mutations invalidate pending review |
| Raw derived-label override on an option-bearing variant | Rejected; choose options instead | Separately reviewed contract if ever needed |
| Join/move involving an existing group | Rejected even if currently image-free | Phase3 `media.write` plus catalog authority and trusted image review |
| SKU rename changing gallery-holder ordering | Rejected, including historical equal-creation-time cases | Same Phase3 gate |
| Image/thumb/gallery fields | Rejected | Phase3 owned staging/checksum/image review |
| Any existing-SKU `stockQuantity` key, even a no-op | Rejected | Phase4 `inventory.adjust`, trusted reason and atomic all-writer ledger coverage |

The current engine's single primary scope is not evidence of additional media/inventory authority. Do not enable dependent paths merely by reading raw grant strings inside an adapter.

Order rules are untouched: SUBMITTED quantities reserve stock for48 hours, confirmation deducts and cancellation restores tracked stock, and order/item price/name/currency snapshots remain immutable. Catalog metadata operations do not change reservations or introduce new stock rejection rules.

## Implemented contracts

`03-CATALOG-SAFE-IMPLEMENTED.json` contains the actual four descriptors produced by `createOperationTools`, their closed input/output JSON Schemas and fixed server scope/capability/risk policies. Its clearly synthetic examples show arguments and structuredContent; examples do not represent live IDs, bearer credentials or approvals. A real authenticated RPC `tools/list` regression checks exact schema parity and validates every example. Catalog preview input intentionally has no client revision field.

## Validation scope

Synthetic SQLite/PostgreSQL tests exercise real RPC and first-party approval, create/update/retry, full sibling review, timestamp-stable sibling and option changes, SKU phantoms, category/currency/import/portal races, scope/RBAC/tenant/revocation/configured-shop denial, unsupported paths, metadata byte-read spies, payload/scan caps, history/audit rollback and unchanged stock holds/order snapshots. Existing product/options/import/gallery tests remain compatibility checks. This document does not authorize default registration, production migration/deployment or any external provider action.
