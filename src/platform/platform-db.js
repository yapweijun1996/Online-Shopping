import { upgradePlatformSchema } from './migrations.js';
import { randomUUID } from 'node:crypto';
import { openPostgresStore } from '../postgres-store.js';

// Automatic OrbStack upgrades remain on the rollback-compatible legacy baseline.
export const PLATFORM_SCHEMA_VERSION = 1;
export const PLATFORM_CLAIM_SCHEMA_VERSION = 2;

/* Initialize only empty databases at the selected target. Existing v1 needs explicit claim upgrade;
   claim-off runtime also accepts v2 after an authorized upgrade. Never migrate on open. */
export async function openPlatformDatabase(url, { claimEnabled = false, ...options } = {}) {
  const targetVersion = claimEnabled ? PLATFORM_CLAIM_SCHEMA_VERSION : PLATFORM_SCHEMA_VERSION;
  const store = openPostgresStore(url, options);
  try {
    await store.transaction(async () => {
      if (!(await store.get("SELECT to_regclass('public.schema_meta') AS name")).name) {
        await upgradePlatformSchema(store, { targetVersion });
      }
      const version = await store.schemaVersion();
      if (version !== targetVersion && !(version === PLATFORM_CLAIM_SCHEMA_VERSION && !claimEnabled)) throw new Error(`Unsupported platform schema version ${version}.`);
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
