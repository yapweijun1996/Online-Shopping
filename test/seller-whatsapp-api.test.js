import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { parseKeyFile } from '../src/secret-box.js';

const origin = 'https://seller.example.test';
const base = `${origin}/api/v1/seller/integrations/whatsapp`;
const username = 'fixture_owner', password = 'SyntheticFixtureOnly4920!';
const accessToken = 'fictional-access-token-ABC123456789';
const appSecret = 'fictional-app-secret-0123456789abcdef';
const body = { accessToken, appSecret, phoneNumberId: '123456789', businessAccountId: '987654321' };
const keys = parseKeyFile(`k1=${randomBytes(32).toString('base64')}`);

async function fixture(t, { quick = false, withKeys = true, verify = async () => ({ ok: true, displayPhoneNumber: '+15550000000', verifiedName: 'Fictional Shop' }) } = {}) {
  const store = await openDatabase(':memory:');
  t.after(() => store.close());
  await ensureAdmin(store, username, password);
  const calls = [];
  const handle = await createApi({ store, whatsappTransport: { verify: async (input) => { calls.push(input); return verify(input); } },
    config: { shopMode: 'manual', publicOrigin: 'https://shop.example.test', sellerOrigin: origin, appRevision: null, sellerQuickLogin: quick, username, integrationKeys: withKeys ? keys : null } });
  const call = (method, target, payload, headers = {}) => handle(new Request(target, { method, headers: { origin, 'content-type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload) }), { clientAddress: '203.0.113.7' });
  const login = await call('POST', `${origin}/api/v1/seller/session`, { username, password });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const authed = (method, target = base, payload, extra = {}) => call(method, target, payload, { cookie, 'x-csrf-token': csrfToken, ...extra });
  return { store, call, authed, calls, cookie, csrfToken };
}

const rows = async (store) => (await store.get('SELECT COUNT(*) AS n FROM integration_connection')).n;
const leaks = (text) => [accessToken, appSecret].filter((secret) => text.includes(secret));

test('every connection route needs a signed-in seller', async (t) => {
  const f = await fixture(t);
  for (const [method, target] of [['GET', base], ['PUT', `${base}/SANDBOX`], ['DELETE', `${base}/SANDBOX`]]) {
    assert.equal((await f.call(method, target, method === 'PUT' ? body : undefined)).status, 401, `${method} without a session`);
  }
  assert.equal(await rows(f.store), 0);
});

test('writes need the same origin and the CSRF token', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('PUT', `${base}/SANDBOX`, body, { cookie: f.cookie })).status, 403, 'no CSRF token');
  assert.equal((await f.call('PUT', `${base}/SANDBOX`, body, { cookie: f.cookie, 'x-csrf-token': f.csrfToken, origin: 'https://evil.example.test' })).status, 403, 'foreign origin');
  assert.equal((await f.call('DELETE', `${base}/SANDBOX`, undefined, { cookie: f.cookie })).status, 403);
  assert.equal(f.calls.length, 0, 'the provider is never called');
  assert.equal(await rows(f.store), 0);
});

test('a seller connects, sees only status and the webhook details, rotates and disconnects', async (t) => {
  const f = await fixture(t);
  const empty = await (await f.authed('GET')).json();
  assert.deepEqual(empty, { available: true, webhookUrl: 'https://shop.example.test/api/v1/webhooks/whatsapp', connections: [] });
  const saved = await f.authed('PUT', `${base}/SANDBOX`, body);
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.deepEqual(leaks(text), [], 'the response never contains a secret');
  const status = JSON.parse(text);
  assert.equal(status.status, 'CONNECTED'); assert.equal(status.environment, 'SANDBOX'); assert.equal(status.secretHint, '••••6789');
  assert.match(status.publicConfig.verifyToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].phoneNumberId, '123456789');
  const listed = await (await f.authed('GET')).text();
  assert.deepEqual(leaks(listed), []);
  assert.equal(JSON.parse(listed).connections.length, 1);
  const rotated = await f.authed('PUT', `${base}/SANDBOX`, { ...body, accessToken: 'fictional-replacement-token-XYZ987654321' });
  assert.equal(rotated.status, 200);
  assert.equal((await f.store.all("SELECT action FROM integration_audit ORDER BY created_at")).map((row) => row.action).join(), 'CONNECT,ROTATE');
  const gone = await f.authed('DELETE', `${base}/SANDBOX`);
  assert.equal(gone.status, 200); assert.equal((await gone.json()).status, 'NOT_CONFIGURED');
  assert.equal((await f.authed('DELETE', `${base}/PRODUCTION`)).status, 404, 'nothing to disconnect');
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM integration_connection WHERE secret_ciphertext IS NOT NULL')).n, 0);
});

test('bad input, unknown environments and provider failures store nothing and leak nothing', async (t) => {
  const rejected = await fixture(t, { verify: async () => ({ ok: false, reason: 'REJECTED' }) });
  const refused = await rejected.authed('PUT', `${base}/SANDBOX`, body);
  assert.equal(refused.status, 400); assert.equal((await refused.json()).error.code, 'CONNECTION_REJECTED');
  assert.equal(await rows(rejected.store), 0);
  const down = await fixture(t, { verify: async () => ({ ok: false, reason: 'UNAVAILABLE' }) });
  assert.equal((await down.authed('PUT', `${base}/SANDBOX`, body)).status, 502);
  const f = await fixture(t);
  for (const bad of [{ ...body, accessToken: 'short' }, { ...body, extra: 1 }, { ...body, appSecret: undefined }, { ...body, phoneNumberId: 'abc' }]) {
    const response = await f.authed('PUT', `${base}/SANDBOX`, bad);
    assert.equal(response.status, 400); assert.deepEqual(leaks(await response.text()), []);
  }
  assert.equal(f.calls.length, 0, 'invalid input is rejected before the provider is called');
  assert.equal((await f.authed('PUT', `${base}/STAGING`, body)).status, 404);
  assert.equal((await f.authed('PUT', `${base}/SANDBOX`, { ...body, environment: 'PRODUCTION' })).status, 400, 'environment comes from the path only');
  assert.equal((await f.authed('PUT', `${base}/SANDBOX`, { padding: 'x'.repeat(9000) })).status, 413);
  assert.equal(await rows(f.store), 0);
});

test('a sample site with quick sign-in never accepts or shows connections', async (t) => {
  const f = await fixture(t, { quick: true });
  assert.deepEqual(await (await f.authed('GET')).json(), { available: false, connections: [] });
  assert.equal((await f.authed('PUT', `${base}/SANDBOX`, body)).status, 403);
  assert.equal((await f.authed('DELETE', `${base}/SANDBOX`)).status, 403);
  assert.equal(f.calls.length, 0); assert.equal(await rows(f.store), 0);
});

test('without master keys the routes report unavailable instead of storing unencrypted secrets', async (t) => {
  const f = await fixture(t, { withKeys: false });
  assert.deepEqual(await (await f.authed('GET')).json(), { available: false, connections: [] });
  assert.equal((await f.authed('PUT', `${base}/SANDBOX`, body)).status, 503);
  assert.equal(await rows(f.store), 0);
});

test('connection attempts are rate limited', async (t) => {
  const f = await fixture(t, { verify: async () => ({ ok: false, reason: 'REJECTED' }) });
  let last;
  for (let i = 0; i < 11; i++) last = await f.authed('PUT', `${base}/SANDBOX`, body);
  assert.equal(last.status, 429);
  assert.equal(f.calls.length, 10);
});
