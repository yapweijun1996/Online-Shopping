import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { updateProduct, addGalleryImage, planGalleryImageAddition } from '../products.js';
import { planProductGallery, planProductMainRestoration, prepareGalleryUploadEntry } from '../product-gallery.js';
import { trackUpdate } from '../product-history.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { mediaContext, mediaHash, withMediaWriter } from './media-storage.js';
import { readMediaSnapshot } from './media-resources.js';
import { readMediaFrame } from './media-frame-storage.js';
import { mediaAssetKey } from './media-manifest.js';
import { mediaSnapshotManifest, assertMediaGraphAfter } from './media-graph.js';
import { isMediaHash, isMediaUuid, mediaObject, validateMediaDescriptor } from './media-policy.js';
import { uploadThumbnail, assertUploadThumbnail } from './media-upload-policy.js';

const changed = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media resource changed. Reopen its review.'); };
const invalid = () => { throw new TypeError('Invalid stored media upload.'); };
const dataUrl = (mime, data) => 'data:' + mime + ';base64,' + Buffer.from(data).toString('base64');

async function planState(read, stage, result) {
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
      galleryPlan = await planProductMainRestoration(read, stage.productId, mainUrl, view.current) ||
        await planProductGallery(read, stage.productId, view.current.galleryItems.map(({ id }) => ({ id })), view.current,
          { mainImageDataUrl: mainUrl });
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
  const manifest = mediaSnapshotManifest('media.prepare_upload', snapshot, after, stage.codecDigest,
    { assets: [asset], newBytes: result.image.length + result.thumbnail.length });
  return { snapshot, manifest, mainUrl, thumbUrl, product };
}
async function plan(read, stage, result) {
  try { return await planState(read, stage, result); }
  catch (error) {
    if (error instanceof FieldError) throw new ApiError(400, 'MEDIA_LAYOUT_INPUT', 'The image selection cannot be applied.');
    throw error;
  }
}
function checkedProposal(value) {
  mediaObject(value, ['productId','stageId','targetSlot','product','thumbnail','media']);
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
          product: { sku: prepared.product.sku, name: prepared.product.name }, thumbnail: uploadThumbnail(resources.result.thumbnail) }, mediaManifest: prepared.manifest };
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
      assertUploadThumbnail(proposal.thumbnail, actual.result.thumbnail);
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
      const identityOf = source => source.source_kind + ':' + source.source_product_id + ':' + source.source_id;
      const oldSources = new Map(prepared.snapshot.sources.map(source => [identityOf(source), source]));
      for (const source of after.sources) {
        const replacedMain = proposal.targetSlot === 'MAIN' && source.source_kind === 'PRODUCT_MAIN' && source.source_product_id === proposal.productId;
        const old = oldSources.get(identityOf(source));
        if (replacedMain || !old) {
          if (!source.thumbnail || source.thumbnail.mime !== proposal.thumbnail.mime ||
              source.thumbnail.byte_sha256 !== proposal.thumbnail.sha256 || source.thumbnail.byte_length !== proposal.thumbnail.byteLength) changed();
        } else if (canonicalOperationJson(source.thumbnail) !== canonicalOperationJson(old.thumbnail)) changed();
      }
      assertMediaGraphAfter(after, retained);
      return { productId: product.id, listingId: product.listingId, revision: after.revision };
    },
    validResult: validReceipt,
    toReceipt: value => ({ productId: value.productId, listingId: value.listingId, revision: value.revision }),
    validReceipt,
  });
}
