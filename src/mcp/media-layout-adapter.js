import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { getProduct, prepareProductUpdate, updateProduct, updateProductGallery } from '../products.js';
import { planProductGallery, requireMainImageRemoval } from '../product-gallery.js';
import { trackUpdate } from '../product-history.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { readMediaSnapshot, loadOldMediaAsset } from './media-resources.js';
import { mediaSnapshotManifest, assertMediaGraphAfter } from './media-graph.js';
import { readMediaFrame } from './media-frame-storage.js';
import { isMediaHash, isMediaUuid, mediaObject, validateMediaDescriptor } from './media-policy.js';
import { mediaContext } from './media-storage.js';
const invalid = () => { throw new ApiError(400, 'MEDIA_LAYOUT_INPUT', 'Invalid existing image selection.'); };
const changed = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media resource changed. Reopen its review.'); };
const equal = (left, right) => canonicalOperationJson(left) === canonicalOperationJson(right);
function input(value) {
  if (!value || !['productId','expectedRevision','gallery','removeMain'].every(key => Object.hasOwn(value, key))) invalid();
  try { mediaObject(value, ['productId','expectedRevision','gallery','removeMain']); } catch { invalid(); }
  if (!isMediaUuid(value.productId) || !isMediaHash(value.expectedRevision) || typeof value.removeMain !== 'boolean' ||
      !Array.isArray(value.gallery) || value.gallery.length > 11) invalid();
  for (const item of value.gallery) {
    try { mediaObject(item, ['id']); } catch { invalid(); }
    if (item.id !== 'main' && !isMediaUuid(item.id)) invalid();
  }
  return value;
}
async function planned(reader, args, codecDigest) {
  input(args);
  const snapshot = await readMediaSnapshot(reader, args.productId);
  if (snapshot.revision !== args.expectedRevision) changed();
  const current = await getProduct(reader, args.productId, true), view = snapshot.views.find(value => value.productId === args.productId);
  if (!current || !view) changed();
  if (view.role === 'variant') {
    const visible = view.current.galleryItems.filter(item => !args.removeMain || item.id !== 'main').map(item => item.id);
    const selected = args.gallery.filter(item => !args.removeMain || item.id !== 'main').map(item => item.id);
    if (!equal(selected, visible)) throw new ApiError(409, 'GALLERY_SHARED', 'Edit the shared gallery on its main variant.');
  }
  await prepareProductUpdate(reader, current, args.removeMain ? { imageDataUrl: null } : { name: current.name });
  requireMainImageRemoval(current, args.removeMain ? null : undefined, view.role !== 'variant');
  const plan = await planProductGallery(reader, args.productId, args.gallery, view.current,
    args.removeMain ? { mainImageDataUrl: null } : {});
  const after = structuredClone(snapshot.before);
  if (args.removeMain) after.products.find(value => value.productId === args.productId).mainAssetKey = null;
  if (view.role !== 'variant') {
    const byId = new Map(view.visible.map(value => [value.id, value.assetKey]));
    const own = snapshot.before.products.find(value => value.productId === args.productId).mainAssetKey;
    if (own && !args.removeMain) byId.set('main', own);
    const keys = plan.selected.map(id => { if (!byId.has(id)) invalid(); return byId.get(id); });
    after.listings.find(value => value.listingId === current.listingId).galleryAssetKeys = keys;
  }
  const manifest = mediaSnapshotManifest('media.preview_layout', snapshot, after, codecDigest);
  return { snapshot, current, view, manifest, normalized: { productId: args.productId, expectedRevision: args.expectedRevision,
    gallery: (view.role === 'variant' ? args.gallery : plan.selected.map(id => ({ id }))), removeMain: args.removeMain } };
}
async function plan(reader, args, codecDigest) {
  try { return await planned(reader, args, codecDigest); }
  catch (error) {
    if (error instanceof FieldError) invalid();
    if (error instanceof ApiError && error.status === 404) throw new ApiError(400, 'MEDIA_RESOURCE_NOT_FOUND', 'Media resource not found.');
    throw error;
  }
}
function proposal(value) {
  try { mediaObject(value, ['productId','expectedRevision','gallery','removeMain','product','media']);
    mediaObject(value.product, ['sku','name']); validateMediaDescriptor(value.media, 'media.preview_layout'); } catch { invalid(); }
  input({ productId: value.productId, expectedRevision: value.expectedRevision, gallery: value.gallery, removeMain: value.removeMain });
  if (typeof value.product.sku !== 'string' || value.product.sku.length > 40 || typeof value.product.name !== 'string' || value.product.name.length > 120) invalid();
}
const receipt = value => {
  try { mediaObject(value, ['productId','listingId','revision']); return isMediaUuid(value.productId) && isMediaUuid(value.listingId) && isMediaHash(value.revision); }
  catch { return false; }
};
export function mediaLayoutAdapter(runtime) {
  const hooks = Object.freeze({
    policyId: 'media-layout-v1', codecDigest: runtime.codecDigest,
    async capture(read, args, context) {
      mediaContext(context);
      const prepared = await plan(read, args, runtime.codecDigest), old = [];
      for (const ref of prepared.snapshot.assets) old.push({ ref, bytes: (await loadOldMediaAsset(read, prepared.snapshot, ref)).data });
      return { resourceId: args.productId, expectedRevision: args.expectedRevision,
        resources: { context, revision: prepared.snapshot.revision, old } };
    },
    async resolve(captured, options) {
      const native = runtime.nativeSession(options), sources = [];
      for (const source of captured.old) {
        const decoded = await native.decode(source.bytes, source.ref.mime, source.ref.byte_sha256);
        sources.push({ ...source.ref, width: decoded.width, height: decoded.height });
      }
      return { context: captured.context, revision: captured.revision, codecDigest: runtime.codecDigest, sources };
    },
    async persistResources(_writer, envelope, resolved, context) {
      if (!equal(mediaContext(context), mediaContext(resolved.context)) || envelope.expectedRevision !== resolved.revision ||
          envelope.proposal.media.codecDigest !== runtime.codecDigest || resolved.codecDigest !== runtime.codecDigest) changed();
    },
    async consumeResources() { /* Existing layout has no uploaded stage to consume. */ },
  });
  return Object.freeze({ resourceType: 'product', media: hooks,
    async preview(read, args, resolved, context) {
      if (!equal(mediaContext(context), mediaContext(resolved.context)) || resolved.revision !== args.expectedRevision || resolved.codecDigest !== runtime.codecDigest) changed();
      const prepared = await plan(read, args, runtime.codecDigest);
      if (resolved.sources.length !== prepared.snapshot.assets.length || prepared.snapshot.assets.some(ref => !resolved.sources.some(source =>
        source.source_kind === ref.source_kind && source.source_id === ref.source_id && source.source_product_id === ref.source_product_id &&
        source.byte_sha256 === ref.byte_sha256 && source.mime === ref.mime && source.byte_length === ref.byte_length))) changed();
      return { resourceId: args.productId, expectedRevision: args.expectedRevision,
        proposal: { ...prepared.normalized, product: { sku: prepared.current.sku, name: prepared.current.name } }, mediaManifest: prepared.manifest };
    },
    async currentRevision(read, envelope) {
      proposal(envelope.proposal);
      if (envelope.resourceId !== envelope.proposal.productId || envelope.expectedRevision !== envelope.proposal.expectedRevision) invalid();
      try { return { exists: true, revision: (await readMediaSnapshot(read, envelope.resourceId)).revision }; }
      catch (error) { if (error instanceof ApiError && error.status === 404) return { exists: false, revision: null }; throw error; }
    },
    async apply(store, value, context) {
      proposal(value); const identity = mediaContext(context.mediaContext);
      if (identity.accountId !== context.accountId || identity.clientId !== context.clientId || identity.grantId !== context.grantId) invalid();
      const prepared = await plan(store, { productId: value.productId, expectedRevision: value.expectedRevision,
        gallery: value.gallery, removeMain: value.removeMain }, runtime.codecDigest);
      const retained = await readMediaFrame(store, identity, context.operationId, value.media);
      if (!equal(prepared.manifest.descriptor, retained.descriptor)) changed();
      const actor = await store.get('SELECT username FROM seller_account WHERE id=?', identity.accountId);
      if (!actor) invalid();
      const patch = { gallery: value.gallery, expectedUpdatedAt: prepared.current.updatedAt };
      const result = await trackUpdate(store, value.productId, actor.username, () => value.removeMain
        ? updateProduct(store, value.productId, { ...patch, imageDataUrl: null })
        : updateProductGallery(store, value.productId, patch));
      if (!result) changed();
      const after = await readMediaSnapshot(store, value.productId); assertMediaGraphAfter(after, retained);
      for (const before of prepared.snapshot.products) {
        const actual = after.products.find(item => item.productId === before.productId);
        for (const field of ['productId','listingId','sku','name','category','variantGroup','variantLabel','active','createdAt']) {
          if (!actual || !equal(actual[field], before[field])) changed();
        }
      }
      for (const source of after.sources) {
        const before = prepared.snapshot.sources.find(item => item.source_kind === source.source_kind && item.source_id === source.source_id && item.source_product_id === source.source_product_id);
        if (!before || !equal(before.thumbnail, source.thumbnail)) changed();
      }
      return { productId: result.id, listingId: result.listingId, revision: after.revision };
    },
    validResult: receipt, toReceipt: value => ({ productId: value.productId, listingId: value.listingId, revision: value.revision }), validReceipt: receipt,
  });
}
