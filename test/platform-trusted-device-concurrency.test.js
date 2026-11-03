import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { createAdminAuth } from '../src/platform/admin-auth.js';
import { createPlatformRoutes } from '../src/platform/admin-routes.js';
import { totpCode } from '../src/platform/totp.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

// Independent review question: can one authenticator code, sent twice at once on one password-stage session, issue two sessions?
test('concurrent confirmations of one code on one sign-in issue exactly one session, and a trusted sign-in is audited with its duration', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  let now = 1_700_000_000_000;
  const config = { shopMode: 'manual', publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { adminHost: 'admin.example.test' } };
  const password = randomBytes(24).toString('base64url');
  await createAdminAuth({ ...f, clock: () => now }).bootstrap('owner', password);
  const routes = createPlatformRoutes({ ...f, config, registry: { invalidate() {} }, defaultStore: store, clock: () => now });
  const handle = await createApi({ store, config, platformHandler: routes });
  let cookie = '', csrf = '';
  const call = (path, method = 'GET', body) => handle(new Request(`https://admin.example.test/api/v1/platform${path}`, {
    method, headers: { origin: 'https://admin.example.test', cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  }), { clientAddress: 'fictional-trusted-device-concurrency' });
  const signIn = async () => {
    const challenge = await call('/csrf'); cookie = challenge.headers.get('set-cookie').split(';')[0]; csrf = (await challenge.json()).csrfToken;
    const first = await call('/session', 'POST', { username: 'owner', password }); assert.equal(first.status, 200);
    cookie = first.headers.get('set-cookie').split(';')[0]; csrf = (await first.json()).csrfToken;
  };
  await signIn();
  const setup = await (await call('/totp/enrol', 'POST', {})).json();
  assert.equal((await call('/totp/confirm', 'POST', { code: totpCode(setup.setupKey, Math.floor(now / 30_000)) })).status, 200);
  for (const trusted of [false, true]) {
    now += 60_000; await signIn();
    const body = { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), ...(trusted ? { trustedDevice: true, trustedDeviceDuration: '1y' } : {}) };
    const replies = await Promise.all([call('/totp/confirm', 'POST', body), call('/totp/confirm', 'POST', body), call('/totp/confirm', 'POST', body)]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 401, 401].sort(), `exactly one of three simultaneous confirmations succeeds (trusted: ${trusted})`);
    const issued = replies.filter((reply) => reply.status === 200).length;
    assert.equal(issued, 1);
  }
  const trustedAudit = await f.platform.all("SELECT action, detail FROM platform_audit WHERE detail LIKE '%trusted%'");
  assert.equal(trustedAudit.length, 1, 'only the trusted sign-in is marked');
  assert.match(trustedAudit[0].detail, /trusted device.*365 days/i); assert.ok(!/token|cookie/i.test(trustedAudit[0].detail));
});
