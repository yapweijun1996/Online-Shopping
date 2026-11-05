import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { objectSchema } from './helpers/mcp-operation-tool-fixture.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';

const descriptor = read => ({ kind: 'read', name: 'company.get', scope: 'company.read', capability: 'settings.write',
  inputSchema: objectSchema({}), outputSchema: objectSchema({ defaultCurrency: { type: 'string', minLength: 3, maxLength: 3, enum: ['MYR', 'SGD'] } }), read });

test('read registry only accepts a fixed read policy and strict closed schemas', () => {
  const build = entry => createOperationTools({ config: { mcpEnabled: false }, entries: [entry] });
  const entry = descriptor(async () => ({ defaultCurrency: 'MYR' }));
  assert.doesNotThrow(() => build(entry));
  for (const patch of [{ name: 'company.commit_update' }, { scope: 'company.write' }, { capability: 'catalog.write' },
    { outputSchema: { type: 'object', additionalProperties: true, properties: {}, required: [] } }, { read: undefined }]) {
    assert.throws(() => build({ ...entry, ...patch }), TypeError);
  }
});

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: authenticated v2 company read holds policy fence and emits compatible audit atomically`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      let badOutput = false, reads = 0;
      const entry = descriptor(async (read, args, authority) => {
        reads++; assert.deepEqual(args, {}); assert.equal(authority.scope, 'company.read');
        assert.equal(read.run, undefined); assert.equal(read.transaction, undefined);
        assert.throws(() => read.get('UPDATE company_setting SET default_currency = ?', 'SGD'), TypeError);
        const row = await read.get('SELECT default_currency FROM company_setting WHERE id = 1');
        return { defaultCurrency: row.default_currency, ...(badOutput ? { privateText: 'Synthetic unlisted company text' } : {}) };
      });
      const f = await reviewFixture(t, dialect, { operationTools: [entry] }); await f.seedGrant();
      await f.store.run("UPDATE oauth_grant SET scopes = 'company.read' WHERE id = ?", f.grantId);
      await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
        SELECT grant_id, tenant_id, account_id, client_id, 'company.read', account_auth_version, epoch_hash, consented_at
        FROM mcp_v2_scope_consent WHERE grant_id = ? AND scope = 'catalog.write'`, f.grantId);
      const bearer = secret(), now = new Date().toISOString();
      await f.store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
        VALUES (?, 'access', ?, ?, 'company.read', ?, ?, 0)`, hash(bearer), f.grantId, f.binding.resource, now, new Date(Date.now() + 600000).toISOString());
      let serial = 0;
      const rpc = (method, params) => f.call('/mcp', 'POST', { jsonrpc: '2.0', id: ++serial, method, params }, {
        authorization: 'Bearer ' + bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      });
      const get = args => rpc('tools/call', { name: 'company.get', arguments: args });
      const listed = await rpc('tools/list', {}); assert.equal(listed.data.result.tools.length, 1);
      assert.equal(listed.data.result.tools[0].name, 'company.get'); assert.equal(listed.data.result.tools[0].annotations.readOnlyHint, true);
      assert.deepEqual((await get({})).data.result.structuredContent, { defaultCurrency: 'MYR' });
      assert.equal((await get({ tenantId: 'other' })).data.error.code, -32602);
      const audits = () => f.store.all("SELECT * FROM mcp_audit WHERE event = 'READ' AND tool_name = 'company.get' AND outcome = 'OK'");
      const audit = (await audits())[0]; assert.ok(audit); assert.equal(audit.tool_name, 'company.get');
      assert.equal(audit.account_id, f.account.id); assert.equal(audit.client_id, f.clientId); assert.equal(audit.grant_id, f.grantId);
      badOutput = true;
      const invalid = await get({}); assert.equal(invalid.data.error.code, -32603);
      assert.ok(!JSON.stringify(invalid.data).includes('Synthetic unlisted')); assert.equal((await audits()).length, 1);
      badOutput = false;
      const originalRun = f.store.run;
      f.store.run = (sql, ...values) => {
        if (sql.includes('INSERT INTO mcp_audit') && values.includes('READ')) throw new Error('Synthetic read audit failure.');
        return originalRun(sql, ...values);
      };
      try { assert.equal((await get({})).data.error.code, -32603); } finally { f.store.run = originalRun; }
      assert.equal((await audits()).length, 1);
      await f.store.run("UPDATE seller_account SET role = 'MANAGER' WHERE id = ?", f.account.id);
      assert.equal((await get({})).response.status, 403);
      await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
      await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id = ? AND scope = 'company.read'", f.grantId);
      assert.equal((await get({})).response.status, 403);
      assert.equal(reads, 3);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_event')).n), 0);
    });
}
