import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { listSellerOrders, decideSellerOrder } from '../src/seller-orders.js';
import { dashboardFigures } from '../src/dashboard-figures.js';
import { exportOrdersCsv } from '../src/order-export.js';
import { eraseOrderContact } from '../src/erase-contact.js';
import { listAuditEvents } from '../src/audit-log.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('PostgreSQL tests require NODE_ENV=test and a disposable test database.');

test('PostgreSQL: order filters, dashboard figures, CSV export and contact erasure match SQLite behaviour', { skip: !base }, async (t) => {
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  await createCategory(store, { code: 'TEST', label: 'Synthetic' });
  const product = await createProduct(store, { sku: 'TEST-1', name: 'Synthetic item', description: 'Synthetic description', category: 'TEST', priceMinor: 500, active: true });
  const place = async (key, quantity) => (await createOrder(store, `pg-report-intent-${key}`, { buyer: { fullName: key === 'b' ? '=SUM(1)' : 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
    deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
      items: [{ productId: product.id, quantity, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }] })).receipt.orderNo;
  const a = await place('a', 1), b = await place('b', 3);
  await store.run('UPDATE shop_order SET submitted_at = ? WHERE order_no = ?', '2026-10-01T04:00:00.000Z', a);
  await store.run('UPDATE shop_order SET submitted_at = ?, status = ? WHERE order_no = ?', '2026-10-09T16:30:00.000Z', 'CONFIRMED', b);
  const numbers = async (query) => (await listSellerOrders(store, new URLSearchParams(query))).items.map((item) => item.orderNo);
  assert.deepEqual(await numbers('minTotal=1000&currency=MYR'), [b]);
  assert.deepEqual(await numbers('search=' + a.slice(-3) + '&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z'), [a]);
  const figures = await dashboardFigures(store, new Date('2026-10-09T17:00:00.000Z'));
  assert.deepEqual(figures.salesToday, [{ currency: 'MYR', orders: 1, totalMinor: 1500 }]);
  assert.equal(figures.pending, 1);
  assert.deepEqual(figures.topProducts.map((row) => [row.sku, row.quantity]), [['TEST-1', 3]]);
  const csv = await exportOrdersCsv(store, new URLSearchParams('status=CONFIRMED'));
  assert.ok(csv.includes(`${b},2026-10-09T16:30:00.000Z,CONFIRMED,MYR,15.00,3,"'=SUM(1)"`) || csv.includes(`'=SUM(1)`));
  const rejected = await decideSellerOrder(store, (await store.get('SELECT id FROM shop_order WHERE order_no = ?', a)).id, 'reject', { expectedRevision: 1, reason: 'Synthetic.' }, 'tester');
  await eraseOrderContact(store, rejected.id, { expectedRevision: rejected.revision, confirmOrderNo: a }, 'tester');
  const erased = await store.get('SELECT buyer_name, buyer_phone, buyer_email, contact_erased_by, revision FROM shop_order WHERE order_no = ?', a);
  assert.deepEqual({ ...erased }, { buyer_name: 'Erased', buyer_phone: '', buyer_email: null, contact_erased_by: 'tester', revision: Number(rejected.revision) + 1 });
  const audit = await listAuditEvents(store, new URLSearchParams('actor=SELLER'));
  assert.equal(audit.items[0].type, 'CONTACT_ERASED');
  assert.equal(audit.items[0].actorId, 'tester');
});
