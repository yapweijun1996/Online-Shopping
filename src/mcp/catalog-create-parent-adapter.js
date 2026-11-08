import { ApiError } from '../http.js';
import { createHash } from 'node:crypto';
import { canonicalOperationJson } from './operation-envelope.js';
import { readCreateDraft } from './catalog-create-draft-storage.js';
import { readCatalogMediaCreateReview,parseCatalogMediaCreateProposal,assertCatalogCreateInitialAfter } from './catalog-media-create-adapter.js';
import { readCatalogCreateParentReview,parentCaptureRevision } from './catalog-create-parent-review.js';
import { isCreationParent,assertCreationParentManifest } from './catalog-create-parent-wire.js';
import { mediaContext,withMediaWriter,mediaHash } from './media-storage.js';
import { readMediaFrame } from './media-frame-storage.js';
import { readMediaSnapshot,loadOldMediaAsset } from './media-resources.js';
import { readCatalogCreateMediaMetadata } from './catalog-create-media-state.js';
import { applyPlannedProductCreate,updateProduct,addGalleryImage } from '../products.js';
import { trackCreate,trackUpdate } from '../product-history.js';
import { withInventoryContext } from '../inventory.js';
import { validateProductInput } from '../product-input.js';
const json=canonicalOperationJson,same=(a,b)=>json(a)===json(b),hash=value=>createHash('sha256').update(json(value)).digest('hex');
const changed=()=>{throw new ApiError(409,'STALE_REVISION','Creation dependencies changed. Review the complete proposal again.');};
const invalid=()=>{throw new ApiError(400,'CREATE_DRAFT_INPUT','Invalid creation draft request.');};
const dataUrl=(mime,bytes)=>`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
function checkedArgs(args,draft){const {draftId,...input}=args;if(draftId!==draft.id||!same(validateProductInput({currency:draft.normalizedInput.currency,...input},[draft.normalizedInput.currency]),draft.normalizedInput))invalid();}
async function finalizeDraft(writer,envelope,resolved,context){
 if(!same(mediaContext(context),resolved.context)||!same(envelope.proposal.creationMedia.images,resolved.images)||envelope.correlationId!==resolved.correlationId)changed();
 for(const row of resolved.results)await writer.bind(row.stageId,row.leaseToken,row.version,row.result,envelope.operationId);
}
async function finalAfter(store,prepared,context,results){
 const {draft,manifest}=prepared,productId=draft.creationIdentity.productId,after=await readMediaSnapshot(store,productId),metadata=await readCatalogCreateMediaMetadata(store,{normalizedInput:draft.normalizedInput,creationIdentity:draft.creationIdentity});
 for(const kind of ['PRODUCT','LISTING']){
  const rows=kind==='PRODUCT'?after.before.products:after.before.listings,key=kind==='PRODUCT'?'productId':'listingId',effects=manifest.effects.filter(row=>row.kind===kind);
  if(rows.length!==effects.length)changed();
  for(const row of rows){const effect=effects.find(item=>item[key]===row[key]);if(!effect)changed();const {[key]:id,...actual}=row,{ownMainVisible,...expected}=effect.after;if(!same(actual,expected))changed();
   if(kind==='PRODUCT'){const view=after.views.find(item=>item.productId===id);if(Boolean(view?.visible.some(item=>item.id==='main'))!==ownMainVisible)changed();}}
 }
 const desired=prepared.proposal.after,row=metadata.rows.product.find(value=>value.id===productId),options=metadata.rows.product_option.filter(value=>value.product_id===productId).map(value=>({typeId:value.option_type_id,valueId:value.option_value_id}));
 if(!row||!same({id:row.id,listingId:row.listing_id,sku:row.sku,name:row.name,description:row.description,categoryCode:row.category,priceMinor:row.price_minor,currency:row.currency,active:row.active===1,stockQuantity:row.stock_quantity,variantGroup:row.variant_group,variantLabel:row.variant_label,options},desired))changed();
 for(const table of ['general_code','option_type','option_value','company_setting'])if(!same(metadata.rows[table],prepared.state.metadata.rows[table]))changed();
 const old=prepared.state.metadata.rows;
 if(metadata.rows.product.length!==old.product.length+1||metadata.rows.listing.length!==old.listing.length+(draft.creationIdentity.targetListingId===null?1:0)||metadata.rows.product_option.length!==old.product_option.length+desired.options.length)changed();
 const omit=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
 for(const original of old.product){const actual=metadata.rows.product.find(row=>row.id===original.id),physical=prepared.projection.physicalEffects.some(row=>row.productId===original.id)||prepared.proposal.creationMedia.images.some(row=>row.productId===original.id),keys=physical?['updated_at','gallery_layout_json']:[];
  if(!actual||!same(omit(actual,keys),omit(original,keys)))changed();}
 for(const original of old.listing)if(!metadata.rows.listing.some(row=>same(row,original)))changed();
 for(const original of old.product_option)if(!metadata.rows.product_option.some(row=>same(row,original)))changed();
 for(const source of prepared.initialSnapshot.sources){const actual=after.sources.find(row=>row.source_kind===source.source_kind&&row.source_id===source.source_id&&row.source_product_id===source.source_product_id);
  if(!actual||actual.byte_sha256!==source.byte_sha256||actual.mime!==source.mime||actual.byte_length!==source.byte_length||!same(actual.thumbnail,source.thumbnail))changed();}

 for(const image of results){const item=prepared.proposal.creationMedia.images.find(value=>value.stageId===image.stageId),asset=after.sources.find(value=>value.source_product_id===item.productId&&value.byte_sha256===item.canonicalSha256&&value.mime===item.mime);
  if(!asset||asset.byte_length!==item.byteLength||asset.thumbnail?.byte_sha256!==item.thumbnailSha256||asset.thumbnail?.byte_length!==item.thumbnailBytes)changed();}
 return {productId,listingId:desired.listingId,revision:hash({version:1,kind:'catalog-create-parent-result',catalogRevision:metadata.revision,mediaRevision:after.revision,manifestRoot:manifest.descriptor.manifestRoot})};
}
/** A strict source-owned composite branch. Legacy image-free CREATE delegates
 * unchanged, and original standalone upload remains unchanged. */
export function createParentAdapter(runtime,legacy){
 const {codecDigest,nativeSession}=runtime;
 const media={...legacy.media,
 async capture(read,args,context,writer){if(!Object.hasOwn(args,'draftId'))return legacy.media.capture(read,args,context,writer);
  let draft=await readCreateDraft(read,args.draftId,mediaContext(context));checkedArgs(args,draft);
  if(draft.state==='BOUND')draft=await runtime.creation.renewParentDraft(draft.id,mediaContext(context),writer);
  if(draft.state!=='OPEN')changed();
  const base=await readCatalogMediaCreateReview(read,{normalizedInput:draft.normalizedInput,creationIdentity:draft.creationIdentity},codecDigest),leases=[],old=[];
  for(const row of draft.stages){const stage=await writer.inspect(row.stage_id);if(stage.productId!==row.target_product_id||stage.targetSlot!==row.target_slot||stage.expectedRevision!==draft.intent_hash||stage.correlationId!==draft.correlation_id)changed();leases.push({...row,...await writer.claimValidation(row.stage_id)});}
  for(const asset of base.manifest.assets){const {asset_key,before_needed,after_needed,...ref}=asset;old.push({ref,bytes:(await loadOldMediaAsset(read,base.state.source.snapshot,ref)).data});}
  if(old.length+leases.length>33)throw new ApiError(503,'CATALOG_REVIEW_TOO_LARGE','The complete image review exceeds its validation budget.');
  return {resourceId:'catalog',expectedRevision:parentCaptureRevision(base,draft),resources:{parent:true,context:mediaContext(context),requestDraftId:args.draftId,draftId:draft.id,intentHash:draft.intent_hash,requestHash:hash(args),sourceRevision:base.proposal.sourceRevision,correlationId:draft.correlation_id,leases,old}};
 },
 async resolve(captured,options){if(captured.parent!==true)return legacy.media.resolve(captured,options);
  const native=nativeSession(options),results=[],images=[];
  for(const lease of captured.leases){const packet=await native.decode(lease.source,lease.sourceMime,lease.sourceSha256),result={sourceSha256:packet.sourceSha256,image:Buffer.from(packet.image),thumbnail:Buffer.from(packet.thumbnail),mime:packet.mime,width:packet.width,height:packet.height,codecDigest};
   results.push({stageId:lease.stage_id,leaseToken:lease.leaseToken,version:lease.version,result});images.push({stageId:lease.stage_id,productId:lease.target_product_id,targetSlot:lease.target_slot,sourceSha256:result.sourceSha256,canonicalSha256:mediaHash(result.image),thumbnailSha256:mediaHash(result.thumbnail),mime:result.mime,byteLength:result.image.length,thumbnailBytes:result.thumbnail.length,width:result.width,height:result.height});}
  // Preserve the original aggregate native session call and deadline budget.
  for(const row of captured.old)await native.decode(row.bytes,row.ref.mime,row.ref.byte_sha256);
  return {parent:true,context:captured.context,requestDraftId:captured.requestDraftId,draftId:captured.draftId,intentHash:captured.intentHash,requestHash:captured.requestHash,sourceRevision:captured.sourceRevision,correlationId:captured.correlationId,images,results};
 },
 async persistResources(writer,envelope,resolved,context){if(!isCreationParent(envelope.proposal))return legacy.media.persistResources(writer,envelope,resolved,context);
  // Binding is written by the trusted adapter inside the engine transaction,
  // before stages are pinned; no public selector can attach an arbitrary stage.
  await runtime.creation.bindParent(envelope,resolved,context);
  return finalizeDraft(writer,envelope,resolved,context);
 },
 async consumeResources(writer,envelope,context){if(!isCreationParent(envelope.proposal))return legacy.media.consumeResources(writer,envelope,context);for(const row of envelope.proposal.creationMedia.images)await writer.consume(row.stageId,envelope.operationId);await runtime.creation.consumeParent(envelope,context);}
 };
 return Object.freeze({...legacy,media:Object.freeze(media),
 async preview(read,args,resolved,context){if(!Object.hasOwn(args,'draftId'))return legacy.preview(read,args,resolved,context);
  if(resolved.parent!==true||resolved.requestHash!==hash(args)||!same(mediaContext(context),resolved.context))changed();
  if(args.draftId!==resolved.requestDraftId)changed();
  const prepared=await readCatalogCreateParentReview(read,{draftId:resolved.draftId,images:resolved.images},codecDigest,mediaContext(context),resolved.sourceRevision);checkedArgs({...args,draftId:resolved.draftId},prepared.draft);
  const {media,...proposal}=prepared.proposal;return {resourceId:'catalog',expectedRevision:prepared.revision,proposal,mediaManifest:prepared.manifest};
 },
 async currentRevision(read,envelope){if(!isCreationParent(envelope.proposal))return legacy.currentRevision(read,envelope);
  try{const value=parseCatalogMediaCreateProposal(envelope.proposal),fresh=await readCatalogCreateParentReview(read,{draftId:value.creationMedia.draftId,images:value.creationMedia.images},codecDigest,undefined,value.sourceRevision);
   return {exists:true,revision:same(fresh.proposal,value)?fresh.revision:null};}catch(error){if(error instanceof ApiError&&[400,404,409].includes(error.status))return {exists:true,revision:null};throw error;}
 },
 async apply(store,proposal,context){if(!isCreationParent(proposal))return legacy.apply(store,proposal,context);
  const value=parseCatalogMediaCreateProposal(proposal),identity=mediaContext(context.mediaContext);if(identity.accountId!==context.accountId||identity.clientId!==context.clientId||identity.grantId!==context.grantId)invalid();
  return store.transaction(async()=>{const prepared=await readCatalogCreateParentReview(store,{draftId:value.creationMedia.draftId,images:value.creationMedia.images},codecDigest,identity,value.sourceRevision);
   if(!same(prepared.proposal,value)||prepared.draft.operation_id!==context.operationId||prepared.draft.correlation_id!==context.correlationId)changed();
   const retained=await readMediaFrame(store,identity,context.operationId,value.media);assertCreationParentManifest(value,retained);if(!same(retained.descriptor,prepared.manifest.descriptor))changed();
   const results=await withMediaWriter(store,identity,async writer=>{const values=[];for(const image of value.creationMedia.images){const result=await writer.boundBytes(image.stageId,context.operationId);if(result.canonicalSha256!==image.canonicalSha256||result.thumbnailSha256!==image.thumbnailSha256||result.width!==image.width||result.height!==image.height)changed();values.push(result);}return values;});
   const actor=await store.get('SELECT username FROM seller_account WHERE id=?',identity.accountId);if(!actor)invalid();
   const inactive={...value.normalizedInput,active:false};
   const result=await withInventoryContext({source:'MCP_CATALOG',actorKind:'SELLER',actorId:identity.accountId,clientId:identity.clientId,grantId:identity.grantId,operationId:context.operationId,correlationId:context.correlationId},()=>trackCreate(store,actor.username,()=>applyPlannedProductCreate(store,inactive,value.creationIdentity)));
   if(result?.id!==value.creationIdentity.productId)changed();
   await assertCatalogCreateInitialAfter(store,{...prepared,state:{...prepared.state,normalizedInput:inactive,after:{...prepared.state.after,active:false}}},context,actor.username);
   prepared.initialSnapshot=await readMediaSnapshot(store,result.id);
   for(const [index,image]of value.creationMedia.images.entries()){const bytes=results[index],main=dataUrl(bytes.mime,bytes.image),thumb=dataUrl('image/png',bytes.thumbnail);
    await trackUpdate(store,image.productId,actor.username,()=>image.targetSlot==='MAIN'?updateProduct(store,image.productId,{imageDataUrl:main,thumbDataUrl:thumb}):addGalleryImage(store,image.productId,main,'manual',thumb));}
   // Publication is the final local step in this same transaction. No caller
   // can observe a partially created product or images before commit.
   if(value.after.active)await trackUpdate(store,result.id,actor.username,()=>updateProduct(store,result.id,{active:true}));
   return finalAfter(store,prepared,context,results);
  });
 }
 });
}
