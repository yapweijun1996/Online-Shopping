import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { catalogue, valid } from '../src/mcp/tools.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';
import { syntheticOperationTool, objectSchema } from './helpers/mcp-operation-tool-fixture.js';

async function rpcFixture(t, dialect, options = {}) {
  const entry = syntheticOperationTool();
  const f = await reviewFixture(t, dialect, { operationTools: [entry], ...options }); await f.seedGrant();
  await f.store.exec('CREATE TABLE synthetic_protocol_product(id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL)');
  const productId = randomUUID();
  await f.store.run('INSERT INTO synthetic_protocol_product(id, name, revision) VALUES (?, ?, 1)', productId, 'Synthetic original');
  const bearer = secret(), scopes = 'catalog.read orders.read analytics.read catalog.write';
  await f.store.run('UPDATE oauth_grant SET scopes = ? WHERE id = ?', scopes, f.grantId);
  await f.store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
    VALUES (?, 'access', ?, ?, ?, ?, ?, 0)`, hash(bearer), f.grantId, f.binding.resource, scopes,
  new Date().toISOString(), new Date(Date.now() + 600000).toISOString());
  let serial = 0;
  const rpc = (method, params, extra = {}) => f.call('/mcp', 'POST', { jsonrpc: '2.0', id: ++serial, method, params, ...extra },
    { authorization: 'Bearer ' + bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
  const tool = (name, args) => rpc('tools/call', { name, arguments: args });
  const input = { id: productId, expectedRevision: 1, name: 'Synthetic changed' };
  return { ...f, entry, productId, bearer, rpc, tool, input };
}

test('server registry rejects unknown policy pairs, open schemas and unbounded metadata', () => {
  const build = entries => createOperationTools({ entries, config: { mcpEnabled: false } });
  const bad = patch => assert.throws(() => build([{ ...syntheticOperationTool(), ...patch }]), TypeError);
  assert.equal(build([]).catalogue.length, 0);
  bad({ previewName: 'unknown.preview', commitName: 'unknown.commit' });
  bad({ commitName: 'company.commit_update' }); bad({ scope: 'catalog.read' }); bad({ capability: 'settings.write' });
  bad({ approved: true }); bad({ adapter: {} });
  bad({ inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true } });
  bad({ inputSchema: objectSchema({ input: { type: 'unknown' } }) });
  bad({ inputSchema: objectSchema({ name: { type: 'string', minLength: 0, maxLength: 999999 } }) });
  bad({ inputSchema: objectSchema({ name: { type: 'string', minLength: 0, maxLength: 10, format: 'email' } }) });
  bad({ inputSchema: objectSchema({ bearer: { type: 'string', minLength: 0, maxLength: 43 } }) });
  const nullable = { anyOf: [{ type: 'integer', minimum: 0, maximum: 1000000 }, { type: 'null' }] };
  const nullableEntry = { ...syntheticOperationTool(), inputSchema: objectSchema({ stockQuantity: nullable }) };
  assert.doesNotThrow(() => build([nullableEntry]));
  assert.equal(valid({ stockQuantity: null }, nullableEntry.inputSchema), true);
  assert.equal(valid({ stockQuantity: 0 }, nullableEntry.inputSchema), true);
  assert.equal(valid({ stockQuantity: 'unlimited' }, nullableEntry.inputSchema), false);
  bad({ inputSchema: objectSchema({ quantity: { anyOf: [nullable.anyOf[0], { type: 'null', default: null }] } }) });
  bad({ inputSchema: objectSchema({ quantity: { anyOf: [nullable.anyOf[0]], type: 'integer' } }) });
  bad({ inputSchema: objectSchema({ quantity: { anyOf: Array(5).fill({ type: 'null' }) } }) });
  bad({ receiptSchema: objectSchema({ name: { type: 'string', minLength: 0, maxLength: 10, default: 'unlisted' } }) });
  let deep = objectSchema({}); for (let i = 0; i < 10; i++) deep = objectSchema({ child: deep }); bad({ inputSchema: deep });
  assert.throws(() => build([syntheticOperationTool(), syntheticOperationTool()]), TypeError);
  assert.throws(() => build(Array.from({ length: 6 }, syntheticOperationTool)), TypeError);
});

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: real JSON-RPC registered pair prepares, requires HTTP approval and commits once`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await rpcFixture(t, dialect);
      const list = await f.rpc('tools/list', {});
      assert.equal(list.response.status, 200); assert.equal(list.data.result.tools.length, 10);
      assert.deepEqual(list.data.result.tools.slice(0, 8), catalogue.map(({ scope: _scope, ...tool }) => tool));
      assert.equal(list.data.result.tools[8].annotations.readOnlyHint, false);
      assert.equal(list.data.result.tools[9].annotations.openWorldHint, false);
      assert.ok(Buffer.byteLength(JSON.stringify(list.data)) <= 262144);
      const key = 'synthetic-protocol-preview-0001';
      const prepare = () => f.tool('catalog.preview_update', { input: f.input, idempotencyKey: key });
      const prepared = await prepare(); assert.equal(prepared.response.status, 200, JSON.stringify(prepared.data));
      const op = prepared.data.result.structuredContent;
      assert.equal(op.status, 'PENDING_APPROVAL'); assert.equal(op.replayed, false);
      assert.equal(op.reviewUrl, f.binding.issuer + '/oauth/operation?operationId=' + op.operationId);
      assert.equal((await prepare()).data.result.structuredContent.operationId, op.operationId);
      const commit = () => f.tool('catalog.commit_update', { operationId: op.operationId });
      assert.equal((await commit()).response.status, 403);
      assert.equal((await f.store.get('SELECT revision FROM synthetic_protocol_product WHERE id = ?', f.productId)).revision, 1);
      const path = '/api/v1/seller/mcp/operations/' + op.operationId;
      const review = await f.call(path, 'GET', undefined, f.headers);
      assert.equal(review.response.status, 200); assert.equal(review.data.proposal.after, f.input.name);
      const approval = await f.call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash,
        challenge: review.data.challenge, decision: 'approve', password: reviewPassword }, f.headers);
      assert.equal(approval.response.status, 200);
      const originalRun = f.store.run;
      f.store.run = async (sql, ...values) => {
        if (sql.startsWith('DELETE FROM oauth_authorization_request WHERE id IN')) throw new Error('Synthetic OAuth cleanup failure.');
        return originalRun(sql, ...values);
      };
      let committed;
      try { committed = await Promise.all([commit(), commit()]); } finally { f.store.run = originalRun; }
      for (const value of committed) {
        assert.equal(value.response.status, 200, JSON.stringify(value.data));
        assert.ok(value.data.result?.structuredContent, JSON.stringify(value.data));
      }
      assert.deepEqual(committed.map(value => value.data.result.structuredContent.replayed).sort(), [false, true]);
      for (const response of committed) assert.deepEqual(response.data.result.structuredContent.result, { id: f.productId, revision: 2 });
      assert.equal((await f.store.get('SELECT revision FROM synthetic_protocol_product WHERE id = ?', f.productId)).revision, 2);
      assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n), 1);
      assert.doesNotMatch((await f.store.get('SELECT result_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).result_json, /Synthetic changed/);
    });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: JSON-RPC rejects authority arguments, stale credentials, RBAC and tenant substitution`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await rpcFixture(t, dialect), args = { input: f.input, idempotencyKey: 'synthetic-negative-0001' };
      for (const key of ['bearer', 'tenantId', 'config', 'adapter', 'approved']) {
        assert.equal((await f.tool('catalog.preview_update', { ...args, [key]: true })).data.error.code, -32602);
        assert.equal((await f.tool('catalog.preview_update', { ...args, input: { ...f.input, [key]: true } })).data.error.code, -32602);
      }
      assert.equal((await f.rpc('tools/call', { name: 'catalog.preview_update', arguments: args, bearer: f.bearer })).data.error.code, -32602);
      assert.equal((await f.tool('company.preview_update', args)).data.error.code, -32602);
      assert.equal((await f.rpc('tools/call', { name: 'catalog.preview_update', arguments: args }, { id: undefined })).response.status, 202);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
      const forged = await f.operation({ tenantId: 'other-tenant' });
      assert.equal((await f.tool('catalog.commit_update', { operationId: forged.value.operationId })).response.status, 403);
      await f.store.run('UPDATE oauth_token SET scopes = ? WHERE token_hash = ?', 'catalog.read', hash(f.bearer));
      assert.equal((await f.tool('catalog.preview_update', args)).response.status, 403);
      assert.ok(!(await f.rpc('tools/list', {})).data.result.tools.some(tool => tool.name === 'catalog.preview_update'));
      await f.store.run('UPDATE oauth_token SET scopes = ? WHERE token_hash = ?', 'catalog.read orders.read analytics.read catalog.write', hash(f.bearer));
      await f.store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", f.account.id);
      assert.equal((await f.tool('catalog.preview_update', args)).response.status, 401);
      await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
      await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id = ?', f.grantId);
      assert.equal((await f.tool('catalog.preview_update', args)).response.status, 403);
      await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', new Date().toISOString(), f.grantId);
      assert.equal((await f.tool('catalog.preview_update', args)).response.status, 401);
      await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', f.grantId);
      await f.store.run('UPDATE oauth_token SET revoked_at = ? WHERE token_hash = ?', new Date().toISOString(), hash(f.bearer));
      assert.equal((await f.tool('catalog.preview_update', args)).response.status, 401);
      const audit = await f.store.all("SELECT * FROM mcp_audit WHERE event = 'DENY'"); assert.ok(audit.length > 0);
      assert.ok(!JSON.stringify(audit).includes(f.bearer));
      assert.doesNotMatch(JSON.stringify(audit), /Synthetic changed|Synthetic-route-password|other-tenant/);
    });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: real v2 request redacts expired proposals and receipt schema failure rolls back mutation`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const entry = syntheticOperationTool();
      entry.adapter.toReceipt = value => ({ id: value.id, revision: value.revision, privateText: 'Synthetic private receipt text' });
      entry.adapter.validReceipt = () => true; // Registry receipt schema remains authoritative.
      const f = await rpcFixture(t, dialect, { operationTools: [entry] });
      const expired = await f.operation({ createdAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString(),
        proposal: { before: 'Synthetic expired private text', after: 'Synthetic expired replacement' } });
      const prepared = await f.tool('catalog.preview_update', { input: f.input, idempotencyKey: 'synthetic-cleanup-0001' });
      const op = prepared.data.result.structuredContent;
      const old = await f.store.get('SELECT state, envelope_json, redacted_at FROM mcp_v2_operation WHERE id = ?', expired.value.operationId);
      assert.equal(old.state, 'EXPIRED'); assert.equal(old.envelope_json, null); assert.ok(old.redacted_at);
      const path = '/api/v1/seller/mcp/operations/' + op.operationId;
      const review = await f.call(path, 'GET', undefined, f.headers);
      const originalAll = f.store.all;
      f.store.all = async (sql, ...values) => {
        if (sql.includes('UPDATE mcp_v2_operation SET envelope_json')) throw new Error('Synthetic cleanup failure.');
        return originalAll(sql, ...values);
      };
      const approval = await f.call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash,
        challenge: review.data.challenge, decision: 'approve', password: reviewPassword }, f.headers);
      f.store.all = originalAll;
      assert.equal(approval.response.status, 200); assert.equal(approval.data.status, 'APPROVED');
      const committed = await f.tool('catalog.commit_update', { operationId: op.operationId });
      assert.equal(committed.data.error.code, -32603);
      assert.equal((await f.store.get('SELECT revision FROM synthetic_protocol_product WHERE id = ?', f.productId)).revision, 1);
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.operationId)).state, 'FAILED');
      assert.equal((await f.store.get('SELECT result_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).result_json, null);
    });
}

test('empty production registry and default-off injection preserve the eight legacy tool definitions', async (t) => {
  for (const options of [{ operationTools: [] }, { config: { mcpV2: { enabled: false } } }]) {
    const f = await rpcFixture(t, 'sqlite', options);
    const response = await f.rpc('tools/list', {});
    assert.deepEqual(response.data.result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
    assert.equal((await f.tool('catalog.preview_update', { input: f.input, idempotencyKey: 'synthetic-disabled-0001' })).data.error.code, -32602);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
  }
});

test('PostgreSQL v2 waiting on the platform fence leaves the tenant writer available to a real v1 read',
  { skip: !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
    const [{ default: pg }, { openPlatformDatabase }, { createPlatformRegistry }] = await Promise.all([
      import('pg'), import('../src/platform/platform-db.js'), import('../src/platform/registry.js'),
    ]);
    const admin = new pg.Pool({ connectionString: process.env.SHOP_TEST_DATABASE_URL });
    const name = `shopping_test_protocol_platform_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.SHOP_TEST_DATABASE_URL); url.pathname = '/' + name;
    const platform = await openPlatformDatabase(url.href), other = new pg.Client({ connectionString: url.href }); await other.connect();
    t.after(async () => { await other.end(); await platform.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
    const tenantId = randomUUID(), now = new Date().toISOString();
    await platform.run(`INSERT INTO tenant(id, code, name, status, currency, database_name, database_role,
      database_password_sealed, database_key_id, created_at, updated_at) VALUES (?, 'alpha', 'Synthetic alpha', 'ACTIVE', 'MYR', ?, ?, ?, 'k1', ?, ?)`,
    tenantId, 't_alpha_12345678', 't_alpha_12345678', Buffer.from('synthetic'), now, now);
    const f = await rpcFixture(t, 'postgres', { tenantId, config: { basePath: '/alpha', platform: { adminHost: 'admin.example.test' } },
      registry: (store, config) => createPlatformRegistry({ store, config, platform, pool: { get: async () => store } }) });
    await other.query('BEGIN');
    await other.query('SELECT id FROM tenant WHERE id = $1 FOR UPDATE', [tenantId]);
    const waiting = f.tool('catalog.preview_update', { input: f.input, idempotencyKey: 'synthetic-lock-order-0001' });
    let prepared;
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const observed = await admin.query("SELECT pid FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE 'SELECT id, code, status, revision FROM tenant%'", [name]);
        if (observed.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true);
      let timer;
      try {
        const read = await Promise.race([f.tool('catalog.categories', {}), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('V1 read blocked behind the waiting v2 tenant transaction.')), 1500);
        })]);
        assert.equal(read.response.status, 200); assert.deepEqual(read.data.result.structuredContent.items, []);
      } finally { clearTimeout(timer); }
    } finally {
      await other.query('COMMIT'); prepared = await waiting;
    }
    assert.equal(prepared.response.status, 200); assert.equal(prepared.data.result.structuredContent.status, 'PENDING_APPROVAL');
  });

test('tenant prefix transport preserves the validated minimal RPC receipt verbatim', async (t) => {
  const entry = syntheticOperationTool();
  entry.receiptSchema.properties.url = { type: 'string', minLength: 1, maxLength: 100 };
  entry.receiptSchema.required.push('url');
  entry.adapter.toReceipt = value => ({ id: value.id, revision: value.revision, url: '/api/synthetic-receipt' });
  entry.adapter.validReceipt = value => Object.keys(value).sort().join(',') === 'id,revision,url';
  const f = await rpcFixture(t, 'sqlite', { operationTools: [entry], config: { basePath: '/alpha' } });
  const prepared = await f.tool('catalog.preview_update', { input: f.input, idempotencyKey: 'synthetic-prefix-0001' });
  const op = prepared.data.result.structuredContent, path = '/api/v1/seller/mcp/operations/' + op.operationId;
  const review = await f.call(path, 'GET', undefined, f.headers);
  assert.equal((await f.call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash,
    challenge: review.data.challenge, decision: 'approve', password: reviewPassword }, f.headers)).response.status, 200);
  const committed = await f.tool('catalog.commit_update', { operationId: op.operationId });
  const stored = JSON.parse((await f.store.get('SELECT result_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).result_json);
  assert.deepEqual(committed.data.result.structuredContent.result, stored);
  assert.equal(stored.url, '/api/synthetic-receipt');
});
