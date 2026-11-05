import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { catalogue } from '../src/mcp/tools.js';
const legacy=catalogue.map(({scope:_scope,...tool})=>tool);
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: actual default constructor keeps media flag-off and explicit empty registrations closed`,options,async t=>{
  const off=await mediaToolsFixture(t,dialect,{config:{mcpMedia:{enabled:false}},entries:undefined});
  const listed=await off.rpc('tools/list',{});assert.equal(listed.response.status,200,JSON.stringify(listed.data));
  assert.deepEqual(listed.data.result.tools.map(tool=>tool.name),[...legacy.map(tool=>tool.name),
   'catalog.preview_create','catalog.commit_create','catalog.preview_update','catalog.commit_update']);
  assert.deepEqual(listed.data.result.tools.slice(0,8),legacy);
  assert.equal((await off.tool('media.list',{productId:off.product.id})).data.error.code,-32602);
  const empty=await mediaToolsFixture(t,dialect,{entries:[]});
  assert.deepEqual((await empty.rpc('tools/list',{})).data.result.tools,legacy);
  for(const f of [off,empty]){
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
  }
 });
 test(`${dialect}: unsafe production/default-v2-off never initializes media and missing worker fails closed`,options,async t=>{
  for(const config of [{production:true},{mcpV2:{enabled:false}}]){
   const f=await mediaToolsFixture(t,dialect,{config,entries:undefined});
   assert.deepEqual((await f.rpc('tools/list',{})).data.result.tools,legacy);
   assert.equal((await f.tool('media.list',{productId:f.product.id})).data.error.code,-32602);
  }
  const missing=await mediaToolsFixture(t,dialect,{entries:undefined,config:{mcpMedia:{enabled:true,
   socketPath:'/synthetic/missing/codec.sock',tokenFile:'/synthetic/missing/token',codecDigest:'d'.repeat(64)}}});
  // This manually supplied invalid trusted descriptor bypasses readConfig;
  // constructor failure uses the application's generic500 initialization path.
  const failed=await missing.rpc('tools/list',{});assert.equal(failed.response.status,500);
  assert.doesNotMatch(JSON.stringify(failed.data),/synthetic\/missing|socket|tokenFile|password/);
  assert.equal((await missing.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  assert.equal((await missing.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);
 });
}
