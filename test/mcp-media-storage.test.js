import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
import { readMediaPolicy } from '../src/mcp/media-storage.js';
for(const dialect of ['sqlite','postgres']){
  const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
  test(`${dialect}: media begin is duplicate-safe, immutable and reserves exact bounded shared quotas`,options,async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.from('synthetic image'),args=f.input(bytes),stage=await f.writer(w=>w.begin(args));
    assert.equal((await f.writer(w=>w.begin(args))).stageId,stage.stageId);
    await assert.rejects(f.writer(w=>w.begin({...args,targetSlot:'GALLERY'})),{status:409});
    await assert.rejects(f.writer(w=>w.get(stage.stageId),f.now,{...f.context,tenantId:'other'}),{status:409});
    const q=await f.store.all('SELECT reserved_bytes,active_slots FROM mcp_v2_media_quota');assert.equal(q.length,2);assert.ok(q.every(row=>row.reserved_bytes===bytes.length+606208&&row.active_slots===1));
    const raced=await Promise.allSettled(Array.from({length:12},(_,n)=>f.writer(w=>w.begin(f.input(bytes,'synthetic-quota-race-'+n)))));
    assert.equal(raced.filter(row=>row.status==='fulfilled').length,11);assert.equal(raced.filter(row=>row.status==='rejected'&&row.reason.status===429).length,1);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,12);
    const row=await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId);assert.equal(row.receipt_expires_at,new Date(Date.parse(f.context.grantExpiresAt)+90*86400000).toISOString());
    assert.ok(row.correlation_id);assert.equal(row.operation_id,null);
    await f.store.run('UPDATE mcp_v2_media_quota SET reserved_bytes=reserved_bytes-1 WHERE kind=?','TENANT');
    await assert.rejects(f.writer(w=>w.begin(f.input(bytes,'synthetic-corrupt-quota'))),{code:'MEDIA_INTEGRITY'});
  });
  test(`${dialect}: append hashes actual bytes, rejects conflicting/out-of-order replay and rollback preserves offsets`,options,async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.alloc(50000,7),stage=await f.writer(w=>w.begin(f.input(bytes)));
    await assert.rejects(f.writer(w=>w.append(stage.stageId,1,bytes.subarray(0,100))),{status:409});
    const part=bytes.subarray(0,36864);await f.writer(w=>w.append(stage.stageId,0,part));
    assert.equal((await f.writer(w=>w.append(stage.stageId,0,part))).replayed,true);
    await assert.rejects(f.writer(w=>w.append(stage.stageId,0,Buffer.alloc(36864,8))),{status:409});
    await assert.rejects(f.writer(async w=>{await w.append(stage.stageId,36864,bytes.subarray(36864));throw new Error('Synthetic append rollback');}),/Synthetic append rollback/);
    assert.equal((await f.writer(w=>w.get(stage.stageId))).nextOffset,36864);
    await assert.rejects(f.writer(w=>w.claimValidation(stage.stageId)),{status:409});
    await f.writer(w=>w.append(stage.stageId,36864,bytes.subarray(36864)));
    const lease=await f.writer(w=>w.claimValidation(stage.stageId));assert.deepEqual(lease.source,bytes);
    assert.equal(Date.parse(lease.leaseUntil)-Date.parse(f.now),45000);
    await assert.rejects(f.writer(w=>w.append(stage.stageId,0,part)),{status:409});
    await assert.rejects(f.writer(w=>w.claimValidation(stage.stageId)),{status:409});
    const later=new Date(Date.parse(f.now)+46000).toISOString(),second=await f.writer(w=>w.claimValidation(stage.stageId),later);
    assert.ok(second.version>lease.version);await f.writer(w=>w.failValidation(stage.stageId,second.leaseToken,second.version),later);
    await assert.rejects(f.writer(w=>w.claimValidation(stage.stageId),later),{status:409});
    await assert.rejects(f.store.run("UPDATE mcp_v2_media_stage SET lease_until=? WHERE id=?",later,stage.stageId));
  });
  test(`${dialect}: lease-bound canonical pin is single-use and consume clears payload without releasing chunk quota`,options,async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.alloc(100,3),{stage,lease}=await f.upload(bytes),op=await f.operation(lease.codecDigest,f.now,lease.correlationId);
    const result={image:Buffer.alloc(200,4),thumbnail:Buffer.alloc(50,5),sourceSha256:lease.sourceSha256,mime:'image/png',width:10,height:10,codecDigest:lease.codecDigest};
    await assert.rejects(f.writer(w=>w.bind(stage.stageId,'A'.repeat(43),lease.version,result,op)),{status:409});
    const both=await Promise.allSettled([0,1].map(()=>f.writer(w=>w.bind(stage.stageId,lease.leaseToken,lease.version,result,op))));
    assert.equal(both.filter(row=>row.status==='fulfilled').length,1);assert.equal(both.filter(row=>row.status==='rejected'&&row.reason.status===409).length,1);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n,1);
    const loaded=await f.writer(w=>w.boundBytes(stage.stageId,op));assert.deepEqual(loaded.image,result.image);assert.deepEqual(loaded.thumbnail,result.thumbnail);
    await assert.rejects(f.store.run('DELETE FROM mcp_v2_operation WHERE id=?',op));
    await assert.rejects(f.store.run('DELETE FROM mcp_v2_media_stage WHERE id=?',stage.stageId));
    const policy=await readMediaPolicy(f.store,f.context,op);assert.equal(policy.required_scopes,'media.write');
    await assert.rejects(f.writer(w=>w.consume(stage.stageId,op)),{status:409});
    await f.store.run("UPDATE mcp_v2_operation SET state='APPROVED' WHERE id=?",op);
    await f.writer(w=>w.consume(stage.stageId,op));
    const row=await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId);
    assert.equal(row.canonical_data,null);assert.equal(row.thumbnail_data,null);assert.equal(row.operation_id,op);assert.equal(row.reserved_bytes,bytes.length+606208);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk')).n,1);
    assert.equal((await f.writer(w=>w.get(stage.stageId))).state,'CONSUMED');
    await assert.rejects(f.writer(w=>w.consume(stage.stageId,op)),{status:409});
    let escaped;await f.writer(w=>{escaped=w;});await assert.rejects(escaped.get(stage.stageId),TypeError);
  });
}

for(const dialect of ['sqlite','postgres'])test(`${dialect}: stale lease, source mismatch, malformed states and audit failure cannot pin or consume bytes`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.alloc(400,9),{stage,lease}=await f.upload(bytes),later=new Date(Date.parse(f.now)+46000).toISOString();
    const replacement=await f.writer(w=>w.claimValidation(stage.stageId),later),op=await f.operation(lease.codecDigest,later,lease.correlationId);
    const result={sourceSha256:lease.sourceSha256,image:Buffer.alloc(300,7),thumbnail:Buffer.alloc(50,8),mime:'image/png',width:20,height:10,codecDigest:lease.codecDigest};
    await assert.rejects(f.writer(w=>w.bind(stage.stageId,lease.leaseToken,lease.version,result,op),later),{status:409});
    await assert.rejects(f.writer(w=>w.bind(stage.stageId,replacement.leaseToken,replacement.version,{...result,sourceSha256:'0'.repeat(64)},op),later),{status:400});
    await f.writer(w=>w.bind(stage.stageId,replacement.leaseToken,replacement.version,result,op),later);
    for(const [column,value]of[['canonical_mime','image/jpeg'],['canonical_bytes',301],['width',8193],['reserved_bytes',0],['state','UPLOADING'],['lease_hash','a'.repeat(64)]])await assert.rejects(f.store.run(`UPDATE mcp_v2_media_stage SET ${column}=? WHERE id=?`,value,stage.stageId));
    await f.store.run("UPDATE mcp_v2_operation SET state='APPROVED' WHERE id=?",op);
    const oldRun=f.store.run;
    f.store.run=(sql,...values)=>{if(sql.startsWith('INSERT INTO mcp_v2_media_event')&&values.includes('CONSUME'))throw new Error('Synthetic consume audit failure');return oldRun(sql,...values);};
    await assert.rejects(f.writer(w=>w.consume(stage.stageId,op),later),/Synthetic consume audit failure/);f.store.run=oldRun;
    const row=await f.store.get('SELECT state,canonical_data,thumbnail_data FROM mcp_v2_media_stage WHERE id=?',stage.stageId);assert.equal(row.state,'BOUND');assert.deepEqual(Buffer.from(row.canonical_data),result.image);assert.deepEqual(Buffer.from(row.thumbnail_data),result.thumbnail);
    const short=f.input(Buffer.from('short'),'synthetic-clipped-lease');const clipped=await f.writer(w=>w.begin(short));await f.writer(w=>w.append(clipped.stageId,0,Buffer.from('short')));
    const below=new Date(Date.parse(f.now)+MEDIA_LIMITS.uploadMs-4999).toISOString();await assert.rejects(f.writer(w=>w.claimValidation(clipped.stageId),below),{status:409});
    const exact=new Date(Date.parse(f.now)+MEDIA_LIMITS.uploadMs-5000).toISOString(),last=await f.writer(w=>w.claimValidation(clipped.stageId),exact);
    assert.equal(last.leaseUntil,clipped.uploadExpiresAt);assert.equal(last.absoluteExpiresAt,clipped.absoluteExpiresAt);
  });

for(const dialect of ['sqlite','postgres'])test(`${dialect}: tenant quota coordinates distinct clients and failed begin audit rolls back both counters`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.from('quota'),oldRun=f.store.run;
    f.store.run=(sql,...values)=>{if(sql.startsWith('INSERT INTO mcp_v2_media_event'))throw new Error('Synthetic begin audit failure');return oldRun(sql,...values);};
    await assert.rejects(f.writer(w=>w.begin(f.input(bytes))),/Synthetic begin audit failure/);f.store.run=oldRun;
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_quota')).n,0);
    const identities=[f.context,{...f.context,clientId:randomUUID(),grantId:randomUUID()}];
    for(let k=0;k<2;k++)for(let n=0;n<12;n++)await f.writer(w=>w.begin(f.input(bytes,`synthetic-client-${k}-upload-${n}`)),f.now,identities[k]);
    assert.equal((await f.store.get("SELECT active_slots FROM mcp_v2_media_quota WHERE kind='TENANT'")).active_slots,24);
    const third={...f.context,clientId:randomUUID(),grantId:randomUUID()};await assert.rejects(f.writer(w=>w.begin(f.input(bytes,'synthetic-tenant-full')),f.now,third),{status:429});
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,24);
    assert.equal((await f.store.get("SELECT active_slots FROM mcp_v2_media_quota WHERE kind='TENANT'")).active_slots,24);
  });
