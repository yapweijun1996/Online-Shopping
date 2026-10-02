import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApi } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { initializeShop, setupShop } from '../src/shop-setup.js';
import { createDemoSandbox } from '../src/demo-sandbox.js';
import { errorResponse } from '../src/http.js';
import worker from '../src/worker.js';

function fixture(t, mode = 'public-demo') {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: mode, production: true, publicOrigin: 'https://demo.example.test', username: 'synthetic-owner' };
  initializeShop(store, config);
  if (mode === 'manual') setupShop(store, { mode: 'production', shopName: 'Synthetic production fixture' });
  const handle = createApi({ store, config, serveStatic: () => new Response('fixture asset') });
  const call = async (method, path, body, session = {}, overrides = {}) => {
    const response = await handle(new Request(`https://demo.example.test${path.startsWith('/') ? path : '/api/v1/demo/' + path}`, {
      method, headers: { origin: config.publicOrigin, ...(body ? { 'content-type': 'application/json' } : {}),
        ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.csrfToken ? { 'x-csrf-token': session.csrfToken } : {}), ...overrides },
      body: body ? JSON.stringify(body) : undefined,
    }), { clientAddress: 'synthetic-local-client' });
    return { status: response.status, response, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null };
  };
  const login = async role => {
    const result = await call('POST', 'session', { role }); assert.equal(result.status, 201);
    assert.match(result.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
    return { cookie: result.response.headers.get('set-cookie').split(';')[0], csrfToken: result.data.csrfToken };
  };
  return { store, call, login };
}

test('passwordless fictional roles cannot authorize the existing seller API or change persistent rows', async t => {
  const f = fixture(t), before = f.store.all('SELECT * FROM product ORDER BY id');
  assert.equal((await f.call('GET', '/api/v1/shop')).data.demoRolesAvailable, true);
  assert.equal((await f.call('GET', 'availability')).status, 200);
  assert.equal((await f.call('POST', 'session', { role: 'SUPER_ADMIN' })).status, 400);
  assert.equal((await f.call('POST', 'session', { role: 'ADMIN', companyId: 'forged' })).status, 400);
  assert.equal((await f.call('POST', 'session', { role: 'ADMIN' }, {}, { origin: 'https://attacker.invalid' })).status, 403);
  const session = await f.login('SELLER');
  assert.equal((await f.call('GET', 'companies', null, session)).data.items.length, 1);
  for (const path of ['/api/v1/seller/session', '/api/v1/seller/products', '/api/v1/seller/orders', '/api/v1/seller/company-settings']) assert.equal((await f.call('GET', path, null, session)).status, 401);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM session').n, 0);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM shop_order').n, 0);
  assert.deepEqual(f.store.all('SELECT * FROM product ORDER BY id'), before);
});

test('production and legacy demo modes expose no bypass endpoints or demo pages, including encoded paths', async t => {
  for (const mode of ['manual', 'demo']) {
    const f = fixture(t, mode);
    assert.equal((await f.call('GET', '/api/v1/shop')).data.demoRolesAvailable, false);
    assert.equal((await f.call('GET', 'availability')).status, 404);
    for (const [method, path, body] of [['POST', 'session', { role: 'ADMIN' }], ['GET', 'companies'], ['POST', 'reset', {}]]) assert.equal((await f.call(method, path, body)).status, 404);
    for (const path of ['/demo', '/demo/', '/demo/index.html', '/%64emo/', '//demo/index.html']) assert.equal((await f.call('GET', path)).status, 404, path);
  }
  let assets = 0;
  const env = { SHOP_MODE: 'manual', ASSETS: { fetch() { assets++; return new Response('asset'); } } };
  for (const path of ['/demo', '/demo/', '/%64emo/index.html', '//demo/app.js']) assert.equal((await worker.fetch(new Request('https://example.test' + path), env)).status, 404);
  assert.equal(assets, 0);
  assert.match(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), /"run_worker_first": true/);
  const proxy = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.match(proxy, /@demo path \/demo \/demo\/\*/);
  assert.match(proxy, /forward_auth backend:3000\s*\{\s*uri \/api\/v1\/demo\/availability/);
  assert.ok(proxy.indexOf('handle @demo') < proxy.indexOf('file_server'));
  assert.doesNotMatch(readFileSync(new URL('../public/seller/index.html', import.meta.url), 'utf8'), /Login as Admin|Login as Demo Seller/);
});

test('malformed product bodies, missing CSRF and foreign origins cannot mutate fictional records', async t => {
  const f = fixture(t), session = await f.login('SELLER');
  const path = 'companies/company-alpha/products', products = (await f.call('GET', path, null, session)).data.items;
  for (const body of [[], 'bad', { expectedRevision: 1, companyId: 'company-beta' }]) assert.equal((await f.call('PATCH', `${path}/${products[0].id}`, body, session)).status, 400);
  assert.equal((await f.call('PATCH', `${path}/${products[0].id}`, { expectedRevision: 1, name: 'blocked' }, session, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.call('PATCH', `${path}/${products[0].id}`, { expectedRevision: 1, name: 'blocked' }, session, { origin: 'https://attacker.invalid' })).status, 403);
  assert.deepEqual((await f.call('GET', path, null, session)).data.items, products);
});

test('seller rejects foreign company and resource IDs, spoofed roles and access administration', async t => {
  const f = fixture(t), session = await f.login('ADMIN');
  const alpha = (await f.call('GET', 'companies/company-alpha/products', null, session)).data.items;
  const beta = (await f.call('GET', 'companies/company-beta/products', null, session)).data.items;
  const orders = (await f.call('GET', 'companies/company-beta/orders', null, session)).data.items;
  const customers = (await f.call('GET', 'companies/company-beta/customers', null, session)).data.items;
  session.csrfToken = (await f.call('POST', 'assume-seller', { sellerId: 'seller-alpha' }, session)).data.csrfToken;
  assert.equal((await f.call('GET', 'companies', null, session)).data.items.length, 1);
  for (const [method, path, body] of [
    ['GET', 'companies/company-beta'], ['GET', 'companies/company-beta/products'], ['GET', 'companies/company-beta/orders'], ['GET', 'companies/company-beta/customers'],
    ['GET', `companies/company-alpha/products/${beta[0].id}`], ['GET', `companies/company-alpha/orders/${orders[0].id}`], ['GET', `companies/company-alpha/customers/${customers[0].id}`],
    ['PATCH', `companies/company-beta/products/${beta[0].id}`, { name: 'forged', expectedRevision: 1 }],
    ['POST', `companies/company-beta/orders/${orders[0].id}/confirm`, { expectedRevision: 1 }],
  ]) assert.equal((await f.call(method, path, body, session, { 'x-company-id': 'company-beta', 'x-role': 'ADMIN' })).status, 404, path);
  for (const [method, path, body] of [
    ['GET', 'sellers'], ['POST', 'companies', { name: 'forged', currency: 'MYR' }], ['POST', 'sellers', { name: 'forged', companyId: 'company-alpha' }],
    ['POST', 'assume-seller', { sellerId: 'seller-beta' }], ['PATCH', 'companies/company-alpha', { name: 'forged', expectedRevision: 1 }],
  ]) assert.equal((await f.call(method, path, body, session)).status, 403, path);
  assert.equal((await f.call('PATCH', `companies/company-alpha/products/${alpha[0].id}`, { expectedRevision: 1, companyId: 'company-beta' }, session)).status, 400);
  assert.equal((await f.call('GET', `companies/company-alpha/products/${alpha[0].id}`, null, session)).data.revision, 1);
});

test('logins are isolated; reset invalidates CSRF and IDs; exit destroys only its own workspace', async t => {
  const f = fixture(t), a = await f.login('ADMIN'), b = await f.login('ADMIN');
  const product = (await f.call('GET', 'companies/company-alpha/products', null, a)).data.items[0];
  assert.equal((await f.call('PATCH', `companies/company-alpha/products/${product.id}`, { expectedRevision: 1, name: 'Fictional edit' }, a)).status, 200);
  assert.equal((await f.call('GET', `companies/company-alpha/products/${product.id}`, null, b)).status, 404);
  assert.notEqual((await f.call('GET', 'companies/company-alpha/products', null, b)).data.items[0].name, 'Fictional edit');
  const oldCsrf = a.csrfToken;
  a.csrfToken = (await f.call('POST', 'reset', {}, a)).data.csrfToken;
  assert.notEqual(a.csrfToken, oldCsrf);
  assert.equal((await f.call('GET', `companies/company-alpha/products/${product.id}`, null, a)).status, 404);
  assert.equal((await f.call('POST', 'reset', {}, { ...a, csrfToken: oldCsrf })).status, 403);
  assert.equal((await f.call('DELETE', 'session', null, a)).status, 200);
  assert.equal((await f.call('GET', 'companies', null, a)).status, 401);
  assert.equal((await f.call('GET', 'companies', null, b)).status, 200);
  assert.equal((await f.call('GET', 'companies', null, { cookie: 'os_fictional_demo=forged' })).status, 401);
});

test('admin manages fictional companies and sellers; disabled access and companies cannot be assumed', async t => {
  const f = fixture(t), session = await f.login('ADMIN');
  assert.equal((await f.call('POST', 'companies', { name: 'Fictional Gamma', currency: 'SGD' }, session, { 'x-csrf-token': '' })).status, 403);
  const company = await f.call('POST', 'companies', { name: 'Fictional Gamma', currency: 'SGD' }, session); assert.equal(company.status, 201);
  const seller = await f.call('POST', 'sellers', { name: 'Demo Gamma', companyId: company.data.id }, session); assert.equal(seller.status, 201);
  assert.equal((await f.call('PATCH', `sellers/${seller.data.id}`, { active: false, expectedRevision: 1 }, session)).status, 200);
  assert.equal((await f.call('POST', 'assume-seller', { sellerId: seller.data.id }, session)).status, 404);
  assert.equal((await f.call('PATCH', 'companies/company-alpha', { active: false, expectedRevision: 1 }, session)).status, 200);
  assert.equal((await f.call('POST', 'assume-seller', { sellerId: 'seller-alpha' }, session)).status, 404);
  assert.equal((await f.call('POST', 'sellers', { name: 'forged', companyId: 'unknown' }, session)).status, 404);
});

test('synthetic API enforces currency, company SKU scope, revision races and immutable order snapshots', async t => {
  const f = fixture(t), session = await f.login('ADMIN');
  const product = (await f.call('GET', 'companies/company-alpha/products', null, session)).data.items[0];
  const original = (await f.call('GET', 'companies/company-alpha/orders', null, session)).data.items[0];
  assert.equal((await f.call('PATCH', 'companies/company-alpha', { currency: 'SGD', expectedRevision: 1 }, session)).status, 409);
  assert.equal((await f.call('PATCH', `companies/company-alpha/products/${product.id}`, { currency: 'SGD', expectedRevision: 1 }, session)).status, 400);
  const edits = await Promise.all([1100, 1200].map(priceMinor => f.call('PATCH', `companies/company-alpha/products/${product.id}`, { priceMinor, expectedRevision: 1 }, session)));
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
  assert.deepEqual((await f.call('GET', `companies/company-alpha/orders/${original.id}`, null, session)).data, original);
  const input = { sku: 'SAME-SKU', name: 'Fictional new product', description: 'Synthetic only', category: 'GENERAL', priceMinor: 100, active: true };
  const alpha = await f.call('POST', 'companies/company-alpha/products', input, session), beta = await f.call('POST', 'companies/company-beta/products', input, session);
  assert.equal(alpha.status, 201); assert.equal(alpha.data.currency, 'MYR'); assert.equal(beta.status, 201); assert.equal(beta.data.currency, 'SGD');
  assert.equal((await f.call('POST', 'companies/company-alpha/products', input, session)).status, 409);
  const decisions = await Promise.all(['confirm', 'reject'].map(action => f.call('POST', `companies/company-alpha/orders/${original.id}/${action}`, { expectedRevision: 1, ...(action === 'reject' ? { reason: 'Fictional rejection' } : {}) }, session)));
  assert.deepEqual(decisions.map(result => result.status).sort(), [200, 409]);
  const order = (await f.call('GET', `companies/company-alpha/orders/${original.id}`, null, session)).data;
  assert.equal(order.events.length, 2); assert.equal(order.events[1].actor, 'demo-admin'); assert.deepEqual(order.items, original.items);
});

test('audit failure rolls back synthetic changes; expired sessions and login bursts fail closed', async t => {
  const f = fixture(t), session = await f.login('ADMIN');
  const product = (await f.call('GET', 'companies/company-alpha/products', null, session)).data.items[0];
  for (let i = 0; i < 100; i++) assert.equal((await f.call('PATCH', `companies/company-alpha/products/${product.id}`, { expectedRevision: i + 1, priceMinor: 100 + i }, session)).status, 200);
  const before = (await f.call('GET', `companies/company-alpha/products/${product.id}`, null, session)).data;
  assert.equal((await f.call('PATCH', `companies/company-alpha/products/${product.id}`, { expectedRevision: 101, name: 'must roll back' }, session)).status, 409);
  assert.deepEqual((await f.call('GET', `companies/company-alpha/products/${product.id}`, null, session)).data, before);
  for (let i = 1; i < 10; i++) await f.login('SELLER');
  assert.equal((await f.call('POST', 'session', { role: 'ADMIN' })).status, 429);
  let clock = 0;
  const route = createDemoSandbox({ enabled: true, now: () => clock });
  const login = await route(new Request('https://fixture.test/api/v1/demo/session', { method: 'POST', headers: { origin: 'https://fixture.test', 'content-type': 'application/json' }, body: '{"role":"SELLER"}' }), 'https://fixture.test');
  clock = 3600001;
  let expired;
  try { await route(new Request('https://fixture.test/api/v1/demo/session', { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } }), 'https://fixture.test'); }
  catch (error) { expired = errorResponse(error); }
  assert.equal(expired.status, 401);
});
