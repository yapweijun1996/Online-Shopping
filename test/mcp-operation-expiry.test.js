import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { expireOperations } from '../src/mcp/operation-expiry.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) {
  throw new Error('Disposable PostgreSQL test database required.');
}
const tenantGuard = { withActiveTenant: async (id, work) => {
  if (id !== 'synthetic') throw new Error('Denied tenant.');
  return work({ revision: 1 });
} };
const digest = 'a'.repeat(64);

async function fixture(t, dialect) {
  let store;
  if (dialect === 'sqlite') {
    store = await openDatabase(':memory:');
    t.after(() => store.close());
  } else {
    const pool = new pg.Pool({ connectionString: base });
    const name = `shopping_test_expiry_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  }
  await store.transaction(() => store.exec(operationSchema(dialect)));
  async function operation(state, expiresAt, tenant = 'synthetic', approvalExpires = null) {
    const id = randomUUID();
    await store.run(`INSERT INTO mcp_v2_operation(id, tenant_id, tenant_revision, account_id, client_id, grant_id,
      epoch_hash, build_digest, issuer, resource, tool_name, required_scope, required_capability, risk, resource_type,
      envelope_json, preview_hash, request_hash, idempotency_hash, state, created_at, expires_at, correlation_id)
      VALUES (?, ?, 1, 'account', 'client', 'grant', ?, ?, 'https://example.test', 'https://example.test/mcp',
      'catalog.preview_update', 'catalog.write', 'catalog.write', 'MEDIUM', 'product', '{}', ?, ?, ?, ?, ?, ?, ?)`,
    id, tenant, digest, digest, digest, digest, id.replaceAll('-', '') + digest.slice(0, 32), state,
    '2020-01-01T00:00:00.000Z', expiresAt, randomUUID());
    if (approvalExpires) await store.run(`INSERT INTO mcp_v2_approval(operation_id, approver_id, session_hash,
      preview_hash, decision, approved_at, expires_at) VALUES (?, 'account', ?, ?, 'APPROVED', ?, ?)`,
    id, digest, digest, '2020-01-01T00:00:00.000Z', approvalExpires);
    return id;
  }
  return { store, operation };
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: expiry is bounded, tenant-scoped, atomic and retains replay evidence`,
    { skip: dialect === 'postgres' && !base }, async (t) => {
      const { store, operation } = await fixture(t, dialect);
      const old = '2021-01-01T00:00:00.000Z', future = '2099-01-01T00:00:00.000Z';
      const first = await operation('PENDING_APPROVAL', old);
      const approved = await operation('APPROVED', future, 'synthetic', old);
      const live = await operation('PENDING_APPROVAL', future);
      const other = await operation('PENDING_APPROVAL', old, 'other');
      const config = { store, tenantGuard, tenantId: 'synthetic', limit: 1 };
      assert.deepEqual(await expireOperations(config), { expired: 1 });
      assert.equal((await store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', first)).state, 'EXPIRED');
      assert.deepEqual(await expireOperations(config), { expired: 1 });
      assert.equal((await store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', approved)).state, 'EXPIRED');
      assert.ok((await store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', approved)).consumed_at);
      assert.equal((await store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', live)).state, 'PENDING_APPROVAL');
      assert.equal((await store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', other)).state, 'PENDING_APPROVAL');
      assert.deepEqual(await expireOperations(config), { expired: 0 });
      const saved = await store.get('SELECT idempotency_hash, envelope_json FROM mcp_v2_operation WHERE id = ?', first);
      assert.equal(saved.envelope_json, '{}');
      assert.equal(saved.idempotency_hash.length, 64);
      await assert.rejects(store.run('UPDATE mcp_v2_operation SET idempotency_hash = ? WHERE id = ?', saved.idempotency_hash, live));
      const events = await store.all('SELECT * FROM mcp_v2_event ORDER BY operation_id');
      assert.equal(events.length, 2);
      assert.ok(events.every((event) => event.event === 'EXPIRE' && event.tenant_id === 'synthetic'));
      await assert.rejects(expireOperations({ ...config, limit: 101 }), TypeError);
      await assert.rejects(expireOperations({ ...config, tenantId: 'other' }), /Denied tenant/);

      const fault = await operation('APPROVED', old, 'synthetic', old);
      const broken = { ...store, run: async (sql, ...args) => {
        if (sql.includes('INSERT INTO mcp_v2_event')) throw new Error('Synthetic audit failure');
        return store.run(sql, ...args);
      } };
      await assert.rejects(expireOperations({ ...config, store: broken }), /Synthetic audit failure/);
      assert.equal((await store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', fault)).state, 'APPROVED');
      assert.equal((await store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', fault)).consumed_at, null);
      const races = await Promise.all([expireOperations(config), expireOperations(config)]);
      assert.equal(races.reduce((sum, value) => sum + value.expired, 0), 1);
      assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ?', fault)).n), 1);
    });
}
