import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { getShopSetup } from '../shop-setup.js';
import { getCompanySettings } from '../settings.js';
import { createSecretBox } from '../secret-box.js';
import { openPlatformDatabase, recordAudit } from './platform-db.js';
import { createTenantPool } from './tenant-pool.js';
import { createPlatformRegistry } from './registry.js';
import { createAdminAuth } from './admin-auth.js';
import { createPlatformRoutes } from './admin-routes.js';
import { issueAdminClaim } from './admin-claim.js';
import { createSetupRoutes } from './setup-routes.js';
import { createQrPolicy } from './whatsapp-qr.js';

export function createPlatformRuntime({ store, config, clock = Date.now, paused = () => false, qrCleanupAndStop }) {
  const secretBox = createSecretBox(config.integrationKeys);
  const pool = createTenantPool({ secretBox, baseUrl: config.platform.databaseUrl, connectionsPerTenant: 3 });
  let connection = null, pending = null, retryAfter = 0, stopped = false, routes = null, setupRoutes = null, timer, background = null, maintenanceTasks = 0;
  const inFlight = new Set();
  const qrStopped = new Map();
  const claimStartedAt = new Date(clock()).toISOString();
  let claimInitialized = false;
  const deps = { inFlight, secretBox, mcpEnabled: config.mcpEnabled === true, baseUrl: config.platform.databaseUrl, provisionerUrl: config.platform.provisionerUrl };
  async function recoverInterrupted(platform) {
    if (paused()) return;
    maintenanceTasks++;
    try {
      await platform.transaction(async () => {
        for (const row of await platform.all("SELECT id, revision FROM tenant WHERE status = 'PROVISIONING' AND is_default = 0")) {
          if (inFlight.has(row.id)) continue;
          const changed = await platform.get("UPDATE tenant SET status = 'FAILED', revision = revision + 1, last_error = 'INTERRUPTED', updated_at = ? WHERE id = ? AND status = 'PROVISIONING' AND revision = ? RETURNING id",
            new Date(clock()).toISOString(), row.id, row.revision);
          if (changed) await recordAudit(platform, { actor: 'host', action: 'TENANT_FAILED', tenantId: row.id, detail: 'INTERRUPTED' });
        }
      });
      if (await platform.schemaVersion() >= 3) {
        const policy = createQrPolicy({ platform, tenantSlots: config.platform.qrTenantSlots, provisionedTenantIds: config.platform.qrProvisionedTenantIds, clock });
        for (const binding of await platform.all('SELECT tenant_id, epoch FROM tenant_qr_binding WHERE cleanup_pending = true ORDER BY tenant_id LIMIT 20')) {
          await policy.reconcile(binding.tenant_id, binding.epoch, async reservation => {
            const row = await platform.get('SELECT * FROM tenant WHERE id = ?', reservation.tenant_id);
            if (!row) return false;
            const shop = row.is_default === 1 ? store : await pool.get(row);
            await shop.transaction(async () => {
              const session = await shop.get(`SELECT * FROM whatsapp_qr_session WHERE id = 1${shop.dialect === 'postgres' ? ' FOR UPDATE' : ''}`);
              const at = new Date(clock()).toISOString();
              await shop.run("UPDATE whatsapp_qr_session SET generation = generation + 1, auth_version = 0, desired = 'OFF', state = 'IDLE', lease_owner = NULL, lease_expires_at = NULL, qr_text = NULL, qr_expires_at = NULL, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?", at, session.revision);
              await shop.run('DELETE FROM whatsapp_qr_auth');
              await shop.run("UPDATE message_thread_message SET status = 'CANCELLED', updated_at = ? WHERE direction = 'OUT' AND status = 'QUEUED'", at);
              await shop.run("UPDATE message_thread_message SET status = 'RECONCILE', updated_at = ? WHERE direction = 'OUT' AND status = 'SENDING'", at);
            });
            // Durable cleanup is independent of stop confirmation. Never infer stop from silence.
            const stopped = qrStopped.get(reservation.tenant_id) === reservation.epoch ||
              (qrCleanupAndStop ? await qrCleanupAndStop(reservation) === true : false);
            if (stopped) qrStopped.delete(reservation.tenant_id);
            return stopped;
          }).catch(() => {});
        }
      }
    } finally { maintenanceTasks--; }
  }
  async function connect() {
    if (stopped || paused()) throw new ApiError(503, 'PLATFORM_UNAVAILABLE', 'The platform is temporarily unavailable.');
    if (connection) {
      const active = connection;
      try { await active.get('SELECT 1 AS alive'); return active; }
      catch {
        // Concurrent requests may fail on the same pool; only its first observer retires it.
        if (connection === active) { connection = null; routes = null; retryAfter = clock() + 5000; await active.close().catch(() => {}); }
      }
    }
    if (pending) return pending;
    if (clock() < retryAfter) throw new ApiError(503, 'PLATFORM_UNAVAILABLE', 'The platform is temporarily unavailable.');
    pending = (async () => {
      let candidate;
      try {
        candidate = await openPlatformDatabase(config.platform.databaseUrl, { claimEnabled: config.platform.claimEnabled, max: 3, connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000 });
        const auth = createAdminAuth({ platform: candidate, secretBox, clock });
        if (!config.platform.claimEnabled) await auth.bootstrap(config.platform.username, config.platform.password);
        await candidate.transaction(async () => {
          if (!await candidate.get('SELECT 1 AS n FROM tenant WHERE is_default = 1')) {
            const setup = await getShopSetup(store), company = await getCompanySettings(store), stamp = new Date(clock()).toISOString();
            await candidate.run(`INSERT INTO tenant(id, code, name, status, currency, is_default, sample, created_at, updated_at)
              VALUES (?, 'default', ?, 'ACTIVE', ?, 1, ?, ?, ?)`, randomUUID(), setup.shopName || 'Current shop', company.defaultCurrency,
              config.sellerQuickLogin || config.shopMode === 'public-demo' ? 1 : 0, stamp, stamp);
          }
          await recoverInterrupted(candidate);
        });
        if (stopped) { await candidate.close(); throw new Error('Platform stopped.'); }
        if (config.platform.claimEnabled && !claimInitialized) {
          if (paused()) throw new Error('Platform paused.');
          const issued = await issueAdminClaim(candidate, config, claimStartedAt, paused);
          claimInitialized = true;
          // Never replay plaintext after a failed stdout write or a reconnect.
          if (issued) console.log(JSON.stringify(issued));
        }
        connection = candidate;
        routes = createPlatformRoutes({ platform: candidate, secretBox, pool, registry, deps, defaultStore: store, config, clock });
        setupRoutes = createSetupRoutes({ platform: candidate, secretBox, config, clock });
        return connection;
      } catch {
        await candidate?.close().catch(() => {}); retryAfter = clock() + 5000;
        throw new ApiError(503, 'PLATFORM_UNAVAILABLE', 'The platform is temporarily unavailable.');
      } finally { pending = null; }
    })();
    return pending;
  }
  const registry = createPlatformRegistry({ store, config, platform: connect, pool, clock, qrStopped });
  // Connection failures stay outside the legacy readiness path, and retries are bounded.
  timer = setInterval(() => {
    if (paused() || background) return;
    background = connect().then(recoverInterrupted).catch(() => {}).finally(() => { background = null; });
  }, 15_000); timer.unref();
  return {
    registry, pool, connect, isBusy: () => Boolean(pending || background || maintenanceTasks), reconcile: async () => recoverInterrupted(await connect()),
    async qrPolicy() { return createQrPolicy({ platform: await connect(), tenantSlots: config.platform.qrTenantSlots, provisionedTenantIds: config.platform.qrProvisionedTenantIds, clock }); },
    workerTenants: {
      async list() { return (await connect()).all("SELECT * FROM tenant WHERE is_default = 0 AND status = 'ACTIVE' ORDER BY code LIMIT 20"); },
      async get(tenant) {
        const row = await (await connect()).get("SELECT * FROM tenant WHERE id = ? AND is_default = 0 AND status = 'ACTIVE'", tenant.id);
        return row ? pool.get(row) : null;
      },
    },
    async handle(request, context) { await connect(); return routes(request, context); },
    async handleSetup(request, context) { await connect(); return setupRoutes(request, context); },
    async close() { stopped = true; clearInterval(timer); await background?.catch(() => {}); await pending?.catch(() => {}); await pool.closeAll(); await connection?.close(); connection = null; },
  };
}
