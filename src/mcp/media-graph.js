import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { buildMediaManifest, mediaAssetKey } from './media-manifest.js';
const changed = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media resource changed. Reopen its review.'); };

/** Metadata projection only. Caller owns authority, native validation and full revision fences. */
export function mediaSnapshotManifest(toolName, snapshot, after, codecDigest, { assets = [], newBytes = 0 } = {}) {
  const effects = [
    ...snapshot.before.products.map(({ productId, ...before }) => ({ kind: 'PRODUCT', productId, before,
      after: Object.fromEntries(Object.entries(after.products.find(value => value.productId === productId)).filter(([key]) => key !== 'productId')) })),
    ...snapshot.before.listings.map(({ listingId, ...before }) => ({ kind: 'LISTING', listingId, before,
      after: Object.fromEntries(Object.entries(after.listings.find(value => value.listingId === listingId)).filter(([key]) => key !== 'listingId')) })),
  ];
  const used = new Set();
  for (const effect of effects) for (const side of ['before','after']) {
    const state = effect[side];
    if (effect.kind === 'PRODUCT') { if (state.mainAssetKey) used.add(state.mainAssetKey); }
    else for (const key of state.galleryAssetKeys) used.add(key);
  }
  const fields = ['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'];
  const old = snapshot.assets.filter(value => used.has(mediaAssetKey(value.mime, value.byte_sha256)))
    .map(value => Object.fromEntries(fields.map(key => [key, value[key]])));
  return buildMediaManifest({ toolName, graphRevision: snapshot.revision, codecDigest,
    graphBytes: { oldBytes: snapshot.graphReadBytes.oldBytes, newBytes }, assets: [...old,...assets], effects });
}
export function assertMediaGraphAfter(after, manifest) {
  for (const kind of ['PRODUCT','LISTING']) {
    const rows = kind === 'PRODUCT' ? after.before.products : after.before.listings, key = kind === 'PRODUCT' ? 'productId' : 'listingId';
    const expected = manifest.effects.filter(effect => effect.kind === kind);
    if (rows.length !== expected.length) changed();
    for (const row of rows) {
      const effect = expected.find(value => value[key] === row[key]), { [key]: _id, ...state } = row;
      if (!effect || canonicalOperationJson(state) !== canonicalOperationJson(effect.after)) changed();
    }
  }
}
