import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { createAdminAuth } from '../src/platform/admin-auth.js';
import { createPlatformRoutes } from '../src/platform/admin-routes.js';
import { totpCode } from '../src/platform/totp.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('HTTP trusted-device sessions are MFA/Origin/CSRF guarded, persistent after inactivity, and cleared on logout', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  let now = 1_700_000_000_000;
  const config = { shopMode: 'manual', publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { adminHost: 'admin.example.test' } };
  const password = randomBytes(24).toString('base64url');
  await createAdminAuth({ ...f, clock: () => now }).bootstrap('owner', password);
  const routes = createPlatformRoutes({ ...f, config, registry: { invalidate() {} }, defaultStore: store, clock: () => now });
  const handle = await createApi({ store, config, platformHandler: routes });
  let cookie = '', csrf = '';
  async function call(path, method = 'GET', body, overrides = {}) {
    return handle(new Request(`https://admin.example.test/api/v1/platform${path}`, {
      method, headers: { origin: 'https://admin.example.test', cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...overrides },
      ...(body ? { body: JSON.stringify(body) } : {})
    }), { clientAddress: 'fictional-trusted-device-api' });
  }
  const challenge = await call('/csrf'); cookie = challenge.headers.get('set-cookie').split(';')[0]; csrf = (await challenge.json()).csrfToken;
  const first = await call('/session', 'POST', { username: 'owner', password, trustedDevice: true, trustedDeviceDuration: '1y' });
  assert.equal(first.status, 200); assert.match(first.headers.get('set-cookie'), /Max-Age=300$/);
  cookie = first.headers.get('set-cookie').split(';')[0]; csrf = (await first.json()).csrfToken;
  assert.equal((await call('/status')).status, 403);
  const setup = await (await call('/totp/enrol', 'POST', {})).json();
  const body = { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), trustedDevice: true, trustedDeviceDuration: '1y' };
  assert.equal((await call('/totp/confirm', 'POST', body, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await call('/totp/confirm', 'POST', body, { origin: 'https://evil.example.test' })).status, 403);
  const confirmed = await call('/totp/confirm', 'POST', body);
  assert.equal(confirmed.status, 200); assert.equal(confirmed.headers.get('cache-control'), 'no-store');
  assert.match(confirmed.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Secure; Path=\/api\/v1\/platform; Max-Age=31536000$/);
  const value = await confirmed.json(); assert.equal(Object.hasOwn(value, 'token'), false);
  const oldCookie = cookie; cookie = confirmed.headers.get('set-cookie').split(';')[0]; csrf = value.csrfToken;
  assert.notEqual(cookie, oldCookie);
  now += 20 * 24 * 60 * 60_000;
  const restored = await call('/session'); assert.equal(restored.status, 200); assert.equal((await restored.json()).stage, 'FULL');
  assert.equal((await call('/session', 'DELETE', undefined, { 'x-csrf-token': '' })).status, 403);
  const signedOut = await call('/session', 'DELETE'); assert.equal(signedOut.status, 200); assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0$/);
  assert.equal((await call('/session')).status, 401);
});
