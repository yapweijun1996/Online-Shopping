import { randomUUID } from 'node:crypto';
import { stamp } from './credentials.js';

// Isolated prototype only: callers must hold the platform tenant fence before
// the tenant-store transaction. This marks expired operations but deliberately
// does not delete proposals or idempotency evidence. Retention is unresolved.
export async function expireOperations({ store, tenantGuard, tenantId, limit = 50 }) {
  if (!store || typeof store.transaction !== 'function' || !tenantGuard ||
      typeof tenantGuard.withActiveTenant !== 'function' || typeof tenantId !== 'string' || !tenantId ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('A trusted tenant guard and bounded expiry batch are required.');
  }
  return tenantGuard.withActiveTenant(tenantId, (tenant) => {
    if (!tenant || !Number.isSafeInteger(tenant.revision) || tenant.revision < 0) {
      throw new TypeError('Invalid tenant fence.');
    }
    return store.transaction(async () => {
      const now = stamp();
      const rows = await store.all(`SELECT o.* FROM mcp_v2_operation o
        LEFT JOIN mcp_v2_approval a ON a.operation_id = o.id
        WHERE o.tenant_id = ? AND o.state IN ('PREPARED','PENDING_APPROVAL','APPROVED')
          AND (o.expires_at <= ? OR (o.state = 'APPROVED' AND a.expires_at <= ?))
        ORDER BY o.expires_at, o.id LIMIT ?`, tenantId, now, now, limit);
      for (const row of rows) {
        let approverId = null;
        if (row.state === 'APPROVED') {
          const approval = await store.get(`UPDATE mcp_v2_approval SET consumed_at = ?
            WHERE operation_id = ? AND decision = 'APPROVED' AND consumed_at IS NULL
            RETURNING approver_id`, now, row.id);
          if (!approval) throw new Error('Expired operation has invalid approval state.');
          approverId = approval.approver_id;
        }
        const changed = await store.get(`UPDATE mcp_v2_operation SET state = 'EXPIRED'
          WHERE id = ? AND tenant_id = ? AND state = ? RETURNING id`, row.id, tenantId, row.state);
        if (!changed) throw new Error('Expired operation changed concurrently.');
        await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, account_id, client_id, grant_id, tool_name,
          resource_id, operation_id, approver_id, event, outcome, correlation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPIRE', 'EXPIRED', ?)`,
        randomUUID(), now, row.tenant_id, row.account_id, row.client_id, row.grant_id, row.tool_name,
        null, row.id, approverId, row.correlation_id);
      }
      return { expired: rows.length };
    });
  });
}
