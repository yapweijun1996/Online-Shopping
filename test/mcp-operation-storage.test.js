import { setupShop } from '../src/shop-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase, ready, SCHEMA_VERSION } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { openPostgresStore } from '../src/postgres-store.js';
import { ensureAdmin, createSession } from '../src/auth.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { canonicalOperationJson, operationPreviewHash } from '../src/mcp/operation-envelope.js';
import { initializeOperationStorage, operationStorageReady, OPERATION_STORAGE_TABLES, OPERATION_STORAGE_META } from '../src/mcp/operation-runtime.js';
import { importSqlite, importTables, excludedImportTables, excludedOperationImportTables, rowsDigest } from '../src/sqlite-import.js';

import { MEDIA_STORAGE_TABLES } from '../src/mcp/media-schema.js';
const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable PostgreSQL test database required.');
const ownerPassword = 'Synthetic-owner-password-2026!';
async function fixture(t, dialect) {
  if (dialect === 'sqlite') {
    const store = await openDatabase(':memory:');
    t.after(() => store.close());
    return store;
  }
  const pool = new pg.Pool({ connectionString: base });
  const name = `shopping_test_storage_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  return store;
}
async function extensionNames(store) {
  const rows = store.dialect === 'sqlite'
    ? await store.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'mcp_v2_*' ORDER BY name")
    : await store.all("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY tablename");
  return rows.map((row) => row.name);
}
async function seedAuthority(store, epoch = secret()) {
  await ensureAdmin(store, 'synthetic_owner', ownerPassword);
  await setupShop(store, { mode: 'production', shopName: 'Synthetic v2 shop' });
  const account = await store.get('SELECT * FROM seller_account WHERE username_key = ?', 'synthetic_owner');
  const session = await createSession(store, account.id);
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 600000).toISOString();
  const binding = { tenantId: 'synthetic', issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp' };
  const clientId = secret(), grantId = randomUUID(), bearer = secret(), requestId = randomUUID();
  await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'none', ?, ?)`, clientId, binding.tenantId, binding.issuer, 'Synthetic client', '["https://client.example.test/callback"]', now, expiry);
  await store.run(`INSERT INTO oauth_authorization_request(id, browser_nonce_hash, client_id, tenant_id, resource, redirect_uri, state, challenge, challenge_method, scopes, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?)`, requestId, hash(secret()), clientId, binding.tenantId, binding.resource,
    'https://client.example.test/callback', 'synthetic-state', secret(), 'catalog.write', now, expiry);
  await store.run('INSERT INTO mcp_v2_authorization_request(request_id, epoch_hash, created_at) VALUES (?, ?, ?)', requestId, operationEpochHash(epoch), now);
  await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes, account_auth_version, created_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, account.id, clientId, binding.tenantId, binding.issuer, binding.resource, account.oauth_auth_version, now, expiry);
  await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
    VALUES (?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId, account.oauth_auth_version, operationEpochHash(epoch), now);
  await store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
    VALUES (?, 'access', ?, ?, 'catalog.write', ?, ?, 0)`, hash(bearer), grantId, binding.resource, now, expiry);
  return { account, session, binding, clientId, grantId, bearer, epoch, now, expiry };
}
function engineOptions(store, authority, apply = () => { throw new Error('Synthetic adapter unexpectedly executed.'); }) {
  return { store, enabled: true, quickLogin: false, binding: authority.binding, epoch: authority.epoch, buildDigest: 'e'.repeat(64),
    tenantGuard: { withActiveTenant: (_tenant, work) => work({ revision: 1 }) },
    adapters: { 'catalog.preview_create': { resourceType: 'product',
      preview: () => ({ resourceId: null, expectedRevision: null, proposal: { name: 'Synthetic item' } }),
      currentRevision: () => ({ exists: false, revision: null }), apply, validResult: () => true,
      toReceipt: (result) => result, validReceipt: () => true,
    } } };
}
async function pendingOperation(store, authority) {
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 60000).toISOString();
  const envelope = {
    version: 1, operationId: randomUUID(), tenantId: authority.binding.tenantId, tenantRevision: 1,
    accountId: authority.account.id, clientId: authority.clientId, grantId: authority.grantId,
    epochHash: operationEpochHash(authority.epoch), buildDigest: 'e'.repeat(64),
    issuer: authority.binding.issuer, resource: authority.binding.resource,
    toolName: 'catalog.preview_create', resourceType: 'product', resourceId: null, expectedRevision: null,
    requiredScope: 'catalog.write', requiredCapability: 'catalog.write', risk: 'MEDIUM',
    createdAt: now, expiresAt: expiry, idempotencyHash: hash('synthetic-storage-idempotency'),
    correlationId: randomUUID(), proposal: { name: 'Synthetic item' },
  };
  const previewHash = operationPreviewHash(envelope);
  await store.run(`INSERT INTO mcp_v2_operation(id, tenant_id, tenant_revision, account_id, client_id, grant_id,
    epoch_hash, build_digest, issuer, resource, tool_name, required_scope, required_capability, risk, resource_type,
    envelope_json, preview_hash, request_hash, idempotency_hash, state, created_at, expires_at, receipt_expires_at, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`,
  envelope.operationId, envelope.tenantId, 1, envelope.accountId, envelope.clientId, envelope.grantId,
  envelope.epochHash, envelope.buildDigest, envelope.issuer, envelope.resource, envelope.toolName,
  envelope.requiredScope, envelope.requiredCapability, envelope.risk, envelope.resourceType,
  canonicalOperationJson(envelope), previewHash, hash('{}'), envelope.idempotencyHash, now, expiry,
  new Date(Date.now() + 91 * 86400000).toISOString(), envelope.correlationId);
  await store.run(`INSERT INTO mcp_v2_approval(operation_id, approver_id, session_hash, preview_hash, decision, approved_at, expires_at)
    VALUES (?, ?, ?, ?, 'APPROVED', ?, ?)`, envelope.operationId, authority.account.id, hash(authority.session.token), previewHash, now, expiry);
  await store.run(`INSERT INTO mcp_v2_approval_challenge(id, operation_id, nonce_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`, randomUUID(), envelope.operationId, hash(secret()), now, expiry);
  await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, tool_name, operation_id, event, outcome, correlation_id)
    VALUES (?, ?, ?, ?, ?, 'PREPARE', 'PREPARED', ?)`, randomUUID(), now, envelope.tenantId, envelope.toolName, envelope.operationId, envelope.correlationId);
  return { operationId: envelope.operationId, previewHash };
}
async function downgradeOperationStore(store) {
  for (const table of [...MEDIA_STORAGE_TABLES.toReversed(), 'mcp_v2_authorization_request', 'mcp_v2_scope_consent', 'mcp_v2_approval_challenge', 'mcp_v2_approval', 'mcp_v2_event', 'mcp_v2_operation', 'mcp_v2_schema']) await store.exec(`DROP TABLE ${table}`);
  await store.setSchemaVersion(29);
}

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !base };
  test(`${dialect}: extension initialization is explicit, repeatable, base-compatible and readiness checks physical schema`, options, async (t) => {
    const store = await fixture(t, dialect);
    await ensureAdmin(store, 'synthetic_owner', ownerPassword);
    assert.equal(SCHEMA_VERSION, 31);
    assert.equal(await ready(store), true);
    assert.equal(await initializeOperationStorage(store), false);
    assert.equal(await initializeOperationStorage(store, { enabled: false }), false);
    for (const enabled of [undefined, null, 'true', 1]) await assert.rejects(initializeOperationStorage(store, { enabled }), TypeError);
    assert.deepEqual(await extensionNames(store), [...OPERATION_STORAGE_TABLES, OPERATION_STORAGE_META].sort());
    assert.equal(await ready(store, { mcpV2: { enabled: true } }), true);
    assert.equal(await initializeOperationStorage(store, { enabled: true }), true);
    assert.equal(await operationStorageReady(store), true);
    assert.equal(await ready(store, { mcpV2: { enabled: true } }), true);
    assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
    assert.deepEqual(await extensionNames(store), [...OPERATION_STORAGE_TABLES, OPERATION_STORAGE_META].sort());
    await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, tool_name, operation_id, event, outcome, correlation_id)
      VALUES (?, ?, ?, ?, ?, 'DENY', 'FORBIDDEN', ?)`, randomUUID(), new Date().toISOString(), 'synthetic', 'catalog.preview_create', randomUUID(), randomUUID());
    await initializeOperationStorage(store, { enabled: true });
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_event')).n, 1);
    await store.exec('DROP INDEX mcp_v2_operation_expiry');
    assert.equal(await operationStorageReady(store), false);
    assert.equal(await ready(store), false, 'Global schema readiness covers operation storage even when v2 tools are disabled');
    await assert.rejects(initializeOperationStorage(store, { enabled: true }), /Incompatible/);
  });

  test(`${dialect}: partial initialization and post-DDL failure roll back atomically`, options, async (t) => {
    const store = await fixture(t, dialect);
    await downgradeOperationStore(store);
    const exec = store.exec;
    store.exec = async (sql) => { await exec(sql); if (sql.includes('CREATE TABLE mcp_v2_schema')) throw new Error('Synthetic initialization failure'); };
    await assert.rejects(initializeOperationStorage(store, { enabled: true }), /Synthetic initialization failure/);
    assert.deepEqual(await extensionNames(store), []);
    assert.equal(await store.schemaVersion(), 29);
    store.exec = exec;
    await initializeOperationStorage(store, { enabled: true });
    await store.setSchemaVersion(31);
    assert.equal(await operationStorageReady(store), true);
    await store.run('UPDATE mcp_v2_schema SET ddl_digest = ? WHERE id = 1', '0'.repeat(64));
    assert.equal(await operationStorageReady(store), false);
    await assert.rejects(initializeOperationStorage(store, { enabled: true }), /Incompatible/);
  });

  test(`${dialect}: concurrent initializers install one durable extension`, options, async (t) => {
    const store = await fixture(t, dialect);
    assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => initializeOperationStorage(store, { enabled: true }))), [true, true, true, true]);
    assert.equal(await operationStorageReady(store), true);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_schema')).n, 1);
  });

  test(`${dialect}: unversioned prototypes and wrong base versions are rejected without adoption`, options, async (t) => {
    const store = await fixture(t, dialect);
    await downgradeOperationStore(store);
    await store.exec(operationSchema(dialect));
    await assert.rejects(initializeOperationStorage(store, { enabled: true }), /Unversioned/);
    assert.equal(await operationStorageReady(store), false);
    assert.equal((await extensionNames(store)).includes(OPERATION_STORAGE_META), false);
    await store.setSchemaVersion(28);
    await assert.rejects(initializeOperationStorage(store, { enabled: true }), /base schema 29, 30 or 31/);
    assert.equal(await store.schemaVersion(), 28);
  });

  test(`${dialect}: authorization request epoch has strict hash and parent constraints`, options, async (t) => {
    const store = await fixture(t, dialect);
    await initializeOperationStorage(store, { enabled: true });
    await assert.rejects(store.run('INSERT INTO mcp_v2_authorization_request(request_id, epoch_hash, created_at) VALUES (?, ?, ?)', randomUUID(), 'a'.repeat(64), new Date().toISOString()));
    const authority = await seedAuthority(store);
    const request = await store.get('SELECT request_id FROM mcp_v2_authorization_request');
    await assert.rejects(store.run('UPDATE mcp_v2_authorization_request SET epoch_hash = ? WHERE request_id = ?', 'Z'.repeat(64), request.request_id));
    await store.run('DELETE FROM oauth_authorization_request WHERE id = ?', request.request_id);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_authorization_request')).n, 0);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent WHERE grant_id = ?', authority.grantId)).n, 1);
  });
}

test('PostgreSQL existing extension initializes under an explicitly granted application role without DDL privileges', { skip: !base }, async (t) => {
  let owner, app, control, role;
  // Register before fixture cleanup so role privileges can be removed while
  // the synthetic database is available. No existing cluster roles are changed.
  t.after(async () => {
    await app?.close();
    if (role) {
      await owner.exec(`DROP OWNED BY ${role}`);
      await control.query(`DROP ROLE ${role}`);
    }
    await control?.end();
  });
  owner = await fixture(t, 'postgres');
  await initializeOperationStorage(owner, { enabled: true });
  role = `mcp_v2_test_${randomUUID().replaceAll('-', '')}`;
  control = new pg.Pool({ connectionString: base });
  const database = (await owner.get('SELECT current_database() AS name')).name;
  const password = secret();
  await control.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  const url = new URL(base); url.pathname = '/' + database; url.username = role; url.password = password;
  app = openPostgresStore(url.href);
  assert.equal(await operationStorageReady(app), false, 'No implicit grants to guessed application roles');
  await owner.exec(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON schema_meta TO ${role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${[OPERATION_STORAGE_META, ...OPERATION_STORAGE_TABLES].join(', ')} TO ${role}`);
  assert.equal((await app.get("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS allowed")).allowed, false);
  assert.equal(await operationStorageReady(app), true);
  assert.equal(await initializeOperationStorage(app, { enabled: true }), true);
});

test('SQLite snapshot restore retains durable extension but rotated external epoch denies a restored approval before any adapter write', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'shop-mcp-v2-restore-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databaseDirectory = path.join(directory, 'database');
  mkdirSync(databaseDirectory);
  const epochFile = path.join(directory, 'external-epoch');
  writeFileSync(epochFile, secret(), { mode: 0o600 });
  const original = path.join(databaseDirectory, 'original.db'), backup = path.join(databaseDirectory, 'backup.db'), restored = path.join(databaseDirectory, 'restored.db');
  const source = await openDatabase(original);
  await initializeOperationStorage(source, { enabled: true });
  const authority = await seedAuthority(source, readFileSync(epochFile, 'utf8'));
  const operation = await pendingOperation(source, authority);
  await source.close();
  copyFileSync(original, backup);
  // The live database consumes the approval after the snapshot was taken.
  const live = await openDatabase(original);
  await live.run('UPDATE mcp_v2_approval SET consumed_at = ? WHERE operation_id = ?', new Date().toISOString(), operation.operationId);
  await live.close();
  copyFileSync(backup, restored);
  const recovery = await openDatabase(restored); t.after(() => recovery.close());
  assert.equal(await operationStorageReady(recovery), true);
  assert.equal((await recovery.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', operation.operationId)).consumed_at, null);
  let applied = 0;
  writeFileSync(epochFile, secret()); // Outside the database snapshot/restore set.
  const engine = createOperationEngine(engineOptions(recovery, { ...authority, epoch: readFileSync(epochFile, 'utf8') }, () => { applied++; return {}; }));
  await assert.rejects(engine.commit({ bearer: authority.bearer, toolName: 'catalog.commit_create', operationId: operation.operationId }), { status: 403, code: 'FORBIDDEN' });
  assert.equal(applied, 0);
  assert.equal((await recovery.get('SELECT state FROM mcp_v2_operation WHERE id = ?', operation.operationId)).state, 'APPROVED');
});

test('SQLite-to-PostgreSQL import excludes all v2 authority, preserves historical events, and rolls back on failure', { skip: !base }, async (t) => {
  const source = await fixture(t, 'sqlite'), target = await fixture(t, 'postgres');
  await initializeOperationStorage(source, { enabled: true });
  const authority = await seedAuthority(source);
  await pendingOperation(source, authority);
  assert.deepEqual([...importTables, ...excludedImportTables].sort(),
    (await source.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((row) => row.name).sort());
  await initializeOperationStorage(target, { enabled: true });
  const run = target.run;
  target.run = async (sql, ...values) => { if (sql.startsWith('INSERT INTO mcp_v2_event')) throw new Error('Synthetic audit import failure'); return run(sql, ...values); };
  await assert.rejects(importSqlite(source, target), /Synthetic audit import failure/);
  target.run = run;
  assert.equal((await target.get('SELECT COUNT(*) AS n FROM seller_account')).n, 0);
  assert.equal((await target.get('SELECT COUNT(*) AS n FROM oauth_token')).n, 0);
  assert.equal(await operationStorageReady(target), true);
  const result = await importSqlite(source, target);
  assert.ok(result.tables.some((table) => table.table === 'mcp_v2_event' && table.rows > 0));
  assert.equal(rowsDigest(await source.all('SELECT * FROM mcp_v2_event')), rowsDigest(await target.all('SELECT * FROM mcp_v2_event')));
  for (const table of excludedOperationImportTables.filter((name) => name !== OPERATION_STORAGE_META)) {
    assert.equal((await target.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, table);
  }
  const verify = createOperationEngine(engineOptions(target, authority));
  await assert.rejects(verify.prepare({ bearer: authority.bearer, toolName: 'catalog.preview_create', args: {}, idempotencyKey: 'synthetic-after-import-0001' }), { status: 403, code: 'FORBIDDEN' });
  await assert.rejects(importSqlite(source, target), /no MCP v2 history|fresh baseline/);
});
