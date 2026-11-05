# Private existing-product UPDATE state

This foundation registers no adapter/tool and changes no policy, engine, flag,
schema, UI or business writer. It allocates no identity, decodes no image, writes
no draft, and grants no approval. CREATE remains separate.

`prepareCatalogMediaUpdate(read,{productId,changes})` accepts a closed metadata
PATCH, excluding stock/media/identity/authority fields. C1b count/byte preflight
precedes complete source/target text and option reads. Captured real product rows
provide the existing DTO for shared `prepareProductUpdate`, unique-SKU validation
and `prepareProductOptionsAfter`; `getProduct` and its gallery loads are avoided.
The shared normalizer also reads company settings for currency; a64KiB byte
preflight bounds that existing read, and unrelated seller text is never returned.

Shared preparation retains leave-null, KEEP, strict group clearing, provisional
label collisions, current inactive-choice grandfathering and stored Unicode.
Derived after labels and choices are review data, never copied over omitted
PATCH keys. Option pairs use a canonical set order, not storefront axis order.
`planMoveToListing` and `projectListingFields` preserve actual shared effects:
existing-target moves adopt target listing fields, while no-move updates propagate
only supplied shared keys to all source members. Omitted legacy drift stays intact.

The complete private `catalog` retains all source/target product and listing
before/after metadata. `review` includes the target and every actually changed
member, each with complete metadata and option labels/codes/active state, plus
changed/new/deleted listing metadata. It does not truncate affected members.
Unknown commit-time `updatedAt` is omitted from projected review; its current
source value and stock remain conservatively bound by the catalog revision.
Stock is shown unchanged and cannot be patched here.

The metadata-only result signals `needsPlannedIdentity`. A future trusted capture
generates a UUID only when needed, then invokes
`readCatalogMediaUpdateState(read,{productId,changes,plannedIdentity})`. The exact
C1a context is required only for a new/private listing and must match actual
product/source/code. Occupied IDs reject before BLOB transfer. No ghost row,
adoption fallback or model-selected identity is introduced.

Complete state rechecks catalog rows, selectors and uniqueness predicates before
BLOB reads, then composes C1b/B1, current BeforeGraph and B2 projection. Mixed
rows and outside-listing SKU/label phantoms deny409. The returned `baseRevision`
is the existing composite, not the final C2a labels/views-bound SHA. Private B2
null IDs/aliases stay intact; catalog after metadata separately binds the exact
identity. The sole C2a assembler must translate these and compute the final SHA.

Independent limits are C1b metadata8MiB, private catalog8MiB, complete changed
review48KiB, and existing B1/B2 media metadata/16MiB physical bounds. Canonical
per-record sizing/equality avoids raising the existing global proposal cap.
Oversized complete review fails503 `CATALOG_REVIEW_TOO_LARGE`; a later adapter
must also bound its entire proposal including labels and descriptor. These are
not a combined8MiB claim or a larger upload allowance.

Callers retain lifecycle-before-tenant fences and recapture after unlocked native
work. Hashes/plans confer no authority. Tests compare real ordinary/planned
product/history services with metadata, full physical graph/visible associations,
copied-main aliases/thumbs, source deletion, shared drift, options, Unicode,
identity occupation, budgets, intervening mutations and atomic rollback. Direct
service evidence is not OAuth, human/native acceptance or C activation. Removing
this unused helper requires no migration or reversal of committed business state.
