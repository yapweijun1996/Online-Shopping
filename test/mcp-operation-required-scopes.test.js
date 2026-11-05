import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { createProtocol, REVISION } from '../src/mcp/protocol.js';
import { OAuthError } from '../src/mcp/oauth.js';
import { operationAuthorityPolicy } from '../src/mcp/operation-policy.js';
import { hash } from '../src/mcp/credentials.js';
import { catalogue } from '../src/mcp/tools.js';
import { companyReadTool, companyMutationTool } from '../src/mcp/company-tools.js';
import { catalogCreateTool, catalogUpdateTool } from '../src/mcp/catalog-tools.js';
import { operationControlTools } from '../src/mcp/operation-control-contracts.js';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';

const legacy = catalogue.map(({ scope: _scope, ...tool }) => tool);
const config = { mcpRedirectUris: ['https://client.example.com/catalog-callback'] };
const operationId = '00000000-0000-4000-8000-000000000001';
const scopeHeader = 'Bearer error="insufficient_scope", scope="catalog.write media.write"';

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: actual registry keeps immutable source requirements private and RESERVED adapters unavailable`, options, async t => {
    const f = await mediaToolsFixture(t, dialect);
    const entries = [companyReadTool(), companyMutationTool(), catalogCreateTool(), catalogUpdateTool(),
      ...operationControlTools(), ...f.entries];
    const build = values => createOperationTools({ store: f.store, config: f.config, binding: f.binding,
      quickLogin: false, tenantGuard: f.guard, entries: values });
    const registry = build(entries);
    for (const tool of registry.catalogue) {
      const required = tool.name.startsWith('operations.') ? [tool.scope] : operationAuthorityPolicy(tool.name).requiredScopes;
      assert.deepEqual(registry.requiredScopes(tool.name), required, tool.name);
      assert.ok(Object.isFrozen(registry.requiredScopes(tool.name)));
      assert.throws(() => registry.requiredScopes(tool.name).push('media.write'), TypeError);
      assert.equal(Object.hasOwn(tool, 'requiredScopes'), false);
      assert.strictEqual(registry.find(tool.name), tool);
      assert.equal(Object.hasOwn(registry.find(tool.name), 'requiredScopes'), false);
    }
    assert.equal(registry.requiredScopes('unknown.preview'), null);
    assert.equal(registry.requiredScopes('__proto__'), null);
    assert.equal(build([]).requiredScopes('catalog.preview_update'), null);
    assert.equal(createOperationTools({ config: { mcpEnabled: false }, entries: [] }).requiredScopes('catalog.preview_update'), null);
    for (const patch of [{ requiredScopes: ['catalog.write', 'media.write'] }, { mediaPolicyId: 'catalog-media-v1' }]) {
      assert.throws(() => build([{ ...catalogUpdateTool(), ...patch }]), TypeError);
    }
    const base = catalogUpdateTool(), unreachable = () => { throw new Error('Reserved adapter must never execute.'); };
    for (const policyId of ['unknown-media-policy', 'catalog-media-v1']) {
      const media = { policyId, codecDigest: 'd'.repeat(64), capture: unreachable, resolve: unreachable,
        persistResources: unreachable, consumeResources: unreachable };
      assert.throws(() => build([{ ...base, adapter: { ...base.adapter, media } }]), TypeError);
    }
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
  });

  test(`${dialect}: protocol dual-scope fixture filters both scopes without changing public definitions or dispatching partial grants`, options, async t => {
    const f = await reviewFixture(t, dialect, { operationTools: undefined, config });
    const actual = createOperationTools({ store: f.store, config: f.config, binding: f.binding, quickLogin: false,
      tenantGuard: { withActiveTenant: () => { throw new Error('Contract lookup must not invoke the engine.'); } }, entries: [catalogUpdateTool()] });
    const toolNames = ['catalog.preview_update', 'catalog.commit_update'];
    const tools = toolNames.map(name => actual.find(name));
    // This is only a standalone protocol-boundary fixture. It is not registered
    // with createApi, has no business adapter and cannot approve/mutate anything.
    // The real registry/engine RESERVED rejection is tested separately above.
    const requirements = new Map(toolNames.map(name => [name, operationAuthorityPolicy(name, 'catalog-media-v1').requiredScopes]));
    let dispatches = 0, serial = 0;
    const registry = Object.freeze({ catalogue: Object.freeze(tools), find: name => actual.find(name),
      requiredScopes: name => requirements.get(name) ?? null,
      call: async () => { dispatches++; return { transportFixture: true }; } });
    const makeProtocol = operationTools => createProtocol({ store: f.store, config: f.config,
      binding: { ...f.binding, mcpV2: f.config.mcpV2 }, limit: async () => {}, operationTools });
    const protocol = makeProtocol(registry);
    const request = (client, method, params) => new Request(f.binding.resource, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + client.bearer,
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': REVISION },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
    const args = name => name.includes('.preview_') ? { input: { id: operationId, changes: { name: 'Synthetic transport text' } },
      idempotencyKey: 'synthetic-required-scope-0001' } : { operationId };
    const clients = [];
    for (const extra of ['', 'catalog.write', 'media.write', 'catalog.write media.write']) {
      const client = await freshCatalogAccess(f, legacyCatalogScopes + (extra ? ' ' + extra : ''));
      clients.push(client);
      const complete = extra === 'catalog.write media.write';
      const response = await protocol(request(client, 'tools/list', {}), 'synthetic-scope-boundary');
      assert.equal(response.status, 200);
      const listed = (await response.json()).result.tools;
      assert.deepEqual(listed, [...legacy, ...(complete ? tools.map(({ scope: _scope, ...tool }) => tool) : [])]);
      assert.equal(JSON.stringify(listed).includes('requiredScopes'), false);
      for (const name of toolNames) {
        const input = request(client, 'tools/call', { name, arguments: args(name) });
        if (complete) {
          const accepted = await protocol(input, 'synthetic-scope-boundary');
          assert.equal(accepted.status, 200);
          assert.deepEqual((await accepted.json()).result.structuredContent, { transportFixture: true });
        } else {
          await assert.rejects(protocol(input, 'synthetic-scope-boundary'), error => error instanceof OAuthError &&
            error.status === 403 && error.error === 'insufficient_scope' && error.headers['WWW-Authenticate'] === scopeHeader);
          assert.equal(dispatches, 0);
        }
      }
    }
    assert.equal(dispatches, 2);
    const both = clients.at(-1), baseline = dispatches;
    const token = await f.store.get('SELECT grant_id,scopes FROM oauth_token WHERE token_hash=?', hash(both.bearer));
    const grant = await f.store.get('SELECT client_id,scopes FROM oauth_grant WHERE id=?', token.grant_id);
    // Narrow an already genuinely consented token/grant, or remove consent.
    // No SQL creates authority; each negative is rolled back independently.
    for (const source of ['token', 'grant', 'consent']) for (const omitted of ['catalog.write', 'media.write']) {
      const rollback = new Error('Synthetic scope-removal rollback');
      await assert.rejects(f.store.transaction(async () => {
        if (source === 'token') await f.store.run('UPDATE oauth_token SET scopes=? WHERE token_hash=?',
          token.scopes.split(' ').filter(scope => scope !== omitted).join(' '), hash(both.bearer));
        if (source === 'grant') await f.store.run('UPDATE oauth_grant SET scopes=? WHERE id=?',
          grant.scopes.split(' ').filter(scope => scope !== omitted).join(' '), token.grant_id);
        if (source === 'consent') await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope=?', token.grant_id, omitted);
        const listed = await protocol(request(both, 'tools/list', {}), 'synthetic-scope-boundary');
        assert.deepEqual((await listed.json()).result.tools, legacy, source + ' lacks ' + omitted);
        for (const name of toolNames) await assert.rejects(protocol(request(both, 'tools/call', { name, arguments: args(name) }),
          'synthetic-scope-boundary'), error => error instanceof OAuthError && error.status === 403 &&
            error.error === 'insufficient_scope' && error.headers['WWW-Authenticate'] === scopeHeader);
        assert.equal(dispatches, baseline);
        throw rollback;
      }), error => error === rollback);
    }
    const malformed = [undefined, () => null, () => [], () => ['catalog.write', 'catalog.write'],
      () => ['catalog.write', 'unknown.scope'], () => ['media.write', 'catalog.write'], () => 'catalog.write media.write'];
    for (const requiredScopes of malformed) {
      const broken = makeProtocol({ ...registry, requiredScopes });
      for (const [method, params] of [['tools/list', {}], ['tools/call', { name: toolNames[1], arguments: args(toolNames[1]) }]]) {
        await assert.rejects(broken(request(both, method, params), 'synthetic-scope-boundary'),
          { name: 'TypeError', message: 'Invalid server operation scope requirements.' });
      }
    }
    for (const authorityField of ['scope', 'requiredScopes', 'mediaPolicyId']) {
      const response = await protocol(request(both, 'tools/call', { name: toolNames[1], arguments: { ...args(toolNames[1]),
        [authorityField]: authorityField === 'requiredScopes' ? ['catalog.write'] : 'catalog-media-v1' } }), 'synthetic-scope-boundary');
      assert.equal((await response.json()).error.code, -32602);
    }
    assert.equal(dispatches, baseline);
    const revoked = await f.call('/oauth/revoke', 'POST', new URLSearchParams({ client_id: grant.client_id,
      token: both.bearer, token_type_hint: 'access_token' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(revoked.response.status, 200);
    await assert.rejects(protocol(request(both, 'tools/call', { name: toolNames[1], arguments: args(toolNames[1]) }),
      'synthetic-scope-boundary'), error => error instanceof OAuthError && error.status === 401 && error.error === 'invalid_token');
    assert.equal(dispatches, baseline);
    for (const table of ['mcp_v2_operation', 'mcp_v2_media_stage', 'product', 'inventory_movement']) {
      assert.equal(Number((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n), 0, table);
    }
  });
}
