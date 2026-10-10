// Disposable edge fixture: echoes requests for routing, or serves real SQLite APIs for browser-state checks.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { ensureAdmin } from '../src/auth.js';
import { setupShop } from '../src/shop-setup.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createApi } from '../src/app.js';
import { createPlatformRegistry } from '../src/platform/registry.js';

if (!process.env.QA_HOST_PORT || !['matrix', 'browser'].includes(process.env.QA_MODE)) throw new Error('Disposable QA fixture settings required.');
const origin = (host) => `https://${host}:${process.env.QA_HOST_PORT}`;
const config = { production: true, shopMode: 'manual', publicOrigin: origin('shop.gmb01.xyz'), sellerOrigin: origin('seller.gmb01.xyz'), platform: { adminHost: `admin.gmb01.xyz:${process.env.QA_HOST_PORT}` } };
const rows = new Map(['alpha', 'bravo', 'suspended', 'deleting', 'provisioning', 'failed'].map((code, index) => [code, { id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, code, name: `Fictional ${code}`, status: index < 2 ? 'ACTIVE' : code.toUpperCase() }]));
const aliases = new Map([['oldalpha', 'alpha']]);
const stores = new Map();
for (const code of ['default', 'alpha', 'bravo']) {
  const store = await openDatabase(':memory:'); stores.set(code, store);
  await ensureAdmin(store, 'fixture_owner', randomBytes(24).toString('hex'));
  await setupShop(store, { mode: 'production', shopName: `Fictional ${code}` });
  await createCategory(store, { code: 'FIXTURE', label: 'Fictional items' });
  await createProduct(store, { sku: 'FIXTURE-1', name: `Fictional ${code} item`, description: 'A synthetic item for browser checks.', category: 'FIXTURE', priceMinor: 1000, currency: 'MYR', stockQuantity: 100, active: true });
}
const platform = { get: async (sql, code) => sql.includes('tenant_code_alias') ? rows.get(aliases.get(code)) : rows.get(code) };
const registry = createPlatformRegistry({ store: stores.get('default'), config, platform, pool: { get: async (row) => stores.get(row.code) } });
const handle = await createApi({ store: stores.get('default'), config, registry,
  platformHandler: async (request) => new Response(JSON.stringify({ method: request.method, host: new URL(request.url).host, path: new URL(request.url).pathname }), { status: new URL(request.url).pathname.endsWith('/session') ? 401 : 200, headers: { 'content-type': 'application/json' } }) });
const server = createServer(async (incoming, response) => {
  try {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    let result;
    if (process.env.QA_MODE === 'browser' && incoming.method === 'POST' && url.pathname === '/api/v1/__qa/rename-alpha') {
      const row = rows.get('alpha'); rows.delete('alpha'); row.code = 'renamedalpha'; rows.set(row.code, row);
      aliases.set('alpha', row.code); aliases.set('oldalpha', row.code); stores.set(row.code, stores.get('alpha')); registry.invalidate();
      result = new Response('{}', { headers: { 'content-type': 'application/json' } });
    } else if (process.env.QA_MODE === 'matrix' && !url.pathname.endsWith('/api/v1/tenant-access')) {
      result = new Response(JSON.stringify({ method: incoming.method, host: incoming.headers.host, path: url.pathname, query: url.search, body: await new Response(Readable.toWeb(incoming)).text() }), { headers: { 'content-type': 'application/json' } });
    } else {
      const request = new Request(url, { method: incoming.method, headers: incoming.headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      Object.defineProperty(request, 'shopRawTarget', { value: incoming.url });
      result = await handle(request, { clientAddress: incoming.headers['x-real-ip'] || 'fixture' });
    }
    const headers = Object.fromEntries(result.headers); headers['set-cookie'] = result.headers.getSetCookie();
    response.writeHead(result.status, headers); response.end(Buffer.from(await result.arrayBuffer()));
  } catch { response.writeHead(500); response.end('Fixture failed.'); }
});
server.listen(3000, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(async () => { for (const store of stores.values()) await store.close(); process.exit(0); }));
