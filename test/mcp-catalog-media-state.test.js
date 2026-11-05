import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { readCatalogMediaMetadata,readCatalogMediaState,CATALOG_STATE_LIMITS } from '../src/mcp/catalog-media-state.js';
import { canonicalOperationJson } from '../src/mcp/operation-envelope.js';
import { createOptionType,createOptionValue } from '../src/options.js';
import { addGalleryImage,setGalleryThumbnail,applyPlannedProductUpdate,requireUniqueProductSku,hasProductSkuConflict,updateProduct } from '../src/products.js';
const png=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
const photo=bytes=>'data:image/png;base64,'+bytes.toString('base64');
const hash=value=>createHash('sha256').update(value).digest('hex');
const input=(source,changes={name:'Normalized name'},plannedIdentity=null)=>({productId:source.id,changes,plannedIdentity});
function observed(store){
 const calls=[];return {calls,read:{dialect:store.dialect,get:(sql,...args)=>{assert.match(sql,/^SELECT\b/);calls.push(sql);return store.get(sql,...args);},all:(sql,...args)=>{assert.match(sql,/^SELECT\b/);calls.push(sql);return store.all(sql,...args);}}};
}
async function fixture(t,dialect){
 const f=await inventoryFixture(t,dialect),source=await f.product({variantGroup:'SOURCE',variantLabel:'Source',stockQuantity:5,imageDataUrl:photo(png)}),target=await f.product({variantGroup:'TARGET',variantLabel:'Target',stockQuantity:null});
 const intent=input(source,{variantGroup:'TARGET',variantLabel:'Moved'});return {...f,source,target,intent};
}
async function fillMembers(f){
 await f.store.transaction(async()=>{for(let n=0;n<298;n++){
  const template=n%2?f.source:f.target;
  await f.store.run(`INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,variant_group,variant_label,stock_quantity,listing_id,created_at,updated_at)
   SELECT ?,?,name,description,category,price_minor,currency,active,variant_group,?,stock_quantity,listing_id,created_at,updated_at FROM product WHERE id=?`,randomUUID(),'CLONE-'+String(n).padStart(4,'0'),'Clone '+n,template.id);
 }});
}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: SELECT-only full metadata and exact composite framing`,options,async t=>{
  const f=await fixture(t,dialect),type=await createOptionType(f.store,{name:'Complete type label'}),value=await createOptionValue(f.store,type.id,{label:'Complete value label'});
  f.intent.changes.options=[{typeId:type.id,valueId:value.id}];const guard=observed(f.store);
  const result=await f.store.transaction(()=>readCatalogMediaState(guard.read,f.intent));
  assert.deepEqual(result.metadata.selector.listingIds,[f.source.listingId,f.target.listingId].sort());assert.equal(result.mediaSnapshot.version,2);
  assert.equal(result.metadata.rows.product.length,2);assert.equal(result.metadata.rows.option_type[0].name,'Complete type label');
  assert.equal(result.metadata.rows.option_value[0].label,'Complete value label');assert.equal(result.metadata.rows.option_value[0].active,1);
  assert.equal(result.metadata.predicates.targetCode.listingId,f.target.listingId);assert.equal(result.metadata.predicates.sku.conflict,false);assert.equal(result.metadata.predicates.label.conflict,false);
  assert.equal(result.revision,hash(canonicalOperationJson({version:1,kind:'catalog-media-update',productId:f.source.id,intentHash:result.metadata.intentHash,catalogRevision:result.catalogRevision,mediaRevision:result.mediaRevision})));
  assert.equal((await f.store.transaction(()=>readCatalogMediaState(f.store,JSON.parse(JSON.stringify(f.intent))))).revision,result.revision);
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.metadata.rows.product),true);
  const metadataCalls=observed(f.store);await f.store.transaction(()=>readCatalogMediaMetadata(metadataCalls.read,f.intent));
  assert.ok(metadataCalls.calls.every(sql=>!/^SELECT .*\b(?:image_data|thumb_data)\b/i.test(sql)));
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: target-code and server UUID absence are independent hashed facts with no allocation`,options,async t=>{
  const f=await fixture(t,dialect),identity={productId:f.source.id,previousListingId:f.source.listingId,targetCode:'FUTURE',newListingId:randomUUID()},intent=input(f.source,{variantGroup:'FUTURE',variantLabel:'Moved'},identity);
  const before=await f.store.transaction(()=>readCatalogMediaState(f.store,intent));
  assert.equal(before.mediaSnapshot.version,1);assert.equal(before.metadata.predicates.targetCode.listingId,null);
  assert.equal(before.metadata.predicates.plannedCreation.lookup.existing,null);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',identity.newListingId),undefined);
  const occupying=await f.product({variantGroup:'OCCUPY',variantLabel:'Other'});
  await applyPlannedProductUpdate(f.store,{id:occupying.id,changes:{variantGroup:null}},{productId:occupying.id,previousListingId:occupying.listingId,targetCode:null,newListingId:identity.newListingId});
  const occupied=await f.store.transaction(()=>readCatalogMediaState(f.store,intent));assert.notEqual(occupied.catalogRevision,before.catalogRevision);assert.equal(occupied.metadata.predicates.targetCode.listingId,null);
  assert.equal(occupied.metadata.predicates.plannedCreation.lookup.existing.id,identity.newListingId);
  const target=await f.product({variantGroup:'FUTURE',variantLabel:'Other'}),codeChanged=await f.store.transaction(()=>readCatalogMediaState(f.store,intent));
  assert.notEqual(codeChanged.revision,occupied.revision);assert.equal(codeChanged.metadata.predicates.targetCode.listingId,target.listingId);
  assert.equal((await f.store.get('SELECT listing_id FROM product WHERE id=?',f.source.id)).listing_id,f.source.listingId);
 });
 test(`${dialect}: omitted options bind current mappings and libraries without inventing AFTER clearing`,options,async t=>{
  const f=await fixture(t,dialect),type=await createOptionType(f.store,{name:'Current option type'}),value=await createOptionValue(f.store,type.id,{label:'Current option value'});
  await updateProduct(f.store,f.source.id,{options:[{typeId:type.id,valueId:value.id}]});
  const literal=JSON.stringify(f.intent.changes),before=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));
  assert.equal(before.rows.product_option.length,1);assert.equal(before.rows.option_type[0].id,type.id);assert.equal(before.rows.option_value[0].id,value.id);
  assert.equal(JSON.stringify(f.intent.changes),literal);assert.equal(Object.hasOwn(f.intent.changes,'options'),false);
  await f.store.run('UPDATE option_value SET translations_json=? WHERE id=?',JSON.stringify({en:'Changed complete translation'}),value.id);
  const after=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));assert.notEqual(after.revision,before.revision);
  assert.equal(after.rows.product_option.length,1);assert.equal(Object.hasOwn(after,'after'),false);
 });
 test(`${dialect}: hidden physical thumbnails bind the composite without timestamp or catalog metadata changes`,options,async t=>{
  const f=await fixture(t,dialect);await addGalleryImage(f.store,f.source.id,photo(Buffer.concat([png,Buffer.from('hidden')])));
  // Supported legacy selection can hide a still-physical association.
  await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify(['main']),f.source.id);
  const gallery=await f.store.get('SELECT id FROM product_gallery_image WHERE product_id=?',f.source.id),before=await f.store.transaction(()=>readCatalogMediaState(f.store,f.intent));
  const time=(await f.store.get('SELECT updated_at FROM product WHERE id=?',f.source.id)).updated_at;
  await setGalleryThumbnail(f.store,f.source.id,gallery.id,photo(Buffer.concat([png,Buffer.from('fresh thumbnail')])));
  const after=await f.store.transaction(()=>readCatalogMediaState(f.store,f.intent));
  assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id=?',f.source.id)).updated_at,time);
  assert.equal(after.catalogRevision,before.catalogRevision);assert.notEqual(after.mediaRevision,before.mediaRevision);assert.notEqual(after.revision,before.revision);
  assert.ok(after.mediaSnapshot.sources.some(source=>source.source_id===gallery.id&&source.thumbnail.byte_sha256));
 });
 test(`${dialect}: joint catalog preflight rejects UTF8 and cross-table budgets before materializing text or images`,options,async t=>{
  const f=await fixture(t,dialect);
  for(const kind of ['joint','unicode']){
   const text=kind==='joint'?'x'.repeat(700000):'漢'.repeat(300000);
   await f.store.run('UPDATE product SET description=? WHERE id=?',text,f.source.id);
   await f.store.run('UPDATE listing SET translations_json=? WHERE id=?',JSON.stringify({en:text}),f.target.listingId);
   const guard=observed(f.store);
   await assert.rejects(f.store.transaction(()=>readCatalogMediaState(guard.read,f.intent)),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
   assert.equal(guard.calls.some(sql=>sql.startsWith('SELECT id, sku, name')),false);
   assert.equal(guard.calls.some(sql=>sql.includes(' AS media_bytes')),false);
   await f.store.run("UPDATE product SET description='Synthetic' WHERE id=?",f.source.id);await f.store.run("UPDATE listing SET translations_json='{}' WHERE id=?",f.target.listingId);
  }
  await f.store.run('UPDATE listing SET translations_json=? WHERE id=?',JSON.stringify({en:'x'.repeat(70000)}),f.target.listingId);
  await assert.rejects(f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent)),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
 });
 test(`${dialect}: individually bounded products and dictionaries share ONE8MiB catalog preflight`,options,async t=>{
  const f=await fixture(t,dialect);await fillMembers(f);const ids=(await f.store.all('SELECT id FROM product ORDER BY id')).map(row=>row.id),templates=[];
  for(let n=0;n<6;n++){const type=await createOptionType(f.store,{name:'Bound type '+n}),value=await createOptionValue(f.store,type.id,{label:'Template'});templates.push({type,value});}
  await f.store.transaction(async()=>{
   await f.store.run('UPDATE product SET description=?','x'.repeat(2000));
   for(let n=0;n<ids.length;n++)for(let k=0;k<templates.length;k++){
    const {type,value}=templates[k],id=randomUUID();
    await f.store.run(`INSERT INTO option_value(id,option_type_id,code,label,translations_json,swatch_color,position,active,created_at,updated_at)
     SELECT ?,?,?,?, ?,swatch_color,?,active,created_at,updated_at FROM option_value WHERE id=?`,id,type.id,'value-'+n,'Value '+n,JSON.stringify({en:'x'.repeat(450)}),n+1,value.id);
    await f.store.run('INSERT INTO product_option(product_id,option_type_id,option_value_id) VALUES(?,?,?)',ids[n],type.id,id);
   }
  });
  const guard=observed(f.store),statistics=[],get=guard.read.get;
  guard.read.get=async(sql,...args)=>{const result=await get(sql,...args);if(sql.startsWith('SELECT COUNT(*)'))statistics.push({sql,...result});return result;};
  await assert.rejects(f.store.transaction(()=>readCatalogMediaState(guard.read,f.intent)),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
  for(const table of ['product','option_value']){const stat=statistics.find(value=>value.sql.includes(' FROM '+table+' WHERE'));
   assert.ok(stat);assert.ok(Number(stat.bytes)*6<CATALOG_STATE_LIMITS.metadataBytes);assert.ok(Number(stat.row_bytes)*6<65536);}
  assert.equal(guard.calls.some(sql=>sql.startsWith('SELECT id, sku, name')),false);assert.equal(guard.calls.some(sql=>sql.includes(' AS media_bytes')),false);
 });
 test(`${dialect}: source and target share one300-member cap with complete bounded metadata pages`,options,async t=>{
  const f=await fixture(t,dialect);
  await fillMembers(f);
  const guard=observed(f.store),state=await f.store.transaction(()=>readCatalogMediaMetadata(guard.read,f.intent));
  assert.equal(state.rows.product.length,CATALOG_STATE_LIMITS.members);assert.equal(guard.calls.filter(sql=>sql.startsWith('SELECT id, sku, name')).length,2);
  const id=randomUUID();await f.store.run(`INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,variant_group,variant_label,stock_quantity,listing_id,created_at,updated_at)
   SELECT ?,'CLONE-OVERFLOW',name,description,category,price_minor,currency,active,variant_group,'Overflow',stock_quantity,listing_id,created_at,updated_at FROM product WHERE id=?`,id,f.target.id);
  const rejected=observed(f.store);await assert.rejects(f.store.transaction(()=>readCatalogMediaState(rejected.read,f.intent)),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
  assert.equal(rejected.calls.some(sql=>sql.startsWith('SELECT id, sku, name')),false);assert.equal(rejected.calls.some(sql=>sql.includes(' AS media_bytes')),false);
 });
 test(`${dialect}: metadata/B1 phase tuple substitution rejects a mixed snapshot and rolls back`,options,async t=>{
  const f=await fixture(t,dialect),guard=observed(f.store),get=guard.read.get;let injected=false;
  guard.read.get=async(sql,...args)=>{
   if(!injected&&sql.startsWith('SELECT id, substr(listing_id')){injected=true;await f.store.run('UPDATE product SET name=? WHERE id=?','Changed between phases',f.source.id);}
   return get(sql,...args);
  };
  await assert.rejects(f.store.transaction(()=>readCatalogMediaState(guard.read,f.intent)),{status:409,code:'CATALOG_DEPENDENCY_CHANGED'});
  assert.equal(injected,true);assert.equal((await f.store.get('SELECT name FROM product WHERE id=?',f.source.id)).name,f.source.name);
 });
 test(`${dialect}: normalized intent is closed and same-source/private selection never invents a listing`,options,async t=>{
  const f=await fixture(t,dialect),privateProduct=await f.product();
  const privateState=await f.store.transaction(()=>readCatalogMediaState(f.store,input(privateProduct,{sku:'PRIVATE-RENAMED'})));
  assert.equal(privateState.mediaSnapshot.version,1);assert.deepEqual(privateState.metadata.selector.listingIds,[privateProduct.listingId]);
  assert.equal(privateState.metadata.selector.targetListingId,privateProduct.listingId);assert.equal(privateState.metadata.predicates.membershipChanges,false);
  assert.equal(await readCatalogMediaMetadata(f.store,input({id:randomUUID()})),null);
  for(const bad of [{...f.intent,targetListingId:f.target.listingId},{...f.intent,approved:true},input(f.source,{sku:'lowercase'}),
   input(f.source,{stockQuantity:5}),input(f.source,{imageDataUrl:'https://invalid.example/image'}),input(f.source,{}),
   {...f.intent,changes:{...f.intent.changes,policyId:'catalog-media-v1'}}]){
   await assert.rejects(f.store.transaction(()=>readCatalogMediaState(f.store,bad)),{status:400,code:'CATALOG_STATE_INPUT'});
  }
  const orphan=await f.product({variantGroup:'OUTSIDE',variantLabel:'Outside'});
  await f.store.run("UPDATE product SET variant_group='TARGET' WHERE id=?",orphan.id);
  await assert.rejects(f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent)),{status:409,code:'CATALOG_DEPENDENCY_CHANGED'});
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: canonical escaping/null metadata stays complete and stock changes only invalidate rather than write`,options,async t=>{
  const f=await fixture(t,dialect),escaped='"\\\n\u0001漢'.repeat(400);
  // Historical JSON/text is read as inert data; this is not a portal-valid PATCH.
  await f.store.run('UPDATE listing SET translations_json=? WHERE id=?',JSON.stringify({en:escaped}),f.target.listingId);
  const first=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));
  assert.equal(JSON.parse(first.rows.listing.find(row=>row.id===f.target.listingId).translations_json).en,escaped);
  assert.ok(first.rows.product.some(row=>row.stock_quantity===null));
  await f.store.run('UPDATE product SET stock_quantity=6 WHERE id=?',f.source.id);
  const next=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));assert.notEqual(next.revision,first.revision);
  assert.equal(Object.hasOwn(f.intent.changes,'stockQuantity'),false);assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',f.source.id)).stock_quantity,6);
 });
 test(`${dialect}: dictionaries, copy drift, company currency and exact SKU/label predicates bind revision`,options,async t=>{
  const f=await fixture(t,dialect),type=await createOptionType(f.store,{name:'Type'}),value=await createOptionValue(f.store,type.id,{label:'Value'});
  f.intent.changes={...f.intent.changes,sku:'PROPOSED',options:[{typeId:type.id,valueId:value.id}]};
  let prior=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));
  for(const [sql,...args] of [
   ['UPDATE listing SET description=? WHERE id=?','Authoritative target description',f.target.listingId],
   ['UPDATE product SET name=? WHERE id=?','Legacy source copy',f.source.id],
   ['UPDATE option_type SET name=?,active=0 WHERE id=?','Changed full type',type.id],
   ['UPDATE option_value SET label=?,code=?,active=0 WHERE id=?','Changed full value','changed-code',value.id],
   ["UPDATE general_code SET label=? WHERE type='PRODUCT_CATEGORY' AND code='TEST'",'Changed category label'],
   ["UPDATE company_setting SET default_currency='SGD' WHERE id=1"],
  ]){await f.store.run(sql,...args);const next=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));assert.notEqual(next.revision,prior.revision,sql);prior=next;}
  await f.store.run("UPDATE company_setting SET default_currency='MYR' WHERE id=1");
  await f.product({sku:'PROPOSED'});const collision=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));
  assert.equal(collision.predicates.sku.conflict,true);assert.equal(await hasProductSkuConflict(f.store,'PROPOSED',f.source.id),true);await assert.rejects(requireUniqueProductSku(f.store,'PROPOSED',f.source.id),{code:'DUPLICATE_SKU'});
  await f.product({variantGroup:'TARGET',variantLabel:'mOvEd'});const labelCollision=await f.store.transaction(()=>readCatalogMediaMetadata(f.store,f.intent));assert.equal(labelCollision.predicates.label.conflict,true);assert.notEqual(labelCollision.revision,collision.revision);
 });
}
