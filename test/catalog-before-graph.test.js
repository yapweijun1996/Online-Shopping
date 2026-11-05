import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { readMediaSnapshot,readMediaUnionSnapshot } from '../src/mcp/media-resources.js';
import { readCatalogMediaBeforeGraph } from '../src/mcp/catalog-media-projection.js';
import { addGalleryImage,getProduct,updateProduct } from '../src/products.js';
const png=readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
const photo=label=>'data:image/png;base64,'+Buffer.concat([png,Buffer.from(label)]).toString('base64');
function selected(read){return{dialect:read.dialect,get:(sql,...args)=>{assert.match(sql,/^SELECT\b/);assert.doesNotMatch(sql,/image_data|thumb_data|\bdata\b/);return read.get(sql,...args);},all:(sql,...args)=>{assert.match(sql,/^SELECT\b/);assert.doesNotMatch(sql,/image_data|thumb_data|\bdata\b/);assert.match(sql,/ORDER BY listing_id,created_at,sku,id LIMIT 301/);return read.all(sql,...args);}};}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: current two-listing BeforeGraph reuses real ordering and full ten/own eleven views`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'SOURCE',variantLabel:'A',imageDataUrl:photo('holder')});
  for(let n=0;n<9;n++)await addGalleryImage(f.store,holder.id,photo('shared'+n));
  const variant=await f.product({variantGroup:'SOURCE',variantLabel:'B',imageDataUrl:photo('variant')}),target=await f.product({imageDataUrl:photo('target')});
  const result=await f.store.transaction(async()=>{const snapshot=await readMediaUnionSnapshot(f.store,holder.id,{targetListingId:target.listingId});return readCatalogMediaBeforeGraph(selected(f.store),snapshot);});
  assert.equal(result.beforeViews.find(row=>row.productId===holder.id).visible.length,10);assert.equal(result.beforeViews.find(row=>row.productId===variant.id).visible.length,11);
  for(const view of result.beforeViews){const actual=await getProduct(f.store,view.productId,true);assert.deepEqual(view.visible.map(row=>({id:row.id,shared:row.shared})),actual.galleryItems.map(row=>({id:row.id,shared:row.shared===true})));}
  assert.equal(Object.isFrozen(result),true);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: hidden unselected physical twin suppresses own main without nulling its key`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'HIDDEN',variantLabel:'A',imageDataUrl:photo('holder')});
  await addGalleryImage(f.store,holder.id,photo('twin'));await addGalleryImage(f.store,holder.id,photo('shown'));
  const variant=await f.product({variantGroup:'HIDDEN',variantLabel:'B',imageDataUrl:photo('twin')});
  const rows=await f.store.all('SELECT id,data FROM product_gallery_image WHERE product_id=? ORDER BY position',holder.id),shown=rows.find(row=>Buffer.from(row.data).equals(Buffer.from(photo('shown').split(',')[1],'base64')));
  await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify([shown.id]),holder.id);
  const result=await f.store.transaction(async()=>readCatalogMediaBeforeGraph(selected(f.store),await readMediaSnapshot(f.store,variant.id)));
  const physical=result.before.products.find(row=>row.productId===variant.id),view=result.beforeViews.find(row=>row.productId===variant.id);
  assert.ok(physical.mainAssetKey);assert.equal(view.visible.some(row=>row.id==='main'),false);assert.equal(view.visible.some(row=>row.assetKey===physical.mainAssetKey),false);
  assert.deepEqual(view.visible.map(row=>row.id),(await getProduct(f.store,variant.id,true)).galleryItems.map(row=>row.id));
 });
 test(`${dialect}: stale tuples and substituted before views reject; singleton explicit hidden main is preserved`,options,async t=>{
  const f=await inventoryFixture(t,dialect),product=await f.product({imageDataUrl:photo('main')});await addGalleryImage(f.store,product.id,photo('shown'));
  const gallery=await f.store.get('SELECT id FROM product_gallery_image WHERE product_id=?',product.id);await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?',JSON.stringify([gallery.id]),product.id);
  const snapshot=await readMediaSnapshot(f.store,product.id),result=await f.store.transaction(()=>readCatalogMediaBeforeGraph(selected(f.store),snapshot));
  assert.ok(result.before.products[0].mainAssetKey);assert.equal(result.beforeViews[0].visible.some(row=>row.id==='main'),false);
  const forged=structuredClone(snapshot);forged.views[0].visible=[];await assert.rejects(f.store.transaction(()=>readCatalogMediaBeforeGraph(selected(f.store),forged)),{status:409,code:'MEDIA_PROJECTION_CHANGED'});
  await updateProduct(f.store,product.id,{sku:'CHANGED'});await assert.rejects(f.store.transaction(()=>readCatalogMediaBeforeGraph(selected(f.store),snapshot)),{status:409,code:'MEDIA_PROJECTION_CHANGED'});
 });
}
