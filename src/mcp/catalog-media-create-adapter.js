import { randomUUID,createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { validateProductInput } from '../product-input.js';
import { applyPlannedProductCreate } from '../products.js';
import { plannedProductCreationIdentity } from '../listings.js';
import { trackCreate } from '../product-history.js';
import { withInventoryContext } from '../inventory.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { catalogCreateTool,catalogProductMetadataSchema } from './catalog-tools.js';
import { readCatalogCreateMediaMetadata,readCatalogCreateMediaState } from './catalog-create-media-state.js';
import { projectCatalogMediaCreate } from './catalog-media-projection.js';
import { buildCatalogCreateReviewManifest } from './catalog-media-review-manifest.js';
import { catalogNormalizationPreflight,assertCatalogMediaPhysicalAfter } from './catalog-media-update-state.js';
import { catalogReviewLabels,catalogCreateOptions } from './catalog-media-review-wire.js';
import { loadOldMediaAsset,readMediaSnapshot } from './media-resources.js';
import { mediaContext } from './media-storage.js';
import { readMediaFrame } from './media-frame-storage.js';
import { validateMediaDescriptor } from './media-policy.js';
import { valid } from './tools.js';

const descriptor=catalogCreateTool(),json=canonicalOperationJson,same=(a,b)=>json(a)===json(b);
const hash=value=>createHash('sha256').update(json(value)).digest('hex'),sha=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid=()=>{throw new ApiError(400,'CATALOG_CREATE_INPUT','Invalid catalog creation.');};
const changed=()=>{throw new ApiError(409,'CATALOG_DEPENDENCY_CHANGED','The catalog dependencies changed.');};
const large=()=>{throw new ApiError(503,'CATALOG_REVIEW_TOO_LARGE','The complete catalog review exceeds its safe limit.');};
const refFields=['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'];
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const adoption='The new SKU adopts the existing listing name, description and category.';
const sharing='The new SKU shares this listing gallery; review every affected image role and position.';
function shape(value,keys){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>{
 const field=Object.getOwnPropertyDescriptor(value,key);return !field?.enumerable||!Object.hasOwn(field,'value');}))invalid();}
function input(value){try{json(value);}catch{invalid();}if(!valid(value,descriptor.inputSchema))invalid();}
function bytes(value){let text;try{text=json(value);}catch{large();}if(Buffer.byteLength(text)>49152)large();return text;}
async function controlled(work){try{return await work();}catch(error){if(error instanceof FieldError)invalid();throw error;}}
function assertContext(context,other){if(!same(mediaContext(context),mediaContext(other)))changed();}
function root(envelope){if(envelope.toolName!=='catalog.preview_create'||envelope.resourceType!=='catalog'||envelope.resourceId!=='catalog'||envelope.risk!=='HIGH')invalid();}
function warnings(state,projection){
 if(state.source.kind==='EMPTY_BEFORE')return [];
 return [{code:'ADOPT_SHARED_LISTING',message:adoption,listingId:state.after.listingId,adoptedFields:['name','description','category']},
  {code:'SHARE_LISTING_GALLERY',message:sharing,listingId:state.after.listingId,existingMembers:projection.before.products.length,
   galleryImages:projection.after.listings[0].galleryAssetKeys.length,copyMain:projection.physicalEffects.some(row=>row.kind==='COPY_MAIN'),layoutChanged:projection.physicalEffects.some(row=>row.kind==='SET_LAYOUT')}];
}
function warningShape(value){
 if(!Array.isArray(value.warnings))invalid();
 const existing=value.creationIdentity.targetListingId!==null;
 if(value.warnings.length!==(existing?2:0))invalid();if(!existing)return;
 const [a,b]=value.warnings;shape(a,['code','message','listingId','adoptedFields']);shape(b,['code','message','listingId','existingMembers','galleryImages','copyMain','layoutChanged']);
 if(a.code!=='ADOPT_SHARED_LISTING'||a.message!==adoption||a.listingId!==value.after.listingId||!same(a.adoptedFields,['name','description','category'])||
  b.code!=='SHARE_LISTING_GALLERY'||b.message!==sharing||b.listingId!==value.after.listingId||b.existingMembers!==value.reviewLabels.length-1||
  !Number.isSafeInteger(b.galleryImages)||b.galleryImages<0||b.galleryImages>10||typeof b.copyMain!=='boolean'||typeof b.layoutChanged!=='boolean')invalid();
}
/** Closed integrity DTO only. This does not authorize a CREATE operation. */
export function parseCatalogMediaCreateProposal(value){
 const text=bytes(value);shape(value,['kind','normalizedInput','creationIdentity','before','after','optionReview','sourceRevision','reviewLabels','reviewBinding','media','warnings']);
 input(value.normalizedInput);let normalized;try{normalized=validateProductInput(value.normalizedInput,['MYR','SGD']);}catch{invalid();}
 if(!same(normalized,value.normalizedInput)||value.kind!=='create'||value.before!==null||!valid(value.after,catalogProductMetadataSchema()))invalid();
 const identity=plannedProductCreationIdentity(value.creationIdentity),labels=catalogReviewLabels(value.reviewLabels,'catalog.preview_create');
 if(value.after.id!==identity.productId||value.after.listingId!==(identity.targetListingId??identity.newListingId)||value.after.variantGroup!==identity.targetCode||
  labels.filter(row=>row.before===null).length!==1||labels.find(row=>row.before===null)?.productId!==identity.productId||!same(labels.find(row=>row.productId===identity.productId).after,{sku:value.after.sku,name:value.after.name}))invalid();
 shape(value.sourceRevision,['catalogRevision','mediaRevision']);shape(value.reviewBinding,['version','baseRevision','reviewProjectionHash']);
 if(![value.sourceRevision.catalogRevision,value.sourceRevision.mediaRevision,value.reviewBinding.baseRevision,value.reviewBinding.reviewProjectionHash].every(item=>sha.test(item||''))||value.reviewBinding.version!==1)invalid();
 catalogCreateOptions(value);warningShape(value);validateMediaDescriptor(value.media,'catalog.preview_create');return freeze(JSON.parse(text));
}
function usedRefs(prepared){return prepared.manifest.assets.map(row=>Object.fromEntries(refFields.map(key=>[key,row[key]])));}

/** Shared current read with a pinned identity. Expected source facts stop stale
 * intent before service preparation; no new target or identity is selected. */
export async function readCatalogMediaCreateReview(read,value,codecDigest,expectedSource=undefined){
 shape(value,['normalizedInput','creationIdentity']);if(!sha.test(codecDigest||''))invalid();
 const metadata=await readCatalogCreateMediaMetadata(read,value);
 if(expectedSource&&metadata.revision!==expectedSource.catalogRevision)changed();
 await catalogNormalizationPreflight(read);
 const state=await controlled(()=>readCatalogCreateMediaState(read,value));
 if(state.catalogRevision!==metadata.revision||expectedSource&&state.mediaRevision!==expectedSource.mediaRevision)changed();
 const projection=await projectCatalogMediaCreate(read,state),built=buildCatalogCreateReviewManifest({state,projection,codecDigest});
 const proposal=parseCatalogMediaCreateProposal({kind:'create',normalizedInput:state.normalizedInput,creationIdentity:state.creationIdentity,before:null,after:state.after,optionReview:state.optionReview,
  sourceRevision:{catalogRevision:state.catalogRevision,mediaRevision:state.mediaRevision},reviewLabels:built.manifest.effects.filter(row=>row.kind==='PRODUCT').map(row=>({productId:row.productId,...row.labels})),
  reviewBinding:built.reviewBinding,media:built.manifest.descriptor,warnings:warnings(state,projection)});
 return {...built,state,projection,proposal};
}
function assertResolved(prepared,resolved,codecDigest,context){
 assertContext(context,resolved.context);
 if(resolved.codecDigest!==codecDigest||resolved.revision!==prepared.revision||!same(resolved.normalizedInput,prepared.state.normalizedInput)||
  !same(resolved.creationIdentity,prepared.state.creationIdentity)||!same(resolved.sourceRevision,prepared.proposal.sourceRevision))changed();
 const refs=usedRefs(prepared);
 if(!Array.isArray(resolved.sources)||resolved.sources.length!==refs.length||refs.some(ref=>!resolved.sources.some(row=>refFields.every(key=>row[key]===ref[key])&&Number.isSafeInteger(row.width)&&row.width>0&&Number.isSafeInteger(row.height)&&row.height>0)))changed();
}
async function captureIntent(read,args){
 input(args);
 const company=await read.get('SELECT substr(default_currency,1,4) AS currency FROM company_setting WHERE id=1');
 if(!company||!['MYR','SGD'].includes(company.currency))changed();
 const normalizedInput=await controlled(()=>validateProductInput({currency:company.currency,...args},[company.currency]));
 const target=normalizedInput.variantGroup?await read.get('SELECT substr(id,1,37) AS id FROM listing WHERE code=?',normalizedInput.variantGroup):null;
 const creationIdentity=plannedProductCreationIdentity({version:1,productId:randomUUID(),targetCode:normalizedInput.variantGroup??null,targetListingId:target?.id??null,newListingId:target?null:randomUUID()});
 return {normalizedInput,creationIdentity};
}
const sameRows=(a,b)=>a.length===b.length&&a.every((row,n)=>same(row,b[n]));
const omit=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const instant=value=>typeof value==='string'&&value.length===24&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;
async function actualAfter(read,prepared,context,actor){
 const {state,projection}=prepared,identity=state.creationIdentity;
 const metadata=await readCatalogCreateMediaMetadata(read,{normalizedInput:state.normalizedInput,creationIdentity:identity});
 const before=state.metadata.rows,after=metadata.rows,snapshot=await readMediaSnapshot(read,identity.productId);
 const prior=state.source.kind==='EXISTING_TARGET'?state.source.snapshot:{sources:[],products:[],galleries:[]};
 await assertCatalogMediaPhysicalAfter(read,{before:prior,projection,plannedIdentity:null},snapshot);
 for(const table of ['general_code','option_type','option_value','company_setting'])if(!sameRows(before[table],after[table]))changed();
 if(after.product.length!==before.product.length+1||after.listing.length!==before.listing.length+(identity.targetListingId===null?1:0)||
  after.product_option.length!==before.product_option.length+state.after.options.length)changed();
 for(const row of before.product){const actual=after.product.find(value=>value.id===row.id),effects=projection.physicalEffects.filter(effect=>effect.productId===row.id),layout=effects.some(effect=>effect.kind==='SET_LAYOUT');
  if(!actual||!same(omit(actual,[...(layout?['gallery_layout_json']:[]),...(effects.length?['updated_at']:[])]),omit(row,[...(layout?['gallery_layout_json']:[]),...(effects.length?['updated_at']:[])]))||
   effects.length&&(!instant(actual.updated_at)||Date.parse(actual.updated_at)<=Date.parse(row.updated_at)))changed();
 }
 for(const row of before.listing){const actual=after.listing.find(value=>value.id===row.id);if(!actual||!same(actual,row))changed();}
 for(const row of before.product_option)if(!after.product_option.some(value=>same(value,row)))changed();
 const row=after.product.find(value=>value.id===identity.productId),desired=state.after;
 if(!row||!same({id:row.id,listingId:row.listing_id,sku:row.sku,name:row.name,description:row.description,categoryCode:row.category,priceMinor:row.price_minor,currency:row.currency,active:row.active===1,stockQuantity:row.stock_quantity,
  variantGroup:row.variant_group,variantLabel:row.variant_label,options:after.product_option.filter(value=>value.product_id===row.id).map(value=>({typeId:value.option_type_id,valueId:value.option_value_id}))},desired)||
  row.image_mime!==null||row.gallery_layout_json!==null||!instant(row.created_at)||row.updated_at!==row.created_at||state.source.kind==='EXISTING_TARGET'&&state.source.order.some(value=>Date.parse(row.created_at)<=Date.parse(value.createdAt)))changed();
 if(identity.targetListingId===null){const listing=after.listing.find(value=>value.id===identity.newListingId);
  if(!listing||!same(listing,{id:identity.newListingId,code:identity.targetCode,name:desired.name,description:desired.description,category:desired.categoryCode,translations_json:'{}',created_at:row.created_at,updated_at:row.created_at}))changed();}
 const coverage=await read.get('SELECT origin,started_at,baseline_quantity FROM inventory_coverage WHERE product_id=?',identity.productId),stock=await read.get('SELECT revision FROM inventory_state WHERE product_id=?',identity.productId);
 const movements=await read.all('SELECT kind,source,reason_code,revision,before_quantity,after_quantity,delta_quantity,actor_kind,actor_id,client_id,grant_id,operation_id,correlation_id,order_id,order_revision,occurred_at FROM inventory_movement WHERE product_id=? LIMIT 2',identity.productId);
 const history=await read.all('SELECT actor,action FROM product_event WHERE product_id=? LIMIT 2',identity.productId);
 if(!coverage||!same(coverage,{origin:'CREATED',started_at:row.created_at,baseline_quantity:desired.stockQuantity})||stock?.revision!==1||movements.length!==1||history.length!==1||!same(history[0],{actor,action:'CREATED'})||
  !same(movements[0],{kind:'INITIALIZED',source:'MCP_CATALOG',reason_code:'PRODUCT_CREATE',revision:1,before_quantity:null,after_quantity:desired.stockQuantity,delta_quantity:null,
   actor_kind:'SELLER',actor_id:context.accountId,client_id:context.clientId,grant_id:context.grantId,operation_id:context.operationId,correlation_id:context.correlationId,order_id:null,order_revision:null,occurred_at:row.created_at}))changed();
 return {metadata,snapshot,revision:hash({version:1,kind:'catalog-media-create-result',productId:identity.productId,listingId:desired.listingId,catalogRevision:metadata.revision,mediaRevision:snapshot.revision})};
}

/** Constructor-private hooks. Current runtime authority still rejects CREATE. */
export function catalogMediaCreateAdapter(runtime){
 if(!sha.test(runtime?.codecDigest||'')||typeof runtime.nativeSession!=='function')throw new TypeError('Trusted catalog media runtime required.');
 const {codecDigest,nativeSession}=runtime;
 const media=Object.freeze({policyId:'catalog-media-v1',codecDigest,
  async capture(read,args,context){mediaContext(context);const intent=await captureIntent(read,args),prepared=await readCatalogMediaCreateReview(read,intent,codecDigest),old=[];
   for(const ref of usedRefs(prepared))old.push({ref,bytes:(await loadOldMediaAsset(read,prepared.state.source.snapshot,ref)).data});
   return {resourceId:'catalog',expectedRevision:prepared.revision,resources:{context:mediaContext(context),requestHash:hash(args),...intent,sourceRevision:prepared.proposal.sourceRevision,revision:prepared.revision,codecDigest,old}};
  },
  async resolve(captured,options){mediaContext(captured.context);if(captured.codecDigest!==codecDigest||!sha.test(captured.revision||'')||!Array.isArray(captured.old)||captured.old.length>32)changed();
   const native=nativeSession(options),sources=[];for(const asset of captured.old){const decoded=await native.decode(asset.bytes,asset.ref.mime,asset.ref.byte_sha256);sources.push({...asset.ref,width:decoded.width,height:decoded.height});}
   return {context:captured.context,requestHash:captured.requestHash,normalizedInput:captured.normalizedInput,creationIdentity:captured.creationIdentity,sourceRevision:captured.sourceRevision,revision:captured.revision,codecDigest,sources};
  },
  async persistResources(_writer,envelope,resolved,context){root(envelope);const proposal=parseCatalogMediaCreateProposal(envelope.proposal);assertContext(context,resolved.context);
   if(envelope.expectedRevision!==resolved.revision||proposal.media.codecDigest!==codecDigest||resolved.codecDigest!==codecDigest||!same(proposal.normalizedInput,resolved.normalizedInput)||!same(proposal.creationIdentity,resolved.creationIdentity)||!same(proposal.sourceRevision,resolved.sourceRevision))changed();
  },
  async consumeResources(_writer,envelope,context){root(envelope);mediaContext(context);parseCatalogMediaCreateProposal(envelope.proposal);},
 });
 return Object.freeze({resourceType:'catalog',media,
  async preview(read,args,resolved,context){input(args);assertContext(context,resolved.context);if(resolved.requestHash!==hash(args))changed();
   const prepared=await readCatalogMediaCreateReview(read,{normalizedInput:resolved.normalizedInput,creationIdentity:resolved.creationIdentity},codecDigest,resolved.sourceRevision);assertResolved(prepared,resolved,codecDigest,context);
   const {media:_media,...proposal}=prepared.proposal;return {resourceId:'catalog',expectedRevision:prepared.revision,proposal,mediaManifest:prepared.manifest};
  },
  async currentRevision(read,envelope){root(envelope);const value=parseCatalogMediaCreateProposal(envelope.proposal);
   try{const prepared=await readCatalogMediaCreateReview(read,{normalizedInput:value.normalizedInput,creationIdentity:value.creationIdentity},codecDigest,value.sourceRevision);
    return {exists:true,revision:same(prepared.proposal,value)?prepared.revision:null};
   }catch(error){if(error instanceof ApiError&&[400,404,409].includes(error.status))return {exists:true,revision:null};throw error;}
  },
  async apply(store,proposal,context){const value=parseCatalogMediaCreateProposal(proposal),identity=mediaContext(context.mediaContext);
   if(identity.accountId!==context.accountId||identity.clientId!==context.clientId||identity.grantId!==context.grantId||!uuid.test(context.operationId||'')||!uuid.test(context.correlationId||''))invalid();
   return store.transaction(async()=>{const prepared=await readCatalogMediaCreateReview(store,{normalizedInput:value.normalizedInput,creationIdentity:value.creationIdentity},codecDigest,value.sourceRevision);
    if(!same(prepared.proposal,value))changed();const retained=await readMediaFrame(store,identity,context.operationId,value.media);if(!same(retained.descriptor,prepared.manifest.descriptor)||retained.stages.length)changed();
    const actor=await store.get('SELECT username FROM seller_account WHERE id=?',identity.accountId);if(!actor)invalid();
    const result=await withInventoryContext({source:'MCP_CATALOG',actorKind:'SELLER',actorId:identity.accountId,clientId:identity.clientId,grantId:identity.grantId,operationId:context.operationId,correlationId:context.correlationId},
     ()=>trackCreate(store,actor.username,()=>applyPlannedProductCreate(store,value.normalizedInput,value.creationIdentity)));
    if(!result||result.id!==value.creationIdentity.productId||result.listingId!==value.after.listingId)changed();const after=await actualAfter(store,prepared,context,actor.username);
    return {productId:result.id,listingId:result.listingId,revision:after.revision};
   });
  },
  validResult:value=>valid(value,descriptor.receiptSchema),toReceipt:value=>({productId:value.productId,listingId:value.listingId,revision:value.revision}),validReceipt:value=>valid(value,descriptor.receiptSchema),
 });
}
export function catalogMediaCreateTool(runtime){return Object.freeze({...catalogCreateTool(),adapter:catalogMediaCreateAdapter(runtime)});}
