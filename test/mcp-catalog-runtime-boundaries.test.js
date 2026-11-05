import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaEngineFixture} from './helpers/mcp-media-engine-fixture.js';
import {verifyOperationAuthority} from '../src/mcp/operation-authorization.js';
import {storeMediaPolicy,readMediaPolicy} from '../src/mcp/media-storage.js';
import {readOperationRecord} from '../src/mcp/operation-record.js';
import {seedCatalogWireOperation} from './helpers/mcp-catalog-wire-fixture.js';
import {canonicalOperationJson,operationPreviewHash} from '../src/mcp/operation-envelope.js';
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: central C authority defaults deny and rejects CREATE/resource/policy substitutions`,options,async t=>{
  const f=await mediaEngineFixture(t,dialect),base={...f.authorization,toolName:'catalog.preview_update',mediaPolicyId:'catalog-media-v1',resourceType:'product'};
  const verify=patch=>f.store.transaction(()=>verifyOperationAuthority(f.store,{...base,...patch}));
  await assert.rejects(verify(),{status:403});
  assert.deepEqual((await verify({catalogUpdateEnabled:true})).requiredScopes,['catalog.write','media.write']);
  for(const patch of [{toolName:'catalog.preview_create'},{toolName:'catalog.commit_create'},{resourceType:'catalog'},{resourceType:null},
   {mediaPolicyId:'media-upload-v1'},{catalogUpdateEnabled:false}])await assert.rejects(verify({catalogUpdateEnabled:true,...patch}),{status:403});
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
 test(`${dialect}: SYNTHETIC metadata writer defaults deny and allows only exact C UPDATE row with both retained scopes`,options,async t=>{
  const f=await mediaEngineFixture(t,dialect),id=await f.operation('d'.repeat(64));
  await f.store.run('DELETE FROM mcp_v2_operation_media_policy WHERE operation_id=?',id);
  await f.store.run("UPDATE mcp_v2_operation SET tool_name='catalog.preview_update',required_scope='catalog.write',resource_id=?,media_policy_id=NULL WHERE id=?",f.productId,id);
  const descriptor={policyId:'catalog-media-v1',manifestRoot:'f'.repeat(64),graphRevision:'e'.repeat(64),codecDigest:'d'.repeat(64),pageCount:1,assetCount:0,effectCount:2};
  await assert.rejects(storeMediaPolicy(f.store,f.context,id,descriptor),{status:400});
  for(const [column,value] of [['tool_name','catalog.preview_create'],['resource_type','catalog'],['resource_id','catalog'],['risk','MEDIUM'],['required_scope','media.write']]){
   await assert.rejects(f.store.transaction(async()=>{await f.store.run('UPDATE mcp_v2_operation SET '+column+'=? WHERE id=?',value,id);
    await storeMediaPolicy(f.store,f.context,id,descriptor,{catalogUpdateEnabled:true});}),{status:409});
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation_media_policy')).n,0);
  }
  await storeMediaPolicy(f.store,f.context,id,descriptor,{catalogUpdateEnabled:true});
  assert.equal((await readMediaPolicy(f.store,f.context,id)).required_scopes,'catalog.write media.write');
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',id)).state,'PENDING_APPROVAL');
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
 test(`${dialect}: retained C record enforces the fixed product UUID binding even with self-consistent envelope hashes`,options,async t=>{
  const f=await mediaEngineFixture(t,dialect),op=await seedCatalogWireOperation(f),grant=await f.store.get('SELECT * FROM oauth_grant WHERE id=?',f.context.grantId);
  const read=async()=>readOperationRecord(f.store,await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.id),
   {binding:f.binding,tenantRevision:f.context.tenantRevision,epochHash:f.context.epochHash,buildDigest:f.context.buildDigest,grant,context:f.context,
    expected:{resourceType:'product',mediaPolicyId:'catalog-media-v1'}});
  assert.ok(await read());
  const forged={...op.envelope,resourceId:'catalog'};
  await f.store.run('UPDATE mcp_v2_operation SET resource_id=?,envelope_json=?,preview_hash=? WHERE id=?','catalog',canonicalOperationJson(forged),operationPreviewHash(forged),op.id);
  assert.equal(await read(),null);
 });
}
