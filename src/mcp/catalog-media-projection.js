import { ApiError } from '../http.js';
import { validateProductInput } from '../product-input.js';
import { planMoveToListing } from '../listings.js';
import { galleryHolderFromOrderedMembers,galleryLayoutIds,sharedGalleryItems,planSharedGallerySelection } from '../product-gallery.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { mediaAssetKey } from './media-manifest.js';
import { MEDIA_LIMITS } from './media-schema.js';

// Internal metadata planning only. No tool, authority, native work or write token.
const changed=()=>{throw new ApiError(409,'MEDIA_PROJECTION_CHANGED','Catalog media changed. Prepare a fresh projection.');};
const unsupported=()=>{throw new ApiError(409,'MEDIA_PROJECTION_UNSUPPORTED','Catalog media requires supported internal planning data.');};
const limited=()=>{throw new ApiError(503,'MEDIA_PROJECTION_LIMIT','Catalog media exceeds its complete projection budget.');};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,sha=/^[0-9a-f]{64}$/;
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const text=(v,max,nullable=false)=>nullable&&v===null||typeof v==='string'&&v.isWellFormed()&&v.length<=max;
const validId=v=>typeof v==='string'&&uuid.test(v);
const equal=(a,b)=>{try{return canonicalOperationJson(a)===canonicalOperationJson(b);}catch{return false;}};
const key=v=>`${v.source_kind}:${v.source_product_id}:${v.source_id}`;
const ref=v=>Object.fromEntries(['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'].map(k=>[k,v[k]]));
function json(value){try{return JSON.parse(canonicalOperationJson(value));}catch{unsupported();}}
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(k=>!keys.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))unsupported();}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function selector(snapshot,productId,sourceListingId,targetListingId){
 if(!snapshot||snapshot.targetId!==productId||!validId(productId)||!validId(sourceListingId)||targetListingId!==null&&!validId(targetListingId)||!sha.test(snapshot.revision||'')||!sha.test(snapshot.structureRevision||''))unsupported();
 const ids=[...new Set([sourceListingId,...(targetListingId===null?[]:[targetListingId])])].sort();
 if(ids.length===1){if(snapshot.version!==1||Object.hasOwn(snapshot,'capture'))changed();}
 else if(snapshot.version!==2||!equal(snapshot.capture,{sourceListingId,listingIds:ids}))changed();
 if(!Array.isArray(snapshot.listings)||snapshot.listings.length!==ids.length||!equal(snapshot.listings.map(r=>r?.id).sort(),ids)||!Array.isArray(snapshot.products)||snapshot.products.length<1||snapshot.products.length>MEDIA_LIMITS.products)changed();
 const seen=new Set();for(const row of snapshot.products){if(!row||typeof row!=='object'||!validId(row.productId)||seen.has(row.productId)||!ids.includes(row.listingId)||!text(row.sku,40)||!text(row.createdAt,24))unsupported();seen.add(row.productId);}
 if(!seen.has(productId)||ids.some(id=>!snapshot.products.some(r=>r.listingId===id)))changed();
 return ids;
}

// Caller holds its lifecycle/store fence. This uses real SQL and validates current
// tuples; no synthetic reader, JavaScript re-sort or hypothetical SQL row exists.
export async function readProjectedListingOrder(read,snapshot,input){
 object(input,['productId','targetListingId','sku']);if(Object.keys(input).length!==3||!validId(input.productId)||!text(input.sku,40)||!input.sku.length)unsupported();
 const current=await read.get('SELECT id,listing_id,sku,created_at FROM product WHERE id=?',input.productId);if(!current)changed();
 const ids=selector(snapshot,input.productId,current.listing_id,input.targetListingId);
 const rows=await read.all(`SELECT id,listing_id AS current_listing_id,sku AS current_sku,created_at,
  CASE WHEN id=? THEN ? ELSE listing_id END AS projected_listing_id,
  CASE WHEN id=? THEN ? ELSE sku END AS projected_sku
  FROM product WHERE listing_id IN (${ids.map(()=>'?').join(',')})
  ORDER BY CASE WHEN (CASE WHEN id=? THEN ? ELSE listing_id END) IS NULL THEN 1 ELSE 0 END,
   projected_listing_id,created_at,projected_sku,id LIMIT ${MEDIA_LIMITS.products+1}`,
 input.productId,input.targetListingId,input.productId,input.sku,...ids,input.productId,input.targetListingId);
 if(rows.length>MEDIA_LIMITS.products)limited();if(rows.length!==snapshot.products.length)changed();
 const captured=new Map(snapshot.products.map(row=>[row.productId,row])),seen=new Set(),groups=new Map();
 for(const row of rows){const before=captured.get(row.id);if(!before||seen.has(row.id)||row.current_listing_id!==before.listingId||row.current_sku!==before.sku||row.created_at!==before.createdAt)changed();seen.add(row.id);
  const listingId=row.projected_listing_id;if(listingId!==null&&!ids.includes(listingId))changed();
  if(!groups.has(listingId))groups.set(listingId,[]);groups.get(listingId).push(row.id);
 }
 return freeze({rows:rows.map(row=>({productId:row.id,currentListingId:row.current_listing_id,currentSku:row.current_sku,createdAt:row.created_at,listingId:row.projected_listing_id,sku:row.projected_sku})),groups:[...groups].map(([listingId,memberIds])=>({listingId,memberIds}))});
}

async function currentProduct(read,id){
 const sizes=await read.get('SELECT length(name) AS name_length,length(description) AS description_length,length(category) AS category_length FROM product WHERE id=?',id);
 if(!sizes)changed();if(Number(sizes.name_length)>120||Number(sizes.description_length)>2000||Number(sizes.category_length)>80)unsupported();
 const row=await read.get('SELECT id,listing_id,sku,created_at,variant_group,name,description,category FROM product WHERE id=?',id);if(!row)changed();return row;
}
async function targetPlan(read,current,patch,passed){
 const groupChange=Object.hasOwn(patch,'variantGroup')&&patch.variantGroup!==current.variant_group;
 if(!groupChange){if(passed!==null)unsupported();return{groupChange:false,targetListingId:current.listing_id,plan:null};}
 if(patch.variantGroup!==null){const size=await read.get('SELECT length(name) AS name_length,length(description) AS description_length,length(category) AS category_length FROM listing WHERE code=?',patch.variantGroup);if(size&&(Number(size.name_length)>120||Number(size.description_length)>2000||Number(size.category_length)>80))unsupported();}
 const fresh=await planMoveToListing(read,current.id,current.listing_id,{...current,...patch});
 if(!equal(json(passed),fresh.target))changed();
 return{groupChange:true,targetListingId:fresh.target.listing.id,plan:fresh.target};
}
function model(snapshot){
 if(!Array.isArray(snapshot.sources)||snapshot.sources.length>MEDIA_LIMITS.products*(MEDIA_LIMITS.newAssets+1)||!Array.isArray(snapshot.galleries)||snapshot.galleries.length>MEDIA_LIMITS.products*MEDIA_LIMITS.newAssets)unsupported();
 object(snapshot.before,['products','listings']);
 if(!snapshot.before||!Array.isArray(snapshot.before.products)||!Array.isArray(snapshot.before.listings)||snapshot.before.products.length!==snapshot.products.length||snapshot.before.listings.length!==snapshot.listings.length)unsupported();
 for(const p of snapshot.products)if(p.layout!==null&&!Array.isArray(p.layout))unsupported();
 if(!equal(snapshot.before.products.map(row=>row?.productId).sort(),snapshot.products.map(row=>row.productId).sort())||!equal(snapshot.before.listings.map(row=>row?.listingId).sort(),snapshot.listings.map(row=>row.id).sort()))unsupported();
 const products=new Map(snapshot.products.map(p=>[p.productId,{...p,layout:p.layout===null?null:[...p.layout]}])),sources=new Map(),galleries=new Map([...products.keys()].map(id=>[id,[]]));let bytes=0;
 for(const s of snapshot.sources){object(s,['source_kind','source_id','source_product_id','stage_id','mime','byte_length','thumbnail','byte_sha256','assetKey','width','height','dimensionsVerified']);if(!s||!['PRODUCT_MAIN','GALLERY'].includes(s.source_kind)||!validId(s.source_id)||!products.has(s.source_product_id)||s.stage_id!==null||!['image/png','image/jpeg','image/webp'].includes(s.mime)||!integer(s.byte_length,1)||s.byte_length>MEDIA_LIMITS.sourceBytes||!sha.test(s.byte_sha256||'')||s.assetKey!==mediaAssetKey(s.mime,s.byte_sha256)||s.source_kind==='PRODUCT_MAIN'&&s.source_id!==s.source_product_id||sources.has(key(s)))unsupported();
  if(s.thumbnail!==null)object(s.thumbnail,['mime','byte_length','byte_sha256']);
  if(s.thumbnail&&(!['image/png','image/jpeg','image/webp'].includes(s.thumbnail.mime)||!integer(s.thumbnail.byte_length,1)||s.thumbnail.byte_length>MEDIA_LIMITS.thumbnailBytes||!sha.test(s.thumbnail.byte_sha256||'')))unsupported();
  sources.set(key(s),{...s,thumbnail:s.thumbnail===null?null:{mime:s.thumbnail.mime,byte_length:s.thumbnail.byte_length,byte_sha256:s.thumbnail.byte_sha256}});bytes+=s.byte_length+(s.thumbnail?.byte_length||0);if(!integer(bytes)||bytes>MEDIA_LIMITS.oldBytes)limited();
 }
 const seen=new Set();for(const g of snapshot.galleries){object(g,['galleryId','productId','position','createdAt','source']);if(!g)unsupported();const owner=galleries.get(g.productId),source=sources.get(g.source);if(!owner||!validId(g.galleryId)||seen.has(g.galleryId)||!integer(g.position,1)||g.position>MEDIA_LIMITS.newAssets||owner.some(row=>row.position===g.position)||!source||source.source_kind!=='GALLERY'||source.source_product_id!==g.productId||source.source_id!==g.galleryId)unsupported();seen.add(g.galleryId);owner.push({...g});}
 for(const p of products.values()){if(p.mainSource!==null){const main=sources.get(p.mainSource);if(!main||main.source_kind!=='PRODUCT_MAIN'||main.source_product_id!==p.productId)unsupported();}const owned=galleries.get(p.productId);owned.sort((a,b)=>a.position-b.position);if(owned.length>MEDIA_LIMITS.newAssets||!Array.isArray(p.layout)&&p.layout!==null||p.layout&&(new Set(p.layout).size!==p.layout.length||p.layout.some(id=>id==='main'?!p.mainSource:!owned.some(g=>g.galleryId===id))))unsupported();}
 if([...sources.values()].filter(s=>s.source_kind==='PRODUCT_MAIN').length!==[...products.values()].filter(p=>p.mainSource).length||snapshot.galleries.length!==[...sources.values()].filter(s=>s.source_kind==='GALLERY').length||bytes!==snapshot.graphReadBytes?.oldBytes||snapshot.graphReadBytes.newBytes!==0)unsupported();
 for(const row of snapshot.before.products)object(row,['productId','listingId','role','mainAssetKey']);for(const row of snapshot.before.listings)object(row,['listingId','holderId','galleryAssetKeys']);
 const beforeProducts=new Map(snapshot.before.products.map(row=>[row.productId,row]));
 for(const p of products.values()){const before=beforeProducts.get(p.productId);if(!before||before.listingId!==p.listingId||!['single','holder','variant'].includes(before.role)||before.mainAssetKey!==(p.mainSource?sources.get(p.mainSource).assetKey:null))unsupported();}
 for(const listing of snapshot.before.listings){const members=[...products.values()].filter(p=>p.listingId===listing.listingId);if(!members.length||!Array.isArray(listing.galleryAssetKeys)||listing.galleryAssetKeys.length>MEDIA_LIMITS.newAssets||listing.galleryAssetKeys.some(k=>!sha.test(k)||![...sources.values()].some(s=>s.assetKey===k))||(members.length===1?listing.holderId!==null:!members.some(p=>p.productId===listing.holderId)))unsupported();for(const p of members)if(beforeProducts.get(p.productId).role!==(members.length===1?'single':p.productId===listing.holderId?'holder':'variant'))unsupported();}
 if(new Set([...sources.values()].map(source=>source.assetKey)).size>MEDIA_LIMITS.oldAssets)limited();return{products,sources,galleries,bytes};
}
function graph(model,groups){
 const products=[],listings=[],views=[];
 for(const group of groups){const holderId=galleryHolderFromOrderedMembers(group.memberIds.map(id=>({id}))),holder=model.products.get(holderId||group.memberIds[0]),uploads=model.galleries.get(holder.productId),main=holder.mainSource&&model.sources.get(holder.mainSource);
  const selected=galleryLayoutIds(holder.layout,holderId===null&&Boolean(main),uploads.map(g=>g.galleryId));
  const shared=selected.filter(id=>!holderId||id!=='main').map(id=>{const s=id==='main'?main:model.sources.get(uploads.find(g=>g.galleryId===id)?.source);if(!s)unsupported();return{id,assetKey:s.assetKey};});
  if(shared.length>MEDIA_LIMITS.newAssets)unsupported();listings.push({listingId:group.listingId,holderId,galleryAssetKeys:shared.map(item=>item.assetKey)});
  for(const productId of group.memberIds){const p=model.products.get(productId),own=p.mainSource&&model.sources.get(p.mainSource),same=own&&uploads.some(g=>model.sources.get(g.source).byte_sha256===own.byte_sha256),visible=holderId?sharedGalleryItems(own?{id:'main',assetKey:own.assetKey}:null,shared,same):shared;
   if(visible.length>MEDIA_LIMITS.newAssets+1)unsupported();views.push({productId,role:holderId===null?'single':holderId===productId?'holder':'variant',holderId,visible:visible.map(item=>({id:item.id,assetKey:item.assetKey,shared:item.shared===true}))});products.push({productId,listingId:group.listingId,role:holderId===null?'single':holderId===productId?'holder':'variant',mainAssetKey:own?.assetKey||null});
  }
 }
 return{views:views.sort((a,b)=>a.productId<b.productId?-1:1),products:products.sort((a,b)=>a.productId<b.productId?-1:1),listings:listings.sort((a,b)=>a.listingId===null?1:b.listingId===null?-1:a.listingId<b.listingId?-1:1)};
}

export async function projectCatalogMediaMove(read,snapshot,input){
 object(input,['productId','targetPlan','patch']);if(Object.keys(input).length!==3||!validId(input.productId)||input.productId!==snapshot?.targetId)unsupported();
 const patch=json(input.patch);object(patch,['sku','name','description','category','priceMinor','currency','active','variantGroup','variantLabel','options']);if(!Object.keys(patch).length||Object.hasOwn(patch,'variantGroup')&&!text(patch.variantGroup,40,true)||Object.hasOwn(patch,'sku')&&(!text(patch.sku,40)||!patch.sku.length))unsupported();
 try{if(!equal(patch,validateProductInput(patch,[patch.currency??'MYR'],{partial:true})))unsupported();}catch{unsupported();}
 const current=await currentProduct(read,input.productId),target=await targetPlan(read,current,patch,input.targetPlan);
 selector(snapshot,input.productId,current.listing_id,target.targetListingId);
 const beforeProduct=snapshot.products.find(p=>p.productId===input.productId);if(current.variant_group!==beforeProduct.variantGroup)changed();
 const ordered=await readProjectedListingOrder(read,snapshot,{productId:input.productId,targetListingId:target.targetListingId,sku:patch.sku??current.sku}),state=model(snapshot),physicalEffects=[];
 for(const row of ordered.rows){const p=state.products.get(row.productId);p.listingId=row.listingId;p.sku=row.sku;}
 if(target.groupChange){const group=ordered.groups.find(g=>g.listingId===target.targetListingId),holderId=galleryHolderFromOrderedMembers(group.memberIds.map(id=>({id})));
  if(holderId){const holder=state.products.get(holderId),main=holder.mainSource&&state.sources.get(holder.mainSource),uploads=state.galleries.get(holderId),plan=planSharedGallerySelection({holderId,layout:holder.layout,mainSha256:main?.byte_sha256||null,uploads:uploads.map(g=>({id:g.galleryId,byteSha256:state.sources.get(g.source).byte_sha256}))});
   if(plan.pendingRef){if(!main)unsupported();const position=Math.max(0,...uploads.map(g=>g.position))+1;if(position>MEDIA_LIMITS.newAssets)unsupported();const copy={...main,source_kind:'GALLERY',source_id:plan.pendingRef},source=key(copy);state.sources.set(source,copy);uploads.push({galleryId:plan.pendingRef,productId:holderId,position,source});state.bytes+=copy.byte_length+(copy.thumbnail?.byte_length||0);physicalEffects.push({kind:'COPY_MAIN',productId:holderId,ref:plan.pendingRef,source:ref(main),thumbnail:main.thumbnail?{...main.thumbnail}:null,position});}
   if(plan.writeLayout){holder.layout=[...plan.selected];physicalEffects.push({kind:'SET_LAYOUT',productId:holderId,selected:[...plan.selected]});}
  }
 }
 if(state.bytes>MEDIA_LIMITS.oldBytes||state.sources.size>MEDIA_LIMITS.products*(MEDIA_LIMITS.newAssets+1)||ordered.groups.length>MEDIA_LIMITS.listings)limited();
 const projected=graph(state,ordered.groups),after={products:projected.products,listings:projected.listings},removedListingIds=snapshot.listings.map(l=>l.id).filter(id=>!ordered.groups.some(group=>group.listingId===id));
 const result={version:1,mediaRevision:snapshot.revision,before:snapshot.before,after,afterViews:projected.views,removedListingIds,physicalEffects,bindings:{newPrivateListing:target.targetListingId===null},graphReadBytes:{beforeOldBytes:snapshot.graphReadBytes.oldBytes,afterOldBytes:state.bytes},catalogDependencies:{targetPlan:target.plan,normalizedPatch:patch}};
 if(Buffer.byteLength(JSON.stringify(result))>MEDIA_LIMITS.records*MEDIA_LIMITS.pageBytes)limited();return freeze(result);
}
