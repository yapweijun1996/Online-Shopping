import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createPlatformTenantOperationGuard } from '../src/platform/tenant-operation-guard.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { hash, stamp } from '../src/mcp/credentials.js';
import { operationReceiptExpiry } from '../src/mcp/operation-maintenance.js';
import { parseCleanupArguments, runSellerMcpCleanup } from '../src/mcp/cleanup-runner.js';

const exec = promisify(execFile), base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable PostgreSQL test database required.');
const script = new URL('../scripts/cleanup-seller-mcp.js', import.meta.url).pathname;
const safeEnv = () => ({ PATH: process.env.PATH, NODE_ENV: 'test', ADMIN_USERNAME: 'fixture_owner', ADMIN_PASSWORD: 'Synthetic-cleanup-password-2026!',
  SHOP_MODE: 'manual', MCP_ENABLED: '0', MCP_V2_ENABLED: '0' });
async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-cleanup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function openPg(t, prefix = 'shopping_test_cleanup') {
  const admin = new pg.Pool({ connectionString: base }), name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  return { store, url: url.href, admin, name };
}
async function proposal(store, tenantId = 'default', extra = {}) {
  const id = randomUUID(), old = '2020-01-01T00:00:00.000Z';
  const row = { id, tenant_id: tenantId, tenant_revision: 0, account_id: randomUUID(), client_id: 'synthetic-client', grant_id: randomUUID(),
    epoch_hash: 'a'.repeat(64), build_digest: 'b'.repeat(64), issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp',
    tool_name: 'catalog.preview_update', required_scope: 'catalog.write', required_capability: 'catalog.write', risk: 'MEDIUM', resource_type: 'product',
    resource_id: randomUUID(), expected_revision: '1', envelope_json: '{"proposal":{"name":"PRIVATE_EXPIRED_PROPOSAL"}}', preview_hash: 'c'.repeat(64),
    request_hash: 'd'.repeat(64), idempotency_hash: hash(id), state: 'REJECTED', created_at: old, expires_at: '2020-01-01T00:10:00.000Z',
    correlation_id: randomUUID(), receipt_expires_at: operationReceiptExpiry(stamp(3600000)), redacted_at: null, result_json: null, ...extra };
  const keys = Object.keys(row);
  await store.run(`INSERT INTO mcp_v2_operation (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((key) => row[key]));
  return row;
}
async function oldClient(store, tenantId = 'default') {
  await store.run(`INSERT INTO oauth_client(id,tenant_id,issuer,client_name,redirect_uris_json,auth_method,created_at,expires_at)
    VALUES (?, ?, 'https://seller.example.test', 'PRIVATE_OLD_CLIENT', '["https://client.example.test/callback"]', 'none', ?, ?)`,
  randomUUID(), tenantId, '2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z');
}

test('cleanup arguments retain bounded pass count and reject ambiguous tenant selections', () => {
  const tenant = randomUUID();
  assert.deepEqual(parseCleanupArguments([]), { passes: 100, tenantId: 'default' });
  assert.deepEqual(parseCleanupArguments(['2', `--tenant=${tenant}`]), { passes: 2, tenantId: tenant });
  assert.deepEqual(parseCleanupArguments(['--tenant=default', '1000']), { passes: 1000, tenantId: 'default' });
  for (const args of [['0'], ['1001'], ['1e2'], ['01'], ['2', '3'], ['--tenant=other'], ['--tenant=default', '--tenant=default'], [`--tenant=${tenant.toUpperCase()}`], ['--unknown']]) assert.throws(() => parseCleanupArguments(args), TypeError);
});
for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: real feature-off CLI drains repeated bounded passes and retains legacy cleanup`, { skip: dialect === 'postgres' && !base }, async (t) => {
    const directory = await folder(t), path = join(directory, 'shop.db');
    const pgFixture = dialect === 'postgres' ? await openPg(t) : null;
    const store = pgFixture?.store ?? await openDatabase(path); if (!pgFixture) t.after(() => store.close());
    await store.exec('CREATE TABLE synthetic_commerce_guard (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await store.run("INSERT INTO synthetic_commerce_guard VALUES (1, 'UNCHANGED')");
    await store.transaction(async () => { for (let index = 0; index < 105; index++) await proposal(store); });
    await oldClient(store);
    const env = { ...safeEnv(), ...(pgFixture ? { DATABASE_URL: pgFixture.url } : { DB_PATH: path }) };
    const first = await exec(process.execPath, [script, '1'], { env });
    assert.deepEqual(JSON.parse(first.stdout), { cleanupPasses: 1 }); assert.doesNotMatch(first.stdout + first.stderr, /PRIVATE_|postgresql:|password|proposal/);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE envelope_json IS NULL')).n, 100);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM oauth_client')).n, 0);
    const retired = await proposal(store, 'default', { receipt_expires_at: '2020-04-01T00:00:00.000Z' });
    const second = await exec(process.execPath, [script, '2'], { env }); assert.deepEqual(JSON.parse(second.stdout), { cleanupPasses: 2 });
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE envelope_json IS NULL')).n, 105);
    assert.equal(await store.get('SELECT id FROM mcp_v2_operation WHERE id = ?', retired.id), undefined);
    assert.equal((await store.get('SELECT value FROM synthetic_commerce_guard')).value, 'UNCHANGED');
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n, 0);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n, 0);
  });
}
test('CLI rejects invalid arguments/configuration without printing private values', async (t) => {
  const directory = await folder(t);
  for (const args of [['1001'], ['--tenant=unknown'], ['1', '--tenant=default', '--tenant=default']]) {
    await assert.rejects(exec(process.execPath, [script, ...args], { env: { ...safeEnv(), DB_PATH: join(directory, 'unopened.db'), DATABASE_URL: 'PRIVATE_INVALID_URL' } }), (error) => {
      assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.doesNotMatch(error.stderr, /PRIVATE_|postgres:|ADMIN_PASSWORD/); return true;
    });
  }
  await assert.rejects(exec(process.execPath, [script, '1'], { env: { ...safeEnv(), DATABASE_URL: 'PRIVATE_INVALID_URL' } }), (error) => {
    assert.equal(error.code, 1); assert.doesNotMatch(error.stderr, /PRIVATE_INVALID_URL/); return true;
  });
});
test('cleanup has no non-default fallback and rejects an incorrectly supplied default identity', async (t) => {
  let opens = 0;
  await assert.rejects(runSellerMcpCleanup({ config: {}, tenantId: randomUUID(), passes: 1 }, { openDefault: () => { opens++; } }), /unavailable/);
  assert.equal(opens, 0);
  const directory = await folder(t), path = join(directory, 'identity.db'), store = await openDatabase(path);
  await oldClient(store, randomUUID()); await proposal(store, randomUUID());
  await store.close();
  await assert.rejects(runSellerMcpCleanup({ config: { dbPath: path, mcpEnabled: false, mcpV2: { enabled: false } }, passes: 1 }), /unavailable/);
  const check = await openDatabase(path); t.after(() => check.close());
  assert.equal((await check.get('SELECT COUNT(*) AS n FROM oauth_client')).n, 1);
  assert.equal((await check.get('SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE envelope_json IS NOT NULL')).n, 1);
});

async function platformFixture(t) {
  const admin = new pg.Pool({ connectionString: base });
  const platformName = `shopping_test_cleanup_platform_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${platformName}`);
  const url = new URL(base); url.pathname = '/' + platformName;
  const platform = await openPlatformDatabase(url.href);
  const shopName = `t_cleanuptest_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE ${shopName}`);
  const shopUrl = new URL(base); shopUrl.pathname = '/' + shopName;
  const store = await openPostgresDatabase(shopUrl.href);
  t.after(async () => { await store.close(); await platform.close(); await admin.query(`DROP DATABASE ${shopName} WITH (FORCE)`); await admin.query(`DROP DATABASE ${platformName} WITH (FORCE)`); await admin.end(); });
  const integrationKeys = parseKeyFile(`k1=${randomBytes(32).toString('base64')}`), box = createSecretBox(integrationKeys);
  const id = randomUUID(), sealed = box.seal('PRIVATE_SYNTHETIC_PASSWORD', `TENANT_DB:${id}`), now = stamp();
  await platform.run(`INSERT INTO tenant(id,code,name,status,currency,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at)
    VALUES (?, 'cleanuptest', 'Synthetic shop', 'SUSPENDED', 'MYR', ?, ?, ?, ?, ?, ?)`, id, shopName, shopName, sealed.sealed, sealed.keyId, now, now);
  const config = { platform: { databaseUrl: url.href }, integrationKeys, mcpEnabled: false, mcpV2: { enabled: false } };
  let opens = 0, closes = 0, fallback = 0;
  const dependencies = {
    openPlatform: async () => ({ ...platform, close: async () => {} }),
    openDefault: async () => { fallback++; throw new Error('Unexpected default fallback.'); },
    openTenant: async (value) => {
      opens++; const connection = new URL(value);
      assert.equal(connection.pathname, '/' + shopName); assert.equal(connection.username, shopName); assert.equal(connection.password, 'PRIVATE_SYNTHETIC_PASSWORD');
      return { ...store, close: async () => { closes++; } };
    },
  };
  return { platform, store, config, dependencies, id, opens: () => opens, closes: () => closes, fallback: () => fallback, shopName };
}
test('postgres: suspended-shop hygiene removes expired proposals/audit while ordinary authority stays denied', { skip: !base }, async (t) => {
  const f = await platformFixture(t), op = await proposal(f.store, f.id);
  await oldClient(f.store, f.id);
  await f.store.exec('CREATE TABLE synthetic_commerce_guard (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  await f.store.run("INSERT INTO synthetic_commerce_guard VALUES (1, 'UNCHANGED')");
  const auditId = randomUUID();
  await f.store.run(`INSERT INTO mcp_v2_event(id,at,tenant_id,tool_name,operation_id,event,outcome,correlation_id)
    VALUES (?, '2020-01-01T00:00:00.000Z', ?, 'catalog.preview_update', ?, 'REJECT', 'REJECTED', ?)`, auditId, f.id, op.id, randomUUID());
  let authorized = false;
  const normalGuard = createPlatformTenantOperationGuard(f.platform);
  await assert.rejects(normalGuard.withActiveTenant(f.id, () => { authorized = true; }), { status: 503 });
  assert.equal(authorized, false);
  assert.deepEqual(await runSellerMcpCleanup({ config: f.config, tenantId: f.id, passes: 2 }, f.dependencies), { cleanupPasses: 2 });
  assert.equal((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id = ?', op.id)).envelope_json, null);
  assert.equal(await f.store.get('SELECT id FROM mcp_v2_event WHERE id = ?', auditId), undefined);
  assert.equal((await f.store.get('SELECT value FROM synthetic_commerce_guard')).value, 'UNCHANGED');
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n, 0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n, 0);
  await assert.rejects(normalGuard.withActiveTenant(f.id, () => { authorized = true; }), { status: 503 });
  assert.equal(authorized, false); assert.equal(f.opens(), 1); assert.equal(f.closes(), 1); assert.equal(f.fallback(), 0);
});
test('postgres: cleanup rejects lifecycle/identity changes and never falls back on bad sealed credentials', { skip: !base }, async (t) => {
  const f = await platformFixture(t);
  for (const status of ['DELETING', 'PURGED', 'PROVISIONING', 'FAILED']) {
    await f.platform.run('UPDATE tenant SET status = ?, revision = revision + 1 WHERE id = ?', status, f.id);
    await assert.rejects(runSellerMcpCleanup({ config: f.config, tenantId: f.id, passes: 1 }, f.dependencies), /unavailable/);
  }
  assert.equal(f.opens(), 0); assert.equal(f.fallback(), 0);
  await f.platform.run("UPDATE tenant SET status = 'ACTIVE', revision = revision + 1 WHERE id = ?", f.id);
  await assert.rejects(runSellerMcpCleanup({ config: f.config, tenantId: randomUUID(), passes: 1 }, f.dependencies), /unavailable/);
  const saved = await f.platform.get('SELECT database_password_sealed FROM tenant WHERE id = ?', f.id);
  await f.platform.run('UPDATE tenant SET database_password_sealed = ? WHERE id = ?', Buffer.from('PRIVATE_BAD_SEALED_DATA'), f.id);
  await assert.rejects(runSellerMcpCleanup({ config: f.config, tenantId: f.id, passes: 1 }, f.dependencies));
  assert.equal(f.opens(), 0); assert.equal(f.fallback(), 0);
  await f.platform.run('UPDATE tenant SET database_password_sealed = ? WHERE id = ?', saved.database_password_sealed, f.id);
  await oldClient(f.store, f.id);
  let calls = 0;
  const swapped = { ...f.dependencies, openPlatform: async () => ({ ...f.platform, close: async () => {}, transaction: async (work) => {
    if (++calls === 2) await f.platform.run('UPDATE tenant SET database_name = ? WHERE id = ?', `t_othercleanuptest_${randomUUID().slice(0, 8)}`, f.id);
    return f.platform.transaction(work);
  } }) };
  await assert.rejects(runSellerMcpCleanup({ config: f.config, tenantId: f.id, passes: 1 }, swapped), /unavailable/);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM oauth_client')).n, 1);
  assert.equal(f.fallback(), 0); assert.equal(f.closes(), 1);
});
test('postgres: platform row is locked before the tenant connection is opened', { skip: !base }, async (t) => {
  const f = await platformFixture(t);
  await oldClient(f.store, f.id);
  const observer = new pg.Client({ connectionString: f.config.platform.databaseUrl }); await observer.connect();
  try {
    let checked = false;
    const dependencies = { ...f.dependencies, openTenant: async (url) => {
      await observer.query("SET lock_timeout = '100ms'");
      await assert.rejects(observer.query("UPDATE tenant SET status = 'DELETING' WHERE id = $1", [f.id]), { code: '55P03' });
      checked = true;
      return f.dependencies.openTenant(url);
    } };
    await runSellerMcpCleanup({ config: f.config, tenantId: f.id, passes: 1 }, dependencies);
    assert.equal(checked, true);
    assert.equal((await f.platform.get('SELECT status FROM tenant WHERE id = ?', f.id)).status, 'SUSPENDED');
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM oauth_client')).n, 0);
  } finally { await observer.end(); }
});
