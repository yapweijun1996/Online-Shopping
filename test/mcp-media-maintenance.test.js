import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { maintainMedia, clearMediaChallenge } from '../src/mcp/media-maintenance.js';
import { maintainOperations } from '../src/mcp/operation-maintenance.js';
import { mediaHash } from '../src/mcp/media-storage.js';
const options=dialect=>({skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL});
const guard=f=>({withActiveTenant:async(id,work)=>{assert.equal(id,f.context.tenantId);return work({revision:f.context.tenantRevision});}});
for(const dialect of ['sqlite','postgres']){
  test(`${dialect}: maximum stage garbage is byte-bounded, interruptible and releases quota only after the final bytes`,options(dialect),async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.alloc(524288,1),{args,stage,lease}=await f.upload(bytes),op=await f.operation(lease.codecDigest,f.now,lease.correlationId);
    await f.writer(w=>w.bind(stage.stageId,lease.leaseToken,lease.version,{image:Buffer.alloc(524288,2),thumbnail:Buffer.alloc(81920,3),sourceSha256:lease.sourceSha256,mime:'image/png',width:2048,height:2048,codecDigest:lease.codecDigest},op));
    await f.store.run("UPDATE mcp_v2_operation SET state='FAILED' WHERE id=?",op);
    const now=new Date(Date.parse(f.now)+660000).toISOString(),config={enabled:true,tenantGuard:guard(f),tenantId:f.context.tenantId,now};
    const oldRun=f.store.run;let deletions=0;
    f.store.run=(sql,...values)=>{if(sql.startsWith('DELETE FROM mcp_v2_media_chunk')&&++deletions===2)throw new Error('Synthetic garbage failure');return oldRun(sql,...values);};
    await assert.rejects(maintainMedia(f.store,config),/Synthetic garbage failure/);f.store.run=oldRun;
    let row=await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId);const original={begin:row.begin_request_hash,idem:row.idempotency_hash,correlation:row.correlation_id};assert.equal(row.state,'BOUND');assert.equal(row.canonical_data.length,524288);assert.equal(row.reserved_bytes,1130496);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk')).n,15);
    const first=await maintainMedia(f.store,config);
    assert.ok(first.passes.every(pass=>pass.rows<=100&&pass.bytes<=1048576));
    row=await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId);assert.equal(row.state,'EXPIRED');assert.equal(row.canonical_data,null);assert.equal(row.reserved_bytes,1130496);
    const remaining=(await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk')).n;assert.ok(remaining>0&&remaining<15);assert.equal(first.released,0);
    assert.ok((await f.store.all('SELECT reserved_bytes,active_slots FROM mcp_v2_media_quota')).every(q=>q.reserved_bytes===1130496&&q.active_slots===1));
    f.store.run=(sql,...values)=>{if(sql.startsWith('INSERT INTO mcp_v2_media_event'))throw new Error('Synthetic release audit failure');return oldRun(sql,...values);};
    await assert.rejects(maintainMedia(f.store,config),/Synthetic release audit failure/);f.store.run=oldRun;
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk')).n,remaining);
    assert.equal((await f.store.get('SELECT reserved_bytes FROM mcp_v2_media_stage')).reserved_bytes,1130496);
    const second=await maintainMedia(f.store,config);assert.equal(second.released,1);assert.ok(second.passes.every(pass=>pass.rows<=100&&pass.bytes<=1048576));
    row=await f.store.get('SELECT * FROM mcp_v2_media_stage');assert.equal(row.reserved_bytes,0);assert.equal(row.operation_id,op);assert.equal(row.begin_request_hash,original.begin);assert.equal(row.idempotency_hash,original.idem);assert.equal(row.correlation_id,original.correlation);
    assert.ok(row.begin_request_hash&&row.idempotency_hash&&row.correlation_id&&row.scrubbed_at);assert.equal(row.receipt_expires_at,new Date(Date.parse(f.context.grantExpiresAt)+90*86400000).toISOString());
    assert.ok((await f.store.all('SELECT reserved_bytes,active_slots FROM mcp_v2_media_quota')).every(q=>q.reserved_bytes===0&&q.active_slots===0));
    assert.equal((await f.writer(w=>w.begin(args),now)).operationId,op);
    await assert.rejects(f.writer(w=>w.append(stage.stageId,0,Buffer.from([1])),now),{status:409});
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation_media_policy')).n,1,'Minimal policy remains until original receipt expiry');
    assert.equal((await maintainMedia(f.store,config)).released,0);
  });
  test(`${dialect}: approved media proof beyond the33-row expiry batch survives, then drains in FK order`,options(dialect),async t=>{
    const f=await mediaFixture(t,dialect),old=new Date(Date.parse(f.now)-3600000).toISOString(),expires=new Date(Date.parse(old)+600000).toISOString(),approved=new Date(Date.parse(old)+60000).toISOString();
    await f.store.transaction(async()=>{
      for(let n=0;n<40;n++){
        const op=await f.operation('d'.repeat(64),old),challenge=randomUUID(),pageHash=mediaHash('{}');
        const descriptor=(await f.store.get('SELECT descriptor_hash FROM mcp_v2_operation_media_policy WHERE operation_id=?',op)).descriptor_hash;
        await f.store.run("UPDATE mcp_v2_operation SET state='APPROVED' WHERE id=?",op);
        await f.store.run('INSERT INTO mcp_v2_approval_challenge(id,operation_id,nonce_hash,created_at,expires_at,consumed_at)VALUES(?,?,?,?,?,?)',challenge,op,mediaHash(challenge),old,expires,approved);
        await f.store.run("INSERT INTO mcp_v2_approval(operation_id,approver_id,session_hash,preview_hash,decision,approved_at,expires_at)VALUES(?,?,?,?,'APPROVED',?,?)",op,f.context.accountId,'e'.repeat(64),'e'.repeat(64),approved,expires);
        await f.store.run('INSERT INTO mcp_v2_media_manifest_page(operation_id,page_index,page_json,page_hash,record_count,created_at)VALUES(?,0,?,?,1,?)',op,'{}',pageHash,old);
        await f.store.run("INSERT INTO mcp_v2_media_delivery(challenge_id,operation_id,kind,item_key,manifest_root,expected_hash,nonce_hash,issued_at,expires_at,ack_at,page_index)VALUES(?,?,'PAGE','0',?,?,?,?,?,?,0)",challenge,op,'f'.repeat(64),pageHash,'c'.repeat(64),old,expires,approved);
        await f.store.run("INSERT INTO mcp_v2_media_approval_evidence(operation_id,challenge_id,manifest_root,descriptor_hash,approver_id,session_hash,account_auth_version,epoch_hash,build_digest,tenant_revision,policy_id,approved_at,expires_at,acknowledged_at)VALUES(?,?,?,?,?,?,0,?,?,1,'media-upload-v1',?,?,?)",op,challenge,'f'.repeat(64),descriptor,f.context.accountId,'e'.repeat(64),f.context.epochHash,f.context.buildDigest,approved,expires,old);
      }
    });
    const config={enabled:true,tenantGuard:guard(f),tenantId:f.context.tenantId},first=await maintainOperations(f.store,config);
    assert.equal(first.expired,33);assert.equal(first.redacted,33);
    for(const table of ['mcp_v2_media_delivery','mcp_v2_media_approval_evidence','mcp_v2_media_manifest_page','mcp_v2_approval','mcp_v2_approval_challenge'])assert.equal((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,7,table);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation_media_policy')).n,40);
    const second=await maintainOperations(f.store,config);assert.equal(second.expired,7);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_approval_evidence')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
  });
}

for(const dialect of ['sqlite','postgres'])test(`${dialect}: oversized legacy approval metadata cannot escape the expiry byte budget or delete pending media proof`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await mediaFixture(t,dialect),old=new Date(Date.parse(f.now)-3600000).toISOString(),approved=new Date(Date.parse(old)+60000).toISOString(),expires=new Date(Date.parse(old)+600000).toISOString();
    const op=await f.operation('d'.repeat(64),old);await f.store.run("UPDATE mcp_v2_operation SET state='APPROVED' WHERE id=?",op);
    await f.store.run("INSERT INTO mcp_v2_approval(operation_id,approver_id,session_hash,preview_hash,decision,approved_at,expires_at)VALUES(?,?,?,?,'APPROVED',?,?)",op,'X'.repeat(600000),'e'.repeat(64),'e'.repeat(64),approved,expires);
    const first=await maintainOperations(f.store,{enabled:true,tenantGuard:guard(f),tenantId:f.context.tenantId});assert.equal(first.expired,0);assert.equal(first.redacted,0);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op)).state,'APPROVED');assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_event')).n,0);
    await f.store.run('UPDATE mcp_v2_approval SET approver_id=? WHERE operation_id=?',f.context.accountId,op);
    assert.equal((await maintainOperations(f.store,{enabled:true,tenantGuard:guard(f),tenantId:f.context.tenantId})).expired,1);
  });
