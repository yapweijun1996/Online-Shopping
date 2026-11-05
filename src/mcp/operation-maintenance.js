import { expireOperations } from './operation-expiry.js';
import { stamp } from './credentials.js';

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

// One bounded pass. Call outside any transaction and repeat on a trusted
// maintenance schedule while v2 is enabled. Each phase commits independently;
// interruption or rollback leaves retryable work. No proposal/result text is
// read into audit or returned. At most 100 rows are mutated per transaction.
export async function maintainOperations(store, { enabled = false, tenantGuard, tenantId } = {}) {
  if (enabled !== true) return { expired: 0, redacted: 0, challenges: 0, approvals: 0, receipts: 0, events: 0 };
  if (!tenantGuard || typeof tenantGuard.withActiveTenant !== 'function' || typeof tenantId !== 'string' || !tenantId) {
    throw new TypeError('Operation maintenance requires a trusted tenant fence.');
  }
  const now = stamp(), cutoff = new Date(Date.parse(now) - OPERATION_AUDIT_RETENTION_MS).toISOString();
  const counts = { expired: 0, redacted: 0, challenges: 0, approvals: 0, receipts: 0, events: 0 };
  const phase = async (work) => {
    await tenantGuard.withActiveTenant(tenantId, (tenant) => {
      if (!tenant || !Number.isSafeInteger(tenant.revision) || tenant.revision < 0) throw new TypeError('Invalid tenant fence.');
      return store.transaction(work);
    });
    await new Promise((resolve) => setImmediate(resolve));
  };
  // Three writes per expired approved row: approval, state and event.
  counts.expired = (await expireOperations({ store, tenantGuard, tenantId, limit: 33 })).expired;
  await new Promise((resolve) => setImmediate(resolve));
  await phase(async () => {
    const rows = await store.all(`UPDATE mcp_v2_operation SET envelope_json = NULL, redacted_at = ?,
      result_json = CASE WHEN state = 'COMMITTED' THEN result_json ELSE NULL END
      WHERE id IN (SELECT id FROM mcp_v2_operation WHERE tenant_id = ? AND state IN (${terminalSql}) AND redacted_at IS NULL
        AND expires_at <= ? ORDER BY expires_at, id LIMIT 100) RETURNING id`, now, tenantId, now);
    counts.redacted = rows.length;
  });
  await phase(async () => {
    const rows = await store.all(`DELETE FROM mcp_v2_approval_challenge WHERE id IN (
      SELECT c.id FROM mcp_v2_approval_challenge c JOIN mcp_v2_operation o ON o.id = c.operation_id
      WHERE o.tenant_id = ? AND (c.expires_at <= ? OR o.redacted_at IS NOT NULL) ORDER BY c.expires_at, c.id LIMIT 100) RETURNING id`, tenantId, now);
    counts.challenges = rows.length;
  });
  await phase(async () => {
    const rows = await store.all(`DELETE FROM mcp_v2_approval WHERE operation_id IN (
      SELECT a.operation_id FROM mcp_v2_approval a JOIN mcp_v2_operation o ON o.id = a.operation_id
      WHERE o.tenant_id = ? AND o.redacted_at IS NOT NULL ORDER BY a.expires_at, a.operation_id LIMIT 100) RETURNING operation_id`, tenantId);
    counts.approvals = rows.length;
  });
  await phase(async () => {
    const rows = await store.all(`DELETE FROM mcp_v2_operation WHERE id IN (
      SELECT o.id FROM mcp_v2_operation o WHERE o.tenant_id = ? AND o.redacted_at IS NOT NULL AND o.receipt_expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM mcp_v2_approval a WHERE a.operation_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM mcp_v2_approval_challenge c WHERE c.operation_id = o.id)
      ORDER BY o.receipt_expires_at, o.id LIMIT 100) RETURNING id`, tenantId, now);
    counts.receipts = rows.length;
  });
  await phase(async () => {
    const rows = await store.all(`DELETE FROM mcp_v2_event WHERE id IN (
      SELECT id FROM mcp_v2_event WHERE tenant_id = ? AND at < ? ORDER BY at, id LIMIT 100) RETURNING id`, tenantId, cutoff);
    counts.events = rows.length;
  });
  return counts;
}
