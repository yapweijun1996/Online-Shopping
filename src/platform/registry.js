import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { singleTenantRegistry } from '../tenants.js';
import { RESERVED_CODES } from './tenant-code.js';

const codePattern = /^[a-z0-9]{3,30}$/;
export function rewriteTenantRequest(request, basePath) {
  if (!basePath) return request;
  const url = new URL(request.url); url.pathname = url.pathname.slice(basePath.length) || '/';
  return new Request(url, { method: request.method, headers: request.headers, signal: request.signal,
    ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}) });
}
export function createPlatformRegistry({ store, config, platform, pool, clock = Date.now }) {
  const fallback = singleTenantRegistry({ store, config }), cache = new Map(), probes = new Map(), identities = new Map();
  const db = () => typeof platform === 'function' ? platform() : platform;
  const boundedSet = (map, key, value) => { map.delete(key); map.set(key, value); while (map.size > 1000) map.delete(map.keys().next().value); };
  async function lookup(code, database) {
    const cached = cache.get(code);
    if (cached && cached.expires > clock()) return cached.value;
    let value = await database.get('SELECT * FROM tenant WHERE code = ? AND is_default = 0', code);
    if (!value) {
      const alias = await database.get(`SELECT t.* FROM tenant_code_alias a JOIN tenant t ON t.id = a.tenant_id WHERE a.code = ? AND t.is_default = 0`, code);
      if (alias) value = { ...alias, alias: true };
    }
    boundedSet(cache, code, { value: value || null, expires: clock() + (value ? 30_000 : 10_000) });
    return value;
  }
  return {
    invalidate() { cache.clear(); },
    cacheSize: () => cache.size,
    async resolve(request, { clientAddress = 'unknown' } = {}) {
      const url = new URL(request.url), segment = url.pathname.split('/')[1];
      if (!codePattern.test(segment) || RESERVED_CODES.has(segment)) return fallback.resolve(request);
      const edgeProbe = url.pathname === `/${segment}/api/v1/tenant-access` && ['GET', 'HEAD'].includes(request.method);
      const unavailable = (status) => ({ response: new Response(request.method === 'HEAD' ? null : `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Shop ${status === 404 ? 'not found' : 'unavailable'}</title><h1>Shop ${status === 404 ? 'not found' : 'unavailable'}</h1></html>`,
        { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) });
      if (url.pathname.length > 8192) return null;
      const cached = cache.get(segment);
      let attemptedProbe;
      if (!cached?.value) {
        const key = createHash('sha256').update(clientAddress).digest('hex');
        let probe = probes.get(key);
        if (!probe || probe.expires <= clock()) probe = { count: 0, expires: clock() + 15 * 60_000 };
        if (probe.count >= 30) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests.');
        probe.count++; boundedSet(probes, key, probe); attemptedProbe = { key, probe };
      }
      const refundProbe = () => { if (attemptedProbe && probes.get(attemptedProbe.key) === attemptedProbe.probe) attemptedProbe.probe.count--; };
      let row;
      try { row = await lookup(segment, await db()); } catch (error) { refundProbe(); throw error; }
      // Refreshing a known shop is ordinary traffic, including the first successful lookup.
      if (row) refundProbe();
      if (!row) return edgeProbe ? unavailable(404) : null;
      if (row.alias) {
        const original = request.headers.get('x-tenant-original-uri');
        if (edgeProbe && original?.startsWith(`/${segment}/`) && !/[\\\r\n]/.test(original)) {
          return { response: new Response(null, { status: 308, headers: { Location: `/${row.code}${original.slice(segment.length + 1)}`, 'Cache-Control': 'no-store' } }) };
        }
        url.pathname = `/${row.code}${url.pathname.slice(segment.length + 1)}`;
        return { response: new Response(null, { status: 308, headers: { Location: url.pathname + url.search, 'Cache-Control': 'no-store' } }) };
      }
      if (['PROVISIONING', 'FAILED', 'PURGED'].includes(row.status)) return edgeProbe ? unavailable(404) : null;
      if (row.status !== 'ACTIVE') return edgeProbe ? unavailable(503) : { id: row.id, status: row.status };
      if (edgeProbe) return { response: new Response(null, { headers: { 'Cache-Control': 'no-store' } }) };
      let tenantStore;
      try { tenantStore = await pool.get(row); } catch { throw new ApiError(503, 'SHOP_UNAVAILABLE', 'This shop is not available right now.'); }
      const basePath = `/${row.code}`;
      let tenant = identities.get(row.id);
      if (!tenant || tenant.store !== tenantStore || tenant.code !== row.code || tenant.config.tenantName !== row.name) {
        const { username: _username, password: _password, platform: _platform, databaseUrl: _databaseUrl, ...baseConfig } = config;
        tenant = Object.freeze({ id: row.id, code: row.code, status: 'ACTIVE', store: tenantStore,
          config: { ...baseConfig, sellerQuickLogin: false, shopMode: 'manual', basePath, tenantName: row.name,
            storageScope: `t-${createHash('sha256').update(row.id).digest('hex').slice(0, 12)}` } });
        boundedSet(identities, row.id, tenant);
      }
      return tenant;
    },
  };
}
