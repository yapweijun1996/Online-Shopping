import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogRuntimeFixture} from './helpers/mcp-catalog-runtime-fixture.js';
import {updateProduct,getProduct,setProductThumbnail} from '../src/products.js';
import {syntheticMediaPng} from './helpers/mcp-media-hooks-fixture.js';
import {rowsDigest} from '../src/sqlite-import.js';
import {reviewPassword} from './helpers/mcp-review-fixture.js';
import {freshCatalogAccess,legacyCatalogScopes} from './helpers/mcp-catalog-default-grant.js';
import {canonicalOperationJson,operationPreviewHash} from '../src/mcp/operation-envelope.js';
import {ApiError} from '../src/http.js';
import {createApi} from '../src/app.js';
import {catalogue} from '../src/mcp/tools.js';
const dto=value=>value.data.result?.structuredContent;
async function commerce(store){const result={};for(const table of ['product','listing','product_gallery_image','product_option','product_event','inventory_state','inventory_movement']){
 const order=table==='product_option'?'product_id,option_type_id':table==='inventory_state'?'product_id':'id';result[table]=rowsDigest(await store.all('SELECT * FROM '+table+' ORDER BY '+order));}return result;}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: explicit empty C registrations preserve v1 while a missing default worker cannot fall back to safe UPDATE`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),empty=await createApi({store:f.store,config:f.config,operationTools:[]});
  const request=()=>new Request(f.binding.resource,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.client.bearer,
   accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  const listed=await empty(request(),{clientAddress:'synthetic-empty-c-runtime'});assert.equal(listed.status,200);
  assert.deepEqual((await listed.json()).result.tools,catalogue.map(({scope:_scope,...tool})=>tool));
  await assert.rejects(createApi({store:f.store,config:f.config,operationTools:null}),TypeError);
  // This fixture has no codec socket/token paths. The actual default factory
  // must fail construction instead of advertising a legacy MEDIUM fallback.
  const missing=await createApi({store:f.store,config:f.config}),response=await missing(request(),{clientAddress:'synthetic-missing-c-worker'});
  assert.equal(response.status,500);assert.equal((await response.json()).error.code,'INTERNAL_ERROR');
  assert.equal(f.decodes(),0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: actual RPC and password/ACK handlers apply C once; decoder is SYNTHETIC and outside the real tenant guard`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),a=await f.product({variantGroup:'SOURCE',variantLabel:'A'}),b=await f.product({variantGroup:'TARGET',variantLabel:'B'}),
   op=await f.prepare(a.id,{variantGroup:'TARGET',variantLabel:'Moved'},'runtime-exact-once');
  assert.equal((await f.store.get('SELECT risk FROM mcp_v2_operation WHERE id=?',op.operationId)).risk,'HIGH');assert.ok(f.decodes()>0);
  assert.equal((await f.prepare(a.id,{variantGroup:'TARGET',variantLabel:'Moved'},'runtime-exact-once')).operationId,op.operationId);
  const different=await f.client.call('catalog.preview_update',{input:{id:a.id,changes:{name:'Other'}},idempotencyKey:'runtime-exact-once'});
  assert.equal(different.response.status,200);assert.equal(different.data.error.code,-32009);
  await f.approve(op);const committed=await f.commit(op);assert.equal(dto(committed)?.status,'COMMITTED',JSON.stringify(committed.data));assert.equal(dto(committed).replayed,false);
  const after=await commerce(f.store),replayed=await f.commit(op);assert.equal(dto(replayed).replayed,true);assert.deepEqual(dto(replayed).result,dto(committed).result);assert.deepEqual(await commerce(f.store),after);
  assert.equal((await getProduct(f.store,a.id,true)).listingId,b.listingId);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',a.listingId),undefined);
  assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',a.id)).stock_quantity,7);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_quota')).n,0);
 });
 test(`${dialect}: concurrent real prepares share one immutable planned UUID and concurrent commits apply only once`,options,async t=>{
  let arrived=0,release;const ready=new Promise(resolve=>{release=resolve;});
  const f=await catalogRuntimeFixture(t,dialect,{beforeDecode:async()=>{if(++arrived===2)release();let timer;
   try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Parallel prepare held a database lock during decode.')),1500);})]);}finally{clearTimeout(timer);}
  }}),p=await f.product(),input={id:p.id,changes:{variantGroup:'NEW-GROUP',variantLabel:'A'}},key='concurrent-c-runtime';
  let values;try{values=await Promise.all([f.client.call('catalog.preview_update',{input,idempotencyKey:key}),f.client.call('catalog.preview_update',{input,idempotencyKey:key})]);}finally{release();}
  assert.ok(values.every(value=>value.response.status===200&&dto(value)?.operationId),JSON.stringify(values.map(value=>value.data)));
  assert.equal(dto(values[0]).operationId,dto(values[1]).operationId);assert.equal(dto(values[0]).previewHash,dto(values[1]).previewHash);
  assert.deepEqual(values.map(value=>dto(value).replayed).sort(),[false,true]);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,1);
  const op=dto(values[0]);await f.approve(op);const committed=await Promise.all([f.commit(op),f.commit(op)]);
  assert.ok(committed.every(value=>dto(value)?.status==='COMMITTED'),JSON.stringify(committed.map(value=>value.data)));
  assert.deepEqual(committed.map(value=>dto(value).replayed).sort(),[false,true]);assert.deepEqual(dto(committed[0]).result,dto(committed[1]).result);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?',p.id)).n,1);
 });
 test(`${dialect}: forged authority/stage/stock/UUID fields and a missing target have exact controlled RPC errors`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),before=await commerce(f.store);
  for(const input of [{id:p.id,changes:{stockQuantity:1}},{id:p.id,changes:{imageDataUrl:'data:image/png;base64,AAAA'}},
   {id:p.id,changes:{gallery:[]}},{id:p.id,changes:{newListingId:randomUUID()}},{id:p.id,changes:{name:'X'},plannedIdentity:{newListingId:randomUUID()}},
   {id:p.id,changes:{name:'X'},catalogUpdateEnabled:true}]){
   const value=await f.client.call('catalog.preview_update',{input,idempotencyKey:'forged-runtime-input'});assert.equal(value.response.status,200);assert.equal(value.data.error.code,-32602);
  }
  const missing=await f.client.call('catalog.preview_update',{input:{id:randomUUID(),changes:{name:'X'}},idempotencyKey:'missing-runtime-input'});
  assert.equal(missing.response.status,200);assert.equal(missing.data.error.code,-32602);assert.equal(f.decodes(),0);
  assert.deepEqual(await commerce(f.store),before);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: a fully approved semantic no-op retains portal history and stock semantics`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),before=await getProduct(f.store,p.id,true),
   movements=await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),op=await f.prepare(p.id,{name:before.name});await f.approve(op);
  assert.equal(dto(await f.commit(op))?.status,'COMMITTED');const after=await getProduct(f.store,p.id,true);
  for(const key of ['sku','name','description','categoryCode','priceMinor','currency','active','stockQuantity','variantGroup','variantLabel','options','galleryItems'])assert.deepEqual(after[key],before[key]);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);assert.deepEqual(await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),movements);
 });
 test(`${dialect}: an actual Seller write during SYNTHETIC decode completes outside locks and prevents prepare persistence`,options,async t=>{
  let target,changed=false;const f=await catalogRuntimeFixture(t,dialect,{beforeDecode:async({f})=>{if(!changed){changed=true;await updateProduct(f.store,target.id,{name:'Intervening Seller literal'});}}});
  target=await f.product();const value=await f.client.call('catalog.preview_update',{input:{id:target.id,changes:{priceMinor:1500}},idempotencyKey:'decode-race-runtime'});
  assert.equal(value.response.status,200);assert.equal(value.data.error.code,-32009,JSON.stringify(value.data));
  assert.equal((await getProduct(f.store,target.id,true)).name,'Intervening Seller literal');assert.equal((await getProduct(f.store,target.id,true)).priceMinor,1200);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: SYNTHETIC native unavailability is controlled503 and never persists C authority`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect,{beforeDecode:async()=>{throw new ApiError(503,'MEDIA_CODEC_UNAVAILABLE','Synthetic unavailable decoder.');}}),p=await f.product(),before=await commerce(f.store);
  const response=await f.client.call('catalog.preview_update',{input:{id:p.id,changes:{name:'Unapplied literal'}},idempotencyKey:'unavailable-c-decoder'});
  assert.equal(response.response.status,503);assert.equal(response.data.error,'temporarily_unavailable');assert.deepEqual(await commerce(f.store),before);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);
 });
 test(`${dialect}: consent withdrawn during outside-lock decode denies the final prepare fence`,options,async t=>{
  let withdrawn=false;const f=await catalogRuntimeFixture(t,dialect,{beforeDecode:async({f})=>{if(!withdrawn){withdrawn=true;await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE scope='media.write'");}}}),p=await f.product(),before=await commerce(f.store);
  const response=await f.client.call('catalog.preview_update',{input:{id:p.id,changes:{name:'Unapplied literal'}},idempotencyKey:'withdrawn-c-decoder'});
  assert.equal(response.response.status,403);assert.deepEqual(await commerce(f.store),before);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: complete C metadata over48KiB fails controlled503 before native or operation rows`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect);let first;
  for(let n=0;n<12;n++){const p=await f.product({variantGroup:'LARGE',variantLabel:'V'+n,name:'N'.repeat(120),description:'X'.repeat(2000)});first??=p;}
  const before=await commerce(f.store),response=await f.client.call('catalog.preview_update',{input:{id:first.id,changes:{description:'Y'.repeat(2000)}},idempotencyKey:'oversize-c-public-proposal'});
  assert.equal(response.response.status,503);assert.equal(response.data.error,'temporarily_unavailable');assert.equal(f.decodes(),0);assert.deepEqual(await commerce(f.store),before);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: thumbnail mutation without product timestamp invalidates review before human approval`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'}),
   timestamp=(await f.store.get('SELECT updated_at FROM product WHERE id=?',p.id)).updated_at;
  await setProductThumbnail(f.store,p.id,'data:image/png;base64,'+syntheticMediaPng(91).toString('base64'));
  assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id=?',p.id)).updated_at,timestamp);
  assert.equal((await f.call(f.path(op),'GET',undefined,f.headers)).response.status,403);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
 test(`${dialect}: actual approval followed by Seller edit consumes stale proof without a C business write`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'});await f.approve(op);
  await updateProduct(f.store,p.id,{priceMinor:1800});const before=await commerce(f.store),value=await f.commit(op);
  assert.deepEqual(dto(value),{operationId:op.operationId,error:'STALE_REVISION'});assert.deepEqual(await commerce(f.store),before);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'CONFLICT');
  assert.ok((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at);
 });
 test(`${dialect}: pages/assets and the bound seller session are mandatory for the real password decision`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'}),value=await f.review(op),
   input={operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,decision:'approve',password:reviewPassword,mediaReviewed:true};
  assert.equal((await f.post(op,'/approval',input)).status,403);await f.acknowledge(op,value);
  const login=await f.call('/api/v1/seller/session','POST',{username:'synthetic_owner',password:reviewPassword},{origin:f.config.sellerOrigin});assert.equal(login.response.status,200);
  assert.equal((await f.call(f.path(op)+'/approval','POST',input,{origin:f.config.sellerOrigin,cookie:login.response.headers.get('set-cookie').split(';')[0],
   'x-csrf-token':login.data.csrfToken})).response.status,403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
 test(`${dialect}: C human decision rechecks current consent/role/grant/mode and first-party Origin/CSRF`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'}),value=await f.review(op);await f.acknowledge(op,value);
  const input={operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,decision:'approve',password:reviewPassword,mediaReviewed:true},
   row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId),consent=await f.store.get("SELECT * FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",row.grant_id);
  const noOrigin={...f.headers};delete noOrigin.origin;
  for(const headers of [noOrigin,{...f.headers,origin:'https://ai.example.test'},{...f.headers,'x-csrf-token':'invalid-csrf'}]){
   const response=await f.call(f.path(op)+'/approval','POST',input,headers);assert.equal(response.response.status,403);assert.equal(response.response.headers.get('access-control-allow-origin'),null);
  }
  const mutations=[
   [()=>f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",row.grant_id),
    ()=>f.store.run('INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at) VALUES(?,?,?,?,?,?,?,?)',...['grant_id','tenant_id','account_id','client_id','scope','account_auth_version','epoch_hash','consented_at'].map(key=>consent[key]))],
   [()=>f.store.run("UPDATE seller_account SET role='STAFF' WHERE id=?",row.account_id),()=>f.store.run("UPDATE seller_account SET role='OWNER' WHERE id=?",row.account_id)],
   [()=>f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',new Date().toISOString(),row.grant_id),()=>f.store.run('UPDATE oauth_grant SET revoked_at=NULL WHERE id=?',row.grant_id)],
   [()=>f.store.run("UPDATE shop_setup SET mode='demo' WHERE id=1"),()=>f.store.run("UPDATE shop_setup SET mode='production' WHERE id=1")],
  ];
  for(const [mutate,restore] of mutations){await mutate();try{assert.equal((await f.post(op,'/approval',input)).status,403);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);}finally{await restore();}}
  // Four reservations above plus this valid fifth attempt preserve the actual
  // account/address budget. No limiter is relaxed or replaced for the test.
  assert.equal((await f.post(op,'/approval',input)).status,200);
 });
 test(`${dialect}: exact C image hash and one-use nonce are bound to the current challenge`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'}),value=await f.review(op),item=value.mediaReview.items[0],
   args={operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,kind:item.kind,itemKey:item.itemKey},delivery=await f.post(op,'/media/delivery',args);
  assert.equal(delivery.status,200);const nonce=delivery.headers.get('x-media-nonce');
  assert.equal((await f.post(op,'/media/ack',{...args,expectedHash:'0'.repeat(64),nonce})).status,403);
  assert.equal((await f.post(op,'/media/ack',{...args,expectedHash:item.hash,nonce:'A'.repeat(43)})).status,403);
  assert.equal((await f.post(op,'/media/ack',{...args,expectedHash:item.hash,nonce})).status,200);
  assert.equal((await f.post(op,'/media/ack',{...args,expectedHash:item.hash,nonce})).status,403);
  const changed=await f.review(op);assert.notEqual(changed.challenge,value.challenge);
  assert.equal((await f.post(op,'/approval',{operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,
   decision:'approve',password:reviewPassword,mediaReviewed:true})).status,403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
 test(`${dialect}: corrupt canonical pages fail controlled503 and expired challenges cannot approve C`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'}),before=await commerce(f.store),
   page=await f.store.get('SELECT * FROM mcp_v2_media_manifest_page WHERE operation_id=? AND page_index=0',op.operationId);
  await f.store.run('UPDATE mcp_v2_media_manifest_page SET page_json=? WHERE operation_id=? AND page_index=0',page.page_json+' ',op.operationId);
  assert.equal((await f.call(f.path(op),'GET',undefined,f.headers)).response.status,503);
  await f.store.run('UPDATE mcp_v2_media_manifest_page SET page_json=? WHERE operation_id=? AND page_index=0',page.page_json,op.operationId);
  const value=await f.review(op),challenge=await f.store.get('SELECT expires_at FROM mcp_v2_approval_challenge WHERE operation_id=?',op.operationId);
  await f.acknowledge(op,value);t.mock.timers.enable({apis:['Date'],now:Date.parse(challenge.expires_at)+1});
  assert.equal((await f.post(op,'/approval',{operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,
   decision:'approve',password:reviewPassword,mediaReviewed:true})).status,403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);assert.deepEqual(await commerce(f.store),before);
 });
 test(`${dialect}: current consent, epoch, role, original grant and real shop mode cannot be bypassed after C approval`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'});await f.approve(op);
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId),consent=await f.store.get("SELECT * FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",row.grant_id),before=await commerce(f.store);
  const mutations=[
   {apply:()=>f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",row.grant_id),status:403,
    restore:()=>f.store.run('INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at) VALUES(?,?,?,?,?,?,?,?)',...['grant_id','tenant_id','account_id','client_id','scope','account_auth_version','epoch_hash','consented_at'].map(key=>consent[key]))},
   {apply:()=>f.store.run("UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=? AND scope='media.write'",'0'.repeat(64),row.grant_id),status:403,
    restore:()=>f.store.run("UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=? AND scope='media.write'",consent.epoch_hash,row.grant_id)},
   {apply:()=>f.store.run("UPDATE seller_account SET role='STAFF' WHERE id=?",row.account_id),status:401,restore:()=>f.store.run("UPDATE seller_account SET role='OWNER' WHERE id=?",row.account_id)},
   {apply:()=>f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',new Date().toISOString(),row.grant_id),status:401,restore:()=>f.store.run('UPDATE oauth_grant SET revoked_at=NULL WHERE id=?',row.grant_id)},
   {apply:()=>f.store.run("UPDATE shop_setup SET mode='demo' WHERE id=1"),status:403,restore:()=>f.store.run("UPDATE shop_setup SET mode='production' WHERE id=1")},
  ];
  for(const mutation of mutations){await mutation.apply();try{assert.equal((await f.commit(op)).response.status,mutation.status);
   assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at,null);assert.deepEqual(await commerce(f.store),before);
  }finally{await mutation.restore();}}
  assert.equal(dto(await f.commit(op))?.status,'COMMITTED');
 });
 test(`${dialect}: another fully consented original account grant and a foreign retained tenant binding cannot use C commerce or controls`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'});await f.approve(op);
  const before=await commerce(f.store),other=await freshCatalogAccess(f,legacyCatalogScopes+' catalog.write media.write operations.read operations.cancel');
  for(const name of ['catalog.commit_update','operations.get','operations.cancel','operations.audit'])assert.equal((await other.call(name,{operationId:op.operationId})).response.status,403);
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId),envelope=JSON.parse(row.envelope_json),foreign={...envelope,tenantId:randomUUID()};
  await f.store.run('UPDATE mcp_v2_operation SET tenant_id=?,envelope_json=?,preview_hash=? WHERE id=?',foreign.tenantId,canonicalOperationJson(foreign),operationPreviewHash(foreign),op.operationId);
  try{assert.equal((await f.commit(op)).response.status,403);assert.equal((await f.client.call('operations.get',{operationId:op.operationId})).response.status,403);}
  finally{await f.store.run('UPDATE mcp_v2_operation SET tenant_id=?,envelope_json=?,preview_hash=? WHERE id=?',row.tenant_id,row.envelope_json,row.preview_hash,op.operationId);}
  assert.deepEqual(await commerce(f.store),before);assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at,null);
 });
 test(`${dialect}: expired real C approval retires proof without applying catalog metadata`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),p=await f.product(),op=await f.prepare(p.id,{name:'Proposed literal'});await f.approve(op);
  const approval=await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id=?',op.operationId),before=await commerce(f.store);
  t.mock.timers.enable({apis:['Date'],now:Date.parse(approval.expires_at)+1});const response=await f.commit(op);
  assert.deepEqual(dto(response),{operationId:op.operationId,error:'EXPIRED'});assert.deepEqual(await commerce(f.store),before);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'EXPIRED');
 });
 test(`${dialect}: late typed commit audit failure rolls back actual listing/image/history/stock changes`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),a=await f.product({variantGroup:'SOURCE',variantLabel:'A'});await f.product({variantGroup:'TARGET',variantLabel:'B'});
  const op=await f.prepare(a.id,{variantGroup:'TARGET',variantLabel:'Moved'});await f.approve(op);const before=await commerce(f.store),run=f.store.run;
  f.store.run=(sql,...values)=>{if(sql.includes('INSERT INTO mcp_audit')&&values.includes('COMMITTED'))throw new Error('Synthetic C final audit fault');return run(sql,...values);};
  try{const response=await f.commit(op);assert.equal(response.data.error.code,-32603);}finally{f.store.run=run;}
  assert.deepEqual(await commerce(f.store),before);assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).consumed_at,null);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'FAILED');
 });
 test(`${dialect}: actual request-time cleanup redacts C proof and retained receipt replay avoids business-source reads`,options,async t=>{
  const f=await catalogRuntimeFixture(t,dialect),a=await f.product({variantGroup:'SOURCE',variantLabel:'A'});await f.product({variantGroup:'TARGET',variantLabel:'B'});
  const op=await f.prepare(a.id,{variantGroup:'TARGET',variantLabel:'Moved'});await f.approve(op);const first=await f.commit(op);
  assert.equal(dto(first)?.status,'COMMITTED',JSON.stringify(first.data));assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',a.listingId),undefined);
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId);t.mock.timers.enable({apis:['Date'],now:Date.parse(row.expires_at)+1});
  const metadata=await f.client.call('operations.get',{operationId:op.operationId});assert.equal(metadata.response.status,200);
  const scrubbed=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId);assert.equal(scrubbed.envelope_json,null);assert.ok(scrubbed.redacted_at);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_manifest_page WHERE operation_id=?',op.operationId)).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',op.operationId)).n,0);
  const get=f.store.get,all=f.store.all;let reads=0;
  const source=sql=>{if(/\bFROM\s+(?:product|listing)\b/i.test(sql)){reads++;throw new Error('Retained receipt must not reload commerce.');}};
  f.store.get=(sql,...args)=>{source(sql);return get(sql,...args);};f.store.all=(sql,...args)=>{source(sql);return all(sql,...args);};
  try{const replay=await f.commit(op);assert.equal(dto(replay)?.replayed,true,JSON.stringify(replay.data));assert.deepEqual(dto(replay).result,dto(first).result);assert.equal(reads,0);}
  finally{f.store.get=get;f.store.all=all;}
 });
}
