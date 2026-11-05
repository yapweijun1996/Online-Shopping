# Shared gallery metadata kernels

This is the reviewed pure boundary of Batch B2, after Batch B1 union capture. It extracts four small helpers in the business gallery service. It does not implement a membership projector, SQL CASE ordering, MCP policy, native validation, trusted image review, tool/default activation or any migration.

| Helper | Trusted input and exact responsibility |
| --- | --- |
| `galleryHolderFromOrderedMembers(rows)` | Rows already ordered by the actual database's `created_at, sku, id`; returns the first ID only when there are at least two members. It does not sort. |
| `galleryLayoutIds(saved, hasMain, uploadIds, implicitReferenceIds=[])` | Explicit saved selection passes through unchanged. Null selection derives main, then implicit references, then uploads in supplied order. |
| `sharedGalleryItems(ownMain, shared, sameAsShared)` | Suppresses the own main only on the supplied equality fact, then preserves shared order and marks shared items. |
| `planSharedGallerySelection({holderId, layout, mainSha256, uploads})` | The previous sharing-selection algorithm using metadata `{id, byteSha256}` uploads. Returns `{holderId, selected, pendingRef, writeLayout}`. No bytes, UUID/time/position allocation or authority. |

The actual services call these same kernels. Holder SQL is unchanged. The real `productGallery` still uses its original SQL byte-equality predicate against **all physical uploads** on the holder, including hidden/unselected images. Equality ignores MIME. A future projector must compare captured full-byte SHA for this fact; a MIME-plus-SHA asset key would change inherited behavior. The kernel does not validate MIME or grant permission to use a legacy asset.

The static/demo reference discovery, known-reference resolution, URL rendering and public/private behavior remain their original code. Only the null/explicit ID selection expressions and own/shared composition call the pure helpers. Repeated explicit associations retain their identity and order; a distinct own main plus ten shared images still displays eleven. No whole portal rendering rewrite or fake projected SQL facade is introduced.

`planListingGallerySharing` retains its original SQL reads and private binary return shape. It computes hashes only when main mapping is needed; an explicit no-main layout does not newly access every upload's data to hash it. The metadata kernel chooses the same main twin, deterministic alias, first-selection dedup and full-ten fallback. The wrapper attaches original bytes/thumbnail/MIME and reads the same maximum position only if a copy is needed. Existing `shareListingGallery` application remains unchanged and allocates actual UUID/time inside its caller's transaction.

Inputs are server-owned internal facts. These pure functions do not check authorization, snapshot freshness, image validity, total resource budgets or closed client arguments. Batch B1 provides bounded current captures; later membership projection and coordinator/approval must separately preserve those boundaries. Pending aliases are not persisted gallery UUIDs and must not become caller authority.

Synthetic SQLite/PostgreSQL tests compare pure metadata results with actual SQL planners and real business application, with whole database digests before/after planning. They cover main copy/twin/full-ten/explicit no-main/alias collision, no new no-main byte hashing, hidden all-upload equality, unequal MIME with identical legacy bytes, repeated associations, static main/reference/upload order and real SQL holder changes. The unequal-MIME fixture deliberately represents legacy signature-inconsistent storage: preserving portal byte equality is not acceptance by the stricter resource/native-validation layer.

The no-hash test instruments property access on rows returned by the real SQL query; it does not fake a database response or construct hypothetical membership. Both databases also execute genuine seller password login and actual `Request` → `createApi` product create/upload/group-join/gallery-reorder requests, preserving CSRF rejection and stock evidence. Existing gallery/static/demo/product/import/options and media-resource regressions remain required.

Source rollback needs no data migration. Retain real committed media/history/inventory state. This extraction is not full catalog group or production acceptance; SQL CASE projection, new/private listing IDs, after-state aliases, full image approval and reserved dual-scope wiring require separate review.
