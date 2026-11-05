import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderToolFixture,orderDto as dto } from './helpers/mcp-order-fixture.js';
import { createOrder } from '../src/orders.js';
import { updateProduct } from '../src/products.js';
import { applySellerDecision } from '../src/seller-orders.js';
import { orderDecisionSnapshot } from '../src/order-decisions.js';
const body=groups=>({buyer:{fullName:'Synthetic private cap buyer',whatsappPhone:'+6581234567'},whatsappOrderContactOptIn:true,deliveries:groups.map(products=>({recipient:{fullName:'Synthetic private cap recipient',phone:'+60123456789'},address:{line1:'Synthetic private cap address',postcode:'50000',country:'MY'},items:products.map(p=>({productId:p.id,quantity:1,expectedPriceMinor:p.priceMinor,expectedCurrency:p.currency}))}))});
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: actual100-line/50-product review fits canonical envelope and valid oversized Unicode/membership fail503 without truncation`,options,async t=>{
  const f=await orderToolFixture(t,dialect),products=[];for(let n=0;n<50;n++)products.push(await f.product({stockQuantity:1000000}));const order=await f.order(products,1,2);
  const prepared=await f.preview(order.id,{action:'confirm'}),op=dto(prepared),proposal=JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',op.operationId)).envelope_json).proposal;assert.equal(proposal.items.length,100);assert.equal(proposal.stockEffects.length,50);assert.ok(Buffer.byteLength(JSON.stringify(proposal))<=49152);
  for(let n=0;n<50;n++)products[n]=await updateProduct(f.store,products[n].id,{sku:'S'+String(n).padStart(39,'0'),name:'汉'.repeat(120)});
  const wide=await f.order(products,1,2),all=f.store.all;let loaded=false;f.store.all=(sql,...args)=>{if(sql.includes('AS price_text'))loaded=true;return all(sql,...args);};
  const oversized=await f.preview(wide.id,{action:'confirm'});f.store.all=all;assert.equal(oversized.response.status,503);assert.equal(loaded,false,'UTF8 line preflight runs before materialization');assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,1);
  const extra=await f.product({stockQuantity:1000000}),created=await createOrder(f.store,'synthetic-51-products-'+randomUUID(),body([products,[extra]])),large=await f.store.get('SELECT id FROM shop_order WHERE order_no=?',created.receipt.orderNo);
  assert.equal((await f.preview(large.id,{action:'confirm'})).response.status,503);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,1);
  // The channel cap is not a new legacy business restriction.
  await applySellerDecision(f.store,large.id,'confirm',{expectedRevision:1},'synthetic_owner');assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',large.id)).status,'CONFIRMED');assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement WHERE order_id=?',large.id)).n,51);
 });
 test(`${dialect}: complete money/currency failures and historical101-line source reject before proposal`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]);await f.store.run('UPDATE shop_order SET total_minor=total_minor+1 WHERE id=?',order.id);assert.equal((await f.preview(order.id,{action:'confirm'})).response.status,503);await f.store.run('UPDATE shop_order SET total_minor=total_minor-1 WHERE id=?',order.id);await f.store.run("UPDATE order_item SET currency='SGD' WHERE delivery_id IN (SELECT id FROM delivery WHERE order_id=?)",order.id);assert.equal((await f.preview(order.id,{action:'confirm'})).response.status,503);await f.store.run("UPDATE order_item SET currency='MYR' WHERE delivery_id IN (SELECT id FROM delivery WHERE order_id=?)",order.id);
  const delivery=await f.store.get('SELECT id FROM delivery WHERE order_id=?',order.id);await f.store.transaction(async()=>{for(let n=1;n<=100;n++)await f.store.run("INSERT INTO order_item(id,delivery_id,position,product_id,sku_snapshot,name_snapshot,price_minor,quantity,line_total_minor,currency) VALUES(?,?,?,?,?,?,500,1,500,'MYR')",randomUUID(),delivery.id,n,p.id,'SYN','Synthetic');});
  const all=f.store.all;f.store.all=(sql,...args)=>{if(sql.includes('AS price_text'))throw new Error('Over-limit order lines must not materialize');return all(sql,...args);};const large=await f.preview(order.id,{action:'confirm'});f.store.all=all;assert.equal(large.response.status,503);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: joint affected-product source budget denies before per-product fact loading and missing index prevents scans`,options,async t=>{
  const f=await orderToolFixture(t,dialect),a=await f.product({stockQuantity:null}),b=await f.product({stockQuantity:null}),target=await f.order([a,b]),historical=await f.order([a,b]),delivery=await f.store.get('SELECT id FROM delivery WHERE order_id=?',historical.id);
  await f.store.transaction(async()=>{for(let n=2;n<12000;n++)await f.store.run("INSERT INTO order_item(id,delivery_id,position,product_id,sku_snapshot,name_snapshot,price_minor,quantity,line_total_minor,currency) VALUES(?,?,?,?,?,?,500,1,500,'MYR')",randomUUID(),delivery.id,n,n%2?a.id:b.id,'SYN','Synthetic');});
  const get=f.store.get;let productLoads=0;f.store.get=(sql,...args)=>{if(sql.includes('inventory_lines'))productLoads++;return get(sql,...args);};assert.equal((await f.preview(target.id,{action:'confirm'})).response.status,503);f.store.get=get;assert.equal(productLoads,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  await f.store.exec('DROP INDEX order_item_inventory');let scopedScans=0;f.store.get=(sql,...args)=>{if(sql.includes('affected_lines'))scopedScans++;return get(sql,...args);};await assert.rejects(orderDecisionSnapshot(f.store,target.id),{status:503,code:'ORDER_DECISION_UNAVAILABLE'});f.store.get=get;assert.equal(scopedScans,0);
 });
}
