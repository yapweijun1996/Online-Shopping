import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogCreateRuntimeFixture } from './helpers/mcp-catalog-create-runtime-fixture.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';
import { maintainOperations } from '../src/mcp/operation-maintenance.js';
import { singleTenantRegistry } from '../src/tenants.js';
import { createApi } from '../src/app.js';
import { serveStatic } from '../src/static.js';
import { createAccount } from '../src/accounts.js';
import { createProduct } from '../src/products.js';
const input=(sku)=>({sku,name:sku,description:'Synthetic finish fixture',category:'SYNTHETIC',priceMinor:140,active:true,stockQuantity:100});
async function setup(t){
 const f=await catalogCreateRuntimeFixture(t,t.name.startsWith('postgres:')?'postgres':'sqlite',{config:{mcpFinish:{enabled:true}}});
 const prepare=async(ops,key='finish-test-idempotency-001')=>{
  const response=await f.call('/api/v1/seller/mcp/finishes','POST',{items:ops.map(op=>({operationId:op.operationId,previewHash:op.previewHash})),idempotencyKey:key},f.headers);
  assert.equal(response.response.status,200,JSON.stringify(response.data));return response.data;
 };
 const proof=async op=>{const value=await f.review(op);await f.acknowledge(op,value);return{operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,mediaReviewed:true};};
 const approve=async(job,items,password=reviewPassword,headers=f.headers)=>f.call('/api/v1/seller/mcp/finishes/'+job.jobId+'/approve','POST',{items,password},headers);
 const resume=job=>f.call('/api/v1/seller/mcp/finishes/'+job.jobId+'/resume','POST',{},f.headers);
 return {...f,prepareJob:prepare,proof,finish:approve,resume};
}
const runTest=(name,fn)=>{for(const dialect of (process.env.SHOP_TEST_DATABASE_URL?['sqlite','postgres']:['sqlite']))test(dialect+': '+name,fn);};
runTest('finish creates, approves, commits, verifies and publishes once; replay is durable',async t=>{
 const f=await setup(t),op=await f.prepare(input('FINISH-001'),'finish-create-operation-001');
 const proof=await f.proof(op),job=await f.prepareJob([op]);
 const result=await f.finish(job,[proof]);assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.equal(result.data.status,'FINISHED',JSON.stringify(result.data));
 assert.equal(result.data.completed,1);assert.equal(result.data.items[0].operationState,'COMMITTED');
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product WHERE sku=?','FINISH-001')).n,1);
 assert.equal((await f.store.get('SELECT active FROM product WHERE sku=?','FINISH-001')).active,1);
 assert.deepEqual((await f.resume(job)).data,result.data);
 assert.equal((await f.prepareJob([op])).jobId,job.jobId);
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n,1);
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM seller_mcp_finish_event WHERE job_id=? AND event='VERIFIED'",job.jobId)).n,1);
});
runTest('batch isolates stale CREATE, preserves committed product and never approves a new proposal',async t=>{
 const f=await setup(t),a=await f.prepare(input('FINISH-A'),'finish-create-operation-a01'),b=await f.prepare(input('FINISH-B'),'finish-create-operation-b01');
 const proofs=[await f.proof(a),await f.proof(b)],job=await f.prepareJob([a,b]);
 const result=await f.finish(job,proofs);assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.equal(result.data.status,'PARTIAL');assert.equal(result.data.completed,1);
 assert.equal(result.data.items[1].error,'STALE_REVISION');
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product WHERE sku=?','FINISH-B')).n,0);
 assert.deepEqual((await f.resume(job)).data,result.data);
});
for(const negative of ['password','unreviewed','csrf','bearer','grant','scope','tenant','hash'])runTest('finish rejects '+negative+' without product writes',async t=>{
 const f=await setup(t),op=await f.prepare(input('NEGATIVE'),'finish-negative-operation-01'),proof=await f.proof(op),job=await f.prepareJob([op]);
 let headers={...f.headers},password=reviewPassword;
 if(negative==='password')password='incorrect-password';
 if(negative==='unreviewed')await f.store.run('DELETE FROM mcp_v2_media_delivery WHERE operation_id=?',op.operationId);
 if(negative==='csrf')headers['x-csrf-token']='wrong';
 if(negative==='bearer')headers.authorization='Bearer '+f.client.bearer;
 if(negative==='grant')await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=(SELECT grant_id FROM mcp_v2_operation WHERE id=?)',new Date().toISOString(),op.operationId);
 if(negative==='scope')await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE scope='media.write'");
 if(negative==='tenant')await f.store.run("UPDATE mcp_v2_operation SET tenant_id='different' WHERE id=?",op.operationId);
 if(negative==='hash')proof.previewHash='0'.repeat(64);
 const response=await f.finish(job,[proof],password,headers);assert.equal(response.response.status,403,JSON.stringify(response.data));
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product WHERE sku=?','NEGATIVE')).n,0);
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'PENDING_APPROVAL');
});
runTest('resume cannot turn an unapproved job into writes; changed idempotency payload rejected',async t=>{
 const f=await setup(t),a=await f.prepare(input('UNAPPROVED'),'finish-unapproved-oper-01'),b=await f.prepare(input('OTHER'),'finish-other-operation-01'),job=await f.prepareJob([a]);
 const result=await f.resume(job);assert.equal(result.data.status,'PARTIAL');assert.equal(result.data.items[0].error,'APPROVAL_REQUIRED');
 const response=await f.call('/api/v1/seller/mcp/finishes','POST',{items:[{operationId:b.operationId,previewHash:b.previewHash}],idempotencyKey:'finish-test-idempotency-001'},f.headers);
 assert.equal(response.response.status,409);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
});
runTest('stale revision revalidation prepares a new exact review; old approval is never transferred',async t=>{
 const f=await setup(t),op=await f.prepare(input('STALE-RENEW'),'finish-renew-operation-01'),proof=await f.proof(op),job=await f.prepareJob([op]);
 await f.approve(op);
 await createProduct(f.store,input('OTHER-WRITE'));
 const stale=await f.resume(job);assert.equal(stale.response.status,200,JSON.stringify(stale.data));
 assert.equal(stale.data.items[0].error,'STALE_REVISION');
 const replacement=await f.call('/api/v1/seller/mcp/finishes/'+job.jobId+'/revalidate','POST',{operationId:op.operationId,idempotencyKey:'finish-revalidation-key-001'},f.headers);
 assert.equal(replacement.response.status,200,JSON.stringify(replacement.data));
 assert.equal(replacement.data.renewedApprovalRequired,true);
 const replay=await f.call('/api/v1/seller/mcp/finishes/'+job.jobId+'/revalidate','POST',{operationId:op.operationId,idempotencyKey:'finish-revalidation-key-001'},f.headers);
 assert.equal(replay.response.status,200,JSON.stringify(replay.data));assert.equal(replay.data.operationId,replacement.data.operationId);assert.equal(replay.data.replayed,true);
 assert.notEqual(replacement.data.operationId,op.operationId);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id=?',replacement.data.operationId)).n,0);
 assert.equal((await f.resume(job)).data.items[0].error,'APPROVAL_REQUIRED');
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product WHERE sku=?','STALE-RENEW')).n,0);
 const newProof=await f.proof(replacement.data),result=await f.finish(job,[newProof]);
 assert.equal(result.data.status,'FINISHED',JSON.stringify(result.data));
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'CONFLICT');
});
runTest('concurrent resumes preserve one create, stock initialization and commit audit',async t=>{
 const f=await setup(t),op=await f.prepare(input('CONCURRENT'),'finish-concurrent-oper-01');await f.approve(op);
 const job=await f.prepareJob([op]),responses=await Promise.all([f.resume(job),f.resume(job),f.resume(job)]);
 for(const response of responses)assert.equal(response.data.status,'FINISHED',JSON.stringify(response.data));
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product WHERE sku=?','CONCURRENT')).n,1);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement WHERE operation_id=?',op.operationId)).n,1);
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n,1);
});
runTest('post-commit progress failure reconciles from receipt after service reconstruction (synthetic crash window)',async t=>{
 const f=await setup(t),op=await f.prepare(input('CRASH-WINDOW'),'finish-crash-window-oper1');await f.approve(op);
 const job=await f.prepareJob([op]),originalRun=f.store.run;let injected=false;
 f.store.run=async(sql,...args)=>{if(!injected&&sql.startsWith('UPDATE seller_mcp_finish_item SET state=')&&args[0]==='COMMITTED'){injected=true;throw new Error('Synthetic stopped progress writer');}return originalRun(sql,...args);};
 const uncertain=await f.resume(job);f.store.run=originalRun;
 assert.equal(injected,true);assert.equal(uncertain.data.items[0].state,'RETRY');assert.equal(uncertain.data.items[0].operationState,'COMMITTED');
 const api=await createApi({store:f.store,config:f.config,serveStatic,operationTools:[{...((await import('../src/mcp/catalog-media-create-adapter.js')).catalogMediaCreateTool(f.runtime))},...(await import('../src/mcp/operation-control-contracts.js')).operationControlTools()]});
 const response=await api(new Request(f.config.sellerOrigin+'/api/v1/seller/mcp/finishes/'+job.jobId+'/resume',{method:'POST',headers:{...f.headers,'content-type':'application/json'},body:'{}'}),{clientAddress:'synthetic-resume'});
 assert.equal(response.status,200);assert.equal((await response.json()).status,'FINISHED');
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n,1);
});
runTest('another seller cannot read a saved job or resume its operations',async t=>{
 const f=await setup(t),op=await f.prepare(input('PRIVATE'),'finish-owner-private-op1'),job=await f.prepareJob([op]);
 const other=await createAccount(f.store,{username:'other_owner',role:'MANAGER',password:reviewPassword},'synthetic_owner');
 await f.store.run('UPDATE seller_account SET must_change_password=0 WHERE id=?',other.id);
 const login=await f.call('/api/v1/seller/session','POST',{username:'other_owner',password:reviewPassword},{origin:f.config.sellerOrigin});
 assert.equal(login.response.status,200);const headers={origin:f.config.sellerOrigin,cookie:login.response.headers.get('set-cookie').split(';')[0],'x-csrf-token':login.data.csrfToken};
 const read=await f.call('/api/v1/seller/mcp/finishes/'+job.jobId,'GET',undefined,headers);
 assert.equal(read.response.status,403);assert.equal(JSON.stringify(read.data).includes(op.operationId),false);
 const resume=await f.call('/api/v1/seller/mcp/finishes/'+job.jobId+'/resume','POST',{},headers);assert.equal(resume.response.status,403);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
});
runTest('expired approval and revoked seller session cannot be resumed',async t=>{
 const f=await setup(t),op=await f.prepare(input('EXPIRED'),'finish-expired-operation1');await f.approve(op);
 const job=await f.prepareJob([op]),approval=await f.store.get('SELECT approved_at FROM mcp_v2_approval WHERE operation_id=?',op.operationId);
 await new Promise(resolve=>setTimeout(resolve,5));
 await f.store.run('UPDATE mcp_v2_approval SET expires_at=? WHERE operation_id=?',new Date(Date.parse(approval.approved_at)+1).toISOString(),op.operationId);
 const response=await f.resume(job);assert.equal(response.data.items[0].error,'EXPIRED',JSON.stringify(response.data));
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
 await f.store.run('DELETE FROM session');assert.equal((await f.resume(job)).response.status,403);
});

runTest('resume reconciles an item genuinely approved after an earlier missing-approval hold',async t=>{
 const f=await setup(t),op=await f.prepare(input('LATER-APPROVED'),'finish-later-approved-op1'),job=await f.prepareJob([op]);
 assert.equal((await f.resume(job)).data.items[0].error,'APPROVAL_REQUIRED');
 await f.approve(op);const result=await f.resume(job);assert.equal(result.data.status,'FINISHED');
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product WHERE sku=?','LATER-APPROVED')).n,1);
});
runTest('operation receipt deletion is not pinned by progress rows or progress audit',async t=>{
 const f=await setup(t),op=await f.prepare(input('RETENTION'),'finish-retention-oper-01'),job=await f.prepareJob([op]);
 const row=await f.store.get('SELECT receipt_expires_at FROM mcp_v2_operation WHERE id=?',op.operationId);
 t.mock.timers.enable({apis:['Date'],now:Date.parse(row.receipt_expires_at)+1});
 const registry=singleTenantRegistry({store:f.store,config:f.config}),tenant=await registry.resolve();
 for(let n=0;n<3;n++)await maintainOperations(f.store,{enabled:true,tenantGuard:registry.operationGuard(tenant),tenantId:'default'});
 assert.equal(await f.store.get('SELECT id FROM mcp_v2_operation WHERE id=?',op.operationId),undefined);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM seller_mcp_finish_item WHERE job_id=?',job.jobId)).n,0);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM seller_mcp_finish_event WHERE job_id=?',job.jobId)).n,0);
});

runTest('read-back checks description as well as price, stock and image hashes after an uncertain commit',async t=>{
 const f=await setup(t),op=await f.prepare(input('READBACK'),'finish-full-readback-op1');await f.approve(op);const job=await f.prepareJob([op]);
 // Synthetic crash window: the genuine engine commits, but progress has not yet been saved.
 const committed=await f.commit(op);assert.equal(committed.data.result.structuredContent.status,'COMMITTED');
 await f.store.run('UPDATE product SET description=? WHERE sku=?','Synthetic concurrent changed description','READBACK');
 const response=await f.resume(job);assert.equal(response.data.status,'PARTIAL');assert.equal(response.data.items[0].error,'VERIFY_CHANGED');
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n,1);
});

runTest('malformed approval packets return actionable invalid input and never approve',async t=>{
 const f=await setup(t),op=await f.prepare(input('MALFORMED'),'finish-malformed-packet1'),job=await f.prepareJob([op]);
 for(const items of [[null],[{operationId:op.operationId}],[{operationId:op.operationId,previewHash:op.previewHash,challenge:'bad'}]]){
  const response=await f.finish(job,items);assert.equal(response.response.status,400);assert.equal(response.data.error,'INVALID_INPUT');
 }
 const response=await f.call('/api/v1/seller/mcp/finishes/'+job.jobId+'/resume','POST',[],f.headers);assert.equal(response.response.status,400);
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'PENDING_APPROVAL');
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
});
