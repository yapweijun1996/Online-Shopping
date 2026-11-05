# Internal catalog media projection

This Batch B2 module is read-only groundwork for existing-product group moves, leaving a group and SKU-driven holder changes. It registers no tool and changes no policy, engine, native codec, manifest schema, identity allocator, staging flow, default registration or business writer. Full catalog/media acceptance and production activation remain separate.

## Trusted inputs and exact components

`projectCatalogMediaMove(read, snapshot, {productId, targetPlan, patch})` accepts a current B1 media snapshot and a server-normalized metadata PATCH. Existing shared product validation verifies normalization; database category/currency/options/SKU rules remain the business preparation service's responsibility. Catalog stock/image/gallery fields and replacement identity/authority keys are rejected. No full after-object is copied into a business write.

For unchanged group membership, including an ungrouped SKU-only edit, `targetPlan` must be null. The actual target is the product's existing source listing. For a group change, `targetPlan` is the current A2 listing choice `{create, code, listing:{id,name,description,category}}`; the helper repeats its lookup using the actual product and normalized group, and requires exact agreement. A new listing remains `id:null`. Current source/target text lengths are checked before complete text transfer; unsupported legacy metadata can therefore be denied in this internal channel while portal behavior stays unchanged.

The snapshot must contain **exactly** the actual source and necessary existing target: one component for unchanged membership or a new/private target; two only when an existing target differs from source. Source comes from the actual product row. Extra unrelated components, missing target members, wrong snapshot version/capture, a forged source or target choice and another product's snapshot deny. This is not a store/tenant selector or user authorization mechanism.

## Real database ordering

`readProjectedListingOrder(read, snapshot, {productId,targetListingId,sku})` uses parameterized SQL CASE expressions over actual rows. It projects the one product's listing/SKU and orders by projected listing, original `created_at`, projected SKU and ID. An explicit null-last expression makes new/private grouping order consistent on both databases. Holder selection consumes these database-ordered IDs through the shared kernel; there is no JavaScript member sort, fake SQL reader, speculative row insertion, savepoint or rollback preview.

Every returned current ID/listing/SKU/creation-time tuple must match the captured member set. A new/lost member, duplicate tuple, changed SKU/creation time or different current source denies. Reads are capped at 301 rows to fail closed above the joint 300-product ceiling. Existing listing indexes serve the scoped filter; unrelated catalog rows are excluded.

The caller still owns platform-first lifecycle and tenant transaction fences. Tuple checks are defensive consistency checks, not a substitute for a complete current catalog/media revision or commit authorization.

## Private result and identities

The frozen metadata result contains `mediaRevision`, captured `before`, complete surviving `after.products/listings`, `removedListingIds`, descriptive `physicalEffects`, `bindings`, before/after physical-byte totals and `catalogDependencies`. Existing product IDs remain fixed. Exactly one new/private listing can appear as `listingId:null`; its holder is null because only the existing moving product enters it. Deleted old listings are explicit in `removedListingIds` and absent from the surviving after graph.

`COPY_MAIN` binds the exact captured seven-field PRODUCT_MAIN source, thumbnail MIME/length/SHA, owner, deterministic private alias and actual next position. `SET_LAYOUT` lists existing references and that alias. Positions outside 1–10 deny. Aliases and null IDs are private descriptions, not valid UUID manifest records or accepted write commands. Only a separately reviewed trusted C identity binder can replace null with a server-preallocated UUID; the real business service must replan and perform actual writes, then compare the real graph and content under its writer fence.

`afterViews` is a separate **private**, closed metadata projection: `{productId,role,holderId,visible:[{id,assetKey,shared}]}`. It has at most 300 products and eleven visible entries per product, with no URL, binary or authority fields. Before views remain available in the immutable B1 `snapshot.views`. Future C must hash-bind and show the actual before/after visible effects to the human; checking this private result while omitting it from review is insufficient. This batch does not alter the current manifest format to carry views.

## Preserved gallery behavior

Only an actual normalized group change invokes target sharing conversion. SKU-only holder changes do not copy the new holder's main. Source shrink never automatically converts or transfers its gallery. Source/target hidden physical uploads remain present and bound.

The four shared gallery kernels implement holder, implicit/explicit layout, sharing conversion and own/shared visible order. Own-main suppression compares captured full-byte SHA against **all** physical uploads of the projected holder, including unselected ones, as the existing portal SQL compares bytes. It does not compare MIME-plus-SHA asset keys. Distinct old IDs with equal pixels retain their ordered associations; ten shared images plus a distinct own main can still show eleven. Unsupported duplicate saved IDs remain subject to the existing B1 gate.

An old main copy retains its source MIME, bytes and thumbnail metadata. The projected after budget includes every hidden physical full image/thumbnail plus any new copy. At most two listings, 300 products, 3,300 physical sources and 16 MiB old physical bytes still apply; copying old content does not gain a new-upload allowance. Metadata and private result bounds remain separate from public manifest/page/schema limits. Over-budget or unsafe after states deny before a proposal could be approved.

The B1 media fence excludes price/currency/description/options and unrelated stock changes. `catalogDependencies` preserves normalized intent and the current listing choice for later binding; it is **not** a complete catalog revision. C must separately capture and bind all source/target catalog records, dictionaries, uniqueness predicates, normalized after fields and identification labels. Neither the B1 snapshot's budget nor this private result's 8 MiB ceiling proves a combined C-metadata-plus-media 8 MiB bound; that composition requires its own cumulative preflight.

## Verification and limits

Synthetic SQLite/PostgreSQL tests compare predictions with actual `updateProduct`/history writes and fresh B1 captures, including private IDs bound only after real application. They compare every role, visible ID/order/content key, copy owner/position/full/thumbnail SHA, all old physical identities and total after bytes. Cases cover older-member moves, source empty/shrink, private leave, target adoption, SKU ties/holder changes without conversion, twins, full-ten fallback, duplicate-content associations, hidden own-main suppression, own eleven, illegal positions, source-field forgery and domain rollback.

A boundary fixture shows the copy's full bytes alone fit while its thumbnail makes the after total exceed 16 MiB by one byte. Actual two-connection interleavings commit SKU or membership changes before the real CASE query; stale projection rejects with no primary write. These unfenced defensive tests do not prove coordinated multi-instance production behavior. A real query-plan fixture includes 1,000 unrelated products. Category/currency validation remains shared and is tested before projection.

Legacy identical bytes declared under a different MIME are rejected by the actual B1 signature gate. Earlier pure-kernel/portal tests preserve inherited raw-byte equality; this projector does not fake a valid B1 capture or relax signature/native requirements to demonstrate that legacy case.

The module returns metadata only, performs SELECTs only and does not grant approval, invoke native validation, stage resources or apply any `physicalEffects`. Roll back by removing/reverting this unregistered helper through review; no migration or reversal of committed business state is required. Full authority, complete human image review, catalog/media orchestration and production rollout remain C or later acceptance.
