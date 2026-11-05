import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash, stamp } from '../src/mcp/credentials.js';
import { catalogue, valid } from '../src/mcp/tools.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { analyticsSalesTrendTool, analyticsTopProductsTool, analyticsInventoryRiskTool } from '../src/mcp/analytics-tools.js';
import { analyticsFixture } from './helpers/analytics-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';

const entries = () => [analyticsSalesTrendTool(), analyticsTopProductsTool(), analyticsInventoryRiskTool()];
const cases = [['analytics.sales_trend', { from: '2026-10-01', toExclusive: '2026-10-11' }],
  ['analytics.top_products', { from: '2026-10-01', toExclusive: '2026-10-11' }], ['analytics.inventory_risk', { mode: 'all' }]];
const config = { mcpRedirectUris: ['https://client.example.com/catalog-callback'] };
const dto = response => { assert.equal(response.response.status, 200, JSON.stringify(response.data)); assert.ok(response.data.result, JSON.stringify(response.data)); return response.data.result.structuredContent; };
const spy = store => {
  const old = { get: store.get, all: store.all, run: store.run, exec: store.exec }; let queries = 0;
  for (const name of Object.keys(old)) store[name] = (sql, ...args) => {
    if (/^\s*SELECT/i.test(sql) && /\b(?:FROM|JOIN)\s+(?:shop_order|order_item|delivery|product)\b/.test(sql)) {
      queries++; assert.doesNotMatch(sql, /SELECT\s+\*|buyer_|recipient_|address_|image_data|thumb_data|name_snapshot|sku_snapshot|notes|document/i);
    }
    assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:shop_order|order_item|delivery|product|product_gallery_image|order_event|product_event)\b/i);
    return old[name](sql, ...args);
  };
  return () => { Object.assign(store, old); assert.ok(queries > 0); };
};
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: three real analytics reads require fresh extended consent and preserve the eight legacy definitions`, options, async t => {
    const f = await analyticsFixture(t, dialect, { operationTools: entries(), config }), old = await freshCatalogAccess(f, legacyCatalogScopes);
    assert.deepEqual((await old.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
    for (const [name, args] of cases) assert.equal((await old.call(name, args)).response.status, 403);
    const client = await freshCatalogAccess(f, legacyCatalogScopes + ' analytics.extended');
    const listed = (await client.rpc('tools/list', {})).data.result.tools;
    assert.equal(listed.length, 11); assert.deepEqual(listed.slice(0, 8), catalogue.map(({ scope: _scope, ...tool }) => tool));
    assert.deepEqual(listed.slice(8).map(tool => tool.name), cases.map(([name]) => name));
    assert.ok(listed.slice(8).every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    const contracts = JSON.parse(readFileSync(new URL('../docs/mcp-v2/03-ANALYTICS-IMPLEMENTED.json', import.meta.url), 'utf8'));
    assert.equal(Object.keys(contracts.$defs).length, 6);
    for (const tool of listed.slice(8)) {
      assert.deepEqual(tool.inputSchema, contracts.$defs[tool.name + '.input']); assert.deepEqual(tool.outputSchema, contracts.$defs[tool.name + '.output']);
      assert.deepEqual(contracts['x-toolPolicies'][tool.name], { scope: 'analytics.extended', capability: 'figures.read', risk: 'LOW' });
      assert.equal(valid(contracts['x-syntheticArguments'][tool.name], tool.inputSchema), true);
    }
    const restore = spy(f.store); let results;
    try { results = await Promise.all(cases.map(async ([name, args]) => [name, dto(await client.call(name, args))])); } finally { restore(); }
    for (const [name, result] of results) {
      assert.equal(valid(result, listed.find(tool => tool.name === name).outputSchema), true);
      assert.equal(result.timeZone, 'UTC+8'); assert.equal(result.definitionVersion, 'accepted-submission-v1');
      assert.deepEqual(result.acceptedStatuses, ['CONFIRMED', 'SHIPPED', 'DELIVERED']);
      assert.equal(result.coverage.databaseComplete, true); assert.equal(result.coverage.historyComplete, false);
      assert.ok(Object.hasOwn(result, 'dateRange')); assert.ok(Object.hasOwn(result, 'filters')); assert.ok(Object.hasOwn(result, 'currency'));
      assert.doesNotMatch(JSON.stringify(result), /Synthetic private|buyer|recipient|address|phone|imageData/i);
      const audit = await f.store.get("SELECT tool_name, outcome FROM mcp_audit WHERE event = 'READ' AND outcome = ?", name);
      assert.deepEqual({ ...audit }, { tool_name: null, outcome: name });
    }
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_event')).n), 0);
  });
  test(`${dialect}: each analytics tool rechecks token scope, role, tenant, consent, revocation and closed arguments`, options, async t => {
    const f = await analyticsFixture(t, dialect, { operationTools: entries(), config }), client = await freshCatalogAccess(f, legacyCatalogScopes + ' analytics.extended');
    const token = await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash = ?', hash(client.bearer));
    const callAll = async status => { for (const [name, args] of cases) assert.equal((await client.call(name, args)).response.status, status, name); };
    for (const [name, args] of cases) {
      assert.equal((await client.call(name, { ...args, tenantId: 'other' })).data.error.code, -32602);
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
      for (const authorization of [undefined, 'Bearer invalid']) assert.equal((await f.call('/mcp', 'POST', body, { ...(authorization ? { authorization } : {}), accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' })).response.status, 401);
    }
    await f.store.run('UPDATE oauth_token SET scopes = ? WHERE token_hash = ?', legacyCatalogScopes, hash(client.bearer)); await callAll(403);
    await f.store.run('UPDATE oauth_token SET scopes = ? WHERE token_hash = ?', legacyCatalogScopes + ' analytics.extended', hash(client.bearer));
    await f.store.run("UPDATE seller_account SET role = 'MANAGER' WHERE id = ?", f.account.id); await callAll(200);
    await f.store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", f.account.id); await callAll(401);
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    await f.store.run("UPDATE oauth_grant SET tenant_id = 'other' WHERE id = ?", token.grant_id); await callAll(401);
    await f.store.run('UPDATE oauth_grant SET tenant_id = ? WHERE id = ?', f.binding.tenantId, token.grant_id);
    const consent = await f.store.get('SELECT epoch_hash FROM mcp_v2_scope_consent WHERE grant_id = ?', token.grant_id);
    await f.store.run('UPDATE mcp_v2_scope_consent SET epoch_hash = ? WHERE grant_id = ?', '0'.repeat(64), token.grant_id); await callAll(403);
    await f.store.run('UPDATE mcp_v2_scope_consent SET epoch_hash = ? WHERE grant_id = ?', consent.epoch_hash, token.grant_id);
    await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', stamp(), token.grant_id); await callAll(401);
    await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', token.grant_id);
    await f.store.run('UPDATE oauth_token SET revoked_at = ? WHERE token_hash = ?', stamp(), hash(client.bearer)); await callAll(401);
  });
  test(`${dialect}: invalid ranges, overflow and failed read audit produce controlled errors and no accepted audit`, options, async t => {
    const f = await analyticsFixture(t, dialect, { operationTools: entries(), config }), client = await freshCatalogAccess(f, legacyCatalogScopes + ' analytics.extended');
    assert.equal((await client.call('analytics.sales_trend', { from: '2026-02-30', toExclusive: '2026-03-01' })).data.error.code, -32602);
    assert.equal((await client.call('analytics.top_products', { ...cases[1][1], limit: 101 })).data.error.code, -32602);
    assert.equal((await client.call('analytics.inventory_risk', { slowDays: 367 })).data.error.code, -32602);
    await f.store.run('UPDATE shop_order SET total_minor = ? WHERE id = ?', Number.MAX_SAFE_INTEGER, f.ids[0]);
    const overflow = await client.call(...cases[0]); assert.equal(overflow.response.status, 503); assert.equal(overflow.data.error, 'temporarily_unavailable');
    const oldRun = f.store.run;
    f.store.run = (sql, ...values) => { if (sql.includes('INSERT INTO mcp_audit') && values.includes('READ')) throw new Error('Synthetic read audit failure.'); return oldRun(sql, ...values); };
    try { for (const [name, args] of cases.slice(1)) assert.equal((await client.call(name, args)).data.error.code, -32603); } finally { f.store.run = oldRun; }
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event = 'READ' AND outcome LIKE 'analytics.%'")).n), 0);
  });
}

test('analytics registry stays fixed, bounded and disabled with MCP off', () => {
  const entry = analyticsSalesTrendTool(), build = value => createOperationTools({ config: { mcpEnabled: false }, entries: [value] });
  assert.doesNotThrow(() => build(entry));
  for (const patch of [{ name: 'analytics.profit' }, { scope: 'analytics.read' }, { capability: 'catalog.write' }]) assert.throws(() => build({ ...entry, ...patch }), TypeError);
  const schema = structuredClone(entry.outputSchema); schema.properties.items.maxItems = 101;
  assert.throws(() => build({ ...entry, outputSchema: schema }), TypeError);
});
