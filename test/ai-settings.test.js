import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrateStore, SCHEMA_VERSION, ready } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { getAiSettings, updateAiSettings, recordUsage, todayTokens } from '../src/ai/settings.js';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { createPlatformRegistry } from '../src/platform/registry.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Use a disposable test database.');
async function database(t, engine) {
  if (engine === 'sqlite') {
    const store = await openDatabase(':memory:'); t.after(() => store.close()); return store;
  }
  const pool = new pg.Pool({ connectionString: base }), name = `ai_test_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  return store;
}
for (const engine of ['sqlite', 'postgres']) {
  const options = { skip: engine === 'postgres' && !base };
  test(`${engine}: AI settings migration, validation, CAS and UTC usage`, options, async t => {
    const store = await database(t, engine);
    await store.exec('DROP TABLE ai_suggestion_audit; DROP TABLE ai_usage; DROP TABLE ai_setting;');
    await store.setSchemaVersion(27);
    if (engine === 'sqlite') await migrateStore(store);
    else await store.transaction(() => upgradePostgres(store, 27));
    assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
    assert.deepEqual(await getAiSettings(store), { enabled: false, level: 1, tone: '', businessNotes: '', dailyTokenCap: 100000, revision: 1, updatedAt: '1970-01-01T00:00:00.000Z' });
    assert.deepEqual(await store.all('SELECT id,actor,thread_id,created_at FROM ai_suggestion_audit'), []);
    const updated = await updateAiSettings(store, { enabled: true, tone: ' friendly ', businessNotes: ' first\nsecond ', dailyTokenCap: 1000, level: 0, expectedRevision: 1 }, 'fixture');
    assert.equal(updated.tone, 'friendly'); assert.equal(updated.businessNotes, 'first\nsecond'); assert.equal(updated.revision, 2);
    const audit = await store.get("SELECT actor,action FROM ai_suggestion_audit WHERE action = 'SETTINGS_UPDATED'");
    assert.equal(audit.actor, 'fixture');
    assert.equal(audit.action, 'SETTINGS_UPDATED');
    await assert.rejects(updateAiSettings(store, { tone: 'stale', expectedRevision: 1 }, 'fixture'), e => e.status === 409);
    for (const patch of [{ tone: 'x'.repeat(301) }, { businessNotes: 'x'.repeat(3001) }, { enabled: 1 }, { level: 2 }, { level: -1 }, { level: 0.5 }, { dailyTokenCap: 999 }, { dailyTokenCap: 2000001 }, { dailyTokenCap: '1000' }, { tone: '\n' }, { tone: '\t' }, { businessNotes: '\r' }, { businessNotes: '\u007f' }, { tone: '\ud800' }, { apiKey: 'forbidden' }, { expectedRevision: 0 }, { expectedRevision: undefined }]) {
      await assert.rejects(updateAiSettings(store, { expectedRevision: 2, ...patch }, 'fixture'), e => Boolean(e.field));
    }
    assert.equal((await getAiSettings(store)).revision, 2);
    await updateAiSettings(store, { tone: 'x'.repeat(300), businessNotes: 'x'.repeat(3000), dailyTokenCap: 2000000, level: 1, expectedRevision: 2 }, 'fixture');
    const contenders = await Promise.allSettled(['first', 'second'].map(tone => updateAiSettings(store, { tone, expectedRevision: 3 }, 'fixture')));
    assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(contenders.find(result => result.status === 'rejected').reason.status, 409);
    const winner = contenders.find(result => result.status === 'fulfilled').value;
    assert.equal((await getAiSettings(store)).tone, winner.tone);
    assert.equal((await getAiSettings(store)).revision, 4);
    for (const [now, inputTokens, outputTokens, outcome] of [['2026-10-23T23:59:59Z', 9, 1, 'ERROR'], ['2026-10-24T00:00:00Z', 20, 3, 'OK'], ['2026-10-24T23:59:59Z', 4, 5, 'HANDOFF'], ['2026-10-25T00:00:00Z', 90, 10, 'CAP']]) {
      await recordUsage(store, { actor: 'fixture', now, inputTokens, outputTokens, outcome, prompt: 'must not persist' });
    }
    assert.equal(await todayTokens(store, '2026-10-24T20:00:00Z'), 32);
    assert.equal(await todayTokens(store, '2026-10-25T01:00:00+02:00'), 32);
    assert.equal(await todayTokens(store, '2026-10-26T00:00:00Z'), 0);
    assert.deepEqual(Object.keys(await store.get('SELECT * FROM ai_usage LIMIT 1')).sort(), ['id', 'day', 'kind', 'actor', 'thread_id', 'input_tokens', 'output_tokens', 'outcome', 'created_at'].sort());
    await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
    assert.equal(await ready(store), true);
    await store.exec('DROP TABLE ai_suggestion_audit');
    assert.equal(await ready(store), false);
  });
  test(`${engine}: AI settings routes enforce roles, CSRF, host gate and tenant isolation`, options, async t => {
    const store = await database(t, engine);
    await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
    const config = { ai: { enabled: true }, publicOrigin: 'https://seller.example.test', shopMode: 'manual' };
    const handle = await createApi({ store, config });
    async function request(api, path, method = 'GET', body, headers = {}) {
      return api(new Request(`https://seller.example.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    }
    const login = await request(handle, '/api/v1/seller/session', 'POST', { username: 'fixture_owner', password: 'FictionalPassword123!' }, { origin: config.publicOrigin });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
    const headers = { cookie, origin: config.publicOrigin, 'x-csrf-token': csrf };
    for (const role of ['OWNER', 'MANAGER', 'STAFF']) {
      await store.run('UPDATE seller_account SET role = ?', role);
      const get = await request(handle, '/api/v1/seller/ai-settings', 'GET', null, { cookie });
      assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store');
      const visible = await get.json();
      assert.equal(visible.available, true);
      if (role !== 'OWNER') assert.deepEqual(Object.keys(visible).sort(), ['available', 'enabled', 'level']);
      const patch = await request(handle, '/api/v1/seller/ai-settings', 'PATCH', { enabled: true, expectedRevision: 1 }, headers);
      assert.equal(patch.status, role === 'OWNER' ? 200 : 403);
    }
    assert.equal((await store.get("SELECT actor FROM ai_suggestion_audit WHERE action = 'SETTINGS_UPDATED'")).actor, 'fixture_owner');
    await store.run("UPDATE seller_account SET role = 'OWNER'");
    for (const invalid of [{ cookie }, { cookie, origin: config.publicOrigin }, { cookie, origin: 'https://evil.example.test', 'x-csrf-token': csrf }, { cookie, 'x-csrf-token': csrf }]) {
      assert.equal((await request(handle, '/api/v1/seller/ai-settings', 'PATCH', { tone: 'bad', expectedRevision: 2 }, invalid)).status, 403);
    }
    assert.equal((await request(handle, '/api/v1/seller/ai-settings')).status, 401);
    const disabled = await createApi({ store, config: { ...config, ai: { enabled: false } } });
    for (const method of ['GET', 'PATCH']) assert.equal((await request(disabled, '/api/v1/seller/ai-settings', method, method === 'PATCH' ? { enabled: false, expectedRevision: 2 } : null, headers)).status, 404);
    const tenantStore = await database(t, engine);
    await ensureAdmin(tenantStore, 'fixture_owner', 'FictionalPassword123!');
    const registry = createPlatformRegistry({ store, config, platform: { get: async (sql, code) => code === 'fixture' ? { id: 'tenant-id', code: 'fixture', name: 'Fixture', status: 'ACTIVE', is_default: 0 } : undefined }, pool: { get: async () => tenantStore } });
    const tenants = await createApi({ store, config, registry });
    const tenantLogin = await request(tenants, '/fixture/api/v1/seller/session', 'POST', { username: 'fixture_owner', password: 'FictionalPassword123!' }, { origin: config.publicOrigin });
    assert.equal(tenantLogin.status, 200);
    const tenantHeaders = { cookie: tenantLogin.headers.get('set-cookie').split(';')[0], origin: config.publicOrigin, 'x-csrf-token': (await tenantLogin.json()).csrfToken };
    const result = await request(tenants, '/fixture/api/v1/seller/ai-settings', 'PATCH', { tone: 'Tenant tone', expectedRevision: 1 }, tenantHeaders);
    assert.equal(result.status, 200); assert.equal((await result.json()).tone, 'Tenant tone');
    assert.equal((await getAiSettings(store)).tone, '');
    const get = await request(tenants, '/fixture/api/v1/seller/ai-settings', 'GET', null, tenantHeaders);
    assert.equal((await get.json()).tone, 'Tenant tone');
  });
}
