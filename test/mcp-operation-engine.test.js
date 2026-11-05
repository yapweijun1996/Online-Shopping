import { setupShop } from '../src/shop-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import pg from 'pg';
import { ensureAdmin, createSession, deleteSession } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { ApiError } from '../src/http.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createPlatformTenantOperationGuard } from '../src/platform/tenant-operation-guard.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
import { createOperationApproval, createOperationReview } from '../src/mcp/operation-approval.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) {
  throw new Error('Disposable PostgreSQL test database required.');
}
const raceSkip = !base || new URL(base).hostname !== '127.0.0.1'
  ? 'Separate-process races require a loopback synthetic PostgreSQL server.' : false;
const password = 'Synthetic-engine-password-2026!';

test('postgres: platform suspension is serialized with a tenant operation commit', { skip: raceSkip }, async (t) => {
  const f = await fixture(t, 'postgres');
  const admin = new pg.Pool({ connectionString: base });
  const name = `shopping_test_platform_guard_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const platform = await openPlatformDatabase(url.href);
  const other = new pg.Client({ connectionString: url.href }); await other.connect();
  const observer = new pg.Pool({ connectionString: base }); t.after(() => observer.end());
  t.after(async () => { await other.end(); await platform.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const now = new Date().toISOString();
  await platform.run(`INSERT INTO tenant(id, code, name, status, currency, database_name, database_role,
    database_password_sealed, database_key_id, created_at, updated_at)
    VALUES (?, ?, ?, 'ACTIVE', 'MYR', ?, ?, ?, ?, ?, ?)`, f.binding.tenantId, 'synthetic', 'Synthetic shop',
  't_synthetic_12345678', 't_synthetic_12345678', Buffer.from('synthetic'), 'k1', now, now);
  const tenantGuard = createPlatformTenantOperationGuard(platform);
  let entered, release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const adapter = { ...f.adapter, apply: async (...args) => {
    const result = await f.adapter.apply(...args); entered(); await held; return result;
  } };
  const engine = createOperationEngine({ ...f.options, tenantGuard, adapters: { 'catalog.preview_update': adapter } });
  const approve = createOperationApproval({ store: f.store, binding: f.binding, sellerOrigin: f.binding.issuer,
    quickLogin: false, epoch: f.options.epoch, buildDigest: f.options.buildDigest, tenantGuard, enabled: true });
  const op = await engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
    args: { id: f.productId, expectedRevision: 1, name: 'Guarded synthetic update' }, idempotencyKey: 'synthetic-guarded-operation' });
  const request = new Request('https://seller.example.test/api/v1/seller/mcp/approval', { method: 'POST',
    headers: { origin: f.binding.issuer, cookie: `seller_session=${f.session.token}`, 'x-csrf-token': f.session.csrfToken } });
  const review = createOperationReview({ store: f.store, binding: f.binding, sellerOrigin: f.binding.issuer,
    quickLogin: false, epoch: f.options.epoch, buildDigest: f.options.buildDigest, tenantGuard, enabled: true });
  const reviewOp = (value) => review(new Request(f.binding.issuer + '/api/v1/seller/mcp/operations/' + value.operationId,
    { headers: { cookie: `seller_session=${f.session.token}` } }), value.operationId);
  await approve(request, { challenge: (await reviewOp(op)).challenge, operationId: op.operationId, previewHash: op.previewHash, decision: 'approve', password }, 'guard-ip');
  const worker = concurrentWorker(t, { databaseUrl: url.href }, 'tenant');
  await worker.event('ready');
  const committing = engine.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: op.operationId });
  await inside;
  worker.child.send({ type: 'start', tenantId: f.binding.tenantId });
  await worker.event('attempt');
  try {
    await waitForLock(observer, worker.name, ['transactionid', 'tuple']);
    assert.equal(worker.events.some((event) => event.type === 'committed'), false);
  }
  finally { release(); }
  assert.equal((await committing).status, 'COMMITTED');
  await worker.event('committed');
  assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Guarded synthetic update');
  await assert.rejects(engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
    args: { id: f.productId, expectedRevision: 2, name: 'Must not run' }, idempotencyKey: 'synthetic-suspended-operation' }), { status: 503 });
  await other.query("UPDATE tenant SET status = 'ACTIVE', revision = revision + 1 WHERE id = $1", [f.binding.tenantId]);
  const pending = await engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
    args: { id: f.productId, expectedRevision: 2, name: 'Must not survive suspension' }, idempotencyKey: 'synthetic-resumed-operation' });
  await approve(request, { challenge: (await reviewOp(pending)).challenge, operationId: pending.operationId, previewHash: pending.previewHash, decision: 'approve', password }, 'guard-ip-2');
  await other.query("UPDATE tenant SET status = 'SUSPENDED', revision = revision + 1 WHERE id = $1", [f.binding.tenantId]);
  await other.query("UPDATE tenant SET status = 'ACTIVE', revision = revision + 1 WHERE id = $1", [f.binding.tenantId]);
  await assert.rejects(engine.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: pending.operationId }), { status: 403 });
  assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Guarded synthetic update');
});
async function fixture(t, dialect) {
  let store, databaseUrl, applicationName;
  if (dialect === 'sqlite') {
    store = await openDatabase(':memory:'); t.after(() => store.close());
  } else {
    const pool = new pg.Pool({ connectionString: base }), name = `shopping_test_engine_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    applicationName = `mcp_v2_parent_${randomUUID().replaceAll('-', '')}`;
    url.searchParams.set('application_name', applicationName);
    databaseUrl = url.href;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  }
  await store.transaction(() => store.exec(operationSchema(dialect)));
  await store.exec('CREATE TABLE synthetic_product (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL)');
  const productId = randomUUID();
  await store.run('INSERT INTO synthetic_product(id, name, revision) VALUES (?, ?, ?)', productId, 'Original synthetic name', 1);
  await ensureAdmin(store, 'synthetic_owner', password);
  await setupShop(store, { mode: 'production', shopName: 'Synthetic v2 shop' });
  const account = await store.get('SELECT * FROM seller_account WHERE username_key = ?', 'synthetic_owner');
  const session = await createSession(store, account.id);
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 600000).toISOString();
  const binding = { tenantId: 'synthetic', issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp' };
  // Test-only guard; production needs a platform lock held across the callback.
  const tenantGuard = { withActiveTenant: async (id, work) => {
    if (id !== binding.tenantId) throw new ApiError(403, 'FORBIDDEN', 'Synthetic tenant denied.');
    return work({ revision: 1 });
  } };
  const clientId = secret(), grantId = randomUUID(), bearer = secret(), epoch = secret(),
    epochHash = operationEpochHash(epoch), buildDigest = 'e'.repeat(64);
  await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, clientId, binding.tenantId, binding.issuer, 'Synthetic client',
  JSON.stringify(['https://client.example.test/callback']), 'none', now, expiry);
  await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes,
    account_auth_version, created_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  grantId, account.id, clientId, binding.tenantId, binding.issuer, binding.resource, 'catalog.write', account.oauth_auth_version, now, expiry);
  await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId, 'catalog.write', account.oauth_auth_version, epochHash, now);
  await store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
    VALUES (?, 'access', ?, ?, ?, ?, ?, 0)`, hash(bearer), grantId, binding.resource, 'catalog.write', now, expiry);
  // This synthetic adapter is a test fixture, not an implementation of a
  // commerce tool. Production adapters must call the existing domain service.
  const adapter = {
    resourceType: 'product',
    preview: async (read, args) => {
      if (!args || Object.keys(args).sort().join(',') !== 'expectedRevision,id,name' ||
          typeof args.name !== 'string' || args.name.length > 100 || !Number.isSafeInteger(args.expectedRevision)) throw new Error('Invalid synthetic input.');
      const product = await read.get('SELECT id, name, revision FROM synthetic_product WHERE id = ?', args.id);
      if (!product || product.revision !== args.expectedRevision) throw new Error('Stale synthetic input.');
      return { resourceId: product.id, expectedRevision: product.revision,
        proposal: { id: product.id, before: product.name, after: args.name } };
    },
    currentRevision: async (read, envelope) => {
      const row = await read.get('SELECT revision FROM synthetic_product WHERE id = ?', envelope.resourceId);
      return { exists: Boolean(row), revision: row?.revision ?? null };
    },
    apply: async (database, proposal) => {
      await database.run('UPDATE synthetic_product SET name = ?, revision = revision + 1 WHERE id = ?', proposal.after, proposal.id);
      return database.get('SELECT id, name, revision FROM synthetic_product WHERE id = ?', proposal.id);
    },
    toReceipt: (value) => ({ id: value.id, revision: value.revision }),
    validReceipt: (value) => Boolean(value && Object.keys(value).sort().join(',') === 'id,revision' &&
      typeof value.id === 'string' && Number.isSafeInteger(value.revision)),
    validResult: (value) => Boolean(value && Object.keys(value).sort().join(',') === 'id,name,revision' &&
      typeof value.id === 'string' && typeof value.name === 'string' && Number.isSafeInteger(value.revision)),
  };
  const options = { store, binding, adapters: { 'catalog.preview_update': adapter }, enabled: true, quickLogin: false, epoch, buildDigest, tenantGuard };
  const engine = createOperationEngine(options);
  const approve = createOperationApproval({ store, binding, sellerOrigin: binding.issuer, quickLogin: false, epoch, buildDigest, tenantGuard, enabled: true });
  const request = () => new Request('https://seller.example.test/api/v1/seller/mcp/approval', {
    method: 'POST', headers: { origin: binding.issuer, cookie: `seller_session=${session.token}`, 'x-csrf-token': session.csrfToken },
  });
  let serial = 0;
  async function prepare(name = 'Updated synthetic name') {
    const args = { id: productId, expectedRevision: (await store.get('SELECT revision FROM synthetic_product WHERE id = ?', productId)).revision, name };
    const idempotencyKey = `synthetic-operation-${String(++serial).padStart(8, '0')}`;
    const op = await engine.prepare({ bearer, toolName: 'catalog.preview_update', args, idempotencyKey });
    return { ...op, args, idempotencyKey };
  }
  const review = createOperationReview({ store, binding, sellerOrigin: binding.issuer, quickLogin: false, epoch, buildDigest, tenantGuard, enabled: true });
  const approveOp = async (op, ip) => {
    const reviewed = await review(new Request(binding.issuer + '/api/v1/seller/mcp/operations/' + op.operationId,
      { headers: { cookie: `seller_session=${session.token}` } }), op.operationId);
    return approve(request(), { operationId: op.operationId, previewHash: op.previewHash, challenge: reviewed.challenge, decision: 'approve', password }, ip);
  };
  const commit = (op) => engine.commit({ bearer, toolName: 'catalog.commit_update', operationId: op.operationId });
  return { store, productId, account, session, grantId, bearer, binding, adapter, options, engine, prepare, approveOp, commit,
    databaseUrl, applicationName };
}

// A separate Node process uses the same PostgreSQL store transaction contract
// as the application. It receives only synthetic test IDs and credentials.
function concurrentWorker(t, f, kind = 'operation') {
  const name = `mcp_v2_worker_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(f.databaseUrl); url.searchParams.set('application_name', name);
  const helper = kind === 'tenant' ? './helpers/mcp-tenant-race-worker.js' : './helpers/mcp-operation-race-worker.js';
  const child = fork(new URL(helper, import.meta.url), [], {
    env: { ...process.env, NODE_ENV: 'test', SHOP_TEST_DATABASE_URL: url.href },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const events = [];
  child.on('message', (message) => events.push(message));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  async function event(type) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = events.find((item) => item?.type === type);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Synthetic worker exited before ${type}.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Synthetic worker did not report ${type}.`);
  }
  return { child, events, event, name };
}

async function waitForLock(pool, applicationName, lockEvents = ['advisory']) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name = $1 AND wait_event_type = 'Lock' AND wait_event = ANY($2)`, [applicationName, lockEvents]);
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected synthetic transaction to wait for the required database lock.');
}

test('postgres: a separate-process grant revocation waits for an in-flight operation', { skip: raceSkip }, async (t) => {
  const f = await fixture(t, 'postgres');
  const observer = new pg.Pool({ connectionString: base }); t.after(() => observer.end());
  const op = await f.prepare('Commit before grant revocation');
  const later = await f.prepare('Must not commit after revocation');
  await f.approveOp(op, 'synthetic-race-approve-1');
  await f.approveOp(later, 'synthetic-race-approve-2');
  let entered, release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const engine = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter,
    apply: async (...values) => { const result = await f.adapter.apply(...values); entered(); await hold; return result; },
  } } });
  const worker = concurrentWorker(t, f);
  await worker.event('ready');
  const commit = engine.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: op.operationId });
  await inside;
  worker.child.send({ type: 'start', action: 'revoke', grantId: f.grantId, accountId: f.account.id, hold: false });
  await worker.event('attempt');
  await waitForLock(observer, worker.name);
  assert.equal(worker.events.some((event) => event.type === 'mutated'), false);
  release();
  assert.equal((await commit).status, 'COMMITTED');
  await worker.event('committed');
  await assert.rejects(f.commit(later), { status: 403 });
  assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Commit before grant revocation');
});

for (const action of ['revoke', 'disable', 'downgrade', 'logout']) {
  test(`postgres: separate-process ${action} commits before a waiting operation`, { skip: raceSkip }, async (t) => {
    const f = await fixture(t, 'postgres');
    const observer = new pg.Pool({ connectionString: base }); t.after(() => observer.end());
    const op = await f.prepare(`Denied after ${action}`);
    await f.approveOp(op, `synthetic-race-${action}`);
    const worker = concurrentWorker(t, f);
    await worker.event('ready');
    worker.child.send({ type: 'start', action, grantId: f.grantId, accountId: f.account.id,
      sessionToken: f.session.token, hold: true });
    await worker.event('mutated');
    // Capture rejection immediately so a surprising early denial is not an
    // unhandled rejection while the lock wait is being observed.
    const result = f.commit(op).then((value) => ({ value }), (error) => ({ error }));
    await waitForLock(observer, f.applicationName);
    worker.child.send({ type: 'release' });
    await worker.event('committed');
    const outcome = await result;
    assert.equal(outcome.error?.status, 403);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Original synthetic name');
  });
}

for (const engineName of ['sqlite', 'postgres']) {
  const options = { skip: engineName === 'postgres' && !base };
  test(`${engineName}: prepared operation needs human approval and commits at most once`, options, async (t) => {
    const f = await fixture(t, engineName);
    assert.throws(() => createOperationEngine({ ...f.options, enabled: false }), TypeError);
    assert.throws(() => createOperationEngine({ ...f.options, quickLogin: true }), TypeError);
    assert.throws(() => createOperationEngine({ ...f.options, tenantGuard: undefined }), TypeError);
    assert.throws(() => createOperationEngine({ ...f.options, epoch: undefined }), TypeError);
    assert.throws(() => createOperationEngine({ ...f.options, buildDigest: 'invalid' }), TypeError);
    assert.throws(() => createOperationEngine({ ...f.options, binding: { ...f.binding, issuer: 'http://seller.example.test' } }), TypeError);
    const op = await f.prepare();
    assert.equal(op.status, 'PENDING_APPROVAL');
    assert.equal((await f.store.get('SELECT revision FROM synthetic_product WHERE id = ?', f.productId)).revision, 1);
    const otherTenant = createOperationEngine({ ...f.options, binding: { ...f.binding, tenantId: 'other' } });
    await assert.rejects(otherTenant.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update', args: op.args,
      idempotencyKey: 'synthetic-other-tenant-key' }), { status: 403 });
    const unsafePreview = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter,
      preview: (read) => read.get("UPDATE synthetic_product SET name = 'Unsafe' RETURNING id"),
    } } });
    await assert.rejects(unsafePreview.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update', args: op.args,
      idempotencyKey: 'synthetic-unsafe-preview-key' }), /read-only query/);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Original synthetic name');
    await assert.rejects(f.engine.prepare({ bearer: 'invalid', toolName: 'catalog.preview_update', args: op.args,
      idempotencyKey: 'synthetic-unauthenticated-key' }), { status: 403 });
    await assert.rejects(f.engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
      args: { ...op.args, id: randomUUID() }, idempotencyKey: 'synthetic-unknown-resource' }), /Stale synthetic input/);
    const replay = await f.engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update', args: op.args, idempotencyKey: op.idempotencyKey });
    assert.equal(replay.operationId, op.operationId);
    assert.equal(replay.replayed, true);
    await assert.rejects(f.engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
      args: { ...op.args, name: 'Different request' }, idempotencyKey: op.idempotencyKey }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
      args: { ...op.args, tenantId: 'another' }, idempotencyKey: 'synthetic-operation-other' }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.engine.commit({ bearer: f.bearer, toolName: 'catalog.commit_update',
      operationId: op.operationId, approved: true, proposal: { after: 'Unapproved' } }), { code: 'INVALID_INPUT' });
    await assert.rejects(f.commit(op), { status: 403 });
    await f.approveOp(op, 'synthetic-ip-1');
    await assert.rejects(f.engine.commit({ bearer: f.bearer, toolName: 'catalog.commit_update',
      operationId: op.operationId, proposal: { after: 'Changed after approval' } }), { code: 'INVALID_INPUT' });
    const result = await Promise.all([f.commit(op), f.commit(op)]);
    assert.deepEqual(result.map((value) => value.replayed).sort(), [false, true]);
    assert.equal((await f.store.get('SELECT revision FROM synthetic_product WHERE id = ?', f.productId)).revision, 2);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Updated synthetic name');
    const approval = await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id = ?', op.operationId);
    assert.ok(approval.consumed_at);
    const events = await f.store.all('SELECT * FROM mcp_v2_event WHERE operation_id = ?', op.operationId);
    assert.equal(events.filter((event) => event.event === 'COMMIT').length, 1);
    assert.doesNotMatch(JSON.stringify(events), /Updated synthetic name|Synthetic-engine-password/);
    await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', new Date().toISOString(), f.grantId);
    await assert.rejects(f.commit(op), { status: 403 }); // even committed replays need a live grant
  });

  test(`${engineName}: stale changes, revoked grants and audit failure cannot mutate business data`, options, async (t) => {
    const f = await fixture(t, engineName);
    const stale = await f.prepare('Stale synthetic name');
    await f.approveOp(stale, 'synthetic-ip-stale');
    await f.store.run('UPDATE synthetic_product SET name = ?, revision = revision + 1 WHERE id = ?', 'Portal edit', f.productId);
    assert.equal((await f.commit(stale)).error, 'STALE_REVISION');
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', stale.operationId)).state, 'CONFLICT');
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');
    assert.ok((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', stale.operationId)).consumed_at);

    const revoked = await f.prepare('Revoked synthetic name');
    await f.approveOp(revoked, 'synthetic-ip-revoked');
    const rotated = createOperationEngine({ ...f.options, epoch: secret() });
    await assert.rejects(rotated.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: revoked.operationId }), { status: 403 });
    const suspended = createOperationEngine({ ...f.options, tenantGuard: { withActiveTenant: async () => {
      throw new ApiError(503, 'SHOP_UNAVAILABLE', 'Synthetic tenant suspended.');
    } } });
    await assert.rejects(suspended.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: revoked.operationId }), { status: 503 });
    const changedBuild = createOperationEngine({ ...f.options, buildDigest: 'f'.repeat(64) });
    await assert.rejects(changedBuild.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: revoked.operationId }), { status: 403 });
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');
    await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', new Date().toISOString(), f.grantId);
    await assert.rejects(f.commit(revoked), { status: 403 });
    await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', f.grantId);
    await f.store.run('UPDATE seller_account SET active = 0 WHERE id = ?', f.account.id);
    await assert.rejects(f.commit(revoked), { status: 403 });
    await f.store.run('UPDATE seller_account SET active = 1, role = ? WHERE id = ?', 'STAFF', f.account.id);
    await assert.rejects(f.commit(revoked), { status: 403 });
    await f.store.run('UPDATE seller_account SET role = ? WHERE id = ?', 'OWNER', f.account.id);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');

    const tampered = await f.prepare('Tampered synthetic name');
    await f.approveOp(tampered, 'synthetic-ip-tampered');
    await f.store.run('UPDATE mcp_v2_operation SET envelope_json = ? WHERE id = ?', '{}', tampered.operationId);
    await assert.rejects(f.commit(tampered), { status: 403 });
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');

    const mismatched = await f.prepare('Mismatched synthetic name');
    await f.approveOp(mismatched, 'synthetic-ip-mismatch');
    await f.store.run('UPDATE mcp_v2_approval SET preview_hash = ? WHERE operation_id = ?', 'b'.repeat(64), mismatched.operationId);
    await assert.rejects(f.commit(mismatched), { status: 403 });
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');

    const failure = await f.prepare('Rolled back synthetic name');
    await f.approveOp(failure, 'synthetic-ip-failure');
    const faultStore = { ...f.store, run: async (sql, ...values) => {
      if (sql.includes('INSERT INTO mcp_v2_event') && values[10] === 'COMMIT') throw new Error('Synthetic audit failure.');
      return f.store.run(sql, ...values);
    } };
    const faulty = createOperationEngine({ ...f.options, store: faultStore });
    await assert.rejects(faulty.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: failure.operationId }), /Synthetic audit failure/);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', failure.operationId)).state, 'FAILED');
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', failure.operationId)).consumed_at, null);

    const expiry = await f.prepare('Expired synthetic name');
    await f.approveOp(expiry, 'synthetic-ip-expiry');
    const approval = await f.store.get('SELECT approved_at FROM mcp_v2_approval WHERE operation_id = ?', expiry.operationId);
    await f.store.run('UPDATE mcp_v2_approval SET expires_at = ? WHERE operation_id = ?',
      new Date(Date.parse(approval.approved_at) + 1000).toISOString(), expiry.operationId);
    const slow = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter,
      apply: async (...values) => {
        const result = await f.adapter.apply(...values);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return result;
      },
    } } });
    await assert.rejects(slow.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: expiry.operationId }), { code: 'EXPIRED' });
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', expiry.operationId)).state, 'EXPIRED');
    assert.ok((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', expiry.operationId)).consumed_at);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');

    const revokeDuring = await f.prepare('Revoke during operation');
    await f.approveOp(revokeDuring, 'synthetic-ip-revoke-during');
    const revoking = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter,
      apply: async (database, ...values) => {
        const result = await f.adapter.apply(database, ...values);
        await database.run('UPDATE oauth_token SET revoked_at = ? WHERE token_hash = ?', new Date().toISOString(), hash(f.bearer));
        return result;
      },
    } } });
    await assert.rejects(revoking.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: revokeDuring.operationId }), { status: 403 });
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');
    assert.equal((await f.store.get('SELECT revoked_at FROM oauth_token WHERE token_hash = ?', hash(f.bearer))).revoked_at, null);

    const immutable = await f.prepare('Immutable synthetic name');
    await f.approveOp(immutable, 'synthetic-ip-immutable');
    const mutating = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter,
      currentRevision: async (_read, envelope) => {
        envelope.proposal.after = 'Changed inside adapter';
        return { exists: true, revision: envelope.expectedRevision };
      },
    } } });
    await assert.rejects(mutating.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: immutable.operationId }), TypeError);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');

    const oversized = await f.prepare('Oversized synthetic result');
    await f.approveOp(oversized, 'synthetic-ip-oversized');
    const oversizedEngine = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter,
      apply: async (...values) => {
        await f.adapter.apply(...values);
        return { data: 'x'.repeat(65536) };
      },
      validResult: () => true,
    } } });
    await assert.rejects(oversizedEngine.commit({ bearer: f.bearer, toolName: 'catalog.commit_update', operationId: oversized.operationId }), TypeError);
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', oversized.operationId)).state, 'FAILED');

    const noSession = await f.prepare('Session revoked name');
    await f.approveOp(noSession, 'synthetic-ip-session');
    await deleteSession(f.store, f.session.token);
    await assert.rejects(f.commit(noSession), { status: 403 });
    assert.equal((await f.store.get('SELECT name FROM synthetic_product WHERE id = ?', f.productId)).name, 'Portal edit');
  });

  test(`${engineName}: bounded pending proposals retain idempotent replay`, options, async (t) => {
    const f = await fixture(t, engineName);
    const first = await f.prepare('Quota fixture 0');
    let seed;
    for (let i = 1; i < 20; i++) seed = await f.prepare(`Quota fixture ${i}`);
    const replay = await f.engine.prepare({ bearer: f.bearer, toolName: 'catalog.preview_update',
      args: first.args, idempotencyKey: first.idempotencyKey });
    assert.equal(replay.replayed, true);
    await assert.rejects(f.prepare('Over client quota'), { status: 429, code: 'RATE_LIMITED' });
    // Leave 19 active for this client, then model 81 other clients' pending
    // operations to exercise the independent tenant-wide ceiling.
    await f.store.run("UPDATE mcp_v2_operation SET state = 'REJECTED' WHERE id = ?", first.operationId);
    for (let i = 0; i < 81; i++) {
      await f.store.run(`INSERT INTO mcp_v2_operation(id, tenant_id, tenant_revision, account_id, client_id, grant_id, epoch_hash, build_digest, issuer, resource, tool_name,
        required_scope, required_capability, risk, resource_type, resource_id, expected_revision, envelope_json, preview_hash,
        request_hash, idempotency_hash, state, created_at, expires_at, correlation_id, receipt_expires_at)
        SELECT ?, tenant_id, tenant_revision, account_id, ?, grant_id, epoch_hash, build_digest, issuer, resource, tool_name, required_scope, required_capability,
        risk, resource_type, resource_id, expected_revision, envelope_json, preview_hash, request_hash, ?, state,
        created_at, expires_at, ?, receipt_expires_at FROM mcp_v2_operation WHERE id = ?`,
      randomUUID(), `synthetic-other-client-${i}`, hash(`synthetic-quota-${i}`), randomUUID(), seed.operationId);
    }
    await assert.rejects(f.prepare('Over tenant quota'), { status: 429, code: 'RATE_LIMITED' });
  });
}
