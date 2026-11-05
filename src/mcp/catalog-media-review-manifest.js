import { ApiError } from '../http.js';
import { plannedListingIdentity,plannedProductCreationIdentity } from '../listings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { buildMediaManifest,mediaAssetKey } from './media-manifest.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { catalogReviewLabels,catalogMediaReviewBinding,catalogMediaGraphBytes } from './catalog-media-review-wire.js';
import { catalogCreateMediaRevision,catalogCreateMetadataRevision } from './catalog-create-media-state.js';

const invalid=()=>{throw new TypeError('Invalid catalog UPDATE media assembly.');};
const limited=()=>{throw new ApiError(503,'CATALOG_REVIEW_TOO_LARGE','The catalog review exceeds its safe metadata limit.');};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,sha=/^[0-9a-f]{64}$/;
const sourceFields=['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'];
function object(value,keys){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);return !descriptor?.enumerable||!Object.hasOwn(descriptor,'value');
 }))invalid();
}
function array(value,max){
 if(!Array.isArray(value)||Reflect.ownKeys(value).length!==value.length+1)invalid();if(value.length>max)limited();
 for(let n=0;n<value.length;n++)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,String(n))||{},'value'))invalid();
}
function json(value){try{return canonicalOperationJson(value);}catch{limited();}}
const equal=(a,b)=>json(a)===json(b);
function graph(value,allowEmpty=false){
 object(value,['products','listings']);array(value.products,MEDIA_LIMITS.products);array(value.listings,MEDIA_LIMITS.listings);
 if(!value.products.length||!value.listings.length){if(!allowEmpty||value.products.length||value.listings.length)invalid();}
 const products=new Map(),listings=new Map();
 for(const row of value.products){object(row,['productId','listingId','role','mainAssetKey']);
  if(!uuid.test(row.productId||'')||products.has(row.productId)||!(row.listingId===null||uuid.test(row.listingId||''))||
   !['single','holder','variant'].includes(row.role)||!(row.mainAssetKey===null||sha.test(row.mainAssetKey||'')))invalid();products.set(row.productId,row);}
 for(const row of value.listings){object(row,['listingId','holderId','galleryAssetKeys']);array(row.galleryAssetKeys,10);
  if(!(row.listingId===null||uuid.test(row.listingId||''))||listings.has(row.listingId)||!(row.holderId===null||uuid.test(row.holderId||''))||
   !row.galleryAssetKeys.every(value=>sha.test(value||'')))invalid();listings.set(row.listingId,row);}
 return{products,listings};
}
function sameGraph(a,b){
 for(const kind of ['products','listings'])if(a[kind].size!==b[kind].size||[...a[kind]].some(([id,row])=>!b[kind].has(id)||!equal(row,b[kind].get(id))))invalid();
}
function productState(product,view,listing){
 if(!view||view.productId!==product.productId||view.role!==product.role||view.holderId!==listing?.holderId)invalid();
 const own=view.visible.find(item=>item.id==='main');
 if(own&&(own.assetKey!==product.mainAssetKey||own.shared!==false||product.role!=='single'&&view.visible[0]!==own)||product.mainAssetKey===null&&own)invalid();
 const keys=view.visible.map(item=>item.assetKey),expected=product.role==='single'?listing.galleryAssetKeys:
  [...(own?[product.mainAssetKey]:[]),...listing.galleryAssetKeys];
 if(!equal(keys,expected))invalid();
 return{listingId:product.listingId,role:product.role,mainAssetKey:product.mainAssetKey,ownMainVisible:Boolean(own)};
}

/** Pure existing-product UPDATE assembler. Fresh reader/projector inputs only;
 * no database facade, writer, model identity or authority is accepted. */
export function buildCatalogUpdateReviewManifest(input){
 object(input,['snapshot','beforeGraph','projection','reviewLabels','plannedIdentity','baseRevision','codecDigest']);
 const {snapshot,beforeGraph,projection}=input;
 if(!snapshot||!uuid.test(snapshot.targetId||'')||!sha.test(snapshot.revision||'')||!sha.test(input.codecDigest||''))invalid();
 object(beforeGraph,['version','mediaRevision','before','beforeViews']);
 object(projection,['version','mediaRevision','before','after','afterViews','removedListingIds','physicalEffects','bindings','graphReadBytes','catalogDependencies']);
 object(projection.bindings,['newPrivateListing']);object(projection.catalogDependencies,['targetPlan','normalizedPatch']);
 if(beforeGraph.version!==1||projection.version!==1||beforeGraph.mediaRevision!==snapshot.revision||projection.mediaRevision!==snapshot.revision||
  typeof projection.bindings.newPrivateListing!=='boolean')invalid();
 const before=graph(beforeGraph.before),after=graph(projection.after),labels=catalogReviewLabels(input.reviewLabels);
 sameGraph(before,graph(snapshot.before));sameGraph(before,graph(projection.before));
 array(snapshot.products,300);array(snapshot.assets,32);array(snapshot.sources,3300);array(projection.removedListingIds,2);array(projection.physicalEffects,4);
 if(labels.length!==before.products.size||labels.length!==after.products.size||snapshot.products.length!==labels.length)invalid();
 for(const label of labels){const actual=snapshot.products.find(row=>row.productId===label.productId);
  if(!actual||!before.products.has(label.productId)||!after.products.has(label.productId)||actual.name!==label.before.name||actual.sku!==label.before.sku||
   before.products.get(label.productId).mainAssetKey!==after.products.get(label.productId).mainAssetKey)invalid();}
 const current=before.products.get(snapshot.targetId);if(!current)invalid();
 const privateTarget=projection.bindings.newPrivateListing,plan=projection.catalogDependencies.targetPlan;
 if(plan!==null){
  object(plan,['create','code','listing']);object(plan.listing,['id','name','description','category']);
  if(typeof plan.create!=='boolean'||!Object.hasOwn(projection.catalogDependencies.normalizedPatch,'variantGroup')||
   (projection.catalogDependencies.normalizedPatch.variantGroup||null)!==plan.code||
   (plan.create?plan.listing.id!==null:!before.listings.has(plan.listing.id))||after.products.get(snapshot.targetId).listingId!==plan.listing.id)invalid();
 }else if(privateTarget||after.products.get(snapshot.targetId).listingId!==current.listingId)invalid();
 for(const [id,row] of before.products)if(id!==snapshot.targetId&&after.products.get(id).listingId!==row.listingId)invalid();
 let identity=null;
 if(privateTarget){
  identity=plannedListingIdentity(input.plannedIdentity);
  if(identity.productId!==snapshot.targetId||identity.previousListingId!==current.listingId||before.listings.has(identity.newListingId)||
   !plan||plan.create!==true||plan.listing?.id!==null||plan.code!==identity.targetCode||
   !after.listings.has(null)||after.products.get(snapshot.targetId).listingId!==null||
   [...after.products.values()].filter(row=>row.listingId===null).length!==1)invalid();
 }else if(input.plannedIdentity!==null||after.listings.has(null)||[...after.products.values()].some(row=>row.listingId===null))invalid();
 if([...before.products.values()].some(row=>row.listingId===null)||before.listings.has(null))invalid();
 const removed=[...before.listings.keys()].filter(id=>!after.listings.has(id)).sort();
 if(!equal(removed,[...projection.removedListingIds].sort()))invalid();
 if(!privateTarget&&[...after.listings.keys()].some(id=>!before.listings.has(id)))invalid();
 object(projection.graphReadBytes,['beforeOldBytes','afterOldBytes']);object(snapshot.graphReadBytes,['oldBytes','newBytes']);
 if(snapshot.graphReadBytes.newBytes!==0||projection.graphReadBytes.beforeOldBytes!==snapshot.graphReadBytes.oldBytes)invalid();
 const graphBytes=catalogMediaGraphBytes(projection.graphReadBytes);
 const binding=catalogMediaReviewBinding({productId:snapshot.targetId,baseRevision:input.baseRevision,reviewLabels:labels,
  beforeViews:beforeGraph.beforeViews,afterViews:projection.afterViews});
 return assemble(input,before,after,labels,identity,graphBytes,binding);
}

function assemble(input,before,after,labels,identity,graphBytes,binding,toolName='catalog.preview_update'){
 const {projection}=input,create=toolName==='catalog.preview_create';
 // EMPTY_BEFORE supplies empty resource metadata, never a fabricated snapshot.
 const resources=create?(input.state.source.kind==='EXISTING_TARGET'?input.state.source.snapshot:{assets:[],sources:[]}):input.snapshot;
 const beforeViews=create?projection.beforeViews:input.beforeGraph.beforeViews;
 const effects=labels.map(label=>{
  const old=before.products.get(label.productId),next=after.products.get(label.productId),oldView=beforeViews.find(row=>row.productId===label.productId),
   nextView=projection.afterViews.find(row=>row.productId===label.productId),state=productState(next,nextView,after.listings.get(next.listingId));
  return{kind:'PRODUCT',productId:label.productId,before:old?productState(old,oldView,before.listings.get(old.listingId)):null,
   after:{...state,listingId:state.listingId??identity.newListingId},labels:{before:label.before,after:label.after}};
 });
 const ids=[...new Set([...before.listings.keys(),...[...after.listings.keys()].map(id=>id??identity.newListingId)])].sort();
 if(ids.length>2)invalid();
 for(const id of ids){const old=before.listings.get(id),next=after.listings.get(id)??(identity?.newListingId===id?after.listings.get(null):undefined);
  effects.push({kind:'LISTING',listingId:id,before:old?{holderId:old.holderId,galleryAssetKeys:[...old.galleryAssetKeys]}:null,
   after:next?{holderId:next.holderId,galleryAssetKeys:[...next.galleryAssetKeys]}:null});}
 const used=new Set();for(const effect of effects)for(const side of ['before','after']){const state=effect[side];if(state===null)continue;
  for(const key of effect.kind==='PRODUCT'?(state.mainAssetKey?[state.mainAssetKey]:[]):state.galleryAssetKeys)used.add(key);}
 const assets=[];
 for(const asset of resources.assets){object(asset,sourceFields);const key=mediaAssetKey(asset.mime,asset.byte_sha256);
  if(!['PRODUCT_MAIN','GALLERY'].includes(asset.source_kind)||asset.stage_id!==null)invalid();
  if(!used.has(key))continue;
  if(!before.products.has(asset.source_product_id)||
   !resources.sources.some(source=>source&&sourceFields.every(field=>{
    const descriptor=Object.getOwnPropertyDescriptor(source,field);return descriptor&&Object.hasOwn(descriptor,'value')&&descriptor.value===asset[field];
   })))invalid();
  assets.push({...asset});used.delete(key);}
 if(used.size)invalid();
 const manifest=buildMediaManifest({toolName,graphRevision:binding.revision,codecDigest:input.codecDigest,graphBytes,assets,effects});
 return Object.freeze({manifest,...binding});
}

function sameRows(value,expected,max){array(value,max);array(expected,max);if(value.length!==expected.length||value.some((row,n)=>!equal(row,expected[n])))invalid();}
function createCopyCost(effects,snapshot,holderId){
 let bytes=0;const kinds=new Set();
 for(const row of effects){
  if(!['COPY_MAIN','SET_LAYOUT'].includes(row?.kind)||kinds.has(row.kind)||row.productId!==holderId)invalid();kinds.add(row.kind);
  if(row.kind==='SET_LAYOUT'){
   object(row,['kind','productId','selected']);array(row.selected,10);
   if(new Set(row.selected).size!==row.selected.length||row.selected.some(id=>typeof id!=='string'||!uuid.test(id)&&!/^shared-main:sha256:[0-9a-f]{64}(?::[1-9][0-9]?)?$/.test(id)))invalid();
  }else{
   object(row,['kind','productId','ref','source','thumbnail','position']);object(row.source,sourceFields);
   const actual=snapshot.sources.find(value=>sourceFields.every(key=>value[key]===row.source[key])),copyRef=typeof row.ref==='string'&&/^shared-main:sha256:([0-9a-f]{64})(?::[1-9][0-9]?)?$/.exec(row.ref);
   if(!actual||row.source.source_kind!=='PRODUCT_MAIN'||row.source.source_product_id!==holderId||row.source.stage_id!==null||
    !copyRef||copyRef[1]!==row.source.byte_sha256||!Number.isSafeInteger(row.position)||row.position<1||row.position>10||!equal(row.thumbnail,actual.thumbnail))invalid();
   bytes+=actual.byte_length+(actual.thumbnail?.byte_length??0);
  }
 }
 return bytes;
}

/** Pure CREATE wrapper over the same assembly/visibility/source path. Inputs
 * come from the fresh SELECT-only CREATE reader/projector, not model arguments. */
export function buildCatalogCreateReviewManifest(input){
 object(input,['state','projection','codecDigest']);const {state,projection}=input;
 object(state,['version','revision','catalogRevision','mediaRevision','creationIdentity','normalizedInput','preparedInput','after','optionReview','source','metadata']);
 object(state.metadata,['version','request','predicates','revision','rows']);
 object(projection,['version','kind','revision','creationIdentity','before','after','beforeViews','afterViews','newProduct','physicalEffects','creationOrder','source','graphReadBytes']);
 object(projection.newProduct,['before','after','optionReview']);object(projection.source,['kind','anchorId','assets','sources']);
 const identity=plannedProductCreationIdentity(state.creationIdentity),existing=identity.targetListingId!==null;
 if(state.version!==1||projection.version!==1||projection.kind!=='CATALOG_CREATE_PRIVATE'||!sha.test(state.revision||'')||!sha.test(input.codecDigest||'')||
  projection.revision!==state.revision||!equal(identity,projection.creationIdentity)||projection.newProduct.before!==null||
  !equal(state.after,projection.newProduct.after)||!equal(state.optionReview,projection.newProduct.optionReview)||
  state.after.id!==identity.productId||state.after.listingId!==(identity.targetListingId??identity.newListingId))invalid();
 if(state.catalogRevision!==state.metadata?.revision||state.catalogRevision!==catalogCreateMetadataRevision(state.metadata)||!equal(state.normalizedInput,state.metadata.request.normalizedInput)||
  !equal(identity,state.metadata.request.creationIdentity)||state.revision!==catalogCreateMediaRevision({catalogRevision:state.catalogRevision,mediaRevision:state.mediaRevision,
   identity,prepared:state.preparedInput,after:state.after,optionReview:state.optionReview,order:state.source.order??[]}))invalid();
 const before=graph(projection.before,true),after=graph(projection.after),newProduct=after.products.get(identity.productId);
 if(!newProduct||before.products.has(identity.productId)||after.products.size!==before.products.size+1||after.products.size>MEDIA_LIMITS.products||after.listings.size!==1||
  !after.listings.has(state.after.listingId)||newProduct.mainAssetKey!==null||[...after.products.values()].some(row=>row.listingId!==state.after.listingId))invalid();
 object(projection.creationOrder,['kind','oldMembers','newProductId']);array(projection.physicalEffects,4);
 if(projection.creationOrder.kind!=='STRICT_LATER_AT_COMMIT'||projection.creationOrder.newProductId!==identity.productId)invalid();
 let snapshot,oldProducts=[];
 if(existing){
  object(state.source,['kind','anchorId','order','snapshot']);snapshot=state.source.snapshot;
  if(state.source.kind!=='EXISTING_TARGET'||projection.source.kind!=='EXISTING_TARGET'||projection.source.anchorId!==state.source.anchorId||
   !snapshot||snapshot.targetId!==state.source.anchorId||snapshot.revision!==state.mediaRevision||!before.products.has(state.source.anchorId)||before.listings.size!==1||!before.listings.has(identity.targetListingId))invalid();
  sameGraph(before,graph(snapshot.before));array(snapshot.products,MEDIA_LIMITS.products-1);oldProducts=snapshot.products;
  if(oldProducts.length!==before.products.size||oldProducts.some(row=>{const actual=state.metadata.rows.product.find(value=>value.id===row.productId);
   return !before.products.has(row.productId)||!actual||actual.listing_id!==row.listingId||actual.name!==row.name||actual.sku!==row.sku||actual.created_at!==row.createdAt;}))invalid();
  sameRows(projection.source.assets,snapshot.assets,32);sameRows(projection.source.sources,snapshot.sources,3300);
  sameRows(projection.creationOrder.oldMembers,state.source.order,299);
  const seen=new Set();for(const row of state.source.order){object(row,['productId','sku','createdAt']);const old=oldProducts.find(value=>value.productId===row.productId);
   if(!old||seen.has(row.productId)||row.sku!==old.sku||row.createdAt!==old.createdAt)invalid();seen.add(row.productId);}
  if(seen.size!==before.products.size||state.source.order[0]?.productId!==state.source.anchorId)invalid();
  const expectedViews=snapshot.views.map(row=>({productId:row.productId,role:row.role,holderId:row.holderId,visible:row.visible.map(({id,assetKey,shared})=>({id,assetKey,shared}))}));
  sameRows(projection.beforeViews,expectedViews,299);
 }else{
  object(state.source,['kind','listingId']);
  if(state.source.kind!=='EMPTY_BEFORE'||state.source.listingId!==identity.newListingId||projection.source.kind!=='EMPTY_BEFORE'||projection.source.anchorId!==null||
   before.products.size||before.listings.size||projection.source.assets.length||projection.source.sources.length||projection.physicalEffects.length)invalid();
  sameRows(projection.beforeViews,[],299);sameRows(projection.creationOrder.oldMembers,[],299);
 }
 if([...before.products].some(([id,row])=>!after.products.has(id)||after.products.get(id).mainAssetKey!==row.mainAssetKey||after.products.get(id).listingId!==row.listingId))invalid();
 const labels=catalogReviewLabels([...oldProducts.map(row=>({productId:row.productId,before:{sku:row.sku,name:row.name},after:{sku:row.sku,name:row.name}})),
  {productId:identity.productId,before:null,after:{sku:state.after.sku,name:state.after.name}}].sort((a,b)=>a.productId<b.productId?-1:1),'catalog.preview_create');
 const graphBytes=catalogMediaGraphBytes(projection.graphReadBytes);
 if(projection.graphReadBytes.beforeOldBytes!==(existing?snapshot.graphReadBytes.oldBytes:0)||existing&&snapshot.graphReadBytes.newBytes!==0)invalid();
 if(projection.graphReadBytes.afterOldBytes!==projection.graphReadBytes.beforeOldBytes+(existing?createCopyCost(projection.physicalEffects,snapshot,after.listings.get(identity.targetListingId).holderId):0))invalid();
 const binding=catalogMediaReviewBinding({toolName:'catalog.preview_create',creationIdentity:identity,baseRevision:state.revision,reviewLabels:labels,beforeViews:projection.beforeViews,afterViews:projection.afterViews});
 return assemble(input,before,after,labels,identity,graphBytes,binding,'catalog.preview_create');
}
