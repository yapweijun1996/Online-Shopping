import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { operationStorageReady } from '../src/mcp/operation-runtime.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { restoreSchema39AuditFixture } from './helpers/legacy-audit-fixture.js';

const insert = (store, toolName) => store.get(`INSERT INTO mcp_audit
  (id,at,tenant_id,correlation_id,event,tool_name,resource_id,outcome,duration_ms,result_count,operation_id)
  VALUES (?,?,'synthetic',?,'CALL',?,'catalog','COMMITTED',0,1,?) RETURNING *`,
randomUUID(), new Date().toISOString(), randomUUID(), toolName, randomUUID());

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: schema40 widens only the MCP audit allowlist and preserves history and the pruned sequence watermark`, options, async t => {
    const { store } = await inventoryFixture(t, dialect, { seed: false });
    await restoreSchema39AuditFixture(store);
    await store.setSchemaVersion(39);
    assert.equal(await operationStorageReady(store), true);
    const retained = await insert(store, 'catalog.commit_create');
    const pruned = await insert(store, 'catalog.commit_update');
    await store.run('DELETE FROM mcp_audit WHERE id=?', pruned.id);
    const migrate = () => dialect === 'sqlite' ? migrateStore(store) : store.transaction(() => upgradePostgres(store, 39));
    const exec = store.exec;
    store.exec = async sql => {
      await exec(sql);
      if (/DROP TABLE mcp_audit; ALTER TABLE mcp_audit_next40|DROP CONSTRAINT mcp_audit_tool_name_check/.test(sql)) {
        throw new Error('Synthetic schema40 migration interruption');
      }
    };
    try { await assert.rejects(migrate(), /Synthetic schema40 migration interruption/); }
    finally { store.exec = exec; }
    assert.equal(await store.schemaVersion(), 39);
    assert.deepEqual(await store.all('SELECT * FROM mcp_audit'), [retained]);
    assert.equal(await operationStorageReady(store), true);
    await migrate();
    assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
    assert.equal(await operationStorageReady(store), true);
    assert.deepEqual(await store.all('SELECT * FROM mcp_audit'), [retained]);
    assert.equal((await insert(store, 'catalog.preview_create_category')).sequence, pruned.sequence + 1);
    assert.equal((await insert(store, 'catalog.commit_create_category')).sequence, pruned.sequence + 2);
    await assert.rejects(insert(store, 'catalog.unknown'), /constraint/i);
  });
}
