import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { upgradePlatformSchema } from '../src/platform/migrations.js';
import { createTenant } from '../src/platform/provisioner.js';
import { createTenantPool } from '../src/platform/tenant-pool.js';
import { createPlatformRuntime } from '../src/platform/runtime.js';
import { openDatabase } from '../src/db.js';

const input = (code) => ({ code, name: 'Fictional ' + code, currency: 'MYR', sellerUsername: code + '.owner' });

test('numbered platform migrations are transactional, repeatable and reject future versions', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), folder = await mkdtemp(join(tmpdir(), 'platform-migrations-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = pathToFileURL(folder + '/');
  await writeFile(join(folder, '002-fixture.sql'), 'CREATE TABLE fixture_marker (id text PRIMARY KEY);');
  assert.equal(await upgradePlatformSchema(f.platform, { targetVersion: 2, directory }), 2);
  assert.equal(await upgradePlatformSchema(f.platform, { targetVersion: 2, directory }), 2);
  await assert.rejects(upgradePlatformSchema(f.platform, { targetVersion: 1, directory }), /Unsupported/);
  await writeFile(join(folder, '003-invalid.sql'), 'CREATE TABLE rolled_back_marker (id text); SELECT nonexistent_function();');
  await assert.rejects(upgradePlatformSchema(f.platform, { targetVersion: 3, directory }));
  assert.equal(await f.platform.schemaVersion(), 2);
  assert.equal((await f.platform.get("SELECT to_regclass('public.rolled_back_marker') AS name")).name, null);
});

test('tenant pools evict idle stores on a timer and reopen with a new store identity', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), result = await createTenant(f.platform, f.deps, input('idle'), 'fixture');
  const row = await f.platform.get('SELECT * FROM tenant WHERE id = ?', result.tenant.id);
  const pool = createTenantPool({ secretBox: f.secretBox, baseUrl: f.baseUrl, idleMs: 150, connectionsPerTenant: 1 }); t.after(() => pool.closeAll());
  const first = await pool.get(row); assert.equal(await first.schemaVersion(), 24);
  await new Promise((resolve) => setTimeout(resolve, 400)); assert.equal(pool.size(), 0);
  const second = await pool.get(row); assert.notEqual(second, first); assert.equal(await second.schemaVersion(), 24);
});

test('provisioning rows stranded after a failed marker reconcile without restarting the backend', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'manual', publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', integrationKeys: f.integrationKeys,
    platform: { adminHost: 'admin.example.test', username: 'owner', password: randomBytes(24).toString('hex'), databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  const runtime = createPlatformRuntime({ store, config }); t.after(() => runtime.close()); await runtime.connect();
  const result = await createTenant(f.platform, f.deps, input('stranded'), 'fixture');
  await f.platform.run("UPDATE tenant SET status='PROVISIONING' WHERE id=?", result.tenant.id);
  await runtime.reconcile();
  const row = await f.platform.get('SELECT status,last_error FROM tenant WHERE id=?', result.tenant.id);
  assert.deepEqual(row, { status: 'FAILED', last_error: 'INTERRUPTED' });
  assert.equal((await f.platform.get("SELECT COUNT(*) AS n FROM platform_audit WHERE action='TENANT_FAILED' AND tenant_id=?",result.tenant.id)).n,1);
  await runtime.reconcile();
  assert.equal((await f.platform.get("SELECT COUNT(*) AS n FROM platform_audit WHERE action='TENANT_FAILED' AND tenant_id=?",result.tenant.id)).n,1);
});

test('worker rechecks a listed tenant status before opening its store', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'manual', integrationKeys: f.integrationKeys,
    platform: { adminHost: 'admin.example.test', username: 'owner', password: randomBytes(24).toString('hex'), databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  const runtime = createPlatformRuntime({ store, config }); t.after(() => runtime.close()); await runtime.connect();
  const created = await createTenant(f.platform, f.deps, input('worker'), 'fixture');
  const [listed] = await runtime.workerTenants.list();
  assert.equal(listed.id, created.tenant.id);
  for (const status of ['SUSPENDED', 'DELETING']) {
    await f.platform.run('UPDATE tenant SET status = ? WHERE id = ?', status, listed.id);
    assert.equal(await runtime.workerTenants.get(listed), null);
    assert.equal(runtime.pool.size(), 0);
  }
  await f.platform.run("UPDATE tenant SET status = 'ACTIVE' WHERE id = ?", listed.id);
  assert.equal(await (await runtime.workerTenants.get(listed)).schemaVersion(), 24);
});
