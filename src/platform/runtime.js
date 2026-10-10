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

export function createPlatformRuntime({ store, config, clock = Date.now }) {
  const secretBox = createSecretBox(config.integrationKeys);
  const pool = createTenantPool({ secretBox, baseUrl: config.platform.databaseUrl, connectionsPerTenant: 3 });
  let connection = null, pending = null, retryAfter = 0, stopped = false, routes = null, timer, recovered = false;
  const deps = { secretBox, baseUrl: config.platform.databaseUrl, provisionerUrl: config.platform.provisionerUrl };
  async function connect() {
    if (stopped) throw new ApiError(503, 'PLATFORM_UNAVAILABLE', 'The platform is temporarily unavailable.');
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
        candidate = await openPlatformDatabase(config.platform.databaseUrl, { max: 3, connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000 });
        const auth = createAdminAuth({ platform: candidate, secretBox, clock });
        await auth.bootstrap(config.platform.username, config.platform.password);
        await candidate.transaction(async () => {
          if (!await candidate.get('SELECT 1 AS n FROM tenant WHERE is_default = 1')) {
            const setup = await getShopSetup(store), company = await getCompanySettings(store), stamp = new Date(clock()).toISOString();
            await candidate.run(`INSERT INTO tenant(id, code, name, status, currency, is_default, sample, created_at, updated_at)
              VALUES (?, 'default', ?, 'ACTIVE', ?, 1, ?, ?, ?)`, randomUUID(), setup.shopName || 'Current shop', company.defaultCurrency,
              config.sellerQuickLogin || config.shopMode === 'public-demo' ? 1 : 0, stamp, stamp);
          }
          if (!recovered) {
            // One backend owns provisioning. A process restart leaves unfinished rows unavailable and retryable.
            for (const row of await candidate.all("SELECT id, revision FROM tenant WHERE status = 'PROVISIONING' AND is_default = 0")) {
              await candidate.run("UPDATE tenant SET status = 'FAILED', revision = revision + 1, last_error = 'INTERRUPTED', updated_at = ? WHERE id = ? AND status = 'PROVISIONING' AND revision = ?",
                new Date(clock()).toISOString(), row.id, row.revision);
              await recordAudit(candidate, { actor: 'host', action: 'TENANT_FAILED', tenantId: row.id, detail: 'INTERRUPTED' });
            }
          }
        });
        recovered = true;
        if (stopped) { await candidate.close(); throw new Error('Platform stopped.'); }
        connection = candidate;
        routes = createPlatformRoutes({ platform: candidate, secretBox, pool, registry, deps, defaultStore: store, config, clock });
        return connection;
      } catch {
        await candidate?.close().catch(() => {}); retryAfter = clock() + 5000;
        throw new ApiError(503, 'PLATFORM_UNAVAILABLE', 'The platform is temporarily unavailable.');
      } finally { pending = null; }
    })();
    return pending;
  }
  const registry = createPlatformRegistry({ store, config, platform: connect, pool, clock });
  // Connection failures stay outside the legacy readiness path, and retries are bounded.
  timer = setInterval(() => connect().catch(() => {}), 15_000); timer.unref();
  return {
    registry, pool, connect,
    async handle(request, context) { await connect(); return routes(request, context); },
    async close() { stopped = true; clearInterval(timer); await pending?.catch(() => {}); await pool.closeAll(); await connection?.close(); connection = null; },
  };
}
