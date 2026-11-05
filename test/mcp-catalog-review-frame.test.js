import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { seedCatalogWireOperation } from './helpers/mcp-catalog-wire-fixture.js';
import { persistMediaFrame,readMediaFrame } from '../src/mcp/media-frame-storage.js';
import { canonicalOperationJson,operationPreviewHash } from '../src/mcp/operation-envelope.js';
import { storeMediaPolicy } from '../src/mcp/media-storage.js';
import { reviewFixture,reviewPassword } from './helpers/mcp-review-fixture.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: SYNTHETIC C frame independently binds canonical proposal labels without enabling runtime policy`,options,async t=>{
  const f=await mediaFixture(t,dialect),op=await seedCatalogWireOperation(f);
  await assert.rejects(storeMediaPolicy(f.store,f.context,op.id,op.manifest.descriptor),{status:400});
  assert.deepEqual(await persistMediaFrame(f.store,f.context,op.id,op.manifest),op.manifest);
  assert.deepEqual(await readMediaFrame(f.store,f.context,op.id),op.manifest);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n,0);
  for(const mutate of [envelope=>{envelope.proposal.reviewLabels[0].after.name='Changed literal';},envelope=>{envelope.proposal.reviewLabels=[];}]){
   const value=structuredClone(op.envelope);mutate(value);
   await f.store.run('UPDATE mcp_v2_operation SET envelope_json=?,preview_hash=? WHERE id=?',canonicalOperationJson(value),operationPreviewHash(value),op.id);
   await assert.rejects(readMediaFrame(f.store,f.context,op.id),{status:503,code:'MEDIA_FRAME_INTEGRITY'});
  }
 });
 test(`${dialect}: invalid labels fail before frame rows and outer transaction rollback leaves no retained authority`,options,async t=>{
  const f=await mediaFixture(t,dialect);
  await assert.rejects(f.store.transaction(async()=>{
   const op=await seedCatalogWireOperation(f,undefined,{reviewLabels:[]});
   await persistMediaFrame(f.store,f.context,op.id,op.manifest);
  }),{status:503,code:'MEDIA_FRAME_INTEGRITY'});
  for(const table of ['mcp_v2_operation','mcp_v2_operation_media_policy','mcp_v2_media_manifest_page','mcp_v2_media_asset_ref','mcp_v2_media_pin'])assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM '+table)).n,0);
 });
 test(`${dialect}: valid seller session and dual consent still cannot review or approve the inactive RESERVED C policy`,options,async t=>{
  const f=await reviewFixture(t,dialect,{config:{mcpMedia:{enabled:true}}});await f.seedGrant();
  const grant=await f.store.get('SELECT * FROM oauth_grant WHERE id=?',f.grantId),epochHash=operationEpochHash(f.config.mcpV2.epoch);
  await f.store.run("UPDATE oauth_grant SET scopes='catalog.write media.write' WHERE id=?",f.grantId);
  await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at)
   VALUES(?,?,?,?,'media.write',?,?,?)`,f.grantId,f.binding.tenantId,f.account.id,f.clientId,f.account.oauth_auth_version,epochHash,grant.created_at);
  const context={...f.binding,tenantRevision:0,accountId:f.account.id,clientId:f.clientId,grantId:f.grantId,accountAuthVersion:f.account.oauth_auth_version,
   epochHash,buildDigest:f.config.mcpV2.buildDigest,grantExpiresAt:grant.absolute_expires_at};
  const op=await seedCatalogWireOperation({...f,context,now:grant.created_at});await persistMediaFrame(f.store,context,op.id,op.manifest);
  await f.store.run("UPDATE mcp_v2_operation SET state='PENDING_APPROVAL' WHERE id=?",op.id);
  const path='/api/v1/seller/mcp/operations/'+op.id;
  assert.equal((await f.call(path,'GET',undefined,f.headers)).response.status,403);
  assert.equal((await f.call(path+'/approval','POST',{operationId:op.id,previewHash:operationPreviewHash(op.envelope),challenge:'A'.repeat(43),
   decision:'approve',password:reviewPassword,mediaReviewed:true},f.headers)).response.status,403);
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.id)).state,'PENDING_APPROVAL');
  for(const table of ['mcp_v2_approval','mcp_v2_approval_challenge','mcp_v2_media_delivery','mcp_v2_media_approval_evidence'])assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM '+table)).n,0);
 });
}
