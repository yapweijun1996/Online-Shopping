import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { createCategory } from '../src/settings.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: genuine seller HTTP records portal, variant and CSV stock with v2 disabled`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await reviewFixture(t,dialect,{config:{mcpV2:{enabled:false}}});await createCategory(f.store,{code:'TEST',label:'Synthetic'});
 const input={sku:'PORTAL-A',name:'Synthetic portal item',description:'Synthetic',category:'TEST',priceMinor:500,stockQuantity:0,active:true,variantGroup:'PORTAL',variantLabel:'A'};
 const denied=await f.call('/api/v1/seller/products','POST',{...input,actorId:f.account.id,source:'MCP_ADJUST'},f.headers);assert.equal(denied.response.status,400);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement')).n,0);
 const created=await f.call('/api/v1/seller/products','POST',input,f.headers);assert.equal(created.response.status,201,JSON.stringify(created.data));const id=created.data.id;
 const second=await f.call('/api/v1/seller/products','POST',{...input,sku:'PORTAL-B',variantLabel:'B',stockQuantity:4},f.headers);assert.equal(second.response.status,201);
 const rows=await f.store.all('SELECT * FROM inventory_movement ORDER BY after_quantity');assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.after_quantity),[0,4]);assert.ok(rows.every(r=>r.actor_id===f.account.id&&r.actor_kind==='SELLER'&&r.reason_code==='PRODUCT_CREATE'&&r.client_id===null));
 const noop=await f.call('/api/v1/seller/products/'+id,'PATCH',{stockQuantity:0},f.headers);assert.equal(noop.response.status,200);assert.equal((await f.store.get('SELECT revision FROM inventory_state WHERE product_id=?',id)).revision,1);
 const metadata=await f.call('/api/v1/seller/products/'+id,'PATCH',{description:'Shared listing metadata'},f.headers);assert.equal(metadata.response.status,200);assert.equal((await f.store.get('SELECT revision FROM inventory_state WHERE product_id=?',second.data.id)).revision,1);
 const imported=await f.call('/api/v1/seller/products/import','POST',{csv:'SKU,Stock\nPORTAL-A,3\nPORTAL-B,',commit:true},f.headers);assert.equal(imported.response.status,200,JSON.stringify(imported.data));
 const changed=await f.store.all('SELECT * FROM inventory_movement WHERE revision=2 ORDER BY product_id');assert.equal(changed.length,2);assert.ok(changed.every(r=>r.source==='CSV'&&r.reason_code==='CSV_SET'&&r.actor_id===f.account.id));
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
});
