import { openDatabase, SCHEMA_VERSION } from '../db.js';
import { openPostgresDatabase } from '../postgres-db.js';
import { openPostgresStore } from '../postgres-store.js';
import { createSecretBox } from '../secret-box.js';
import { tenantUrl } from '../platform/provisioner.js';
import { cleanupOAuth } from './cleanup.js';
import { maintainOperations } from './operation-maintenance.js';
import { operationStorageReady } from './operation-runtime.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const usage = 'Usage: node scripts/cleanup-seller-mcp.js [passes:1-1000] [--tenant=default|UUID]';
export function parseCleanupArguments(args) {
  let passes = 100, tenantId = 'default', countSeen = false, tenantSeen = false;
  for (const value of args) {
    if (typeof value !== 'string') throw new TypeError(usage);
    if (value.startsWith('--tenant=')) {
      if (tenantSeen) throw new TypeError(usage);
      tenantId = value.slice(9); tenantSeen = true;
      if (tenantId !== 'default' && !uuid.test(tenantId)) throw new TypeError(usage);
    } else {
      if (countSeen || !/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > 1000) throw new TypeError(usage);
      passes = Number(value); countSeen = true;
    }
  }
  return { passes, tenantId };
}

const unavailable = () => { throw new Error('MCP cleanup target is unavailable.'); };
const sameDatabase = (a, b) => a.id === b.id && a.is_default === b.is_default &&
  a.database_name === b.database_name && a.database_role === b.database_role;

// This PRIVATE adapter is exclusively for host-authorized data hygiene. It
// permits ACTIVE and SUSPENDED under the normal platform-first row lock. Never
// export or pass it to an engine, approval route or other business authority.
function cleanupFence(platform, tenantId) {
  let identity;
  return Object.freeze({
    async withActiveTenant(id, work) {
      if (id !== tenantId || typeof work !== 'function') unavailable();
      return platform.transaction(async () => {
        const version = await platform.schemaVersion();
        if (!Number.isSafeInteger(version) || version < 1 || version > 3) unavailable();
        const row = tenantId === 'default'
          ? await platform.get('SELECT * FROM tenant WHERE is_default = 1 FOR UPDATE')
          : await platform.get('SELECT * FROM tenant WHERE id = ? AND is_default = 0 FOR UPDATE', tenantId);
        if (!row || !['ACTIVE', 'SUSPENDED'].includes(row.status) ||
            !Number.isSafeInteger(row.revision) || row.revision < 0 || (identity && !sameDatabase(identity, row))) unavailable();
        identity ??= Object.freeze({ id: row.id, is_default: row.is_default, database_name: row.database_name, database_role: row.database_role });
        return work(Object.freeze({ revision: row.revision }), row);
      });
    },
  });
}

async function assertIdentity(store, tenantId) {
  // A supplied default connection cannot silently target an already populated
  // non-default shop, and mixed/imported identities must be reviewed first.
  for (const table of ['oauth_client', 'oauth_authorization_request', 'oauth_grant', 'mcp_v2_operation', 'mcp_v2_scope_consent', 'mcp_v2_media_stage', 'mcp_v2_media_quota', 'mcp_v2_media_event']) {
    if (await store.get(`SELECT tenant_id FROM ${table} WHERE tenant_id <> ? LIMIT 1`, tenantId)) unavailable();
  }
}

// No service, timer or credential discovery is started. The host explicitly
// selects one shop; each pass retains existing OAuth reclamation and runs one
// bounded v2 retention pass even when MCP feature switches are off.
export async function runSellerMcpCleanup({ config, passes = 100, tenantId = 'default' }, dependencies = {}) {
  if (!config || !Number.isInteger(passes) || passes < 1 || passes > 1000 ||
      (tenantId !== 'default' && !uuid.test(tenantId))) throw new TypeError(usage);
  if (tenantId !== 'default' && !config.platform) unavailable();
  const openDefault = dependencies.openDefault ?? (() => config.databaseUrl ? openPostgresDatabase(config.databaseUrl) : openDatabase(config.dbPath));
  const openPlatform = dependencies.openPlatform ?? ((url) => openPostgresStore(url, { max: 1 }));
  const openTenant = dependencies.openTenant ?? ((url) => openPostgresStore(url, { max: 1 }));
  let store, platform;
  try {
    if (config.platform) platform = await openPlatform(config.platform.databaseUrl);
    const tenantGuard = platform ? cleanupFence(platform, tenantId) : Object.freeze({
      async withActiveTenant(id, work) {
        if (id !== 'default') unavailable();
        return work(Object.freeze({ revision: 0 }));
      },
    });
    await tenantGuard.withActiveTenant(tenantId, async (_tenant, row) => {
      if (tenantId === 'default') store = await openDefault();
      else {
        if (!config.integrationKeys || !row.database_name || !row.database_role || !row.database_password_sealed || !row.database_key_id) unavailable();
        const box = createSecretBox(config.integrationKeys);
        const password = box.open(row.database_password_sealed, row.database_key_id, `TENANT_DB:${row.id}`);
        store = await openTenant(tenantUrl(config.platform.databaseUrl, { role: row.database_role, password, database: row.database_name }));
      }
      if (await store.schemaVersion() !== SCHEMA_VERSION || !await operationStorageReady(store)) unavailable();
      await assertIdentity(store, tenantId);
    });
    // cleanupOAuth's individual writer transactions acquire the platform fence
    // before the shop lock. Do not wrap the whole repeated pass in either lock.
    const guarded = { ...store, transaction: (work) => tenantGuard.withActiveTenant(tenantId, () => store.transaction(work)) };
    for (let i = 0; i < passes; i++) {
      await cleanupOAuth(guarded);
      await maintainOperations(store, { enabled: true, tenantGuard, tenantId });
    }
    return { cleanupPasses: passes };
  } finally {
    try { if (store) await store.close(); }
    finally { if (platform) await platform.close(); }
  }
}
