import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { applyPlannedProductCreate } from '../src/products.js';
import { createOptionType,createOptionValue } from '../src/options.js';
import { readCatalogCreateMediaState,catalogCreateMetadataRevision } from '../src/mcp/catalog-create-media-state.js';
import { projectCatalogMediaCreate } from '../src/mcp/catalog-media-projection.js';
import { buildCatalogCreateReviewManifest } from '../src/mcp/catalog-media-review-manifest.js';
import { assertCatalogReviewBinding } from '../src/mcp/catalog-media-review-wire.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { mediaManifestRows,readMediaManifest } from '../src/mcp/media-manifest.js';
import { rowsDigest } from '../src/sqlite-import.js';
const png=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url)),photo=label=>'data:image/png;base64,'+Buffer.concat([png,Buffer.from(label)]).toString('base64');
const input=(sku,extra={})=>({sku,name:'Requested copy',description:'Synthetic',category:'TEST',priceMinor:500,currency:'MYR',active:true,...extra});
const identity=(code=null,target=null)=>({version:1,productId:randomUUID(),targetCode:code,targetListingId:target?.listingId??null,newListingId:target?null:randomUUID()});
async function prepare(store,fields,context){const state=await readCatalogCreateMediaState(store,{normalizedInput:fields,creationIdentity:context}),projection=await projectCatalogMediaCreate(store,state);return {state,projection,codecDigest:'2'.repeat(64)};}
const envelope=(packet,result)=>({toolName:'catalog.preview_create',resourceType:'catalog',resourceId:'catalog',risk:'HIGH',expectedRevision:result.revision,
 proposal:{kind:'create',creationIdentity:packet.state.creationIdentity,normalizedInput:packet.state.normalizedInput,before:null,after:packet.state.after,optionReview:packet.state.optionReview,
 reviewLabels:result.manifest.effects.filter(row=>row.kind==='PRODUCT').map(row=>({productId:row.productId,...row.labels})),reviewBinding:result.reviewBinding,media:result.manifest.descriptor}});
async function upload(store,productId,position){const id=randomUUID();await store.run("INSERT INTO product_gallery_image(id,product_id,position,mime,data,created_at) VALUES(?,?,?,'image/png',?,'2026-01-01T00:00:00.000Z')",id,productId,position,Buffer.concat([png,Buffer.from('gallery-'+position)]));return id;}
test('raw metadata revision retains independently evaluated9557133 record stream bytes',()=>{
 const identity={version:1,productId:'00000000-0000-4000-8000-000000000001',targetCode:null,targetListingId:null,newListingId:'00000000-0000-4000-8000-000000000002'};
 const request={normalizedInput:input('HASH'),creationIdentity:identity};request.normalizedInput.name='Synthetic';
 const predicates={identity,productId:null,newListingId:null,targetByCodeId:null,targetById:null},rows={product:[],listing:[],general_code:[],option_type:[],option_value:[],product_option:[],company_setting:[{default_currency:'MYR'}]};
 // Actual git9557133 module evaluated independently with these raw source facts.
 assert.equal(catalogCreateMetadataRevision({request,predicates,rows}),'4a146da2a2716aa72c83c7d4755091a8257fbfe787373a46a3fe624ed90931d1');
});
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: CREATE assembler preserves actual private/new-group/existing COPY/hidden/full11 metadata and service AFTER`,options,async t=>{
  const f=await inventoryFixture(t,dialect);
  for(const mode of ['private','new-group','copy','hidden','full']){
   const group=mode==='private'?null:'GROUP-'+mode.toUpperCase();let target=null;
   if(!['private','new-group'].includes(mode))target=await f.product({variantGroup:group,variantLabel:'Old',name:'Adopted shared name',imageDataUrl:photo('main-'+mode),thumbDataUrl:photo('thumb-'+mode)});
   if(mode==='hidden'){const id=await upload(f.store,target.id,1);await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify([id]),target.id);}
   if(mode==='full'){await f.product({variantGroup:group,variantLabel:'Other'});await f.store.run('DELETE FROM product_gallery_image WHERE product_id=?',target.id);for(let n=1;n<=10;n++)await upload(f.store,target.id,n);await f.store.run('UPDATE product SET gallery_layout_json=NULL WHERE id=?',target.id);}
   const packet=await prepare(f.store,input('NEW-'+mode.toUpperCase(),{stockQuantity:4,...(group?{variantGroup:group,variantLabel:'New'}:{})}),identity(group,target)),before=rowsDigest(await f.store.all('SELECT * FROM product')),result=buildCatalogCreateReviewManifest(packet);
   assert.equal(rowsDigest(await f.store.all('SELECT * FROM product')),before);assert.equal(result.manifest.descriptor.graphRevision,result.revision);assert.ok(result.manifest.pages.length>=1);assert.equal(result.manifest.stages.length,0);assert.equal(result.manifest.effects.filter(row=>row.kind==='PRODUCT'&&row.before===null).length,1);
   assert.equal(assertCatalogReviewBinding(envelope(packet,result),result.manifest).length,packet.projection.after.products.length);
   const context={operationId:randomUUID(),toolName:'catalog.preview_create',createdAt:'2026-11-05T00:00:00.000Z',expiresAt:'2026-11-05T00:10:00.000Z'},operation={id:context.operationId,tool_name:context.toolName,media_policy_id:'catalog-media-v1',required_scope:'catalog.write',required_capability:'catalog.write',risk:'HIGH',created_at:context.createdAt,expires_at:context.expiresAt};
   assert.deepEqual(readMediaManifest(mediaManifestRows(result.manifest,context),operation),result.manifest);
   const actual=await applyPlannedProductCreate(f.store,packet.state.normalizedInput,packet.state.creationIdentity),snapshot=await readMediaSnapshot(f.store,actual.id);
   assert.equal(actual.name,packet.state.after.name);assert.equal(actual.variantLabel,packet.state.after.variantLabel);assert.equal(actual.stockQuantity,4);
   for(const effect of result.manifest.effects){if(effect.kind==='PRODUCT'){const row=snapshot.before.products.find(row=>row.productId===effect.productId),view=snapshot.views.find(row=>row.productId===effect.productId),{ownMainVisible,...physical}=effect.after;assert.deepEqual(row,{productId:effect.productId,...physical});assert.equal(ownMainVisible,view.visible.some(row=>row.id==='main'));
     const listing=result.manifest.effects.find(row=>row.kind==='LISTING'&&row.listingId===physical.listingId).after,expected=physical.role==='single'?listing.galleryAssetKeys:[...(ownMainVisible?[physical.mainAssetKey]:[]),...listing.galleryAssetKeys];assert.deepEqual(view.visible.map(row=>row.assetKey),expected);
    }else assert.deepEqual(snapshot.before.listings.find(row=>row.listingId===effect.listingId),{listingId:effect.listingId,...effect.after});}
   if(mode==='private'||mode==='new-group'){assert.equal(result.manifest.assets.length,0);assert.equal(result.manifest.effects.length,2);}if(mode==='full')assert.equal(snapshot.views.find(row=>row.productId===target.id).visible.length,11);
  }
 });
 test(`${dialect}: CREATE assembler binds resolved option labels while applying canonical input`,options,async t=>{
  const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Colour'}),value=await createOptionValue(f.store,type.id,{label:'Blue'}),packet=await prepare(f.store,input('OPTIONS',{variantGroup:'OPTIONS',variantLabel:'Canonical base',options:[{typeId:type.id,valueId:value.id}]}),identity('OPTIONS'));
  const result=buildCatalogCreateReviewManifest(packet),proposal=envelope(packet,result);assert.equal(proposal.proposal.after.variantLabel,'Blue');assert.equal(proposal.proposal.normalizedInput.variantLabel,'Canonical base');assert.equal(proposal.proposal.optionReview.after[0].valueLabel,'Blue');assertCatalogReviewBinding(proposal,result.manifest);
  const actual=await applyPlannedProductCreate(f.store,packet.state.normalizedInput,packet.state.creationIdentity);assert.equal(actual.variantLabel,proposal.proposal.after.variantLabel);
 });
 test(`${dialect}: CREATE assembler rejects packet splicing stages aliases altered revisions copy/thumb costs and raw metadata`,options,async t=>{
  const f=await inventoryFixture(t,dialect),target=await f.product({variantGroup:'GROUP',variantLabel:'Old',imageDataUrl:photo('main'),thumbDataUrl:photo('thumb')}),packet=await prepare(f.store,input('NEW',{variantGroup:'GROUP',variantLabel:'New'}),identity('GROUP',target)),before=rowsDigest(await f.store.all('SELECT * FROM product'));
  for(const [index,mutate] of [value=>value.state.catalogRevision='f'.repeat(64),value=>value.state.normalizedInput.name='Changed request',value=>value.state.after.name='Changed final',value=>value.projection.creationIdentity.productId=randomUUID(),value=>value.projection.after.products.pop(),value=>value.projection.graphReadBytes.afterOldBytes--,
   value=>value.projection.source.assets[0].stage_id=randomUUID(),value=>value.projection.source.assets[0].url='https://untrusted.invalid',value=>value.projection.physicalEffects.find(row=>row.kind==='COPY_MAIN').thumbnail.byte_sha256='f'.repeat(64),value=>value.projection.physicalEffects.push({kind:'AUTHORIZE',approved:true}),value=>value.projection.newProduct.before={},value=>value.state.source.snapshot.products[0].name='Forged old label'].entries()){
   const bad=structuredClone(packet);mutate(bad);assert.throws(()=>buildCatalogCreateReviewManifest(bad),'Mutation '+index);
  }
  assert.equal(rowsDigest(await f.store.all('SELECT * FROM product')),before);assert.ok(buildCatalogCreateReviewManifest(packet).manifest.pages.length);
 });
}
