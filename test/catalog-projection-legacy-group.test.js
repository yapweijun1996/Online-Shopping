import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { createOptionType,createOptionValue } from '../src/options.js';
import { getProduct,prepareProductUpdate,updateProduct } from '../src/products.js';
import { trackUpdate } from '../src/product-history.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { projectCatalogMediaMove } from '../src/mcp/catalog-media-projection.js';
import { readCatalogMediaMetadata } from '../src/mcp/catalog-media-state.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: legacy empty-group membership stays on source while options still clear strictly`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect),type=await createOptionType(f.store,{name:'Colour'}),value=await createOptionValue(f.store,type.id,{label:'Red'});
 const initial=await f.product({variantGroup:'LEGACY',options:[{typeId:type.id,valueId:value.id}],stockQuantity:5});
 // Deliberate supported database legacy state; a current Portal PATCH normalizes it.
 await f.store.run("UPDATE product SET variant_group='' WHERE id=?",initial.id);
 const before=await getProduct(f.store,initial.id,true),stock=await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),movements=await f.store.all('SELECT * FROM inventory_movement ORDER BY id');
 const projected=await f.store.transaction(async()=>{const patch=await prepareProductUpdate(f.store,before,{variantGroup:''});assert.equal(patch.variantGroup,null);return projectCatalogMediaMove(f.store,await readMediaSnapshot(f.store,before.id),{productId:before.id,targetPlan:null,patch});});
 assert.equal(projected.bindings.newPrivateListing,false);assert.deepEqual(projected.physicalEffects,[]);assert.deepEqual(projected.removedListingIds,[]);assert.equal(projected.after.products[0].listingId,before.listingId);
 await assert.rejects(f.store.transaction(()=>readCatalogMediaMetadata(f.store,{productId:before.id,changes:{variantGroup:null,variantLabel:null},plannedIdentity:null})),{status:409,code:'CATALOG_DEPENDENCY_CHANGED'});
 const actual=await trackUpdate(f.store,before.id,'synthetic_owner',()=>updateProduct(f.store,before.id,{variantGroup:''}));
 assert.equal(actual.listingId,before.listingId);assert.equal(actual.variantGroup,null);assert.equal(actual.variantLabel,null);assert.deepEqual(actual.options,[]);assert.equal(actual.createdAt,before.createdAt);assert.equal(actual.stockQuantity,5);
 assert.deepEqual(projected.afterViews[0].visible.map(row=>row.id),actual.galleryItems.map(row=>row.id));
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM listing')).n,1);assert.ok(await f.store.get('SELECT id FROM listing WHERE id=?',before.listingId));
 assert.deepEqual(await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),stock);assert.deepEqual(await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),movements);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?',before.id)).n,1);
});
