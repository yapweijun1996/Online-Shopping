import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryToolFixture,inventoryDto as dto } from './helpers/mcp-inventory-fixture.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual default inventory tools read complete revision and adjust only after human approval once`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryToolFixture(t,dialect),p=await f.product(),before=await f.summary(p.id);assert.equal(before.onHand,8);assert.equal(before.stockRevision,1);assert.equal(before.held,0);assert.equal(before.available,8);assert.equal(before.coverage.writerCoverage,'APPLICATION_WRITERS');
 const prepared=await f.preview(p,3,{note:'  </pre><script>window.injected=true</script> Private count note  '}),op=dto(prepared);
 assert.equal(op.status,'PENDING_APPROVAL');assert.equal((await f.commit(op)).response.status,403);
 const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId),proposal=JSON.parse(row.envelope_json).proposal;
 assert.equal(row.risk,'HIGH');assert.equal(proposal.before.onHand,8);assert.equal(proposal.after.onHand,3);assert.match(proposal.note,/Private count note/);
 assert.equal((await f.approve(op)).response.status,200);
 const results=await Promise.all([f.commit(op),f.commit(op)]),receipts=results.map(dto);assert.deepEqual(receipts.map(r=>r.replayed).sort(),[false,true]);assert.deepEqual(receipts[0].result,receipts[1].result);
 const after=await f.summary(p.id);assert.equal(after.onHand,3);assert.equal(after.stockRevision,2);assert.notEqual(after.revision,before.revision);assert.equal(after.revision,receipts[0].result.revision);
 const movement=await f.store.get("SELECT * FROM inventory_movement WHERE source='MCP_ADJUST'");assert.equal(movement.reason_code,'COUNT_CORRECTION');assert.equal(movement.actor_id,f.account.id);assert.equal(movement.operation_id,op.operationId);assert.equal(movement.delta_quantity,-5);assert.equal(movement.client_id,row.client_id);assert.equal(movement.grant_id,row.grant_id);assert.equal(movement.correlation_id,row.correlation_id);
 assert.doesNotMatch(JSON.stringify(movement),/Private count note|Synthetic inventory item|window.injected/);assert.doesNotMatch(JSON.stringify(receipts),/Private count note|Synthetic inventory item|window.injected/);assert.ok(Buffer.byteLength(JSON.stringify(receipts[0].result))<=2048);
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM product_event WHERE product_id=? AND action='UPDATED'",p.id)).n,1);assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n,1);
 const page=dto(await f.client.call('inventory.movements',{productId:p.id,limit:1}));assert.equal(page.items[0].kind,'SET');assert.equal(page.items[0].stockRevision,2);assert.equal(page.nextBeforeRevision,2);assert.doesNotMatch(JSON.stringify(page),/actor|clientId|orderId|note|correlation|source_key/);
 const next=dto(await f.client.call('inventory.movements',{productId:p.id,beforeRevision:page.nextBeforeRevision,limit:1}));assert.equal(next.items[0].stockRevision,1);assert.equal(next.nextBeforeRevision,null);
});

import { randomUUID } from 'node:crypto';
import { updateProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { inventorySnapshot } from '../src/inventory-reads.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { hash,stamp } from '../src/mcp/credentials.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { createAccount } from '../src/accounts.js';
const rowState=async store=>{const state=[];for(const name of ['product','inventory_state','inventory_movement','product_event','shop_order','order_event'])state.push([name,rowsDigest(await store.all(`SELECT * FROM ${name}`))]);return state;};
async function submit(f,p,quantity=2){const result=await createOrder(f.store,'synthetic-inventory-order-'+randomUUID(),{buyer:{fullName:'Private synthetic buyer',whatsappPhone:'+6581234567'},whatsappOrderContactOptIn:true,deliveries:[{recipient:{fullName:'Private synthetic recipient',phone:'+60123456789'},address:{line1:'Private synthetic address',postcode:'50000',country:'MY'},items:[{productId:p.id,quantity,expectedPriceMinor:p.priceMinor,expectedCurrency:p.currency}]}]});return f.store.get('SELECT id,status,revision FROM shop_order WHERE order_no=?',result.receipt.orderNo);}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: exact closed arguments, missing targets, no-op and stale expected revisions create no operation`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),current=await f.summary(p.id),input={productId:p.id,expectedRevision:current.revision,stockQuantity:3,reasonCode:'RECEIPT'};
  for(const [name,args] of [['inventory.summary',{}],['inventory.summary',{productId:randomUUID()}],['inventory.movements',{productId:p.id,limit:101}],['inventory.movements',{productId:randomUUID()}],
   ...[{actorId:f.account.id},{tenantId:'other'},{source:'MCP_ADJUST'},{asOf:stamp()},{approved:true},{reasonCode:'human freeform'},{stockQuantity:-1},{stockQuantity:1000001},{stockQuantity:1.1},{note:'x'.repeat(501)}].map(extra=>['inventory.preview_adjustment',{input:{...input,...extra},idempotencyKey:'synthetic-invalid-'+randomUUID()}]),
   ['inventory.commit_adjustment',{operationId:randomUUID(),stockQuantity:0}]])assert.equal((await f.client.call(name,args)).data.error.code,-32602,name);
  assert.equal((await f.preview(p,8)).data.error.code,-32009);
  await updateProduct(f.store,p.id,{stockQuantity:7});assert.equal((await f.client.call('inventory.preview_adjustment',{input,idempotencyKey:'synthetic-stale-revision-0001'})).data.error.code,-32009);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM inventory_movement WHERE source='MCP_ADJUST'")).n,0);
 });
 test(`${dialect}: current scopes, fresh consent, role, tenant, revocation and configured shop fence all four tools`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),before=await f.summary(p.id),input={productId:p.id,expectedRevision:before.revision,stockQuantity:3,reasonCode:'OTHER'};
  const token=await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?',hash(f.client.bearer)),grant=token.grant_id;
  const calls=[['inventory.summary',{productId:p.id}],['inventory.movements',{productId:p.id}],['inventory.preview_adjustment',{input,idempotencyKey:'synthetic-authority-0001'}],['inventory.commit_adjustment',{operationId:randomUUID()}]];
  const deny=async(status=403)=>{for(const [name,args]of calls)assert.equal((await f.client.call(name,args)).response.status,status,name);};
  for(const [sql,args,restore,restored,status]of [
   ["UPDATE seller_account SET role='STAFF' WHERE id=?",[f.account.id],"UPDATE seller_account SET role='OWNER' WHERE id=?",[f.account.id],401],
   ["UPDATE oauth_grant SET tenant_id='other' WHERE id=?",[grant],'UPDATE oauth_grant SET tenant_id=? WHERE id=?',[f.binding.tenantId,grant],401],
   ["UPDATE shop_setup SET mode='demo' WHERE id=1",[],"UPDATE shop_setup SET mode='production' WHERE id=1",[]],
   ['UPDATE oauth_grant SET revoked_at=? WHERE id=?',[stamp(),grant],'UPDATE oauth_grant SET revoked_at=NULL WHERE id=?',[grant],401],
   ['UPDATE oauth_token SET revoked_at=? WHERE token_hash=?',[stamp(),hash(f.client.bearer)],'UPDATE oauth_token SET revoked_at=NULL WHERE token_hash=?',[hash(f.client.bearer)],401],
   ['UPDATE seller_account SET active=0 WHERE id=?',[f.account.id],'UPDATE seller_account SET active=1 WHERE id=?',[f.account.id],401],
  ]){await f.store.run(sql,...args);await deny(status);await f.store.run(restore,...restored);}
  await f.store.run('UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=?','0'.repeat(64),grant);await deny();
  const old=await freshCatalogAccess(f,legacyCatalogScopes);for(const[name,args]of calls)assert.equal((await old.call(name,args)).response.status,403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: genuinely fresh Manager OAuth and own first-party approval can adjust; read-only grant cannot write`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),temporary='SyntheticManagerTemporary123!',password='SyntheticManagerInventory123!';
  const manager=await createAccount(f.store,{username:'inventory_manager',password:temporary,role:'MANAGER'},'synthetic_owner');
  const login=await f.call('/api/v1/seller/session','POST',{username:'inventory_manager',password:temporary},{origin:f.config.sellerOrigin});assert.equal(login.response.status,200);
  const passwordChanged=await f.call('/api/v1/seller/account/password','POST',{currentPassword:temporary,newPassword:password},{origin:f.config.sellerOrigin,cookie:login.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':login.data.csrfToken});assert.equal(passwordChanged.response.status,200);
  const client=await freshCatalogAccess(f,legacyCatalogScopes+' inventory.read inventory.adjust',f.call,{username:'inventory_manager',password});
  const current=dto(await client.call('inventory.summary',{productId:p.id}));const op=dto(await client.call('inventory.preview_adjustment',{input:{productId:p.id,expectedRevision:current.revision,stockQuantity:4,reasonCode:'DAMAGE'},idempotencyKey:'synthetic-manager-adjust-0001'}));
  const path='/api/v1/seller/mcp/operations/'+op.operationId;assert.equal((await f.call(path,'GET',undefined,f.headers)).response.status,403);const review=await f.call(path,'GET',undefined,client.headers);
  assert.equal(review.response.status,200);const approved=await f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password},client.headers);assert.equal(approved.response.status,200);
  assert.equal(dto(await client.call('inventory.commit_adjustment',{operationId:op.operationId})).status,'COMMITTED');assert.equal((await f.store.get("SELECT actor_id FROM inventory_movement WHERE source='MCP_ADJUST'")).actor_id,manager.id);
  const read=await freshCatalogAccess(f,legacyCatalogScopes+' inventory.read');assert.equal((await read.call('inventory.summary',{productId:p.id})).response.status,200);assert.equal((await read.call('inventory.commit_adjustment',{operationId:op.operationId})).response.status,403);
 });
 test(`${dialect}: stock ABA, current portal edits, checkout, hold expiry and order decisions invalidate approved stock changes`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect);
  const stale=async(p,mutate)=>{const op=dto(await f.preview(p,4));assert.equal((await f.approve(op)).response.status,200);await mutate();const before=await rowState(f.store),result=dto(await f.commit(op));assert.equal(result.error,'STALE_REVISION');assert.deepEqual(await rowState(f.store),before);assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'CONFLICT');};
  const p=await f.product();await stale(p,async()=>{await updateProduct(f.store,p.id,{stockQuantity:2});await updateProduct(f.store,p.id,{stockQuantity:8});});
  const named=await f.product();await stale(named,()=>updateProduct(f.store,named.id,{name:'Changed reviewed identity'}));
  const checkout=await f.product();await stale(checkout,()=>submit(f,checkout));
  const expired=await f.product(),held=await submit(f,expired);await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(Date.now()-47*3600000).toISOString(),held.id);
  await stale(expired,()=>f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(Date.now()-49*3600000).toISOString(),held.id));
  const decided=await f.product(),order=await submit(f,decided);await stale(decided,()=>decideSellerOrder(f.store,order.id,'reject',{expectedRevision:1,reason:'Synthetic rejection'},'synthetic_owner'));
  const confirmed=await f.product(),confirmedOrder=await submit(f,confirmed);await decideSellerOrder(f.store,confirmedOrder.id,'confirm',{expectedRevision:1},'synthetic_owner');
  await stale(confirmed,()=>decideSellerOrder(f.store,confirmedOrder.id,'cancel',{expectedRevision:2,reason:'Synthetic cancellation'},'synthetic_owner'));
 });
 test(`${dialect}: below-hold adjustments and unlimited mode preserve policy; confirmed mode flips cannot be proposed`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product();await submit(f,p,3);
  const op=dto(await f.preview(p,1));assert.equal((await f.approve(op)).response.status,200);assert.equal(dto(await f.commit(op)).status,'COMMITTED');
  const after=await f.summary(p.id);assert.equal(after.held,3);assert.equal(after.available,0);assert.equal(after.shortfall,2);
  const unlimited=dto(await f.preview(p,null));assert.equal((await f.approve(unlimited)).response.status,200);assert.equal(dto(await f.commit(unlimited)).status,'COMMITTED');assert.equal((await f.summary(p.id)).available,null);
  const finite=dto(await f.preview(p,8));assert.equal((await f.approve(finite)).response.status,200);assert.equal(dto(await f.commit(finite)).status,'COMMITTED');
  const existing=await f.store.get("SELECT id,revision FROM shop_order WHERE status='SUBMITTED'");await decideSellerOrder(f.store,existing.id,'confirm',{expectedRevision:existing.revision},'synthetic_owner');
  assert.equal((await f.preview(p,null)).data.error.code,-32009);
 });
 test(`${dialect}: wrong challenge/hash/client or revoked grant cannot authorize an otherwise valid proposal`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),op=dto(await f.preview(p,3));
  assert.equal((await f.approve(op,{challenge:'A'.repeat(43)})).response.status,403);
  assert.equal((await f.approve(op,{previewHash:'0'.repeat(64)})).response.status,403);
  assert.equal((await f.commit(op)).response.status,403);assert.equal((await f.approve(op)).response.status,200);
  const other=await freshCatalogAccess(f,legacyCatalogScopes+' inventory.read inventory.adjust');assert.equal((await other.call('inventory.commit_adjustment',{operationId:op.operationId})).response.status,403);
  const grant=await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?',hash(f.client.bearer));await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',stamp(),grant.grant_id);
  assert.equal((await f.commit(op)).response.status,401);assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM inventory_movement WHERE source='MCP_ADJUST'")).n,0);
 });
 test(`${dialect}: late ledger/product history/operation audit failures roll back adjustment and leave no false receipt`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product();
  for(const needle of ['INSERT INTO inventory_movement','INSERT INTO product_event','COMMIT']){
   const op=dto(await f.preview(p,3)),approved=await f.approve(op);assert.equal(approved.response.status,200);const before=await rowState(f.store),run=f.store.run;
   f.store.run=async(sql,...args)=>{await run(sql,...args);if(needle==='COMMIT'?sql.includes('INSERT INTO mcp_v2_event')&&args.includes('COMMIT'):sql.includes(needle))throw new Error('Synthetic adjustment evidence failure');};
   const failed=await f.commit(op);f.store.run=run;assert.equal(failed.data.error.code,-32603);assert.deepEqual(await rowState(f.store),before);
   const row=await f.store.get('SELECT state,result_json FROM mcp_v2_operation WHERE id=?',op.operationId);assert.equal(row.state,'FAILED');assert.equal(row.result_json,null);
  }
 });
 test(`${dialect}: adjustment and real order confirmation race never lose stock or duplicate a movement`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),order=await submit(f,p,2),op=dto(await f.preview(p,10));assert.equal((await f.approve(op)).response.status,200);
  const [adjusted]=await Promise.all([f.commit(op),decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner')]);const result=dto(adjusted),rows=await f.store.all('SELECT revision,before_quantity,after_quantity FROM inventory_movement WHERE product_id=? ORDER BY revision',p.id);
  for(let i=1;i<rows.length;i++)assert.equal(rows[i].before_quantity,rows[i-1].after_quantity);
  if(result.status==='COMMITTED'){assert.equal(rows.length,3);assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);}else{assert.equal(result.error,'STALE_REVISION');assert.equal(rows.length,2);assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,6);}
  assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',order.id)).status,'CONFIRMED');
 });
}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual commit captures fresh server time and rejects naturally expired holds without hashing wall clock`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryToolFixture(t,dialect),p=await f.product(),order=await submit(f,p),clock=Date.now;
 await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(clock()-48*3600000+60000).toISOString(),order.id);
 const before=await f.summary(p.id),again=await f.summary(p.id);assert.equal(before.revision,again.revision);
 const op=dto(await f.preview(p,4));assert.equal((await f.approve(op)).response.status,200);const physical=await rowState(f.store);
 Date.now=()=>clock()+61000;
 try{const done=dto(await f.commit(op));assert.equal(done.error,'STALE_REVISION');assert.deepEqual(await rowState(f.store),physical);}finally{Date.now=clock;}
});
import { maintainOperations } from '../src/mcp/operation-maintenance.js';
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: real inventory review requires matching session, Origin and CSRF; read audit failure accepts no read`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),op=dto(await f.preview(p,4)),path='/api/v1/seller/mcp/operations/'+op.operationId;
  assert.equal((await f.call(path,'GET')).response.status,403);
  for(const headers of [{...f.client.headers,origin:'https://untrusted.example.test'},{...f.client.headers,'x-csrf-token':''},{...f.client.headers,cookie:''}]){
   const review=await f.call(path,'GET',undefined,f.client.headers);assert.equal(review.response.status,200);
   const denied=await f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password:'Synthetic-route-password-2026!'},headers);assert.equal(denied.response.status,403);
  }
  assert.equal((await f.commit(op)).response.status,403);assert.equal((await f.approve(op)).response.status,200);
  const previous=await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event='READ' AND outcome LIKE 'inventory.%'"),run=f.store.run;
  f.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.includes('INSERT INTO mcp_audit')&&args.includes('READ'))throw new Error('Synthetic inventory read audit failure');};
  try{for(const[name,args]of [['inventory.summary',{productId:p.id}],['inventory.movements',{productId:p.id}]])assert.equal((await f.client.call(name,args)).data.error.code,-32603);}finally{f.store.run=run;}
  assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event='READ' AND outcome LIKE 'inventory.%'")).n,previous.n);assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);
 });
 test(`${dialect}: adjustment note expires with proposal while minimal receipt and fixed movement/audit evidence remain`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect),p=await f.product(),note='Synthetic private expiring inventory count note',op=dto(await f.preview(p,4,{note}));assert.equal((await f.approve(op)).response.status,200);const result=dto(await f.commit(op));
  const clock=Date.now;Date.now=()=>clock()+11*60000;
  try{await maintainOperations(f.store,{enabled:true,tenantId:'default',tenantGuard:{withActiveTenant:(_id,work)=>work({revision:0})}});}finally{Date.now=clock;}
  const row=await f.store.get('SELECT envelope_json,result_json,redacted_at FROM mcp_v2_operation WHERE id=?',op.operationId);assert.equal(row.envelope_json,null);assert.ok(row.redacted_at);assert.deepEqual(JSON.parse(row.result_json),result.result);
  for(const table of ['inventory_movement','product_event','mcp_v2_event','mcp_audit'])assert.doesNotMatch(JSON.stringify(await f.store.all(`SELECT * FROM ${table}`)),/Synthetic private expiring inventory count note/);
  assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM inventory_movement WHERE source='MCP_ADJUST' AND reason_code='COUNT_CORRECTION'")).n,1);
 });
}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: real inventory commit/history reads no product media, description, variant or contact bytes`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryToolFixture(t,dialect),p=await f.product(),op=dto(await f.preview(p,4));assert.equal((await f.approve(op)).response.status,200);const original={get:f.store.get,all:f.store.all};let stockReads=0;
 for(const name of Object.keys(original))f.store[name]=(sql,...args)=>{if(/^\s*SELECT/.test(sql)&&/\b(?:FROM|JOIN)\s+(?:product|order_item|shop_order|delivery)\b/.test(sql)){stockReads++;assert.doesNotMatch(sql,/SELECT\s+\*|image_data|thumb_data|description|gallery|variant|buyer_|recipient_|address_/i);}return original[name](sql,...args);};
 try{assert.equal(dto(await f.commit(op)).status,'COMMITTED');}finally{Object.assign(f.store,original);}assert.ok(stockReads>0);
 const event=await f.store.get("SELECT changes FROM product_event WHERE product_id=? AND action='UPDATED'",p.id);assert.deepEqual(JSON.parse(event.changes),[{field:'stockQuantity',from:8,to:4}]);
});
