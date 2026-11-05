import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { seedCreateWireOperation } from './helpers/mcp-catalog-create-wire-fixture.js';
import { persistMediaFrame,readMediaFrame } from '../src/mcp/media-frame-storage.js';
import { canonicalOperationJson,operationPreviewHash } from '../src/mcp/operation-envelope.js';
import { storeMediaPolicy } from '../src/mcp/media-storage.js';
import { reviewFixture,reviewPassword } from './helpers/mcp-review-fixture.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: SYNTHETIC CREATE EMPTY/existing frames bind stored identity and page literals with no stage authority`,options,async t=>{
  const f=await mediaFixture(t,dialect);
  for(const existing of [false,true]){
   const operation=await seedCreateWireOperation(f,{existing});await assert.rejects(storeMediaPolicy(f.store,f.context,operation.id,operation.manifest.descriptor),{status:400});
   assert.deepEqual(await persistMediaFrame(f.store,f.context,operation.id,operation.manifest),operation.manifest);assert.deepEqual(await readMediaFrame(f.store,f.context,operation.id),operation.manifest);
   for(const mutate of [value=>value.proposal.after.name='Unbound literal',value=>{value.proposal.after.name='Forged both';value.proposal.reviewLabels.find(row=>row.before===null).after.name='Forged both';},value=>value.proposal.creationIdentity.productId='00000000-0000-4000-8000-000000000077',value=>value.proposal.reviewLabels.find(row=>row.before===null).before={sku:'Fake',name:'Fake'},value=>value.proposal.after.options=[{typeId:'x',valueId:'y'}]]){
    const envelope=structuredClone(operation.envelope);mutate(envelope);await f.store.run('UPDATE mcp_v2_operation SET envelope_json=?,preview_hash=? WHERE id=?',canonicalOperationJson(envelope),operationPreviewHash(envelope),operation.id);
    await assert.rejects(readMediaFrame(f.store,f.context,operation.id),{status:503,code:'MEDIA_FRAME_INTEGRITY'});
    await f.store.run('UPDATE mcp_v2_operation SET envelope_json=?,preview_hash=? WHERE id=?',canonicalOperationJson(operation.envelope),operationPreviewHash(operation.envelope),operation.id);
   }
  }
  for(const table of ['mcp_v2_media_stage','mcp_v2_media_pin'])assert.equal((await f.store.get('SELECT COUNT(*) n FROM '+table)).n,0);
 });
 test(`${dialect}: CREATE frame mismatch fails before rows and rolls back retained prototype metadata`,options,async t=>{
  const f=await mediaFixture(t,dialect);await assert.rejects(f.store.transaction(async()=>{const operation=await seedCreateWireOperation(f,{proposalPatch:{before:{}}});await persistMediaFrame(f.store,f.context,operation.id,operation.manifest);}),{status:503,code:'MEDIA_FRAME_INTEGRITY'});
  for(const table of ['mcp_v2_operation','mcp_v2_operation_media_policy','mcp_v2_media_manifest_page','mcp_v2_media_asset_ref'])assert.equal((await f.store.get('SELECT COUNT(*) n FROM '+table)).n,0);
 });
 test(`${dialect}: real session and separate dual consent still cannot review or approve RESERVED CREATE`,options,async t=>{
  const f=await reviewFixture(t,dialect,{config:{mcpMedia:{enabled:true}}});await f.seedGrant();const grant=await f.store.get('SELECT * FROM oauth_grant WHERE id=?',f.grantId),epochHash=operationEpochHash(f.config.mcpV2.epoch);
  await f.store.run("UPDATE oauth_grant SET scopes='catalog.write media.write' WHERE id=?",f.grantId);
  await f.store.run("INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at) VALUES(?,?,?,?,'media.write',?,?,?)",f.grantId,f.binding.tenantId,f.account.id,f.clientId,f.account.oauth_auth_version,epochHash,grant.created_at);
  const context={...f.binding,tenantRevision:0,accountId:f.account.id,clientId:f.clientId,grantId:f.grantId,accountAuthVersion:f.account.oauth_auth_version,epochHash,buildDigest:f.config.mcpV2.buildDigest,grantExpiresAt:grant.absolute_expires_at};
  const operation=await seedCreateWireOperation({...f,context,now:grant.created_at});await persistMediaFrame(f.store,context,operation.id,operation.manifest);await f.store.run("UPDATE mcp_v2_operation SET state='PENDING_APPROVAL' WHERE id=?",operation.id);
  const url='/api/v1/seller/mcp/operations/'+operation.id;
  assert.equal((await f.call(url,'GET',undefined,f.headers)).response.status,403);
  assert.equal((await f.call(url+'/approval','POST',{operationId:operation.id,previewHash:operationPreviewHash(operation.envelope),challenge:'A'.repeat(43),decision:'approve',password:reviewPassword,mediaReviewed:true},f.headers)).response.status,403);
  for(const table of ['mcp_v2_approval','mcp_v2_approval_challenge','mcp_v2_media_delivery','mcp_v2_media_approval_evidence'])assert.equal((await f.store.get('SELECT COUNT(*) n FROM '+table)).n,0);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.id)).state,'PENDING_APPROVAL');
 });
}
