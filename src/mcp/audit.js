import { randomUUID } from 'node:crypto';
import { OPERATION_SCOPE_POLICIES, OPERATION_MUTATION_PAIRS } from './operation-policy.js';
import { mediaPolicyForTool } from './media-policy.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MCP_AUDIT_OUTCOMES = Object.freeze(['OK','PENDING_APPROVAL','PREPARED','APPROVED','COMMITTED','REPLAY','REJECTED','CANCELLED','EXPIRED','STALE_REVISION','CONFLICT','FAILED',
  'STAGE_BEGIN','STAGE_APPEND','STAGE_DISCARD','STAGE_BEGIN_REPLAY','STAGE_APPEND_REPLAY','STAGE_DISCARD_REPLAY']);
const outcomes = new Set(MCP_AUDIT_OUTCOMES);
const readNames = new Set(['company.get','analytics.sales_trend','analytics.top_products','analytics.inventory_risk','inventory.summary','inventory.movements','media.list','operations.get','operations.audit']);
const invalid = () => { throw new TypeError('Invalid typed MCP audit record.'); };
// Keep both sort keys visible to the optimizer. Equality+MAX can choose a
// global sequence PK reverse scan through unrelated operations on PostgreSQL.
// Equal closed bounds preserve exact operation identity and the composite-key
// endpoint order. No sequence ceiling hides an unsafe BIGINT anchor.
export const OPERATION_AUDIT_ANCHORS_SQL=`SELECT
  COALESCE((SELECT sequence FROM mcp_v2_event WHERE operation_id>=? AND operation_id<=? ORDER BY operation_id DESC,sequence DESC LIMIT 1),0) AS lifecycle,
  COALESCE((SELECT sequence FROM mcp_audit WHERE operation_id>=? AND operation_id<=? ORDER BY operation_id DESC,sequence DESC LIMIT 1),0) AS calls`;
export async function readOperationAuditAnchors(store,operationId) {
  if(!uuid.test(operationId||''))invalid();
  const anchors=await store.get(OPERATION_AUDIT_ANCHORS_SQL,operationId,operationId,operationId,operationId);
  if(![anchors.lifecycle,anchors.calls].every(n=>Number.isSafeInteger(n)&&n>=0))invalid();
  return anchors;
}
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f]/.test(value);
export function mcpAuditResource(toolName, args) {
  if (!Object.hasOwn(OPERATION_SCOPE_POLICIES, toolName)) invalid();
  if (toolName.startsWith('company.')) return '1';
  if (toolName.startsWith('analytics.')) return null;
  if (['catalog.preview_create','catalog.commit_create'].includes(toolName)) return 'catalog';
  if (toolName.startsWith('operations.')) return args.operationId;
  return args.productId ?? args.id ?? args.orderId;
}
function validResource(tool, resource) {
  if (tool.startsWith('company.')) return resource === '1';
  if (tool.startsWith('analytics.')) return resource === null;
  if (['catalog.preview_create','catalog.commit_create'].includes(tool)) return resource === 'catalog';
  return uuid.test(resource || '');
}
// Closed metadata, written inside the same transaction as the returned result.
export async function recordMcpAudit(store, value) {
  const keys = ['tenantId','accountId','clientId','grantId','toolName','resourceId','operationId','correlationId','event','outcome','durationMs','resultCount'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',') || !Object.hasOwn(OPERATION_SCOPE_POLICIES, value.toolName) ||
      !text(value.tenantId,100) || !uuid.test(value.accountId || '') || !text(value.clientId,128) || !uuid.test(value.grantId || '') ||
      !uuid.test(value.correlationId || '') || !(value.operationId === null || uuid.test(value.operationId || '')) ||
      !['READ','CALL'].includes(value.event) || (value.event === 'READ') !== readNames.has(value.toolName) || !outcomes.has(value.outcome) ||
      !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || !Number.isSafeInteger(value.resultCount) || value.resultCount < 0 || value.resultCount > 100 ||
      !validResource(value.toolName,value.resourceId)) invalid();
  await store.run(`INSERT INTO mcp_audit(id,at,tenant_id,account_id,client_id,grant_id,correlation_id,event,tool_name,resource_id,outcome,duration_ms,result_count,operation_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), new Date().toISOString(), value.tenantId, value.accountId, value.clientId, value.grantId,
  value.correlationId, value.event, value.toolName, value.resourceId, value.outcome, value.durationMs, value.resultCount, value.operationId);
}
export function recordOperationCall(store, row, toolName, outcome) {
  let commit = OPERATION_MUTATION_PAIRS[row.tool_name];
  if (!commit) { try { commit = mediaPolicyForTool(row.tool_name).commitTool; } catch { invalid(); } }
  if (![row.tool_name,commit].includes(toolName)) invalid();
  return recordMcpAudit(store, { tenantId: row.tenant_id, accountId: row.account_id, clientId: row.client_id, grantId: row.grant_id,
    toolName, resourceId: row.resource_id, operationId: row.id, correlationId: row.correlation_id, event: 'CALL', outcome,
    durationMs: 0, resultCount: ['EXPIRED','STALE_REVISION','FAILED','CONFLICT'].includes(outcome) ? 0 : 1 });
}

// Call under the existing writer transaction. SQL measures legacy text without
// transferring it to Node; an oversized first row blocks this bounded batch.
export async function cleanupMcpAudit(store, { tenantId, now = new Date().toISOString(), limit = 100 } = {}) {
  if (!text(tenantId,100) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) || new Date(now).toISOString() !== now) invalid();
  const cutoff = new Date(Date.parse(now) - 90 * 86400000).toISOString();
  const fields = ['id','at','tenant_id','account_id','client_id','grant_id','correlation_id','event','tool_name','resource_id','outcome'];
  const length = column => store.dialect === 'postgres' ? `octet_length(COALESCE(${column},''))::BIGINT` : `length(CAST(COALESCE(${column},'') AS BLOB))`;
  const size = `6*(${fields.map(length).join('+')})+1024`;
  const rows = await store.all(`SELECT CASE WHEN ${size}<=1048576 THEN id ELSE NULL END AS id,${size} AS bytes FROM mcp_audit WHERE tenant_id=? AND at<? ORDER BY at,id LIMIT ?`,tenantId,cutoff,limit);
  let bytes=0,deleted=0;
  for (const row of rows) {
    const amount=Number(row.bytes);
    if (row.id === null || !Number.isSafeInteger(amount) || bytes+amount>1048576) break;
    await store.run('DELETE FROM mcp_audit WHERE id=? AND tenant_id=? AND at<?',row.id,tenantId,cutoff);
    bytes+=amount;deleted++;
  }
  return { deleted, bytes, blocked: rows.length>deleted };
}
