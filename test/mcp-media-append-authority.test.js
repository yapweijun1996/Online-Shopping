import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
const parts=Array.from({length:Math.ceil(png.length/3072)},(_,n)=>png.subarray(n*3072,(n+1)*3072).toString('base64'));
for(const dialect of ['sqlite','postgres'])for(const changed of ['removed-consent','old-epoch','raw-scope'])test(`${dialect}: ${changed} APPEND uses ordinary120 with no chunk or native authority`,
 {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
  const f=await mediaToolsFixture(t,dialect),begun=await f.tool('media.prepare_upload',{input:{action:'begin',...await f.input(png)}});
  const stage=begun.data.result.structuredContent.stage,input={input:{action:'append',stageId:stage.stageId,offset:0,dataParts:parts}};
  if(changed==='old-epoch')await f.store.run("UPDATE mcp_v2_scope_consent SET epoch_hash=? WHERE grant_id=? AND scope='media.write'",'f'.repeat(64),f.grantId);
  else await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'",f.grantId);
  if(changed==='raw-scope'){
   await f.store.run("UPDATE oauth_grant SET scopes='catalog.read media.write' WHERE id=?",f.grantId);
   await f.store.run("UPDATE oauth_token SET scopes='catalog.read media.write' WHERE grant_id=?",f.grantId);
  }
  const registered=createOperationTools({store:f.store,binding:f.binding,config:f.config,tenantGuard:f.guard,quickLogin:false,entries:f.entries});
  assert.equal(await registered.isMediaAppend('media.prepare_upload',input,f.bearer),false);
  const before=(await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n;
  for(let index=before;index<120;index++){
   const response=await f.tool('media.prepare_upload',input);assert.equal(response.response.status,403,JSON.stringify(response.data));
  }
  assert.equal((await f.tool('media.prepare_upload',input)).response.status,429);
  assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n,120);
  assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-append'")).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk')).n,0);
  assert.equal((await f.store.get('SELECT next_offset FROM mcp_v2_media_stage WHERE id=?',stage.stageId)).next_offset,0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
