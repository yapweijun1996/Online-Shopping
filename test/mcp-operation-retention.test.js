import { setupShop } from '../src/shop-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { ensureAdmin, createSession } from '../src/auth.js';
import { hash, secret, stamp } from '../src/mcp/credentials.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { initializeOperationStorage } from '../src/mcp/operation-runtime.js';
import { maintainOperations, operationReceiptExpiry, OPERATION_AUDIT_RETENTION_MS } from '../src/mcp/operation-maintenance.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable PostgreSQL test database required.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function fixture(t, dialect) {
  let store;
  if (dialect === 'postgres') {
    const pool = new pg.Pool({ connectionString: base }), name = `shopping_test_retention_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  } else { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  await initializeOperationStorage(store, { enabled: true });
  await store.exec('CREATE TABLE synthetic_receipt_resource (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL)');
  const productId = randomUUID();
  await store.run('INSERT INTO synthetic_receipt_resource VALUES (?, ?, 1)', productId, 'PRIVATE_ORIGINAL_NAME');
  await ensureAdmin(store, 'synthetic_owner', 'Synthetic-retention-password-2026!');
  await setupShop(store, { mode: 'production', shopName: 'Synthetic v2 shop' });
  const account = await store.get("SELECT * FROM seller_account WHERE username_key = 'synthetic_owner'");
  const session = await createSession(store, account.id);
  const epoch = secret(), epochHash = operationEpochHash(epoch), buildDigest = 'e'.repeat(64);
  const binding = { tenantId: 'synthetic', issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp' };
  const tenantGuard = { withActiveTenant: async (id, work) => {
    if (id !== binding.tenantId) throw new Error('Synthetic tenant mismatch.');
    return work({ revision: 1 });
  } };
  const now = stamp(), grantExpiry = stamp(3600000), clientId = secret(), grantId = randomUUID(), bearer = secret();
  await store.run(`INSERT INTO oauth_client(id,tenant_id,issuer,client_name,redirect_uris_json,auth_method,created_at,expires_at)
    VALUES (?, ?, ?, 'Synthetic client', '["https://client.example.test/callback"]', 'none', ?, ?)`, clientId, binding.tenantId, binding.issuer, now, grantExpiry);
  await store.run(`INSERT INTO oauth_grant(id,account_id,client_id,tenant_id,issuer,resource,scopes,account_auth_version,created_at,absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, account.id, clientId, binding.tenantId, binding.issuer, binding.resource, account.oauth_auth_version, now, grantExpiry);
  await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at)
    VALUES (?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId, account.oauth_auth_version, epochHash, now);
  await store.run(`INSERT INTO oauth_token(token_hash,kind,grant_id,resource,scopes,issued_at,expires_at,generation)
    VALUES (?, 'access', ?, ?, 'catalog.write', ?, ?, 0)`, hash(bearer), grantId, binding.resource, now, grantExpiry);
  const adapter = {
    resourceType: 'product',
    preview: async (read, args) => {
      if (Object.keys(args).sort().join(',') !== 'id,name' || !uuid.test(args.id) || typeof args.name !== 'string') throw new Error('Invalid synthetic args.');
      const row = await read.get('SELECT * FROM synthetic_receipt_resource WHERE id = ?', args.id);
      return { resourceId: row.id, expectedRevision: row.revision, proposal: { before: row.name, after: args.name, id: row.id } };
    },
    currentRevision: async (read, envelope) => {
      const row = await read.get('SELECT revision FROM synthetic_receipt_resource WHERE id = ?', envelope.resourceId);
      return { exists: Boolean(row), revision: row?.revision ?? null };
    },
    apply: async (database, proposal) => {
      await database.run('UPDATE synthetic_receipt_resource SET name = ?, revision = revision + 1 WHERE id = ?', proposal.after, proposal.id);
      return database.get('SELECT * FROM synthetic_receipt_resource WHERE id = ?', proposal.id);
    },
    validResult: (row) => row && uuid.test(row.id) && typeof row.name === 'string' && Number.isSafeInteger(row.revision),
    toReceipt: ({ id, revision }) => ({ id, revision }),
    validReceipt: (row) => row && Object.keys(row).sort().join(',') === 'id,revision' && uuid.test(row.id) && Number.isSafeInteger(row.revision) && row.revision > 0,
  };
  const options = { store, binding, epoch, buildDigest, tenantGuard, enabled: true, quickLogin: false, adapters: { 'catalog.preview_update': adapter } };
  const engine = createOperationEngine(options);
  let serial = 0;
  const prepare = (key = `synthetic-retention-${String(++serial).padStart(8, '0')}`) => engine.prepare({ bearer, toolName: 'catalog.preview_update', args: { id: productId, name: 'PRIVATE_PROPOSED_NAME' }, idempotencyKey: key });
  // Synthetic proof fixture only; actual first-party approval has separate HTTP tests.
  const approve = async (op) => {
    await store.run("UPDATE mcp_v2_operation SET state = 'APPROVED' WHERE id = ?", op.operationId);
    await store.run(`INSERT INTO mcp_v2_approval(operation_id,approver_id,session_hash,preview_hash,decision,approved_at,expires_at)
      VALUES (?, ?, ?, ?, 'APPROVED', ?, ?)`, op.operationId, account.id, hash(session.token), op.previewHash, stamp(), stamp(300000));
  };
  const commit = (op, target = engine) => target.commit({ bearer, toolName: 'catalog.commit_update', operationId: op.operationId });
  const maintenanceOptions = { enabled: true, tenantGuard, tenantId: binding.tenantId };
  const maintain = (database = store) => maintainOperations(database, maintenanceOptions);
  return { store, account, session, grantId, clientId, bearer, binding, grantExpiry, productId, options, adapter, engine, prepare, approve, commit, maintain, maintenanceOptions };
}
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !base };
  test(`${dialect}: committed receipt excludes proposal text and remains replayable after scrub`, options, async (t) => {
    const f = await fixture(t, dialect), key = 'synthetic-retention-fixed-key', op = await f.prepare(key);
    await f.approve(op);
    const first = await f.commit(op); assert.deepEqual(first.result, { id: f.productId, revision: 2 });
    const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId);
    assert.equal(row.receipt_expires_at, operationReceiptExpiry(f.grantExpiry)); assert.doesNotMatch(row.result_json, /PRIVATE_|name/);
    assert.equal((await f.maintain()).redacted, 0);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(row.expires_at) + 1 });
    const cleanup = await f.maintain(); assert.equal(cleanup.redacted, 1); assert.equal(cleanup.approvals, 1);
    const scrubbed = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', row.id);
    assert.equal(scrubbed.envelope_json, null); assert.ok(scrubbed.redacted_at); assert.equal(scrubbed.result_json, row.result_json);
    const replay = await f.commit(op); assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first.result);
    assert.equal((await f.prepare(key)).operationId, row.id);
    assert.equal((await f.store.get('SELECT revision FROM synthetic_receipt_resource WHERE id = ?', f.productId)).revision, 2);
    assert.doesNotMatch(JSON.stringify(await f.store.all('SELECT * FROM mcp_v2_event')), /PRIVATE_|before|after/);
  });
  test(`${dialect}: retention purge cannot revive revoked or expired grants`, options, async (t) => {
    const f = await fixture(t, dialect), op = await f.prepare(); await f.approve(op); await f.commit(op);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(op.expiresAt) + 1 }); await f.maintain();
    await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', stamp(), f.grantId);
    await assert.rejects(f.commit(op), { status: 403 });
    await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', f.grantId);
    t.mock.timers.setTime(Date.parse(f.grantExpiry) + 1); await assert.rejects(f.commit(op), { status: 403 });
    assert.equal((await f.maintain()).receipts, 0);
    t.mock.timers.setTime(Date.parse(operationReceiptExpiry(f.grantExpiry)) + 1);
    assert.equal((await f.maintain()).receipts, 1);
    assert.equal(await f.store.get('SELECT id FROM mcp_v2_operation WHERE id = ?', op.operationId), undefined);
    await assert.rejects(f.commit(op), { status: 403 }); await assert.rejects(f.prepare(), { status: 403 });
  });
  test(`${dialect}: a new client or grant cannot inherit a scrubbed operation or its approval`, options, async (t) => {
    const f = await fixture(t, dialect), key = 'synthetic-original-retention-key', op = await f.prepare(key);
    await f.approve(op); await f.commit(op);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(op.expiresAt) + 1 }); await f.maintain();
    const insert = async (table, row) => {
      const keys = Object.keys(row);
      await f.store.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((key) => row[key]));
    };
    for (const anotherClient of [false, true]) {
      const client = await f.store.get('SELECT * FROM oauth_client WHERE id = ?', f.clientId);
      const clientId = anotherClient ? secret() : f.clientId;
      if (anotherClient) await insert('oauth_client', { ...client, id: clientId });
      const grant = await f.store.get('SELECT * FROM oauth_grant WHERE id = ?', f.grantId);
      const grantId = randomUUID(), bearer = secret();
      await insert('oauth_grant', { ...grant, id: grantId, client_id: clientId, created_at: stamp() });
      const token = await f.store.get('SELECT * FROM oauth_token WHERE token_hash = ?', hash(f.bearer));
      await insert('oauth_token', { ...token, token_hash: hash(bearer), grant_id: grantId, issued_at: stamp() });
      const commit = () => f.engine.commit({ bearer, toolName: 'catalog.commit_update', operationId: op.operationId });
      await assert.rejects(commit(), { status: 403 });
      const consent = await f.store.get('SELECT * FROM mcp_v2_scope_consent WHERE grant_id = ?', f.grantId);
      await insert('mcp_v2_scope_consent', { ...consent, grant_id: grantId, client_id: clientId, consented_at: stamp() });
      await assert.rejects(commit(), { status: 403 });
      const prepare = () => f.engine.prepare({ bearer, toolName: 'catalog.preview_update', args: { id: f.productId, name: 'PRIVATE_PROPOSED_NAME' }, idempotencyKey: key });
      if (!anotherClient) await assert.rejects(prepare(), { status: 403 });
      else {
        const pending = await prepare(); assert.equal(pending.status, 'PENDING_APPROVAL'); assert.notEqual(pending.operationId, op.operationId);
        await assert.rejects(f.engine.commit({ bearer, toolName: 'catalog.commit_update', operationId: pending.operationId }), { status: 403 });
      }
    }
    assert.equal((await f.store.get('SELECT revision FROM synthetic_receipt_resource WHERE id = ?', f.productId)).revision, 2);
  });
  test(`${dialect}: invalid receipt rolls back domain writes and absent receipt contract rejects registration`, options, async (t) => {
    const f = await fixture(t, dialect), op = await f.prepare(); await f.approve(op);
    for (const missing of ['toReceipt', 'validReceipt']) {
      const adapter = { ...f.adapter }; delete adapter[missing];
      assert.throws(() => createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': adapter } }), TypeError);
    }
    const invalid = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': { ...f.adapter, toReceipt: (raw) => raw } } });
    await assert.rejects(f.commit(op, invalid), /Invalid operation receipt/);
    assert.equal((await f.store.get('SELECT revision FROM synthetic_receipt_resource WHERE id = ?', f.productId)).revision, 1);
    const failed = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId);
    assert.equal(failed.state, 'FAILED'); assert.equal(failed.result_json, null);
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', op.operationId)).consumed_at, null);
  });
  test(`${dialect}: receipt size and time limits roll back before acknowledgement`, options, async (t) => {
    const f = await fixture(t, dialect), oversized = await f.prepare(); await f.approve(oversized);
    const tooLarge = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': {
      ...f.adapter, toReceipt: () => ({ payload: 'x'.repeat(2049) }), validReceipt: () => true,
    } } });
    await assert.rejects(f.commit(oversized, tooLarge), /receipt is too large/);
    assert.equal((await f.store.get('SELECT revision FROM synthetic_receipt_resource WHERE id = ?', f.productId)).revision, 1);
    const slow = await f.prepare(); await f.approve(slow);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const expired = createOperationEngine({ ...f.options, adapters: { 'catalog.preview_update': {
      ...f.adapter, toReceipt: async (raw) => {
        t.mock.timers.setTime(Date.parse(slow.expiresAt) + 1);
        return f.adapter.toReceipt(raw);
      },
    } } });
    await assert.rejects(f.commit(slow, expired), { status: 409, code: 'EXPIRED' });
    assert.equal((await f.store.get('SELECT revision FROM synthetic_receipt_resource WHERE id = ?', f.productId)).revision, 1);
  });
  test(`${dialect}: expired proposal cleanup and metadata audit roll back together`, options, async (t) => {
    const f = await fixture(t, dialect), op = await f.prepare();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(op.expiresAt) + 1 });
    const failing = Object.create(f.store);
    failing.run = async (sql, ...args) => { if (sql.includes('INSERT INTO mcp_v2_event')) throw new Error('Synthetic audit unavailable.'); return f.store.run(sql, ...args); };
    await assert.rejects(f.maintain(failing), /Synthetic audit unavailable/);
    const unchanged = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId);
    assert.equal(unchanged.state, 'PENDING_APPROVAL'); assert.ok(unchanged.envelope_json); assert.equal(unchanged.redacted_at, null);
    const result = await f.maintain(); assert.equal(result.expired, 1); assert.equal(result.redacted, 1);
    const expired = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId);
    assert.equal(expired.state, 'EXPIRED'); assert.equal(expired.envelope_json, null);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE event = 'EXPIRE'")).n, 1);
    await assert.rejects(f.commit(op), { status: 403 });
  });
  test(`${dialect}: scrubbed replay validates retained policy, receipt and original client`, options, async (t) => {
    const f = await fixture(t, dialect), op = await f.prepare(); await f.approve(op); await f.commit(op);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(op.expiresAt) + 1 }); await f.maintain();
    const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId);
    for (const [column, value] of [['client_id', 'another-client'], ['risk', 'HIGH'], ['receipt_expires_at', stamp(86400000)], ['result_json', '{"name":"PRIVATE_INJECTED"}']]) {
      await f.store.run(`UPDATE mcp_v2_operation SET ${column} = ? WHERE id = ?`, value, row.id);
      await assert.rejects(f.commit(op), { status: 403 }, column);
      await f.store.run(`UPDATE mcp_v2_operation SET ${column} = ? WHERE id = ?`, row[column], row.id);
    }
    assert.equal((await f.commit(op)).replayed, true);
  });
  test(`${dialect}: bounded sweeps drain more than 33 approved operations without deleting pending proof`, options, async (t) => {
    const f = await fixture(t, dialect), op = await f.prepare(); await f.approve(op);
    const template = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId);
    const approval = await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id = ?', op.operationId);
    await f.store.transaction(async () => {
      for (let index = 0; index < 104; index++) {
        const row = { ...template, id: randomUUID(), idempotency_hash: hash(`synthetic-copy-${index}`) }, columns = Object.keys(row);
        await f.store.run(`INSERT INTO mcp_v2_operation (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map((column) => row[column]));
        const proof = { ...approval, operation_id: row.id }, keys = Object.keys(proof);
        await f.store.run(`INSERT INTO mcp_v2_approval (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((key) => proof[key]));
      }
    });
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(template.expires_at) + 1 });
    const first = await f.maintain(); assert.equal(first.expired, 33); assert.equal(first.redacted, 33); assert.equal(first.approvals, 33);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_approval a JOIN mcp_v2_operation o ON o.id = a.operation_id WHERE o.state = 'APPROVED' AND a.consumed_at IS NULL")).n, 72);
    const counts = await Promise.all([f.maintain(), f.maintain(), f.maintain()]);
    assert.equal(counts.reduce((sum, row) => sum + row.expired, first.expired), 105);
    assert.ok(counts.every((row) => row.expired <= 33 && row.redacted <= 100 && row.approvals <= 100));
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n, 0);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE state = 'EXPIRED' AND envelope_json IS NULL")).n, 105);
    const { sequence: _sequence, ...event } = await f.store.get('SELECT * FROM mcp_v2_event LIMIT 1');
    const insertEvent = async (id, tenant, at) => {
      const row = { ...event, id, tenant_id: tenant, at }, columns = Object.keys(row);
      await f.store.run(`INSERT INTO mcp_v2_event (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map((column) => row[column]));
    };
    await insertEvent(randomUUID(), f.binding.tenantId, new Date(Date.now() - OPERATION_AUDIT_RETENTION_MS - 1).toISOString());
    const boundary = randomUUID(); await insertEvent(boundary, f.binding.tenantId, new Date(Date.now() - OPERATION_AUDIT_RETENTION_MS).toISOString());
    const foreign = randomUUID(); await insertEvent(foreign, 'another-tenant', '2000-01-01T00:00:00.000Z');
    assert.equal((await f.maintain()).events, 1);
    assert.ok(await f.store.get('SELECT id FROM mcp_v2_event WHERE id = ?', boundary));
    assert.ok(await f.store.get('SELECT id FROM mcp_v2_event WHERE id = ?', foreign));
    assert.deepEqual(await maintainOperations({ transaction() { throw new Error('Off maintenance queried database.'); } }), { expired: 0, redacted: 0, challenges: 0, approvals: 0, receipts: 0, events: 0 });
  });
}
