import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { openDatabase, migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { openPostgresStore } from '../src/postgres-store.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { operationEventSchema } from '../src/mcp/operation-schema.js';
import { mcpAuditSchema } from '../src/mcp/audit-schema.js';
import { operationStorageDdl, operationStorageMetaSchema, operationStorageReady, upgradeOperationAuditStorage } from '../src/mcp/operation-runtime.js';
import { assertMcpAuditStorage, migrateMcpAuditStorage } from '../src/mcp/audit-storage.js';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { importSqlite, rowsDigest } from '../src/sqlite-import.js';
const sha = value => createHash('sha256').update(value).digest('hex');
async function legacyFixture(t, dialect) {
  let store;
  if (dialect === 'sqlite') {
    store = await openDatabase(':memory:'); t.after(() => store.close());
    await store.transaction(async () => {
      await store.exec('DROP TABLE mcp_audit; DROP TABLE mcp_v2_event; DROP TABLE mcp_v2_schema;');
      await store.exec(mcpAuditSchema('sqlite', { version: 33 }));
      await store.exec(operationEventSchema('sqlite', { auditSequence: false }));
      await store.exec(operationStorageMetaSchema('sqlite', { version: 2 }));
      const objects = await store.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'mcp_v2_*' OR tbl_name GLOB 'mcp_v2_*' ORDER BY type,name");
      await store.run('INSERT INTO mcp_v2_schema VALUES(1,2,?,?)', sha(operationStorageDdl('sqlite', { version: 2 })), sha(JSON.stringify(objects)));
      await store.setSchemaVersion(33);
    });
  } else {
    const base = process.env.SHOP_TEST_DATABASE_URL;
    if (process.env.NODE_ENV !== 'test' || !base || !/test/i.test(new URL(base).pathname)) throw new Error('Disposable PostgreSQL required.');
    const pool = new pg.Pool({ connectionString: base }), name = 'shopping_test_audit34_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE DATABASE ${name}`); const url = new URL(base); url.pathname = '/' + name;
    t.after(async () => { if (store) await store.close(); await pool.query(`DROP DATABASE ${name} WITH(FORCE)`); await pool.end(); });
    store = openPostgresStore(url.href);
    await store.exec(await readFile(new URL('./fixtures/postgres-schema33.sql', import.meta.url), 'utf8'));
  }
  const migrate = () => store.transaction(() => dialect === 'sqlite' ? migrateStore(store) : upgradePostgres(store, 33));
  return { store, migrate };
}
async function history(store) {
  const op = randomUUID();
  for (const n of [3,1,2]) {
    const id = `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`, at = '2026-11-01T00:00:00.000Z';
    await store.run(`INSERT INTO mcp_audit(id,at,tenant_id,account_id,client_id,grant_id,correlation_id,event,tool_name,resource_id,outcome,duration_ms,result_count)
      VALUES(?,?, 'synthetic','account','client','grant',?,'READ','catalog.get',?,'OK',0,1)`, id, at, id, op);
    await store.run(`INSERT INTO mcp_v2_event(id,at,tenant_id,account_id,client_id,grant_id,tool_name,resource_id,operation_id,approver_id,event,outcome,correlation_id)
      VALUES(?,?,'synthetic','account','client','grant','catalog.preview_update',?,?,NULL,'PREPARE','PREPARED',?)`, id, at, op, op, id);
  }
  return { mcp: await store.all('SELECT * FROM mcp_audit ORDER BY at,id'), lifecycle: await store.all('SELECT * FROM mcp_v2_event ORDER BY at,id') };
}
for (const dialect of ['sqlite','postgres']) {
  for (const metadataVersion of [2,3]) test(`${dialect}: audit34 with version${metadataVersion} operation metadata rejects partial migration without adoption`, async t => {
    const {store,migrate}=await legacyFixture(t,dialect);await history(store);
    await store.transaction(()=>metadataVersion === 2 ? migrateMcpAuditStorage(store) : upgradeOperationAuditStorage(store));
    const before = { audit: await store.all('SELECT * FROM mcp_audit ORDER BY sequence'), events: await store.all('SELECT * FROM mcp_v2_event ORDER BY id'), metadata: await store.get('SELECT * FROM mcp_v2_schema') };
    await assert.rejects(migrate(),/Partial schema34 audit storage/);
    assert.equal(await store.schemaVersion(),33);assert.equal((await store.get('SELECT version FROM mcp_v2_schema')).version,metadataVersion);
    assert.deepEqual(await store.all('SELECT * FROM mcp_audit ORDER BY sequence'), before.audit);
    assert.deepEqual(await store.all('SELECT * FROM mcp_v2_event ORDER BY id'), before.events);
    assert.deepEqual(await store.get('SELECT * FROM mcp_v2_schema'), before.metadata);
  });
  test(`${dialect}: strict33 audit upgrade preserves all UUIDs and fields and allocates nonreused insertion sequences`, async t => {
    const { store, migrate } = await legacyFixture(t, dialect), before = await history(store);
    await migrate(); assert.equal(await store.schemaVersion(), SCHEMA_VERSION); assert.equal(await operationStorageReady(store), true); await assertMcpAuditStorage(store);
    assert.equal((await store.get('SELECT version FROM mcp_v2_schema')).version, 3);
    const mcp = await store.all('SELECT * FROM mcp_audit ORDER BY sequence'), lifecycle = await store.all('SELECT * FROM mcp_v2_event ORDER BY sequence');
    assert.deepEqual(mcp.map(({ sequence, operation_id, ...row }) => row), before.mcp.map(row => ({ ...row })));
    assert.deepEqual(lifecycle.map(({ sequence, ...row }) => row), before.lifecycle.map(row => ({ ...row })));
    assert.deepEqual(mcp.map(row => row.sequence), [1,2,3]); assert.deepEqual(lifecycle.map(row => row.sequence), [1,2,3]);
    await store.run('DELETE FROM mcp_audit'); await store.run('DELETE FROM mcp_v2_event');
    const id = randomUUID();
    await store.run("INSERT INTO mcp_audit(id,at,tenant_id,correlation_id,event,tool_name,outcome,duration_ms,result_count) VALUES(?,?,'synthetic',?,'CALL','company.commit_update','REPLAY',0,1)", id, new Date().toISOString(), id);
    assert.equal((await store.get('SELECT sequence FROM mcp_audit')).sequence, 4);
    const row = before.lifecycle[0], keys = Object.keys(row);
    await store.run(`INSERT INTO mcp_v2_event(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key]));
    assert.equal((await store.get('SELECT sequence FROM mcp_v2_event')).sequence, 4);
  });
  test(`${dialect}: audit migration interruption rolls back both tables metadata and history`, async t => {
    const { store, migrate } = await legacyFixture(t, dialect), before = await history(store), exec = store.exec;
    store.exec = async sql => { await exec(sql); if (sql.includes('mcp_audit_operation_sequence')) throw new Error('Synthetic audit DDL interruption'); };
    await assert.rejects(migrate(), /Synthetic audit DDL interruption/); store.exec = exec;
    assert.equal(await store.schemaVersion(), 33); assert.equal((await store.get('SELECT version FROM mcp_v2_schema')).version, 2);
    assert.deepEqual(await store.all('SELECT * FROM mcp_audit ORDER BY at,id'), before.mcp);
    assert.deepEqual(await store.all('SELECT * FROM mcp_v2_event ORDER BY at,id'), before.lifecycle);
    await migrate(); assert.equal(await operationStorageReady(store), true);
  });
  test(`${dialect}: unknown schema33 audit shape rejects before operation storage mutation`, async t => {
    const { store, migrate } = await legacyFixture(t, dialect), exec = store.exec;
    await store.exec('ALTER TABLE mcp_audit ADD COLUMN unreviewed TEXT'); let mutation = false;
    store.exec = async sql => { if (/mcp_v2_event_next34|ALTER TABLE mcp_v2_event|DROP TABLE mcp_v2_schema/.test(sql)) mutation = true; return exec(sql); };
    await assert.rejects(migrate(), /Incompatible schema33 MCP audit storage/); store.exec = exec;
    assert.equal(mutation, false); assert.equal(await store.schemaVersion(), 33);
  });
  test(`${dialect}: changed version2 extension is rejected before either audit table is rebuilt`, async t => {
    const { store, migrate } = await legacyFixture(t, dialect), before = await history(store);
    await store.exec('DROP INDEX mcp_v2_operation_client_active');
    await assert.rejects(migrate(), /Incompatible MCP v2 storage extension/);
    assert.equal(await store.schemaVersion(),33);
    assert.deepEqual(await store.all('SELECT * FROM mcp_audit ORDER BY at,id'),before.mcp);
    assert.deepEqual(await store.all('SELECT * FROM mcp_v2_event ORDER BY at,id'),before.lifecycle);
  });
}
test('trusted SQLite import preserves audit identity rows and advances both PostgreSQL sequences', async t => {
  const source = (await mediaFixture(t,'sqlite')).store, target = (await mediaFixture(t,'postgres')).store;
  await history(source);
  const before = new Map();
  for (const name of ['mcp_audit','mcp_v2_event']) before.set(name, rowsDigest(await source.all(`SELECT * FROM ${name}`)));
  await importSqlite(source,target);
  for (const name of ['mcp_audit','mcp_v2_event']) {
    const rows = await target.all(`SELECT * FROM ${name}`); assert.equal(rowsDigest(rows),before.get(name));
    const { sequence, ...row } = rows[0]; row.id=randomUUID(); const keys=Object.keys(row);
    await target.run(`INSERT INTO ${name}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(key=>row[key]));
    assert.equal((await target.get(`SELECT MAX(sequence) n FROM ${name}`)).n,4);
  }
});
