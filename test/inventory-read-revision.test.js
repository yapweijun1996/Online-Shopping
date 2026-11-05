import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { inventorySnapshot, inventoryMovements, INVENTORY_READ_LIMITS } from '../src/inventory-reads.js';
import { updateProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { rowsDigest } from '../src/sqlite-import.js';
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: complete stock revision hashes relevant labels/facts and actual expiry, excludes clock and unrelated price`,options,async t=>{
  const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:10}),asOf=Date.now(),order=await f.order([p],2),cutoff=asOf-48*3600000;
  await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(cutoff+1).toISOString(),order.id);
  const a=await inventorySnapshot(f.store,p.id,asOf),b=await inventorySnapshot(f.store,p.id,asOf);assert.equal(a.held,2);assert.equal(a.revision,b.revision);
  const expired=await inventorySnapshot(f.store,p.id,asOf+1);assert.equal(expired.held,0);assert.notEqual(expired.revision,a.revision);
  const sourceDigest=rowsDigest(await f.store.all('SELECT * FROM inventory_movement'));
  await updateProduct(f.store,p.id,{priceMinor:600});assert.equal((await inventorySnapshot(f.store,p.id,asOf)).revision,a.revision);
  await updateProduct(f.store,p.id,{description:'Ignored private product text'});assert.equal((await inventorySnapshot(f.store,p.id,asOf)).revision,a.revision);
  await updateProduct(f.store,p.id,{name:'Changed approved identity'});assert.notEqual((await inventorySnapshot(f.store,p.id,asOf)).revision,a.revision);assert.equal(rowsDigest(await f.store.all('SELECT * FROM inventory_movement')),sourceDigest);
  await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');const confirmed=await inventorySnapshot(f.store,p.id,asOf);assert.equal(confirmed.confirmedOrders,1);
  await decideSellerOrder(f.store,order.id,'ship',{expectedRevision:2,carrier:'Synthetic carrier',trackingNo:'SYN-1'},'synthetic_owner');assert.notEqual((await inventorySnapshot(f.store,p.id,asOf)).revision,confirmed.revision);
 });
 test(`${dialect}: bounded source-row and UTF8 metadata bytes reject BEFORE row materialization, never scan unrelated product history`,options,async t=>{
  const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:null}),other=await f.product({stockQuantity:null}),order=await f.order([p]),delivery=await f.store.get('SELECT id FROM delivery WHERE order_id=?',order.id);
  const seed=async(product,count)=>{await f.store.transaction(async()=>{for(let n=1;n<=count;n++)await f.store.run(`INSERT INTO order_item(id,delivery_id,position,product_id,sku_snapshot,name_snapshot,price_minor,quantity,line_total_minor,currency) VALUES(?,?,?,?,?,?,500,1,500,'MYR')`,randomUUID(),delivery.id,n,product.id,'SYNTHETIC','Private synthetic item');});};
  await seed(other,10001);assert.equal((await inventorySnapshot(f.store,p.id)).held,1);
  await f.store.run('DELETE FROM order_item WHERE product_id=?',other.id);
  await seed(p,9999);const full=await inventorySnapshot(f.store,p.id);assert.equal(full.held,10000);
  const all=f.store.all;let detailQueries=0;f.store.all=(sql,...args)=>{if(sql.includes('SELECT i.id,i.delivery_id'))detailQueries++;return all(sql,...args);};
  await f.store.run(`INSERT INTO order_item(id,delivery_id,position,product_id,sku_snapshot,name_snapshot,price_minor,quantity,line_total_minor,currency) VALUES(?,?,?,?,?,?,500,1,500,'MYR')`,randomUUID(),delivery.id,10001,p.id,'SYNTHETIC','Private synthetic item');
  await assert.rejects(inventorySnapshot(f.store,p.id),{status:503,code:'INVENTORY_LIMIT'});assert.equal(detailQueries,0);f.store.all=all;
  await f.store.run('DELETE FROM order_item WHERE product_id=? AND position=10001',p.id);
  // Noncanonical but index-sized legacy metadata crosses the byte budget.
  // Preflight rejects it before loading any of those strings into the result.
  await f.store.run('UPDATE order_item SET id=?||id WHERE product_id=?','大'.repeat(170),p.id);
  f.store.all=(sql,...args)=>{if(sql.includes('SELECT i.id,i.delivery_id'))throw new Error('Oversized metadata must not materialize');return all(sql,...args);};
  await assert.rejects(inventorySnapshot(f.store,p.id),{status:503,code:'INVENTORY_LIMIT'});f.store.all=all;
 });
 test(`${dialect}: metadata-only snapshots and stable movement keyset reveal no actor/order/notes and never mutate business state`,options,async t=>{
  const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:8});for(const quantity of [7,6,5])await updateProduct(f.store,p.id,{stockQuantity:quantity});
  const before=rowsDigest(await f.store.all('SELECT * FROM product')),methods={get:f.store.get,all:f.store.all,run:f.store.run,exec:f.store.exec};let reads=0;
  for(const key of Object.keys(methods))f.store[key]=(sql,...args)=>{reads++;assert.match(sql,/^\s*SELECT/);assert.doesNotMatch(sql,/image_data|thumb_data|buyer_|recipient_|address_|SELECT\s+\*/i);return methods[key](sql,...args);};
  let first;try{await inventorySnapshot(f.store,p.id);first=await inventoryMovements(f.store,{productId:p.id,limit:2});}finally{Object.assign(f.store,methods);}assert.ok(reads>0);assert.deepEqual(first.items.map(r=>r.stockRevision),[4,3]);assert.equal(rowsDigest(await f.store.all('SELECT * FROM product')),before);
  await updateProduct(f.store,p.id,{stockQuantity:4});const next=await inventoryMovements(f.store,{productId:p.id,limit:2,beforeRevision:first.nextBeforeRevision});assert.deepEqual(next.items.map(r=>r.stockRevision),[2,1]);assert.equal(next.nextBeforeRevision,null);assert.doesNotMatch(JSON.stringify(next),/actor|orderId|note|client|correlation/);
 });
}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: missing or changed index fails before any source scan on an already-open store`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,dialect),p=await f.product(),get=f.store.get,all=f.store.all;
 for(const changed of [false,true]){
  await f.store.exec('DROP INDEX order_item_inventory');if(changed)await f.store.exec('CREATE INDEX order_item_inventory ON order_item(delivery_id,product_id,id)');
  let sourceQueries=0;for(const key of ['get','all'])f.store[key]=(sql,...args)=>{if(sql.includes('FROM order_item'))sourceQueries++;return(key==='get'?get:all)(sql,...args);};
  await assert.rejects(inventorySnapshot(f.store,p.id),{status:503,code:'INVENTORY_UNAVAILABLE'});assert.equal(sourceQueries,0);f.store.get=get;f.store.all=all;
  if(!changed)await f.store.exec('CREATE INDEX order_item_inventory ON order_item(product_id, id, delivery_id)');
 }
});
