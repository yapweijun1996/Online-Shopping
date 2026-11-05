# Internal media resource snapshots

Status: local read/revision helpers based on schema31/gallery/portable source `c0ec064` and the frozen pure policy/manifest dependency. No tool, route, authentication, staging, business write, registry or production enablement is introduced. Business mutations remain existing product/gallery/history services. This is not media-phase, native-image or production acceptance.

## Internal APIs and ownership

`readMediaSnapshot(read, productId)` captures the complete current listing component of an existing product in the already selected tenant store. It accepts no tenant/account/role/SQL/URL/path or store-selection argument. The caller must hold the future coordinator's platform-first lifecycle fence and shared tenant transaction. This helper does not acquire authority or independently promise a concurrent transaction snapshot. It covers one current component, not future group joins/moves across listings; any future combined graph must reapply the schema's global listing/product/effect ceilings.

The frozen result contains target/revision/structureRevision, listing/member identification labels and media relationships, physical `sources`, content-deduplicated manifest `assets`, visible views, a `before` graph and actual `graphReadBytes:{oldBytes,newBytes:0}`. No Buffers, data URLs, currency, price, stock, customer/order/contact/note records are returned. Names/SKUs/category labels are untrusted seller text and may contain personal data; this is not an anonymous-output claim.

Manifest assets use shared `mediaAssetKey` and exact fields `source_kind`, `source_id`, `source_product_id`, `stage_id:null`, `byte_sha256`, `mime`, `byte_length`. PRODUCT_MAIN binds source_id to its owning product ID. GALLERY binds gallery ID AND actual owning product ID. Identical MIME/full-byte SHA shares one representative asset key; all physical owners and thumbnail differences remain in sources/revision. Repeated same-pixel positions stay ordered.

`before.products` contains `{productId,listingId,role,mainAssetKey}`; `before.listings` contains `{listingId,holderId,galleryAssetKeys}`. A coordinator wraps these into effect.before and derives AFTER with existing shared planners. A single product follows actual selected visible order, including main when selected. Shared listing keys contain shared entries only; separate own main may produce eleven visible images alongside ten shared. `galleryRole` and `productGallery` supply roles/order/main dedup; this module does not copy those rules.

Each view supplies a metadata-only `current` shape for `planProductGallery` and `requireMainImageRemoval`. Its `view:` values are opaque identities, not fetchable URLs. `planGalleryImageAddition` retains existing main/variant guards. Those business plans may contain private bytes and must never become MCP proposals. This resource module neither selects a proposed layout nor applies DML.

## Revision and fence policy

The versioned, length-framed revision streams canonical records. It binds membership, created_at/SKU holder order, variant identifiers, raw layouts, active visibility, physical main/gallery MIME/bytes, every thumbnail MIME/byte, gallery ID/position/ownership and all captured human identification labels (name/SKU/category code/label/listing labels). A human-review implementation must use captured labels or a verified matching revision, never unrelated unhashed current labels as approved snapshot data.

Stock, prices, currency, product updated_at, orders and notes are excluded. Actual order confirmation changes stock/updated_at without invalidating a media-only revision. Thumbnail setters can leave updated_at unchanged; changed main/gallery thumbnails still invalidate content revision. This fence does not replace a catalog revision for future combined catalog/media changes.

## Bounds before bytes

Limits derive from `media-schema.MEDIA_LIMITS`. SQL product count, aggregate metadata lengths and COUNT/SUM actual full/thumbnail lengths run before BLOB transfer to JavaScript. Duplicate physical copies count toward16MiB old-read bytes. Each full image is1–512KiB and thumbnail1–80KiB with supported MIME/null pairs; mainless orphan thumbnails and unsupported stored state reject.

At most300 products with ten stored gallery rows each bound physical sources to3300. The512 limit counts effects, not physical copies. After the physical gate, exactly one full OR thumbnail BLOB column/row is loaded per query, sequentially hashed, and released from the result graph. Distinct MIME/full-byte SHA keys stop at32; this content check follows bounded hashing and never returns a partial graph.

Both raw and private derived metadata are bounded by records×pageBytes (8MiB). This accommodates all3300 ownership identities without incorrectly applying the public manifest's16×16KiB/512-record transport ceiling to a private snapshot. The snapshot is not a public MCP DTO; a coordinator must project/paginate its immutable manifest under those unchanged public bounds. Exact300-member and3300-physical-copy fixtures verify the distinction.

Saved static refs, non-UUID gallery IDs, duplicate/unknown layout IDs and unsupported legacy states fail closed. This does not tighten portal behavior or fetch demo files/URLs. Existing signature/base64/size validators check current MIME/bytes; no full native decode is claimed. Legacy width/height remain null and dimensionsVerified false. Thumbnail hash binds state, not proof it derives from the full image. Future native validation/review must verify full pixels and derived thumbnails through its trusted codec.

## Explicit private byte loading

`loadOldMediaAsset(read, snapshot, expectedRef, {thumbnail?})` returns private bytes through this explicit internal call only. expectedRef must exactly match a captured seven-field source; a URL or SHA alone is insufficient. Extra/malformed refs, source-product substitutions, unrelated IDs and replayed old SHA deny, even if another product has identical pixels.

The loader rechecks bounded structural membership/holder/labels/layout/lengths, then queries exact source ID/product ID/expected length, validates current MIME and requested full/thumbnail SHA. A source growing after preflight cannot pass the length predicate. It neither selects a tenant nor authorizes a user.

It checks requested bytes and structure, not every other image's hash on each call. The future coordinator must separately revalidate the complete content revision and grant/consent/RBAC/epoch/build/lease/pin/human evidence under its fence. Old trusted metadata is not authority to serve a picture or commit. No HTTP delivery, ACK, approval or fallback is introduced.

Controlled failures:404 MEDIA_RESOURCE_NOT_FOUND,409 MEDIA_RESOURCE_UNSUPPORTED / MEDIA_RESOURCE_CHANGED,503 MEDIA_RESOURCE_LIMIT. No partial successful snapshot or substituted image is returned.

## Evidence and remaining acceptance

Synthetic SQLite/PostgreSQL tests use actual product/gallery/thumbnail/order services and a SELECT-only facade, comparing full database digests and ensuring one bounded BLOB query at a time. Cases cover single/holder/variant10+own11, composition with shared planning and actual portal reorder, actual stock confirmation, timestamp-stable thumbnails, same-length full-image replay denial, SKU holder/membership/label changes, source ownership, missing/static/legacy state, metadata/full/thumbnail/physical-total byte bounds before loading, exactly300 members/3300 physical copies/32 content keys and33-key rejection.

This does not establish native decode, new staging authority, quota/lease/pin, multi-scope authentication, image delivery/ACK/approval, atomic commit or production capacity. Those remain coordinator/protocol acceptance. Reverting these unregistered helpers/docs/tests requires no schema or business-state rollback; existing legitimate business changes are not undone by removing a helper.
