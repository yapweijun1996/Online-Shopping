import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { setupShop } from '../src/shop-setup.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { ensureAdmin } from '../src/auth.js';
import { singleTenantRegistry, DEFAULT_TENANT_ID } from '../src/tenants.js';

const config = { shopMode: 'manual', publicOrigin: null, sellerOrigin: null, appRevision: null };
async function shop(t, name) {
  const store = await openDatabase(':memory:');
  t.after(() => store.close());
  await setupShop(store, { mode: 'production', shopName: name });
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  await createProduct(store, { sku: 'TEE-1', name: `${name} tee`, description: 'Soft', category: 'WEAR', priceMinor: 1200, currency: 'MYR', active: true });
  await ensureAdmin(store, 'fixture_owner', 'SyntheticFixtureOnly4920!');
  return store;
}
const get = (handle, path, headers = {}) => handle(new Request(`https://shop.example.test${path}`, { headers }), { clientAddress: '203.0.113.5' });
const names = async (response) => (await response.json()).items.map((item) => item.name);

test('the single-shop registry maps every request to the default tenant', async (t) => {
  const store = await shop(t, 'Solo');
  const registry = singleTenantRegistry({ store, config });
  const tenant = await registry.resolve(new Request('https://shop.example.test/anything'));
  assert.equal(tenant.id, DEFAULT_TENANT_ID); assert.equal(tenant.status, 'ACTIVE'); assert.equal(tenant.store, store);
  const handle = await createApi({ store, config });
  assert.deepEqual(await names(await get(handle, '/api/v1/products')), ['Solo tee']);
  assert.equal((await get(handle, '/api/v1/shop')).status, 200);
});

test('with a registry each request runs against its own tenant store, config and limiters', async (t) => {
  const a = await shop(t, 'Alpha'), b = await shop(t, 'Beta');
  const tenants = { alpha: { id: 'alpha', code: 'alpha', status: 'ACTIVE', store: a, config }, beta: { id: 'beta', code: 'beta', status: 'ACTIVE', store: b, config } };
  const registry = { resolve: async (request) => tenants[request.headers.get('x-tenant')] ?? null };
  const handle = await createApi({ registry });
  assert.deepEqual(await names(await get(handle, '/api/v1/products', { 'x-tenant': 'alpha' })), ['Alpha tee']);
  assert.deepEqual(await names(await get(handle, '/api/v1/products', { 'x-tenant': 'beta' })), ['Beta tee']);
  // Failed sign-ins in one shop use that shop's limiter and database; the other shop is unaffected.
  const login = (tenant) => handle(new Request('https://shop.example.test/api/v1/seller/session', { method: 'POST',
    headers: { origin: 'https://shop.example.test', 'content-type': 'application/json', 'x-tenant': tenant }, body: JSON.stringify({ username: 'fixture_owner', password: 'wrong-password-123' }) }), { clientAddress: '203.0.113.5' });
  for (let i = 0; i < 5; i++) assert.equal((await login('alpha')).status, 401);
  assert.equal((await login('alpha')).status, 429, 'alpha is locked out');
  assert.equal((await login('beta')).status, 401, 'beta still answers normally');
  assert.equal((await a.get('SELECT COUNT(*) AS n FROM rate_limit_attempt')).n > 0, true);
  assert.equal((await b.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket = 'login'")).n, 1, 'one attempt, in beta only');
});

test('an unknown tenant is 404 and a suspended one 503, without touching any database', async (t) => {
  const touched = [];
  const trap = new Proxy({}, { get: (_, key) => { touched.push(String(key)); throw new Error('the database must not be used'); } });
  const registry = { resolve: async (request) => ({ missing: null, suspended: { id: 's', code: 's', status: 'SUSPENDED', store: trap, config }, provisioning: { id: 'p', code: 'p', status: 'PROVISIONING', store: trap, config } })[request.headers.get('x-tenant')] };
  const handle = await createApi({ registry });
  assert.equal((await get(handle, '/api/v1/products', { 'x-tenant': 'missing' })).status, 404);
  const suspended = await get(handle, '/api/v1/products', { 'x-tenant': 'suspended' });
  assert.equal(suspended.status, 503); assert.equal((await suspended.json()).error.code, 'SHOP_UNAVAILABLE');
  assert.equal((await get(handle, '/api/v1/products', { 'x-tenant': 'provisioning' })).status, 503);
  assert.deepEqual(touched, []);
});

test('a tenant route table is built once, however many requests arrive at the same time', async (t) => {
  const store = await shop(t, 'Once');
  let setupReads = 0;   // building a route table reads the shop setup exactly once
  const counted = new Proxy(store, { get: (target, key) => key === 'get'
    ? (sql, ...params) => { if (/FROM shop_setup/.test(sql)) setupReads++; return target.get(sql, ...params); }
    : Reflect.get(target, key) });
  let resolved = 0;
  const tenant = { id: 'once', code: 'once', status: 'ACTIVE', store: counted, config };
  const handle = await createApi({ registry: { resolve: async () => { resolved++; return tenant; } } });
  await Promise.all([get(handle, '/api/v1/products'), get(handle, '/api/v1/products'), get(handle, '/health')]);
  await get(handle, '/api/v1/shop');
  assert.equal(resolved, 4, 'every request is resolved');
  assert.equal(setupReads, 1, 'four requests, three of them at once, built the route table exactly once');
});

test('a failing registry or tenant setup answers 500 without leaking details and recovers', async (t) => {
  const store = await shop(t, 'Flaky');
  let fail = true;
  const handle = await createApi({ registry: { resolve: async () => { if (fail) throw new Error('registry down: secret-detail'); return { id: 'f', code: 'f', status: 'ACTIVE', store, config }; } } });
  const down = await get(handle, '/health');
  assert.equal(down.status, 500); assert.ok(!JSON.stringify(await down.json()).includes('secret-detail'));
  fail = false;
  assert.equal((await get(handle, '/health')).status, 200);
});
