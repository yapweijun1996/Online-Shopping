import { SCHEMA_VERSION } from '../db.js';
import { openNodeStore } from '../store.js';
import { lstatSync } from 'node:fs';
import { revokeSessions } from '../auth.js';
import { invalidateOAuth, stamp } from './credentials.js';
import { openPostgresStore } from '../postgres-store.js';
import { createSecretBox } from '../secret-box.js';
import { tenantUrl } from '../platform/provisioner.js';
import { cleanupOAuth } from './cleanup.js';
import { maintainOperations } from './operation-maintenance.js';
import { operationStorageReady } from './operation-runtime.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const usage = 'Usage: node scripts/cleanup-seller-mcp.js [passes:1-1000] [--tenant=default|UUID], or --all [passes:1-10] [--limit=1-20] [--after=UUID]';
export function parseCleanupArguments(args) {
  if (args.includes('--all')) return parseAllCleanupArguments(args);
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

// All-shop mode is deliberately smaller than the historical single-shop pass
// range. The host repeats pages and resets the cursor only after complete=true.
function parseAllCleanupArguments(args) {
  let passes = 1, limit = 20, after = null;
  const seen = new Set();
  for (const value of args) {
    const key = value === '--all' ? 'all' : value.startsWith('--limit=') ? 'limit' : value.startsWith('--after=') ? 'after' : 'passes';
    if (seen.has(key)) throw new TypeError(usage);
    seen.add(key);
    if (key === 'all') continue;
    if (key === 'after') { after = value.slice(8); if (!uuid.test(after)) throw new TypeError(usage); }
    else {
      const text = key === 'limit' ? value.slice(8) : value;
      const number = Number(text);
      if (!/^[1-9][0-9]*$/.test(text) || number > (key === 'limit' ? 20 : 10)) throw new TypeError(usage);
      if (key === 'limit') limit = number; else passes = number;
    }
  }
  return { all: true, passes, limit, after };
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

// Open one existing shop only after the private platform hygiene fence.
// No service, timer, schema initialization or business authority is created.
async function withMaintenanceTarget({ config, tenantId = 'default' }, dependencies, work) {
  if (!config || (tenantId !== 'default' && !uuid.test(tenantId))) throw new TypeError(usage);
  if (tenantId !== 'default' && !config.platform) unavailable();
  const openDefault = dependencies.openDefault ?? (() => {
    if (config.databaseUrl) return openPostgresStore(config.databaseUrl, { max: 1 });
    // The maintenance path must never initialize or migrate a missing/old DB.
    if (typeof config.dbPath !== 'string' || !lstatSync(config.dbPath).isFile()) unavailable();
    return openNodeStore(config.dbPath);
  });
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
    return await work(store, tenantGuard);
  } finally {
    try { if (store) await store.close(); }
    finally { if (platform) await platform.close(); }
  }
}

// The private target/fence is shared only by these fixed host-hygiene actions.
// Never use it as application/business authorization (SUSPENDED is permitted).
export async function runSellerMcpCleanup({ config, passes = 100, tenantId = 'default' }, dependencies = {}) {
  if (!Number.isInteger(passes) || passes < 1 || passes > 1000) throw new TypeError(usage);
  return withMaintenanceTarget({ config, tenantId }, dependencies, async (store, tenantGuard) => {
    const guarded = { ...store, transaction: work => tenantGuard.withActiveTenant(tenantId, () => store.transaction(work)) };
    for (let i = 0; i < passes; i++) {
      await cleanupOAuth(guarded);
      await maintainOperations(store, { enabled: true, tenantGuard, tenantId });
    }
    return { cleanupPasses: passes };
  });
}

export async function runAllSellerMcpCleanup({ config, passes = 1, limit = 20, after = null }, dependencies = {}) {
  if (!config || !Number.isInteger(passes) || passes < 1 || passes > 10 || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
      (after !== null && !uuid.test(after))) throw new TypeError(usage);
  if (!config.platform) {
    if (after !== null) throw new TypeError(usage);
    await runSellerMcpCleanup({ config, passes }, dependencies);
    return { processedTenants: 1, cleanupPassesPerTenant: passes, nextCursor: null, complete: true };
  }
  const platform = await (dependencies.openPlatform ?? (url => openPostgresStore(url, { max: 1 })))(config.platform.databaseUrl);
  let rows;
  try {
    const version = await platform.schemaVersion();
    if (!Number.isSafeInteger(version) || version < 1 || version > 3) unavailable();
    rows = await platform.all("SELECT id,is_default FROM tenant WHERE status IN ('ACTIVE','SUSPENDED') AND id>? ORDER BY id LIMIT ?", after ?? '', limit + 1);
    if (rows.some(row => !uuid.test(row.id) || ![0, 1].includes(row.is_default))) unavailable();
  } finally { await platform.close(); }
  for (const row of rows.slice(0, limit)) {
    // Re-enter the existing platform row-lock fence before opening each shop.
    await runSellerMcpCleanup({ config, passes, tenantId: row.is_default === 1 ? 'default' : row.id }, dependencies);
  }
  return { processedTenants: Math.min(rows.length, limit), cleanupPassesPerTenant: passes,
    nextCursor: rows.length > limit ? rows[limit - 1].id : null, complete: rows.length <= limit };
}

const recoveryUsage = 'Usage: node scripts/recover-seller-mcp.js [--tenant=default|UUID] [--phase=accounts|requests] [--after=UUID] [--limit=1-100]';
export function parseRecoveryArguments(args) {
  let tenantId = 'default', phase = 'accounts', after = null, limit = 100;
  const seen = new Set();
  for (const value of args) {
    const match = /^--(tenant|phase|after|limit)=(.+)$/.exec(value);
    if (!match || seen.has(match[1])) throw new TypeError(recoveryUsage);
    seen.add(match[1]);
    if (match[1] === 'tenant') tenantId = match[2];
    if (match[1] === 'phase') phase = match[2];
    if (match[1] === 'after') after = match[2];
    if (match[1] === 'limit') { if (!/^[1-9][0-9]*$/.test(match[2])) throw new TypeError(recoveryUsage); limit = Number(match[2]); }
  }
  validateRecovery({ tenantId, phase, after, limit });
  return { tenantId, phase, after, limit };
}
function validateRecovery({ tenantId, phase, after, limit }) {
  if ((tenantId !== 'default' && !uuid.test(tenantId)) || !['accounts', 'requests'].includes(phase) ||
      (after !== null && !uuid.test(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError(recoveryUsage);
}
export async function runSellerMcpRecovery({ config, tenantId = 'default', phase = 'accounts', after = null, limit = 100 }, dependencies = {}) {
  validateRecovery({ tenantId, phase, after, limit });
  return withMaintenanceTarget({ config, tenantId }, dependencies, (store, tenantGuard) =>
    tenantGuard.withActiveTenant(tenantId, () => store.transaction(async () => {
      const rows = phase === 'accounts'
        ? await store.all('SELECT id FROM seller_account WHERE id>? ORDER BY id LIMIT ?', after ?? '', limit + 1)
        : await store.all('SELECT id FROM oauth_authorization_request WHERE account_id IS NULL AND consumed_at IS NULL AND id>? ORDER BY id LIMIT ?', after ?? '', limit + 1);
      if (rows.some(row => !uuid.test(row.id))) unavailable();
      for (const row of rows.slice(0, limit)) {
        if (phase === 'accounts') { await revokeSessions(store, row.id); await invalidateOAuth(store, row.id); }
        else await store.run('UPDATE oauth_authorization_request SET consumed_at=? WHERE id=? AND account_id IS NULL AND consumed_at IS NULL', stamp(), row.id);
      }
      const more = rows.length > limit;
      return { phase, processed: Math.min(rows.length, limit), nextPhase: more ? phase : phase === 'accounts' ? 'requests' : null,
        nextCursor: more ? rows[limit - 1].id : null, complete: phase === 'requests' && !more };
    })));
}
