import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,mkdtempSync,rmSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createCategory } from '../src/settings.js';
import { createProduct,applyPlannedProductCreate,getProduct } from '../src/products.js';
import { createOptionType,createOptionValue } from '../src/options.js';
import { trackCreate } from '../src/product-history.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { readCatalogCreateMediaMetadata,readCatalogCreateMediaState } from '../src/mcp/catalog-create-media-state.js';
import { projectCatalogMediaCreate } from '../src/mcp/catalog-media-projection.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
const png=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
const bytes=value=>Buffer.concat([png,Buffer.from(value)]),photo=value=>'data:image/png;base64,'+bytes(value).toString('base64');
const fields=(sku,extra={})=>({sku,name:'Requested name',description:'Requested description',category:'TEST',priceMinor:500,currency:'MYR',active:true,...extra});
const identity=(code=null,target=null)=>({version:1,productId:randomUUID(),targetCode:code,targetListingId:target?.listingId??null,newListingId:target?null:randomUUID()});
const request=(input,context)=>({normalizedInput:input,creationIdentity:context});
const tables=['product','listing','product_gallery_image','product_option','product_event','inventory_state','inventory_movement'];
async function state(store){const values=[];for(const table of tables)values.push([table,rowsDigest(await store.all('SELECT * FROM '+table))]);return values;}
const normalize=graph=>({products:[...graph.products].sort((a,b)=>a.productId<b.productId?-1:1),listings:[...graph.listings].sort((a,b)=>a.listingId<b.listingId?-1:1)});
function reader(store){const queries=[],read={dialect:store.dialect};for(const method of ['get','all'])read[method]=(sql,...args)=>{assert.match(sql,/^SELECT\b/);assert.equal(sql.includes(';'),false);queries.push({method,sql,args});return store[method](sql,...args);};return {read,queries};}
async function upload(store,productId,label,position){const id=randomUUID();await store.run("INSERT INTO product_gallery_image(id,product_id,position,mime,data,created_at) VALUES(?,?,?,'image/png',?,'2026-01-01T00:00:00.000Z')",id,productId,position,bytes(label));return id;}
async function compare(store,captured,projected){
 const before=await state(store);assert.deepEqual(await projectCatalogMediaCreate(reader(store).read,captured),projected);assert.deepEqual(await state(store),before);
 const product=await trackCreate(store,'synthetic_owner',()=>applyPlannedProductCreate(store,captured.normalizedInput,captured.creationIdentity));
 const actual=await readMediaSnapshot(store,product.id);assert.deepEqual(normalize(actual.before),normalize(projected.after));assert.equal(actual.graphReadBytes.oldBytes,projected.graphReadBytes.afterOldBytes);
 const aliases=new Map();for(const effect of projected.physicalEffects.filter(row=>row.kind==='COPY_MAIN')){
  const old=captured.source.snapshot.sources,added=actual.sources.filter(row=>row.source_kind==='GALLERY'&&row.source_product_id===effect.productId&&!old.some(s=>s.source_kind==='GALLERY'&&s.source_id===row.source_id));
  assert.equal(added.length,1);assert.equal(added[0].byte_sha256,effect.source.byte_sha256);assert.equal(added[0].mime,effect.source.mime);assert.deepEqual(added[0].thumbnail,effect.thumbnail);aliases.set(effect.ref,added[0].source_id);
 }
 for(const view of projected.afterViews){const real=actual.views.find(row=>row.productId===view.productId);assert.equal(real.role,view.role);assert.equal(real.holderId,view.holderId);assert.deepEqual(real.visible.map(({id,assetKey,shared})=>({id,assetKey,shared})),view.visible.map(item=>({...item,id:aliases.get(item.id)??item.id})));}
 for(const key of ['id','listingId','sku','name','description','categoryCode','priceMinor','currency','active','stockQuantity','variantGroup','variantLabel'])assert.deepEqual(product[key],projected.newProduct.after[key]);
 assert.deepEqual(product.options.map(row=>({typeId:row.type.id,valueId:row.value.id})),projected.newProduct.after.options);
 if(captured.source.kind==='EXISTING_TARGET'){const maximum=Math.max(...captured.source.order.map(row=>Date.parse(row.createdAt)));assert.ok(Date.parse(product.createdAt)>maximum);for(const old of captured.source.snapshot.sources){const row=actual.sources.find(s=>s.source_kind===old.source_kind&&s.source_id===old.source_id&&s.source_product_id===old.source_product_id);assert.ok(row);assert.equal(row.byte_sha256,old.byte_sha256);assert.deepEqual(row.thumbnail,old.thumbnail);}}
 return {product,actual};
}
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 for(const mutation of ['code','product','listing','currency','category','option','member'])test(`${dialect}: raw revision detects ${mutation} without adopting changed validation`,options,async t=>{
  const f=await inventoryFixture(t,dialect),context=identity('FRESH'),req=request(fields('NEW',{variantGroup:'FRESH',variantLabel:'New'}),context),captured=await readCatalogCreateMediaState(f.store,req);
  if(mutation==='code')await f.product({variantGroup:'FRESH',variantLabel:'Other'});
  if(mutation==='product')await applyPlannedProductCreate(f.store,fields('OCCUPIED'),{...identity(),productId:context.productId});
  if(mutation==='listing')await f.store.run("INSERT INTO listing(id,name,description,category,created_at,updated_at) VALUES(?,'Occupied','Synthetic','TEST','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",context.newListingId);
  if(mutation==='currency')await f.store.run("UPDATE company_setting SET default_currency='SGD' WHERE id=1");
  if(mutation==='category')await f.store.run("UPDATE general_code SET active=0 WHERE type='PRODUCT_CATEGORY' AND code='TEST'");
  if(mutation==='option')await createOptionType(f.store,{name:'New dictionary dependency'});
  if(mutation==='member')await f.product();
  assert.notEqual((await readCatalogCreateMediaMetadata(f.store,req)).revision,captured.catalogRevision);const before=await state(f.store);await assert.rejects(projectCatalogMediaCreate(reader(f.store).read,captured));assert.deepEqual(await state(f.store),before);
 });
 test(`${dialect}: target299 plus new fits joint300; target300 fails before media bodies`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'Holder'}),parts=[],args=[];
  for(let n=0;n<298;n++){parts.push("(?,?,'Synthetic','Synthetic','TEST',500,'MYR',1,?,'GROUP',?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");args.push(randomUUID(),'MEMBER-'+n,holder.listingId,'Label-'+n);}
  await f.store.run('INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,listing_id,variant_group,variant_label,created_at,updated_at) VALUES '+parts.join(','),...args);
  const req=request(fields('NEW',{variantGroup:'GROUP',variantLabel:'New'}),identity('GROUP',holder)),captured=await readCatalogCreateMediaState(f.store,req),projection=await projectCatalogMediaCreate(f.store,captured);assert.equal(projection.after.products.length,300);assert.equal(projection.creationOrder.oldMembers.length,299);
  await f.product({variantGroup:'GROUP',variantLabel:'Member300'});const g=reader(f.store);await assert.rejects(readCatalogCreateMediaState(g.read,req),{code:'CATALOG_REVIEW_TOO_LARGE'});assert.equal(g.queries.some(row=>row.sql.includes('p.image_data')),false);
 });
 test(`${dialect}: complete dictionary text preflight precedes all dependency materialization`,options,async t=>{
  const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Large dictionary'});await f.store.run('UPDATE option_type SET translations_json=? WHERE id=?',JSON.stringify({en:'x'.repeat(2*1024*1024)}),type.id);
  const g=reader(f.store);await assert.rejects(readCatalogCreateMediaMetadata(g.read,request(fields('NEW'),identity())),{code:'CATALOG_REVIEW_TOO_LARGE'});assert.equal(g.queries.some(row=>row.method==='all'),false);assert.ok(g.queries.some(row=>/COUNT\(\*\).*SUM\(.*MAX\(/.test(row.sql)));
 });
 test(`${dialect}: aggregate metadata budget rejects individually bounded rows before first page`,options,async t=>{
  const f=await inventoryFixture(t,dialect),parts=[],args=[],text=JSON.stringify({en:'x'.repeat(10000)});
  for(let n=0;n<150;n++){parts.push("(?,?,?,?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");args.push(randomUUID(),'BOUNDED-'+n,'Synthetic',text);}
  await f.store.run('INSERT INTO option_type(id,code,name,translations_json,created_at,updated_at) VALUES '+parts.join(','),...args);
  const g=reader(f.store);await assert.rejects(readCatalogCreateMediaMetadata(g.read,request(fields('NEW'),identity())),{code:'CATALOG_REVIEW_TOO_LARGE'});assert.equal(g.queries.some(row=>row.method==='all'),false);
 });
 test(`${dialect}: actual old bytes and thumbnails change composite even without metadata timestamps`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'Old',imageDataUrl:photo('old'),thumbDataUrl:photo('thumb')}),req=request(fields('NEW',{variantGroup:'GROUP',variantLabel:'New'}),identity('GROUP',holder)),captured=await readCatalogCreateMediaState(f.store,req);
  await f.store.run('UPDATE product SET thumb_data=? WHERE id=?',bytes('changed-thumb'),holder.id);
  const current=await readCatalogCreateMediaState(f.store,req);assert.equal(current.catalogRevision,captured.catalogRevision);assert.notEqual(current.mediaRevision,captured.mediaRevision);assert.notEqual(current.revision,captured.revision);await assert.rejects(projectCatalogMediaCreate(f.store,captured),{code:'MEDIA_PROJECTION_CHANGED'});
 });
 test(`${dialect}: physical preflight and distinct old32 content limits remain independent`,options,async t=>{
  for(const mode of ['bytes','assets']){const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'Old'}),parts=[],args=[];for(let n=0;n<33;n++){const body=mode==='bytes'?Buffer.alloc(MEDIA_LIMITS.sourceBytes):bytes('distinct-'+n);if(mode==='bytes')png.copy(body);parts.push("(?,?,'Synthetic','Synthetic','TEST',500,'MYR',1,?,'GROUP',?,'image/png',?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");args.push(randomUUID(),'IMAGE-'+n,holder.listingId,'Label-'+n,body);}await f.store.run('INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,listing_id,variant_group,variant_label,image_mime,image_data,created_at,updated_at) VALUES '+parts.join(','),...args);
   const g=reader(f.store);await assert.rejects(readCatalogCreateMediaState(g.read,request(fields('NEW',{variantGroup:'GROUP',variantLabel:'New'}),identity('GROUP',holder))),{code:'MEDIA_RESOURCE_LIMIT'});if(mode==='bytes')assert.equal(g.queries.some(row=>/^SELECT (image_data|data)/.test(row.sql)),false);
  }
 });
 test(`${dialect}: strict normalized input forged packets and orphan targets reject without writes`,options,async t=>{
  const f=await inventoryFixture(t,dialect),context=identity(),req=request(fields('NEW'),context),captured=await readCatalogCreateMediaState(f.store,req),before=await state(f.store);let invoked=false;
  const getter={...req.normalizedInput};Object.defineProperty(getter,'name',{enumerable:true,get(){invoked=true;return 'Hidden';}});
  for(const bad of [{...req,approved:true},{...req,normalizedInput:getter},{...req,normalizedInput:{...req.normalizedInput,stageId:randomUUID()}},{...req,normalizedInput:{...req.normalizedInput,imageDataUrl:photo('forbidden')}}])await assert.rejects(readCatalogCreateMediaState(f.store,bad));assert.equal(invoked,false);
  for(const change of [copy=>copy.after.name='Forged',copy=>copy.source={kind:'EXISTING_TARGET',anchorId:context.productId},copy=>copy.creationIdentity.productId=randomUUID(),copy=>copy.metadata.rows.option_type.push({id:randomUUID()})]){const copy=structuredClone(captured);change(copy);await assert.rejects(projectCatalogMediaCreate(f.store,copy));}
  assert.deepEqual(await state(f.store),before);await f.store.run("INSERT INTO listing(id,code,name,description,category,created_at,updated_at) VALUES(?,'ORPHAN','Orphan','Synthetic','TEST','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",context.newListingId);
  await assert.rejects(readCatalogCreateMediaState(f.store,request(fields('ORPHAN-NEW',{variantGroup:'ORPHAN'}),{...identity('ORPHAN'),targetListingId:context.newListingId,newListingId:null})),{code:'CATALOG_CREATE_MEDIA_CHANGED'});
 });
 test(`${dialect}: real second-connection commit after capture rejects without primary writes`,options,async t=>{
  const f=await twoConnections(t,dialect);try{const holder=await f.product({variantGroup:'GROUP',variantLabel:'Old'}),req=request(fields('NEW',{variantGroup:'GROUP',variantLabel:'New'}),identity('GROUP',holder)),captured=await readCatalogCreateMediaState(f.store,req);
   await createProduct(f.second,fields('CONCURRENT',{variantGroup:'GROUP',variantLabel:'Other'}));const afterOther=await state(f.store);await assert.rejects(projectCatalogMediaCreate(reader(f.store).read,captured),{code:'MEDIA_PROJECTION_CHANGED'});assert.deepEqual(await state(f.store),afterOther);
  }finally{if(dialect==='postgres')await f.second.close();}
 });
 test(`${dialect}: late shared-copy failure rolls back real service and history; private plan remains usable`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'Old',imageDataUrl:photo('main'),thumbDataUrl:photo('thumb')}),captured=await readCatalogCreateMediaState(f.store,request(fields('NEW',{variantGroup:'GROUP',variantLabel:'New',stockQuantity:4}),identity('GROUP',holder))),projection=await projectCatalogMediaCreate(f.store,captured),before=await state(f.store),run=f.store.run;
  f.store.run=async(sql,...args)=>{const result=await run(sql,...args);if(sql.startsWith('INSERT INTO product_gallery_image'))throw new Error('Synthetic late copy fault');return result;};try{await assert.rejects(trackCreate(f.store,'synthetic_owner',()=>applyPlannedProductCreate(f.store,captured.normalizedInput,captured.creationIdentity)),/Synthetic late copy fault/);}finally{f.store.run=run;}assert.deepEqual(await state(f.store),before);
  const {product}=await compare(f.store,captured,projection);assert.equal(product.stockQuantity,4);assert.equal((await getProduct(f.store,holder.id,true)).stockQuantity,holder.stockQuantity);assert.equal((await f.store.get('SELECT COUNT(*) n FROM inventory_movement WHERE product_id=?',product.id)).n,1);
 });
}
async function twoConnections(t,dialect){if(dialect==='postgres'){const f=await inventoryFixture(t,dialect);const second=await openPostgresDatabase(f.location);return {...f,second};}const directory=mkdtempSync(path.join(tmpdir(),'catalog-create-projector-'));chmodSync(directory,0o700);const file=path.join(directory,'private.sqlite'),store=await openDatabase(file);chmodSync(file,0o600);const second=await openDatabase(file);t.after(async()=>{await second.close();await store.close();rmSync(directory,{recursive:true,force:true});});await createCategory(store,{code:'TEST',label:'Synthetic'});return {store,second,product:extra=>createProduct(store,fields('OLD',extra))};}
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: private/no-group and new-group use honest EMPTY_BEFORE without synthetic DB snapshot`,options,async t=>{
  const f=await inventoryFixture(t,dialect);
  for(const group of [null,'FRESH']){const input=fields(group?'FRESH-SKU':'PRIVATE',{stockQuantity:0,...(group?{variantGroup:group,variantLabel:'New'}:{})}),context=identity(group),before=await state(f.store),g=reader(f.store);
   const captured=await readCatalogCreateMediaState(g.read,request(input,context)),projected=await projectCatalogMediaCreate(g.read,captured);
   assert.deepEqual(await state(f.store),before);assert.deepEqual(captured.source,{kind:'EMPTY_BEFORE',listingId:context.newListingId});assert.equal(projected.newProduct.before,null);assert.equal(Object.hasOwn(projected.newProduct.after,'createdAt'),false);
   assert.deepEqual(projected.before,{products:[],listings:[]});assert.deepEqual(projected.source,{kind:'EMPTY_BEFORE',anchorId:null,assets:[],sources:[]});assert.equal(projected.after.products.length,1);assert.equal(projected.after.listings.length,1);assert.equal(projected.after.products[0].role,'single');assert.equal(projected.after.listings[0].holderId,null);assert.equal(projected.physicalEffects.length,0);assert.deepEqual(projected.graphReadBytes,{beforeOldBytes:0,afterOldBytes:0});assert.equal(g.queries.some(row=>row.sql.includes('p.image_data')),false);
   await compare(f.store,captured,projected);
  }
 });
 for(const mode of ['single','hidden','legacy-shared','twin','full'])test(`${dialect}: target ${mode} matches real ownership visibility copies and thumbnails`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'Old',name:'Adopted shared name',description:'Adopted shared description',imageDataUrl:photo('main'),thumbDataUrl:photo('thumb')});
  if(['legacy-shared','full'].includes(mode))await f.product({variantGroup:'GROUP',variantLabel:'Earlier variant',imageDataUrl:photo('own-variant')});
  if(mode==='full')await f.store.run('DELETE FROM product_gallery_image WHERE product_id=?',holder.id);
  const ids=[];if(['hidden','twin','full'].includes(mode))for(let n=1;n<=(mode==='full'?10:2);n++)ids.push(await upload(f.store,holder.id,mode==='twin'&&n===2?'main':'gallery-'+n,n));
  if(mode==='hidden')await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify([ids[0]]),holder.id);
  if(mode==='twin')await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify(['main',ids[0]]),holder.id);
  if(['legacy-shared','full'].includes(mode))await f.store.run('UPDATE product SET gallery_layout_json=NULL WHERE id=?',holder.id);
  await f.store.run('UPDATE product SET created_at=? WHERE id=?','2030-01-01T00:00:00.000Z',holder.id);
  if(['legacy-shared','full'].includes(mode)){const first=await f.store.get('SELECT id FROM product WHERE listing_id=? AND id<>?',holder.listingId,holder.id);await f.store.run('UPDATE product SET created_at=? WHERE id=?','2030-01-01T00:00:00.001Z',first.id);}
  const captured=await readCatalogCreateMediaState(f.store,request(fields('AAA-NEW',{variantGroup:'GROUP',variantLabel:'New'}),identity('GROUP',holder))),projected=await projectCatalogMediaCreate(reader(f.store).read,captured);
  assert.equal(captured.source.anchorId,holder.id);assert.equal(captured.after.name,'Adopted shared name');assert.equal(captured.after.description,'Adopted shared description');assert.equal(projected.after.listings[0].holderId,holder.id);assert.equal(projected.after.products.length,captured.source.order.length+1);
  assert.equal(projected.physicalEffects.some(row=>row.kind==='COPY_MAIN'),mode==='single');
  if(mode==='full')assert.equal(projected.afterViews.find(row=>row.productId===holder.id).visible.length,11);
  if(mode==='hidden')assert.equal(projected.afterViews.find(row=>row.productId===holder.id).visible[0].id,'main');
  await compare(f.store,captured,projected);
 });
 test(`${dialect}: structured options and literal labels are actual CREATE preparation`,options,async t=>{
  const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Colour'}),red=await createOptionValue(f.store,type.id,{label:'Red'}),blue=await createOptionValue(f.store,type.id,{label:'Blue'}),holder=await f.product({variantGroup:'OPTIONS',options:[{typeId:type.id,valueId:red.id}]});
  const req=request(fields('BLUE',{variantGroup:'OPTIONS',options:[{typeId:type.id,valueId:blue.id}]}),identity('OPTIONS',holder)),captured=await readCatalogCreateMediaState(f.store,req),projection=await projectCatalogMediaCreate(f.store,captured);
  assert.equal(captured.after.variantLabel,'Blue');assert.equal(projection.newProduct.optionReview.after[0].typeName,'Colour');assert.equal(projection.newProduct.optionReview.after[0].valueLabel,'Blue');
  const before=(await readCatalogCreateMediaMetadata(f.store,req)).revision;await f.store.run('UPDATE option_value SET active=0 WHERE id=?',blue.id);
  assert.notEqual((await readCatalogCreateMediaMetadata(f.store,req)).revision,before);await assert.rejects(projectCatalogMediaCreate(f.store,captured));await f.store.run('UPDATE option_value SET active=1 WHERE id=?',blue.id);
  await compare(f.store,captured,projection);
 });
}
