import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { recordAudit } from './platform-db.js';

const denied = () => new ApiError(409, 'STATE_CONFLICT', 'The shop changed. Refresh and try again.');
export async function lockQrPolicy(platform) {
  if (await platform.schemaVersion() < 3) return false;
  await platform.get('SELECT revision FROM tenant_qr_capacity WHERE id = 1 FOR UPDATE');
  return true;
}
// Called inside the lifecycle transaction; does not require a reachable shop DB.
export async function disableQrBinding(platform, tenantId, actor, stamp) {
  if (!await lockQrPolicy(platform)) return;
  const binding = await platform.get('SELECT * FROM tenant_qr_binding WHERE tenant_id = ? FOR UPDATE', tenantId);
  if (!binding) return;
  await platform.run('UPDATE tenant_qr_binding SET enabled = false, cleanup_pending = true, epoch = epoch + 1, revision = revision + 1, updated_at = ?, updated_by = ? WHERE tenant_id = ? AND revision = ?', stamp, actor, tenantId, binding.revision);
  await recordAudit(platform, { actor, action: 'QR_DISABLE', tenantId });
}

export function createQrPolicy({ platform, tenantSlots = 1, provisionedTenantIds = [], clock = Date.now }) {
  if (!Number.isSafeInteger(tenantSlots) || tenantSlots < 0) throw new Error('Invalid QR tenant slot ceiling.');
  const provisioned = new Set(provisionedTenantIds);
  const stamp = () => new Date(clock()).toISOString();
  const required = async () => { if (!await lockQrPolicy(platform)) throw new ApiError(409, 'QR_SCHEMA_REQUIRED', 'An explicit platform QR upgrade is required.'); };
  return {
    async view(id) {
      if (await platform.schemaVersion() < 3) return null;
      return { binding: await platform.get('SELECT * FROM tenant_qr_binding WHERE tenant_id = ?', id) || null, provisioned: provisioned.has(id), tenantSlots };
    },
    async mutate(id, enabled, input, actor) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || Object.keys(input).some((key) => key !== 'expectedRevision')) throw new FieldError('expectedRevision', 'Send only the current shop revision.');
      return platform.transaction(async () => {
        await required();
        const row = await platform.get('SELECT * FROM tenant WHERE id = ? FOR UPDATE', id);
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
        if (row.revision !== input.expectedRevision) throw denied();
        const binding = await platform.get('SELECT * FROM tenant_qr_binding WHERE tenant_id = ? FOR UPDATE', id);
        if (enabled) {
          if (row.status !== 'ACTIVE' || binding?.cleanup_pending) throw denied();
          if (row.is_default !== 1 && !provisioned.has(id)) throw new ApiError(409, 'QR_WORKER_NOT_PROVISIONED', 'Ask the host operator to provision a dedicated worker.');
          let slot = binding?.slot_id;
          if (slot === undefined) {
            if (row.is_default === 1) slot = 0;
            else {
              const occupied = new Set((await platform.all('SELECT slot_id FROM tenant_qr_binding')).map((item) => item.slot_id));
              for (let candidate = 1; candidate <= tenantSlots; candidate++) if (!occupied.has(candidate)) { slot = candidate; break; }
            }
          }
          if (slot === undefined || (row.is_default !== 1 && (slot === 0 || slot > tenantSlots))) throw new ApiError(409, 'QR_CAPACITY', 'All provisioned QR slots are reserved.');
          if (binding) await platform.run('UPDATE tenant_qr_binding SET enabled = true, epoch = epoch + 1, revision = revision + 1, updated_at = ?, updated_by = ? WHERE tenant_id = ? AND revision = ?', stamp(), actor, id, binding.revision);
          // Tenant revision survives retirement, so a recreated reservation cannot revive an old epoch.
          else await platform.run('INSERT INTO tenant_qr_binding(tenant_id, slot_id, enabled, epoch, updated_at, updated_by) VALUES (?, ?, true, ?, ?, ?)', id, slot, row.revision + 1, stamp(), actor);
          await recordAudit(platform, { actor, action: 'QR_ENABLE', tenantId: id });
        } else await disableQrBinding(platform, id, actor, stamp());
        await platform.run('UPDATE tenant SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', stamp(), id, row.revision);
        await platform.run('UPDATE tenant_qr_capacity SET revision = revision + 1 WHERE id = 1');
        return { revision: row.revision + 1, ...await this.view(id) };
      });
    },
    // Host-only callback: cleanup must fence shop state and confirm the old worker stopped.
    // Failure rolls back platform changes, leaving the durable reservation pending for retry.
    async reconcile(id, epoch, cleanupAndStop) {
      return platform.transaction(async () => {
        await required();
        const binding = await platform.get('SELECT * FROM tenant_qr_binding WHERE tenant_id = ? FOR UPDATE', id);
        if (!binding || binding.enabled || !binding.cleanup_pending || binding.epoch !== epoch) throw denied();
        if (await cleanupAndStop(binding) !== true) throw denied();
        await recordAudit(platform, { actor: 'host', action: 'QR_CLEANUP', tenantId: id });
        await platform.run('DELETE FROM tenant_qr_binding WHERE tenant_id = ? AND epoch = ? AND enabled = false', id, epoch);
        await platform.run('UPDATE tenant_qr_capacity SET revision = revision + 1 WHERE id = 1');
        await recordAudit(platform, { actor: 'host', action: 'QR_BINDING_RETIRED', tenantId: id });
      });
    },
    async withAuthorizedBinding(id, slot, epoch, work) {
      return platform.transaction(async () => {
        await required();
        const row = await platform.get("SELECT t.* FROM tenant t JOIN tenant_qr_binding b ON b.tenant_id = t.id WHERE t.id = ? AND t.status = 'ACTIVE' AND b.enabled = true AND b.cleanup_pending = false AND b.slot_id = ? AND b.epoch = ? FOR UPDATE OF b", id, slot, epoch);
        if (!row || (row.is_default !== 1 && (!provisioned.has(id) || slot < 1 || slot > tenantSlots))) throw new ApiError(403, 'QR_REVOKED', 'QR access has been revoked.');
        return work(row);
      });
    },
  };
}
