import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { createProduct,applyPlannedProductCreate,preparePlannedProductCreate,updateProduct,getProduct } from '../src/products.js';
import { plannedProductCreationIdentity,planProductCreationListing } from '../src/listings.js';
import { createOptionType,createOptionValue,requireGroupOptions } from '../src/options.js';
import { withInventoryContext } from '../src/inventory.js';
import { trackCreate } from '../src/product-history.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { FieldError } from '../src/validation.js';
import { createApi } from '../src/app.js';
import { setupShop } from '../src/shop-setup.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
const conflict={status:409,code:'PRODUCT_CREATE_PLAN_CONFLICT'};
const input=(sku,extra={})=>({sku,name:'Synthetic planned product',description:'Synthetic description',category:'TEST',priceMinor:500,active:true,...extra});
const identity=(code=null,target=null)=>({version:1,productId:randomUUID(),targetCode:code,targetListingId:target?.listingId??null,newListingId:target?null:randomUUID()});
const tables=['product','listing','product_gallery_image','product_option','product_event','inventory_coverage','inventory_state','inventory_movement'];
const state=store=>Promise.all(tables.map(async table=>[table,rowsDigest(await store.all('SELECT * FROM '+table))]));
const semantics=value=>Object.fromEntries(['name','description','categoryCode','priceMinor','currency','active','stockQuantity','variantLabel','options'].map(key=>[key,value[key]]));
const rollback=async(store,work)=>{const done=new Error('Synthetic comparison rollback');let value;await assert.rejects(store.transaction(async()=>{value=await work();throw done;}),error=>error===done);return value;};
async function writes(store,work){const run=store.run,sql=[];store.run=(query,...args)=>{sql.push(query.replace(/\s+/g,' ').trim());return run(query,...args);};try{return{value:await work(),sql};}finally{store.run=run;}}
const photo=await readFile(new URL('../public/shop/icons/icon-192.png',import.meta.url));
const imageDataUrl='data:image/png;base64,'+photo.toString('base64');
for(const dialect of ['sqlite','postgres']) {
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: planned plain and new-group creation use exact server IDs with ordinary service semantics`,options,async t=>{
  const f=await inventoryFixture(t,dialect);
  for(const group of [null,'PLANNED-GROUP']) {
   const fields=input(group?'GROUP-SKU':'PLAIN-SKU',{stockQuantity:0,...(group?{variantGroup:group,variantLabel:'Blue'}:{})}),context=identity(group),before=await state(f.store);
   const select=method=>(sql,...args)=>{assert.match(sql,/^SELECT\b/);assert.equal(sql.includes(';'),false);return f.store[method](sql,...args);};
   const prepared=await preparePlannedProductCreate({dialect,get:select('get'),all:select('all')},fields,context);assert.deepEqual(await state(f.store),before);
   assert.equal(prepared.currency,'MYR');assert.equal(prepared.stockQuantity,0);
   const listingPlan=await planProductCreationListing(f.store,prepared,context);assert.equal(listingPlan.create,true);assert.equal(listingPlan.listing.id,null);
   const baseline=await writes(f.store,()=>rollback(f.store,()=>createProduct(f.store,fields))),ordinary=baseline.value;assert.deepEqual(await state(f.store),before);
   const planned=await writes(f.store,()=>applyPlannedProductCreate(f.store,fields,context)),actual=planned.value;assert.deepEqual(planned.sql,baseline.sql);
   assert.deepEqual(semantics(actual),semantics(ordinary));assert.equal(actual.id,context.productId);assert.equal(actual.listingId,context.newListingId);
   assert.equal(actual.variantGroup,group);assert.notEqual(ordinary.id,context.productId);assert.notEqual(ordinary.listingId,context.newListingId);
   const ledger=await f.store.get('SELECT kind,reason_code,before_quantity,after_quantity,revision FROM inventory_movement WHERE product_id=?',actual.id);
   assert.deepEqual({...ledger},{kind:'INITIALIZED',reason_code:'PRODUCT_CREATE',before_quantity:null,after_quantity:0,revision:1});
   assert.equal((await f.store.get('SELECT COUNT(*) n FROM product_event')).n,0);
   await assert.rejects(applyPlannedProductCreate(f.store,fields,context),conflict);
  }
 });
 test(`${dialect}: joining a group adopts real listing copy, preserves holder order and shares exact old main and thumbnail`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'SHARED',variantLabel:'First',name:'Authoritative group',description:'Authoritative description',imageDataUrl,thumbDataUrl:imageDataUrl,stockQuantity:9});
  const future='2030-01-01T00:00:00.000Z';await f.store.run('UPDATE product SET created_at=?,updated_at=? WHERE id=?',future,future,holder.id);
  const fields=input('JOINED',{variantGroup:'SHARED',variantLabel:'Second',name:'Requested duplicate name',description:'Requested duplicate description',stockQuantity:null}),context=identity('SHARED',holder);
  const before=await state(f.store),prepared=await preparePlannedProductCreate(f.store,fields,context);assert.deepEqual(await state(f.store),before);
  assert.equal((await planProductCreationListing(f.store,prepared,context)).create,false);
  const ordinary=await rollback(f.store,()=>createProduct(f.store,fields)),actual=await applyPlannedProductCreate(f.store,fields,context);
  assert.deepEqual(semantics(actual),semantics(ordinary));assert.equal(actual.name,'Authoritative group');assert.equal(actual.description,'Authoritative description');
  assert.equal(actual.id,context.productId);assert.equal(actual.listingId,holder.listingId);assert.equal(actual.galleryHolderId,holder.id);assert.equal(actual.createdAt,'2030-01-01T00:00:00.001Z');
  assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',holder.id)).stock_quantity,9);
  const copies=await f.store.all('SELECT product_id,mime,data,thumb_mime,thumb_data FROM product_gallery_image');assert.equal(copies.length,1);
  assert.equal(copies[0].product_id,holder.id);assert.deepEqual(Buffer.from(copies[0].data),photo);assert.deepEqual(Buffer.from(copies[0].thumb_data),photo);
  assert.equal((await getProduct(f.store,holder.id,true)).galleryHolderId,holder.id);assert.equal((await f.store.get('SELECT COUNT(*) n FROM listing')).n,1);
  const third=await applyPlannedProductCreate(f.store,input('THIRD',{variantGroup:'SHARED',variantLabel:'Third'}),identity('SHARED',holder));
  assert.equal(third.galleryHolderId,holder.id);assert.equal(third.createdAt,'2030-01-01T00:00:00.002Z');assert.equal((await f.store.get('SELECT COUNT(*) n FROM product_gallery_image')).n,1);
 });
 test(`${dialect}: pure planned preparation uses absent non-null ID for all existing option rules`,options,async t=>{
  const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Colour'}),red=await createOptionValue(f.store,type.id,{label:'Red'}),blue=await createOptionValue(f.store,type.id,{label:'  Blue  '}),other=await createOptionType(f.store,{name:'Size'}),small=await createOptionValue(f.store,other.id,{label:'S'});
  const holder=await f.product({variantGroup:'OPTIONS',options:[{typeId:type.id,valueId:red.id}]}),context=identity('OPTIONS',holder),fields=input('OPTION-JOIN',{variantGroup:'OPTIONS',options:[{typeId:type.id,valueId:blue.id}]}),before=await state(f.store);
  await requireGroupOptions(f.store,null,'OPTIONS',false); // Demonstrates why NULL cannot be preparation evidence.
  await assert.rejects(preparePlannedProductCreate(f.store,input('MISSING',{variantGroup:'OPTIONS',variantLabel:'Manual'}),context),{code:'OPTIONS_REQUIRED'});
  for(const patch of [{options:[{typeId:type.id,valueId:red.id}]},{options:[{typeId:other.id,valueId:small.id}]},{options:[{typeId:type.id,valueId:randomUUID()}]},{options:[{typeId:type.id,valueId:blue.id},{typeId:type.id,valueId:red.id}]}])await assert.rejects(preparePlannedProductCreate(f.store,{...fields,...patch},context));
  for(const [table,id]of [['option_value',blue.id],['option_type',type.id]]){
   await f.store.run(`UPDATE ${table} SET active=0 WHERE id=?`,id);
   await assert.rejects(preparePlannedProductCreate(f.store,fields,context),error=>error instanceof FieldError&&error.field==='options');
   await f.store.run(`UPDATE ${table} SET active=1 WHERE id=?`,id);
  }
  assert.deepEqual(await state(f.store),before);const prepared=await preparePlannedProductCreate(f.store,fields,context);assert.equal(prepared.variantLabel,'Blue');assert.equal(await f.store.get('SELECT id FROM product WHERE id=?',context.productId),undefined);
  const ordinary=await rollback(f.store,()=>createProduct(f.store,fields)),actual=await applyPlannedProductCreate(f.store,prepared,context);assert.deepEqual(semantics(actual),semantics(ordinary));assert.equal(actual.variantLabel,'Blue');
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM product_option WHERE product_id=?',actual.id)).n,1);
 });
 test(`${dialect}: strict identity and metadata input reject getters unknown IDs media stages and ordinary HTTP context`,options,async t=>{
  const f=await inventoryFixture(t,dialect),context=identity(),fields=input('CLOSED'),before=await state(f.store);let touched=false;
  const accessor={...context};Object.defineProperty(accessor,'productId',{enumerable:true,get(){touched=true;return randomUUID();}});
  for(const bad of [{...context,version:2},{...context,approved:true},{...context,[Symbol('extra')]:true},Object.assign(Object.create({}),context),accessor,{...context,productId:'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'},{...context,targetCode:''},{...context,targetCode:'lowercase'},{...context,targetListingId:randomUUID()},{...context,newListingId:null}])assert.throws(()=>plannedProductCreationIdentity(bad),conflict);
  assert.equal(touched,false);assert.equal(Object.isFrozen(plannedProductCreationIdentity(context)),true);
  const getter={...fields};Object.defineProperty(getter,'name',{enumerable:true,get(){touched=true;return 'hidden';}});
  const option={typeId:randomUUID()};Object.defineProperty(option,'valueId',{enumerable:true,get(){touched=true;return randomUUID();}});
  for(const extra of [{id:context.productId},{productId:context.productId},{context},{newListingId:context.newListingId},{imageDataUrl},{thumbDataUrl:imageDataUrl},{image:photo},{bytes:photo},{stageId:randomUUID()},{gallery:[]},{scope:'catalog.write'},getter,{...fields,options:[option]}])await assert.rejects(applyPlannedProductCreate(f.store,extra===getter?getter:{...fields,...extra},context),conflict);
  assert.equal(touched,false);assert.deepEqual(await state(f.store),before);
  await setupShop(f.store,{mode:'production',shopName:'Synthetic'});const api=await createApi({store:f.store,config:{publicOrigin:'http://fixture.test',sellerOrigin:'http://fixture.test',mcpEnabled:false}});
  const login=await api(new Request('http://fixture.test/api/v1/seller/session',{method:'POST',headers:{'content-type':'application/json',origin:'http://fixture.test'},body:JSON.stringify({username:'synthetic_owner',password:'SyntheticInventoryPassword123!'})}));assert.equal(login.status,200);
  const headers={'content-type':'application/json',origin:'http://fixture.test',cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await login.json()).csrfToken};
  for(const extra of [{context},{id:context.productId},{productId:context.productId},{newListingId:context.newListingId}]){
    const response=await api(new Request('http://fixture.test/api/v1/seller/products',{method:'POST',headers,body:JSON.stringify({...fields,...extra})}));assert.equal(response.status,400);
  }
  assert.equal(await f.store.get('SELECT id FROM product WHERE id=?',context.productId),undefined);
 });
 test(`${dialect}: target/code and planned UUID changes conflict instead of adopting or reallocating`,options,async t=>{
  const f=await inventoryFixture(t,dialect);
  for(const kind of ['code-appears','new-listing-id','product-id','wrong-target','code-disappears','wrong-code']) {
   const fields=input('CONFLICT-'+kind.toUpperCase(),{variantGroup:'GROUP-'+kind.toUpperCase(),variantLabel:'New'});
   let context=identity(fields.variantGroup),holder;
   if(['wrong-target','code-disappears','wrong-code'].includes(kind)){holder=await f.product({variantGroup:fields.variantGroup,variantLabel:'Old'});context=identity(fields.variantGroup,holder);}
   await preparePlannedProductCreate(f.store,fields,context);
   if(kind==='code-appears')await f.product({variantGroup:fields.variantGroup,variantLabel:'Old'});
   if(kind==='new-listing-id')context.newListingId=(await f.product()).listingId;
   if(kind==='product-id')context.productId=(await f.product()).id;
   if(kind==='wrong-target')context.targetListingId=(await f.product()).listingId;
   if(kind==='code-disappears')await updateProduct(f.store,holder.id,{variantGroup:'',variantLabel:null});
   if(kind==='wrong-code')context.targetCode='DIFFERENT';
   const before=await state(f.store);await assert.rejects(applyPlannedProductCreate(f.store,fields,context),conflict);assert.deepEqual(await state(f.store),before);
  }
 });
 test(`${dialect}: concurrent planned code and product-ID races have one exact winner with no orphan fallback`,options,async t=>{
  const f=await inventoryFixture(t,dialect),other=dialect==='postgres'?await openPostgresDatabase(f.location):f.store;
  try{for(const kind of ['code','product']){
   const contexts=[identity(kind==='code'?'RACE':null),identity(kind==='code'?'RACE':null)];if(kind==='product')contexts[1].productId=contexts[0].productId;
   const results=await Promise.allSettled(contexts.map((context,index)=>applyPlannedProductCreate(index?other:f.store,input('RACE-'+kind.toUpperCase()+index,{...(kind==='code'?{variantGroup:'RACE',variantLabel:'Variant'+index}:{})}),context)));
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const winner=results.findIndex(r=>r.status==='fulfilled'),loser=1-winner;
   assert.equal(results[winner].value.id,contexts[winner].productId);assert.equal(results[winner].value.listingId,contexts[winner].newListingId);assert.equal(results[loser].reason.code,conflict.code);
   assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',contexts[loser].newListingId),undefined);
  }}finally{if(other!==f.store)await other.close();}
 });
 test(`${dialect}: real initial ledger and caller history retain the original operation identity exactly once`,options,async t=>{
  const f=await inventoryFixture(t,dialect),account=await f.store.get("SELECT id FROM seller_account WHERE username_key='synthetic_owner'"),context=identity(),operationId=randomUUID(),clientId=randomUUID(),grantId=randomUUID(),correlationId=randomUUID();
  const actual=await withInventoryContext({source:'MCP_CATALOG',actorKind:'SELLER',actorId:account.id,clientId,grantId,operationId,correlationId},()=>trackCreate(f.store,'synthetic_owner',()=>applyPlannedProductCreate(f.store,input('LEDGER',{stockQuantity:4}),context)));
  assert.equal(actual.id,context.productId);const movement=await f.store.get('SELECT * FROM inventory_movement WHERE product_id=?',actual.id);
  for(const [column,value]of Object.entries({source:'MCP_CATALOG',actor_kind:'SELLER',actor_id:account.id,client_id:clientId,grant_id:grantId,operation_id:operationId,correlation_id:correlationId,kind:'INITIALIZED',reason_code:'PRODUCT_CREATE',revision:1,before_quantity:null,after_quantity:4,delta_quantity:null}))assert.equal(movement[column],value,column);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM inventory_movement WHERE product_id=?',actual.id)).n,1);
  const history=await f.store.all('SELECT action,actor FROM product_event WHERE product_id=?',actual.id);assert.deepEqual(history.map(row=>({...row})),[{action:'CREATED',actor:'synthetic_owner'}]);
  await assert.rejects(applyPlannedProductCreate(f.store,input('LEDGER',{stockQuantity:4}),context),conflict);assert.equal((await f.store.get('SELECT COUNT(*) n FROM inventory_movement')).n,1);
 });
 test(`${dialect}: every late fresh-create write and final read fault restores all rows and leaves planned IDs reusable`,options,async t=>{
  const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Colour'}),blue=await createOptionValue(f.store,type.id,{label:'Blue'}),context=identity('FAULT-GROUP'),fields=input('FAULT-SKU',{variantGroup:'FAULT-GROUP',options:[{typeId:type.id,valueId:blue.id}],stockQuantity:3});
  const faults=[/^INSERT INTO listing\b/,/^INSERT INTO product\b/,/^INSERT INTO inventory_coverage\b/,/^INSERT INTO inventory_state\b/,/^UPDATE product SET stock_quantity/,/^UPDATE inventory_state\b/,/^INSERT INTO inventory_movement\b/,/^INSERT INTO product_option\b/,/^UPDATE product SET variant_label/,/^INSERT INTO product_event\b/];
  for(const pattern of faults){const before=await state(f.store),run=f.store.run;let injected=false;f.store.run=async(sql,...args)=>{const value=await run(sql,...args);if(pattern.test(sql.trim())){injected=true;throw new Error('Synthetic late creation fault');}return value;};
   try{await assert.rejects(trackCreate(f.store,'synthetic_owner',()=>applyPlannedProductCreate(f.store,fields,context)),/Synthetic late creation fault/);}finally{f.store.run=run;}
   assert.equal(injected,true,String(pattern));assert.deepEqual(await state(f.store),before);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',context.newListingId),undefined);
  }
  const before=await state(f.store),get=f.store.get;let injected=false;f.store.get=async(sql,...args)=>{const value=await get(sql,...args);if(sql.startsWith('SELECT p.id')&&args.includes(context.productId)&&value){injected=true;throw new Error('Synthetic final product read fault');}return value;};
  try{await assert.rejects(applyPlannedProductCreate(f.store,fields,context),/Synthetic final product read fault/);}finally{f.store.get=get;}
  assert.equal(injected,true);assert.deepEqual(await state(f.store),before);assert.equal((await applyPlannedProductCreate(f.store,fields,context)).id,context.productId);
 });
 test(`${dialect}: late shared-gallery copy and layout faults roll back new SKU ledger options and existing holder changes`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'COPY-FAULT',variantLabel:'Original',imageDataUrl,thumbDataUrl:imageDataUrl,stockQuantity:7}),context=identity('COPY-FAULT',holder),fields=input('COPY-JOIN',{variantGroup:'COPY-FAULT',variantLabel:'New',stockQuantity:2});
  for(const pattern of [/^INSERT INTO product_gallery_image\b/,/^UPDATE product SET gallery_layout_json/]){
   const before=await state(f.store),run=f.store.run;let injected=false;f.store.run=async(sql,...args)=>{const value=await run(sql,...args);if(pattern.test(sql.trim())){injected=true;throw new Error('Synthetic late gallery fault');}return value;};
   try{await assert.rejects(trackCreate(f.store,'synthetic_owner',()=>applyPlannedProductCreate(f.store,fields,context)),/Synthetic late gallery fault/);}finally{f.store.run=run;}
   assert.equal(injected,true);assert.deepEqual(await state(f.store),before);assert.equal(await f.store.get('SELECT id FROM product WHERE id=?',context.productId),undefined);
  }
  assert.equal((await applyPlannedProductCreate(f.store,fields,context)).galleryHolderId,holder.id);
 });
}
