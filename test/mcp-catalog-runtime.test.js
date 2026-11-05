import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogRuntimeFixture} from './helpers/mcp-catalog-runtime-fixture.js';
import {updateProduct,getProduct,setProductThumbnail} from '../src/products.js';
import {syntheticMediaPng} from './helpers/mcp-media-hooks-fixture.js';
import {rowsDigest} from '../src/sqlite-import.js';
import {reviewPassword} from './helpers/mcp-review-fixture.js';
const dto=value=>value.data.result?.structuredContent;
async function commerce(store){const result={};for(const table of ['product','listing','product_gallery_image','product_option','product_event','inventory_state','inventory_movement']){
 const order=table==='product_option'?'product_id,option_type_id':table==='inventory_state'?'product_id':'id';result[table]=rowsDigest(await store.all('SELECT * FROM '+table+' ORDER BY '+order));}return result;}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
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
 test(`${dialect}: an actual Seller write during SYNTHETIC decode completes outside locks and prevents prepare persistence`,options,async t=>{
  let target,changed=false;const f=await catalogRuntimeFixture(t,dialect,{beforeDecode:async({f})=>{if(!changed){changed=true;await updateProduct(f.store,target.id,{name:'Intervening Seller literal'});}}});
  target=await f.product();const value=await f.client.call('catalog.preview_update',{input:{id:target.id,changes:{priceMinor:1500}},idempotencyKey:'decode-race-runtime'});
  assert.equal(value.response.status,200);assert.equal(value.data.error.code,-32009,JSON.stringify(value.data));
  assert.equal((await getProduct(f.store,target.id,true)).name,'Intervening Seller literal');assert.equal((await getProduct(f.store,target.id,true)).priceMinor,1200);
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
