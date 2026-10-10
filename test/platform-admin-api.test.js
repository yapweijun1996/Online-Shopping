import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { readConfig, readPlatformConfig } from '../src/config.js';
import { createAdminAuth } from '../src/platform/admin-auth.js';
import { createPlatformRoutes } from '../src/platform/admin-routes.js';
import { totpCode } from '../src/platform/totp.js';
import { serveStatic } from '../src/static.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('platform is inert without settings and missing enabled configuration fails closed', () => {
  assert.equal(readPlatformConfig({}, null), null);
  assert.equal(readPlatformConfig({ PLATFORM_ENABLED: '0', PLATFORM_ADMIN_HOST: 'invalid' }, null), null);
  assert.throws(() => readPlatformConfig({ PLATFORM_ENABLED: 'wrong' }, null), /PLATFORM_ENABLED/);
  assert.throws(() => readPlatformConfig({ PLATFORM_ENABLED: '1' }, null), /INTEGRATION_KEY_FILE/);
  const password = randomBytes(24).toString('hex');
  assert.equal(readConfig({ ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: password }).platform, null);
});

test('platform host separation, Origin and CSRF on every write, restricted endpoint denial and no-store', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'manual', publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { adminHost: 'admin.example.test' } };
  const password = randomBytes(24).toString('hex'), clock = 1_700_000_000_000;
  await createAdminAuth({ ...f, clock: () => clock }).bootstrap('owner', password);
  const routes = createPlatformRoutes({ ...f, config, registry: { invalidate() {} }, defaultStore: store, clock: () => clock });
  const handle = await createApi({ store, config, platformHandler: routes, serveStatic });
  let cookie = '', csrf = '';
  async function call(path, method = 'GET', body, overrides = {}) {
    const headers = { origin: 'https://admin.example.test', cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...overrides };
    return handle(new Request(`https://admin.example.test/api/v1/platform${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), { clientAddress: 'fictional-platform-api' });
  }
  for (const host of ['shop.example.test', 'seller.example.test', 'admin.example.test.evil']) {
    assert.equal((await handle(new Request(`https://${host}/api/v1/platform/session`))).status, 404);
    assert.equal((await handle(new Request(`https://${host}/platform/`))).status, 404);
  }
  assert.equal((await handle(new Request('https://admin.example.test/shop/'))).status, 404);
  assert.equal((await handle(new Request('https://admin.example.test/platform/'))).status, 200);
  assert.equal((await call('/session')).status, 401);
  assert.equal((await call('/session', 'POST', { username: 'owner', password })).status, 403);
  const challenge = await call('/csrf'); cookie = challenge.headers.get('set-cookie').split(';')[0]; csrf = (await challenge.json()).csrfToken;
  assert.equal((await call('/session', 'POST', { username: 'owner', password }, { origin: 'https://evil.example.test' })).status, 403);
  const first = await call('/session', 'POST', { username: 'owner', password }); assert.equal(first.status, 200);
  cookie = first.headers.get('set-cookie').split(';')[0]; csrf = (await first.json()).csrfToken;
  const writes = [['/shops', { code: 'fictional', name: 'Fictional', currency: 'MYR', sellerUsername: 'fictional.owner' }],
    ['/shops/00000000-0000-4000-8000-000000000000/suspend', { expectedRevision: 0 }],
    ['/account/password', { currentPassword: password, newPassword: randomBytes(24).toString('hex') }], ['/account/recovery-codes', { password }]];
  for (const [path, body] of writes) {
    assert.equal((await call(path, 'POST', body)).status, 403, path);
    assert.equal((await call(path, 'POST', body, { 'x-csrf-token': '' })).status, 403, path);
    assert.equal((await call(path, 'POST', body, { origin: 'https://evil.example.test' })).status, 403, path);
  }
  for (const path of ['/shops', '/audit', '/status']) assert.equal((await call(path)).status, 403, path);
  assert.equal((await call('/totp/enrol', 'POST', {}, { 'x-csrf-token': '' })).status, 403);
  const setup = await (await call('/totp/enrol', 'POST', {})).json();
  const confirmed = await call('/totp/confirm', 'POST', { code: totpCode(setup.setupKey, Math.floor(clock / 30_000)) });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.headers.get('cache-control'), 'no-store');
  cookie = confirmed.headers.get('set-cookie').split(';')[0]; csrf = (await confirmed.json()).csrfToken;
  for (const [path, body] of writes) {
    assert.equal((await call(path, 'POST', body, { 'x-csrf-token': '' })).status, 403, path);
    assert.equal((await call(path, 'POST', body, { 'x-csrf-token': 'wrong' })).status, 403, path);
    assert.equal((await call(path, 'POST', body, { 'x-csrf-token': 'é'.repeat(csrf.length) })).status, 403, path);
    assert.equal((await call(path, 'POST', body, { origin: 'https://evil.example.test' })).status, 403, path);
  }
  assert.equal((await call('/shops', 'POST', writes[0][1])).status, 201);
  assert.equal((await call('/status')).status, 200);
  assert.equal((await call('/session', 'DELETE', undefined, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await call('/session', 'DELETE')).status, 200); assert.equal((await call('/session')).status, 401);
});
