import { expireOperations } from './operation-expiry.js';
import { stamp } from './credentials.js';
import { cleanupMcpAudit } from './audit.js';

export const OPERATION_AUDIT_RETENTION_MS = 90 * 86400000;
export const OPERATION_TERMINAL_STATES = Object.freeze(['COMMITTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'CONFLICT', 'FAILED']);
const terminalSql = "'COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED'";
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const operationInstant = (value) => typeof value === 'string' && instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// Only the trusted grant's absolute expiry establishes the receipt horizon.
export function operationReceiptExpiry(grantExpiry) {
  if (!operationInstant(grantExpiry)) throw new TypeError('Invalid operation grant expiry.');
  return new Date(Date.parse(grantExpiry) + OPERATION_AUDIT_RETENTION_MS).toISOString();
}

// Source metadata and erased text count toward the same1MiB/100mutation cap.
// A single malformed oversized row stays visible for operator repair; never
// delete a prefix of its data or let one row exceed a cleanup transaction.
function boundedRows(rows) {
  const selected=[];let bytes=0;
  for(const row of rows){const size=Buffer.byteLength(JSON.stringify(row))+64;if(selected.length===100||bytes+size>1048576)break;selected.push(row);bytes+=size;}
  return selected;
}

export async function maintainOperations(store, { enabled = false, tenantGuard, tenantId } = {}) {
  const counts = { expired: 0, redacted: 0, challenges: 0, approvals: 0, receipts: 0, events: 0, audits: 0 };
  if (enabled !== true) return counts;
  if (!tenantGuard || typeof tenantGuard.withActiveTenant !== 'function' || typeof tenantId !== 'string' || !tenantId) {
    throw new TypeError('Operation maintenance requires a trusted tenant fence.');
  }
  const now=stamp(),cutoff=new Date(Date.parse(now)-OPERATION_AUDIT_RETENTION_MS).toISOString();
  const phase=async work=>{
    await tenantGuard.withActiveTenant(tenantId,tenant=>{
      if(!tenant||!Number.isSafeInteger(tenant.revision)||tenant.revision<0)throw new TypeError('Invalid tenant fence.');
      return store.transaction(work);
    });
    await new Promise(resolve=>setImmediate(resolve));
  };
  counts.expired=(await expireOperations({store,tenantGuard,tenantId,limit:33})).expired;
  // Media proof is drained only for terminal operations, after the33-row expiry
  // batch. Approved backlog outside that batch retains every bound proof row.
  const {maintainMedia}=await import('./media-maintenance.js');
  await maintainMedia(store,{enabled:true,tenantGuard,tenantId});
  await phase(async()=>{
    const rows=boundedRows(await store.all(`SELECT * FROM mcp_v2_operation WHERE tenant_id=? AND state IN (${terminalSql}) AND redacted_at IS NULL AND expires_at<=? ORDER BY expires_at,id LIMIT 100`,tenantId,now));
    for(const row of rows)await store.run("UPDATE mcp_v2_operation SET envelope_json=NULL,redacted_at=?,result_json=CASE WHEN state='COMMITTED' THEN result_json ELSE NULL END WHERE id=?",now,row.id);
    counts.redacted=rows.length;
  });
  const erase=async(table,key,query,args,count)=>phase(async()=>{
    const rows=boundedRows(await store.all(query,...args));
    for(const row of rows)await store.run(`DELETE FROM ${table} WHERE ${key}=?`,row[key]);
    counts[count]=rows.length;
  });
  await erase('mcp_v2_approval_challenge','id',`SELECT c.* FROM mcp_v2_approval_challenge c JOIN mcp_v2_operation o ON o.id=c.operation_id
    WHERE o.tenant_id=? AND (c.expires_at<=? OR o.redacted_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_delivery d WHERE d.challenge_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_approval_evidence e WHERE e.challenge_id=c.id)
    ORDER BY c.expires_at,c.id LIMIT 100`,[tenantId,now],'challenges');
  await erase('mcp_v2_approval','operation_id',`SELECT a.* FROM mcp_v2_approval a JOIN mcp_v2_operation o ON o.id=a.operation_id
    WHERE o.tenant_id=? AND o.redacted_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_approval_evidence e WHERE e.operation_id=a.operation_id)
    ORDER BY a.expires_at,a.operation_id LIMIT 100`,[tenantId],'approvals');
  await erase('mcp_v2_operation','id',`SELECT o.* FROM mcp_v2_operation o WHERE o.tenant_id=? AND o.redacted_at IS NOT NULL AND o.receipt_expires_at<=?
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_approval a WHERE a.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_approval_challenge c WHERE c.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_operation_media_policy p WHERE p.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_pin p WHERE p.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_manifest_page p WHERE p.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_asset_ref a WHERE a.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_delivery d WHERE d.operation_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM mcp_v2_media_approval_evidence e WHERE e.operation_id=o.id)
    ORDER BY o.receipt_expires_at,o.id LIMIT 100`,[tenantId,now],'receipts');
  await erase('mcp_v2_event','id','SELECT * FROM mcp_v2_event WHERE tenant_id=? AND at<? ORDER BY at,id LIMIT 100',[tenantId,cutoff],'events');
  await phase(async()=>{ counts.audits=(await cleanupMcpAudit(store,{tenantId,now})).deleted; });
  return counts;
}
