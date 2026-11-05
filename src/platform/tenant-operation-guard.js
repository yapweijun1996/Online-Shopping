import { ApiError } from '../http.js';

// Acquire the platform tenant row before entering the
// tenant-store transaction. Suspension/update must use the same platform
// database and respect this lock order. Hold it only across bounded database
// work, never external API calls or user interaction. Single-tenant deployments
// need their own explicit guard.
export function createPlatformTenantOperationGuard(platform, { expectedTenantId, expectedCode } = {}) {
  if (!platform || platform.dialect !== 'postgres' || typeof platform.transaction !== 'function' ||
      typeof platform.get !== 'function') throw new TypeError('A PostgreSQL platform store is required.');
  return Object.freeze({
    async withActiveTenant(tenantId, work) {
      if (typeof tenantId !== 'string' || !tenantId || typeof work !== 'function') {
        throw new ApiError(503, 'SHOP_UNAVAILABLE', 'This shop is not available right now.');
      }
      if (expectedTenantId !== undefined && tenantId !== expectedTenantId) throw new ApiError(503, 'SHOP_UNAVAILABLE', 'This shop is not available right now.');
      return platform.transaction(async () => {
        const row = tenantId === 'default'
          ? await platform.get('SELECT id, code, status, revision FROM tenant WHERE is_default = 1 FOR UPDATE')
          : await platform.get('SELECT id, code, status, revision FROM tenant WHERE id = ? AND is_default = 0 FOR UPDATE', tenantId);
        if (!row || row.status !== 'ACTIVE' || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
            (expectedCode !== undefined && row.code !== expectedCode)) {
          throw new ApiError(503, 'SHOP_UNAVAILABLE', 'This shop is not available right now.');
        }
        return work(Object.freeze({ revision: row.revision }));
      });
    },
  });
}
