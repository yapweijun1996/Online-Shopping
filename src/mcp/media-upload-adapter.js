import { ApiError } from '../http.js';
import { updateProduct, addGalleryImage, planGalleryImageAddition } from '../products.js';
import { planProductGallery, prepareGalleryUploadEntry } from '../product-gallery.js';
import { trackUpdate } from '../product-history.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { mediaContext, mediaHash, withMediaWriter } from './media-storage.js';
import { readMediaSnapshot } from './media-resources.js';
import { readMediaFrame } from './media-frame-storage.js';
import { buildMediaManifest, mediaAssetKey } from './media-manifest.js';
import { isMediaHash, isMediaUuid, mediaObject, validateMediaDescriptor } from './media-policy.js';

const changed = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media resource changed. Reopen its review.'); };
const invalid = () => { throw new TypeError('Invalid stored media upload.'); };
const dataUrl = (mime, data) => 'data:' + mime + ';base64,' + Buffer.from(data).toString('base64');
const sourceFields = ['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'];

async function plan(read, stage, result) {
  const snapshot = await readMediaSnapshot(read, stage.productId);
  if (snapshot.revision !== stage.expectedRevision || result.codecDigest !== stage.codecDigest ||
      result.sourceSha256 !== stage.sourceSha256 || result.mime !== stage.sourceMime) changed();
  const target = snapshot.before.products.find(value => value.productId === stage.productId);
  const view = snapshot.views.find(value => value.productId === stage.productId);
  const product = snapshot.products.find(value => value.productId === stage.productId);
  if (!target || !view || !product) changed();
  const asset = { source_kind: 'STAGE', source_id: stage.stageId, source_product_id: stage.productId, stage_id: stage.stageId,
    byte_sha256: mediaHash(result.image), mime: result.mime, byte_length: result.image.length };
  const key = mediaAssetKey(asset.mime, asset.byte_sha256), after = structuredClone(snapshot.before);
  const mainUrl = dataUrl(result.mime, result.image), thumbUrl = dataUrl('image/png', result.thumbnail);
  let galleryPlan;
  if (stage.targetSlot === 'GALLERY') {
    // Reuse the complete portal guard, current gallery selection and duplicate handling.
    galleryPlan = (await planGalleryImageAddition(read, stage.productId, prepareGalleryUploadEntry(mainUrl, thumbUrl))).plan;
  } else if (stage.targetSlot === 'MAIN') {
    after.products.find(value => value.productId === stage.productId).mainAssetKey = key;
    if (view.role === 'single') {
      const requested = view.current.galleryItems.map(({ id }) => ({ id }));
      if (product.layout === null && !requested.some(value => value.id === 'main')) requested.unshift({ id: 'main' });
      galleryPlan = await planProductGallery(read, stage.productId, requested, view.current, { mainImageDataUrl: mainUrl });
    }
  } else invalid();
  if (galleryPlan) {
    const keys = new Map(snapshot.galleries.filter(value => value.productId === stage.productId).map(value => [value.galleryId,
      snapshot.sources.find(source => source.source_kind === 'GALLERY' && source.source_id === value.galleryId && source.source_product_id === stage.productId).assetKey]));
    keys.set('main', stage.targetSlot === 'MAIN' ? key : target.mainAssetKey);
    for (const [id, image] of galleryPlan.pending) keys.set(id, mediaAssetKey(image.mime, mediaHash(image.data)));
    const selected = galleryPlan.selected.map(id => { if (!keys.has(id)) invalid(); return keys.get(id); });
    after.listings.find(value => value.listingId === target.listingId).galleryAssetKeys = selected;
  }
  const effects = [
    ...snapshot.before.products.map(({ productId, ...before }) => ({ kind: 'PRODUCT', productId, before,
      after: Object.fromEntries(Object.entries(after.products.find(value => value.productId === productId)).filter(([field]) => field !== 'productId')) })),
    ...snapshot.before.listings.map(({ listingId, ...before }) => ({ kind: 'LISTING', listingId, before,
      after: Object.fromEntries(Object.entries(after.listings.find(value => value.listingId === listingId)).filter(([field]) => field !== 'listingId')) })),
  ];
  const used = new Set();
  for (const effect of effects) for (const side of ['before','after']) {
    const state = effect[side];
    if (effect.kind === 'PRODUCT') { if (state.mainAssetKey) used.add(state.mainAssetKey); }
    else for (const value of state.galleryAssetKeys) used.add(value);
  }
  const assets = snapshot.assets.filter(value => used.has(mediaAssetKey(value.mime, value.byte_sha256)))
    .map(value => Object.fromEntries(sourceFields.map(field => [field, value[field]])));
  assets.push(asset);
  const manifest = buildMediaManifest({ toolName: 'media.prepare_upload', graphRevision: snapshot.revision,
    codecDigest: stage.codecDigest, graphBytes: { oldBytes: snapshot.graphReadBytes.oldBytes, newBytes: result.image.length }, assets, effects });
  return { snapshot, manifest, mainUrl, thumbUrl, product };
}
function checkedProposal(value) {
  mediaObject(value, ['productId','stageId','targetSlot','product','media']);
  mediaObject(value.product, ['sku','name']);
  if (!isMediaUuid(value.productId) || !isMediaUuid(value.stageId) || !['MAIN','GALLERY'].includes(value.targetSlot) ||
      typeof value.product.sku !== 'string' || value.product.sku.length > 40 || typeof value.product.name !== 'string' || value.product.name.length > 120) invalid();
  validateMediaDescriptor(value.media, 'media.prepare_upload');
}
const validReceipt = value => {
  try { mediaObject(value, ['productId','listingId','revision']); return isMediaUuid(value.productId) && isMediaUuid(value.listingId) && isMediaHash(value.revision); } catch { return false; }
};

/** Server-owned adapter only; importing/constructing it registers no MCP tool. */
export function makeUploadAdapter({ hooks }) {
  return Object.freeze({
    resourceType: 'product', media: hooks,
    async preview(read, args, resources, trustedContext) {
      mediaObject(args, ['stageId']);
      if (args.stageId !== resources.stage.stageId || canonicalOperationJson(mediaContext(trustedContext)) !== canonicalOperationJson(mediaContext(resources.context))) invalid();
      const prepared = await plan(read, resources.stage, resources.result);
      return { resourceId: resources.stage.productId, expectedRevision: prepared.snapshot.revision,
        proposal: { productId: resources.stage.productId, stageId: resources.stage.stageId, targetSlot: resources.stage.targetSlot,
          product: { sku: prepared.product.sku, name: prepared.product.name } }, mediaManifest: prepared.manifest };
    },
    async currentRevision(read, envelope) {
      checkedProposal(envelope.proposal);
      if (envelope.resourceId !== envelope.proposal.productId) invalid();
      try { return { exists: true, revision: (await readMediaSnapshot(read, envelope.resourceId)).revision }; }
      catch (error) { if (error?.status === 404) return { exists: false, revision: null }; throw error; }
    },
    async apply(store, proposal, context) {
      checkedProposal(proposal);
      const identity = mediaContext(context.mediaContext);
      if (identity.accountId !== context.accountId || identity.clientId !== context.clientId || identity.grantId !== context.grantId) invalid();
      const actual = await withMediaWriter(store, identity, async writer => ({ stage: await writer.inspect(proposal.stageId),
        result: await writer.boundBytes(proposal.stageId, context.operationId) }));
      if (actual.stage.productId !== proposal.productId || actual.stage.targetSlot !== proposal.targetSlot ||
          actual.stage.correlationId !== context.correlationId) invalid();
      const retained = await readMediaFrame(store, identity, context.operationId, proposal.media);
      const prepared = await plan(store, actual.stage, actual.result);
      if (canonicalOperationJson(prepared.manifest.descriptor) !== canonicalOperationJson(retained.descriptor)) changed();
      const actor = await store.get('SELECT username FROM seller_account WHERE id=?', identity.accountId);
      if (!actor) invalid();
      const product = await trackUpdate(store, proposal.productId, actor.username, () => proposal.targetSlot === 'MAIN'
        ? updateProduct(store, proposal.productId, { imageDataUrl: prepared.mainUrl, thumbDataUrl: prepared.thumbUrl })
        : addGalleryImage(store, proposal.productId, prepared.mainUrl, 'manual', prepared.thumbUrl));
      if (!product) changed();
      const after = await readMediaSnapshot(store, proposal.productId);
      for (const kind of ['PRODUCT','LISTING']) {
        const rows = kind === 'PRODUCT' ? after.before.products : after.before.listings;
        const id = kind === 'PRODUCT' ? 'productId' : 'listingId';
        const expected = retained.effects.filter(effect => effect.kind === kind);
        if (rows.length !== expected.length) changed();
        for (const row of rows) {
          const effect = expected.find(value => value[id] === row[id]);
          const { [id]: _id, ...state } = row;
          if (!effect || canonicalOperationJson(state) !== canonicalOperationJson(effect.after)) changed();
        }
      }
      return { productId: product.id, listingId: product.listingId, revision: after.revision };
    },
    validResult: validReceipt,
    toReceipt: value => ({ productId: value.productId, listingId: value.listingId, revision: value.revision }),
    validReceipt,
  });
}
