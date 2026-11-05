import { randomUUID } from 'node:crypto';
import { MEDIA_LIMITS } from './media-schema.js';
import { MEDIA_STAGE_COLUMNS, checkMediaStage } from './media-storage.js';
const terminalSql="'COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED'";
const stageTerminal="'CONSUMED','FAILED','EXPIRED','CANCELLED'";
const cutoffMs=90*86400000;
const cost=row=>Buffer.byteLength(JSON.stringify(row));
function budget(){let rows=0,bytes=0;return{take(row,payload=0,count=1){const size=cost(row)+payload;if(rows+count>MEDIA_LIMITS.cleanupRows||bytes+size>MEDIA_LIMITS.cleanupBytes)return false;rows+=count;bytes+=size;return true;},get rows(){return rows;},get bytes(){return bytes;}};}
const inconsistent=()=>{throw new Error('Media cleanup integrity mismatch.');};
const clearCanonical="canonical_data=NULL,canonical_sha256=NULL,canonical_bytes=NULL,canonical_mime=NULL,width=NULL,height=NULL,thumbnail_data=NULL,thumbnail_sha256=NULL,thumbnail_bytes=NULL";

// Hygiene only: caller supplies an already bound store and trusted lifecycle
// fence (the CLI may inject its private ACTIVE/SUSPENDED cleanup-only fence).
// Never decodes, reconstructs authority, resolves a tenant, or renews a lease.
export async function maintainMedia(store,{enabled=false,tenantGuard,tenantId,now:givenNow}={}){
  const counts={rows:0,bytes:0,passes:[],chunks:0,stages:0,released:0,metadata:0,events:0};
  if(enabled!==true)return counts;
  if(!tenantGuard||typeof tenantGuard.withActiveTenant!=='function'||typeof tenantId!=='string'||!tenantId)throw new TypeError('Media cleanup requires a trusted tenant fence.');
  const phase=async work=>{
    await tenantGuard.withActiveTenant(tenantId,tenant=>{
      if(!tenant||!Number.isSafeInteger(tenant.revision)||tenant.revision<0)throw new TypeError('Invalid cleanup fence.');
      return store.transaction(async()=>{
        const now=givenNow??new Date().toISOString();if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)||new Date(now).toISOString()!==now)throw new TypeError('Invalid media cleanup time.');
        const b=budget();await work(b,now);counts.rows+=b.rows;counts.bytes+=b.bytes;counts.passes.push({rows:b.rows,bytes:b.bytes});
      });
    });
    await new Promise(resolve=>setImmediate(resolve));
  };
  const erase=async(table,key,query)=>phase(async(b,now)=>{
    const rows=await store.all(query,tenantId,now);
    for(const row of rows){if(!b.take(row))break;await store.run(`DELETE FROM ${table} WHERE ${key.map(column=>`${column}=?`).join(' AND ')}`,...key.map(column=>row[column]));counts.metadata++;}
  });
  // Only terminal parents past their ORIGINAL proposal deadline are candidates.
  // Approved backlog left outside expireOperations'33 row batch is untouched.
  const past="o.tenant_id=? AND o.state IN ("+terminalSql+") AND o.expires_at<=?";
  await erase('mcp_v2_media_delivery',['challenge_id','kind','item_key'],`SELECT d.* FROM mcp_v2_media_delivery d JOIN mcp_v2_operation o ON o.id=d.operation_id WHERE ${past} ORDER BY d.expires_at,d.challenge_id,d.kind,d.item_key LIMIT 100`);
  await erase('mcp_v2_media_approval_evidence',['operation_id'],`SELECT e.* FROM mcp_v2_media_approval_evidence e JOIN mcp_v2_operation o ON o.id=e.operation_id WHERE ${past} AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_delivery d WHERE d.challenge_id=e.challenge_id) ORDER BY e.expires_at,e.operation_id LIMIT 100`);
  await erase('mcp_v2_media_asset_ref',['operation_id','asset_key'],`SELECT a.* FROM mcp_v2_media_asset_ref a JOIN mcp_v2_operation o ON o.id=a.operation_id WHERE ${past} AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_delivery d WHERE d.operation_id=a.operation_id AND d.asset_key=a.asset_key) ORDER BY a.operation_id,a.asset_key LIMIT 100`);
  await erase('mcp_v2_media_manifest_page',['operation_id','page_index'],`SELECT p.* FROM mcp_v2_media_manifest_page p JOIN mcp_v2_operation o ON o.id=p.operation_id WHERE ${past} AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_delivery d WHERE d.operation_id=p.operation_id AND d.page_index=p.page_index) ORDER BY p.operation_id,p.page_index LIMIT 100`);
  await erase('mcp_v2_media_pin',['stage_id'],`SELECT p.* FROM mcp_v2_media_pin p JOIN mcp_v2_operation o ON o.id=p.operation_id WHERE ${past} AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_asset_ref a WHERE a.stage_id=p.stage_id AND a.operation_id=p.operation_id) ORDER BY p.expires_at,p.stage_id LIMIT 100`);
  await phase(async(b,now)=>{
    const row=await store.get(`SELECT ${MEDIA_STAGE_COLUMNS} FROM mcp_v2_media_stage s WHERE s.tenant_id=? AND s.reserved_bytes>0 AND
      (s.state IN (${stageTerminal}) OR (s.state IN ('UPLOADING','VALIDATING') AND s.upload_expires_at<=?) OR
      (s.state='BOUND' AND s.bound_expires_at<=? AND NOT EXISTS(SELECT 1 FROM mcp_v2_operation o WHERE o.id=s.operation_id AND o.state NOT IN (${terminalSql}))))
      ORDER BY s.absolute_expires_at,s.id LIMIT 1`,tenantId,now,now);
    if(!row)return;checkMediaStage(row);
    const stageRows=await store.all('SELECT reserved_bytes,quota_owner_key FROM mcp_v2_media_stage WHERE tenant_id=? AND reserved_bytes>0 LIMIT 25',tenantId);
    if(stageRows.length>MEDIA_LIMITS.tenantSlots)inconsistent();
    const quotaRows=[];
    for(const[kind,key]of[['TENANT','tenant'],['CLIENT',row.quota_owner_key]]){
      const q=await store.get('SELECT * FROM mcp_v2_media_quota WHERE tenant_id=? AND kind=? AND owner_key=?',tenantId,kind,key);
      const children=kind==='TENANT'?stageRows:stageRows.filter(stage=>stage.quota_owner_key===key);
      if(!q||q.reserved_bytes!==children.reduce((sum,stage)=>sum+stage.reserved_bytes,0)||q.active_slots!==children.length)inconsistent();quotaRows.push(q);
    }
    const kind=row.state==='CONSUMED'?'CONSUME':row.state==='FAILED'?'FAIL':row.state==='CANCELLED'?'CANCEL':'EXPIRE';
    const audit={id:randomUUID(),at:now,tenant_id:row.tenant_id,account_id:row.account_id,client_id:row.client_id,grant_id:row.grant_id,
      stage_id:row.id,correlation_id:row.correlation_id,event:kind,outcome:'GARBAGE_STEP',byte_count:0,tool_name:null,operation_id:row.operation_id};
    // Reserve all possible stage/quota/audit mutations BEFORE deleting any byte.
    // Overcounting a reserved but unnecessary write is safe and observable.
    const next={...row,state:row.state==='BOUND'||row.state==='UPLOADING'||row.state==='VALIDATING'?'EXPIRED':row.state,terminal_at:row.terminal_at??now};
    const final={...next,reserved_bytes:0,scrubbed_at:now,version:row.version+2,lease_hash:null,lease_until:null,canonical_sha256:null,canonical_bytes:null,canonical_mime:null,width:null,height:null,thumbnail_sha256:null,thumbnail_bytes:null};
    if(!b.take(row,(row.canonical_bytes??0)+(row.thumbnail_bytes??0))||!b.take(final)||!b.take(audit)||!quotaRows.every(q=>b.take(q)))inconsistent();
    let changed=false;
    if(!['CONSUMED','FAILED','EXPIRED','CANCELLED'].includes(row.state)){
      await store.run(`UPDATE mcp_v2_media_stage SET state='EXPIRED',version=version+1,lease_hash=NULL,lease_until=NULL,${clearCanonical},terminal_at=? WHERE id=? AND version=?`,now,row.id,row.version);changed=true;
    }
    const chunks=await store.all('SELECT stage_id,"offset",byte_length,sha256 FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset" LIMIT 16',row.id);
    if(chunks.length>MEDIA_LIMITS.chunks)inconsistent();
    for(const chunk of chunks){if(!b.take(chunk,chunk.byte_length))break;await store.run('DELETE FROM mcp_v2_media_chunk WHERE stage_id=? AND "offset"=?',row.id,chunk.offset);counts.chunks++;changed=true;}
    const remaining=await store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk WHERE stage_id=?',row.id);
    if(remaining.n===0){
      audit.outcome='SCRUBBED';
      for(const q of quotaRows){if(!await store.get('UPDATE mcp_v2_media_quota SET reserved_bytes=reserved_bytes-?,active_slots=active_slots-1 WHERE tenant_id=? AND kind=? AND owner_key=? AND reserved_bytes=? AND active_slots=? RETURNING owner_key',row.reserved_bytes,q.tenant_id,q.kind,q.owner_key,q.reserved_bytes,q.active_slots))inconsistent();}
      await store.run('UPDATE mcp_v2_media_stage SET reserved_bytes=0,scrubbed_at=?,version=version+1 WHERE id=?',now,row.id);counts.released++;changed=true;
    }
    if(changed){
      await store.run(`INSERT INTO mcp_v2_media_event(id,at,tenant_id,account_id,client_id,grant_id,stage_id,correlation_id,event,outcome,byte_count,tool_name,operation_id)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,...Object.values(audit));counts.stages++;
    }
  });
  await erase('mcp_v2_operation_media_policy',['operation_id'],`SELECT p.* FROM mcp_v2_operation_media_policy p JOIN mcp_v2_operation o ON o.id=p.operation_id WHERE o.tenant_id=? AND o.receipt_expires_at<=? AND o.state IN (${terminalSql})
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_pin s WHERE s.operation_id=o.id) AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_asset_ref a WHERE a.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_manifest_page m WHERE m.operation_id=o.id) AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_delivery d WHERE d.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_approval_evidence e WHERE e.operation_id=o.id) ORDER BY o.receipt_expires_at,o.id LIMIT 100`);
  await phase(async(b,now)=>{
    const rows=await store.all(`SELECT ${MEDIA_STAGE_COLUMNS} FROM mcp_v2_media_stage s WHERE tenant_id=? AND reserved_bytes=0 AND receipt_expires_at<=? AND state IN (${stageTerminal})
      AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_pin p WHERE p.stage_id=s.id) AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_chunk c WHERE c.stage_id=s.id) ORDER BY receipt_expires_at,id LIMIT 100`,tenantId,now);
    for(const row of rows){if(!b.take(row))break;await store.run('DELETE FROM mcp_v2_media_stage WHERE id=?',row.id);counts.metadata++;}
  });
  await phase(async(b)=>{
    const rows=await store.all(`SELECT q.* FROM mcp_v2_media_quota q WHERE q.tenant_id=? AND q.reserved_bytes=0 AND q.active_slots=0
      AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_stage s WHERE s.tenant_id=q.tenant_id AND s.reserved_bytes>0 AND (q.kind='TENANT' OR s.quota_owner_key=q.owner_key))
      ORDER BY q.kind,q.owner_key LIMIT 100`,tenantId);
    for(const row of rows){if(!b.take(row))break;await store.run('DELETE FROM mcp_v2_media_quota WHERE tenant_id=? AND kind=? AND owner_key=? AND reserved_bytes=0 AND active_slots=0',row.tenant_id,row.kind,row.owner_key);counts.metadata++;}
  });
  await phase(async(b,now)=>{
    const rows=await store.all('SELECT * FROM mcp_v2_media_event WHERE tenant_id=? AND at<? ORDER BY at,id LIMIT 100',tenantId,new Date(Date.parse(now)-cutoffMs).toISOString());
    for(const row of rows){if(!b.take(row))break;await store.run('DELETE FROM mcp_v2_media_event WHERE id=?',row.id);counts.events++;}
  });
  return counts;
}

// Future first-party challenge refresh must call this INSIDE its authenticated
// writer transaction before deleting the old challenge. It provides no auth.
export async function clearMediaChallenge(store,operationId,challengeId){
  return store.transaction(async()=>{
  const challenge=await store.get('SELECT operation_id,consumed_at FROM mcp_v2_approval_challenge WHERE id=?',challengeId);
  if(!challenge||challenge.operation_id!==operationId||challenge.consumed_at!==null||await store.get('SELECT operation_id FROM mcp_v2_media_approval_evidence WHERE challenge_id=?',challengeId))throw new Error('Media challenge cannot be refreshed.');
  const rows=await store.all('SELECT * FROM mcp_v2_media_delivery WHERE challenge_id=? ORDER BY kind,item_key LIMIT 59',challengeId);
  if(rows.length>58||rows.reduce((sum,row)=>sum+cost(row),0)>MEDIA_LIMITS.cleanupBytes)throw new Error('Media challenge exceeds refresh budget.');
  for(const row of rows)await store.run('DELETE FROM mcp_v2_media_delivery WHERE challenge_id=? AND kind=? AND item_key=?',challengeId,row.kind,row.item_key);
  return rows.length;
  });
}
