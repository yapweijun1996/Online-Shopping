# Listing rich product detail

Schema 35 adds `listing_detail` and `listing_detail_image`. The existing required
2,000-character description remains the short summary and CSV/MCP text field.
Rich detail is optional, shared by all listing variants, and saved independently.
An empty rich document uses the existing plain description in the storefront.

## API contract

- `GET /api/v1/seller/products/:id/detail` returns
  `{ listingId, revision, document, assets }`.
- `PUT` to the same URL accepts exactly `{ expectedRevision, document }` and
  returns the same complete response after committing.
- `POST /api/v1/seller/products/:id/detail/images` accepts exactly
  `{ imageDataUrl }` and returns `{ id, src, width, height }` for a staged image.
- `GET /api/v1/seller/products/:id/detail/images/:assetId` reads owned staged or
  committed image bytes. Tenant routing adds the current tenant path prefix.
- `DELETE /api/v1/seller/products/:id/detail/images/:assetId` discards only a
  private staged asset. It requires Origin/CSRF and refuses committed assets with
  409 `DETAIL_IMAGE_IN_USE`; committed removal requires document CAS.
- Public `GET /api/v1/products/:id/detail` and `/detail/images/:assetId` require an
  active requested variant. Only referenced, committed images are public. A shared
  image may be fetched through an active sibling, even if its uploader variant is
  now inactive. Staged images are never public.

All seller detail routes require a seller session and `catalog.write`. PUT/POST
also require the configured same origin and session CSRF token. Images are returned
with their validated MIME, nosniff and no-store. There is no remote-image fetch,
arbitrary HTML, SVG, script, iframe, URL, style or executable attribute field.
Text is inert even when it resembles markup; the renderer creates text nodes.

`revision` is an opaque SHA-256 string binding the listing identity, saved sequence
and ordered member IDs. Clients must preserve the string unchanged. The document
and all asset changes commit in one store transaction using the existing common
writer lock and a revision predicate. A stale document or moved membership yields
409 `DETAIL_CHANGED`. Basic product/gallery revisions remain independent: rich
saves update the listing timestamp and append product history metadata, without
changing `product.updated_at` or any basic field, price, stock or activity.

## Document version 1

```json
{
  "version": 1,
  "blocks": [
    { "type": "heading", "text": "Product details" },
    { "type": "paragraph", "text": "Description", "bold": true },
    { "type": "list", "items": ["One", "Two"] },
    { "type": "image", "assetId": "00000000-0000-4000-8000-000000000001", "alt": "Describe the item", "caption": "Optional caption" },
    { "type": "specs", "rows": [{ "label": "Size", "value": "Small" }] }
  ]
}
```

Shapes are strict; unknown attributes and unsupported document versions fail.
Exact storage readiness/startup checks reject missing/altered columns, constraints,
indexes, unexpected triggers and PostgreSQL RLS rather than adopting partial DDL.

Rich detail supports at most 1,000 listing members (a larger listing fails closed).
At most 40 blocks, 20 image blocks and 50,000 text characters are accepted. Paragraphs
are at most 5,000 characters, headings 240, lists/specs at most 30 items/rows, image
alt 500 (nonempty), captions 1,000. A serialized document is capped at 160,000
characters. Bold applies to a paragraph; this release has no arbitrary inline HTML.

## Media lifecycle and limits

Upload uses the existing PNG/JPEG/WebP canonical-base64, byte-size and signature
validator (512 KiB per image), plus encoded-header dimensions: at most 32,768 per
side and 40 million pixels. Dimensions are extracted server-side, not trusted from
client metadata. This is bounded format/header validation, **not full native pixel
decoding or an image safety attestation**. The browser also decodes the upload.

Image UUID ownership is listing-local and enforced on every reference/read. SHA-256
is stored and checked when bytes are served. A successful document save commits
selected staged assets and deletes formerly committed assets no longer referenced.
It leaves other tabs' staged assets alone. Expired (24 hours) stages are denied on
read and removed opportunistically on the next successful upload/save for that
listing. Quota is 40 staged + committed assets, 20 MiB total, allowing replacement
of the full 20-image document before publication. There is no new background timer;
a dormant abandoned listing retains bounded expired bytes until its next write.
Deleting a listing cascades both new tables; demo reset clears both explicitly.
SQLite-to-PostgreSQL import includes both tables and verifies their row digests.

## Variant changes and protected MCP policy

An actual move/split/join involving a listing with nonempty rich detail returns 409
`DETAIL_MEMBERSHIP_CONFLICT`, atomically rolling back the whole product edit. The
seller may retain the group or save a copy and explicitly clear affected rich detail
before regrouping. Unchanged variant-group saves work normally. Creating a new
variant in a rich listing preserves and shares its document, and invalidates any
previously loaded detail revision by changing membership. Automatic copy/merge of
rich documents is deferred; it never silently drops or chooses one document.

Current protected catalog review graphs cover main/gallery assets, not rich-detail
assets. Catalog CREATE into an existing rich listing, catalog UPDATE/review and
media snapshots involving an affected rich listing fail closed with
`CATALOG_RICH_DETAIL_UNSUPPORTED`. The guard runs in preview and current-state
revalidation, including old and target listings. Legacy catalog CREATE revisions
also include detail sequence metadata. Clearing the detail allows a newly prepared
operation. No acknowledgment is manufactured and no new MCP schema/write scope is
added. Seller editing remains available; unrelated inventory/order services remain
unchanged. Full rich-detail MCP review requires a separate explicit graph/approval
coverage change before it can be enabled.

## Migration and release

SQLite migrates 34 to 35 transactionally. PostgreSQL fresh baseline is 35 and the
explicit operator upgrade adds only these tables/index; prior global upgrades still
run before this additive step. Existing inventory and MCP storage schema/DDL hashes
are unchanged; their compatibility guards accept global35. The cleanup runner uses
the global version and must run the matched candidate binary. The old application
expects global34 and refuses35; updating only the application image is insufficient.

The existing `scripts/qa-gcp-mcp-canary.mjs` harness is a historical schema34
canary and does not certify schema35. Schema35 requires the exact published
candidate image to upgrade a restored schema34 clone, rerun idempotently, revert
only empty additive tables and prove the actual old image ready again. The new
protected operator must additionally verify the live full MCP profile and public
health after cutover; changing the old harness version constant is not acceptance.

Release uses the protected GCP runbook, stopped-writer fresh backups, isolated
restore proof and matching backend/codec/controller pins. A no-traffic rollback to
the old binary is possible only after proving the new tables have no rows, dropping
only the two additive tables (image before document) and restoring global metadata
34. This is an operator procedure, not a web/API downgrade endpoint. After any
schema35 document/image writes, preserve35 and recover forward, or use the reviewed
full restore/credential invalidation procedure. Never drop populated rich tables
as an application rollback shortcut.
