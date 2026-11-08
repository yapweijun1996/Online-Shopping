import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { readCatalogMediaCreateReview,parseCatalogMediaCreateProposal } from './catalog-media-create-adapter.js';
import { readCreateDraft } from './catalog-create-draft-storage.js';
import { creationMediaBinding,assertCreationParentManifest } from './catalog-create-parent-wire.js';
import { buildCatalogParentMediaManifest,mediaAssetKey } from './media-manifest.js';
import { catalogMediaReviewBinding } from './catalog-media-review-wire.js';
const json=canonicalOperationJson,same=(a,b)=>json(a)===json(b),hash=value=>createHash('sha256').update(json(value)).digest('hex');
const changed=()=>{throw new ApiError(409,'STALE_REVISION','Creation dependencies changed. Review the full proposal again.');};
export const parentCaptureRevision=(prepared,draft)=>hash({version:1,kind:'catalog-create-parent-source',revision:prepared.revision,intentHash:draft.intent_hash,draftId:draft.id,stages:draft.stages});
function views(effects,baseViews,images){
 return effects.filter(row=>row.kind==='PRODUCT').map(row=>{const listing=effects.find(item=>item.kind==='LISTING'&&item.listingId===row.after.listingId),prior=baseViews.find(item=>item.productId===row.productId);
  const gallery=listing.after.galleryAssetKeys.map(key=>{const stage=images.find(image=>mediaAssetKey(image.mime,image.canonicalSha256)===key);const existing=baseViews.flatMap(view=>view.visible).find(item=>item.assetKey===key);return {id:stage?.targetSlot==='MAIN'?'main':stage?.stageId??existing?.id,assetKey:key,shared:row.after.role!=='single'};});
  const visible=row.after.role==='single'?gallery:[...(row.after.mainAssetKey?[{id:'main',assetKey:row.after.mainAssetKey,shared:false}]:[]),...gallery];
  if(visible.some(item=>!item.id))changed();
  return {productId:row.productId,role:row.after.role,holderId:listing.after.holderId,visible};
 }).sort((a,b)=>a.productId<b.productId?-1:1);
}
/** Rebuild from the exact original server IDs and fresh catalog/source reader.
 * Descriptors alone never authorize bytes: stage pin/native proof is checked by
 * operation engine, storage and the parent adapter before review or writes. */
export async function readCatalogCreateParentReview(read,{draftId,images},codecDigest,context=undefined,expectedSource=undefined){
 const draft=await readCreateDraft(read,draftId,context),binding=creationMediaBinding({version:1,draftId,intentHash:draft.intent_hash,images});
 if(draft.stages.length!==images.length||draft.stages.some((stage,n)=>stage.stage_id!==images[n].stageId||stage.target_product_id!==images[n].productId||stage.target_slot!==images[n].targetSlot))changed();
 for(const [n,stage]of draft.stages.entries()){
  const source=await read.get('SELECT source_sha256,source_mime,expected_revision,correlation_id,codec_digest,canonical_sha256,thumbnail_sha256 FROM mcp_v2_media_stage WHERE id=?',stage.stage_id),image=images[n];
  if(!source||source.source_sha256!==image.sourceSha256||source.source_mime!==image.mime||source.expected_revision!==draft.intent_hash||source.correlation_id!==draft.correlation_id||source.codec_digest!==codecDigest||
   source.canonical_sha256!==null&&source.canonical_sha256!==image.canonicalSha256||source.thumbnail_sha256!==null&&source.thumbnail_sha256!==image.thumbnailSha256)changed();
 }
 const base=await readCatalogMediaCreateReview(read,{normalizedInput:draft.normalizedInput,creationIdentity:draft.creationIdentity},codecDigest,expectedSource);
 const effects=structuredClone(base.manifest.effects),fresh=effects.find(row=>row.kind==='PRODUCT'&&row.before===null),listing=effects.find(row=>row.kind==='LISTING');
 const assets=images.map(row=>({source_kind:'STAGE',source_id:row.stageId,source_product_id:row.productId,stage_id:row.stageId,byte_sha256:row.canonicalSha256,mime:row.mime,byte_length:row.byteLength}));
 const keys=assets.map(row=>mediaAssetKey(row.mime,row.byte_sha256));
 const inherited=listing.after.galleryAssetKeys;
 // Duplicates have service-dependent associations/order. Reject instead of
 // presenting a plan whose actual service effects might differ.
 if(keys.some(key=>inherited.includes(key))||new Set(keys).size!==keys.length)throw new ApiError(400,'CREATE_IMAGE_DUPLICATE','Use distinct images for each new image position.');
 fresh.after.mainAssetKey=keys[0];fresh.after.ownMainVisible=true;
 if(listing.before===null)listing.after.galleryAssetKeys=[...keys];else listing.after.galleryAssetKeys=[...inherited,...keys.slice(1)];
 if(listing.after.galleryAssetKeys.length>10)throw new ApiError(400,'MEDIA_GALLERY_LIMIT','The complete gallery exceeds ten images.');
 const afterViews=views(effects,base.projection.afterViews,images),reviewBinding=catalogMediaReviewBinding({toolName:'catalog.preview_create',creationIdentity:draft.creationIdentity,baseRevision:parentCaptureRevision(base,draft),reviewLabels:base.proposal.reviewLabels,beforeViews:base.projection.beforeViews,afterViews});
 const oldBytes=base.projection.graphReadBytes.beforeOldBytes,newBytes=images.reduce((sum,row)=>sum+row.byteLength+row.thumbnailBytes,0);
 const manifest=buildCatalogParentMediaManifest({toolName:'catalog.preview_create',graphRevision:reviewBinding.revision,codecDigest,graphBytes:{oldBytes:Math.max(oldBytes,base.projection.graphReadBytes.afterOldBytes),newBytes},assets:[...base.manifest.assets.map(({asset_key,before_needed,after_needed,...row})=>row),...assets],effects});
 const proposal=parseCatalogMediaCreateProposal({...base.proposal,creationMedia:binding,reviewBinding:reviewBinding.reviewBinding,media:manifest.descriptor});assertCreationParentManifest(proposal,manifest);
 return {...base,draft,manifest,proposal,revision:reviewBinding.revision,reviewBinding:reviewBinding.reviewBinding,afterViews};
}
