import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { ready, SCHEMA_VERSION } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { ensureAdmin } from '../src/auth.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { saveKey, keyStatus, openKey } from '../src/ai-studio/credential.js';
import { getStudioSetting } from '../src/ai-studio/usage.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Use a disposable test database.');
const options = { skip: !base };
async function database(t) {
  const pool = new pg.Pool({ connectionString: base }), name = `studio_test_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  return store;
}
const KEY = 'sk-fictional-0123456789abcdefghij-WXYZ';

test('postgres: a schema 28 database upgrades to 29 with defaults, and the baseline matches the upgrade', options, async (t) => {
  const store = await database(t);
  await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
  const baseline = await store.all("SELECT column_name, data_type FROM information_schema.columns WHERE table_name LIKE 'ai_studio_%' ORDER BY table_name, column_name");
  await store.exec('DROP TABLE ai_studio_usage; DROP TABLE ai_studio_credential; DROP TABLE ai_studio_setting');
  await store.setSchemaVersion(28);
  assert.equal(await ready(store), false);
  await store.transaction(() => upgradePostgres(store, 28));
  assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(await ready(store), true);
  assert.deepEqual(await getStudioSetting(store), { dailyCallCap: 20, revision: 1 });
  assert.deepEqual(await store.all("SELECT column_name, data_type FROM information_schema.columns WHERE table_name LIKE 'ai_studio_%' ORDER BY table_name, column_name"), baseline);
  assert.equal((await store.get('SELECT key_generation FROM ai_studio_setting')).key_generation, 0);
  await store.transaction(() => upgradePostgres(store, 29 - 1));
  assert.equal(await ready(store), true);
});

test('postgres: the sealed key round-trips as bytes and simultaneous saves have one winner', options, async (t) => {
  const store = await database(t);
  const box = createSecretBox(parseKeyFile(`k1=${randomBytes(32).toString('base64')}\n`));
  const save = (tail, expectedRevision) => saveKey(store, box, 'default', { apiKey: KEY.replace('WXYZ', tail), expectedRevision }, 'fixture_owner', async () => true);
  const first = await save('AAAA', 0);
  assert.equal(first.revision, 1);
  assert.equal(await openKey(store, box, 'default'), KEY.replace('WXYZ', 'AAAA'));
  const results = await Promise.allSettled([save('BBBB', 1), save('CCCC', 1), save('DDDD', 1)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
  const status = await keyStatus(store);
  assert.equal(status.revision, 2);
  const winner = results.find((r) => r.status === 'fulfilled').value;
  assert.equal(winner.last4, status.last4);
  const fresh = await Promise.allSettled([save('EEEE', 0), save('FFFF', 0)]);
  assert.equal(fresh.filter((r) => r.status === 'fulfilled').length, 0);
});
