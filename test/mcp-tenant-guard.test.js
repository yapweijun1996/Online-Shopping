import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createPlatformTenantOperationGuard } from '../src/platform/tenant-operation-guard.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) {
  throw new Error('Disposable PostgreSQL test database required.');
}

test('platform guard requires a PostgreSQL store', () => {
  assert.throws(() => createPlatformTenantOperationGuard(null), TypeError);
  assert.throws(() => createPlatformTenantOperationGuard({ dialect: 'sqlite' }), TypeError);
});

test('platform guard serializes a tenant operation against suspension on another connection',
  { skip: !base }, async (t) => {
    const admin = new pg.Pool({ connectionString: base });
    const name = `shopping_test_guard_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    const platform = await openPlatformDatabase(url.href);
    const other = new pg.Client({ connectionString: url.href }); await other.connect();
    t.after(async () => { await other.end(); await platform.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
    const tenant = randomUUID(), now = new Date().toISOString();
    await platform.run(`INSERT INTO tenant(id, code, name, status, currency, is_default, created_at, updated_at)
      VALUES (?, ?, ?, 'ACTIVE', 'MYR', 1, ?, ?)`, tenant, 'synthetic', 'Synthetic shop', now, now);
    const guard = createPlatformTenantOperationGuard(platform);
    assert.equal(await guard.withActiveTenant('default', () => 'allowed'), 'allowed');
    await assert.rejects(guard.withActiveTenant('missing', () => 'not called'), { status: 503, code: 'SHOP_UNAVAILABLE' });

    let enter, release, attempted;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const updateAttempted = new Promise((resolve) => { attempted = resolve; });
    const operation = guard.withActiveTenant('default', async () => { enter(); await held; return 'committed'; });
    await entered;
    let suspensionFinished = false;
    const suspension = (async () => {
      await other.query('BEGIN'); attempted();
      await other.query("UPDATE tenant SET status = 'SUSPENDED', revision = revision + 1 WHERE id = $1", [tenant]);
      await other.query('COMMIT'); suspensionFinished = true;
    })();
    await updateAttempted;
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(suspensionFinished, false);
    } finally { release(); }
    assert.equal(await operation, 'committed');
    await suspension;
    assert.equal(suspensionFinished, true);
    let called = false;
    await assert.rejects(guard.withActiveTenant('default', () => { called = true; }), { status: 503, code: 'SHOP_UNAVAILABLE' });
    assert.equal(called, false);

    await other.query("UPDATE tenant SET status = 'ACTIVE', revision = revision + 1 WHERE id = $1", [tenant]);
    await assert.rejects(guard.withActiveTenant('default', () => { throw new Error('Synthetic failure.'); }), /Synthetic failure/);
    // The failed callback must not strand a platform lock.
    await other.query("UPDATE tenant SET status = 'SUSPENDED', revision = revision + 1 WHERE id = $1", [tenant]);
  });
