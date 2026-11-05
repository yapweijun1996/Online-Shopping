import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { catalogue } from '../src/mcp/tools.js';

const legacy = 'catalog.read orders.read analytics.read';
async function access(f, scopes) {
  const bearer = secret();
  const { generation } = await f.store.get("SELECT COALESCE(MAX(generation), -1) + 1 AS generation FROM oauth_token WHERE grant_id = ? AND kind = 'access'", f.grantId);
  await f.store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
    VALUES (?, 'access', ?, ?, ?, ?, ?, ?)`, hash(bearer), f.grantId, f.binding.resource, scopes,
  new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), generation);
  let id = 0;
  const rpc = (method, params) => f.call('/mcp', 'POST', { jsonrpc: '2.0', id: ++id, method, params }, {
    authorization: 'Bearer ' + bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
  });
  return { rpc, call: (name, args) => rpc('tools/call', { name, arguments: args }) };
}
async function consentCompany(f) {
  await f.store.run('UPDATE oauth_grant SET scopes = ? WHERE id = ?', legacy + ' company.read company.write', f.grantId);
  for (const scope of ['company.read', 'company.write']) {
    await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
      SELECT grant_id, tenant_id, account_id, client_id, ?, account_auth_version, epoch_hash, ?
      FROM mcp_v2_scope_consent WHERE grant_id = ? AND scope = 'catalog.write'`, scope, new Date().toISOString(), f.grantId);
  }
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: default safe v2 registers company tools only for explicitly consented credentials`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await reviewFixture(t, dialect, { operationTools: undefined }); await f.seedGrant();
      await f.store.run('UPDATE oauth_grant SET scopes = ? WHERE id = ?', legacy, f.grantId);
      const old = await access(f, legacy);
      assert.deepEqual((await old.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
      assert.equal((await old.call('company.get', {})).response.status, 403);
      const before = await f.store.get('SELECT * FROM company_setting WHERE id = 1');
      await consentCompany(f);
      const current = await access(f, legacy + ' company.read company.write');
      const listed = await current.rpc('tools/list', {});
      assert.equal(listed.response.status, 200); assert.equal(listed.data.result.tools.length, 11);
      assert.deepEqual(listed.data.result.tools.slice(0, 8), catalogue.map(({ scope: _scope, ...tool }) => tool));
      assert.deepEqual(listed.data.result.tools.slice(8).map(tool => tool.name), ['company.get', 'company.preview_update', 'company.commit_update']);
      assert.deepEqual(await f.store.get('SELECT * FROM company_setting WHERE id = 1'), before);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 0);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
      assert.equal((await old.rpc('tools/list', {})).data.result.tools.length, 8);
      assert.equal((await old.call('company.get', {})).response.status, 403);
      const read = await current.call('company.get', {}); assert.equal(read.response.status, 200);
      const company = read.data.result.structuredContent.company;
      const prepared = await current.call('company.preview_update', { input: { expectedRevision: company.revision, changes: { defaultCurrency: 'SGD' } }, idempotencyKey: 'synthetic-default-company-0001' });
      assert.equal(prepared.response.status, 200, JSON.stringify(prepared.data));
      const op = prepared.data.result.structuredContent;
      const path = '/api/v1/seller/mcp/operations/' + op.operationId;
      const review = await f.call(path, 'GET', undefined, f.headers);
      assert.equal(review.response.status, 200); assert.equal(review.data.currencyAcknowledgementRequired, true);
      const input = { operationId: op.operationId, previewHash: op.previewHash, challenge: review.data.challenge, decision: 'approve', password: reviewPassword };
      assert.equal((await f.call(path + '/approval', 'POST', input, f.headers)).response.status, 403);
      assert.equal((await f.call(path + '/approval', 'POST', { ...input, currencyAcknowledged: true }, f.headers)).response.status, 200);
      assert.equal((await f.store.get('SELECT default_currency FROM company_setting WHERE id = 1')).default_currency, 'MYR');
      const results = await Promise.all([current.call('company.commit_update', { operationId: op.operationId }), current.call('company.commit_update', { operationId: op.operationId })]);
      for (const result of results) assert.ok(result.data.result?.structuredContent, JSON.stringify(result.data));
      assert.deepEqual(results.map(result => result.data.result.structuredContent.replayed).sort(), [false, true]);
      assert.equal((await f.store.get('SELECT default_currency FROM company_setting WHERE id = 1')).default_currency, 'SGD');
      assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n), 1);
    });
}

test('explicit empty registration and disabled or production mode never expose built-in company tools', async (t) => {
  for (const options of [{ operationTools: [] }, { operationTools: undefined, config: { mcpV2: { enabled: false } } },
    { operationTools: undefined, config: { production: true } }]) {
    const f = await reviewFixture(t, 'sqlite', options); await f.seedGrant(); await consentCompany(f);
    const client = await access(f, legacy + ' company.read company.write');
    const listed = await client.rpc('tools/list', {});
    assert.equal(listed.response.status, 200); assert.equal(listed.data.result.tools.length, 8);
    assert.equal((await client.call('company.get', {})).data.error.code, -32602);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    await assert.rejects(createApi({ store: f.store, config: f.config, operationTools: null }), TypeError);
  }
});
