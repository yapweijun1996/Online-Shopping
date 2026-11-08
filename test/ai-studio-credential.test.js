import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase, SCHEMA_VERSION, ready } from '../src/db.js';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { parseKeyFile } from '../src/secret-box.js';
import { keyStatus, openKey } from '../src/ai-studio/credential.js';
import { createSecretBox } from '../src/secret-box.js';
import { reserve, settle, callsToday, getStudioSetting, failureOutcome } from '../src/ai-studio/usage.js';

const ORIGIN = 'https://seller.example.test';
const KEY = 'sk-fictional-0123456789abcdefghij-WXYZ';
const integrationKeys = () => parseKeyFile(`k1=${randomBytes(32).toString('base64')}\n`);

async function fixture(t, { keys = true, validate = async () => true } = {}) {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
  const config = { publicOrigin: ORIGIN, shopMode: 'manual', ...(keys ? { integrationKeys: integrationKeys() } : {}) };
  const seen = [];
  const handle = await createApi({ store, config, studioProvider: (apiKey) => ({ validateKey: async () => { seen.push(apiKey); return validate(apiKey); } }) });
  const request = (path, method = 'GET', body, headers = {}) => handle(new Request(`${ORIGIN}${path}`,
    { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const login = await request('/api/v1/seller/session', 'POST', { username: 'fixture_owner', password: 'FictionalPassword123!' }, { origin: ORIGIN });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  return { store, request, seen, config, cookie, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf } };
}

test('current schema and ready covers the AI Studio tables', async (t) => {
  assert.equal(SCHEMA_VERSION, 35);
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
  assert.equal(await ready(store), true);
  assert.deepEqual(await getStudioSetting(store), { dailyCallCap: 20, revision: 1 });
  await store.exec('DROP TABLE ai_studio_usage');
  assert.equal(await ready(store), false);
});

test('the key is validated first, sealed at rest, bound to the shop and never returned', async (t) => {
  const f = await fixture(t);
  const saved = await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: ` ${KEY} `, expectedRevision: 0 }, f.headers);
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual({ configured: body.configured, last4: body.last4, revision: body.revision }, { configured: true, last4: 'WXYZ', revision: 1 });
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal(f.seen[0], KEY);
  const row = await f.store.get('SELECT * FROM ai_studio_credential');
  assert.doesNotMatch(Buffer.from(row.sealed).toString('latin1'), /fictional/);
  const box = createSecretBox(f.config.integrationKeys);
  assert.equal(await openKey(f.store, box, 'default'), KEY);
  assert.throws(() => box.open(Buffer.from(row.sealed), row.key_id, 'AI_STUDIO:OPENAI:other-shop'));
  for (const path of ['/api/v1/seller/ai-studio', '/api/v1/seller/ai-studio/key']) {
    const text = JSON.stringify(await (await f.request(path, 'GET', null, { cookie: f.cookie })).text());
    assert.doesNotMatch(text, /fictional|sk-/);
  }
  const status = await (await f.request('/api/v1/seller/ai-studio', 'GET', null, { cookie: f.cookie })).json();
  assert.deepEqual({ configured: status.configured, last4: status.last4, available: status.available }, { configured: true, last4: 'WXYZ', available: true });
  const replaced = await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY.replace('WXYZ', 'ABCD'), expectedRevision: 1 }, f.headers);
  assert.equal((await replaced.json()).revision, 2);
  const stale = await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 1 }, f.headers);
  assert.equal(stale.status, 409);
  const removed = await f.request('/api/v1/seller/ai-studio/key', 'DELETE', { expectedRevision: 1 }, f.headers);
  assert.equal(removed.status, 409);
  const gone = await f.request('/api/v1/seller/ai-studio/key', 'DELETE', { expectedRevision: 2 }, f.headers);
  const after = await gone.json();
  assert.deepEqual({ configured: after.configured, revision: after.revision }, { configured: false, revision: 3 });
  // A tab that still holds an old revision can neither re-save nor delete over a later key.
  const staleSave = await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 1 }, f.headers);
  assert.equal(staleSave.status, 409);
  const again = await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 3 }, f.headers);
  assert.equal((await again.json()).revision, 4);
  assert.equal((await f.request('/api/v1/seller/ai-studio/key', 'DELETE', { expectedRevision: 2 }, f.headers)).status, 409);
  assert.equal((await keyStatus(f.store)).configured, true);
  // Two simultaneous replacements: exactly one wins.
  const race = await Promise.all(['AAAA', 'BBBB'].map((tail) => f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY.replace('WXYZ', tail), expectedRevision: 4 }, f.headers)));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
});

test('a rejected or unreachable key is never stored and errors do not echo it', async (t) => {
  for (const [code, status] of [['STUDIO_KEY_REJECTED', 422], ['STUDIO_UNAVAILABLE', 502]]) {
    const f = await fixture(t, { validate: async () => { throw Object.assign(new Error(`bad ${KEY}`), { code }); } });
    const result = await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 0 }, f.headers);
    assert.equal(result.status, status);
    assert.doesNotMatch(await result.text(), /sk-fictional/);
    assert.equal(await f.store.get('SELECT 1 AS n FROM ai_studio_credential'), undefined);
  }
});

test('input validation, roles, CSRF and host configuration are enforced', async (t) => {
  const f = await fixture(t);
  for (const body of [{}, { apiKey: 'short' }, { apiKey: 'a b c d e f g h i j k l m n o p' }, { apiKey: KEY, extra: 1 }, { apiKey: 12345 }, { apiKey: KEY, expectedRevision: -1 }]) {
    assert.equal((await f.request('/api/v1/seller/ai-studio/key', 'PUT', body, f.headers)).status, 400);
  }
  for (const bad of [{ cookie: f.cookie }, { cookie: f.cookie, origin: ORIGIN }, { cookie: f.cookie, origin: 'https://evil.example.test', 'x-csrf-token': f.headers['x-csrf-token'] }]) {
    assert.equal((await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 0 }, bad)).status, 403);
  }
  assert.equal((await f.request('/api/v1/seller/ai-studio')).status, 401);
  for (const role of ['MANAGER', 'STAFF']) {
    await f.store.run('UPDATE seller_account SET role = ?', role);
    const status = await f.request('/api/v1/seller/ai-studio', 'GET', null, { cookie: f.cookie });
    assert.equal(status.status, role === 'MANAGER' ? 200 : 403);
    if (role === 'MANAGER') assert.equal(Object.hasOwn(await status.json(), 'last4'), false);
    assert.equal((await f.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 0 }, f.headers)).status, 403);
    assert.equal((await f.request('/api/v1/seller/ai-studio/key', 'DELETE', { expectedRevision: 0 }, f.headers)).status, 403);
    assert.equal((await f.request('/api/v1/seller/ai-studio/settings', 'PATCH', { dailyCallCap: 5, expectedRevision: 1 }, f.headers)).status, 403);
  }
  const bare = await fixture(t, { keys: false });
  assert.equal((await (await bare.request('/api/v1/seller/ai-studio', 'GET', null, { cookie: bare.cookie })).json()).available, false);
  assert.equal((await bare.request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 0 }, bare.headers)).status, 503);
});

test('the daily call cap is enforced from the usage ledger', async (t) => {
  const f = await fixture(t);
  const set = await f.request('/api/v1/seller/ai-studio/settings', 'PATCH', { dailyCallCap: 3, expectedRevision: 1 }, f.headers);
  assert.equal((await set.json()).dailyCallCap, 3);
  assert.equal((await f.request('/api/v1/seller/ai-studio/settings', 'PATCH', { dailyCallCap: 3, expectedRevision: 1 }, f.headers)).status, 409);
  for (const cap of [0, 501, 1.5, '5']) assert.equal((await f.request('/api/v1/seller/ai-studio/settings', 'PATCH', { dailyCallCap: cap, expectedRevision: 2 }, f.headers)).status, 400);
  const day = new Date('2026-11-02T10:00:00Z');
  const [image, review] = await reserve(f.store, ['IMAGE', 'REVIEW'], 'a', null, day);
  assert.equal(await callsToday(f.store, day), 2);              // reserved calls count at once
  await settle(f.store, image, 'OK'); await settle(f.store, review, 'AMBIGUOUS');
  assert.equal(await callsToday(f.store, day), 2);
  await assert.rejects(reserve(f.store, ['IMAGE', 'REVIEW'], 'a', null, day), { status: 429, code: 'AI_STUDIO_CAP' });
  assert.equal(await callsToday(f.store, day), 2);              // a refused reservation leaves nothing behind
  const [last] = await reserve(f.store, ['ANALYZE'], 'a', null, day);
  await settle(f.store, last, 'ERROR');                         // known not billed: released
  assert.equal(await callsToday(f.store, day), 2);
  await settle(f.store, last, 'OK');                            // a settled row never changes again
  assert.equal(await callsToday(f.store, day), 2);
  assert.equal((await reserve(f.store, ['IMAGE', 'REVIEW', 'ANALYZE'], 'a', null, new Date('2026-11-03T00:00:00Z'))).length, 3);
  assert.deepEqual(['STUDIO_TIMEOUT', 'STUDIO_BAD_RESPONSE', 'STUDIO_REFUSED'].map((code) => failureOutcome({ code })), ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS']);
  assert.deepEqual(['STUDIO_KEY_REJECTED', 'STUDIO_REQUEST_REJECTED', 'STUDIO_RATE_LIMITED', 'STUDIO_UNAVAILABLE'].map((code) => failureOutcome({ code })), ['ERROR', 'ERROR', 'ERROR', 'ERROR']);
  // Simultaneous reservations cannot both pass: cap 3, three requests of two calls each.
  const race = await Promise.allSettled([1, 2, 3].map(() => reserve(f.store, ['IMAGE', 'REVIEW'], 'a', null, new Date('2026-11-05T10:00:00Z'))));
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await callsToday(f.store, new Date('2026-11-05T10:00:00Z')), 2);
  assert.deepEqual(Object.keys(await f.store.get('SELECT * FROM ai_studio_usage LIMIT 1')).sort(), ['actor', 'created_at', 'day', 'id', 'kind', 'outcome', 'product_id']);
});
