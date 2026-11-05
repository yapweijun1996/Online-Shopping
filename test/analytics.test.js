import test from 'node:test';
import assert from 'node:assert/strict';
import { salesTrend, topProducts, inventoryRisk, ANALYTICS_LIMITS } from '../src/analytics.js';
import { dashboardFigures } from '../src/dashboard-figures.js';
import { reservedQuantitySql, stockAvailability } from '../src/stock-reservation.js';
import { analyticsFixture, analyticsNow } from './helpers/analytics-fixture.js';

const period = { from: '2026-10-01', toExclusive: '2026-10-11' };
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: independent accepted-value oracle agrees with dashboard UTC+8/status/currency definitions`, options, async t => {
    const f = await analyticsFixture(t, dialect), result = await salesTrend(f.store, { ...period, comparePrevious: true }, analyticsNow);
    assert.deepEqual(result.totals, [{ currency: 'MYR', orders: 3, totalMinor: 4350 }, { currency: 'SGD', orders: 1, totalMinor: 5000 }]);
    assert.deepEqual(result.comparison, { from: '2026-09-21', toExclusive: '2026-10-01', totals: [{ currency: 'MYR', orders: 1, totalMinor: 5000 }, { currency: 'SGD', orders: 0, totalMinor: 0 }],
      delta: [{ currency: 'MYR', orders: 2, totalMinor: -650 }, { currency: 'SGD', orders: 1, totalMinor: 5000 }] });
    assert.equal(result.items.length, 10); assert.equal(result.items[0].from, '2026-10-01');
    assert.deepEqual(result.items[8].sales, [{ currency: 'MYR', orders: 1, totalMinor: 1250 }, { currency: 'SGD', orders: 0, totalMinor: 0 }]);
    assert.deepEqual(result.items[9].sales, [{ currency: 'MYR', orders: 1, totalMinor: 2500 }, { currency: 'SGD', orders: 1, totalMinor: 5000 }]);
    assert.equal(result.coverage.databaseComplete, true); assert.equal(result.coverage.historyComplete, false);
    const dashboard = await dashboardFigures(f.store, analyticsNow);
    const today = await salesTrend(f.store, { from: '2026-10-10', toExclusive: '2026-10-11' }, analyticsNow);
    const window = await salesTrend(f.store, { from: '2026-09-11', toExclusive: '2026-10-11' }, analyticsNow);
    assert.deepEqual(today.totals.filter(row => row.orders), dashboard.salesToday);
    assert.deepEqual(window.totals.filter(row => row.orders), dashboard.salesWindow);
    assert.equal(dashboard.ordersToday, 5); assert.equal(dashboard.pending, 1);
    const top = await topProducts(f.store, { from: '2026-09-11', toExclusive: '2026-10-11' }, analyticsNow);
    for (const row of dashboard.topProducts) assert.deepEqual(top.items.find(item => item.productId === row.productId && item.currency === row.currency),
      { productId: row.productId, sku: row.sku, name: row.name, categoryCode: row.productId === f.c.id ? 'ALTERNATE' : 'SYNTHETIC', currency: row.currency, quantity: row.quantity, totalMinor: row.totalMinor });
    assert.doesNotMatch(JSON.stringify(result), /Synthetic private|phone|recipient|address|buyer/i);
  });
  test(`${dialect}: calendar grouping, leap/custom ranges, comparison and bucket pagination are exact`, options, async t => {
    const f = await analyticsFixture(t, dialect);
    const weekly = await salesTrend(f.store, { ...period, groupBy: 'week', currency: 'MYR' }, analyticsNow);
    assert.deepEqual(weekly.items.map(row => [row.from, row.toExclusive, row.sales[0].totalMinor]), [['2026-10-01', '2026-10-05', 600], ['2026-10-05', '2026-10-11', 3750]]);
    const monthly = await salesTrend(f.store, { from: '2026-09-20', toExclusive: '2026-10-11', groupBy: 'month' }, analyticsNow);
    assert.deepEqual(monthly.items.map(row => [row.from, row.toExclusive, row.sales[0].totalMinor]), [['2026-09-20', '2026-10-01', 5000], ['2026-10-01', '2026-10-11', 4350]]);
    const leap = await salesTrend(f.store, { from: '2024-02-28', toExclusive: '2024-03-02', currency: 'SGD' }, analyticsNow);
    assert.deepEqual(leap.items.map(row => row.from), ['2024-02-28', '2024-02-29', '2024-03-01']); assert.equal(leap.totals[0].totalMinor, 0);
    const first = await salesTrend(f.store, { from: '2024-01-01', toExclusive: '2025-01-01', limit: 100 }, analyticsNow);
    const last = await salesTrend(f.store, { from: '2024-01-01', toExclusive: '2025-01-01', limit: 100, offset: 300 }, analyticsNow);
    assert.equal(first.items.length, 100); assert.equal(first.nextOffset, 100); assert.equal(first.coverage.pageComplete, false);
    assert.equal(last.items.length, 66); assert.equal(last.nextOffset, null); assert.equal(last.paginationCapped, false);
    for (const patch of [{ from: '2026-02-30' }, { from: '2026-10-11' }, { from: '2024-01-01', toExclusive: '2025-01-02' }, { groupBy: 'quarter' }, { currency: 'USD' },
      { limit: 101 }, { offset: 10001 }, { comparePrevious: 'true' }, { tenantId: 'other' }]) await assert.rejects(salesTrend(f.store, { ...period, ...patch }, analyticsNow), { status: 400 });
  });
  test(`${dialect}: current product/category attribution is explicit while dashboard snapshots remain unchanged`, options, async t => {
    const f = await analyticsFixture(t, dialect);
    await f.store.run('UPDATE product SET sku = ?, name = ?, category = ? WHERE id = ?', 'CURRENT-A', 'Current synthetic name', 'ALTERNATE', f.a.id);
    const result = await topProducts(f.store, { ...period, sortBy: 'value' }, analyticsNow);
    assert.equal(result.attribution, 'CURRENT_PRODUCT_AND_CATEGORY'); assert.equal(result.historicalCategoryAvailable, false);
    assert.deepEqual(result.items.map(row => [row.sku, row.currency, row.quantity, row.totalMinor]), [['CURRENT-A', 'MYR', 3, 3750], ['C', 'MYR', 3, 600], ['B', 'SGD', 1, 5000]]);
    const category = await topProducts(f.store, { ...period, groupBy: 'category' }, analyticsNow);
    assert.deepEqual(category.items, [{ productId: null, sku: null, name: null, categoryCode: 'ALTERNATE', currency: 'MYR', quantity: 6, totalMinor: 4350 },
      { productId: null, sku: null, name: null, categoryCode: 'SYNTHETIC', currency: 'SGD', quantity: 1, totalMinor: 5000 }]);
    const dashboard = await dashboardFigures(f.store, analyticsNow);
    assert.equal(dashboard.topProducts.find(row => row.productId === f.a.id).sku, 'A');
    const first = await topProducts(f.store, { ...period, limit: 1 }, analyticsNow), next = await topProducts(f.store, { ...period, limit: 1, offset: 1 }, analyticsNow);
    assert.equal(first.nextOffset, 1); assert.notEqual(first.items[0].productId, next.items[0].productId);
  });
  test(`${dialect}: low/slow inventory honors strict48-hour holds, unlimited stock, shortfalls and insufficient age`, options, async t => {
    const f = await analyticsFixture(t, dialect);
    await f.place(f.a, 4, '2026-10-07T17:00:00.000Z', 'SUBMITTED');
    await f.place(f.a, 2, '2026-10-07T17:00:00.001Z', 'SUBMITTED');
    await f.place(f.a, 7, '2026-10-07T16:59:59.999Z', 'SUBMITTED');
    await f.place(f.a, 1, '2026-10-10T01:00:00.000Z', 'SUBMITTED');
    await f.place(f.b, 3, '2026-10-09T16:00:00.000Z', 'SUBMITTED');
    const fresh = await f.make('NEW', 100), inactive = await f.make('INACTIVE', 100);
    await f.store.run('UPDATE product SET stock_quantity = 2 WHERE id = ?', f.a.id);
    await f.store.run('UPDATE product SET created_at = ? WHERE id = ?', '2026-10-09T00:00:00.000Z', fresh.id);
    await f.store.run('UPDATE product SET active = 0, stock_quantity = 0 WHERE id = ?', inactive.id);
    const result = await inventoryRisk(f.store, { mode: 'all' }, analyticsNow), byId = new Map(result.items.map(row => [row.productId, row]));
    const a = byId.get(f.a.id), b = byId.get(f.b.id);
    assert.deepEqual([a.stockQuantity, a.reservedQuantity, a.availableQuantity, a.reservationShortfall, a.lowStock, a.slowMoving, a.acceptedQuantityInPeriod], [2, 4, 0, 2, true, false, 7]);
    assert.deepEqual([b.stockQuantity, b.reservedQuantity, b.availableQuantity, b.reservationShortfall, b.lowStock, b.slowMoving, b.acceptedQuantityInPeriod], [null, 3, null, 0, false, true, 0]);
    assert.deepEqual(result.totals, { scannedProducts: 4, matchedProducts: 4, matchedTracked: 1, matchedUnlimited: 3, matchedLowStock: 1, matchedSlowMoving: 1, matchedUnknownSlow: 1 });
    assert.equal(byId.get(fresh.id).slowMoving, null); assert.equal(byId.has(inactive.id), false);
    assert.equal(Number((await f.store.get(`SELECT ${reservedQuantitySql('?', analyticsNow.getTime())} AS held`, f.a.id)).held), a.reservedQuantity);
    assert.equal((await inventoryRisk(f.store, { activeOnly: false, mode: 'all' }, analyticsNow)).items.length, 5);
    assert.deepEqual((await inventoryRisk(f.store, { mode: 'low' }, analyticsNow)).items.map(row => row.productId), [f.a.id]);
    assert.deepEqual((await inventoryRisk(f.store, { mode: 'slow' }, analyticsNow)).items.map(row => row.productId), [f.b.id]);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id = ?', f.a.id)).stock_quantity, 2);
  });
  test(`${dialect}: unsafe aggregate money fails closed instead of rounding or returning partial totals`, options, async t => {
    const f = await analyticsFixture(t, dialect);
    await f.store.run('UPDATE shop_order SET total_minor = ? WHERE id = ?', Number.MAX_SAFE_INTEGER, f.ids[0]);
    await assert.rejects(salesTrend(f.store, period, analyticsNow), { status: 503, code: 'ANALYTICS_LIMIT' });
    await f.store.run('UPDATE order_item SET line_total_minor = ? WHERE delivery_id IN (SELECT id FROM delivery WHERE order_id = ?)', Number.MAX_SAFE_INTEGER, f.ids[0]);
    await assert.rejects(topProducts(f.store, period, analyticsNow), { status: 503, code: 'ANALYTICS_LIMIT' });
  });
}

test('analytics caps source rows and bytes before exposing partial aggregates; stock presentation is pure', async () => {
  await assert.rejects(salesTrend({ all: async sql => { assert.match(sql, /LIMIT 10001/); return Array(10001).fill({}); } }, period, analyticsNow), { code: 'ANALYTICS_LIMIT' });
  await assert.rejects(topProducts({ all: async sql => sql.includes('FROM shop_order WHERE') ? [] : Array(50001).fill({}) }, period, analyticsNow), { code: 'ANALYTICS_LIMIT' });
  await assert.rejects(inventoryRisk({ all: async () => Array(10001).fill({}) }, {}, analyticsNow), { code: 'ANALYTICS_LIMIT' });
  await assert.rejects(inventoryRisk({ all: async () => Array(10000).fill({ name: 'x'.repeat(1000) }) }, {}, analyticsNow), { code: 'ANALYTICS_LIMIT' });
  assert.deepEqual(stockAvailability(2, 4), { reservedQuantity: 4, availableQuantity: 0, reservationShortfall: 2 });
  assert.deepEqual(stockAvailability(null, 4), { reservedQuantity: 4, availableQuantity: null, reservationShortfall: 0 });
  assert.throws(() => stockAvailability(-1, 0), TypeError); assert.throws(() => stockAvailability(0, Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.equal(ANALYTICS_LIMITS.page, 100);
});
