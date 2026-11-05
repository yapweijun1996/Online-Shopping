import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { catalogue } from '../src/mcp/tools.js';
import { analyticsFixture } from './helpers/analytics-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';

const config = { mcpRedirectUris: ['https://client.example.com/catalog-callback'] };
const calls = [['analytics.sales_trend', { from: '2026-10-01', toExclusive: '2026-10-11' }],
  ['analytics.top_products', { from: '2026-10-01', toExclusive: '2026-10-11' }], ['analytics.inventory_risk', { mode: 'all' }]];
for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: gated default analytics is visible only to fresh extended consent and never changes legacy schemas`,
  { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async t => {
    const f = await analyticsFixture(t, dialect, { operationTools: undefined, config });
    const old = await freshCatalogAccess(f, legacyCatalogScopes);
    assert.deepEqual((await old.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
    for (const [name, args] of calls) assert.equal((await old.call(name, args)).response.status, 403);
    const client = await freshCatalogAccess(f, legacyCatalogScopes + ' analytics.extended');
    const listed = (await client.rpc('tools/list', {})).data.result.tools;
    assert.equal(listed.length, 11); assert.deepEqual(listed.slice(0, 8), catalogue.map(({ scope: _scope, ...tool }) => tool));
    assert.deepEqual(listed.slice(8).map(tool => tool.name), calls.map(([name]) => name));
    for (const [name, args] of calls) {
      const result = await client.call(name, args); assert.equal(result.response.status, 200, JSON.stringify(result.data));
      const value = result.data.result.structuredContent; assert.equal(value.timeZone, 'UTC+8'); assert.equal(value.coverage.historyComplete, false);
      assert.ok(value.dateRange); assert.ok(value.filters); assert.ok(value.totals);
      assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event = 'READ' AND outcome = ?", name)).n, 1);
    }
    const all = await freshCatalogAccess(f, legacyCatalogScopes + ' company.read company.write catalog.write analytics.extended');
    assert.equal((await all.rpc('tools/list', {})).data.result.tools.length, 18);
    assert.equal((await old.rpc('tools/list', {})).data.result.tools.length, 8);
    assert.equal((await client.rpc('tools/list', {})).data.result.tools.length, 11);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_event')).n), 0);
  });

test('explicit empty, disabled and production registries expose no built-in analytics; null stays invalid', async t => {
  for (const options of [{ operationTools: [] }, { operationTools: undefined, config: { mcpV2: { enabled: false } } },
    { operationTools: undefined, config: { production: true } }]) {
    const f = await analyticsFixture(t, 'sqlite', { ...options, config: { ...config, ...options.config } }), client = await freshCatalogAccess(f, legacyCatalogScopes);
    assert.deepEqual((await client.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
    for (const [name, args] of calls) assert.equal((await client.call(name, args)).data.error.code, -32602);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    await assert.rejects(createApi({ store: f.store, config: f.config, operationTools: null }), TypeError);
  }
});
