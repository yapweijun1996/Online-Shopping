import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { getProduct,addGalleryImage,updateProductGallery,applyPlannedProductCreate } from '../src/products.js';
import { shareListingGallery } from '../src/product-gallery.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { trackCreate } from '../src/product-history.js';
import { createApi } from '../src/app.js';
import { setupShop } from '../src/shop-setup.js';
const png=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url)),photo=value=>'data:image/png;base64,'+Buffer.concat([png,Buffer.from(value)]).toString('base64');
async function fixture(t,dialect){const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'GROUP',variantLabel:'Old',imageDataUrl:photo('main'),thumbDataUrl:photo('thumb')});
 await addGalleryImage(f.store,holder.id,photo('old-upload'));
 const old=await getProduct(f.store,holder.id,true),originalIds=(await f.store.all('SELECT id FROM product_gallery_image WHERE product_id=?',holder.id)).map(row=>row.id);
 const context={version:1,productId:randomUUID(),targetCode:'GROUP',targetListingId:holder.listingId,newListingId:null};
 const fields={sku:'NEW',name:'Synthetic',description:'Synthetic',category:'TEST',priceMinor:500,currency:'MYR',active:true,variantGroup:'GROUP',variantLabel:'New',stockQuantity:3};
 return {...f,holder,old,originalIds,context,fields};
}
const state=async store=>{const rows=[];for(const table of ['product','listing','product_gallery_image','product_event','inventory_coverage','inventory_state','inventory_movement'])rows.push(rowsDigest(await store.all('SELECT * FROM '+table)));return rows;};
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 for(const transport of ['service','HTTP'])test(`${dialect}: stale ${transport} gallery selection cannot delete the main copy created by real planned join`,options,async t=>{
  const f=await fixture(t,dialect);let api,headers;
  if(transport==='HTTP'){
   await setupShop(f.store,{mode:'production',shopName:'Synthetic'});api=await createApi({store:f.store,config:{publicOrigin:'http://fixture.test',sellerOrigin:'http://fixture.test',mcpEnabled:false}});
   const login=await api(new Request('http://fixture.test/api/v1/seller/session',{method:'POST',headers:{origin:'http://fixture.test','content-type':'application/json'},body:JSON.stringify({username:'synthetic_owner',password:'SyntheticInventoryPassword123!'})}));assert.equal(login.status,200);
   headers={origin:'http://fixture.test','content-type':'application/json',cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await login.json()).csrfToken};
  }
  await applyPlannedProductCreate(f.store,f.fields,f.context);
  const copies=await f.store.all('SELECT id FROM product_gallery_image WHERE product_id=?',f.holder.id),copy=copies.find(row=>!f.originalIds.includes(row.id));assert.ok(copy);
  const before=await state(f.store),body={gallery:f.old.galleryItems.map(row=>({id:row.id})),expectedUpdatedAt:f.old.updatedAt};
  if(transport==='service'){
   let rejection;try{await updateProductGallery(f.store,f.holder.id,body);}catch(error){rejection=error;}
   const retained=Boolean(await f.store.get('SELECT id FROM product_gallery_image WHERE id=?',copy.id));assert.equal(rejection?.code,'PRODUCT_CHANGED','Old request accepted; new shared-main copy retained='+retained);
  }else{
   const response=await api(new Request('http://fixture.test/api/v1/seller/products/'+f.holder.id,{method:'PATCH',headers,body:JSON.stringify(body)}));
   const retained=Boolean(await f.store.get('SELECT id FROM product_gallery_image WHERE id=?',copy.id));assert.equal(response.status,409,'Old HTTP request accepted; new shared-main copy retained='+retained);assert.equal((await response.json()).error.code,'PRODUCT_CHANGED');
  }
  assert.deepEqual(await state(f.store),before);assert.notEqual((await getProduct(f.store,f.holder.id,true)).updatedAt,f.old.updatedAt);
 });
 test(`${dialect}: copy and layout-only sharing touch monotonically once; late version fault rolls back all creation state`,options,async t=>{
  const f=await fixture(t,dialect),future='2030-01-01T00:00:00.000Z';await f.store.run('UPDATE product SET updated_at=? WHERE id=?',future,f.holder.id);
  const before=await state(f.store),run=f.store.run;f.store.run=async(sql,...args)=>{const value=await run(sql,...args);if(sql==='UPDATE product SET updated_at = ? WHERE id = ?')throw new Error('Synthetic after-gallery-version fault');return value;};
  try{await assert.rejects(trackCreate(f.store,'synthetic_owner',()=>applyPlannedProductCreate(f.store,f.fields,f.context)),/Synthetic after-gallery-version fault/);}finally{f.store.run=run;}
  assert.deepEqual(await state(f.store),before);await applyPlannedProductCreate(f.store,f.fields,f.context);
  const copied=await getProduct(f.store,f.holder.id,true);assert.equal(copied.updatedAt,'2030-01-01T00:00:00.001Z');const stable=await state(f.store);
  await f.store.transaction(()=>shareListingGallery(f.store,f.holder.listingId));assert.deepEqual(await state(f.store),stable);
  const galleryCount=(await f.store.get('SELECT COUNT(*) n FROM product_gallery_image WHERE product_id=?',f.holder.id)).n;
  await f.store.run('UPDATE product SET gallery_layout_json=NULL WHERE id=?',f.holder.id);
  await f.store.transaction(()=>shareListingGallery(f.store,f.holder.listingId));assert.equal((await getProduct(f.store,f.holder.id,true)).updatedAt,'2030-01-01T00:00:00.002Z');assert.equal((await f.store.get('SELECT COUNT(*) n FROM product_gallery_image WHERE product_id=?',f.holder.id)).n,galleryCount);
  const layoutStable=await state(f.store);await f.store.transaction(()=>shareListingGallery(f.store,f.holder.listingId));assert.deepEqual(await state(f.store),layoutStable);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM inventory_movement WHERE product_id=?',f.holder.id)).n,1);assert.equal((await f.store.get('SELECT COUNT(*) n FROM inventory_movement WHERE product_id=?',f.context.productId)).n,1);
 });
}
