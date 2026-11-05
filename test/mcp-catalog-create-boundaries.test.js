import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaEngineFixture} from './helpers/mcp-media-engine-fixture.js';
import {verifyOperationAuthority} from '../src/mcp/operation-authorization.js';
import {storeMediaPolicy,readMediaPolicy} from '../src/mcp/media-storage.js';
import {createOperationEngine} from '../src/mcp/operation-engine.js';

// Constructor-only synthetic hooks: no preview, decoder, grant or approval evidence.
test('CREATE media hooks require their independent flag and literal catalog resource type',()=>{
 const noop=()=>{}, adapter={resourceType:'catalog',preview:noop,currentRevision:noop,apply:noop,validResult:noop,toReceipt:noop,validReceipt:noop,
  media:{policyId:'catalog-media-v1',codecDigest:'d'.repeat(64),capture:noop,resolve:noop,persistResources:noop,consumeResources:noop}},
  options={store:{},binding:{tenantId:'synthetic',issuer:'https://seller.example.test',resource:'https://seller.example.test/mcp'},
   adapters:{'catalog.preview_create':adapter},epoch:Buffer.alloc(32,3).toString('base64url'),buildDigest:'b'.repeat(64),tenantGuard:{withActiveTenant:noop},enabled:true,quickLogin:false};
 assert.throws(()=>createOperationEngine(options),TypeError);
 assert.throws(()=>createOperationEngine({...options,catalogUpdateEnabled:true}),TypeError);
 assert.ok(createOperationEngine({...options,catalogCreateEnabled:true}));
 for(const resourceType of ['product','inventory','order'])assert.throws(()=>createOperationEngine({...options,catalogCreateEnabled:true,
  adapters:{'catalog.preview_create':{...adapter,resourceType}}}),TypeError);
});
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: CREATE authority defaults deny and requires independent fixed dual-scope profile`,options,async t=>{
  const f=await mediaEngineFixture(t,dialect),base={...f.authorization,toolName:'catalog.preview_create',mediaPolicyId:'catalog-media-v1',resourceType:'catalog'};
  const verify=patch=>f.store.transaction(()=>verifyOperationAuthority(f.store,{...base,...patch}));
  await assert.rejects(verify(),{status:403});await assert.rejects(verify({catalogUpdateEnabled:true}),{status:403});
  assert.deepEqual((await verify({catalogCreateEnabled:true})).requiredScopes,['catalog.write','media.write']);
  for(const patch of [{toolName:'catalog.preview_update'},{toolName:'catalog.commit_update'},{resourceType:'product'},
   {mediaPolicyId:'media-upload-v1'},{catalogCreateEnabled:false}])await assert.rejects(verify({catalogCreateEnabled:true,...patch}),{status:403});
  await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE scope='media.write'");
  await assert.rejects(verify({catalogCreateEnabled:true}),{status:403});
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: SYNTHETIC retained policy permits only HIGH CREATE catalog/catalog and preserves both scopes`,options,async t=>{
  const f=await mediaEngineFixture(t,dialect),id=await f.operation('d'.repeat(64));
  await f.store.run('DELETE FROM mcp_v2_operation_media_policy WHERE operation_id=?',id);
  await f.store.run("UPDATE mcp_v2_operation SET tool_name='catalog.preview_create',required_scope='catalog.write',resource_type='catalog',resource_id='catalog',media_policy_id=NULL WHERE id=?",id);
  const descriptor={policyId:'catalog-media-v1',manifestRoot:'f'.repeat(64),graphRevision:'e'.repeat(64),codecDigest:'d'.repeat(64),pageCount:1,assetCount:0,effectCount:2};
  await assert.rejects(storeMediaPolicy(f.store,f.context,id,descriptor),{status:400});
  await assert.rejects(storeMediaPolicy(f.store,f.context,id,descriptor,{catalogUpdateEnabled:true}),{status:409});
  for(const [column,value] of [['tool_name','catalog.preview_update'],['resource_type','product'],['resource_id',f.productId],['risk','MEDIUM'],['required_scope','media.write']]){
   await assert.rejects(f.store.transaction(async()=>{await f.store.run('UPDATE mcp_v2_operation SET '+column+'=? WHERE id=?',value,id);
    await storeMediaPolicy(f.store,f.context,id,descriptor,{catalogCreateEnabled:true});}),{status:409});
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation_media_policy')).n,0);
  }
  await storeMediaPolicy(f.store,f.context,id,descriptor,{catalogCreateEnabled:true});
  assert.equal((await readMediaPolicy(f.store,f.context,id)).required_scopes,'catalog.write media.write');
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
}
