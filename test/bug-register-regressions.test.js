import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryFixture} from './helpers/inventory-fixture.js';
import {listProducts} from '../src/products.js';
import {setupShop,resetDemo} from '../src/shop-setup.js';
import {openDatabase} from '../src/db.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: catalog selects available sibling instead of reserved cheap variant`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect);
 const a=await f.product({variantGroup:'PAIR',variantLabel:'A',stockQuantity:1,priceMinor:100});
 const b=await f.product({variantGroup:'PAIR',variantLabel:'B',stockQuantity:1,priceMinor:200});
 await f.order([a]);const result=await listProducts(f.store,new URLSearchParams());assert.equal(result.items.find(p=>p.variantGroup==='PAIR')?.id,b.id);
});
test('repeated demo resets retain only the seeded listings',async t=>{
 const db=await openDatabase(':memory:');t.after(()=>db.close());await setupShop(db,{mode:'demo'});
 const count=async()=>Number((await db.get('SELECT COUNT(*) AS n FROM listing')).n);const initial=await count();
 await resetDemo(db);assert.equal(await count(),initial);await resetDemo(db);assert.equal(await count(),initial);
});

import {png} from './helpers/mcp-media-coordinator-fixture.js';
import {getProductImage,getGalleryImage,setProductThumbnail,setGalleryThumbnail,addGalleryImage} from '../src/products.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: thumbnail changes advance main and gallery versions; identical writes are stable`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect),photo='data:image/png;base64,'+png.toString('base64'),thumb='data:image/png;base64,'+Buffer.concat([png,Buffer.from('preview')]).toString('base64');
 const p=await f.product({imageDataUrl:photo});await addGalleryImage(f.store,p.id,'data:image/png;base64,'+Buffer.concat([png,Buffer.from('gallery')]).toString('base64'));const g=await f.store.get('SELECT id FROM product_gallery_image WHERE product_id=?',p.id);
 for(const [read,write]of [[()=>getProductImage(f.store,p.id,true,true),()=>setProductThumbnail(f.store,p.id,thumb)],[()=>getGalleryImage(f.store,p.id,g.id,true,true),()=>setGalleryThumbnail(f.store,p.id,g.id,thumb)]]){
 const before=await read();await write();const after=await read();assert.notEqual(before.version,after.version);assert.notDeepEqual(before.data,after.data);await write();assert.equal((await read()).version,after.version);
 }
});

import {getProduct,updateProduct} from '../src/products.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: shared text edits invalidate sibling editor revision`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect),a=await f.product({variantGroup:'TEXT',variantLabel:'A'}),b=await f.product({variantGroup:'TEXT',variantLabel:'B'});
 const before=await getProduct(f.store,b.id,true);await updateProduct(f.store,a.id,{name:'Updated shared title'});const after=await getProduct(f.store,b.id,true);
 assert.equal(after.name,'Updated shared title');assert.notEqual(after.updatedAt,before.updatedAt);
 await assert.rejects(updateProduct(f.store,b.id,{name:'Stale title',expectedUpdatedAt:before.updatedAt}),{code:'PRODUCT_CHANGED'});
});

import {createOptionType,createOptionValue} from '../src/options.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: structured IDs distinguish identical truncated labels while duplicate combinations and legacy labels remain rejected`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect);
 const type=await createOptionType(f.store,{name:'Long'}),second=await createOptionType(f.store,{name:'Size'});
 const long=await createOptionValue(f.store,type.id,{label:'A'.repeat(80)}),one=await createOptionValue(f.store,second.id,{label:'One'}),two=await createOptionValue(f.store,second.id,{label:'Two'});
 const options=value=>[{typeId:type.id,valueId:long.id},{typeId:second.id,valueId:value.id}];
 const a=await f.product({variantGroup:'LONG',options:options(one)}),b=await f.product({variantGroup:'LONG',options:options(two)});
 assert.equal(a.variantLabel,b.variantLabel);assert.notEqual(a.id,b.id);
 await assert.rejects(f.product({variantGroup:'LONG',options:options(one)}),{code:'DUPLICATE_VARIANT'});
 await f.product({variantGroup:'LEGACY',variantLabel:'Same'});
 await assert.rejects(f.product({variantGroup:'LEGACY',variantLabel:'same'}),{code:'DUPLICATE_VARIANT'});
});

import {migrateStore,SCHEMA_VERSION} from '../src/db.js';
import {upgradePostgres} from '../src/postgres/upgrade.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: schema36 label index upgrades atomically and preserves products`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect),p=await f.product({variantGroup:'OLD',variantLabel:'Existing'});
 await f.store.exec(`DROP INDEX product_variant_option; CREATE UNIQUE INDEX product_variant_option ON product(variant_group, ${dialect==='sqlite'?'variant_label COLLATE NOCASE':'lower(variant_label)'});`);
 await f.store.setSchemaVersion(36);
 const upgrade=()=>dialect==='sqlite'?migrateStore(f.store):f.store.transaction(()=>upgradePostgres(f.store,36));
 await upgrade();assert.equal(await f.store.schemaVersion(),SCHEMA_VERSION);assert.equal((await getProduct(f.store,p.id,true)).variantLabel,'Existing');
 const unique=dialect==='sqlite'?(await f.store.all("PRAGMA index_list('product')")).find(i=>i.name==='product_variant_option').unique:(await f.store.get("SELECT indisunique AS value FROM pg_index JOIN pg_class ON pg_class.oid=indexrelid WHERE relname='product_variant_option'")).value;
 assert.equal(Boolean(unique),false);
 await assert.rejects(f.product({variantGroup:'OLD',variantLabel:'existing'}),{code:'DUPLICATE_VARIANT'});
});

for(const dialect of ['sqlite','postgres'])test(`${dialect}: concurrent structured creation reserves exactly one identical combination`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Concurrent'}),value=await createOptionValue(f.store,type.id,{label:'One'});
 const results=await Promise.allSettled([1,2].map(()=>f.product({variantGroup:'RACE',options:[{typeId:type.id,valueId:value.id}]})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'DUPLICATE_VARIANT');
});
for(const dialect of ['sqlite','postgres'])test(`${dialect}: demo reset removes old group contents and rolls back a failed reseed`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect,{seed:false});await setupShop(f.store,{mode:'demo'});
 const snapshot=async()=>JSON.stringify(await f.store.all('SELECT * FROM listing ORDER BY id'));
 await f.product({category:'HOME',variantGroup:'RESET-OLD',variantLabel:'A',name:'Old listing title'});
 const initial=await snapshot(),run=f.store.run;
 f.store.run=async(sql,...args)=>{if(sql.startsWith('INSERT INTO general_code'))throw new Error('Synthetic reseed failure');return run(sql,...args);};
 try{await assert.rejects(resetDemo(f.store),/Synthetic reseed failure/);}finally{f.store.run=run;}
 assert.equal(await snapshot(),initial);
 await resetDemo(f.store);const n=(await f.store.get('SELECT COUNT(*) AS n FROM listing')).n;await resetDemo(f.store);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM listing')).n,n);
 const fresh=await f.product({category:'HOME',variantGroup:'RESET-OLD',variantLabel:'A',name:'Fresh listing title'});assert.equal(fresh.name,'Fresh listing title');
});
