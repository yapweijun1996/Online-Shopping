import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { createPlatformRegistry, rewriteTenantRequest } from '../src/platform/registry.js';
import { RESERVED_CODES } from '../src/platform/tenant-code.js';
import { serveStatic } from '../src/static.js';

const config = { shopMode: 'manual', sellerQuickLogin: true, username: 'bootstrap', password: 'must-not-reach-tenant',
  publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { adminHost: 'admin.example.test' } };
const request = (path, host = 'shop.example.test', options) => {
  const result = new Request(`https://${host}${path}`, options);
  Object.defineProperty(result, 'shopRawTarget', { value: path });
  return result;
};
async function fixture(t, options = {}) {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  const rows = new Map(['ACTIVE', 'SUSPENDED', 'DELETING', 'PROVISIONING', 'FAILED'].map((status) => [status.toLowerCase(), { id: status, code: status.toLowerCase(), status, name: status, is_default: 0 }]));
  rows.set('123', { id: 'digits', code: '123', status: 'ACTIVE', name: 'Digits', is_default: 0 });
  let reads = 0, opens = 0, currentStore = store;
  const platform = { get: async (sql, code) => { reads++; return sql.includes('tenant_code_alias') ? code === 'oldcode' ? rows.get('active') : undefined : rows.get(code); } };
  const pool = { get: async () => { opens++; return currentStore; } };
  const registry = createPlatformRegistry({ store, config, platform, pool, ...options });
  const handle = await createApi({ store, config, registry, serveStatic });
  return { store, rows, registry, handle, reads: () => reads, opens: () => opens, replaceStore: (value) => { currentStore = value; } };
}

test('known, unknown and unavailable codes, malformed and reserved paths open no rejected tenant', async (t) => {
  const f = await fixture(t);
  for (const code of ['unknown', 'provisioning', 'failed', 'UPPER', 'ab', 'a'.repeat(31), 'shop', 'seller', 'platform', 'index.html', '%2e%2e', '%2f', 'actіve', 'active.', 'active%2fother']) {
    const before = f.opens(); assert.equal((await f.handle(request(`/${code}/api/v1/shop`))).status, 404, code); assert.equal(f.opens(), before);
  }
  for (const code of ['suspended', 'deleting']) {
    const result = await f.handle(request(`/${code}/api/v1/shop`)); assert.equal(result.status, 503); assert.equal((await result.json()).error.code, 'SHOP_UNAVAILABLE');
  }
  assert.equal(f.opens(), 0);
  assert.equal((await f.handle(request('/active/api/v1/shop'))).status, 200);
  assert.equal((await f.handle(request('/123/api/v1/shop'))).status, 200);
  const tenant = await f.registry.resolve(request('/active/shop/'));
  assert.equal(tenant.config.sellerQuickLogin, false); assert.equal(tenant.config.shopMode, 'manual'); assert.equal(tenant.config.username, undefined);
  assert.equal(tenant.config.password, undefined); assert.equal(tenant.config.platform, undefined); assert.match(tenant.config.storageScope, /^t-[a-f0-9]{12}$/);
  assert.equal((await f.handle(request('/active//api/v1/shop'))).status, 404);
  assert.equal((await f.handle(request('/active/' + 'x'.repeat(9000)))).status, 404);
  for (const method of ['HEAD', 'OPTIONS']) assert.equal((await f.handle(request('/missing/api/v1/shop', undefined, { method }))).status, 404);
});

test('rewritten streaming POST retains method, headers, query and bytes', async () => {
  const bytes = new TextEncoder().encode('{"fictional":"streamed"}');
  const source = request('/abc/api/v1/orders?key=value', undefined, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture': 'yes' },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), duplex: 'half' });
  const result = rewriteTenantRequest(source, '/abc');
  assert.equal(new URL(result.url).pathname, '/api/v1/orders'); assert.equal(new URL(result.url).search, '?key=value');
  assert.equal(result.method, 'POST'); assert.equal(result.headers.get('x-fixture'), 'yes'); assert.equal(await result.text(), new TextDecoder().decode(bytes));
});

test('aliases keep path and query; dynamic manifests and root redirects follow the tenant', async (t) => {
  const f = await fixture(t);
  const alias = await f.handle(request('/oldcode/shop/?search=fictional')); assert.equal(alias.status, 308); assert.equal(alias.headers.get('location'), '/active/shop/?search=fictional');
  assert.equal(f.opens(), 0);
  for (const app of ['shop', 'seller']) {
    const manifest = await f.handle(request(`/active/${app}/manifest.webmanifest`)); assert.equal(manifest.status, 200);
    const body = await manifest.json(); assert.equal(body.id, `/active/${app}/`); assert.equal(body.scope, body.start_url);
    assert.equal((await f.handle(request('/active/', `${app}.example.test`))).headers.get('location'), `/active/${app}/`);
  }
});

test('registry cache is bounded, negatively caches and blocks probing before database lookup', async (t) => {
  let clock = 0; const f = await fixture(t, { clock: () => clock });
  await f.registry.resolve(request('/missing/shop/')); const before = f.reads();
  await f.registry.resolve(request('/missing/shop/')); assert.equal(f.reads(), before);
  clock += 10_001; await f.registry.resolve(request('/missing/shop/')); assert.ok(f.reads() > before);
  for (let i = 0; i < 1100; i++) await f.registry.resolve(request(`/missing${i}/shop/`), { clientAddress: `fictional-${i}` });
  assert.equal(f.registry.cacheSize(), 1000);
  for (let i = 0; i < 30; i++) await f.registry.resolve(request(`/probe${i}/shop/`), { clientAddress: 'bounded-probe' });
  const reads = f.reads(); await assert.rejects(f.registry.resolve(request('/lastprobe/shop/'), { clientAddress: 'bounded-probe' }), /Too many/); assert.equal(f.reads(), reads);
});

test('an evicted store produces a new tenant identity and rebuilds the route handler', async (t) => {
  const f = await fixture(t); const first = await f.registry.resolve(request('/active/api/v1/shop'));
  assert.equal((await f.handle(request('/active/api/v1/shop'))).status, 200);
  const other = await openDatabase(':memory:'); t.after(() => other.close());
  await other.run("UPDATE shop_setup SET shop_name = 'Reopened shop' WHERE id = 1");
  f.replaceStore(other); const reopened = await f.registry.resolve(request('/active/api/v1/shop'));
  assert.notEqual(reopened, first);
  const result = await f.handle(request('/active/api/v1/shop')); assert.equal(result.status, 200); assert.equal((await result.json()).shopName, 'Reopened shop');
});

test('expired known shops never consume the unknown-code probe quota on a shared IP', async (t) => {
  let clock = 0; const f = await fixture(t, { clock: () => clock });
  for (let pass = 0; pass < 25; pass++) {
    for (const code of ['active', '123']) assert.equal((await f.handle(request(`/${code}/api/v1/tenant-access`), { clientAddress: 'fictional-household' })).status, 200);
    clock += 30_001;
  }
  for (let i = 0; i < 30; i++) await f.registry.resolve(request(`/unknown${i}/shop/`), { clientAddress: 'fictional-household' });
  const reads = f.reads();
  await assert.rejects(f.registry.resolve(request('/unknownlast/shop/'), { clientAddress: 'fictional-household' }), /Too many/);
  assert.equal(f.reads(), reads); assert.equal(f.opens(), 0);
});

test('every public top-level name and served entry point is invalid as a code or reserved', async () => {
  const names = [...await readdir(new URL('../public/', import.meta.url)), 'api', 'health', 'ready', 'p', 's', 'platform'];
  for (const name of names) assert.ok(!/^[a-z0-9]{3,30}$/.test(name) || RESERVED_CODES.has(name), name);
});

test('platform lookup failures do not strand a valid cold code behind the probe limiter', async (t) => {
  const f = await fixture(t); let offline = true;
  const registry = createPlatformRegistry({ store: f.store, config, platform: () => {
    if (offline) throw new Error('Synthetic platform outage');
    return { get: async () => f.rows.get('active') };
  }, pool: { get() { throw new Error('Metadata probe must not open a shop'); } } });
  for (let i = 0; i < 35; i++) await assert.rejects(registry.resolve(request('/active/api/v1/tenant-access')), /Synthetic platform outage/);
  offline = false;
  assert.equal((await registry.resolve(request('/active/api/v1/tenant-access'))).response.status, 200);
});

test('edge availability probes enforce lifecycle and aliases without opening tenant databases', async (t) => {
  const f = await fixture(t);
  for (const [code, status] of [['active', 200], ['missing', 404], ['failed', 404], ['provisioning', 404], ['suspended', 503], ['deleting', 503]]) {
    assert.equal((await f.handle(request(`/${code}/api/v1/tenant-access`))).status, status);
  }
  const alias = await f.handle(request('/oldcode/api/v1/tenant-access', undefined, { headers: { 'x-tenant-original-uri': '/oldcode/shop/?search=fixture&category=1' } }));
  assert.equal(alias.status, 308); assert.equal(alias.headers.get('location'), '/active/shop/?search=fixture&category=1');
  assert.equal(f.opens(), 0);
});
