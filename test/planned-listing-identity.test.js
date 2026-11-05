import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { applyPlannedProductUpdate, updateProduct, getProduct } from '../src/products.js';
import { plannedListingIdentity, planMoveToListing } from '../src/listings.js';
import { trackUpdate } from '../src/product-history.js';
import { createOptionType, createOptionValue } from '../src/options.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { FieldError } from '../src/validation.js';
import { createApi } from '../src/app.js';
import { setupShop } from '../src/shop-setup.js';
const conflict={status:409,code:'LISTING_PLAN_CONFLICT'};
const context=(product,targetCode=null)=>({productId:product.id,previousListingId:product.listingId,targetCode,newListingId:randomUUID()});
const apply=(f,product,changes,identity=context(product))=>applyPlannedProductUpdate(f.store,{id:product.id,changes},identity);
async function state(store){return Promise.all(['product','listing','product_gallery_image','product_option','product_event','inventory_state','inventory_movement'].map(async table=>rowsDigest(await store.all('SELECT * FROM '+table+' ORDER BY '+(table==='inventory_state'?'product_id':table==='product_option'?'product_id,option_type_id':'id')))));}
const semantics=product=>Object.fromEntries(['name','description','categoryCode','priceMinor','currency','active','stockQuantity','variantGroup','variantLabel'].map(key=>[key,product[key]]));
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: exact server listing identity matches ordinary update without ghost allocation or hidden history`,options,async t=>{
  const f=await inventoryFixture(t,dialect),fields={variantGroup:'SOURCE',variantLabel:'Original',stockQuantity:5};
  const planned=await f.product(fields),ordinary=await f.product({...fields,variantGroup:'PORTAL'}),identity=context(planned);
  const before=await state(f.store),plan=await planMoveToListing(f.store,planned.id,planned.listingId,{...planned,category:planned.categoryCode,variantGroup:null,variantLabel:null});
  assert.equal(plan.target.create,true);assert.equal(plan.target.listing.id,null);assert.deepEqual(await state(f.store),before);
  assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',identity.newListingId),undefined);
  const stock=await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),movement=await f.store.all('SELECT * FROM inventory_movement ORDER BY id');
  const changes={variantGroup:'',name:'Explicit new listing name'},actual=await apply(f,planned,changes,identity),portal=await updateProduct(f.store,ordinary.id,changes);
  assert.equal(actual.listingId,identity.newListingId);assert.notEqual(portal.listingId,identity.newListingId);assert.deepEqual(semantics(actual),semantics(portal));
  assert.equal(actual.createdAt,planned.createdAt);assert.equal(actual.variantLabel,null);assert.deepEqual(actual.options,[]);
  assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',planned.listingId),undefined);
  assert.deepEqual(await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),stock);assert.deepEqual(await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),movement);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);await assert.rejects(apply(f,planned,changes,identity),conflict);
 });
 test(`${dialect}: empty new group uses server UUID and live source-sibling check with caller history`,options,async t=>{
  const f=await inventoryFixture(t,dialect),source=await f.product({variantGroup:'SOURCE',variantLabel:'First',stockQuantity:5}),identity=context(source,'NEW-GROUP');
  const sibling=await f.product({variantGroup:'SOURCE',variantLabel:'Second',stockQuantity:null});
  const actual=await trackUpdate(f.store,source.id,'synthetic_owner',()=>apply(f,source,{variantGroup:'NEW-GROUP',variantLabel:'Moved'},identity));
  assert.equal(actual.listingId,identity.newListingId);assert.equal(actual.createdAt,source.createdAt);assert.equal((await f.store.get('SELECT code FROM listing WHERE id=?',identity.newListingId)).code,'NEW-GROUP');
  assert.ok(await f.store.get('SELECT id FROM listing WHERE id=?',source.listingId));assert.equal((await getProduct(f.store,sibling.id,true)).listingId,source.listingId);
  const event=await f.store.get('SELECT actor,action,changes FROM product_event WHERE product_id=?',source.id);assert.equal(event.actor,'synthetic_owner');assert.equal(event.action,'UPDATED');assert.deepEqual(JSON.parse(event.changes),[{field:'variantLabel',from:'First',to:'Moved'}]);
  assert.equal(actual.stockQuantity,5);assert.equal((await getProduct(f.store,sibling.id,true)).stockQuantity,null);
 });
 test(`${dialect}: appearing target code, occupied UUID and changed source conflict without adoption or fallback`,options,async t=>{
  const f=await inventoryFixture(t,dialect);
  for(const kind of ['code','uuid','source','same-group','wrong-code','wrong-product','missing-product']){
   const source=await f.product({variantGroup:'SOURCE-'+kind.toUpperCase(),variantLabel:'Original',stockQuantity:5}),identity=context(source,'NEW-'+kind.toUpperCase());let changes={variantGroup:identity.targetCode,variantLabel:'Moved'},id=source.id;
   if(kind==='code')await f.product({variantGroup:identity.targetCode,variantLabel:'Other'});
   if(kind==='uuid')identity.newListingId=(await f.product()).listingId;
   if(kind==='source')await updateProduct(f.store,source.id,{variantGroup:'',variantLabel:null});
   if(kind==='same-group'){changes={variantGroup:source.variantGroup};identity.targetCode=source.variantGroup;}
   if(kind==='wrong-code')identity.targetCode='DIFFERENT';if(kind==='wrong-product')id=(await f.product()).id;if(kind==='missing-product')id=identity.productId=randomUUID();
   const before=await state(f.store);await assert.rejects(applyPlannedProductUpdate(f.store,{id,changes},identity),conflict,kind);assert.deepEqual(await state(f.store),before,kind);
  }
 });
 test(`${dialect}: concurrent planned new-group creation has one exact UUID winner and no silent adoption`,options,async t=>{
  const f=await inventoryFixture(t,dialect),products=await Promise.all(['A','B'].map(label=>f.product({variantGroup:'RACE-'+label,variantLabel:label,stockQuantity:5})));
  const identities=products.map(product=>context(product,'NEW-RACE'));
  const results=await Promise.allSettled(products.map((product,index)=>apply(f,product,{variantGroup:'NEW-RACE',variantLabel:'Moved-'+index},identities[index])));
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.filter(value=>value.status==='rejected').length,1);
  const winner=results.findIndex(value=>value.status==='fulfilled'),loser=1-winner;
  assert.equal(results[winner].value.listingId,identities[winner].newListingId);assert.equal(results[loser].reason.code,'LISTING_PLAN_CONFLICT');
  assert.equal((await f.store.get("SELECT id FROM listing WHERE code='NEW-RACE'")).id,identities[winner].newListingId);
  assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',identities[loser].newListingId),undefined);
  assert.equal((await getProduct(f.store,products[loser].id,true)).listingId,products[loser].listingId);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
 });
 test(`${dialect}: context and input are closed and ordinary fields cannot supply planned identity`,options,async t=>{
  const f=await inventoryFixture(t,dialect),product=await f.product({variantGroup:'ORIGINAL',variantLabel:'Original'}),identity=context(product);let getterRead=false;
  const accessor={...identity};Object.defineProperty(accessor,'newListingId',{enumerable:true,get(){getterRead=true;return randomUUID();}});
  for(const bad of [{...identity,approved:true},{...identity,tenantId:'foreign'},{...identity,newListingId:product.listingId},{...identity,targetCode:''},{...identity,targetCode:'lowercase'},{...identity,newListingId:randomUUID().toUpperCase()},{...identity,[Symbol('extra')]:true},Object.assign(Object.create({}),identity),accessor])assert.throws(()=>plannedListingIdentity(bad),conflict);
  assert.equal(getterRead,false);assert.equal(Object.isFrozen(plannedListingIdentity(identity)),true);const before=await state(f.store);
  for(const input of [{id:product.id,changes:{variantGroup:''},newListingId:identity.newListingId},{id:product.id,changes:{variantGroup:''},context:identity},{id:product.id,changes:{variantGroup:'',stockQuantity:5}}])await assert.rejects(applyPlannedProductUpdate(f.store,input,identity),conflict);
  for(const changes of [{variantGroup:'',newListingId:identity.newListingId},{variantGroup:'',context:identity},{variantGroup:'',approved:true}]){await assert.rejects(apply(f,product,changes,identity),error=>error instanceof FieldError);await assert.rejects(updateProduct(f.store,product.id,changes),error=>error instanceof FieldError);}
  assert.deepEqual(await state(f.store),before);
 });
 test(`${dialect}: faults after new listing INSERT and source DELETE restore all state and reusable server ID`,options,async t=>{
  const f=await inventoryFixture(t,dialect);
  for(const fault of ['INSERT INTO listing','DELETE FROM listing']){
   const source=await f.product({variantGroup:'SOURCE-'+(fault.startsWith('INSERT')?'INSERT':'DELETE'),variantLabel:'Original',stockQuantity:5}),identity=context(source),before=await state(f.store),run=f.store.run;let injected=false;
   f.store.run=async(sql,...args)=>{const result=await run(sql,...args);if(sql.startsWith(fault)){injected=true;throw new Error('Synthetic post-listing-write fault');}return result;};
   try{await assert.rejects(trackUpdate(f.store,source.id,'synthetic_owner',()=>apply(f,source,{variantGroup:''},identity)),/Synthetic post-listing-write fault/);}finally{f.store.run=run;}
   assert.equal(injected,true);assert.deepEqual(await state(f.store),before);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',identity.newListingId),undefined);assert.equal((await apply(f,source,{variantGroup:''},identity)).listingId,identity.newListingId);
  }
 });
 test(`${dialect}: existing option validation/drop and stock ledger/history stay on shared service path`,options,async t=>{
  const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Colour'}),red=await createOptionValue(f.store,type.id,{label:'Red'});
  const source=await f.product({variantGroup:'OPTIONS',options:[{typeId:type.id,valueId:red.id}],stockQuantity:5}),identity=context(source);
  const invalid=await f.product({variantGroup:'INVALID',variantLabel:'Original',stockQuantity:5}),badIdentity=context(invalid,'NEW-INVALID'),before=await state(f.store);
  await assert.rejects(apply(f,invalid,{variantGroup:badIdentity.targetCode,options:[{typeId:randomUUID(),valueId:randomUUID()}]},badIdentity),error=>error instanceof FieldError&&error.field==='options');assert.deepEqual(await state(f.store),before);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',badIdentity.newListingId),undefined);
  const stock=await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),movements=await f.store.all('SELECT * FROM inventory_movement ORDER BY id');
  const actual=await trackUpdate(f.store,source.id,'synthetic_owner',()=>apply(f,source,{variantGroup:''},identity));assert.deepEqual(actual.options,[]);assert.equal(actual.variantLabel,null);assert.equal(actual.stockQuantity,5);
  assert.deepEqual(await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),stock);assert.deepEqual(await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),movements);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?',source.id)).n,1);
  await trackUpdate(f.store,source.id,'synthetic_owner',()=>updateProduct(f.store,source.id,{stockQuantity:7}));assert.equal((await getProduct(f.store,source.id,true)).stockQuantity,7);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement WHERE product_id=?',source.id)).n,2);
 });
 test(`${dialect}: seller HTTP PATCH rejects new-ID/context fields under the ordinary route contract`,options,async t=>{
  const f=await inventoryFixture(t,dialect),product=await f.product({variantGroup:'HTTP-SOURCE',variantLabel:'Original'});await setupShop(f.store,{mode:'production',shopName:'Synthetic identity shop'});
  const origin='https://seller.example.test',api=await createApi({store:f.store,config:{sellerOrigin:origin,publicOrigin:origin,shopMode:'manual'}});
  const login=await api(new Request(origin+'/api/v1/seller/session',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({username:'synthetic_owner',password:'SyntheticInventoryPassword123!'})}));assert.equal(login.status,200);
  const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0],before=await state(f.store);
  for(const patch of [{variantGroup:'',newListingId:randomUUID()},{variantGroup:'',context:context(product)}]){
   const response=await api(new Request(origin+'/api/v1/seller/products/'+product.id,{method:'PATCH',headers:{'content-type':'application/json',origin,cookie,'x-csrf-token':session.csrfToken},body:JSON.stringify(patch)}));assert.equal(response.status,400);assert.deepEqual(await state(f.store),before);
  }
 });
}
