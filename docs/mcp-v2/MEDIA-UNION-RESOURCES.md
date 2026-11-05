# Internal two-listing media snapshots

Batch B1 adds read-only union capture and exact private byte loading. It introduces no MCP descriptor, policy activation, native decoding, stage, engine guard, default registration, migration or business write. Reserved catalog/media operations remain disabled. Membership projection is a separate Batch B2.

## Internal API and compatibility

`readMediaUnionSnapshot(read, productId, {targetListingId: null | UUID} = {})` captures the existing product's actual source listing plus an optional existing target listing. The source listing is always derived from the actual product row. The optional target is trusted internal output from the listing planner, not user authority or a tenant/store selector. The caller already holds the platform-first lifecycle fence and shared tenant transaction. No independent concurrent-snapshot or authorization guarantee is added.

Both wrappers use one collector and one content-hashing/projection core. `readMediaSnapshot(read, productId)` retains version 1, its exact result shape and length-framed revision records. Union calls without another target, or with the same listing, return that same version-1 result. Fixed synthetic golden revisions captured before this refactor are verified on both databases; existing media operations do not receive an unnecessary revision-format change.

A genuine two-listing result has version 2 and adds:

```js
capture: {
  sourceListingId: "actual-source-listing-uuid",
  listingIds: ["sorted-existing-listing-uuid-1", "sorted-existing-listing-uuid-2"]
}
```

The selector is frozen and included in both structural and complete content revisions. Products, galleries and physical sources use their original deterministic ordering; each listing's holder/visible selection still comes from actual `galleryRole` / `productGallery`. No projected SQL facade or hypothetical membership is used.

## Joint budgets before bytes

The collector executes joint counts and UTF-8/physical byte sums over the two listing IDs before any BLOB transfer. The existing `MEDIA_LIMITS` remain unchanged:

- At most two existing listings and 300 products **in total**, not per listing.
- At most 16 MiB old physical full-image and thumbnail bytes, including duplicate copies, hidden nonholder uploads and unselected images. A shared content key does not discount actual read bytes.
- At most 3,300 physical sources from the existing per-product ten-gallery bound. The 512 effect-record budget remains distinct from physical-reference count.
- Raw and derived private metadata retain the existing 8 MiB ceiling.
- Each full image is at most 512 KiB and each thumbnail at most 80 KiB. The existing MIME/null/layout/identity checks run before byte loading.
- Full images and thumbnails load sequentially as exactly one bounded BLOB column/row at a time. At most 32 distinct `{MIME, full-byte SHA}` keys are accepted across the union; the 33rd stops hashing without returning a partial snapshot.

Parameterized `listing_id IN (?,?)` queries reuse existing listing indexes. Source budgets exclude unrelated listings. The union is not two independently budgeted snapshots joined after hashing.

The complete SHA binds every physical owner, raw relationship/layout/position, holder order, human identification label and main/thumbnail content digest, including assets that are currently invisible. Content-deduplicated manifest candidates remain separate from those full physical identities. Stock, prices, currency, product `updated_at`, customer/order fields and notes remain outside this media-only fence, exactly as before. A future combined catalog operation still needs its independent complete catalog metadata revision.

## Exact old-asset loading

`loadOldMediaAsset` accepts both frozen snapshot versions. For version 2 it validates the exact captured selector, rederives the product's current source listing and collects the same union under joint budgets. Source membership, target disappearance, labels, layouts or structural changes deny before byte loading. It then checks the requested captured physical source ID **and** owning product, exact metadata/length, current MIME/signature and requested full/thumbnail SHA. Identical pixels elsewhere do not authorize substituting a different physical reference.

Private loader output contains bytes only for this explicit internal call. It does not expose a URL, select a tenant or grant permission. As before, one load checks the requested bytes and complete structure, not every other asset's current SHA. The eventual coordinator must separately recheck the complete content revision and current scope/grant/account/epoch/build/review evidence before using the graph. Hashing is not native pixel validation; dimensions remain null/unverified.

## Controlled boundaries

Malformed target options, static/unknown legacy layouts, unsupported identities and unsafe source state fail closed. Missing product/target is a controlled 404; structural/ownership/content changes are controlled 409; budget excess is controlled 503. No partial success or repair is returned.

An additional target listing with zero members currently returns `409 MEDIA_RESOURCE_UNSUPPORTED` during metadata collection, before BLOB reads. The current manifest graph rejects a non-null listing with no members; this batch does not fabricate one or reinterpret an empty physical listing as a created/deleted logical graph. New/private targets use no existing target ID at this layer; their future projection and trusted identity allocation remain B2/C design work.

## Evidence and rollback

Synthetic SQLite/PostgreSQL tests use actual product, gallery, thumbnail and order-decision services with a SELECT-only boundary and complete database digests. Cases cover fixed version-1 golden compatibility; joint exact-300/301, 16-MiB-plus-thumbnail, 32/33-content and metadata budgets; hidden references; sequential byte reads; exact loaders and source substitution; timestamp-stable thumbnails; same-length content changes; labels/SKU holder/membership staleness; actual stock confirmation remaining outside the media fence; malformed/empty/static/missing targets; and real query plans with 1,000 unrelated products.

This is no claim of native validation, human image approval, union commit orchestration, production capacity or full catalog group support. No full-suite result is implied by the focused tests. Source rollback needs no migration; preserve already committed real business state and evidence. Default callers continue using the compatible single-listing wrapper until a separately reviewed implementation selects the union helper.
