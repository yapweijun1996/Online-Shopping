import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createSession, ensureAdmin } from '../src/auth.js';
import { setupShop } from '../src/shop-setup.js';
import { hash, liveGrant, revokeGrant, secret } from '../src/mcp/credentials.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { createOperationApproval, createOperationReview } from '../src/mcp/operation-approval.js';
import { verifyOperationAuthority } from '../src/mcp/operation-authorization.js';
import { createOAuth } from '../src/mcp/oauth.js';
import { createProtocol, REVISION } from '../src/mcp/protocol.js';
import { operationStorageReady } from '../src/mcp/operation-runtime.js';
import { readStoredOperation } from '../src/mcp/operation-envelope.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname) ||
    !['127.0.0.1', 'localhost'].includes(new URL(base).hostname))) {
  throw new Error('Snapshot tests require the explicitly configured loopback disposable test cluster.');
}
const password = 'Synthetic-restore-password-2026!';
const sellerOrigin = 'https://seller.example.test';
const pgBin = '/usr/lib/postgresql/16/bin';

async function physicalOperationSchema(store) {
  return {
    columns: await store.all("SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY table_name, ordinal_position"),
    constraints: await store.all("SELECT r.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY r.relname, c.conname"),
    indexes: await store.all("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY tablename, indexname"),
  };
}

function postgresEnvironment(url) {
  const parsed = new URL(url);
  if (parsed.search) throw new Error('Synthetic snapshot tools require explicit PostgreSQL connection fields.');
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGCONNECT_TIMEOUT: '5',
    PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGAPPNAME: 'synthetic-mcp-snapshot-test' };
}
function postgresTool(tool, url, args) {
  // Credentials are environment-only, never process arguments, error output or
  // test diagnostics. All files and connections belong to this synthetic fixture.
  const result = spawnSync(path.join(pgBin, tool), args, { env: postgresEnvironment(url),
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.ok(result.status === 0 && !result.error, `Synthetic ${tool} did not complete successfully.`);
}
async function storageFixture(t, dialect) {
  const directory = mkdtempSync(path.join(tmpdir(), 'shop-mcp-snapshot-'));
  chmodSync(directory, 0o700);
  for (const child of ['database', 'snapshots', 'external']) mkdirSync(path.join(directory, child), { mode: 0o700 });
  const epochFile = path.join(directory, 'external', 'operation-epoch');
  writeFileSync(epochFile, secret(), { mode: 0o600 });
  const stores = new Set(), databases = [];
  let control;
  t.after(async () => {
    try {
      for (const store of stores) await store.close();
      if (control) for (const name of databases) await control.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally { await control?.end(); rmSync(directory, { recursive: true, force: true }); }
  });
  const open = async (location) => {
    const store = dialect === 'sqlite' ? await openDatabase(location) : await openPostgresDatabase(location);
    stores.add(store); return store;
  };
  const close = async (store) => { await store.close(); stores.delete(store); };
  let sourceLocation, recoveryLocation;
  if (dialect === 'sqlite') {
    sourceLocation = path.join(directory, 'database', 'original.db');
    recoveryLocation = path.join(directory, 'database', 'recovered.db');
  } else {
    control = new pg.Pool({ connectionString: base });
    for (const suffix of ['original', 'recovered']) {
      const name = `shopping_test_snapshot_${suffix}_${randomUUID().replaceAll('-', '')}`;
      await control.query(`CREATE DATABASE ${name}`); databases.push(name);
    }
    const urlOf = (name) => { const url = new URL(base); url.pathname = '/' + name; return url.href; };
    sourceLocation = urlOf(databases[0]); recoveryLocation = urlOf(databases[1]);
  }
  const snapshot = path.join(directory, 'snapshots', dialect === 'sqlite' ? 'before.db' : 'before.dump');
  const config = () => readConfig({ NODE_ENV: 'test', ADMIN_USERNAME: 'synthetic_owner', ADMIN_PASSWORD: password,
    MCP_ENABLED: '1', MCP_V2_ENABLED: '1', MCP_V2_EPOCH_FILE: epochFile, SHOP_MODE: 'manual',
    SELLER_ORIGIN: sellerOrigin, PUBLIC_ORIGIN: 'https://shop.example.test',
    DB_PATH: path.join(directory, 'database', 'original.db') });
  return { directory, epochFile, sourceLocation, recoveryLocation, snapshot, open, close, config };
}

async function seedSnapshot(store, config) {
  await ensureAdmin(store, 'synthetic_owner', password);
  await setupShop(store, { mode: 'production', shopName: 'Synthetic snapshot shop' });
  const account = await store.get('SELECT * FROM seller_account WHERE username_key = ?', 'synthetic_owner');
  const session = await createSession(store, account.id);
  const binding = { tenantId: 'synthetic-restore', issuer: sellerOrigin, resource: sellerOrigin + '/mcp', mcpV2: config.mcpV2 };
  const tenantGuard = { withActiveTenant: async (tenantId, work) => {
    assert.equal(tenantId, binding.tenantId); return work({ revision: 1 });
  } };
  const clientId = secret(), grantId = randomUUID(), bearer = secret(), refresh = secret();
  const now = new Date().toISOString(), expires = new Date(Date.now() + 3600000).toISOString();
  await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
    VALUES (?, ?, ?, 'Synthetic restore client', ?, 'none', ?, ?)`, clientId, binding.tenantId, binding.issuer,
  '["https://client.example.com/callback"]', now, expires);
  await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes, account_auth_version, created_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'catalog.read catalog.write', ?, ?, ?)`, grantId, account.id, clientId, binding.tenantId,
  binding.issuer, binding.resource, account.oauth_auth_version, now, expires);
  await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
    VALUES (?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId,
  account.oauth_auth_version, operationEpochHash(config.mcpV2.epoch), now);
  for (const [kind, value] of [['access', bearer], ['refresh', refresh]]) {
    await store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
      VALUES (?, ?, ?, ?, 'catalog.read catalog.write', ?, ?, 0)`, hash(value), kind, grantId, binding.resource, now, expires);
  }
  await store.exec('CREATE TABLE synthetic_restore_target(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)');
  const resourceId = randomUUID();
  await store.run('INSERT INTO synthetic_restore_target(id, revision, value) VALUES (?, 1, ?)', resourceId, 'Synthetic original');
  const counts = { applied: 0 };
  const adapter = { resourceType: 'product',
    preview: async (read, args) => {
      const row = await read.get('SELECT * FROM synthetic_restore_target WHERE id = ?', args.id);
      assert.ok(row && row.revision === 1);
      return { resourceId: row.id, expectedRevision: row.revision, proposal: { id: row.id, before: row.value, after: args.value } };
    },
    currentRevision: async (read, envelope) => {
      const row = await read.get('SELECT revision FROM synthetic_restore_target WHERE id = ?', envelope.resourceId);
      return { exists: Boolean(row), revision: row?.revision ?? null };
    },
    apply: async (database, proposal) => {
      counts.applied++;
      await database.run('UPDATE synthetic_restore_target SET value = ?, revision = revision + 1 WHERE id = ?', proposal.after, proposal.id);
      return { id: proposal.id, revision: 2 };
    },
    validResult: (value) => value?.id === resourceId && value.revision === 2,
    toReceipt: (value) => ({ resourceId: value.id, revision: value.revision }),
    validReceipt: (value) => value?.resourceId === resourceId && value.revision === 2 && Object.keys(value).sort().join(',') === 'resourceId,revision',
  };
  const options = (database, runtimeConfig) => ({ store: database, binding: { ...binding, mcpV2: runtimeConfig.mcpV2 },
    sellerOrigin, quickLogin: false, enabled: true, ...runtimeConfig.mcpV2, tenantGuard,
    adapters: { 'catalog.preview_update': adapter } });
  const humanRequest = (method = 'POST') => new Request(sellerOrigin + '/api/v1/seller/mcp/operations', {
    method, headers: { origin: sellerOrigin, cookie: `seller_session=${session.token}`, 'x-csrf-token': session.csrfToken },
  });
  const engine = createOperationEngine(options(store, config)), review = createOperationReview(options(store, config));
  const approved = await engine.prepare({ bearer, toolName: 'catalog.preview_update', args: { id: resourceId, value: 'Synthetic approved change' }, idempotencyKey: 'synthetic-snapshot-approved-0001' });
  const reviewed = await review(humanRequest('GET'), approved.operationId);
  assert.ok(typeof reviewed.challenge === 'string');
  assert.equal((await createOperationApproval(options(store, config))(humanRequest(), {
    operationId: approved.operationId, previewHash: approved.previewHash, challenge: reviewed.challenge, decision: 'approve', password,
  }, 'synthetic-snapshot-approval')).status, 'APPROVED');
  const pending = await engine.prepare({ bearer, toolName: 'catalog.preview_update', args: { id: resourceId, value: 'Synthetic pending change' }, idempotencyKey: 'synthetic-snapshot-pending-0001' });
  const pendingReview = await review(humanRequest('GET'), pending.operationId);
  assert.ok(pendingReview.challenge !== reviewed.challenge, 'Each review receives a fresh challenge.');
  return { account, session, binding, clientId, grantId, bearer, refresh, issuedAt: now, approved, pending,
    pendingReview, resourceId, counts, options, humanRequest };
}

async function mutateOriginal(store, fixture) {
  await store.transaction(async () => {
    await store.run('UPDATE mcp_v2_approval SET consumed_at = ? WHERE operation_id = ?', new Date().toISOString(), fixture.approved.operationId);
    await store.run("UPDATE mcp_v2_operation SET state = 'CANCELLED' WHERE id IN (?, ?)", fixture.approved.operationId, fixture.pending.operationId);
    await revokeGrant(store, fixture.grantId, 'SYNTHETIC_POST_SNAPSHOT_REVOCATION');
    await store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id = ?', fixture.grantId);
    await store.run('DELETE FROM session WHERE token_hash = ?', hash(fixture.session.token));
    await store.run('UPDATE synthetic_restore_target SET revision = 2, value = ? WHERE id = ?', 'Synthetic post-snapshot value', fixture.resourceId);
  });
  assert.ok((await store.get('SELECT revoked_at FROM oauth_grant WHERE id = ?', fixture.grantId)).revoked_at);
  assert.ok((await store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', fixture.approved.operationId)).consumed_at);
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent WHERE grant_id = ?', fixture.grantId)).n, 0);
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM session WHERE token_hash = ?', hash(fixture.session.token))).n, 0);
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: actual separate snapshot restore revives raw approvals and credentials, but external epoch rotation fences all old v2 authority`,
    { skip: dialect === 'postgres' && !base, timeout: 60000 }, async (t) => {
      const storage = await storageFixture(t, dialect), configA = storage.config();
      let source = await storage.open(storage.sourceLocation);
      const fixture = await seedSnapshot(source, configA);
      const sourceStructure = dialect === 'postgres' ? await physicalOperationSchema(source) : null;
      await storage.close(source);
      if (dialect === 'sqlite') { copyFileSync(storage.sourceLocation, storage.snapshot); chmodSync(storage.snapshot, 0o600); }
      else {
        writeFileSync(storage.snapshot, '', { mode: 0o600 });
        postgresTool('pg_dump', storage.sourceLocation, ['--format=custom', '--no-owner', '--no-privileges', '--file', storage.snapshot]);
      }
      assert.equal(statSync(storage.directory).mode & 0o777, 0o700);
      assert.equal(statSync(storage.snapshot).mode & 0o777, 0o600);
      assert.ok(statSync(storage.snapshot).size > 0);
      source = await storage.open(storage.sourceLocation);
      await mutateOriginal(source, fixture);
      await storage.close(source);
      if (dialect === 'sqlite') { copyFileSync(storage.snapshot, storage.recoveryLocation); chmodSync(storage.recoveryLocation, 0o600); }
      else postgresTool('pg_restore', storage.recoveryLocation, ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', new URL(storage.recoveryLocation).pathname.slice(1), storage.snapshot]);
      const recovery = await storage.open(storage.recoveryLocation);
      if (sourceStructure) assert.deepEqual(await physicalOperationSchema(recovery), sourceStructure);
      assert.ok(storage.sourceLocation !== storage.recoveryLocation, 'Recovery uses a separate database.');
      assert.equal(await operationStorageReady(recovery), true);
      assert.equal((await recovery.get('SELECT state FROM mcp_v2_operation WHERE id = ?', fixture.approved.operationId)).state, 'APPROVED');
      assert.equal((await recovery.get('SELECT state FROM mcp_v2_operation WHERE id = ?', fixture.pending.operationId)).state, 'PENDING_APPROVAL');
      assert.equal((await recovery.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', fixture.approved.operationId)).consumed_at, null);
      assert.equal((await recovery.get('SELECT revoked_at FROM oauth_grant WHERE id = ?', fixture.grantId)).revoked_at, null);
      assert.equal((await recovery.get('SELECT COUNT(*) AS n FROM oauth_token WHERE grant_id = ? AND revoked_at IS NULL', fixture.grantId)).n, 2);
      assert.equal((await recovery.get('SELECT COUNT(*) AS n FROM session WHERE token_hash = ?', hash(fixture.session.token))).n, 1);
      assert.equal((await recovery.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent WHERE grant_id = ?', fixture.grantId)).n, 1);
      assert.equal((await recovery.get('SELECT revision FROM synthetic_restore_target WHERE id = ?', fixture.resourceId)).revision, 1);
      const challenge = await recovery.get('SELECT nonce_hash, session_hash, consumed_at FROM mcp_v2_approval_challenge WHERE operation_id = ?', fixture.pending.operationId);
      assert.ok(challenge.nonce_hash === hash(fixture.pendingReview.challenge + ':' + fixture.pending.previewHash));
      assert.ok(challenge.session_hash === hash(fixture.session.token));
      assert.equal(challenge.consumed_at, null);
      writeFileSync(storage.epochFile, secret(), { mode: 0o600 });
      const configB = storage.config(), bindingB = { ...fixture.binding, mcpV2: configB.mcpV2 };
      assert.ok(configA.mcpV2.epoch !== configB.mcpV2.epoch);
      assert.equal(configA.mcpV2.buildDigest, configB.mcpV2.buildDigest, 'Only the external epoch changes.');
      const restoredProposal = await recovery.get('SELECT * FROM mcp_v2_operation WHERE id = ?', fixture.approved.operationId);
      assert.ok(readStoredOperation(restoredProposal, bindingB), 'Restored proposal retains its canonical digest and all stored bindings.');
      assert.equal(restoredProposal.build_digest, configB.mcpV2.buildDigest);
      const allowed = await liveGrant(recovery, fixture.grantId, bindingB, fixture.issuedAt);
      assert.ok(allowed.allowed.includes('catalog.read'));
      assert.ok(!allowed.allowed.includes('catalog.write'), 'Restored old consent does not authorize the new epoch.');
      const denied = (promise) => assert.rejects(promise, { status: 403, code: 'FORBIDDEN' });
      await denied(recovery.transaction(() => verifyOperationAuthority(recovery, { bearer: fixture.bearer, binding: bindingB,
        toolName: 'catalog.commit_update', epochHash: operationEpochHash(configB.mcpV2.epoch) })));
      const optionsB = fixture.options(recovery, configB), engineB = createOperationEngine(optionsB);
      await denied(engineB.prepare({ bearer: fixture.bearer, toolName: 'catalog.preview_update',
        args: { id: fixture.resourceId, value: 'Synthetic denied change' }, idempotencyKey: 'synthetic-after-restore-0001' }));
      await denied(createOperationReview(optionsB)(fixture.humanRequest('GET'), fixture.pending.operationId));
      await denied(createOperationApproval(optionsB)(fixture.humanRequest(), { operationId: fixture.pending.operationId,
        previewHash: fixture.pending.previewHash, challenge: fixture.pendingReview.challenge, decision: 'approve', password }, 'synthetic-restored-pending'));
      await denied(engineB.commit({ bearer: fixture.bearer, toolName: 'catalog.commit_update', operationId: fixture.approved.operationId }));
      assert.equal(fixture.counts.applied, 0);
      assert.equal((await recovery.get('SELECT revision FROM synthetic_restore_target WHERE id = ?', fixture.resourceId)).revision, 1);
      // Existing policy preserves restored v1 read scopes. Epoch fencing alone
      // cannot revoke old read/session credentials: operations must invalidate
      // all restored credentials before a real recovery resumes traffic.
      const protocol = createProtocol({ store: recovery, config: configB, binding: bindingB, limit: async () => {} });
      const response = await protocol(new Request(sellerOrigin + '/mcp', { method: 'POST', headers: {
        authorization: 'Bearer ' + fixture.bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': REVISION,
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }), 'synthetic-restored-read');
      assert.equal(response.status, 200);
      assert.ok((await response.json()).result.tools.some((tool) => tool.name === 'catalog.categories'));
      const oauth = createOAuth({ store: recovery, config: configB, tenantId: bindingB.tenantId, limit: async () => {} });
      await assert.rejects(oauth.token(new Request(sellerOrigin + '/oauth/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token',
          client_id: fixture.clientId, refresh_token: fixture.refresh, resource: bindingB.resource, scope: 'catalog.write' }) }), 'synthetic-restored-refresh'),
      { status: 400, error: 'invalid_scope' });
      assert.equal((await recovery.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', fixture.approved.operationId)).consumed_at, null);
      await assert.rejects(recovery.transaction(async () => {
        await recovery.exec('DROP INDEX mcp_v2_operation_receipt_expiry');
        assert.equal(await operationStorageReady(recovery), false, 'A genuinely missing index still fails readiness after restore.');
        throw new Error('Synthetic rollback of index tamper');
      }), /Synthetic rollback of index tamper/);
      assert.equal(await operationStorageReady(recovery), true);
      if (dialect === 'postgres') {
        await assert.rejects(recovery.transaction(async () => {
          await recovery.exec('ALTER TABLE mcp_v2_operation DROP CONSTRAINT mcp_v2_operation_envelope_json_check');
          await recovery.exec('ALTER TABLE mcp_v2_operation ADD CONSTRAINT mcp_v2_operation_envelope_json_check CHECK (envelope_json IS NULL OR length(envelope_json) <= 65536)');
          assert.equal(await operationStorageReady(recovery), false, 'A weakened constraint still fails readiness after restore.');
          throw new Error('Synthetic rollback of constraint tamper');
        }), /Synthetic rollback of constraint tamper/);
        assert.equal(await operationStorageReady(recovery), true);
      }
    });
}
