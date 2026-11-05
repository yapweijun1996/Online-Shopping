# Internal listing lookup and membership projection

This is Batch A2 after the shared-gallery planner extraction. It changes only the business listing service and adds no MCP descriptor, scope, flag, stage, schema, public endpoint or group/media enablement. Existing safe catalog restrictions remain in place.

## Shared service plans

`projectListingFields(current, patch)` copies only supplied `name`, `description` and `category` fields over the current safe record. An omitted field retains its per-member value, including historical drift. Explicitly supplying a value equal to the parent can still normalize divergent member copies. Other keys, including stock, SKU, identity and options, do not become shared updates. The existing `syncListing` uses this same projection to construct its original two SQL updates in the same field order.

`planListingFor(read, fields)` performs the existing group-code lookup and returns `{create, code, listing}`. An existing target supplies authoritative shared text/category; a new target carries `id: null`. Planning never allocates a UUID or writes an unborn product/listing. The existing `listingFor` calls the plan and allocates the actual listing UUID/time only in application.

`planMoveToListing(read, productId, previousListingId, fields)` returns the target plan, prior listing ID, a `deletePrevious` hint, and the target product's projected shared fields/listing ID. If the target listing is new its projected ID remains null. The hint checks for other source members while excluding the moving product. It is informative, not deletion authority. The existing `moveToListing` replans internally, applies the target choice and product shared fields, then repeats its original actual source-membership predicate **after** the product update before deleting an empty old listing. A caller cannot submit a precomputed plan to this service. The existing outer product transaction still owns the fence and rollback.

These helpers accept trusted, normalized internal service inputs. They do not validate user authority or replace `prepareProductCreate`, `prepareProductUpdate`, SKU/category/currency/option validation, media freshness or inventory approval. They read bounded-size target records and an existence predicate, without materializing a whole group or adding a new portal cap. Their SELECT-only interface loads no image/BLOB. They do not predict full source/target membership, roles, media visibility or option transitions; those remain future complete-graph planning work.

## Preserved portal behavior

- Existing target listing shared fields override the moving/joining product's proposed text/category, exactly as before. Shared updates in an unchanged listing propagate only supplied fields.
- Group moves retain the product UUID, creation time, own price and stock. The existing product service continues to clear stale options on leaving/changing groups and enforce active categories, currency, option-type consistency and case-aware label uniqueness.
- Group creation timestamps and gallery-holder SQL ordering remain unchanged. Moving an older member can make it the new holder. Existing target-holder uploads remain physically present even if the new holder changes which gallery is visible; this extraction does not invent image transfers or fix inherited semantics.
- Empty prior listings are deleted only under the original live membership predicate. A new sibling added after an earlier read-only plan means the real service keeps that listing.
- Existing history, product timestamps, inventory evidence and transaction rollback remain owned by the original product/history services. Plans introduce no domain-history or inventory entry.

Synthetic SQLite/PostgreSQL tests compare SELECT-only plans with actual create/update services and complete safe row digests. They cover existing/new/private target lookup with no UUID allocation, target adoption, empty/nonempty source, an intervening new sibling, explicit legacy shared-field drift, parent-equal normalization, older-member holder changes, hidden physical assets, options clearing/collision, category/currency rejection and injected post-delete rollback through the actual history wrapper. SQLite raw rows have a null prototype; tests normalize their container shape when comparing projected values, without changing the store contract.

## Remaining boundary

This is business SSOT groundwork, not full catalog group acceptance. Full two-listing resource capture, complete bounded before/after image graphs, native validation outside locks, stage ownership, source-owned RESERVED dual-scope construction and full human page/asset approval remain B/C prerequisites. A possible separate default-off catalog-media factory flag and server-only preallocated SKU intent are design candidates requiring separate review, not implemented features. Existing stock PATCH stays rejected by catalog and uses its independent inventory approval flow.

Rollback needs no schema migration. Revert the source extraction through review while preserving real committed listing/product/gallery/history/stock state. No production or multi-instance guarantee is made by these local tests.
