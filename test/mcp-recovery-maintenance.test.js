import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openNodeStore } from '../src/store.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { openPostgresStore } from '../src/postgres-store.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { ensureAdmin, createSession } from '../src/auth.js';
import { createAccount } from '../src/accounts.js';
import { liveGrant, hash, secret, stamp } from '../src/mcp/credentials.js';
import { createOAuth } from '../src/mcp/oauth.js';
import { readMcpMaintenanceConfig } from '../src/mcp/maintenance-config.js';
import { parseCleanupArguments, parseRecoveryArguments, runSellerMcpCleanup, runAllSellerMcpCleanup, runSellerMcpRecovery } from '../src/mcp/cleanup-runner.js';

const exec = promisify(execFile), base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw Error('Disposable PostgreSQL required.');
const password = 'T7!pQ9xV4mK2rD8zL6nF1cH5jB3sA0wE', issuer = 'https://seller.example.test', resource = issuer + '/mcp';
const cleanup = new URL('../scripts/cleanup-seller-mcp.js', import.meta.url).pathname, recovery = new URL('../scripts/recover-seller-mcp.js', import.meta.url).pathname;
const inheritedEnv = () => ({ PATH: process.env.PATH, NODE_ENV: 'production', ADMIN_USERNAME: 'fixture_owner', ADMIN_PASSWORD: password,
  DB_PATH: '/tmp/synthetic-maintenance/shop.db', PUBLIC_ORIGIN: 'https://shop.example.test', SELLER_ORIGIN: issuer, MCP_ENABLED: '1', MCP_V2_ENABLED: '1', MCP_V2_MEDIA_ENABLED: '1',
  MCP_V2_CATALOG_MEDIA_CREATE_ENABLED: '1', MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED: '1', MCP_V2_PRODUCTION_PROFILE: 'seller-operations-v1',
  MCP_V2_BACKEND_IDENTITY: 'sha256:' + 'a'.repeat(64), MCP_V2_EPOCH_FILE: '/absent-private-epoch', MCP_V2_MEDIA_TOKEN_FILE: '/absent-private-token' });
async function folder(t) { const path = await mkdtemp(join(tmpdir(), 'shopping-maintenance-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function fixture(t, dialect, { initialize = true } = {}) {
  let store, url, admin, name;
  const directory = await folder(t), path = join(directory, 'shop.db');
  if (dialect === 'postgres') {
    admin = new pg.Pool({ connectionString: base }); name = 'shopping_test_maintenance_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE DATABASE ${name}`); const connection = new URL(base); connection.pathname = '/' + name; url = connection.href;
    store = initialize ? await openPostgresDatabase(url) : openPostgresStore(url, { max: 1 });
  } else store = initialize ? await openDatabase(path) : openNodeStore(path);
  t.after(async () => { try { await store.close(); } finally { if (admin) { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); } } });
  return { store, config: url ? { databaseUrl: url } : { dbPath: path }, env: { ...inheritedEnv(), ...(url ? { DATABASE_URL: url } : { DB_PATH: path }) } };
}
async function family(store, accountId, tenantId = 'default') {
  const clientId = secret(), grantId = randomUUID(), code = secret(), access = secret(), refresh = secret(), requestId = randomUUID(), unboundId = randomUUID();
  const created = stamp(-1000), expires = stamp(86400000), version = (await store.get('SELECT oauth_auth_version FROM seller_account WHERE id=?', accountId)).oauth_auth_version;
  await store.run("INSERT INTO oauth_client(id,tenant_id,issuer,client_name,redirect_uris_json,auth_method,created_at,expires_at) VALUES(?,?,?,'PRIVATE_CLIENT','[\"https://client.example.com/callback\"]','none',?,?)", clientId, tenantId, issuer, created, expires);
  await store.run("INSERT INTO oauth_grant(id,account_id,client_id,tenant_id,issuer,resource,scopes,account_auth_version,created_at,absolute_expires_at) VALUES(?,?,?,?,?,?,'catalog.read',?,?,?)", grantId, accountId, clientId, tenantId, issuer, resource, version, created, expires);
  await store.run("INSERT INTO oauth_authorization_code(code_hash,grant_id,redirect_uri,resource,challenge,created_at,expires_at) VALUES(?,?,'https://client.example.com/callback',?,?,?,?)", hash(code), grantId, resource, secret(), created, expires);
  for (const [value, kind] of [[access, 'access'], [refresh, 'refresh']]) await store.run("INSERT INTO oauth_token(token_hash,kind,grant_id,resource,scopes,issued_at,expires_at,generation) VALUES(?,?,?,?,'catalog.read',?,?,0)", hash(value), kind, grantId, resource, created, expires);
  for (const [id, account] of [[requestId, accountId], [unboundId, null]]) await store.run("INSERT INTO oauth_authorization_request(id,browser_nonce_hash,client_id,tenant_id,resource,redirect_uri,state,challenge,challenge_method,scopes,created_at,expires_at,account_id) VALUES(?,?,?,?,?,'https://client.example.com/callback','PRIVATE_STATE',?,'S256','catalog.read',?,?,?)", id, hash(secret()), clientId, tenantId, resource, secret(), created, expires, account);
  await createSession(store, accountId);
  return { grantId, code, requestId, unboundId };
}

test('maintenance-only configuration keeps real production and disables every MCP runtime without inspecting worker inputs', () => {
  const env = inheritedEnv();
  for (const key of ['MCP_V2_EPOCH_FILE', 'MCP_V2_MEDIA_TOKEN_FILE', 'MCP_V2_PRODUCTION_PROFILE', 'MCP_V2_BACKEND_IDENTITY']) Object.defineProperty(env, key, { enumerable: true, get() { throw Error('Forbidden maintenance input read'); } });
  const config = readMcpMaintenanceConfig(env);
  assert.equal(config.production, true); assert.equal(config.mcpEnabled, false);
  for (const key of ['mcpV2', 'mcpMedia', 'mcpCatalogMediaCreate', 'mcpCatalogMediaUpdate']) assert.deepEqual(config[key], { enabled: false });
});

test('all-shop and recovery arguments enforce closed bounded pages and explicit cursors', () => {
  const id = randomUUID();
  assert.deepEqual(parseCleanupArguments(['--all']), { all: true, passes: 1, limit: 20, after: null });
  assert.deepEqual(parseCleanupArguments(['--all', '10', '--limit=2', '--after=' + id]), { all: true, passes: 10, limit: 2, after: id });
  for (const args of [['--all', '--tenant=default'], ['--all', '--all'], ['--all', '11'], ['--all', '--limit=21'], ['--all', '--after=default'], ['--all', '--limit=1', '--limit=2']]) assert.throws(() => parseCleanupArguments(args));
  assert.deepEqual(parseRecoveryArguments([]), { tenantId: 'default', phase: 'accounts', after: null, limit: 100 });
  for (const args of [['--limit=101'], ['--limit=0'], ['--phase=all'], ['--after=default'], ['--tenant=bad'], ['--tenant=default', '--tenant=default'], ['--password=PRIVATE']]) assert.throws(() => parseRecoveryArguments(args));
});

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !base ? 'Disposable PostgreSQL not configured.' : false };
  test(`${dialect}: host recovery invalidates bounded legacy families/sessions and unbound requests without resetting passwords`, options, async t => {
    const f = await fixture(t, dialect); await ensureAdmin(f.store, 'fixture_owner', password);
    await createAccount(f.store, { username: 'fixture_manager', role: 'MANAGER', password }, 'synthetic_owner');
    await createAccount(f.store, { username: 'fixture_staff', role: 'STAFF', password }, 'synthetic_owner');
    const before = await f.store.all('SELECT id,password_hash,active,must_change_password,oauth_auth_version FROM seller_account ORDER BY id');
    const families = []; for (const row of before) families.push(await family(f.store, row.id));
    const owner = await f.store.get("SELECT id FROM seller_account WHERE role='OWNER'"), ownerFamily = families[before.findIndex(row => row.id === owner.id)];
    assert.ok(await liveGrant(f.store, ownerFamily.grantId, { tenantId: 'default', issuer, resource }));
    const originalCompany = await f.store.get('SELECT * FROM company_setting');
    let cursor = null, pages = 0;
    do {
      const value = await runSellerMcpRecovery({ config: f.config, limit: 1, after: cursor }); pages++;
      assert.equal(value.processed, 1); assert.equal(value.complete, false); cursor = value.nextCursor;
      if (cursor === null) assert.equal(value.nextPhase, 'requests');
    } while (cursor !== null);
    assert.equal(pages, 3);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM session')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant WHERE revoked_at IS NULL')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_token WHERE revoked_at IS NULL')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_authorization_code WHERE consumed_at IS NULL')).n), 0);
    for (const record of families) assert.ok((await f.store.get('SELECT consumed_at FROM oauth_authorization_request WHERE id=?', record.requestId)).consumed_at);
    let complete = false; cursor = null;
    while (!complete) { const value = await runSellerMcpRecovery({ config: f.config, phase: 'requests', after: cursor, limit: 1 }); complete = value.complete; cursor = value.nextCursor; }
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_authorization_request WHERE consumed_at IS NULL')).n), 0);
    assert.equal(await liveGrant(f.store, ownerFamily.grantId, { tenantId: 'default', issuer, resource }), null);
    const oauth = createOAuth({ store: f.store, config: { sellerOrigin: issuer }, tenantId: 'default', limit: async () => {} });
    const ownerClient = (await f.store.get('SELECT client_id FROM oauth_grant WHERE id=?', ownerFamily.grantId)).client_id;
    const request = new Request(issuer + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body:
      new URLSearchParams({ grant_type: 'authorization_code', code: ownerFamily.code, client_id: ownerClient, redirect_uri: 'https://client.example.com/callback',
        code_verifier: secret() + secret(), resource }).toString() });
    await assert.rejects(oauth.token(request, 'synthetic-recovery'), error => error.error === 'invalid_grant');
    const after = await f.store.all('SELECT id,password_hash,active,must_change_password,oauth_auth_version FROM seller_account ORDER BY id');
    assert.deepEqual(after.map(row => ({ ...row })), before.map(row => ({ ...row, oauth_auth_version: row.oauth_auth_version + 1 })));
    assert.deepEqual(await f.store.get('SELECT * FROM company_setting'), originalCompany);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n), 0);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event='INVALIDATE'")).n), 3);
    await runSellerMcpRecovery({ config: f.config, limit: 100 });
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM session')).n), 0); // Repetition safely revokes again.
  });

  test(`${dialect}: recovery audit failure rolls back session deletion, grant revocation and account version`, options, async t => {
    const f = await fixture(t, dialect); await ensureAdmin(f.store, 'fixture_owner', password);
    const account = await f.store.get('SELECT * FROM seller_account'); await family(f.store, account.id);
    const run = f.store.run, dependencies = { openDefault: async () => ({ ...f.store, close: async () => {}, run: async (sql, ...args) => {
      if (/INSERT INTO mcp_audit/.test(sql)) throw Error('Synthetic recovery audit failure'); return run(sql, ...args);
    } }) };
    await assert.rejects(runSellerMcpRecovery({ config: f.config }, dependencies), /Synthetic recovery audit failure/);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM session')).n), 1);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant WHERE revoked_at IS NULL')).n), 1);
    assert.equal((await f.store.get('SELECT oauth_auth_version FROM seller_account')).oauth_auth_version, account.oauth_auth_version);
  });

  test(`${dialect}: real maintenance CLI ignores inherited full-profile worker selectors and returns only secret-free counts`, options, async t => {
    const f = await fixture(t, dialect); await ensureAdmin(f.store, 'fixture_owner', password);
    const account = await f.store.get('SELECT id FROM seller_account'); await family(f.store, account.id);
    const result = await exec(process.execPath, [recovery, '--limit=1'], { env: f.env });
    assert.deepEqual(JSON.parse(result.stdout), { phase: 'accounts', processed: 1, nextPhase: 'requests', nextCursor: null, complete: false });
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|password|postgres:|hash|token/);
    const cleaned = await exec(process.execPath, [cleanup, '--all'], { env: f.env });
    assert.deepEqual(JSON.parse(cleaned.stdout), { processedTenants: 1, cleanupPassesPerTenant: 1, nextCursor: null, complete: true });
  });

  test(`${dialect}: empty and wrong schema targets are rejected without creating or upgrading tables`, options, async t => {
    const f = await fixture(t, dialect, { initialize: false });
    const tableNames = async () => f.store.dialect === 'sqlite' ? f.store.all("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name") : f.store.all("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const before = await tableNames();
    for (const run of [runSellerMcpCleanup, runSellerMcpRecovery]) await assert.rejects(run({ config: f.config }));
    assert.deepEqual(await tableNames(), before);
    if (dialect === 'postgres') await f.store.exec('CREATE TABLE schema_meta(id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_meta VALUES(1,29)');
    else await f.store.setSchemaVersion(29);
    const old = await tableNames();
    for (const run of [runSellerMcpCleanup, runSellerMcpRecovery]) await assert.rejects(run({ config: f.config }), /unavailable/);
    assert.deepEqual(await tableNames(), old); assert.equal(await f.store.schemaVersion(), 29);
  });
}

test('missing SQLite maintenance target is not initialized', async t => {
  const path = join(await folder(t), 'missing.db');
  await assert.rejects(runSellerMcpCleanup({ config: { dbPath: path } }));
  await assert.rejects(runSellerMcpRecovery({ config: { dbPath: path } }));
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

async function tenantFixture(t) {
  const f = await fixture(t, 'postgres'), admin = new pg.Pool({ connectionString: base });
  const name = 'shopping_test_maintenance_platform_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE ${name}`); const url = new URL(base); url.pathname = '/' + name;
  const platform = await openPlatformDatabase(url.href);
  t.after(async () => { await platform.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const integrationKeys = parseKeyFile('k1=' + randomBytes(32).toString('base64')), box = createSecretBox(integrationKeys), ids = [];
  for (const [index, status] of ['ACTIVE', 'SUSPENDED', 'DELETING', 'PURGED'].entries()) {
    const id = '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'), sealed = box.seal('PRIVATE_TENANT_PASSWORD', 'TENANT_DB:' + id); ids.push(id);
    await platform.run('INSERT INTO tenant(id,code,name,status,currency,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, 'maint' + index, 'Synthetic maintenance shop', status, 'MYR', 't_maintenance' + index + '_00000000', 't_maintenance' + index + '_00000000', sealed.sealed, sealed.keyId, stamp(), stamp());
  }
  const config = { ...f.config, platform: { databaseUrl: url.href }, integrationKeys };
  const opened = [], dependencies = { openPlatform: async () => ({ ...platform, close: async () => {} }),
    openDefault: async () => { throw Error('Default fallback is forbidden.'); }, openTenant: async value => {
      const url = new URL(value); assert.equal(url.password, 'PRIVATE_TENANT_PASSWORD'); assert.equal(url.username, url.pathname.slice(1));
      opened.push(url.pathname.slice(1)); return { ...f.store, close: async () => {} };
    } };
  return { ...f, config, platform, ids, dependencies, opened };
}

test('postgres: all-shop cleanup uses bounded stable pages and the existing ACTIVE/SUSPENDED fence', { skip: !base }, async t => {
  const f = await tenantFixture(t);
  const first = await runAllSellerMcpCleanup({ config: f.config, limit: 1 }, f.dependencies);
  assert.deepEqual(first, { processedTenants: 1, cleanupPassesPerTenant: 1, nextCursor: f.ids[0], complete: false });
  const second = await runAllSellerMcpCleanup({ config: f.config, limit: 1, after: first.nextCursor }, f.dependencies);
  assert.deepEqual(second, { processedTenants: 1, cleanupPassesPerTenant: 1, nextCursor: null, complete: true });
  assert.deepEqual(f.opened, ['t_maintenance0_00000000', 't_maintenance1_00000000']);
  assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n), 0);
  assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n), 0);
  for (const id of f.ids.slice(2)) await assert.rejects(runSellerMcpRecovery({ config: f.config, tenantId: id }, f.dependencies), /unavailable/);
  assert.equal(f.opened.length, 2);
});

test('postgres: recovery rechecks suspended tenant identity and lifecycle under the platform lock before credentials change', { skip: !base }, async t => {
  const f = await tenantFixture(t), tenantId = f.ids[1];
  await ensureAdmin(f.store, 'fixture_owner', password); const account = await f.store.get('SELECT id FROM seller_account');
  await family(f.store, account.id, tenantId);
  const observer = new pg.Client({ connectionString: f.config.platform.databaseUrl }); await observer.connect();
  try {
    const dependencies = { ...f.dependencies, openTenant: async value => {
      await observer.query("SET lock_timeout='100ms'");
      await assert.rejects(observer.query("UPDATE tenant SET status='DELETING' WHERE id=$1", [tenantId]), { code: '55P03' });
      return f.dependencies.openTenant(value);
    } };
    assert.equal((await runSellerMcpRecovery({ config: f.config, tenantId }, dependencies)).processed, 1);
  } finally { await observer.end(); }
  assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM session')).n), 0);
  await createSession(f.store, account.id);
  await f.platform.run("UPDATE tenant SET status='DELETING',revision=revision+1 WHERE id=?", tenantId);
  await assert.rejects(runSellerMcpRecovery({ config: f.config, tenantId }, f.dependencies), /unavailable/);
  assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM session')).n), 1);
});
