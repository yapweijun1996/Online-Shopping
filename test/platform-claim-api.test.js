import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { issueAdminClaim } from '../src/platform/admin-claim.js';
import { createSetupRoutes } from '../src/platform/setup-routes.js';
import { createPlatformRoutes } from '../src/platform/admin-routes.js';
import { createApi } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { totpCode } from '../src/platform/totp.js';

async function fixture(t) {
  const f = await platformFixture(t), store = await openDatabase(':memory:');
  t.after(() => store.close());
  const config = { publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { claimEnabled: true, adminHost: 'admin.example.test' } };
  const routes = () => createSetupRoutes({ ...f, config });
  const handle = await createApi({ store, config, setupHandler: routes(), platformHandler: createPlatformRoutes({ ...f, config, registry: {}, defaultStore: store }) });
  const issue = () => issueAdminClaim(f.platform, config, new Date(Date.now() + 1).toISOString(), () => false);
  const event = await issue(), code = new URL(event.url).hash.slice(1), password = randomBytes(24).toString('hex');
  const body = { code, username: 'claim.owner', email: 'Contact@Example.test', password };
  let ip = 0;
  const call = (path = 'claim', value = body, options = {}) => handle(new Request(`https://${options.host || 'shop.example.test'}/api/v1/setup/${path}`, {
    method: path === 'status' ? 'GET' : 'POST', headers: { origin: config.publicOrigin, 'content-type': 'application/json', ...options.headers },
    ...(path === 'status' ? {} : { body: options.raw ?? JSON.stringify(value) }),
  }), { clientAddress: options.ip || `fictional-${ip++}` });
  return { ...f, store, config, handle, issue, body, call, routes };
}
const absent = { error: { code: 'NOT_FOUND', message: 'Not found.' } };

test('claim status, proof, validation, limits and exhausted generation are generic and durable', { skip: !platformTestUrl }, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.call('status')).json(), { open: true });
  for (const host of ['seller.example.test', 'admin.example.test', 'shop.example.test.evil']) assert.deepEqual(await (await f.call('status', null, { host })).json(), absent);
  for (const headers of [{ origin: '' }, { origin: 'https://evil.example.test', 'x-csrf-token': 'anything' }]) assert.deepEqual(await (await f.call('claim', f.body, { headers })).json(), absent);
  for (const raw of ['{', JSON.stringify({ code: 'x'.repeat(5000) })]) assert.deepEqual(await (await f.call('claim', null, { raw })).json(), absent);
  for (const patch of [{ email: 'a@@example.test' }, { email: 'a\n@example.test' }, { email: 'a..b@example.test' }, { email: 'a@-bad.test' }, { email: 'a'.repeat(65) + '@example.test' }, { username: 'a@b' }, { password: 'short' }, { password: 'prefixclaim.ownerSuffix' }, { role: 'FULL' }]) {
    const response = await f.call('claim', { ...f.body, ...patch });
    assert.equal(response.status, 400);
    assert.equal((await f.platform.get('SELECT closed_at FROM platform_admin_claim')).closed_at, null);
  }
  for (let n = 0; n < 5; n++) assert.equal((await f.call('claim', { ...f.body, email: 'bad' }, { ip: 'limited' })).status, 400);
  assert.deepEqual(await (await f.call('claim', f.body, { ip: 'limited' })).json(), absent);
  assert.equal((await f.platform.get("SELECT count(*) AS n FROM platform_audit WHERE action='ADMIN_CLAIM_RATE_LIMITED'")).n, 1);
  for (let n = 0; n < 5; n++) assert.deepEqual(await (await f.call('claim', { ...f.body, code: n ? 'wrong' : undefined })).json(), absent);
  assert.equal((await f.platform.get('SELECT attempts FROM platform_admin_claim')).attempts, 5);
  assert.equal((await f.platform.get('SELECT attempts FROM platform_admin_claim_generation')).attempts, 5);
  assert.deepEqual(await (await f.call('status')).json(), absent);
  assert.deepEqual(await (await f.call()).json(), absent);
  assert.equal((await f.platform.get('SELECT count(*) AS n FROM platform_admin')).n, 0);
});

test('claim races produce one restricted session, enforce MFA and stay closed across restart', { skip: !platformTestUrl }, async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.call(), f.call('claim', { ...f.body, username: 'other.owner' })]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 404]);
  const winner = responses.find((r) => r.status === 200), cookie = winner.headers.get('set-cookie').split(';')[0], view = await winner.json();
  assert.equal(view.stage, 'PASSWORD'); assert.equal(view.totpEnabled, false);
  assert.equal(view.nextUrl, 'https://admin.example.test/platform/');
  assert.match(winner.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Secure; Path=\/api\/v1\/platform/);
  assert.equal((await f.platform.get('SELECT email FROM platform_admin')).email, 'contact@example.test');
  const admin = (path, body, csrf = view.csrfToken) => f.handle(new Request(`https://admin.example.test/api/v1/platform/${path}`, { method: body ? 'POST' : 'GET', headers: { cookie, origin: 'https://admin.example.test', 'x-csrf-token': csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  assert.equal((await admin('shops')).status, 403);
  assert.equal((await admin('totp/enrol', {}, '')).status, 403);
  const setup = await (await admin('totp/enrol', {})).json();
  const confirmed = await admin('totp/confirm', { code: totpCode(setup.setupKey, Math.floor(Date.now() / 30_000)) });
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).stage, 'FULL');
  assert.equal(await f.issue(), null);
  assert.deepEqual(await (await f.routes()(new Request('https://shop.example.test/api/v1/setup/status'))).json(), absent);
  assert.deepEqual(await (await f.call()).json(), absent);
  assert.equal((await f.platform.get('SELECT count(*) AS n FROM platform_admin')).n, 1);
  assert.equal((await f.platform.get("SELECT count(*) AS n FROM platform_audit WHERE action='ADMIN_CLAIMED'")).n, 1);
  for (const { tablename } of await f.platform.all("SELECT tablename FROM pg_tables WHERE schemaname='public'")) {
    const rows = JSON.stringify(await f.platform.all(`SELECT * FROM "${tablename}"`));
    assert.equal(rows.includes(f.body.code), false); assert.equal(rows.includes(f.body.password), false);
  }
});

test('claim transaction rolls back closure on insert failure; expired/off states reveal nothing', { skip: !platformTestUrl }, async (t) => {
  const f = await fixture(t), before = await f.platform.get('SELECT * FROM platform_admin_claim');
  await f.platform.exec("CREATE FUNCTION fail_claim_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_claim_test BEFORE INSERT ON platform_admin FOR EACH ROW EXECUTE FUNCTION fail_claim_test();");
  const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
  assert.equal((await f.call()).status, 500);
  assert.deepEqual(await f.platform.get('SELECT * FROM platform_admin_claim'), before);
  assert.equal((await f.platform.get('SELECT count(*) AS n FROM platform_session')).n, 0);
  assert.equal((await f.platform.get("SELECT count(*) AS n FROM platform_audit WHERE action='ADMIN_CLAIMED'")).n, 0);
  assert.equal(JSON.stringify(errors).includes(f.body.password), false);
  await f.platform.exec('DROP TRIGGER fail_claim_test ON platform_admin; DROP FUNCTION fail_claim_test();');
  await f.platform.run("UPDATE platform_admin_claim SET issued_at='2000-01-01T00:00:00.000Z', expires_at='2000-01-01T00:30:00.000Z'");
  for (const path of ['status', 'claim', 'unknown']) assert.deepEqual(await (await f.call(path)).json(), absent);
  await f.issue(); f.config.platform.claimEnabled = false;
  for (const path of ['status', 'claim', 'unknown']) assert.deepEqual(await (await f.call(path)).json(), absent);
});
