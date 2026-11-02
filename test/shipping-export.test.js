import { unzip, assertBalanced } from './helpers/xlsx.js';
import { migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { toXlsx } from '../src/xlsx.js';
import '../public/seller/sender-copy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createCategory, updateCompanySettings } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { applySellerDecision } from '../src/seller-orders.js';
import { exportShippingList } from '../src/order-shipping-export.js';
import { parseCsv as parseFullCsv } from '../src/csv.js';
// Existing receiver assertions deliberately address the receiver block.
const parseCsv = csv => parseFullCsv(csv).map(row => row.slice(8));
import { sellerFixture } from './helpers/seller-app.js';
import { messages, languages } from '../public/shared/i18n.js';
import '../public/seller/tracking-copy.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Use a disposable test database.');
for (const backend of ['SQLite', 'PostgreSQL']) test(`${backend}: shipping parcels, filters, erasure, formulas and cap`, { skip: backend === 'PostgreSQL' && !base }, async (t) => {
  let db;
  if (backend === 'PostgreSQL') {
    const pool = new pg.Pool({ connectionString: base }), name = `shipping_test_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    db = await openPostgresDatabase(url.href);
    t.after(async () => { await db.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  } else { db = await openDatabase(':memory:'); t.after(() => db.close()); }
  for (const column of ['sender_name', 'sender_phone', 'sender_address_line1', 'sender_address_line2', 'sender_city', 'sender_state', 'sender_postcode', 'sender_country']) await db.exec(`ALTER TABLE company_setting DROP COLUMN ${column}`);
  await db.setSchemaVersion(25);
  if (backend === 'SQLite') await migrateStore(db);
  else await db.transaction(() => upgradePostgres(db, 25));
  assert.equal(await db.schemaVersion(), SCHEMA_VERSION);
  await createCategory(db, { code: 'TEST', label: 'Fictional' });
  const product = await createProduct(db, { sku: 'PARCEL', name: 'Fictional item', description: 'Fictional', category: 'TEST', priceMinor: 1250, active: true });
  async function make(count, confirmed = true) {
    const { receipt } = await createOrder(db, randomUUID(), { buyer: { fullName: 'Fictional Buyer', email: 'fixture@example.invalid' }, whatsappOrderContactOptIn: false,
      deliveries: Array.from({ length: count }, (_, i) => ({ recipient: { fullName: `Recipient ${i}`, phone: '+60123456789' }, address: { line1: 'Fictional Street', line2: 'Unit 1', city: 'City', region: 'State', postcode: '01234', country: 'MY' }, items: [{ productId: product.id, quantity: i + 1, expectedPriceMinor: 1250, expectedCurrency: 'MYR' }] })) });
    const row = await db.get('SELECT id, order_no FROM shop_order WHERE order_no = ?', receipt.orderNo);
    if (confirmed) await applySellerDecision(db, row.id, 'confirm', { expectedRevision: 1 }, 'fixture');
    return row;
  }
  const first = await make(2), second = await make(1), pending = await make(1, false);
  await updateCompanySettings(db, { senderName: 'Fictional Sender', senderPhone: '+60123456789', senderPostcode: '01000', senderCountry: 'MY' });
  const full = parseFullCsv((await exportShippingList(db, new URLSearchParams())).csv);
  assert.deepEqual(full[1].slice(0, 8), ['Fictional Sender', "'+60123456789", '', '', '', '', '01000', 'MY']);
  for (const patch of [{ senderPhone: 'bad' }, { senderName: 'x'.repeat(121) }, { senderCountry: 'Malaysia' }]) {
    await assert.rejects(updateCompanySettings(db, patch), error => error.field === Object.keys(patch)[0]);
  }
  assert.equal((await updateCompanySettings(db, { senderAddressLine2: '' })).senderAddressLine2, null);
  await db.run('UPDATE order_item SET name_snapshot = ?', '=1+1');
  const book = unzip((await exportShippingList(db, new URLSearchParams(), 'xlsx')).xlsx);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) { assert.ok(book[part]); assertBalanced(book[part]); }
  const sheet = book['xl/worksheets/sheet1.xml'];
  for (const cell of sheet.matchAll(/<c\b[^>]*>/g)) assert.match(cell[0], /t="inlineStr"/);
  for (const value of ['+60123456789', '01000', '1 x =1+1', 'Fictional Sender']) assert.ok(sheet.includes(value));
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/);
  assert.match(book['xl/styles.xml'], /<font><b\/>/);
  assert.ok(sheet.indexOf('<sheetViews>') < sheet.indexOf('<cols>'));
  await db.run('UPDATE order_item SET name_snapshot = ?', 'Fictional item');
  const before = await db.all('SELECT * FROM order_event ORDER BY id');
  let result = await exportShippingList(db, new URLSearchParams());
  const rows = parseCsv(result.csv);
  assert.equal(rows.length, 4); assert.equal(rows[0].length, 18);
  const pair = rows.slice(1).filter((row) => row[0] === first.order_no);
  assert.deepEqual(pair.map((row) => row[1]), ['1/2', '2/2']);
  assert.deepEqual(pair.map((row) => row[10]), ['1 x Fictional item', '2 x Fictional item']);
  assert.deepEqual(pair.map((row) => row[11]), ['1', '2']);
  assert.deepEqual(pair.map((row) => row[12]), ['37.50', '37.50']);
  assert.equal(pair[0][3], "'+60123456789"); assert.equal(pair[0][8], '01234'); assert.equal(pair[0][15], '');
  assert.ok(result.csv.startsWith('\uFEFF')); assert.ok(result.csv.endsWith('\r\n'));
  assert.deepEqual(await db.all('SELECT * FROM order_event ORDER BY id'), before);
  assert.equal((await db.get('SELECT status FROM shop_order WHERE id = ?', first.id)).status, 'CONFIRMED');
  assert.equal(parseCsv((await exportShippingList(db, new URLSearchParams({ status: 'SUBMITTED' }))).csv)[1][0], pending.order_no);
  assert.equal(parseCsv((await exportShippingList(db, new URLSearchParams({ search: second.order_no, currency: 'MYR', minTotal: '1000', maxTotal: '2000' }))).csv).length, 2);
  await db.run('UPDATE shop_order SET submitted_at = ? WHERE id = ?', '2026-01-01T00:00:00.000Z', second.id);
  const dated = parseCsv((await exportShippingList(db, new URLSearchParams({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', limit: '1', offset: '100' }))).csv);
  assert.deepEqual(dated.slice(1).map((row) => row[0]), [second.order_no]);
  assert.equal(parseCsv((await exportShippingList(db, new URLSearchParams())).csv)[1][0], second.order_no);
  assert.equal(parseCsv((await exportShippingList(db, new URLSearchParams({ currency: 'SGD' }))).csv).length, 1);
  assert.equal(parseCsv((await exportShippingList(db, new URLSearchParams({ status: 'SUBMITTED,CONFIRMED' }))).csv).length, 5);
  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    await db.run('UPDATE delivery SET recipient_name = ?, address_line1 = ? WHERE order_id = ?', prefix + 'name', prefix + 'address', first.id);
    const safe = parseCsv((await exportShippingList(db, new URLSearchParams({ search: first.order_no }))).csv)[1];
    assert.equal(safe[2], "'" + prefix + 'name'); assert.equal(safe[4], "'" + prefix + 'address');
  }
  await db.run('UPDATE order_item SET name_snapshot = ? WHERE delivery_id IN (SELECT id FROM delivery WHERE order_id = ?)', '😀'.repeat(210), first.id);
  const long = parseCsv((await exportShippingList(db, new URLSearchParams({ search: first.order_no }))).csv)[1];
  assert.equal(Array.from(long[10]).length, 200); assert.equal(Array.from(long[16]).length, 60); assert.ok(!long[10].includes('\uFFFD'));
  await db.run('UPDATE shop_order SET contact_erased_at = ? WHERE id = ?', new Date().toISOString(), first.id);
  result = await exportShippingList(db, new URLSearchParams());
  assert.equal(result.skipped, 2); assert.equal(parseCsv(result.csv).length, 2);
  // Duplicate fictional parcel snapshots to exercise the parcel, rather than order, boundary.
  const parcel = await db.get('SELECT * FROM delivery WHERE order_id = ?', second.id);
  for (let i = 1; i < 500; i++) await db.run(`INSERT INTO delivery (id, order_id, position, recipient_name, recipient_phone, address_line1, address_line2, address_city, address_region, address_postcode, address_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), second.id, i, parcel.recipient_name, parcel.recipient_phone, parcel.address_line1, parcel.address_line2, parcel.address_city, parcel.address_region, parcel.address_postcode, parcel.address_country);
  assert.equal(parseCsv((await exportShippingList(db, new URLSearchParams())).csv).length, 501);
  await db.run(`INSERT INTO delivery (id, order_id, position, recipient_name, recipient_phone, address_line1, address_postcode, address_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), second.id, 500, 'Fictional', '+60123456789', 'Street', '01234', 'MY');
  await assert.rejects(exportShippingList(db, new URLSearchParams()), (error) => error.status === 413 && error.code === 'TOO_MANY_ROWS');
  await assert.rejects(exportShippingList(db, new URLSearchParams(), 'xlsx'), error => error.status === 413);
});

test('HTTP shipping download requires a session, permits fulfilment roles and refuses sample sites', async (t) => {
  const f = await sellerFixture(); t.after(() => f.close());
  const path = '/api/v1/seller/orders/shipping-list.csv';
  assert.equal((await f.request('GET', path)).response.status, 401);
  const login = await f.login();
  const submitted = await f.submit();
  const order = await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', submitted.data.orderNo);
  await applySellerDecision(f.app.database, order.id, 'confirm', { expectedRevision: 1 }, 'fixture');
  for (const role of ['OWNER', 'MANAGER', 'STAFF']) {
    await f.app.database.run('UPDATE seller_account SET role = ? WHERE username = ?', role, f.config.username);
    const { response, data } = await f.request('GET', path, undefined, { cookie: login.cookie });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-skipped-erased'), '0');
    assert.match(response.headers.get('content-disposition'), /shipping-list-\d{4}-\d{2}-\d{2}\.csv/);
    assert.equal(parseCsv(data).length, 2);
  }
  await f.app.database.run('UPDATE shop_order SET contact_erased_at = ?', new Date().toISOString());
  assert.equal((await f.request('GET', path, undefined, { cookie: login.cookie })).response.headers.get('x-skipped-erased'), '1');
  const sample = await sellerFixture({ sellerQuickLogin: true }); t.after(() => sample.close());
  const sampleLogin = await sample.login();
  assert.equal((await sample.request('GET', path, undefined, { cookie: sampleLogin.cookie })).response.status, 403);
});

test('shipping export copy has seven-locale parity', () => {
  for (const locale of languages) for (const key of ['shippingExport', 'shippingExcel', 'shippingCsv', 'senderHint', 'senderTitle', 'senderName', 'senderPhone', 'senderAddressLine1', 'senderAddressLine2', 'senderCity', 'senderState', 'senderPostcode', 'senderCountry', 'shippingHelp', 'shippingTooMany', 'shippingForbidden']) assert.equal(typeof messages[locale.code || locale][key], 'string');
});

test('XLSX HTTP authorization and attachment parity', async t => {
  const f = await sellerFixture(); t.after(() => f.close());
  const path = '/api/v1/seller/orders/shipping-list.xlsx';
  assert.equal((await f.request('GET', path)).response.status, 401);
  const login = await f.login();
  for (const role of ['OWNER', 'MANAGER', 'STAFF']) {
    await f.app.database.run('UPDATE seller_account SET role = ? WHERE username = ?', role, f.config.username);
    const { response } = await f.request('GET', path, undefined, { cookie: login.cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-disposition'), /\.xlsx"/);
  }
  const sample = await sellerFixture({ sellerQuickLogin: true }); t.after(() => sample.close());
  const session = await sample.login();
  assert.equal((await sample.request('GET', path, undefined, { cookie: session.cookie })).response.status, 403);
});

test('workbook XML escapes user text and removes illegal controls without changing literals', () => {
  const sheet = unzip(toXlsx([['Header'], ['<x>&"' + String.fromCharCode(1, 0xD800, 9, 10) + '😀'], ['=HYPERLINK("test")'], ['0123456789']]))['xl/worksheets/sheet1.xml'];
  assertBalanced(sheet);
  assert.ok(sheet.includes('&lt;x&gt;&amp;&quot;' + String.fromCharCode(9, 10) + '😀'));
  assert.ok(!sheet.includes('\u0001'));
  assert.ok(sheet.includes('=HYPERLINK(&quot;test&quot;)'));
  assert.ok(sheet.includes('0123456789'));
  assert.ok(!sheet.includes('<f>'));
});
