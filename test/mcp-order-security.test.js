import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderToolFixture,orderDto as dto } from './helpers/mcp-order-fixture.js';
import { freshCatalogAccess,legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { hash,stamp } from '../src/mcp/credentials.js';
import { updateProduct } from '../src/products.js';
import { decideSellerOrder,applySellerDecision } from '../src/seller-orders.js';
import { rowsDigest } from '../src/sqlite-import.js';
const state=async store=>{const rows=[];for(const table of ['shop_order','order_item','order_event','product','inventory_state','inventory_movement'])rows.push([table,rowsDigest(await store.all(`SELECT * FROM ${table}`))]);return rows;};
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: closed decision fields, optional integer CAS and all invalid from-states reject before operation creation`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),base={orderId:order.id,decision:{action:'confirm'}};
  for(const input of [{}, {...base,expectedRevision:0},{...base,expectedRevision:'1'},{...base,orderId:randomUUID()},...['actorId','tenantId','approved','password','source','expectedResourceRevision','asOf','currency','totalMinor'].map(key=>({...base,[key]:'untrusted'})),
   ...[{action:'refund'},{action:'confirm',reason:'Unexpected'},{action:'reject'},{action:'reject',reason:'\ncontrol'},{action:'ship',carrier:'Carrier',reason:'Unexpected'},{action:'confirm',expectedRevision:1}].map(decision=>({...base,decision}))]){
   const result=await f.client.call('orders.preview_decision',{input,idempotencyKey:'synthetic-order-invalid-'+randomUUID()});assert.equal(result.data.error.code,-32602,JSON.stringify(input));}
  assert.equal((await f.preview(order.id,{action:'confirm'},{expectedRevision:99})).data.error.code,-32009);
  for(const decision of [{action:'ship',carrier:'Synthetic'},{action:'cancel',reason:'Synthetic'},{action:'deliver'}])assert.equal((await f.preview(order.id,decision)).data.error.code,-32009);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');
  for(const decision of [{action:'confirm'},{action:'reject',reason:'Synthetic'},{action:'deliver'}])assert.equal((await f.preview(order.id,decision)).data.error.code,-32009);
  assert.equal((await f.preview(order.id,{action:'ship'})).data.error.code,-32602);
  assert.equal((await f.client.call('orders.commit_decision',{operationId:randomUUID(),action:'confirm'})).data.error.code,-32602);
 });
 test(`${dialect}: current fresh scope/consent, role, tenant, revocation and ordinary mode fence both order tools`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),token=await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?',hash(f.client.bearer)),grant=token.grant_id;
  const calls=[['orders.preview_decision',{input:{orderId:order.id,decision:{action:'confirm'}},idempotencyKey:'synthetic-orders-authority-0001'}],['orders.commit_decision',{operationId:randomUUID()}]],deny=async status=>{for(const[name,args]of calls)assert.equal((await f.client.call(name,args)).response.status,status,name);};
  for(const[sql,args,restore,values,status]of [
   ["UPDATE seller_account SET role='STAFF' WHERE id=?",[f.account.id],"UPDATE seller_account SET role='OWNER' WHERE id=?",[f.account.id],401],
   ["UPDATE oauth_grant SET tenant_id='other' WHERE id=?",[grant],'UPDATE oauth_grant SET tenant_id=? WHERE id=?',[f.binding.tenantId,grant],401],
   ["UPDATE shop_setup SET mode='demo' WHERE id=1",[],"UPDATE shop_setup SET mode='production' WHERE id=1",[],403],
   ['UPDATE oauth_grant SET revoked_at=? WHERE id=?',[stamp(),grant],'UPDATE oauth_grant SET revoked_at=NULL WHERE id=?',[grant],401],
   ['UPDATE oauth_token SET revoked_at=? WHERE token_hash=?',[stamp(),hash(f.client.bearer)],'UPDATE oauth_token SET revoked_at=NULL WHERE token_hash=?',[hash(f.client.bearer)],401],
   ['UPDATE seller_account SET active=0 WHERE id=?',[f.account.id],'UPDATE seller_account SET active=1 WHERE id=?',[f.account.id],401],
  ]){await f.store.run(sql,...args);await deny(status);await f.store.run(restore,...values);}
  await f.store.run('UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=?','0'.repeat(64),grant);await deny(403);
  const old=await freshCatalogAccess(f,legacyCatalogScopes);for(const[name,args]of calls)assert.equal((await old.call(name,args)).response.status,403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: approved decisions reject stale portal order, physical stock ABA, checkout and naturally expired holds`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product();
  const stale=async(order,mutate)=>{const op=dto(await f.preview(order.id,{action:'confirm'}));assert.equal((await f.approve(op)).response.status,200);await mutate();const before=await state(f.store);assert.equal(dto(await f.commit(op)).error,'STALE_REVISION');assert.deepEqual(await state(f.store),before);};
  const changed=await f.order([p]);await stale(changed,()=>decideSellerOrder(f.store,changed.id,'reject',{expectedRevision:1,reason:'Synthetic portal decision'},'synthetic_owner'));
  const aba=await f.order([p]);await stale(aba,async()=>{await updateProduct(f.store,p.id,{stockQuantity:5});await updateProduct(f.store,p.id,{stockQuantity:10});});
  await decideSellerOrder(f.store,aba.id,'reject',{expectedRevision:1,reason:'Synthetic cleanup'},'synthetic_owner');
  const checkout=await f.order([p]);await stale(checkout,()=>f.order([p],1));
  const expiring=await f.order([p],1),clock=Date.now;await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(clock()-48*3600000+60000).toISOString(),expiring.id);
  const op=dto(await f.preview(expiring.id,{action:'confirm'}));await f.approve(op);const before=await state(f.store);Date.now=()=>clock()+61000;try{assert.equal(dto(await f.commit(op)).error,'STALE_REVISION');assert.deepEqual(await state(f.store),before);}finally{Date.now=clock;}
 });
 test(`${dialect}: already expired pending order can confirm against physical stock despite other active holds`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),old=await f.order([p],2);await f.store.run('UPDATE shop_order SET submitted_at=? WHERE id=?',new Date(Date.now()-49*3600000).toISOString(),old.id);await f.order([p],10);
  const op=dto(await f.preview(old.id,{action:'confirm'})),proposal=JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',op.operationId)).envelope_json).proposal,effect=proposal.stockEffects[0];
  assert.equal(effect.onHandBefore,10);assert.equal(effect.heldBefore,10);assert.equal(effect.heldAfter,10);assert.equal(effect.shortfallAfter,2);await f.approve(op);assert.equal(dto(await f.commit(op)).result.status,'CONFIRMED');assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);
 });
 test(`${dialect}: one short or overflowing product rejects full preview; shared mutation helper rolls back every order line`,options,async t=>{
  const f=await orderToolFixture(t,dialect),a=await f.product(),b=await f.product(),order=await f.order([a,b]);await updateProduct(f.store,b.id,{stockQuantity:1});let before=await state(f.store);
  assert.equal((await f.preview(order.id,{action:'confirm'})).data.error.code,-32009);assert.deepEqual(await state(f.store),before);await assert.rejects(applySellerDecision(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner'),{status:409,code:'INSUFFICIENT_STOCK'});assert.deepEqual(await state(f.store),before);
  await updateProduct(f.store,b.id,{stockQuantity:10});await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');const last=[a,b].sort((x,y)=>x.id.localeCompare(y.id)).at(-1);await updateProduct(f.store,last.id,{stockQuantity:1000000});before=await state(f.store);
  assert.equal((await f.preview(order.id,{action:'cancel',reason:'Synthetic overflow cancellation'})).data.error.code,-32009);assert.deepEqual(await state(f.store),before);await assert.rejects(applySellerDecision(f.store,order.id,'cancel',{expectedRevision:2,reason:'Synthetic overflow cancellation'},'synthetic_owner'),{status:409,code:'STOCK_LIMIT_CONFLICT'});assert.deepEqual(await state(f.store),before);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: ledger, order history and COMMIT audit failure atomically roll back status, both stocks and receipt`,options,async t=>{
  const f=await orderToolFixture(t,dialect),a=await f.product(),b=await f.product(),order=await f.order([a,b]);
  for(const needle of ['INSERT INTO inventory_movement','INSERT INTO order_event','COMMIT']){
   const op=dto(await f.preview(order.id,{action:'confirm'}));assert.equal((await f.approve(op)).response.status,200);const before=await state(f.store),run=f.store.run;
   f.store.run=async(sql,...args)=>{await run(sql,...args);if(needle==='COMMIT'?sql.includes('INSERT INTO mcp_v2_event')&&args.includes('COMMIT'):sql.includes(needle))throw new Error('Synthetic order evidence failure');};
   const failed=await f.commit(op);f.store.run=run;assert.equal(failed.data.error.code,-32603);assert.deepEqual(await state(f.store),before);const row=await f.store.get('SELECT state,result_json FROM mcp_v2_operation WHERE id=?',op.operationId);assert.equal(row.state,'FAILED');assert.equal(row.result_json,null);
  }
 });
 test(`${dialect}: actual confirm/cancel commits racing checkout preserve CAS, contiguous stock evidence and once-only replay`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product({stockQuantity:8}),order=await f.order([p],2),confirm=dto(await f.preview(order.id,{action:'confirm'}));await f.approve(confirm);
  const [decision,checkout]=await Promise.all([f.commit(confirm),f.order([p],2)]),confirmed=dto(decision);assert.ok(checkout.id);
  if(confirmed.error){assert.equal(confirmed.error,'STALE_REVISION');assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');}else{assert.equal(confirmed.result.status,'CONFIRMED');assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,6);}
  const cancel=dto(await f.preview(order.id,{action:'cancel',reason:'Synthetic raced cancellation'}));await f.approve(cancel);const [cancelled]=await Promise.all([f.commit(cancel),f.order([p],1)]),result=dto(cancelled);
  if(result.error){assert.equal(result.error,'STALE_REVISION');assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,6);}else{assert.equal(result.result.status,'CANCELLED');assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);assert.equal(dto(await f.commit(cancel)).replayed,true);}
  const moves=await f.store.all('SELECT revision,before_quantity,after_quantity FROM inventory_movement WHERE product_id=? ORDER BY revision',p.id);for(let i=1;i<moves.length;i++)assert.equal(moves[i].before_quantity,moves[i-1].after_quantity);
 });
 test(`${dialect}: first-party review and cross-client commit require exact session, Origin, CSRF, hash and password`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),op=dto(await f.preview(order.id,{action:'confirm'})),path='/api/v1/seller/mcp/operations/'+op.operationId;
  assert.equal((await f.call(path,'GET')).response.status,403);assert.equal((await f.approve(op,{challenge:'A'.repeat(43)})).response.status,403);assert.equal((await f.approve(op,{previewHash:'0'.repeat(64)})).response.status,403);
  for(const headers of [{...f.client.headers,origin:'https://untrusted.example.test'},{...f.client.headers,'x-csrf-token':''},{...f.client.headers,cookie:''}]){const review=await f.call(path,'GET',undefined,f.client.headers);assert.equal((await f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password:'Synthetic-route-password-2026!'},headers)).response.status,403);}
  assert.equal((await f.commit(op)).response.status,403);assert.equal((await f.approve(op)).response.status,200);const other=await freshCatalogAccess(f,legacyCatalogScopes+' orders.decide');assert.equal((await other.call('orders.commit_decision',{operationId:op.operationId})).response.status,403);
  const grant=await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?',hash(f.client.bearer));await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',stamp(),grant.grant_id);assert.equal((await f.commit(op)).response.status,401);assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',order.id)).status,'SUBMITTED');
 });
}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: genuinely fresh Manager account can approve its own order; current portal downgrade invalidates an approved decision`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),temporary='SyntheticOrdersTemporary123!',password='SyntheticOrdersManager123!';
  const created=await f.call('/api/v1/seller/accounts','POST',{username:'orders_manager',password:temporary,role:'MANAGER'},f.client.headers);assert.equal(created.response.status,201);const manager=created.data;
  const login=await f.call('/api/v1/seller/session','POST',{username:'orders_manager',password:temporary},{origin:f.config.sellerOrigin});assert.equal(login.response.status,200);
  const changed=await f.call('/api/v1/seller/account/password','POST',{currentPassword:temporary,newPassword:password},{origin:f.config.sellerOrigin,cookie:login.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':login.data.csrfToken});assert.equal(changed.response.status,200);
  const client=await freshCatalogAccess(f,legacyCatalogScopes+' orders.decide',f.call,{username:'orders_manager',password});
  const approve=async op=>{const path='/api/v1/seller/mcp/operations/'+op.operationId;assert.equal((await f.call(path,'GET',undefined,f.headers)).response.status,403);const review=await f.call(path,'GET',undefined,client.headers);assert.equal(review.response.status,200);return f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password},client.headers);};
  const first=dto(await client.call('orders.preview_decision',{input:{orderId:order.id,decision:{action:'confirm'}},idempotencyKey:'synthetic-manager-order-0001'}));assert.equal((await approve(first)).response.status,200);assert.equal(dto(await client.call('orders.commit_decision',{operationId:first.operationId})).result.status,'CONFIRMED');assert.equal((await f.store.get('SELECT actor_id FROM inventory_movement WHERE order_id=?',order.id)).actor_id,manager.id);
  const next=await f.order([p]),pending=dto(await client.call('orders.preview_decision',{input:{orderId:next.id,decision:{action:'confirm'}},idempotencyKey:'synthetic-manager-order-0002'}));await approve(pending);
  const downgraded=await f.call('/api/v1/seller/accounts/'+manager.id,'PATCH',{role:'STAFF'},f.client.headers);assert.equal(downgraded.response.status,200);assert.equal((await client.call('orders.commit_decision',{operationId:pending.operationId})).response.status,401);assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',next.id)).status,'SUBMITTED');
 });
 test(`${dialect}: preview and actual mutation-only commit never read contacts, notes, tracking history or image data`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),methods={get:f.store.get,all:f.store.all,run:f.store.run,exec:f.store.exec};let reads=0,previewing=true;
  for(const name of Object.keys(methods))f.store[name]=(sql,...args)=>{if(/^\s*SELECT/.test(sql)&&/\b(?:FROM|JOIN)\s+(?:shop_order|order_item|delivery|product)\b/i.test(sql)){reads++;assert.doesNotMatch(sql,/SELECT\s+\*|buyer_|recipient_|address_|contact_|image_data|thumb_data|tracking_carrier|tracking_no|description|gallery/i);}if(previewing)assert.doesNotMatch(sql,/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:shop_order|order_item|order_event|delivery|product|inventory_movement|inventory_state)\b/i);return methods[name](sql,...args);};
  let op;try{op=dto(await f.preview(order.id,{action:'confirm'}));}finally{Object.assign(f.store,methods);}assert.ok(reads>0);await f.approve(op);previewing=false;for(const name of Object.keys(methods))f.store[name]=(sql,...args)=>{if(/^\s*SELECT/.test(sql)&&/\b(?:FROM|JOIN)\s+(?:shop_order|order_item|delivery|product)\b/i.test(sql))assert.doesNotMatch(sql,/SELECT\s+\*|buyer_|recipient_|address_|contact_|image_data|thumb_data|tracking_carrier|tracking_no|description|gallery/i);return methods[name](sql,...args);};
  try{assert.equal(dto(await f.commit(op)).result.status,'CONFIRMED');}finally{Object.assign(f.store,methods);}
 });
 test(`${dialect}: legacy trim/NFC/action-specific validation is shared and historical money is not repriced`,options,async t=>{
  const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),items=rowsDigest(await f.store.all('SELECT * FROM order_item'));
  const op=dto(await f.preview(order.id,{action:'confirm'}));await updateProduct(f.store,p.id,{priceMinor:900});await f.approve(op);assert.equal(dto(await f.commit(op)).result.status,'CONFIRMED');assert.equal(rowsDigest(await f.store.all('SELECT * FROM order_item')),items);assert.equal((await f.store.get('SELECT total_minor FROM shop_order WHERE id=?',order.id)).total_minor,1000);
  const text=' '.repeat(600)+'Synthetic Cafe\u0301 carrier'+' '.repeat(600),ship=dto(await f.preview(order.id,{action:'ship',carrier:text,trackingNo:null}));
  const proposal=JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',ship.operationId)).envelope_json).proposal;assert.equal(proposal.decision.carrier,'Synthetic Café carrier');assert.equal(proposal.decision.trackingNo,null);await f.approve(ship);assert.equal(dto(await f.commit(ship)).result.status,'SHIPPED');
 });
}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: invalid action-specific fields and stale supplied integer fail before full order/stock source reads`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await orderToolFixture(t,dialect),p=await f.product(),order=await f.order([p]),get=f.store.get,all=f.store.all;let graphReads=0;
 for(const key of ['get','all'])f.store[key]=(sql,...args)=>{if(sql.includes('order_destinations')||sql.includes('affected_lines')||sql.includes('inventory_lines'))graphReads++;return(key==='get'?get:all)(sql,...args);};
 try{assert.equal((await f.preview(order.id,{action:'reject'})).data.error.code,-32602);assert.equal((await f.preview(order.id,{action:'confirm',reason:'Unexpected'})).data.error.code,-32602);assert.equal((await f.preview(order.id,{action:'confirm'},{expectedRevision:99})).data.error.code,-32009);}finally{f.store.get=get;f.store.all=all;}assert.equal(graphReads,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
});
