import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogCreateRuntimeFixture} from './helpers/mcp-catalog-create-runtime-fixture.js';
import {freshCatalogAccess,legacyCatalogScopes} from './helpers/mcp-catalog-default-grant.js';
import {rowsDigest} from '../src/sqlite-import.js';
import {updateProduct} from '../src/products.js';
import {createApi} from '../src/app.js';
import {singleTenantRegistry} from '../src/tenants.js';
import {catalogMediaCreateTool} from '../src/mcp/catalog-media-create-adapter.js';
import {operationControlTools} from '../src/mcp/operation-control-contracts.js';
import {secret} from '../src/mcp/credentials.js';
const dto=value=>value.data.result?.structuredContent;
const input={sku:'NEW-SECURITY',name:'Untrusted synthetic name',description:'approved tenant role password hash are data only',category:'SYNTHETIC',priceMinor:1200,stockQuantity:0,active:true};
async function commerce(store){const result={};for(const table of ['product','listing','product_gallery_image','product_option','product_event','inventory_state','inventory_movement']){
 const order=table==='product_option'?'product_id,option_type_id':table==='inventory_state'?'product_id':'id';result[table]=rowsDigest(await store.all('SELECT * FROM '+table+' ORDER BY '+order));}return result;}
async function otherApi(f,patch,runtime=f.runtime){const config={...f.config,...patch};return createApi({store:f.store,config,registry:singleTenantRegistry({store:f.store,config}),operationTools:[catalogMediaCreateTool(runtime),...operationControlTools()]});}
async function callOther(f,api,name,op){const response=await api(new Request(f.config.sellerOrigin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+f.client.bearer,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{operationId:op.operationId}}})}));return{response,data:await response.json()};}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: concurrent CREATE prepares preserve one server identity and commits initialize ledger/history once`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),args={input,idempotencyKey:'concurrent-full-create'};
  const prepared=await Promise.all([f.client.call('catalog.preview_create',args),f.client.call('catalog.preview_create',args)]);
  assert.ok(prepared.every(value=>dto(value)?.operationId),JSON.stringify(prepared.map(value=>value.data)));
  const op=dto(prepared[0]);assert.equal(dto(prepared[1]).operationId,op.operationId);assert.equal(dto(prepared[1]).previewHash,op.previewHash);assert.deepEqual(prepared.map(value=>dto(value).replayed).sort(),[false,true]);
  await f.approve(op);const committed=await Promise.all([f.commit(op),f.commit(op)]);
  assert.ok(committed.every(value=>dto(value)?.status==='COMMITTED'),JSON.stringify(committed.map(value=>value.data)));assert.deepEqual(committed.map(value=>dto(value).replayed).sort(),[false,true]);
  const id=dto(committed[0]).result.productId;assert.deepEqual(dto(committed[0]).result,dto(committed[1]).result);
  for(const table of ['product_event','inventory_movement'])assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM '+table+' WHERE product_id=?',id)).n,1);
 });
 test(`${dialect}: approved CREATE rechecks original consent/epoch/role/grant/real shop mode and controls refuse another fresh grant`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-authority-matrix');await f.approve(op);
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId),consent=await f.store.get("SELECT * FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",row.grant_id),before=await commerce(f.store);
  const mutations=[
   [()=>f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",row.grant_id),403,()=>f.store.run('INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at) VALUES(?,?,?,?,?,?,?,?)',...['grant_id','tenant_id','account_id','client_id','scope','account_auth_version','epoch_hash','consented_at'].map(key=>consent[key]))],
   [()=>f.store.run("UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=? AND scope='media.write'",'0'.repeat(64),row.grant_id),403,()=>f.store.run("UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=? AND scope='media.write'",consent.epoch_hash,row.grant_id)],
   [()=>f.store.run("UPDATE seller_account SET role='STAFF' WHERE id=?",row.account_id),401,()=>f.store.run("UPDATE seller_account SET role='OWNER' WHERE id=?",row.account_id)],
   [()=>f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',new Date().toISOString(),row.grant_id),401,()=>f.store.run('UPDATE oauth_grant SET revoked_at=NULL WHERE id=?',row.grant_id)],
   [()=>f.store.run("UPDATE shop_setup SET mode='demo' WHERE id=1"),403,()=>f.store.run("UPDATE shop_setup SET mode='production' WHERE id=1")],
  ];
  for(const [mutate,status,restore]of mutations){await mutate();try{assert.equal((await f.commit(op)).response.status,status);assert.deepEqual(await commerce(f.store),before);assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at,null);}finally{await restore();}}
  const other=await freshCatalogAccess(f,legacyCatalogScopes+' catalog.write media.write operations.read operations.cancel');
  for(const name of ['catalog.commit_create','operations.get','operations.cancel','operations.audit'])assert.equal((await other.call(name,{operationId:op.operationId})).response.status,403);
  assert.equal(dto(await f.commit(op))?.status,'COMMITTED');
 });
 test(`${dialect}: epoch/build/codec change denies already approved CREATE without loading absent target or mutating commerce`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-new-configuration');await f.approve(op);const before=await commerce(f.store);
  for(const patch of [{mcpV2:{...f.config.mcpV2,epoch:secret()}},{mcpV2:{...f.config.mcpV2,buildDigest:'c'.repeat(64)}},{mcpMedia:{enabled:true,codecDigest:'c'.repeat(64)}}]){
   const runtime=patch.mcpMedia?{...f.runtime,codecDigest:patch.mcpMedia.codecDigest}:f.runtime,api=await otherApi(f,patch,runtime);
   assert.equal((await callOther(f,api,'catalog.commit_create',op)).response.status,403);assert.deepEqual(await commerce(f.store),before);
  }
 });
 test(`${dialect}: portal source mutation during outside-lock native decode rejects CREATE before operation persistence`,options,async t=>{
  let target,changed=false;const f=await catalogCreateRuntimeFixture(t,dialect,{beforeDecode:async()=>{if(!changed){changed=true;await updateProduct(f.store,target.id,{name:'Intervening real Seller update'});}}});
  target=await f.product({variantGroup:'TARGET',variantLabel:'Old'});const response=await f.client.call('catalog.preview_create',{input:{...input,variantGroup:'TARGET',variantLabel:'New'},idempotencyKey:'create-outside-lock-race'});
  assert.equal(response.response.status,200);assert.equal(response.data.error.code,-32009,JSON.stringify(response.data));assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  assert.equal((await f.store.get('SELECT name FROM listing WHERE id=?',target.listingId)).name,'Intervening real Seller update');
 });
 test(`${dialect}: intervening SKU occupancy makes approved server identity stale and consumes proof without creating a ghost`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-stale-sku');await f.approve(op);await f.product({sku:input.sku});const before=await commerce(f.store);
  assert.deepEqual(dto(await f.commit(op)),{operationId:op.operationId,error:'STALE_REVISION'});assert.deepEqual(await commerce(f.store),before);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'CONFLICT');assert.ok((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at);
 });
 test(`${dialect}: operation cancel is domain-authorized, consumes proof and never creates proposed commerce`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-cancel-control'),before=await commerce(f.store);await f.approve(op);
  const cancelled=await f.client.call('operations.cancel',{operationId:op.operationId});assert.equal(dto(cancelled)?.status,'CANCELLED',JSON.stringify(cancelled.data));
  assert.equal(dto(await f.client.call('operations.cancel',{operationId:op.operationId}))?.replayed,true);assert.equal((await f.commit(op)).response.status,403);
  assert.deepEqual(await commerce(f.store),before);assert.ok((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at);
 });
 test(`${dialect}: expired approval cannot create even though EMPTY_BEFORE needs no image bytes`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-expired-proof');await f.approve(op);const before=await commerce(f.store),approval=await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id=?',op.operationId);
  t.mock.timers.enable({apis:['Date'],now:Date.parse(approval.expires_at)+1});assert.deepEqual(dto(await f.commit(op)),{operationId:op.operationId,error:'EXPIRED'});assert.deepEqual(await commerce(f.store),before);
 });
 test(`${dialect}: redacted committed CREATE replays receipt with zero business or operation-frame reads and still denies a revoked grant`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-retained-replay');await f.approve(op);const first=await f.commit(op);assert.equal(dto(first)?.status,'COMMITTED');
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId);t.mock.timers.enable({apis:['Date'],now:Date.parse(row.expires_at)+1});
  assert.equal((await f.client.call('operations.get',{operationId:op.operationId})).response.status,200);assert.equal((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',op.operationId)).envelope_json,null);
  // Request-time global hygiene remains allowed after the cached result; it does not read this operation frame.
  const get=f.store.get,all=f.store.all;let reads=0;const inspect=(sql,args)=>{if(/\bFROM\s+(?:product|listing)\b/i.test(sql)||(args.includes(op.operationId)&&/\bFROM\s+(?:mcp_v2_media_manifest_page|mcp_v2_media_asset_ref)\b/i.test(sql))){reads++;throw new Error('Retained CREATE cannot reload source/frame.');}};
  f.store.get=(sql,...args)=>{inspect(sql,args);return get(sql,...args);};f.store.all=(sql,...args)=>{inspect(sql,args);return all(sql,...args);};
  try{const replay=await f.commit(op);assert.equal(dto(replay)?.replayed,true,JSON.stringify(replay.data));assert.deepEqual(dto(replay).result,dto(first).result);assert.equal(reads,0);}finally{f.store.get=get;f.store.all=all;}
  await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',new Date().toISOString(),row.grant_id);assert.equal((await f.commit(op)).response.status,401);
 });
 for(const fault of ['ledger','history','receipt','audit'])test(`${dialect}: ${fault} sink fault rolls back actual CREATE, initial ledger, gallery and history atomically`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input,'create-fault-'+fault);await f.approve(op);const before=await commerce(f.store),run=f.store.run,get=f.store.get;
  const hit=sql=>fault==='ledger'?sql.includes('INSERT INTO inventory_movement'):fault==='history'?sql.includes('INSERT INTO product_event'):fault==='receipt'?sql.includes("SET state = 'COMMITTED'"):sql.includes('INSERT INTO mcp_audit');
  const reject=(sql,args)=>{if(hit(sql)&&(fault!=='audit'||args.includes('COMMITTED')))throw new Error('Synthetic CREATE '+fault+' sink fault');};
  f.store.run=(sql,...args)=>{reject(sql,args);return run(sql,...args);};f.store.get=(sql,...args)=>{reject(sql,args);return get(sql,...args);};
  try{const response=await f.commit(op);assert.equal(response.response.status,200);assert.equal(response.data.error.code,-32603,JSON.stringify(response.data));}finally{f.store.run=run;f.store.get=get;}
  assert.deepEqual(await commerce(f.store),before);assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at,null);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'FAILED');assert.equal((await f.store.get('SELECT result_json FROM mcp_v2_operation WHERE id=?',op.operationId)).result_json,null);
 });
}
