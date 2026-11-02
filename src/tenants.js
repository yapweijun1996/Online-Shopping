// Tenant context. A tenant is one shop with its single seller: its own store (database) and its own config.
// The API asks a registry which tenant a request belongs to and then runs that tenant's routes unchanged.
// Today's installation is one tenant (the default); the platform registry that serves many comes later
// (docs/MULTI_TENANT_SUPERADMIN_PLAN.md, phase P2 onward).
//
// A tenant looks like { id, code, status: 'ACTIVE' | 'SUSPENDED', store, config }. A registry is
// { resolve(request) -> tenant | null }; null means "no such shop".

export const DEFAULT_TENANT_ID = 'default';

/* The current single shop as a registry: every request belongs to it. */
export function singleTenantRegistry({ store, config }) {
  const tenant = Object.freeze({ id: DEFAULT_TENANT_ID, code: null, status: 'ACTIVE', store, config });
  return { resolve: async () => tenant };
}
