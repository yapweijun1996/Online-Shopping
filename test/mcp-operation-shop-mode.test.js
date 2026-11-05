import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';
import { hash, secret } from '../src/mcp/credentials.js';

async function fixture(t, dialect) {
  const f = await reviewFixture(t, dialect, { operationTools: undefined }); await f.seedGrant();
  const scopes = 'catalog.read orders.read analytics.read company.read company.write';
  await f.store.run('UPDATE oauth_grant SET scopes = ? WHERE id = ?', scopes, f.grantId);
  for (const scope of ['company.read', 'company.write']) await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
    SELECT grant_id, tenant_id, account_id, client_id, ?, account_auth_version, epoch_hash, ?
    FROM mcp_v2_scope_consent WHERE grant_id = ? AND scope = 'catalog.write'`, scope, new Date().toISOString(), f.grantId);
  const bearer = secret();
  await f.store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
    VALUES (?, 'access', ?, ?, ?, ?, ?, 0)`, hash(bearer), f.grantId, f.binding.resource, scopes,
  new Date().toISOString(), new Date(Date.now() + 600000).toISOString());
  let id = 0;
  const tool = (name, args) => f.call('/mcp', 'POST', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, {
    authorization: 'Bearer ' + bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
  });
  return { ...f, tool };
}

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: actual DB mode denies company read, prepare and an already approved commit centrally`, options, async (t) => {
    const f = await fixture(t, dialect);
    const current = await f.tool('company.get', {}); assert.equal(current.response.status, 200);
    const revision = current.data.result.structuredContent.company.revision;
    const args = { input: { expectedRevision: revision, changes: { availabilityText: 'Synthetic protected company text' } }, idempotencyKey: 'synthetic-mode-boundary-0001' };
    const prepared = await f.tool('company.preview_update', args); assert.equal(prepared.response.status, 200);
    const op = prepared.data.result.structuredContent, path = '/api/v1/seller/mcp/operations/' + op.operationId;
    const review = await f.call(path, 'GET', undefined, f.headers); assert.equal(review.response.status, 200);
    assert.equal((await f.call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash,
      challenge: review.data.challenge, decision: 'approve', password: reviewPassword }, f.headers)).response.status, 200);
    const before = await f.store.get('SELECT * FROM company_setting WHERE id = 1');
    // Production setup cannot switch through setupShop; direct row changes here
    // model a restored/imported database without changing the company revision.
    for (const mode of ['demo', null]) {
      await f.store.run('UPDATE shop_setup SET mode = ? WHERE id = 1', mode);
      for (const [name, input] of [['company.get', {}], ['company.preview_update', args], ['company.commit_update', { operationId: op.operationId }]]) {
        const denied = await f.tool(name, input); assert.equal(denied.response.status, 403, JSON.stringify(denied.data));
        assert.equal(denied.data.result, undefined);
        assert.ok(!JSON.stringify(denied.data).includes('Synthetic protected company text'));
      }
      assert.deepEqual(await f.store.get('SELECT * FROM company_setting WHERE id = 1'), before);
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.operationId)).state, 'APPROVED');
      assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', op.operationId)).consumed_at, null);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 1);
      assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE event = 'COMMIT'")).n), 0);
      assert.equal((await f.tool('catalog.categories', {})).response.status, 200);
    }
  });

  test(`${dialect}: real Owner setup can select demo under manual deployment but cannot grant v2 data access`, options, async (t) => {
    const f = await fixture(t, dialect);
    // Model an initially unconfigured shop using the same authenticated owner;
    // the subsequent mode transition uses the actual existing seller endpoint.
    await f.store.run('UPDATE shop_setup SET mode = NULL WHERE id = 1');
    assert.equal((await f.tool('company.get', {})).response.status, 403);
    const setup = await f.call('/api/v1/seller/setup', 'POST', { mode: 'demo' }, f.headers);
    assert.equal(setup.response.status, 200); assert.equal(setup.data.mode, 'demo');
    assert.equal((await f.tool('company.get', {})).response.status, 403);
    const listed = await f.tool('catalog.list', { limit: 2 });
    assert.equal(listed.response.status, 200); assert.equal(listed.data.result.structuredContent.items.length, 2);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    assert.equal((await f.call('/api/v1/seller/setup', 'POST', { mode: 'production', shopName: 'Cannot switch existing demo' }, f.headers)).response.status, 409);
  });
}
