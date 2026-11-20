import { dropInventoryForLegacyFixture } from './helpers/inventory-fixture.js';
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
import { getStudioSetting, reserve, callsToday } from '../src/ai-studio/usage.js';
import { createCategory } from '../src/settings.js';
import { createProduct, getProduct } from '../src/products.js';
import { addStudioDraftToGallery, generateStyleImage, listStudioDrafts } from '../src/ai-studio/jobs.js';

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

test('postgres: a schema 28 database upgrades with current defaults, and the baseline matches the upgrade', options, async (t) => {
  const store = await database(t);
  await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
  const baseline = await store.all("SELECT column_name, data_type FROM information_schema.columns WHERE table_name LIKE 'ai_studio_%' ORDER BY table_name, column_name");
  await store.exec('DROP TABLE ai_studio_draft; DROP TABLE ai_studio_usage; DROP TABLE ai_studio_credential; DROP TABLE ai_studio_setting');
  await dropInventoryForLegacyFixture(store); await store.setSchemaVersion(28);
  assert.equal(await ready(store), false);
  await store.transaction(() => upgradePostgres(store, 28));
  assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(await ready(store), true);
  assert.deepEqual(await getStudioSetting(store), { dailyCallCap: 100, revision: 1 });
  assert.deepEqual(await store.all("SELECT column_name, data_type FROM information_schema.columns WHERE table_name LIKE 'ai_studio_%' ORDER BY table_name, column_name"), baseline);
  assert.equal((await store.get('SELECT key_generation FROM ai_studio_setting')).key_generation, 0);
  await store.transaction(() => upgradePostgres(store, 29 - 1));
  assert.equal(await ready(store), true);
});

test('postgres: schema 38 preserves a higher cap and published gallery selection is atomic', options, async (t) => {
  const store = await database(t);
  await store.exec('DROP TABLE ai_studio_draft; UPDATE ai_studio_setting SET daily_call_cap = 250, revision = 7');
  await store.setSchemaVersion(38);
  await store.transaction(() => upgradePostgres(store, 38));
  assert.deepEqual(await getStudioSetting(store), { dailyCallCap: 250, revision: 7 });
  const secretBox = createSecretBox(parseKeyFile(`k1=${randomBytes(32).toString('base64')}\n`));
  await saveKey(store, secretBox, 'default', { apiKey: KEY, expectedRevision: 0 }, 'fixture', async () => true);
  await createCategory(store, { code: 'TESTS', label: 'Tests' });
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const product = await createProduct(store, { sku: 'STUDIO', name: 'Studio item', description: 'Fixture image',
    category: 'TESTS', priceMinor: 1200, active: true, imageDataUrl: `data:image/jpeg;base64,${photo.toString('base64')}` });
  const studioProvider = () => ({
    edit: async () => ({ mime: 'image/jpeg', data: Buffer.concat([photo, Buffer.from([1])]) }),
    review: async () => ({ verdict: 'WARN', issues: ['Check the label'] }),
  });
  const draft = await generateStyleImage({ store, secretBox, shopId: 'default', studioProvider, actor: 'fixture',
    productId: product.id, body: { style: 'studio' } });
  assert.equal((await getProduct(store, product.id)).images.length, 1);
  assert.deepEqual(await listStudioDrafts(store, product.id), [draft]);
  const save = () => addStudioDraftToGallery(store, product.id, draft.draftId, 'fixture');
  const [selected, retry] = await Promise.all([save(), save()]);
  assert.deepEqual(selected, retry);
  assert.equal((await getProduct(store, product.id)).images.length, 2);
  assert.deepEqual(await listStudioDrafts(store, product.id), []);
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

test('postgres: simultaneous reservations cannot pass the daily cap and PENDING rows count', options, async (t) => {
  const store = await database(t);
  const day = new Date('2026-11-05T10:00:00Z');
  await reserve(store, Array(96).fill('ANALYZE'), 'fixture', null, day);
  const race = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(store, ['IMAGE', 'REVIEW'], 'fixture', null, day)));
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(race.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'AI_STUDIO_CAP'));
  assert.equal(await callsToday(store, day), 100);
});
