import { upgradePlatformSchema } from './migrations.js';
import { randomUUID } from 'node:crypto';
import { openPostgresStore } from '../postgres-store.js';

export const PLATFORM_SCHEMA_VERSION = 2;

/* Opens the platform database, creating its schema in an empty database. A database that already has another schema
   version is refused instead of being changed. */
export async function openPlatformDatabase(url, options) {
  const store = openPostgresStore(url, options);
  try {
    await store.transaction(async () => {
      if (!(await store.get("SELECT to_regclass('public.schema_meta') AS name")).name) {
        await upgradePlatformSchema(store);
      }
      const version = await store.schemaVersion();
      if (version !== PLATFORM_SCHEMA_VERSION) throw new Error(`Unsupported platform schema version ${version}.`);
    });
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

/* One line in the append-only audit trail. Never put a password, token or personal data in `detail`. */
export async function recordAudit(platform, { actor, action, tenantId = null, detail = null }) {
  await platform.run('INSERT INTO platform_audit(id, actor, action, tenant_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    randomUUID(), actor, action, tenantId, detail, new Date().toISOString());
}
