# Pure media policy and manifest metadata

These modules describe/check metadata only. They register no tools, access no store,
read no configuration and grant no authority. Fixtures containing IDs/hashes are
not proof of actual bytes, ownership, consent or human approval.

`mediaPolicyForTool` fixes HIGH risk and catalog.write capability. Upload and layout
mutation pairs require media.write; catalog-media requires catalog.write AND
media.write and is RESERVED. This is not the ordinary catalog policy selector.
Legacy catalog/company null markers retain existing handling. Direct media cannot
hide behind a null marker. No caller scope/risk/capability overrides are accepted.

`makeMediaDescriptor(toolName,input)` derives policyId from the fixed tool family.
Input has exactly manifestRoot,graphRevision,codecDigest,pageCount,assetCount,
effectCount. Output adds policyId, matching MEDIA_POLICY_DESCRIPTOR_FIELDS from
schema31. `mediaDescriptorHash` hashes canonicalOperationJson of those seven fields,
exactly the storage helper preimage. No new envelope version. `makeMediaPolicyRow`
emits exact snake_case schema31 fields from preview tool/context/descriptor; times
are the approved ten minutes. `validateRetainedMediaPolicy` checks the row against
operation marker/tool/base scope/capability/risk/identity/times/hash, optionally its
proposal descriptor. Retained checks can run after proposal/pixels have been scrubbed.
Reserved metadata may be described here; actual storage writing still rejects it.

`buildMediaManifest` accepts a closed object:

```js
{
  toolName: 'media.prepare_upload', graphRevision: '<SHA256>', codecDigest: '<SHA256>',
  graphBytes: { oldBytes: 100, newBytes: 200 },
  assets: [{ source_kind: 'PRODUCT_MAIN', source_id: '<product UUID>',
    source_product_id: '<product UUID>', stage_id: null,
    byte_sha256: '<SHA256>', mime: 'image/png', byte_length: 100 }],
  effects: [
    { kind: 'PRODUCT', productId: '<UUID>',
      before: { listingId: '<UUID>', role: 'single', mainAssetKey: '<SHA256 or null>' },
      after: { listingId: '<UUID>', role: 'single', mainAssetKey: '<SHA256 or null>' } },
    { kind: 'LISTING', listingId: '<UUID>',
      before: { holderId: null, galleryAssetKeys: ['<ordered SHA256>'] },
      after: { holderId: null, galleryAssetKeys: ['<ordered SHA256>'] } }
  ]
}
```

The example shows shape, not a valid complete graph. Assets allow only PRODUCT_MAIN,
GALLERY or STAGE. Main source_id equals product; stage_id equals stage source_id.
No URLs/paths/raw bytes/thumbs/authority fields; UUID source IDs only. Every source
owner must exist before, preserving existing-product-only staging. Asset key is
`mediaAssetKey(mime,byteSha256)` = SHA256(canonical{mime,byteSha256}). Equal image
bytes/MIME deduplicate once with deterministic DB-source preference; all new stage
refs remain hashed in page metadata and returned in stages. Conflicting source/
stage identity or size rejects. A stage cannot supply another product's main or
another holder's gallery; a holder's gallery can affect many variants.

Membership comes from product states, checked against listing holder/role states.
Unknown refs, duplicate effects, missing members and inconsistent roles reject.
Direct media cannot change membership/holder. Reserved catalog can describe movement
without activating a flow. Gallery order remains meaningful; repeated pixel keys
can preserve distinct legacy associations. Ten shared plus distinct own main gives
eleven visible. Full physical association IDs remain bound by resource revision and
the eventual normalized business proposal; this pixel manifest does not replace them.

The trusted snapshot computes actual graphBytes including thumbnails before loading
images. This module checks declared caps and known-asset lower bounds, not their
physical truth. MEDIA_LIMITS supplies300products,2listings,32old/10new/42total assets,
512records,16pages x32records/16KiB,16MiB old/8MiB new/24MiB graph. No truncation.
Existing canonical depth16/node4096/64KiB checks apply per record/page/root, rather
than imposing the envelope limit on the entire paged graph. Source/role slot/no-op
business semantics still come from the shared gallery planner, not this validator.

Assets sort by key, then LISTING/PRODUCT effects sort by UUID. Pages contain version1,
toolName,graphRevision,codecDigest,graphBytes,pageIndex and records. Root hashes fixed
global metadata and ordered page hash/index/count tuples plus asset/effect counts.
Before/after-needed flags are derived. Input entity ordering does not change root;
gallery position order does. A single asset/pin may appear in many effects.

`mediaManifestRows(manifest,context)` revalidates the metadata and returns only
{policy,pages,assets}, with exact SQL names/operation_id/created_at. `readMediaManifest`
checks canonical ordered rows, contiguous pages, exact counts/hashes/context,
recomputed graph/root and all asset refs. Duplicate/noncanonical JSON and reordered,
missing/extra/tampered rows reject. SQL queries must ORDER BY page_index/asset_key.
The returned stages list is metadata for future one-use pins; it performs no binding.
Policy-only replay uses its validator after pages are deleted, not the frame reader.

Future coordinator must separately verify live token/grant/full scopes and explicit
consent, RBAC/account version, ACTIVE tenant/production shop, epoch/build/codec,
complete actual content revision, decoded bytes and stage ownership/TTL, actual
old/new first-party image review, and source-derived normalized business effects.
Release all platform/store locks for codec CPU. Reuse existing business/history
services and atomically consume approval/stage/audit. Never serialize planner byte
Maps or treat a valid metadata hash as approval. This batch has no DB/native decoder,
API registration, authorization fallback or production activation.
