# Read-only shared-gallery conversion plan

This Batch A business-service extraction is based on `be3f7db`. It adds no MCP tool, policy activation, migration, staged upload or authority. Reserved catalog/media flow remains disabled. It does not predict group membership changes yet.

`planListingGallerySharing(read, listingId)` reads the existing holder and its physical gallery. It returns null for a listing without a shared holder; otherwise its private result is `{holderId, selected, pending, writeLayout}`. `selected` preserves existing references and exact legacy selection order. `pending` is null or an internal main-copy record with binary bytes, thumbnail, MIME, position and a deterministic `shared-main:sha256:<digest>` reference. A deterministic suffix avoids collision with legacy references. These are private plans, not transport or approval DTOs.

The portal's existing `shareListingGallery` calls this same planner and then performs its original writes. Only application allocates a random UUID and actual creation timestamp. Its caller still owns the surrounding transaction. A future caller must replan under the actual writer fence; a plan is neither authorization nor a reusable write token. No speculative insert, savepoint or rollback preview is used.

Inherited behavior remains exact:

- Holder selection uses the existing SQL order `created_at, sku, id`, and requires at least two listing members.
- A null layout derives main plus uploaded references. If no main occurs, only a previously null layout is initialized; an explicit legacy layout remains untouched, including repeated or stale references.
- When main occurs, an existing byte-identical upload replaces it. Otherwise the main is copied only when there are fewer than ten physical uploads. A full ten-upload gallery does not receive an eleventh physical copy; main is removed from its shared layout.
- Main mapping deduplicates references in first-selection order exactly as before. Old IDs, bytes, thumbnails, creation times and positions remain unchanged. The new main copy preserves the holder thumbnail.
- This conversion changes no product timestamp, stock or history itself. Existing outer create/update services retain their own timestamps, validation, inventory and history behavior.
- A variant's distinct own main remains separate from the shared gallery, so ten shared images can still yield eleven visible images.

Synthetic SQLite/PostgreSQL tests put the planner behind a SELECT-only facade, compare complete product/listing/gallery/history/inventory row digests before and after planning, then compare the plan with the actual service's IDs/content/order. Cases include main twins, a full ten-upload gallery, no main, explicit legacy layout, deterministic alias collision, singleton no-op, idempotence, preserved thumbnails and actual `createProduct` sharing. An insertion fault after real SQL proves the caller's transaction rolls back the new product, stock evidence and gallery together. No production or future group-expansion acceptance follows from these tests.

Source rollback needs no data migration; retain already committed real gallery state and evidence. The later membership projection and complete catalog/media revision, native validation and human approval remain separate batches.
