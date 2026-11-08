import { isCreationParent,assertCreationParentManifest } from './catalog-create-parent-wire.js';
import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { createHash } from 'node:crypto';
import { plannedProductCreationIdentity } from '../listings.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha=/^[0-9a-f]{64}$/;
const invalid=()=>{throw new TypeError('Invalid catalog image review binding.');};
const large=()=>{throw new ApiError(503,'CATALOG_REVIEW_TOO_LARGE','The catalog review exceeds its safe metadata limit.');};
function object(value,keys){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);return !descriptor?.enumerable||!Object.hasOwn(descriptor,'value');
 }))invalid();
}
function label(value){
 object(value,['sku','name']);
 if(typeof value.sku!=='string'||!value.sku.isWellFormed()||value.sku.length>40||typeof value.name!=='string'||!value.name.isWellFormed()||value.name.length>120)invalid();
 return {sku:value.sku,name:value.name};
}
const createTool=toolName=>{if(!['catalog.preview_update','catalog.preview_create'].includes(toolName))invalid();return toolName==='catalog.preview_create';};
export function catalogProductLabels(value,toolName='catalog.preview_update'){object(value,['before','after']);return Object.freeze({before:createTool(toolName)&&value.before===null?null:Object.freeze(label(value.before)),after:Object.freeze(label(value.after))});}
export function catalogReviewLabels(value,toolName='catalog.preview_update'){
 createTool(toolName);
 if(!Array.isArray(value)||value.length<1||value.length>MEDIA_LIMITS.products||Reflect.ownKeys(value).length!==value.length+1)invalid();
 let last='';const rows=[];
 for(let n=0;n<value.length;n++){
  const descriptor=Object.getOwnPropertyDescriptor(value,String(n));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))invalid();
  const row=descriptor.value;object(row,['productId','before','after']);
  if(typeof row.productId!=='string'||!uuid.test(row.productId)||row.productId<=last)invalid();last=row.productId;
  rows.push(Object.freeze({productId:row.productId,...catalogProductLabels({before:row.before,after:row.after},toolName)}));
 }
 let text;try{text=canonicalOperationJson(rows);}catch{large();}if(Buffer.byteLength(text)>49152)large();
 return Object.freeze(rows);
}

function views(value,labels){
 if(!Array.isArray(value)||value.length!==labels.length||Reflect.ownKeys(value).length!==value.length+1)invalid();
 for(let n=0;n<value.length;n++)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,String(n))||{},'value'))invalid();
 return value.map((row,n)=>{
  object(row,['productId','role','holderId','visible']);
  if(row.productId!==labels[n].productId||!['single','holder','variant'].includes(row.role)||
   (row.role==='single'?row.holderId!==null:!uuid.test(row.holderId||'')||!labels.some(label=>label.productId===row.holderId)||
    (row.role==='holder')!==(row.holderId===row.productId))||!Array.isArray(row.visible)||row.visible.length>11||Reflect.ownKeys(row.visible).length!==row.visible.length+1)invalid();
  for(let n=0;n<row.visible.length;n++)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(row.visible,String(n))||{},'value'))invalid();
  const seen=new Set(),visible=row.visible.map(item=>{
   object(item,['id','assetKey','shared']);
   if(typeof item.id!=='string'||!(item.id==='main'||uuid.test(item.id)||/^shared-main:sha256:[0-9a-f]{64}(?::[1-9][0-9]?)?$/.test(item.id))||
    seen.has(item.id)||!sha.test(item.assetKey||'')||typeof item.shared!=='boolean'||
    (row.role==='single'?item.shared:item.shared!==(item.id!=='main')))invalid();
   seen.add(item.id);return{id:item.id,assetKey:item.assetKey,shared:item.shared};
  });
  return{productId:row.productId,role:row.role,holderId:row.holderId,visible};
 });
}
function creationIdentity(value){try{return plannedProductCreationIdentity(value);}catch{invalid();}}
function reviewRevision(productId,binding,identity=null){
 object(binding,['version','baseRevision','reviewProjectionHash']);
 if(binding.version!==1||!sha.test(binding.baseRevision||'')||!sha.test(binding.reviewProjectionHash||''))invalid();
 const preimage=identity?{version:2,kind:'catalog-media-create',resourceType:'catalog',resourceId:'catalog',creationIdentity:identity,baseRevision:binding.baseRevision,reviewProjectionHash:binding.reviewProjectionHash}:
  {version:2,kind:'catalog-media-update',productId,baseRevision:binding.baseRevision,reviewProjectionHash:binding.reviewProjectionHash};
 return createHash('sha256').update(canonicalOperationJson(preimage)).digest('hex');
}
// Private projection input is a complete bounded record stream, never a model
// argument or a substitute for the fresh catalog/B1 readers.
export function catalogMediaReviewBinding(input){
 const create=Object.getOwnPropertyDescriptor(input??{},'toolName')?.value==='catalog.preview_create';
 object(input,create?['toolName','creationIdentity','baseRevision','reviewLabels','beforeViews','afterViews']:['productId','baseRevision','reviewLabels','beforeViews','afterViews']);
 const identity=create?creationIdentity(input.creationIdentity):null,productId=create?identity.productId:input.productId;
 const labels=catalogReviewLabels(input.reviewLabels,create?'catalog.preview_create':'catalog.preview_update');
 if(!uuid.test(productId||'')||!labels.some(row=>row.productId===productId)||!sha.test(input.baseRevision||''))invalid();
 if(create&&(labels.filter(row=>row.before===null).length!==1||labels.find(row=>row.productId===productId).before!==null||
  labels.some(row=>row.before!==null&&canonicalOperationJson(row.before)!==canonicalOperationJson(row.after))))invalid();
 const hash=createHash('sha256');let bytes=0;
 function record(value){let text;try{text=canonicalOperationJson(value);}catch{large();}
  const size=Buffer.byteLength(text);bytes+=size+12;if(size>65536||bytes>8*1024*1024)large();hash.update(String(size)+':').update(text).update('\n');}
 record({version:1,kind:'catalog-media-review-projection'});
 for(const [table,rows] of [['reviewLabels',labels],['beforeViews',views(input.beforeViews,create?labels.filter(row=>row.before!==null):labels)],['afterViews',views(input.afterViews,labels)]]){
  record({table,count:rows.length});for(const row of rows)record(row);
 }
 const reviewBinding=Object.freeze({version:1,baseRevision:input.baseRevision,reviewProjectionHash:hash.digest('hex')});
 return Object.freeze({revision:reviewRevision(productId,reviewBinding,identity),reviewBinding});
}

// Fixed CREATE relationships only; this is not authority or a business planner.
export function catalogCreateEffects(effects,identity=undefined,creationParent=false){
 const products=effects.filter(row=>row.kind==='PRODUCT'),listings=effects.filter(row=>row.kind==='LISTING'),created=products.filter(row=>row.before===null);
 if(created.length!==1||listings.length!==1)invalid();
 const fresh=created[0],listing=listings[0];
 if(!fresh.after||(!creationParent&&(fresh.after.mainAssetKey!==null||fresh.after.ownMainVisible!==false))||fresh.labels.before!==null||listing.after===null||fresh.after.listingId!==listing.listingId)invalid();
 for(const row of products){
  if(row.after===null||row.after.listingId!==listing.listingId||(row.before===null)!==(row.labels.before===null))invalid();
  if(row.before!==null&&(row.before.listingId!==listing.listingId||row.before.mainAssetKey!==row.after.mainAssetKey||canonicalOperationJson(row.labels.before)!==canonicalOperationJson(row.labels.after)))invalid();
 }
 if(listing.before===null?(products.length!==1||fresh.after.role!=='single'||listing.after.holderId!==null||!creationParent&&listing.after.galleryAssetKeys.length!==0):products.length<2)invalid();
 if(identity!==undefined){const context=creationIdentity(identity);if(fresh.productId!==context.productId||listing.listingId!==(context.targetListingId??context.newListingId)||
  (listing.before===null)!==(context.targetListingId===null))invalid();}
 return {product:fresh,listing};
}
export function catalogCreateOptions(proposal){
 const options=proposal.after?.options,review=proposal.optionReview;
 object(review,['before','after']);
 if(!Array.isArray(options)||options.length>6||!Array.isArray(review.before)||review.before.length!==0||
  !Array.isArray(review.after)||review.after.length!==options.length)invalid();
 const pairs=[],seen=new Set();
 for(const row of review.after){object(row,['typeId','valueId','typeName','typeCode','valueLabel','valueCode','typeActive','valueActive']);
  if(!uuid.test(row.typeId||'')||!uuid.test(row.valueId||'')||seen.has(row.typeId)||typeof row.typeActive!=='boolean'||typeof row.valueActive!=='boolean')invalid();
  for(const [key,max]of [['typeName',60],['typeCode',60],['valueLabel',80],['valueCode',60]])if(typeof row[key]!=='string'||!row[key].isWellFormed()||row[key].length>max)invalid();
  seen.add(row.typeId);pairs.push({typeId:row.typeId,valueId:row.valueId});
 }
 for(const pair of options)object(pair,['typeId','valueId']);
 if(canonicalOperationJson(pairs)!==canonicalOperationJson(options))invalid();
 return review.after;
}

// This is a conservative physical graph budget, not a byte-read counter.
// Private projections retain the separate actual before/after costs.
export function catalogMediaGraphBytes(value){
 object(value,['beforeOldBytes','afterOldBytes']);
 if(![value.beforeOldBytes,value.afterOldBytes].every(bytes=>Number.isSafeInteger(bytes)&&bytes>=0))invalid();
 if(Math.max(value.beforeOldBytes,value.afterOldBytes)>MEDIA_LIMITS.oldBytes)large();
 return Object.freeze({oldBytes:Math.max(value.beforeOldBytes,value.afterOldBytes),newBytes:0});
}

// Integrity only. Real product/scope/graph/approval checks stay outside this helper.
export function assertCatalogReviewBinding(envelope,manifest){
 const create=envelope?.toolName==='catalog.preview_create',parent=create&&isCreationParent(envelope.proposal);
 if((create?envelope.resourceType!=='catalog'||envelope.resourceId!=='catalog':envelope?.toolName!=='catalog.preview_update'||envelope.resourceType!=='product'||!uuid.test(envelope.resourceId||''))||envelope.risk!=='HIGH'||
  manifest?.descriptor?.policyId!=='catalog-media-v1'||manifest.descriptor.graphRevision!==envelope.expectedRevision||
  canonicalOperationJson(envelope.proposal?.media)!==canonicalOperationJson(manifest.descriptor)||!parent&&(manifest.stages.length!==0||manifest.assets.some(row=>row.source_kind==='STAGE')))invalid();
 const identity=create?creationIdentity(envelope.proposal.creationIdentity):null;
 if(reviewRevision(envelope.resourceId,envelope.proposal.reviewBinding,identity)!==envelope.expectedRevision)invalid();
 let proposal;try{proposal=canonicalOperationJson(envelope.proposal);}catch{large();}if(Buffer.byteLength(proposal)>49152)large();
 const labels=catalogReviewLabels(envelope.proposal.reviewLabels,envelope.toolName),products=manifest.effects.filter(row=>row.kind==='PRODUCT');
 if(products.length!==labels.length||!products.some(row=>row.productId===(create?identity.productId:envelope.resourceId)))invalid();
 if(create){const {product}=catalogCreateEffects(manifest.effects,identity,parent),after=envelope.proposal.after;
  if(envelope.proposal.before!==null||!after||after.id!==identity.productId||after.listingId!==product.after.listingId||
   canonicalOperationJson(label({sku:after.sku,name:after.name}))!==canonicalOperationJson(product.labels.after))invalid();
  catalogCreateOptions(envelope.proposal);if(parent)assertCreationParentManifest(envelope.proposal,manifest);}
 for(let n=0;n<labels.length;n++){
  const row=products[n],expected=labels[n];if(!row||row.productId!==expected.productId||(!create&&row.before===null)||row.after===null||
   canonicalOperationJson(catalogProductLabels(row.labels,envelope.toolName))!==canonicalOperationJson({before:expected.before,after:expected.after}))invalid();
 }
 return labels;
}
