import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { updateProduct, getProduct } from '../src/products.js';
import { trackCreate, trackUpdate } from '../src/product-history.js';
import { importProducts } from '../src/product-import.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { reservedQuantity, reservedQuantitySql } from '../src/stock-reservation.js';
import { setupShop, resetDemo } from '../src/shop-setup.js';
import { withInventoryContext } from '../src/inventory.js';
import { rowsDigest } from '../src/sqlite-import.js';
const tables = ['product', 'inventory_coverage', 'inventory_state', 'inventory_movement', 'product_event', 'shop_order', 'order_event'];
const snapshot = async db => Promise.all(tables.map(async name => [name, rowsDigest(await db.all(`SELECT * FROM ${name}`))]));
const stock = async (db,id) => (await db.get('SELECT stock_quantity FROM product WHERE id=?',id)).stock_quantity;
const revision = async (db,id) => (await db.get('SELECT revision FROM inventory_state WHERE product_id=?',id)).revision;
for (const dialect of ['sqlite','postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: zero/unlimited initialize; omitted/no-op/ABA preserve history and stock revision semantics`,options,async t=>{
    const f=await inventoryFixture(t,dialect),a=await f.product({stockQuantity:0}),b=await f.product(),c=await f.product({stockQuantity:7});
    for (const [p,q] of [[a,0],[b,null],[c,7]]) {
      assert.equal(await stock(f.store,p.id),q);assert.equal(await revision(f.store,p.id),1);
      const row=await f.store.get('SELECT * FROM inventory_movement WHERE product_id=?',p.id);
      assert.equal(row.kind,'INITIALIZED');assert.equal(row.before_quantity,null);assert.equal(row.after_quantity,q);assert.equal(row.delta_quantity,null);assert.equal(row.occurred_at,p.createdAt);
      assert.equal((await f.store.get('SELECT origin FROM inventory_coverage WHERE product_id=?',p.id)).origin,'CREATED');
    }
    const before=await getProduct(f.store,c.id,true);
    await trackUpdate(f.store,c.id,'synthetic_owner',()=>updateProduct(f.store,c.id,{stockQuantity:7}));
    await updateProduct(f.store,c.id,{description:'Changed metadata'});
    assert.equal(await revision(f.store,c.id),1);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
    assert.ok((await getProduct(f.store,c.id,true)).updatedAt>before.updatedAt);
    await trackUpdate(f.store,c.id,'synthetic_owner',()=>updateProduct(f.store,c.id,{stockQuantity:2}));
    await trackUpdate(f.store,c.id,'synthetic_owner',()=>updateProduct(f.store,c.id,{stockQuantity:7}));
    assert.equal(await revision(f.store,c.id),3);assert.equal(await stock(f.store,c.id),7);
    const rows=await f.store.all('SELECT * FROM inventory_movement WHERE product_id=? ORDER BY revision',c.id),owner=await f.store.get('SELECT id FROM seller_account WHERE username=?','synthetic_owner');
    assert.deepEqual(rows.map(r=>r.delta_quantity),[null,-5,5]);assert.equal(rows[1].actor_kind,'SELLER');assert.equal(rows[1].actor_id,owner.id);
    await trackUpdate(f.store,c.id,'private arbitrary contact',()=>updateProduct(f.store,c.id,{stockQuantity:null}));
    const unknown=await f.store.get('SELECT * FROM inventory_movement WHERE product_id=? AND revision=4',c.id);assert.equal(unknown.kind,'TRACKING_DISABLED');assert.equal(unknown.actor_id,'business-service');
    await updateProduct(f.store,c.id,{stockQuantity:0});assert.equal(await revision(f.store,c.id),5);
  });
  test(`${dialect}: ledger and existing product history failures atomically roll back metadata, balance and revisions`,options,async t=>{
    const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:8}),before=await snapshot(f.store),run=f.store.run;
    for(const needle of ['INSERT INTO inventory_movement','INSERT INTO product_event']) {
      f.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.includes(needle))throw new Error('Synthetic ledger/history failure');};
      await assert.rejects(trackUpdate(f.store,p.id,'synthetic_owner',()=>updateProduct(f.store,p.id,{stockQuantity:3,name:'Must rollback'})),/Synthetic ledger\/history/);
      assert.deepEqual(await snapshot(f.store),before);f.store.run=run;
    }
    f.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.includes('INSERT INTO inventory_movement'))throw new Error('Synthetic create ledger failure');};
    await assert.rejects(trackCreate(f.store,'synthetic_owner',()=>f.product({stockQuantity:0})),/Synthetic create/);f.store.run=run;
    assert.deepEqual(await snapshot(f.store),before);
  });
  test(`${dialect}: confirmation/cancellation aggregate deliveries once; holds and mode restrictions remain unchanged`,options,async t=>{
    const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:10}),unlimited=await f.product();
    const order=await f.order([p,unlimited],2,2);assert.equal(await reservedQuantity(f.store,p.id),4);assert.equal(await stock(f.store,p.id),10);
    await updateProduct(f.store,p.id,{stockQuantity:2});assert.equal(await reservedQuantity(f.store,p.id),4);
    await assert.rejects(decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner'),{status:409,code:'INSUFFICIENT_STOCK'});
    assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',order.id)).status,'SUBMITTED');
    await updateProduct(f.store,p.id,{stockQuantity:10});await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');
    assert.equal(await stock(f.store,p.id),6);assert.equal(await revision(f.store,unlimited.id),1);
    const rows=await f.store.all('SELECT * FROM inventory_movement WHERE order_id=?',order.id);assert.equal(rows.length,1);assert.equal(rows[0].delta_quantity,-4);assert.equal(rows[0].order_revision,2);
    await assert.rejects(decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner'),{status:409});
    await assert.rejects(updateProduct(f.store,p.id,{stockQuantity:null}),{status:409,code:'STOCK_TRACKING_CONFLICT'});
    const historical=rowsDigest(await f.store.all('SELECT * FROM order_item'));
    await decideSellerOrder(f.store,order.id,'cancel',{expectedRevision:2,reason:'Private human order note'},'synthetic_owner');
    assert.equal(await stock(f.store,p.id),10);assert.equal(rowsDigest(await f.store.all('SELECT * FROM order_item')),historical);
    assert.doesNotMatch(JSON.stringify(await f.store.all('SELECT * FROM inventory_movement')),/Private human order note|Synthetic Buyer|Synthetic Recipient/);
    await updateProduct(f.store,p.id,{stockQuantity:null});assert.equal(await stock(f.store,p.id),null);
    const pending=await f.order([unlimited],1),asOf=Date.now(),cutoff=new Date(asOf-48*3600000).toISOString();
    await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',cutoff,pending.id);
    assert.equal(Number((await f.store.get(`SELECT ${reservedQuantitySql('?',asOf)} AS n`,unlimited.id)).n),0);
    await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(Date.parse(cutoff)+1).toISOString(),pending.id);
    assert.equal(Number((await f.store.get(`SELECT ${reservedQuantitySql('?',asOf)} AS n`,unlimited.id)).n),1);
  });
  test(`${dialect}: overflowing cancellation and late order-event failure roll back every product and evidence row`,options,async t=>{
    const f=await inventoryFixture(t,dialect),a=await f.product({stockQuantity:5}),b=await f.product({stockQuantity:5}),order=await f.order([a,b],2);
    await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');
    const sorted=[a,b].sort((x,y)=>x.id.localeCompare(y.id));await updateProduct(f.store,sorted[1].id,{stockQuantity:1000000});
    const before=await snapshot(f.store);
    await assert.rejects(decideSellerOrder(f.store,order.id,'cancel',{expectedRevision:2,reason:'cancel'},'synthetic_owner'),{status:409,code:'STOCK_LIMIT_CONFLICT'});
    assert.deepEqual(await snapshot(f.store),before);
    await updateProduct(f.store,sorted[1].id,{stockQuantity:3});const restored=await snapshot(f.store),run=f.store.run;
    f.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.includes('INSERT INTO order_event'))throw new Error('Synthetic order event failure');};
    await assert.rejects(decideSellerOrder(f.store,order.id,'cancel',{expectedRevision:2,reason:'cancel'},'synthetic_owner'),/Synthetic order/);f.store.run=run;
    assert.deepEqual(await snapshot(f.store),restored);
    await decideSellerOrder(f.store,order.id,'cancel',{expectedRevision:2,reason:'cancel'},'synthetic_owner');
    assert.deepEqual(await Promise.all([stock(f.store,a.id),stock(f.store,b.id)]),[5,5]);
  });
  test(`${dialect}: CSV absent/blank/no-op stock, variants and fixed operator contexts share the writer`,options,async t=>{
    const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:9});
    await importProducts(f.store,`SKU,Name\n${p.sku},CSV renamed`,'synthetic_owner');assert.equal(await revision(f.store,p.id),1);
    await importProducts(f.store,`SKU,Stock\n${p.sku},`,'synthetic_owner');assert.equal(await stock(f.store,p.id),null);assert.equal(await revision(f.store,p.id),2);
    await importProducts(f.store,`SKU,Stock\n${p.sku},`,'synthetic_owner');assert.equal(await revision(f.store,p.id),2);
    const row=await f.store.get('SELECT * FROM inventory_movement WHERE product_id=? AND revision=2',p.id);assert.equal(row.reason_code,'CSV_SET');assert.equal(row.source,'CSV');
    const csv='SKU,Name,Description,Category,Currency,Price,Stock,Active\nCSV-A,CSV item,Synthetic,TEST,MYR,5.00,0,yes\nCSV-B,CSV item,Synthetic,TEST,MYR,5.00,3,yes';
    const before=await snapshot(f.store),run=f.store.run;let writes=0;
    f.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.includes('INSERT INTO inventory_movement')&&++writes===2)throw new Error('Synthetic second CSV ledger failure');};
    await assert.rejects(importProducts(f.store,csv,'synthetic_owner'),/Synthetic second CSV/);f.store.run=run;assert.deepEqual(await snapshot(f.store),before);
    await importProducts(f.store,csv,'synthetic_owner');assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM inventory_movement WHERE reason_code='CSV_CREATE'")).n,2);
    const a=await f.product({variantGroup:'VAR',variantLabel:'A',stockQuantity:0}),b=await f.product({variantGroup:'VAR',variantLabel:'B',stockQuantity:4});
    assert.equal(await revision(f.store,a.id),1);assert.equal(await revision(f.store,b.id),1);
    const operator=await withInventoryContext({source:'OPERATOR',actorKind:'OPERATOR',actorId:'seed-demo-shop'},()=>f.product({stockQuantity:2}));
    assert.equal((await f.store.get('SELECT reason_code FROM inventory_movement WHERE product_id=?',operator.id)).reason_code,'OPERATOR_CREATE');
    assert.throws(()=>withInventoryContext({source:'MCP_ADJUST'},()=>{}),/Invalid trusted/);
    assert.throws(()=>withInventoryContext({source:'PRODUCT',actorKind:'SELLER',actorId:'forged name'},()=>{}),/Invalid trusted/);
  });
  test(`${dialect}: demo reset explicitly deletes only synthetic inventory dependents and reinitializes every product`,options,async t=>{
    const f=await inventoryFixture(t,dialect,{seed:false});await setupShop(f.store,{mode:'demo'});
    const count=(await f.store.get('SELECT COUNT(*) AS n FROM product')).n;assert.ok(count>0);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM inventory_movement WHERE reason_code='DEMO_CREATE' AND actor_kind='SYSTEM' AND actor_id='demo-seed'")).n,count);
    await resetDemo(f.store);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement')).n,count);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_state WHERE revision=1')).n,count);
    const run=f.store.run,before=await snapshot(f.store);f.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.includes('INSERT INTO inventory_movement'))throw new Error('Synthetic demo ledger failure');};
    await assert.rejects(resetDemo(f.store),/Synthetic demo/);f.store.run=run;assert.deepEqual(await snapshot(f.store),before);
    await f.store.run("UPDATE shop_setup SET mode='production' WHERE id=1");await assert.rejects(resetDemo(f.store),{status:409,code:'NOT_DEMO'});
  });
  test(`${dialect}: competing setters and confirm/cancel serialize into one contiguous stock movement chain`,options,async t=>{
    const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:10}),order=await f.order([p],2);
    await Promise.all([updateProduct(f.store,p.id,{stockQuantity:20}),decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner')]);
    await Promise.all([updateProduct(f.store,p.id,{stockQuantity:30}),decideSellerOrder(f.store,order.id,'cancel',{expectedRevision:2,reason:'cancel'},'synthetic_owner')]);
    const rows=await f.store.all('SELECT * FROM inventory_movement WHERE product_id=? ORDER BY revision',p.id);
    assert.deepEqual(rows.map(r=>r.revision),[1,2,3,4,5]);for(let i=1;i<rows.length;i++)assert.equal(rows[i].before_quantity,rows[i-1].after_quantity);
    assert.equal(await stock(f.store,p.id),rows.at(-1).after_quantity);assert.equal(await revision(f.store,p.id),5);
  });
}
