import { dropInventoryForLegacyFixture } from './helpers/inventory-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase, migrateStore } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { mediaSchema, MEDIA_STORAGE_TABLES } from '../src/mcp/media-schema.js';
import { operationStorageReady, operationStorageManifestSql, initializeOperationStorage } from '../src/mcp/operation-runtime.js';
import { excludedImportTables } from '../src/sqlite-import.js';
const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable PostgreSQL required.');
const sha = value => createHash('sha256').update(value).digest('hex');
const oldDigests = { sqlite: 'c4327861d2e4c045a6f37bc67616b287e91ee3f7871053f5845cc93a2f9224dc', postgres: '5deabb4f780c68580da9f23d85e2c80a33d1ce7ea194b39cf4567e6adc01ce6b' };
async function fixture(t, dialect) {
  if (dialect === 'sqlite') { const store = await openDatabase(':memory:'); t.after(() => store.close()); return store; }
  const pool = new pg.Pool({ connectionString: base }), name = 'shopping_test_media31_' + randomUUID().replaceAll('-', '');
  await pool.query(`CREATE DATABASE ${name}`); const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  return store;
}
async function legacy30(store) {
  await dropInventoryForLegacyFixture(store);
  for (const table of MEDIA_STORAGE_TABLES.toReversed()) await store.exec(`DROP TABLE ${table}`);
  for (const table of ['mcp_v2_authorization_request','mcp_v2_scope_consent','mcp_v2_approval_challenge','mcp_v2_approval','mcp_v2_event','mcp_v2_operation','mcp_v2_schema']) await store.exec(`DROP TABLE ${table}`);
  await store.exec(operationSchema(store.dialect, { media: false }));
  await store.exec(`CREATE TABLE mcp_v2_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),ddl_digest TEXT NOT NULL CHECK(length(ddl_digest)=64),manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64))${store.dialect === 'sqlite' ? ' STRICT' : ''}`);
  const digest = store.dialect === 'postgres' ? (await store.get(operationStorageManifestSql())).digest
    : sha(JSON.stringify(await store.all("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name GLOB 'mcp_v2_*' OR tbl_name GLOB 'mcp_v2_*' ORDER BY type, name")));
  await store.run('INSERT INTO mcp_v2_schema VALUES(1,1,?,?)', oldDigests[store.dialect], digest);
  await store.setSchemaVersion(30);
}
for (const dialect of ['sqlite','postgres']) {
  test(`${dialect}: schema31 validates the exact legacy30 fingerprint before transactional upgrade`, { skip: dialect === 'postgres' && !base }, async t => {
    assert.equal(sha(operationSchema(dialect, { media: false })), oldDigests[dialect]);
    const store = await fixture(t, dialect);
    assert.equal(await store.schemaVersion(), 32); assert.equal(await operationStorageReady(store), true);
    await legacy30(store);
    assert.equal(await operationStorageReady(store), false);
    await assert.rejects(initializeOperationStorage(store, { enabled: true }), /Incompatible/);
    const migrate = () => dialect === 'sqlite' ? migrateStore(store) : store.transaction(() => upgradePostgres(store, 30));
    const exec = store.exec;
    store.exec = async sql => { await exec(sql); if (sql.includes('CREATE TABLE mcp_v2_media_pin')) throw new Error('Synthetic media DDL interruption'); };
    await assert.rejects(migrate(), /Synthetic media DDL interruption/); store.exec = exec;
    assert.equal(await store.schemaVersion(), 30);
    assert.equal((await store.get('SELECT version FROM mcp_v2_schema WHERE id=1')).version, 1);
    await migrate(); assert.equal(await store.schemaVersion(), 32); assert.equal(await operationStorageReady(store), true);
    assert.equal((await store.get('SELECT version FROM mcp_v2_schema WHERE id=1')).version, 2);
    for (const table of MEDIA_STORAGE_TABLES) assert.equal((await store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0);
    await store.exec('DROP INDEX mcp_v2_media_stage_lease'); assert.equal(await operationStorageReady(store), false);
  });
  test(`${dialect}: media quota limits, unknown policy and RESTRICT ownership reject malformed storage`, { skip: dialect === 'postgres' && !base }, async t => {
    const store = await fixture(t, dialect);
    await store.run("INSERT INTO mcp_v2_media_quota VALUES('synthetic','TENANT','tenant',33554432,24)");
    for (const sql of ["UPDATE mcp_v2_media_quota SET reserved_bytes=33554433", "UPDATE mcp_v2_media_quota SET active_slots=25", "UPDATE mcp_v2_media_quota SET owner_key='other'", "UPDATE mcp_v2_media_quota SET kind='MODEL'"]) await assert.rejects(store.run(sql));
    await assert.rejects(store.run("INSERT INTO mcp_v2_media_quota VALUES('synthetic','CLIENT','not-a-hash',0,0)"));
    const fks = dialect === 'sqlite' ? await store.all("PRAGMA foreign_key_list('mcp_v2_media_stage')") : await store.all("SELECT constraint_name FROM information_schema.table_constraints WHERE table_name='mcp_v2_media_stage' AND constraint_type='FOREIGN KEY'");
    assert.deepEqual(fks, []);
    for (const table of MEDIA_STORAGE_TABLES.filter(value => value !== 'mcp_v2_media_event')) assert.ok(excludedImportTables.includes(table));
    assert.doesNotMatch(mediaSchema(dialect), /CASCADE|BETWEEN/);
  });
}
