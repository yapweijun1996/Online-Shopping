import test from 'node:test';
import assert from 'node:assert/strict';
import { shopObjectName } from '../src/shop-setup.js';
import { readDemoRevision, readShopMode } from '../src/config.js';
import { storageKey } from '../public/shop/storage-scope.js';
test('public demo reset selects a distinct namespace and never aliases legacy or production',()=>{
 const names=['shop','pet-shop-demo-v1',shopObjectName('public-demo','v1'),shopObjectName('public-demo','v2')];assert.equal(new Set(names).size,4);
 assert.equal(readShopMode({SHOP_MODE:'public-demo'}),'public-demo');assert.equal(readDemoRevision({}),'v1');
 for(const label of ['', '../shop','shop/','A','a'.repeat(33),null]){assert.throws(()=>shopObjectName('public-demo',label));if(label!==null)assert.throws(()=>readDemoRevision({SHOP_DEMO_REVISION:label}))}
});
test('browser data keys isolate demo revisions and retain legacy keys without migration',()=>{
 try {delete globalThis.shopStorageNamespace;assert.equal(storageKey('orders'),'orders');globalThis.shopStorageNamespace='public-general-demo-v1';assert.equal(storageKey('orders'),'orders:public-general-demo-v1');globalThis.shopStorageNamespace='public-general-demo-v2';assert.equal(storageKey('orders'),'orders:public-general-demo-v2');}finally{delete globalThis.shopStorageNamespace}
});

test('all fictional catalog images have matching original-generation provenance and no external assets',async()=>{
 const {readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');
 const catalog=JSON.parse(readFileSync(new URL('../src/public-demo-catalog.json',import.meta.url)));const manifest=JSON.parse(readFileSync(new URL('../src/public-demo-image-manifest.json',import.meta.url)));
 assert.equal(catalog.length,35);assert.equal(manifest.assets.length,35);assert.equal(new Set(catalog.map(x=>x.category)).size,7);assert.equal(new Set(manifest.assets.map(x=>x.assetSha256)).size,35);
 for(const product of catalog){const asset=manifest.assets.find(x=>x.sku===product.sku);assert.ok(asset);assert.match(product.imageDataUrl,/^data:image\/jpeg;base64,/);const bytes=Buffer.from(product.imageDataUrl.split(',')[1],'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.assetSha256);assert.ok(bytes.length<512*1024);assert.match(product.description,/Fictional demo/);assert.doesNotMatch(product.name+' '+product.description,/PETKIT|Shopee|marketplace|Paws|https?:|wa\.me/i);assert.equal(product.variantGroup,undefined);}
});
test('public demo endpoint reports revision and never exposes a configured contact',async(t)=>{
 const {openDatabase}=await import('../src/db.js');const {initializeShop}=await import('../src/shop-setup.js');const {createApi}=await import('../src/app.js');const store=openDatabase(':memory:');t.after(()=>store.close());const config={shopMode:'public-demo',demoRevision:'v2',production:false,publicOrigin:null};initializeShop(store,config);store.run("UPDATE company_setting SET seller_whatsapp_phone = '60123456789'");const api=createApi({store,config});const r=await api(new Request('http://localhost/api/v1/shop'));const data=await r.json();assert.equal(data.mode,'demo');assert.equal(data.demoNamespace,'public-general-demo-v2');assert.equal(data.sellerWhatsAppPhone,null);
});
