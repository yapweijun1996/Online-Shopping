import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { freshCatalogAccess } from './helpers/mcp-catalog-default-grant.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { inventoryRisk, ANALYTICS_LIMITS } from '../src/analytics.js';
import { analyticsSalesTrendTool, analyticsTopProductsTool, analyticsInventoryRiskTool } from '../src/mcp/analytics-tools.js';

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: valid multibyte analytics pages fail with controlled503 and smaller pages retain complete totals`,
  { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const f = await reviewFixture(t, dialect, { operationTools: [analyticsSalesTrendTool(), analyticsTopProductsTool(), analyticsInventoryRiskTool()],
      config: { mcpRedirectUris: ['https://client.example.com/catalog-callback'] } });
    const category = 'A'.repeat(80), name = '漢'.repeat(120), products = [];
    await createCategory(f.store, { code: category, label: 'Synthetic maximum fields' });
    for (let n = 0; n < 100; n++) products.push(await createProduct(f.store, { sku: ('SYNTHETIC-' + n).padEnd(40, 'A'), name,
      description: 'Synthetic response budget fixture', category, priceMinor: 100, stockQuantity: 1, active: true }));
    const deliveries = [products.slice(0, 50), products.slice(50)].map(items => ({ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' },
      address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' }, items: items.map(product => ({ productId: product.id, quantity: 1, expectedPriceMinor: 100, expectedCurrency: 'MYR' })) }));
    const order = await createOrder(f.store, 'synthetic-response-byte-budget-order', { buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true, deliveries });
    await f.store.run("UPDATE shop_order SET status = 'CONFIRMED', submitted_at = ? WHERE order_no = ?", '2026-11-05T01:00:00.000Z', order.receipt.orderNo);
    const client = await freshCatalogAccess(f, 'analytics.extended');
    await assert.rejects(inventoryRisk(f.store, { mode: 'all', limit: 100 }), { status: 503, code: 'ANALYTICS_RESPONSE_LIMIT' });
    const denied = await client.call('analytics.inventory_risk', { mode: 'all', limit: 100 });
    assert.equal(denied.response.status, 503); assert.deepEqual(denied.data, { error: 'temporarily_unavailable' });
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event = 'READ' AND tool_name = 'analytics.inventory_risk' AND outcome = 'OK'")).n), 0);
    const pages = [];
    for (const offset of [0, 50]) {
      const response = await client.call('analytics.inventory_risk', { mode: 'all', limit: 50, offset });
      assert.equal(response.response.status, 200, JSON.stringify(response.data)); const value = response.data.result.structuredContent; pages.push(value);
      assert.equal(value.items.length, 50); assert.equal(value.totals.matchedProducts, 100);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= ANALYTICS_LIMITS.responseBytes);
      assert.ok(value.items.every(row => row.name === name && row.sku.length === 40 && row.categoryCode.length === 80));
    }
    assert.equal(pages[0].nextOffset, 50); assert.equal(pages[1].nextOffset, null);
    assert.equal(new Set(pages.flatMap(page => page.items.map(row => row.productId))).size, 100);
    assert.deepEqual(pages[0].totals, pages[1].totals);
    for (const [tool, args] of [['analytics.top_products', { from: '2026-11-01', toExclusive: '2026-11-06' }],
      ['analytics.sales_trend', { from: '2026-09-01', toExclusive: '2026-12-10', comparePrevious: true }]]) {
      const large = await client.call(tool, { ...args, limit: 100 }); assert.equal(large.response.status, 200, JSON.stringify(large.data));
      const value = large.data.result.structuredContent; assert.equal(value.items.length, 100);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= ANALYTICS_LIMITS.responseBytes);
      const small = await client.call(tool, { ...args, limit: 50 }); assert.equal(small.response.status, 200, JSON.stringify(small.data));
      assert.equal(small.data.result.structuredContent.items.length, 50); assert.deepEqual(small.data.result.structuredContent.totals, value.totals);
    }
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 100);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
  });
