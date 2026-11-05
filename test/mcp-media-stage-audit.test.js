import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
const parts=Array.from({length:Math.ceil(png.length/3072)},(_,n)=>png.subarray(n*3072,(n+1)*3072).toString('base64'));
const call=(f,input)=>f.tool('media.prepare_upload',{input});
const dto=value=>{assert.equal(value.response.status,200,JSON.stringify(value.data));assert.ok(value.data.result,JSON.stringify(value.data));return value.data.result.structuredContent.stage;};
// Real RPC/authority/storage with explicitly seeded consent and synthetic codec;
// these stage actions invoke neither native decode nor image approval.
for(const dialect of ['sqlite','postgres']) {
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: each real RPC stage action and replay audits fixed metadata without manufacturing an operation history`,options,async t=>{
  const f=await mediaToolsFixture(t,dialect),input={action:'begin',...await f.input()},stage=dto(await call(f,input));dto(await call(f,input));
  const append={action:'append',stageId:stage.stageId,offset:0,dataParts:parts};dto(await call(f,append));dto(await call(f,append));
  const discard={action:'discard',stageId:stage.stageId};dto(await call(f,discard));dto(await call(f,discard));
  const rows=await f.store.all("SELECT * FROM mcp_audit WHERE tool_name='media.prepare_upload' ORDER BY sequence");
  assert.deepEqual(rows.map(r=>r.outcome),['STAGE_BEGIN','STAGE_BEGIN_REPLAY','STAGE_APPEND','STAGE_APPEND_REPLAY','STAGE_DISCARD','STAGE_DISCARD_REPLAY']);
  assert.ok(rows.every(r=>r.event==='CALL'&&r.operation_id===null&&r.resource_id===f.product.id&&r.correlation_id===stage.correlationId&&
    r.tenant_id===f.binding.tenantId&&r.account_id===f.account.id&&r.client_id===f.clientId&&r.grant_id===f.grantId));
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_operation')).n,0);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_event WHERE tool_name='media.prepare_upload' AND event IN ('BEGIN','APPEND','CANCEL')")).n,3);
  assert.equal(JSON.stringify(rows).includes(png.toString('base64')),false);assert.doesNotMatch(JSON.stringify(rows),/sourceSha256|dataParts|idempotencyKey|codecDigest/);
  const before=rows.length;await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",f.grantId);
  assert.equal((await call(f,discard)).response.status,403);assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_audit WHERE tool_name='media.prepare_upload'")).n,before);
 });
 test(`${dialect}: typed stage audit failures roll back stage chunks quota and logical proof while attempt reservations remain charged`,options,async t=>{
  const f=await mediaToolsFixture(t,dialect),begin={action:'begin',...await f.input()},run=f.store.run;
  const fault=async(outcome,input)=>{
    f.store.run=(sql,...args)=>{if(sql.includes('INSERT INTO mcp_audit')&&args.includes(outcome))throw new Error('Synthetic typed stage audit failure');return run(sql,...args);};
    try{assert.equal((await call(f,input)).data.error.code,-32603);}finally{f.store.run=run;}
  };
  await fault('STAGE_BEGIN',begin);assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_stage')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_quota')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_event')).n,0);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-stage'")).n,1);
  const stage=dto(await call(f,begin)),append={action:'append',stageId:stage.stageId,offset:0,dataParts:parts};
  await fault('STAGE_APPEND',append);assert.equal((await f.store.get('SELECT next_offset FROM mcp_v2_media_stage WHERE id=?',stage.stageId)).next_offset,0);assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_chunk')).n,0);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_event WHERE event='APPEND'")).n,0);assert.equal((await f.store.get("SELECT COUNT(*) n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-append'")).n,1);
  dto(await call(f,append));const before=await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId);await fault('STAGE_APPEND_REPLAY',append);
  assert.deepEqual(await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId),before);
  const discard={action:'discard',stageId:stage.stageId};await fault('STAGE_DISCARD',discard);assert.equal((await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?',stage.stageId)).state,'UPLOADING');
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_event WHERE event='CANCEL'")).n,0);dto(await call(f,discard));
  await fault('STAGE_DISCARD_REPLAY',discard);assert.equal((await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?',stage.stageId)).state,'CANCELLED');
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_audit WHERE tool_name='media.prepare_upload'")).n,3);
 });
}
