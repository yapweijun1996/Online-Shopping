import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createCategory } from '../src/settings.js';
import { createProduct, updateProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { addOrderNote } from '../src/order-notes.js';
import { getSellerOrder } from '../src/seller-orders.js';
import { bulkSetActive, listProductHistory, trackCreate, trackUpdate } from '../src/product-history.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('PostgreSQL tests require NODE_ENV=test and a disposable test database.');

test('PostgreSQL: order notes, product history and bulk activation behave like SQLite', { skip: !base }, async (t) => {
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  await createCategory(store, { code: 'TEST', label: 'Synthetic' });
  const one = await trackCreate(store, 'tester', () => createProduct(store, { sku: 'PG-1', name: 'One', description: 'Synthetic', category: 'TEST', priceMinor: 500, stockQuantity: 3, active: true }));
  const two = await trackCreate(store, 'tester', () => createProduct(store, { sku: 'PG-2', name: 'Two', description: 'Synthetic', category: 'TEST', priceMinor: 700, active: true }));
  await createOrder(store, 'pg-note-intent-0001', { buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
    deliveries: [{ recipient: { fullName: 'R', phone: '+60123456789' }, address: { line1: 'Street', postcode: '50000', country: 'MY' }, items: [{ productId: two.id, quantity: 1, expectedPriceMinor: 700, expectedCurrency: 'MYR' }] }] });
  const id = (await store.get('SELECT id FROM shop_order')).id;
  await addOrderNote(store, id, { body: 'Line one\nLine two' }, 'tester');
  assert.deepEqual((await getSellerOrder(store, id)).notes.map((note) => note.body), ['Line one\nLine two']);
  await trackUpdate(store, one.id, 'tester', () => updateProduct(store, one.id, { priceMinor: 650, stockQuantity: 8 }));
  const history = await listProductHistory(store, one.id, new URLSearchParams());
  assert.deepEqual(history.items.map((item) => item.action), ['UPDATED', 'CREATED']);
  assert.deepEqual(history.items[0].changes, [{ field: 'priceMinor', from: 500, to: 650 }, { field: 'stockQuantity', from: 3, to: 8 }]);
  assert.deepEqual(await bulkSetActive(store, [one.id, two.id], false, 'tester', (id, patch) => updateProduct(store, id, patch)), { requested: 2, changed: 2 });
  await assert.rejects(bulkSetActive(store, [one.id, '11111111-1111-4111-8111-111111111111'], true, 'tester', (id, patch) => updateProduct(store, id, patch)), /no longer exists/);
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM product WHERE active = 1')).n), 0);
});

test('PostgreSQL: the product CSV export matches', { skip: !base }, async (t) => {
  const { exportProductsCsv } = await import('../src/product-export.js');
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  await createCategory(store, { code: 'TEST', label: 'Synthetic' });
  await createProduct(store, { sku: 'PG-CSV', name: '+Plus', description: 'Synthetic', category: 'TEST', priceMinor: 1999, stockQuantity: 2, active: true });
  const csv = await exportProductsCsv(store, new URLSearchParams('search=csv'));
  assert.ok(csv.includes("PG-CSV,'+Plus,Synthetic,Synthetic,,,MYR,19.99,2,yes,"));
});

test('PostgreSQL: the product CSV import round-trips, previews, applies and rolls back like SQLite', { skip: !base }, async (t) => {
  const { exportProductsCsv } = await import('../src/product-export.js');
  const { importProducts, planImport } = await import('../src/product-import.js');
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  await createCategory(store, { code: 'TEST', label: 'Synthetic' });
  await createProduct(store, { sku: 'PG-IMP', name: '=Formula', description: 'Synthetic', category: 'TEST', priceMinor: 1999, stockQuantity: 2, active: true });
  const csv = await exportProductsCsv(store, new URLSearchParams());
  assert.deepEqual((await planImport(store, csv)).summary, { create: 0, update: 0, unchanged: 1, errors: 0 });
  const edited = 'SKU,Name,Description,Category,Price,Stock,Active\nPG-IMP,,,,25.00,,\nPG-NEW,Brand new,Fresh,Synthetic,3.50,9,yes\n';
  assert.deepEqual((await planImport(store, edited)).summary, { create: 1, update: 1, unchanged: 0, errors: 0 });
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM product')).n), 1, 'a plan writes nothing');
  await importProducts(store, edited, 'tester');
  assert.deepEqual((await store.all('SELECT sku, price_minor, stock_quantity FROM product ORDER BY sku')).map((row) => [row.sku, Number(row.price_minor), row.stock_quantity === null ? null : Number(row.stock_quantity)]), [['PG-IMP', 2500, null], ['PG-NEW', 350, 9]]);
  await assert.rejects(importProducts(store, 'SKU,Name,Description,Category,Price\nPG-OK,Fine,Desc,Synthetic,1.00\nPG-BAD,Bad,Desc,Nowhere,1.00\n', 'tester'), /Fix the rows/);
  assert.equal(Number((await store.get("SELECT COUNT(*) AS n FROM product WHERE sku = 'PG-OK'")).n), 0);
});
