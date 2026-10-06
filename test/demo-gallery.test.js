import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openDatabase,migrateStore} from '../src/db.js';
import {setupShop} from '../src/shop-setup.js';
import {addGalleryImage,getProduct,getProductImage,listProducts} from '../src/products.js';
import {withDemoGallery} from '../src/demo-gallery.js';
import {productMedia} from '../public/shop/product-media.js';

test('fictional galleries retain hero and never override seller edits, custom galleries or other modes',async t=>{
 const store=await openDatabase(':memory:');t.after(async ()=>await store.close());await setupShop(store,{mode:'demo'});
 const id=(await listProducts(store,new URLSearchParams('limit=100'))).items.find(x=>x.sku==='DEMO-001').id;
 const p=await getProduct(store,id),hero=await getProductImage(store,id);const gallery=withDemoGallery(p,hero,'public-demo');
 assert.equal(gallery.images[0],p.imageUrl);assert.equal(gallery.images.length,6);assert.equal(gallery.imageMedia.length,6);
 assert.equal(withDemoGallery(p,hero,'manual'),p);assert.equal(withDemoGallery(p,hero,'demo'),p);
 const renamed={...p,name:'Seller replacement'};assert.equal(withDemoGallery(renamed,hero,'public-demo'),renamed);
 assert.equal(withDemoGallery(p,{data:Buffer.from('changed hero')},'public-demo'),p);
 const customized={...p,images:[p.imageUrl,'/api/v1/custom-gallery']};assert.equal(withDemoGallery(customized,hero,'public-demo'),customized);
});
test('v10 gallery migration preserves all existing image bytes, IDs, positions and product data',async t=>{
 const s=await openDatabase(':memory:');t.after(async ()=>await s.close());await setupShop(s,{mode:'demo'});const p=(await listProducts(s,new URLSearchParams('limit=100'))).items[0];
 const bytes=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
 const data=i=>'data:image/png;base64,'+Buffer.concat([bytes,Buffer.from('distinct-fixture-'+i)]).toString('base64');
 for(let i=0;i<4;i++)await addGalleryImage(s,p.id,data(i));
 const before=await s.all('SELECT * FROM product_gallery_image ORDER BY position'),products=await s.all('SELECT * FROM product ORDER BY id');
 await s.exec(`ALTER TABLE product_gallery_image RENAME TO gallery_fixture;
 CREATE TABLE product_gallery_image(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4),mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),data BLOB NOT NULL,created_at TEXT NOT NULL,UNIQUE(product_id,position)) STRICT;
 INSERT INTO product_gallery_image SELECT * FROM gallery_fixture;DROP TABLE gallery_fixture;CREATE INDEX product_gallery_product ON product_gallery_image(product_id,position);`);
 await s.exec('ALTER TABLE product DROP COLUMN stock_quantity');await s.setSchemaVersion(10);await migrateStore(s);assert.equal(await s.schemaVersion(),16);assert.deepEqual(await s.all('SELECT * FROM product_gallery_image ORDER BY position'),before);assert.deepEqual(await s.all('SELECT * FROM product ORDER BY id'),products);
 for(let i=4;i<9;i++)await addGalleryImage(s,p.id,data(i));assert.equal((await getProduct(s,p.id)).images.length,10);await assert.rejects(async ()=>await addGalleryImage(s,p.id,data(9)));
});
test('gallery variants are local, hash-verified, bounded and retain reference provenance',()=>{
 const m=JSON.parse(readFileSync(new URL('../src/public-demo-gallery-provenance.json',import.meta.url)));
 assert.equal(m.productCount,35);assert.equal(m.imageCount,m.productCount*6);
 const gallery=JSON.parse(readFileSync(new URL('../src/public-demo-gallery.json',import.meta.url)));
 const heroes=JSON.parse(readFileSync(new URL('../src/public-demo-image-manifest.json',import.meta.url))).assets;
 assert.deepEqual(Object.keys(gallery.products).sort(),heroes.map(x=>x.sku).sort());
 assert.equal(new Set(m.assets.map(x=>x.sourceSha256)).size,m.imageCount);
 for(const h of heroes){assert.equal(m.perProductCounts[h.sku],6);assert.equal(gallery.products[h.sku].heroSha256,h.assetSha256);assert.equal(gallery.products[h.sku].media.length,6);}
 for(const a of m.assets){assert.match(a.sourceSha256,/^[a-f0-9]{64}$/);assert.match(a.referenceHeroSha256,/^[a-f0-9]{64}$/);assert.match(a.review,/^approved/);
 assert.deepEqual(a.variants.map(v=>Math.max(v.width,v.height)),[160,640,1254]);for(const v of a.variants){assert.match(v.url,/^\/demo-assets\/DEMO-\d{3}\/view-\d+-[a-f0-9]{12}-\d+\.jpg$/);const data=readFileSync(new URL('../public'+v.url,import.meta.url));assert.equal(data.length,v.bytes);assert.deepEqual(jpegDimensions(data),{width:v.width,height:v.height});assert.equal(createHash('sha256').update(data).digest('hex'),v.sha256);assert.ok(v.bytes<=(Math.max(v.width,v.height)===160?24:Math.max(v.width,v.height)===640?160:768)*1024);}}
});
test('media metadata supports legacy images and caps presentation at ten without changing source state',()=>{
 const p={name:'Synthetic item',images:Array.from({length:12},(_,i)=>'/api/v1/photo/'+i)};
 const media=productMedia(p);assert.equal(media.length,10);assert.equal(p.images.length,12);assert.equal(media[0].thumbnail,p.images[0]);assert.equal(media[0].full,p.images[0]);assert.match(media[0].alt,/Synthetic item/);assert.deepEqual(productMedia({name:'empty'}),[]);
});

// Validate the actual raster dimensions independently of the encoder metadata.
function jpegDimensions(data){
 assert.equal(data.readUInt16BE(0),0xffd8);let offset=2;
 while(offset<data.length){
  assert.equal(data[offset++],0xff);const marker=data[offset++];
  if(marker===0xda||marker===0xd9)break;
  const length=data.readUInt16BE(offset);
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{height:data.readUInt16BE(offset+3),width:data.readUInt16BE(offset+5)};
  offset+=length;
 }
 throw Error('Missing JPEG dimensions');
}
