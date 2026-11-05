import { ApiError } from '../http.js';
import { plannedListingIdentity } from '../listings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { buildMediaManifest,mediaAssetKey } from './media-manifest.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { catalogReviewLabels,catalogMediaReviewBinding,catalogMediaGraphBytes } from './catalog-media-review-wire.js';

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
function graph(value){
 object(value,['products','listings']);array(value.products,MEDIA_LIMITS.products);array(value.listings,MEDIA_LIMITS.listings);
 if(!value.products.length||!value.listings.length)invalid();
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

function assemble(input,before,after,labels,identity,graphBytes,binding){
 const {snapshot,beforeGraph,projection}=input;
 const effects=labels.map(label=>{
  const old=before.products.get(label.productId),next=after.products.get(label.productId),oldView=beforeGraph.beforeViews.find(row=>row.productId===label.productId),
   nextView=projection.afterViews.find(row=>row.productId===label.productId),state=productState(next,nextView,after.listings.get(next.listingId));
  return{kind:'PRODUCT',productId:label.productId,before:productState(old,oldView,before.listings.get(old.listingId)),
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
 for(const asset of snapshot.assets){object(asset,sourceFields);const key=mediaAssetKey(asset.mime,asset.byte_sha256);
  if(!['PRODUCT_MAIN','GALLERY'].includes(asset.source_kind)||asset.stage_id!==null)invalid();
  if(!used.has(key))continue;
  if(!before.products.has(asset.source_product_id)||
   !snapshot.sources.some(source=>source&&sourceFields.every(field=>{
    const descriptor=Object.getOwnPropertyDescriptor(source,field);return descriptor&&Object.hasOwn(descriptor,'value')&&descriptor.value===asset[field];
   })))invalid();
  assets.push({...asset});used.delete(key);}
 if(used.size)invalid();
 const manifest=buildMediaManifest({toolName:'catalog.preview_update',graphRevision:binding.revision,codecDigest:input.codecDigest,graphBytes,assets,effects});
 return Object.freeze({manifest,...binding});
}
