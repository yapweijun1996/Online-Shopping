import { ApiError } from '../http.js';
import { readMediaSnapshot } from './media-resources.js';
import { mediaAssetKey } from './media-manifest.js';
import { canonicalOperationJson } from './operation-envelope.js';

/** Bounded current graph metadata only. The caller supplies live media.read authority/fence. */
export async function listMedia(read, { productId, limit = 5, offset = 0 }) {
  let snapshot;
  try { snapshot = await readMediaSnapshot(read, productId); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new ApiError(400, 'MEDIA_RESOURCE_NOT_FOUND', 'Media resource not found.');
    throw error;
  }
  const products = snapshot.products.slice(offset, offset + limit), keys = new Set();
  const items = products.map(product => {
    const view = snapshot.views.find(value => value.productId === product.productId);
    const state = snapshot.before.products.find(value => value.productId === product.productId);
    if (state.mainAssetKey) keys.add(state.mainAssetKey);
    const gallery = view.visible.map(value => { keys.add(value.assetKey); return { id: value.id, assetKey: value.assetKey, shared: value.shared }; });
    return { productId: product.productId, listingId: product.listingId, sku: product.sku, name: product.name, role: view.role,
      holderId: view.holderId, mainAssetKey: state.mainAssetKey, gallery };
  });
  const assets = snapshot.assets.filter(value => keys.has(mediaAssetKey(value.mime, value.byte_sha256))).map(value => ({
    assetKey: mediaAssetKey(value.mime, value.byte_sha256), sha256: value.byte_sha256, mime: value.mime, byteLength: value.byte_length,
  }));
  const dto = { productId, revision: snapshot.revision, membersTotal: snapshot.products.length, items, assets,
    nextOffset: offset + products.length < snapshot.products.length ? offset + products.length : null };
  try { if (Buffer.byteLength(canonicalOperationJson(dto)) > 65536) throw 0; }
  catch { throw new ApiError(503, 'MEDIA_LIST_RESPONSE_LIMIT', 'Media metadata page exceeds its safe limit. Reduce limit.'); }
  return dto;
}
