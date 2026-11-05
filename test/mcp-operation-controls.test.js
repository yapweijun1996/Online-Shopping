import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderToolFixture,orderDto,orderScopes } from './helpers/mcp-order-fixture.js';
import { freshCatalogAccess } from './helpers/mcp-catalog-default-grant.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';
import { hash } from '../src/mcp/credentials.js';
import { maintainOperations } from '../src/mcp/operation-maintenance.js';
import { cleanupMcpAudit } from '../src/mcp/audit.js';
import { readFile } from 'node:fs/promises';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { operationControlTools,OPERATION_CONTROL_CONTRACTS } from '../src/mcp/operation-control-contracts.js';
import { inventoryToolFixture,inventoryDto,inventoryScopes } from './helpers/mcp-inventory-fixture.js';
const scopes=orderScopes+' company.read company.write operations.read operations.cancel';
const get=(f,op)=>f.client.call('operations.get',{operationId:op.operationId});
const cancel=(f,op)=>f.client.call('operations.cancel',{operationId:op.operationId});
const audit=(f,op,args={})=>f.client.call('operations.audit',{operationId:op.operationId,...args});
const state=(f,op)=>f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId);
async function prepare(f,action='confirm') {const p=await f.product(),o=await f.order([p]);return {p,o,op:orderDto(await f.preview(o.id,{action}))};}
test('control registry accepts only fixed source contracts and exported schemas match runtime',async()=>{
 const [entry]=operationControlTools(),build=value=>createOperationTools({config:{mcpEnabled:false},entries:[value]});
 assert.doesNotThrow(()=>build(entry));
 for(const patch of [{name:'company.get'},{name:'__proto__'},{scope:'catalog.write'},{handler:()=>true},{inputSchema:{type:'object'}},{outputSchema:{type:'object'}}])assert.throws(()=>build({...entry,...patch}),TypeError);
 const bundle=JSON.parse(await readFile(new URL('../docs/mcp-v2/03-OPERATIONS-IMPLEMENTED.json',import.meta.url),'utf8'));
 for(const [name,contract]of Object.entries(OPERATION_CONTROL_CONTRACTS))for(const kind of ['input','output'])assert.deepEqual(bundle.$defs[name+'.'+kind],contract[kind+'Schema']);
});
for(const dialect of ['sqlite','postgres']) {
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: twelve-case actual RPC authority matrix covers every control`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),{op}=await prepare(f);
  const token=await f.store.get('SELECT * FROM oauth_token WHERE token_hash=?',hash(f.client.bearer));
  const cases=[
   {name:'Owner',status:200},
   {name:'Manager underlying order capability',sql:"UPDATE seller_account SET role='MANAGER' WHERE id=?",args:[f.account.id],status:200},
   {name:'Staff',sql:"UPDATE seller_account SET role='STAFF' WHERE id=?",args:[f.account.id],status:401},
   {name:'disabled',sql:'UPDATE seller_account SET active=0 WHERE id=?',args:[f.account.id],status:401},
   {name:'password reset required',sql:'UPDATE seller_account SET must_change_password=1 WHERE id=?',args:[f.account.id],status:401},
   {name:'token lacks control',tokenControl:true,status:403},
   {name:'token lacks underlying',sql:'UPDATE oauth_token SET scopes=? WHERE token_hash=?',args:[scopes.split(' ').filter(s=>s!=='orders.decide').join(' '),token.token_hash],status:403},
   {name:'grant lacks control',grantControl:true,status:403},
   {name:'grant lacks underlying',sql:'UPDATE oauth_grant SET scopes=? WHERE id=?',args:[scopes.split(' ').filter(s=>s!=='orders.decide').join(' '),token.grant_id],status:403},
   {name:'control consent absent',consentControl:true,status:403},
   {name:'underlying consent absent',sql:"DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='orders.decide'",args:[token.grant_id],status:403},
   {name:'different tenant record',sql:"UPDATE mcp_v2_operation SET tenant_id='other' WHERE id=?",args:[op.operationId],status:403},
  ];
  for(const scenario of cases)for(const name of ['operations.get','operations.audit','operations.cancel']) {
   const rollback=new Error('Synthetic matrix rollback'),scope=name==='operations.cancel'?'operations.cancel':'operations.read';
   await assert.rejects(f.store.transaction(async()=>{
    if(scenario.sql)await f.store.run(scenario.sql,...scenario.args);
    if(scenario.tokenControl)await f.store.run('UPDATE oauth_token SET scopes=? WHERE token_hash=?',scopes.split(' ').filter(s=>s!==scope).join(' '),token.token_hash);
    if(scenario.grantControl)await f.store.run('UPDATE oauth_grant SET scopes=? WHERE id=?',scopes.split(' ').filter(s=>s!==scope).join(' '),token.grant_id);
    if(scenario.consentControl)await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope=?',token.grant_id,scope);
    const result=await f.client.call(name,{operationId:op.operationId});assert.equal(result.response.status,scenario.status,scenario.name+' '+name+' '+JSON.stringify(result.data));
    if(scenario.status===200)assert.ok(result.data.result);
    throw rollback;
   }),error=>error===rollback);
   assert.equal((await state(f,op)).state,'PENDING_APPROVAL');
  }
 });
 test(`${dialect}: real OAuth/default RPC controls expose only safe own-grant metadata and cancel without commerce`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),{o,op}=await prepare(f);
  const listed=(await f.client.rpc('tools/list',{})).data.result.tools;
  assert.deepEqual(listed.filter(tool=>tool.name.startsWith('operations.')).map(tool=>tool.name).sort(),['operations.audit','operations.cancel','operations.get']);
  const dto=orderDto(await get(f,op));assert.equal(dto.status,'PENDING_APPROVAL');assert.equal(dto.resourceId,o.id);assert.equal(dto.resourceType,'order');
  assert.doesNotMatch(JSON.stringify(dto),/Synthetic private|"proposal":|"tracking":|"buyer":|"reason":|orderNo/i);
  assert.equal(dto.proposalRedacted,false);assert.equal(Object.hasOwn(dto,'envelope'),false);assert.equal(Object.hasOwn(dto,'result'),false);
  assert.equal((await f.client.call('operations.get',{operationId:op.operationId,scope:'orders.decide'})).data.error.code,-32602);
  assert.equal((await f.client.call('operations.get',{operationId:randomUUID()})).response.status,403);
  const other=await freshCatalogAccess(f,scopes);assert.equal((await other.call('operations.get',{operationId:op.operationId})).response.status,403);
  const cancelled=orderDto(await cancel(f,op));assert.deepEqual(cancelled,{operationId:op.operationId,status:'CANCELLED',replayed:false});
  assert.equal(orderDto(await cancel(f,op)).replayed,true);assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',o.id)).status,'SUBMITTED');
  assert.equal((await f.commit(op)).response.status,403);
  const events=await f.store.all("SELECT event,tool_name,outcome FROM mcp_v2_event WHERE operation_id=? AND event='CANCEL'",op.operationId);
  assert.deepEqual(events.map(r=>({...r})),[{event:'CANCEL',tool_name:'operations.cancel',outcome:'CANCELLED'}]);
  const page=orderDto(await audit(f,op));assert.equal(page.coverage.historicalUnlinkedCallsIncluded,false);assert.equal(page.coverage.preOperationStagesIncluded,false);
  assert.ok(page.items.some(item=>item.toolName==='operations.cancel'&&item.event==='CALL'&&item.outcome==='REPLAY'));
  assert.doesNotMatch(JSON.stringify(page),/Synthetic private|proposal|tracking|buyer|password|notes/i);
 });
 test(`${dialect}: stable two-sequence pages reject forged cross-binding cursors and exclude later insertions`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),{op}=await prepare(f);
  for(let n=0;n<4;n++)orderDto(await get(f,op));
  const first=orderDto(await audit(f,op,{limit:2}));assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  orderDto(await get(f,op));
  let next=first.nextCursor,items=[...first.items];while(next){const page=orderDto(await audit(f,op,{limit:2,cursor:next}));assert.deepEqual(page.coverage,first.coverage);items.push(...page.items);next=page.nextCursor;}
  assert.equal(new Set(items.map(i=>i.source+':'+i.sequence)).size,items.length);
  assert.ok(items.every(i=>i.sequence<=(i.source==='MCP'?first.coverage.callAnchor:first.coverage.lifecycleAnchor)));
  assert.equal(items.filter(i=>i.toolName==='operations.get').length,4);
  for(const args of [{limit:3,cursor:first.nextCursor},{limit:2,cursor:first.nextCursor.slice(0,-1)+'!'}])assert.equal((await audit(f,op,args)).data.error.code,-32602);
  const second=await prepare(f);assert.equal((await audit(f,second.op,{limit:2,cursor:first.nextCursor})).data.error.code,-32602);
  await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=(SELECT grant_id FROM oauth_token WHERE token_hash=?) AND scope='operations.read'",hash(f.client.bearer));
  assert.equal((await audit(f,op,{limit:2,cursor:first.nextCursor})).response.status,403);
 });
 test(`${dialect}: controls require all independently consented scopes and current dynamic underlying capability`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),{op}=await prepare(f);
  const company=orderDto(await f.client.call('company.preview_update',{input:{expectedRevision:orderDto(await f.client.call('company.get',{})).company.revision,changes:{availabilityText:'Synthetic private availability'}},idempotencyKey:'synthetic-company-control-test'}));
  await f.store.run("UPDATE seller_account SET role='MANAGER' WHERE id=?",f.account.id);
  assert.equal(orderDto(await get(f,op)).status,'PENDING_APPROVAL');assert.equal((await get(f,company)).response.status,403);assert.equal((await cancel(f,company)).response.status,403);
  await f.store.run("UPDATE seller_account SET role='OWNER' WHERE id=?",f.account.id);
  for(const scope of ['operations.read','orders.decide']) {
    const grant=(await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?',hash(f.client.bearer))).grant_id;
    const consent=await f.store.get('SELECT * FROM mcp_v2_scope_consent WHERE grant_id=? AND scope=?',grant,scope);
    await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope=?',grant,scope);
    assert.equal((await get(f,op)).response.status,403);
    const keys=Object.keys(consent);await f.store.run(`INSERT INTO mcp_v2_scope_consent(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>consent[k]));
  }
  await f.store.run("UPDATE seller_account SET role='STAFF' WHERE id=?",f.account.id);assert.equal((await get(f,op)).response.status,401);
  await f.store.run("UPDATE seller_account SET role='OWNER' WHERE id=?",f.account.id);
  await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=(SELECT grant_id FROM oauth_token WHERE token_hash=?)',new Date().toISOString(),hash(f.client.bearer));
  assert.equal((await get(f,op)).response.status,401);assert.equal((await cancel(f,op)).response.status,401);
 });
 test(`${dialect}: actual commit and replay audit use requested names and audit faults roll back domain once`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),first=await prepare(f);assert.equal((await f.approve(first.op)).response.status,200);
  assert.equal(orderDto(await f.commit(first.op)).replayed,false);assert.equal(orderDto(await f.commit(first.op)).replayed,true);
  const calls=await f.store.all("SELECT tool_name,outcome,operation_id,resource_id FROM mcp_audit WHERE operation_id=? AND event='CALL' ORDER BY sequence",first.op.operationId);
  assert.deepEqual(calls.map(r=>[r.tool_name,r.outcome]),[['orders.preview_decision','PENDING_APPROVAL'],['orders.commit_decision','COMMITTED'],['orders.commit_decision','REPLAY']]);
  assert.ok(calls.every(r=>r.operation_id===first.op.operationId&&r.resource_id===first.o.id));
  const run=f.store.run;f.store.run=(sql,...values)=>{if(sql.includes('INSERT INTO mcp_audit')&&values.includes('REPLAY'))throw new Error('Synthetic replay audit failure');return run(sql,...values);};
  try{assert.equal((await f.commit(first.op)).data.error.code,-32603);}finally{f.store.run=run;}
  assert.equal((await state(f,first.op)).state,'COMMITTED');assert.equal((await f.store.get('SELECT revision FROM shop_order WHERE id=?',first.o.id)).revision,2);
  const second=await prepare(f);assert.equal((await f.approve(second.op)).response.status,200);
  f.store.run=(sql,...values)=>{if(sql.includes('INSERT INTO mcp_audit')&&values.includes('COMMITTED'))throw new Error('Synthetic initial audit failure');return run(sql,...values);};
  try{assert.equal((await f.commit(second.op)).data.error.code,-32603);}finally{f.store.run=run;}
  assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',second.o.id)).status,'SUBMITTED');
  assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',second.op.operationId)).consumed_at,null);
  assert.equal((await state(f,second.op)).state,'FAILED');
 });
 test(`${dialect}: cancel consumes approved proof atomically and loses safely to commit`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),first=await prepare(f);assert.equal((await f.approve(first.op)).response.status,200);
  const run=f.store.run;f.store.run=(sql,...values)=>{if(sql.includes('INSERT INTO mcp_audit')&&values.includes('CANCELLED'))throw new Error('Synthetic cancel audit failure');return run(sql,...values);};
  try{assert.equal((await cancel(f,first.op)).data.error.code,-32603);}finally{f.store.run=run;}
  assert.equal((await state(f,first.op)).state,'APPROVED');assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',first.op.operationId)).consumed_at,null);
  const results=await Promise.all([cancel(f,first.op),f.commit(first.op)]);const final=(await state(f,first.op)).state;assert.ok(['CANCELLED','COMMITTED'].includes(final));
  assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',first.o.id)).status,final==='COMMITTED'?'CONFIRMED':'SUBMITTED');
  assert.equal(results.filter(r=>r.data.result).length,1);
  if(final==='COMMITTED')assert.equal((await cancel(f,first.op)).data.error.code,-32009);
  else assert.ok((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',first.op.operationId)).consumed_at);
  const second=await prepare(f);assert.equal((await f.approve(second.op)).response.status,200);
  const reversed=await Promise.all([f.commit(second.op),cancel(f,second.op)]),last=(await state(f,second.op)).state;
  assert.equal(reversed.filter(r=>r.data.result).length,1);assert.ok(['COMMITTED','CANCELLED'].includes(last));
  assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',second.o.id)).status,last==='COMMITTED'?'CONFIRMED':'SUBMITTED');
  if(last==='COMMITTED')assert.equal((await cancel(f,second.op)).data.error.code,-32009);
 });
 test(`${dialect}: current inventory reason is joined from authoritative ledger without copying its note`,options,async t=>{
  const f=await inventoryToolFixture(t,dialect,{scopes:inventoryScopes+' operations.read operations.cancel'}),p=await f.product();
  const op=inventoryDto(await f.preview(p,3,{reasonCode:'DAMAGE',note:'PRIVATE count note must never enter operation metadata'}));
  assert.equal((await f.approve(op)).response.status,200);inventoryDto(await f.commit(op));
  const metadata=inventoryDto(await f.client.call('operations.get',{operationId:op.operationId}));assert.equal(metadata.inventoryReason,'DAMAGE');
  assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE|count note/);
  const row=await f.store.get("SELECT id FROM inventory_movement WHERE operation_id=? AND source='MCP_ADJUST'",op.operationId);
  await f.store.run('UPDATE inventory_movement SET correlation_id=? WHERE id=?',randomUUID(),row.id);
  assert.equal((await f.client.call('operations.get',{operationId:op.operationId})).response.status,503);
 });
 test(`${dialect}: cancel uses shared expiry semantics and approval cannot revive the cancelled operation`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),first=await prepare(f),path='/api/v1/seller/mcp/operations/'+first.op.operationId;
  const review=await f.call(path,'GET',undefined,f.client.headers);assert.equal(review.response.status,200);
  const results=await Promise.all([cancel(f,first.op),f.call(path+'/approval','POST',{operationId:first.op.operationId,previewHash:first.op.previewHash,challenge:review.data.challenge,decision:'approve',password:reviewPassword},f.client.headers)]);
  assert.equal(orderDto(results[0]).status,'CANCELLED');assert.equal((await state(f,first.op)).state,'CANCELLED');
  assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',first.o.id)).status,'SUBMITTED');
  const proof=await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',first.op.operationId);assert.ok(!proof||proof.consumed_at);
  const second=await prepare(f),row=await f.store.get('SELECT expires_at FROM mcp_v2_operation WHERE id=?',second.op.operationId);
  t.mock.timers.enable({apis:['Date'],now:Date.parse(row.expires_at)+1});
  assert.equal(orderDto(await cancel(f,second.op)).status,'EXPIRED');
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_event WHERE operation_id=? AND event='EXPIRE'",second.op.operationId)).n,1);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_event WHERE operation_id=? AND event='CANCEL'",second.op.operationId)).n,0);
 });
 test(`${dialect}: redacted receipt controls stay authorized and expired original grants never regain rights`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),{op}=await prepare(f);assert.equal((await f.approve(op)).response.status,200);orderDto(await f.commit(op));
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId);
  t.mock.timers.enable({apis:['Date'],now:Date.parse(row.expires_at)+1});
  await maintainOperations(f.store,{enabled:true,tenantId:f.binding.tenantId,tenantGuard:{withActiveTenant:async(_id,work)=>work({revision:0})}});
  const dto=orderDto(await get(f,op));assert.equal(dto.proposalRedacted,true);assert.equal(dto.receiptAvailable,true);assert.equal(orderDto(await f.commit(op)).replayed,true);
  const grant=await f.store.get('SELECT absolute_expires_at FROM oauth_grant WHERE id=?',row.grant_id);
  t.mock.timers.setTime(Date.parse(grant.absolute_expires_at)+1);assert.equal((await get(f,op)).response.status,401);
  const fresh=await freshCatalogAccess(f,scopes);assert.equal((await fresh.call('operations.get',{operationId:op.operationId})).response.status,403);
  t.mock.timers.setTime(Date.parse(row.receipt_expires_at)+1);
  await maintainOperations(f.store,{enabled:true,tenantId:f.binding.tenantId,tenantGuard:{withActiveTenant:async(_id,work)=>work({revision:0})}});
  assert.equal((await get(f,op)).response.status,401);assert.equal(await f.store.get('SELECT id FROM mcp_v2_operation WHERE id=?',op.operationId),undefined);
 });
 test(`${dialect}: ninety-day audit hygiene stays tenant/row/byte bounded and rolls back`,options,async t=>{
  const f=await orderToolFixture(t,dialect,{scopes}),at='2000-01-01T00:00:00.000Z';
  await f.store.transaction(async()=>{for(let n=0;n<105;n++){const id=randomUUID();await f.store.run("INSERT INTO mcp_audit(id,at,tenant_id,correlation_id,event,outcome,duration_ms,result_count)VALUES(?,?,?,?,'READ',?,0,0)",id,at,'default',id,'X'.repeat(2000));}});
  const first=await f.store.transaction(()=>cleanupMcpAudit(f.store,{tenantId:'default'}));assert.ok(first.deleted<100&&first.deleted>0);assert.ok(first.bytes<=1048576);
  const remaining=(await f.store.get('SELECT COUNT(*) n FROM mcp_audit WHERE at=?',at)).n;
  await assert.rejects(f.store.transaction(async()=>{await cleanupMcpAudit(f.store,{tenantId:'default'});throw new Error('Synthetic cleanup rollback');}),/Synthetic cleanup rollback/);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_audit WHERE at=?',at)).n,remaining);
  const id=randomUUID();await f.store.run("INSERT INTO mcp_audit(id,at,tenant_id,correlation_id,event,outcome,duration_ms,result_count)VALUES(?,?,?,?,'READ','foreign',0,0)",id,at,'other',id);
  for(let n=0;n<4;n++)await f.store.transaction(()=>cleanupMcpAudit(f.store,{tenantId:'default'}));assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_audit WHERE at=? AND tenant_id=?',at,'default')).n,0);assert.ok(await f.store.get('SELECT id FROM mcp_audit WHERE id=?',id));
 });
}
