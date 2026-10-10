// Opens each shop's own database on first use and keeps a bounded number of them open. A shop's connection is made
// with that shop's own role (its password is unsealed here and nowhere else), so the process holds no connection that
// could read another shop's data through the same pool. Idle shops are closed.
import { openPostgresStore } from '../postgres-store.js';
import { SCHEMA_VERSION } from '../db.js';
import { tenantUrl } from './provisioner.js';

export function createTenantPool({ secretBox, baseUrl, maxOpen = 20, idleMs = 5 * 60_000, connectionsPerTenant = 3, clock = Date.now }) {
  const open = new Map();   // tenant id -> { promise, lastUsed }
  const close = async (id) => {
    const entry = open.get(id);
    open.delete(id);
    if (entry) await (await entry.promise.catch(() => null))?.close().catch(() => {});
  };
  async function evictIdle() {
    const stamp = clock();
    for (const [id, entry] of open) if (!entry.busy && stamp - entry.lastUsed > idleMs) await close(id);
  }
  const timer = setInterval(() => evictIdle().catch(() => {}), Math.max(100, Math.min(idleMs, 30_000))); timer.unref();
  async function connect(tenant) {
    if (!tenant.database_name) throw new Error('This tenant has no database of its own.');
    const password = secretBox.open(tenant.database_password_sealed, tenant.database_key_id, `TENANT_DB:${tenant.id}`);
    const store = openPostgresStore(tenantUrl(baseUrl, { role: tenant.database_role, password, database: tenant.database_name }), { max: connectionsPerTenant });
    try {
      // A shop whose schema is not the one this release expects is not served; the updater brings it up to date.
      const version = await store.schemaVersion();
      if (version !== SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}.`);
      return new Proxy(store, { get(target, name) {
        const value = target[name];
        if (typeof value !== 'function' || name === 'close') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args) => { const entry = open.get(tenant.id); if (entry) { entry.lastUsed = clock(); entry.busy++; }
          try { return await value.apply(target, args); } finally { if (entry) { entry.busy--; entry.lastUsed = clock(); } } };
      } });
    } catch (error) { await store.close(); throw error; }
  }
  return {
    size: () => open.size, evictIdle,
    /* The store of an ACTIVE tenant row (as read from the platform database). */
    async get(tenant) {
      const stamp = clock();
      await evictIdle();
      let entry = open.get(tenant.id);
      if (!entry) {
        // Make room first: the least recently used shop is closed.
        while (open.size >= maxOpen) await close([...open].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0]);
        entry = { promise: connect(tenant), lastUsed: stamp, busy: 0 };
        open.set(tenant.id, entry);
        entry.promise.catch(() => { if (open.get(tenant.id) === entry) open.delete(tenant.id); });
      }
      entry.lastUsed = stamp;
      return entry.promise;
    },
    release: close,
    async closeAll() { clearInterval(timer); for (const id of [...open.keys()]) await close(id); },
  };
}
