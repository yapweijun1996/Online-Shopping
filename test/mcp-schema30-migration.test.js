import { inventoryStorageReady } from '../src/inventory-schema.js';
import { dropInventoryForLegacyFixture } from './helpers/inventory-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase, migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { operationStorageMetaSchema, operationStorageSeedSql, operationStorageReady, operationStorageDdl } from '../src/mcp/operation-runtime.js';
import { postgresSchema12Sql } from '../deploy/postgres/schema12.js';
import { senderFields } from '../src/sender-settings.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable PostgreSQL test database required.');
import { MEDIA_STORAGE_TABLES } from '../src/mcp/media-schema.js';
const tables = [...MEDIA_STORAGE_TABLES.toReversed(), 'mcp_v2_authorization_request', 'mcp_v2_scope_consent', 'mcp_v2_approval_challenge', 'mcp_v2_approval', 'mcp_v2_event', 'mcp_v2_operation', 'mcp_v2_schema'];
async function removeOperations(store) {
  await dropInventoryForLegacyFixture(store);
  for (const table of tables) await store.exec(`DROP TABLE ${table}`);
  await store.setSchemaVersion(29);
}
async function postgresFixture(t) {
  const control = new pg.Pool({ connectionString: base });
  const name = `shopping_test_migration30_${randomUUID().replaceAll('-', '')}`;
  await control.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await control.query(`DROP DATABASE ${name} WITH (FORCE)`); await control.end(); });
  return { store, url: url.href };
}
const admin = ['synthetic_owner', 'synthetic-historical-hash', '2026-11-01T00:00:00.000Z'];

test('fresh PostgreSQL baseline embeds exact shared operation DDL and self-contained metadata SQL', () => {
  const sql = readFileSync(new URL('../src/postgres/schema.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(operationStorageDdl('postgres') + '\n' + operationStorageMetaSchema('postgres') + '\n' + operationStorageSeedSql() + '\n'));
  assert.match(sql, /INSERT INTO schema_meta VALUES \(1, 32\)/);
});

test('SQLite29 to30 migration preserves historical rows, rolls back final DDL failure and is repeatable', async (t) => {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  await removeOperations(store);
  await store.run('INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, ?, ?, ?)', ...admin);
  const before = await store.get('SELECT * FROM admin');
  const exec = store.exec;
  store.exec = async (sql) => { await exec(sql); if (sql.includes('CREATE TABLE mcp_v2_schema')) throw new Error('Synthetic schema30 final DDL failure'); };
  await assert.rejects(migrateStore(store), /Synthetic schema30 final DDL failure/);
  assert.equal(await store.schemaVersion(), 29);
  assert.equal((await store.all("SELECT name FROM sqlite_schema WHERE name GLOB 'mcp_v2_*'")).length, 0);
  assert.deepEqual(await store.get('SELECT * FROM admin'), before);
  store.exec = exec;
  await migrateStore(store); await migrateStore(store);
  assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(await operationStorageReady(store), true);
  assert.deepEqual(await store.get('SELECT * FROM admin'), before);
});

async function sourceVersionFixture(store, version) {
  if (version < 24) {
    // Independent physical historical fixtures exercise every supported source
    // version path. Versions14-23 deliberately reuse the supported schema12
    // shape, matching existing compatibility fixtures; they do not claim exact
    // historical snapshots for those releases.
    await store.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    let sql = version === 13
      ? readFileSync(new URL('./fixtures/postgres-schema13.sql', import.meta.url), 'utf8')
      : version < 12 ? readFileSync(new URL('./fixtures/postgres-schema10.sql', import.meta.url), 'utf8') : postgresSchema12Sql;
    if (version === 11) sql = sql.replace('position BETWEEN 1 AND 4', 'position BETWEEN 1 AND 9');
    await store.exec(sql);
  } else {
    await removeOperations(store);
    if (version < 29) for (const table of ['ai_studio_image', 'ai_studio_usage', 'ai_studio_setting', 'ai_studio_credential']) await store.exec(`DROP TABLE ${table}`);
    if (version < 28) for (const table of ['ai_suggestion_audit', 'ai_usage', 'ai_setting']) await store.exec(`DROP TABLE ${table}`);
    if (version < 27) for (const table of ['message_thread_message', 'message_thread', 'message_peer_suppression', 'whatsapp_qr_auth', 'whatsapp_qr_session']) await store.exec(`DROP TABLE ${table}`);
    if (version < 26) for (const [column] of Object.values(senderFields)) await store.exec(`ALTER TABLE company_setting DROP COLUMN ${column}`);
    if (version < 25) {
      for (const table of ['oauth_token', 'oauth_authorization_code', 'oauth_grant', 'oauth_authorization_request', 'oauth_client', 'mcp_audit']) await store.exec(`DROP TABLE ${table}`);
      await store.exec('ALTER TABLE seller_account DROP COLUMN oauth_auth_version');
    }
  }
  await store.setSchemaVersion(version);
  await store.run('INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, ?, ?, ?)', ...admin);
}

for (const version of Array.from({ length: 20 }, (_, index) => index + 10)) {
  test(`PostgreSQL source-version${version} reaches31 with matching operation schema and final-step rollback`, { skip: !base }, async (t) => {
    const { store, url } = await postgresFixture(t);
    const expectedManifest = (await store.get('SELECT manifest_digest FROM mcp_v2_schema WHERE id = 1')).manifest_digest;
    await sourceVersionFixture(store, version);
    const before = await store.get('SELECT * FROM admin');
    await assert.rejects(openPostgresDatabase(url), /Unsupported database schema version/);
    const failing = { ...store, exec: async (sql) => {
      await store.exec(sql);
      if (sql.includes('CREATE TABLE mcp_v2_schema')) throw new Error('Synthetic schema30 final DDL failure');
    } };
    await assert.rejects(store.transaction(() => upgradePostgres(failing, version)), /Synthetic schema30 final DDL failure/);
    assert.equal(await store.schemaVersion(), version);
    assert.deepEqual(await store.get('SELECT * FROM admin'), before);
    assert.equal((await store.get("SELECT to_regclass('public.mcp_v2_schema') AS name")).name, null);
    const upgraded = await openPostgresDatabase(url, { allowUpgrade: true });
    try {
      assert.equal(await upgraded.schemaVersion(), 32);
      assert.equal(await operationStorageReady(upgraded), true);
      assert.equal((await upgraded.get('SELECT manifest_digest FROM mcp_v2_schema WHERE id = 1')).manifest_digest, expectedManifest);
      assert.deepEqual(await upgraded.get('SELECT * FROM admin'), before);
    } finally { await upgraded.close(); }
    const again = await openPostgresDatabase(url, { allowUpgrade: true });
    await again.close();
  });
}

test('PostgreSQL fresh baseline can be executed directly without the JS loader and rolls back loader validation failure', { skip: !base }, async (t) => {
  const { store } = await postgresFixture(t);
  await store.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sql = readFileSync(new URL('../src/postgres/schema.sql', import.meta.url), 'utf8');
  await store.transaction(() => store.exec(sql));
  assert.equal(await operationStorageReady(store), true);
  await assert.rejects(store.transaction(async () => {
    await store.exec('DROP INDEX mcp_v2_operation_expiry');
    if (!await operationStorageReady(store)) throw new Error('Synthetic validation rejected incomplete schema');
  }), /Synthetic validation rejected/);
  assert.equal(await operationStorageReady(store), true);
});

test('PostgreSQL29 upgrade grants the legacy application role new tables without tenant cross-grants', { skip: !base }, async (t) => {
  const control = new pg.Pool({ connectionString: base });
  await control.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'online_shopping_app') THEN CREATE ROLE online_shopping_app NOLOGIN; END IF; END $$");
  const { store } = await postgresFixture(t);
  await removeOperations(store);
  await store.transaction(() => upgradePostgres(store, 29));
  await store.exec('GRANT SELECT ON schema_meta TO online_shopping_app');
  await store.transaction(async () => {
    await store.exec('SET LOCAL ROLE online_shopping_app');
    assert.equal(await operationStorageReady(store), true);
    assert.equal(await inventoryStorageReady(store), true);
    await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, tool_name, operation_id, event, outcome, correlation_id)
      VALUES (?, ?, ?, ?, ?, 'DENY', 'FORBIDDEN', ?)`, randomUUID(), new Date().toISOString(), 'synthetic', 'catalog.preview_create', randomUUID(), randomUUID());
  });
  const tenantName = `t_testshop_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  await control.query(`CREATE DATABASE ${tenantName}`);
  const url = new URL(base); url.pathname = '/' + tenantName;
  const tenant = await openPostgresDatabase(url.href);
  t.after(async () => { await tenant.close(); await control.query(`DROP DATABASE ${tenantName} WITH (FORCE)`); });
  t.after(() => control.end());
  await removeOperations(tenant);
  await tenant.transaction(() => upgradePostgres(tenant, 29));
  assert.equal((await tenant.get("SELECT has_table_privilege('online_shopping_app', 'mcp_v2_operation', 'SELECT') AS allowed")).allowed, false);
  for (const table of ['inventory_schema','inventory_coverage','inventory_state','inventory_movement']) assert.equal((await tenant.get("SELECT has_table_privilege('online_shopping_app', ?, 'SELECT') AS allowed",table)).allowed,false);
});
