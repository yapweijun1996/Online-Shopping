import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { getProduct,prepareProductUpdate,updateProduct,applyPlannedProductUpdate,addGalleryImage,setProductThumbnail } from '../src/products.js';
import { planMoveToListing } from '../src/listings.js';
import { readCatalogMediaState } from '../src/mcp/catalog-media-state.js';
import { readMediaUnionSnapshot } from '../src/mcp/media-resources.js';
import { readCatalogMediaBeforeGraph,projectCatalogMediaMove } from '../src/mcp/catalog-media-projection.js';
import { buildCatalogUpdateReviewManifest } from '../src/mcp/catalog-media-review-manifest.js';
import { assertCatalogReviewBinding } from '../src/mcp/catalog-media-review-wire.js';
import { trackUpdate } from '../src/product-history.js';
import { catalogWireInput,wireId } from './helpers/mcp-catalog-wire-fixture.js';
import { mediaAssetKey } from '../src/mcp/media-manifest.js';
const png=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
const photo=value=>'data:image/png;base64,'+Buffer.concat([png,Buffer.from(value)]).toString('base64');
test('SYNTHETIC pure300-product assembly compares complete bounded records within existing page caps',()=>{
 const asset=catalogWireInput().assets[0],key=mediaAssetKey(asset.mime,asset.byte_sha256),listingId=wireId(500),
  products=Array.from({length:300},(_,n)=>({productId:wireId(n+1),listingId,role:n?'variant':'holder',mainAssetKey:key})),
  before={products,listings:[{listingId,holderId:wireId(1),galleryAssetKeys:[]}]},
  views=products.map(row=>({productId:row.productId,role:row.role,holderId:wireId(1),visible:[{id:'main',assetKey:key,shared:false}]})),
  labels=products.map(row=>({productId:row.productId,before:{sku:'S',name:'N'},after:{sku:'S',name:'N'}})),revision='f'.repeat(64);
 const input={snapshot:{targetId:wireId(1),revision,before,products:products.map(row=>({...row,sku:'S',name:'N'})),assets:[asset],sources:[asset],graphReadBytes:{oldBytes:38400,newBytes:0}},
  beforeGraph:{version:1,mediaRevision:revision,before,beforeViews:views},projection:{version:1,mediaRevision:revision,before,after:before,afterViews:views,
   removedListingIds:[],physicalEffects:[],bindings:{newPrivateListing:false},graphReadBytes:{beforeOldBytes:38400,afterOldBytes:38400},catalogDependencies:{targetPlan:null,normalizedPatch:{name:'N'}}},
  reviewLabels:labels,plannedIdentity:null,baseRevision:'a'.repeat(64),codecDigest:'d'.repeat(64)};
 const value=buildCatalogUpdateReviewManifest(input);assert.equal(value.manifest.effects.length,301);assert.ok(value.manifest.pages.length<=16);
 assert.ok(value.manifest.pages.every(row=>Buffer.byteLength(row.page_json)<=16384));assert.equal(value.manifest.assets.length,1);
 const big=structuredClone(input);big.beforeGraph.before.products.push({...products[0],productId:wireId(999)});
 assert.throws(()=>buildCatalogUpdateReviewManifest(big),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
});
async function inputFor(store,id,changes){
 const current=await getProduct(store,id,true),patch=await prepareProductUpdate(store,current,changes),moved=Object.hasOwn(patch,'variantGroup')&&
  (patch.variantGroup||null)!==(current.variantGroup||null),targetPlan=moved?(await planMoveToListing(store,id,current.listingId,
   {...current,...patch,category:patch.category??current.categoryCode})).target:null;
 const plannedIdentity=targetPlan?.create?{productId:id,previousListingId:current.listingId,targetCode:targetPlan.code,newListingId:randomUUID()}:null;
 const state=await readCatalogMediaState(store,{productId:id,changes:patch,plannedIdentity}),snapshot=state.mediaSnapshot;
 const beforeGraph=await readCatalogMediaBeforeGraph(store,snapshot),projection=await projectCatalogMediaMove(store,snapshot,{productId:id,patch,targetPlan});
 const apply=()=>plannedIdentity?applyPlannedProductUpdate(store,{id,changes:patch},plannedIdentity):updateProduct(store,id,patch);
 // Independent oracle: run the actual service in a rolled-back transaction.
 // No hypothetical SQL rows or duplicated catalog normalization algorithm.
 let after;const rollback=new Error('Synthetic oracle rollback');
 await assert.rejects(store.transaction(async()=>{await apply();after=await store.all(`SELECT id,sku,name FROM product WHERE id IN (${snapshot.products.map(()=>'?').join(',')}) ORDER BY id`,...snapshot.products.map(row=>row.productId));throw rollback;}),error=>error===rollback);
 const reviewLabels=snapshot.products.map(row=>({productId:row.productId,before:{sku:row.sku,name:row.name},
  after:{sku:after.find(value=>value.id===row.productId).sku,name:after.find(value=>value.id===row.productId).name}}));
 return{snapshot,beforeGraph,projection,reviewLabels,plannedIdentity,baseRevision:state.revision,codecDigest:'d'.repeat(64),apply};
}
const assemble=input=>buildCatalogUpdateReviewManifest(Object.fromEntries(Object.entries(input).filter(([key])=>key!=='apply')));
async function actualAfter(store,input,manifest){
 const result=await trackUpdate(store,input.snapshot.targetId,'synthetic_owner',input.apply),source=input.beforeGraph.before.products.find(row=>row.productId===result.id).listingId,
  retained=await store.get('SELECT id FROM listing WHERE id=?',source),snapshot=await readMediaUnionSnapshot(store,result.id,{targetListingId:retained&&source!==result.listingId?source:null}),graph=await readCatalogMediaBeforeGraph(store,snapshot);
 for(const effect of manifest.effects){const id=effect.kind==='PRODUCT'?'productId':'listingId',rows=effect.kind==='PRODUCT'?graph.before.products:graph.before.listings,actual=rows.find(row=>row[id]===effect[id]);
  if(effect.after===null){assert.equal(actual,undefined);continue;}
  if(effect.kind==='LISTING')assert.deepEqual(effect.after,{holderId:actual.holderId,galleryAssetKeys:actual.galleryAssetKeys});
  else{const view=graph.beforeViews.find(row=>row.productId===actual.productId);assert.deepEqual(effect.after,{listingId:actual.listingId,role:actual.role,mainAssetKey:actual.mainAssetKey,ownMainVisible:view.visible.some(row=>row.id==='main')});}
 }
 return{result,snapshot};
}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: UPDATE union assembler filters unused physical assets and matches real target adoption/copy service`,options,async t=>{
  const f=await inventoryFixture(t,dialect),source=await f.product({name:'Source literal',variantGroup:'SOURCE',variantLabel:'A',imageDataUrl:photo('source')}),
   target=await f.product({name:'Target literal',variantGroup:'TARGET',variantLabel:'B',imageDataUrl:photo('target')});
  await addGalleryImage(f.store,source.id,photo('hidden'));await addGalleryImage(f.store,target.id,photo('shared'));
  await setProductThumbnail(f.store,source.id,photo('source-thumb'));
  await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify(['main']),source.id);
  const input=await inputFor(f.store,source.id,{variantGroup:'TARGET',variantLabel:'Moved'}),value=assemble(input),hidden=input.snapshot.sources.find(row=>row.source_kind==='GALLERY'&&row.source_product_id===source.id);
  assert.ok(input.projection.physicalEffects.some(row=>row.kind==='COPY_MAIN'));assert.ok(value.manifest.assets.every(row=>row.asset_key!==hidden.assetKey));
  assert.equal(value.manifest.stages.length,0);assert.equal(JSON.parse(value.manifest.pages[0].page_json).graphBytes.oldBytes,input.projection.graphReadBytes.afterOldBytes);
  assert.ok(input.projection.graphReadBytes.afterOldBytes>input.projection.graphReadBytes.beforeOldBytes);
  const main=input.snapshot.sources.find(row=>row.source_kind==='PRODUCT_MAIN'&&row.source_product_id===source.id);
  assert.equal(input.projection.graphReadBytes.afterOldBytes-input.projection.graphReadBytes.beforeOldBytes,main.byte_length+main.thumbnail.byte_length);
  assert.deepEqual(assertCatalogReviewBinding({toolName:'catalog.preview_update',resourceType:'product',resourceId:source.id,risk:'HIGH',expectedRevision:value.revision,
   proposal:{reviewLabels:input.reviewLabels,reviewBinding:value.reviewBinding,media:value.manifest.descriptor}},value.manifest),input.reviewLabels);
  const actual=await actualAfter(f.store,input,value.manifest);assert.equal(actual.result.name,'Target literal');assert.equal(actual.result.createdAt,source.createdAt);
  assert.equal(value.manifest.effects.find(row=>row.kind==='LISTING'&&row.listingId===source.listingId).after,null);
 });
 test(`${dialect}: private planned UUID creates literal listing state, source shrink and actual own-main visibility`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'A',imageDataUrl:photo('holder')}),
   variant=await f.product({imageDataUrl:photo('variant')});
  await addGalleryImage(f.store,variant.id,photo('hidden-own'));
  await updateProduct(f.store,variant.id,{variantGroup:'GROUP',variantLabel:'B'});
  const input=await inputFor(f.store,variant.id,{variantGroup:null}),value=assemble(input),created=value.manifest.effects.find(row=>row.kind==='LISTING'&&row.before===null);
  assert.equal(created.listingId,input.plannedIdentity.newListingId);assert.equal(created.after.holderId,null);assert.equal(created.after.galleryAssetKeys.length,2);
  assert.equal(value.manifest.effects.find(row=>row.kind==='PRODUCT'&&row.productId===variant.id).after.ownMainVisible,true);
  assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',created.listingId),undefined);
  const actual=await actualAfter(f.store,input,value.manifest);assert.equal(actual.result.listingId,created.listingId);assert.ok(await f.store.get('SELECT id FROM listing WHERE id=?',holder.listingId));
 });
 test(`${dialect}: SKU holder flip binds hidden-twin suppression and actual eleven-image visibility`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({sku:'AAA',variantGroup:'GROUP',variantLabel:'A',imageDataUrl:photo('holder')}),
   variant=await f.product({sku:'ZZZ',variantGroup:'GROUP',variantLabel:'B',imageDataUrl:photo('own')});
  for(let n=0;n<9;n++)await addGalleryImage(f.store,holder.id,photo('shared-'+n));
  const unchanged=await inputFor(f.store,variant.id,{sku:'ZZY'}),full=assemble(unchanged),own=full.manifest.effects.find(row=>row.productId===variant.id);
  assert.equal(own.before.ownMainVisible,true);assert.equal(unchanged.beforeGraph.beforeViews.find(row=>row.productId===variant.id).visible.length,11);
  const first=(await f.store.all('SELECT id FROM product_gallery_image WHERE product_id=? ORDER BY position',holder.id))[0];
  await f.store.run('UPDATE product_gallery_image SET data=? WHERE id=?',Buffer.from(photo('own').split(',')[1],'base64'),first.id);
  await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify([]),holder.id);
  await f.store.run('UPDATE product SET created_at=? WHERE listing_id=?','2026-01-01T00:00:00.000Z',holder.listingId);
  const input=await inputFor(f.store,variant.id,{sku:'000'}),value=assemble(input),effect=value.manifest.effects.find(row=>row.productId===variant.id);
  assert.ok(effect.before.mainAssetKey);assert.equal(effect.before.ownMainVisible,false);assert.equal(effect.after.role,'holder');
  await actualAfter(f.store,input,value.manifest);
 });
 test(`${dialect}: closed assembly rejects forged labels/views/sources/planned identities without writes`,options,async t=>{
  const f=await inventoryFixture(t,dialect),product=await f.product({imageDataUrl:photo('main')});
  const input=await inputFor(f.store,product.id,{variantGroup:'NEW-GROUP',variantLabel:'A'}),plain=Object.fromEntries(Object.entries(input).filter(([key])=>key!=='apply'));
  const before=await f.store.all('SELECT id,listing_id,updated_at FROM product ORDER BY id');
  for(const mutate of [value=>{value.extra=true;},value=>{value.projection.mediaRevision='f'.repeat(64);},value=>{value.beforeGraph.beforeViews=[];},
   value=>{value.reviewLabels[0].before.name='Unbound current name';},value=>{value.reviewLabels.push(value.reviewLabels[0]);},
   value=>{value.projection.afterViews[0].visible=[];},value=>{value.projection.after.products[0].mainAssetKey=null;},
   value=>{value.plannedIdentity.previousListingId=randomUUID();},value=>{value.plannedIdentity.targetCode='OTHER';},
   value=>{value.plannedIdentity.newListingId=product.listingId;},value=>{value.projection.catalogDependencies.targetPlan.code='OTHER';},
   value=>{value.projection.graphReadBytes.beforeOldBytes++;},value=>{value.projection.graphReadBytes.afterOldBytes=16777217;},
   value=>{value.snapshot.assets[0].byte_length++;},value=>{value.snapshot.assets[0].source_product_id=randomUUID();},
   value=>{value.snapshot.assets[0].source_kind='STAGE';},value=>{value.projection.removedListingIds=[];},
  ]){const value=structuredClone(plain);mutate(value);assert.throws(()=>buildCatalogUpdateReviewManifest(value));}
  assert.deepEqual(await f.store.all('SELECT id,listing_id,updated_at FROM product ORDER BY id'),before);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM listing')).n,1);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
}
