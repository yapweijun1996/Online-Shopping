import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { topProducts, inventoryRisk } from '../src/analytics.js';
import { analyticsFixture, analyticsNow } from './helpers/analytics-fixture.js';

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: selective analytics uses status/time and FK join indexes on 30000 synthetic order lines`,
  { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const f = await analyticsFixture(t, dialect);
    await f.store.transaction(async () => {
      for (let start = 0; start < 30000; start += 500) {
        const orders = [], deliveries = [], items = [], orderArgs = [], deliveryArgs = [], itemArgs = [];
        for (let n = start; n < start + 500; n++) {
          const orderId = randomUUID(), deliveryId = randomUUID(), at = n >= 29997 ? '2026-10-09T16:00:00.000Z' : '2026-01-01T00:00:00.000Z';
          orders.push("(?, ?, 'Synthetic buyer', '', 0, 'en', 'CONFIRMED', 1, 'MYR', 100, ?, ?)"); orderArgs.push(orderId, 'SYNTHETIC-PLAN-' + n, at, at);
          deliveries.push("(?, ?, 0, 'Synthetic recipient', '', 'Synthetic street', '50000', 'MY')"); deliveryArgs.push(deliveryId, orderId);
          items.push("(?, ?, 0, ?, 'SYNTHETIC', 'Synthetic item', 100, 1, 100, 'MYR')"); itemArgs.push(randomUUID(), deliveryId, f.a.id);
        }
        await f.store.run('INSERT INTO shop_order(id, order_no, buyer_name, buyer_phone, whatsapp_opt_in, locale, status, revision, currency, total_minor, submitted_at, updated_at) VALUES ' + orders.join(','), ...orderArgs);
        await f.store.run('INSERT INTO delivery(id, order_id, position, recipient_name, recipient_phone, address_line1, address_postcode, address_country) VALUES ' + deliveries.join(','), ...deliveryArgs);
        await f.store.run('INSERT INTO order_item(id, delivery_id, position, product_id, sku_snapshot, name_snapshot, price_minor, quantity, line_total_minor, currency) VALUES ' + items.join(','), ...itemArgs);
      }
    });
    await f.store.exec('ANALYZE');
    const statements = [], read = { all: (sql, ...args) => { statements.push([sql, args]); return f.store.all(sql, ...args); } };
    const started = performance.now(), result = await topProducts(read, { from: '2026-10-10', toExclusive: '2026-10-11' }, analyticsNow);
    t.diagnostic('Bounded selective read milliseconds: ' + (performance.now() - started).toFixed(2));
    assert.equal(result.items.find(row => row.productId === f.a.id).quantity, 5);
    assert.equal(statements.length, 2);
    const stockStatements = [], stockRead = { all: (sql, ...args) => { stockStatements.push([sql, args]); return f.store.all(sql, ...args); } };
    const stockStarted = performance.now(); await inventoryRisk(stockRead, { mode: 'all' }, analyticsNow);
    t.diagnostic('Bounded stock read milliseconds: ' + (performance.now() - stockStarted).toFixed(2));
    assert.equal(stockStatements.length, 5);
    const [pendingSql, pendingArgs] = stockStatements.find(([sql]) => /FROM shop_order WHERE status = 'SUBMITTED'/.test(sql));
    assert.match(JSON.stringify(await f.store.all((dialect === 'postgres' ? 'EXPLAIN (FORMAT JSON) ' : 'EXPLAIN QUERY PLAN ') + pendingSql, ...pendingArgs)), /shop_order_queue/);
    const plans = [];
    for (const [sql, args] of statements) plans.push(JSON.stringify(await f.store.all((dialect === 'postgres' ? 'EXPLAIN (FORMAT JSON) ' : 'EXPLAIN QUERY PLAN ') + sql, ...args)));
    assert.match(plans[0], /shop_order_queue/); assert.match(plans[1], /shop_order_queue/);
    assert.match(plans[1], /delivery_order_id_position_key|sqlite_autoindex_delivery/);
    assert.match(plans[1], /order_item_delivery_id_position_key|sqlite_autoindex_order_item/);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM shop_order')).n), 30009);
  });
