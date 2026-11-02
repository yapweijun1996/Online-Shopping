import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';
import { createProduct } from '../src/products.js';
import { dashboardFigures, shopDayStart } from '../src/dashboard-figures.js';
import { csvCell } from '../src/order-export.js';
import { EXPORT_ROW_LIMIT } from '../src/order-export.js';

async function seeded() {
  const f = await sellerFixture();
  const sgd = await createProduct(f.app.database, { sku: 'SGD-ITEM', name: 'Singapore item', description: 'Fictional', category: 'EXAMPLES', priceMinor: 5000, active: true });
  // The seller API only creates products in the company currency; a second-currency product is set up directly.
  await f.app.database.run("UPDATE product SET currency = 'SGD' WHERE id = ?", sgd.id);
  sgd.currency = 'SGD';
  const db = f.app.database;
  const place = async (buyerName, product, quantity, submittedAt, status) => {
    const order = await f.submit({ buyerName, quantity, item: product });
    assert.equal(order.response.status, 201);
    await db.run('UPDATE shop_order SET submitted_at = ?, status = ? WHERE order_no = ?', submittedAt, status, order.data.orderNo);
    return order.data.orderNo;
  };
  return { f, sgd, place };
}

test('order list filters by date range, currency and total, with bounded validation', async () => {
  const { f, sgd, place } = await seeded();
  try {
    const a = await place('A', f.product, 1, '2026-10-01T04:00:00.000Z', 'CONFIRMED');   // MYR 12.50
    const b = await place('B', f.product, 4, '2026-10-05T04:00:00.000Z', 'SHIPPED');     // MYR 50.00
    const c = await place('C', sgd, 2, '2026-10-06T04:00:00.000Z', 'DELIVERED');         // SGD 100.00
    const { headers } = await f.login();
    const list = async (query) => (await f.request('GET', `/api/v1/seller/orders?${query}`, null, headers));
    const numbers = async (query) => (await list(query)).data.items.map((item) => item.orderNo).sort();
    assert.deepEqual(await numbers('currency=SGD'), [c]);
    assert.deepEqual(await numbers('currency=MYR'), [a, b].sort());
    assert.deepEqual(await numbers('minTotal=2000'), [b, c].sort());
    assert.deepEqual(await numbers('maxTotal=5000&currency=MYR'), [a, b].sort());
    assert.deepEqual(await numbers('minTotal=1250&maxTotal=1250'), [a]);
    assert.deepEqual(await numbers('from=2026-10-05T00:00:00.000Z&to=2026-10-06T00:00:00.000Z'), [b]);   // `to` is exclusive
    assert.deepEqual(await numbers(`status=SHIPPED,DELIVERED&from=2026-10-02T00:00:00.000Z`), [b, c].sort());
    for (const bad of ['currency=USD', 'minTotal=-1', 'minTotal=abc', 'minTotal=500&maxTotal=100', 'from=yesterday', 'maxTotal=1e9']) {
      assert.equal((await list(bad)).response.status, 400, bad);
    }
  } finally { await f.close(); }
});

test('CSV export follows the filters, neutralises formulas, and refuses anonymous and sample sites', async () => {
  const { f, sgd, place } = await seeded();
  try {
    await place('=HYPERLINK("http://evil.invalid")', f.product, 1, '2026-10-01T04:00:00.000Z', 'CONFIRMED');
    await place('Plain, "quoted" Buyer', sgd, 1, '2026-10-02T04:00:00.000Z', 'DELIVERED');
    assert.equal((await f.request('GET', '/api/v1/seller/orders/export.csv', null, { origin: f.origin })).response.status, 401);
    const { headers } = await f.login();
    const all = await f.request('GET', '/api/v1/seller/orders/export.csv', null, headers);
    assert.equal(all.response.status, 200);
    assert.match(all.response.headers.get('content-type'), /^text\/csv/);
    assert.match(all.response.headers.get('content-disposition'), /^attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(all.response.headers.get('cache-control'), 'no-store');
    const lines = all.data.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^Order number,Submitted \(UTC\),Status,Currency,Total,Items,Buyer name/);
    assert.ok(lines.some((line) => line.includes(`"'=HYPERLINK(""http://evil.invalid"")"`)), 'formula cell is prefixed with an apostrophe');
    assert.ok(lines.some((line) => line.includes('"Plain, ""quoted"" Buyer"') && line.includes(',SGD,50.00,1,')));
    const sgdOnly = await f.request('GET', '/api/v1/seller/orders/export.csv?currency=SGD', null, headers);
    assert.equal(sgdOnly.data.trim().split('\r\n').length, 2);
    assert.equal((await f.request('GET', '/api/v1/seller/orders/export.csv?currency=XXX', null, headers)).response.status, 400);
  } finally { await f.close(); }
});

test('CSV cells: formula prefixes, quotes and control characters', () => {
  for (const [input, expected] of [['=1+1', "'=1+1"], ['+1', "'+1"], ['-1', "'-1"], ['@x', "'@x"], ['\tx', "'\tx"], ['a,b', '"a,b"'], ['say "hi"', '"say ""hi"""'], [null, ''], [12, '12']]) {
    assert.equal(csvCell(input), expected);
  }
});

test('CSV export is refused above the row limit and on a quick sign-in site', async () => {
  const { f, place } = await seeded();
  try {
    const { headers } = await f.login();
    await place('A', f.product, 1, '2026-10-01T04:00:00.000Z', 'CONFIRMED');
    const db = f.app.database;
    const template = await db.get('SELECT * FROM shop_order LIMIT 1');
    const columns = Object.keys(template);
    await db.transaction(async () => {
      for (let n = 0; n < EXPORT_ROW_LIMIT; n++) {
        await db.run(`INSERT INTO shop_order(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map((column) =>
          column === 'id' ? `bulk-${n}` : column === 'order_no' ? `BULK-${n}` : template[column]));
      }
    });
    const refused = await f.request('GET', '/api/v1/seller/orders/export.csv', null, headers);
    assert.equal(refused.response.status, 413);
    assert.equal(refused.data.error.code, 'TOO_MANY_ROWS');
    assert.equal((await f.request('GET', '/api/v1/seller/orders/export.csv?search=BULK-1&maxTotal=1', null, headers)).response.status, 200);
  } finally { await f.close(); }
  const sample = await sellerFixture({ sellerQuickLogin: true });
  try {
    const { headers } = await sample.login();
    assert.equal((await sample.request('GET', '/api/v1/seller/orders/export.csv', null, headers)).response.status, 403);
  } finally { await sample.close(); }
});

test('dashboard: today is the UTC+8 day, sales are per currency and exclude rejected and cancelled orders', async () => {
  const { f, sgd, place } = await seeded();
  try {
    // 2026-10-09 17:00 UTC is already 2026-10-10 01:00 in Malaysia and Singapore.
    const now = new Date('2026-10-09T17:00:00.000Z');
    assert.equal(new Date(shopDayStart(now.getTime())).toISOString(), '2026-10-09T16:00:00.000Z');
    await place('Today MYR', f.product, 2, '2026-10-09T16:30:00.000Z', 'CONFIRMED');      // today in UTC+8, 25.00 MYR
    await place('Today SGD', sgd, 1, '2026-10-09T20:00:00.000Z', 'SHIPPED');              // today, 50.00 SGD
    await place('Yesterday', f.product, 1, '2026-10-09T15:59:59.000Z', 'DELIVERED');      // yesterday in UTC+8, 12.50 MYR
    await place('Rejected', f.product, 9, '2026-10-09T17:00:00.000Z', 'REJECTED');
    await place('Cancelled', f.product, 9, '2026-10-09T17:30:00.000Z', 'CANCELLED');
    await place('Waiting', f.product, 1, '2026-10-09T17:40:00.000Z', 'SUBMITTED');
    await place('Old', f.product, 7, '2026-08-01T04:00:00.000Z', 'DELIVERED');           // outside the 30-day window
    const figures = await dashboardFigures(f.app.database, now);
    assert.equal(figures.ordersToday, 5);   // all but Yesterday and Old
    assert.equal(figures.pending, 1);
    assert.deepEqual(figures.salesToday, [{ currency: 'MYR', orders: 1, totalMinor: 2500 }, { currency: 'SGD', orders: 1, totalMinor: 5000 }]);
    assert.deepEqual(figures.salesWindow, [{ currency: 'MYR', orders: 2, totalMinor: 3750 }, { currency: 'SGD', orders: 1, totalMinor: 5000 }]);
    assert.deepEqual(figures.topProducts.map((row) => [row.sku, row.currency, row.quantity]), [['SELLER-ITEM', 'MYR', 3], ['SGD-ITEM', 'SGD', 1]]);
    const { headers } = await f.login();
    assert.equal((await f.request('GET', '/api/v1/seller/dashboard', null, { origin: f.origin })).response.status, 401);
    const served = await f.request('GET', '/api/v1/seller/dashboard', null, headers);
    assert.equal(served.response.status, 200);
    assert.equal(served.response.headers.get('cache-control'), 'no-store');
    assert.ok(Array.isArray(served.data.salesToday));
  } finally { await f.close(); }
});
