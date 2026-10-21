import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { applySellerDecision } from '../src/seller-orders.js';
import { TRACKING_HEADER_ALIASES, trackingRows, trackingImport } from '../src/tracking-import.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { sellerFixture } from './helpers/seller-app.js';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';

const header = 'Order number,Carrier,Tracking number,Shipped date\r\n';
const csvOf = (orders, prefix = '00') => header + orders.map((order, i) => `${order.order_no},J&T Express,${prefix}${i},`).join('\r\n');
const commit = (csv, plan) => ({ csv, commit: true, planHash: plan.planHash, expectedRevisions: plan.expectedRevisions });
const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Use a disposable test database.');
async function fixture(t, backend) {
  let store;
  if (backend === 'PostgreSQL') {
    const name = `shopping_test_${randomUUID().replaceAll('-', '')}`, pool = new pg.Pool({ connectionString: base });
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  } else { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  await createCategory(store, { code: 'TEST', label: 'Fictional' });
  const product = await createProduct(store, { sku: 'CSV-ITEM', name: 'Fictional item', description: 'Fictional', category: 'TEST', priceMinor: 100, active: true });
  async function make(count) {
    const orders = [];
    for (let i = 0; i < count; i++) {
      const { receipt } = await createOrder(store, randomUUID(), { buyer: { fullName: 'Fictional Buyer', email: 'fixture@example.invalid' }, whatsappOrderContactOptIn: false,
        deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60123456789' }, address: { line1: 'Fictional Street', postcode: '50000', country: 'MY' }, items: [{ productId: product.id, quantity: 1, expectedPriceMinor: 100, expectedCurrency: 'MYR' }] }] });
      const order = await store.get('SELECT id, order_no FROM shop_order WHERE order_no = ?', receipt.orderNo);
      await applySellerDecision(store, order.id, 'confirm', { expectedRevision: 1 }, 'confirmer'); orders.push(order);
    }
    return orders;
  }
  return { store, make };
}

test('strict CSV syntax, bounds, BOM, CRLF, quoted cells and unsafe identities', () => {
  assert.equal(trackingRows('\uFEFFOrder number,Carrier,Tracking number\r\nOS-00000001,"Carrier, Inc.",001234\r\n')[0].trackingNo, '001234');
  for (const csv of ['Order number,Carrier,Tracking number\na,"b"junk,c', 'Order number,Carrier,Tracking number\na,b"x,c', 'Order number,Carrier,Tracking number\na,b', 'Order number,Carrier,Carrier,Tracking number\na,b,c,d']) assert.throws(() => trackingRows(csv));
  for (const value of ['=SUM(1)', "'=SUM(1)", '1e12', 'a b', 'a\tb']) assert.equal(trackingRows(`Order number,Carrier,Tracking number\na,Carrier,${value}`)[0].errors[0].field, 'trackingNo');
  assert.throws(() => trackingRows('x'.repeat(1_000_001)), (error) => error.status === 413);
  assert.throws(() => trackingRows(header + Array.from({ length: 501 }, () => 'a,b,c,').join('\n')), (error) => error.code === 'TOO_MANY_ROWS');
  assert.throws(() => trackingRows(header + `a,b,${'c'.repeat(4001)},`));
  assert.deepEqual(parseCsv('a,b\n"a\nb","x""y"', { strict: true }), [['a', 'b'], ['a\nb', 'x"y']]);
  for (const dangerous of [' =SUM(1)', '\n=SUM(1)', '\tfoo', '@cmd', '+cmd', '-cmd']) assert.equal(parseCsv(toCsv([[dangerous]]))[0][0], `'${dangerous}`);
});

test('header aliases normalize punctuation, case and spaces without ambiguous mapping', () => {
  const values = { orderNo: 'OS-1', carrier: 'Courier', trackingNo: '00123', shippedDate: '2026-01-01' };
  for (const [field, aliases] of Object.entries(TRACKING_HEADER_ALIASES)) for (const alias of aliases) {
    const fields = Object.keys(values);
    const headers = fields.map((key) => key === field ? ` \uFEFF${alias.toUpperCase().replaceAll(' ', '_')} ` : TRACKING_HEADER_ALIASES[key][0]);
    assert.equal(trackingRows(toCsv([headers, fields.map((key) => values[key])]))[0][field], values[field]);
  }
  for (const csv of ['Order No,Reference,Carrier,AWB\na,a,b,c', 'Order No,Courier,AWB,Tracking\na,b,c,c', 'Order No,AWB\na,c', 'a,b,c']) assert.throws(() => trackingRows(csv));
  for (const carrier of ['Ninja Van', 'J&T Express', 'Pos Laju', 'DHL eCommerce', 'Flash Express', 'SPX Express', 'EasyParcel', 'Lalamove', 'GDex', 'Skynet', 'Best Express', 'Citylink Express', 'Pos Malaysia', 'Unlisted courier']) {
    assert.equal(trackingRows(`Order No,Courier,AWB\nOS-1,${carrier.toLowerCase()},001`)[0].carrier, carrier === 'Unlisted courier' ? carrier.toLowerCase() : carrier);
  }
});

test('replacement-decoded invalid UTF-8 tracking bytes receive a field error', async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode(header + 'OS-1,Courier,ABC'), 0xff, 44]);
  const csv = await new Blob([bytes]).text();
  const row = trackingRows(csv)[0];
  assert.deepEqual(row.errors, [{ field: 'trackingNo', code: 'INVALID', message: 'Use valid UTF-8 text without replacement characters.' }]);
  assert.equal(row.trackingNo, '');
});

for (const backend of ['SQLite', 'PostgreSQL']) {
  test(`${backend}: EasyParcel-style reordered export ignores personal and price columns`, { skip: backend === 'PostgreSQL' && !base }, async (t) => {
    const { store, make } = await fixture(t, backend);
    const [order] = await make(1);
    const headers = ['Receiver Name', 'AWB No', 'Address', 'Postcode', 'Price', 'Courier Name', 'Your Reference', 'Weight', 'Sender', 'Phone', 'Service', 'Dispatch Date'];
    const csv = toCsv([headers, ['Fictional Recipient', '001234', 'Fictional Road', '00000', '12.50', 'gdex', order.order_no, '1', 'Fictional Sender', '000', '=HYPERLINK("unsafe")', '']]);
    const plan = await trackingImport(store, { csv, commit: false }, 'actor');
    assert.deepEqual(plan.sourceHeaders, { trackingNo: 'AWB No', carrier: 'Courier Name', orderNo: 'Your Reference', shippedDate: 'Dispatch Date' });
    assert.deepEqual(plan.ignoredColumns, ['Receiver Name', 'Address', 'Postcode', 'Price', 'Weight', 'Sender', 'Phone', 'Service']);
    assert.equal(plan.summary.errors, 0);
    assert.equal(JSON.stringify(plan).includes('Fictional Recipient'), false);
    assert.deepEqual((await trackingImport(store, commit(csv, plan), 'actor')).applied, { shipped: 1, unchanged: 0 });
    const saved = await store.get('SELECT status, tracking_carrier, tracking_no FROM shop_order WHERE id = ?', order.id);
    assert.deepEqual({ ...saved }, { status: 'SHIPPED', tracking_carrier: 'GDex', tracking_no: '001234' });
  });
  test(`${backend}: 100 and 500 row atomic shipping, replay and unchanged audit`, { skip: backend === 'PostgreSQL' && !base }, async (t) => {
    const { store, make } = await fixture(t, backend);
    for (const count of [100, 500]) {
      const orders = await make(count), csv = csvOf(orders, `00${count}-`);
      const snapshots = await store.all('SELECT * FROM delivery ORDER BY id');
      const plan = await trackingImport(store, { csv, commit: false }, 'actor');
      assert.deepEqual(plan.summary, { ship: count, unchanged: 0, errors: 0 });
      assert.equal((await store.get("SELECT COUNT(*) AS n FROM order_event WHERE status = 'SHIPPED'")).n, count === 100 ? 0 : 100);
      const result = await trackingImport(store, commit(csv, plan), 'csv_actor');
      assert.deepEqual(result.applied, { shipped: count, unchanged: 0 });
      for (const order of orders) {
        const row = await store.get('SELECT status, revision, tracking_no, total_minor FROM shop_order WHERE id = ?', order.id);
        assert.equal(row.status, 'SHIPPED'); assert.equal(row.revision, 3); assert.equal(row.total_minor, 100); assert.match(row.tracking_no, /^00/);
        const event = await store.get("SELECT actor_type, actor_id, previous_status, reason FROM order_event WHERE order_id = ? AND status = 'SHIPPED'", order.id);
        assert.deepEqual({ ...event }, { actor_type: 'SELLER', actor_id: 'csv_actor', previous_status: 'CONFIRMED', reason: 'tracking CSV' });
      }
      assert.deepEqual(await store.all('SELECT * FROM delivery ORDER BY id'), snapshots);
      const before = await store.all('SELECT * FROM order_event ORDER BY id');
      assert.deepEqual((await trackingImport(store, commit(csv, plan), 'retry')).applied, { shipped: 0, unchanged: count });
      await applySellerDecision(store, orders[0].id, 'deliver', { expectedRevision: 3 }, 'deliverer');
      const replay = await trackingImport(store, { csv: '\uFEFF' + csv.replaceAll('\r\n', '\n'), commit: false }, 'actor');
      assert.deepEqual(replay.summary, { ship: 0, unchanged: count, errors: 0 });
      assert.deepEqual((await store.all('SELECT * FROM order_event WHERE id <= ? ORDER BY id', before.at(-1).id)), before);
      assert.equal((await store.get('SELECT COUNT(*) AS n FROM message_outbox')).n, 0);
    }
  });
  test(`${backend}: classifications, dates, stale manifests and all-or-nothing rollback`, { skip: backend === 'PostgreSQL' && !base }, async (t) => {
    const { store, make } = await fixture(t, backend), orders = await make(6);
    const csv = csvOf(orders), plan = await trackingImport(store, { csv, commit: false }, 'actor');
    await assert.rejects(trackingImport(store, { ...commit(csv, plan), csv: csv + '\nunknown,C,999,' }, 'actor'), /Preview this exact file/);
    await assert.rejects(trackingImport(store, { ...commit(csv, plan), expectedRevisions: [] }, 'actor'), /complete preview/);
    await applySellerDecision(store, orders[0].id, 'cancel', { expectedRevision: 2, reason: 'Fictional' }, 'manual');
    await assert.rejects(trackingImport(store, commit(csv, plan), 'actor'), (e) => e.code === 'IMPORT_HAS_ERRORS');
    assert.equal((await store.get("SELECT COUNT(*) AS n FROM shop_order WHERE status = 'SHIPPED'")).n, 0);
    const duplicate = header + `${orders[1].order_no},C,T,\n${orders[1].order_no},C,T,`;
    assert.deepEqual((await trackingImport(store, { csv: duplicate, commit: false }, 'a')).rows.map((r) => r.errors[0].code), ['DUPLICATE_ORDER', 'DUPLICATE_ORDER']);
    const reused = header + `${orders[1].order_no},C,T,\n${orders[2].order_no},C,T,`;
    assert.equal((await trackingImport(store, { csv: reused, commit: false }, 'a')).summary.errors, 2);
    for (const date of ['2026-02-30', '9999-01-01', '2000-01-01']) {
      const answer = await trackingImport(store, { csv: header + `${orders[1].order_no},C,T,${date}`, commit: false }, 'a');
      assert.equal(answer.rows[0].errors[0].code, 'INVALID_DATE');
    }
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const dated = header + `${orders[1].order_no},C,T,${today}`;
    const datePlan = await trackingImport(store, { csv: dated, commit: false }, 'a');
    await trackingImport(store, commit(dated, datePlan), 'a');
    assert.equal((await store.get("SELECT reason FROM order_event WHERE order_id = ? AND status = 'SHIPPED'", orders[1].id)).reason, `tracking CSV; declared shipped date ${today}`);
    const report = await trackingImport(store, { csv: header + ' =BAD,C,000,', commit: false }, 'a');
    assert.ok(!report.reportCsv.includes('buyer')); assert.equal(report.rows[0].errors.some((e) => e.code === 'ORDER_NOT_FOUND'), true);
    const invalid = header + `${orders[2].order_no},C,T,`;
    assert.equal((await trackingImport(store, { csv: invalid, commit: false }, 'a')).rows[0].errors[0].code, 'TRACKING_REUSED');
    await store.run('UPDATE shop_order SET contact_erased_at = ? WHERE id = ?', new Date().toISOString(), orders[3].id);
    assert.equal((await trackingImport(store, { csv: csvOf([orders[3]]), commit: false }, 'a')).rows[0].errors[0].code, 'ORDER_NOT_ELIGIBLE');
    const two = orders.slice(4), pairCsv = csvOf(two, 'fault-'), pairPlan = await trackingImport(store, { csv: pairCsv, commit: false }, 'a');
    let events = 0;
    const broken = new Proxy(store, { get(target, key) {
      if (key === 'run') return async (sql, ...args) => { if (sql.includes('INSERT INTO order_event') && ++events === 2) throw new Error('Injected event failure'); return target.run(sql, ...args); };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
    await assert.rejects(trackingImport(broken, commit(pairCsv, pairPlan), 'a'), /Injected event/);
    for (const order of two) assert.equal((await store.get('SELECT revision FROM shop_order WHERE id = ?', order.id)).revision, 2);
  });
  test(`${backend}: overlapping imports and manual shipping race without duplicate events`, { skip: backend === 'PostgreSQL' && !base }, async (t) => {
    const { store, make } = await fixture(t, backend), orders = await make(1), csv = csvOf(orders), other = csvOf(orders, 'different-');
    const a = await trackingImport(store, { csv, commit: false }, 'a'), b = await trackingImport(store, { csv: other, commit: false }, 'b');
    const outcomes = await Promise.allSettled([
      trackingImport(store, commit(csv, a), 'a'), trackingImport(store, commit(other, b), 'b'),
      applySellerDecision(store, orders[0].id, 'ship', { expectedRevision: 2, carrier: 'Manual', trackingNo: 'manual-1' }, 'manual'),
    ]);
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await store.get("SELECT COUNT(*) AS n FROM order_event WHERE status = 'SHIPPED'")).n, 1);
    assert.equal((await store.get('SELECT revision FROM shop_order')).revision, 3);
  });
  test(`${backend}: unsupported orders and late CAS failure leave every batch row untouched`, { skip: backend === 'PostgreSQL' && !base }, async (t) => {
    const { store, make } = await fixture(t, backend), orders = await make(5);
    for (const status of ['SUBMITTED', 'REJECTED', 'CANCELLED']) {
      await store.run('UPDATE shop_order SET status = ? WHERE id = ?', status, orders[0].id);
      assert.equal((await trackingImport(store, { csv: csvOf([orders[0]]), commit: false }, 'a')).rows[0].errors[0].code, 'INVALID_STATUS');
    }
    await store.run('UPDATE shop_order SET order_no = ? WHERE id = ?', 'DEMO-00000999', orders[0].id);
    assert.equal((await trackingImport(store, { csv: csvOf([{ order_no: 'DEMO-00000999' }]), commit: false }, 'a')).rows[0].errors[0].code, 'ORDER_NOT_ELIGIBLE');
    const delivery = await store.get('SELECT * FROM delivery WHERE order_id = ?', orders[1].id);
    await store.run(`INSERT INTO delivery(id,order_id,position,recipient_name,recipient_phone,address_line1,address_line2,address_city,address_region,address_postcode,address_country)
      VALUES (?,?,1,?,?,?,?,?,?,?,?)`, randomUUID(), orders[1].id, delivery.recipient_name, delivery.recipient_phone, delivery.address_line1, delivery.address_line2, delivery.address_city, delivery.address_region, delivery.address_postcode, delivery.address_country);
    assert.equal((await trackingImport(store, { csv: csvOf([orders[1]]), commit: false }, 'a')).rows[0].errors[0].code, 'MULTI_DESTINATION_UNSUPPORTED');
    const pair = orders.slice(2, 4), csv = csvOf(pair, 'cas-'), plan = await trackingImport(store, { csv, commit: false }, 'a');
    let updates = 0;
    const broken = new Proxy(store, { get(target, key) {
      if (key === 'get') return async (sql, ...args) => sql.startsWith('UPDATE shop_order') && ++updates === 2 ? undefined : target.get(sql, ...args);
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
    await assert.rejects(trackingImport(broken, commit(csv, plan), 'a'), (error) => error.code === 'STALE_REVISION');
    for (const order of pair) assert.equal((await store.get('SELECT revision FROM shop_order WHERE id = ?', order.id)).revision, 2);
    const lastCsv = csvOf([orders[4]], 'stale-'), lastPlan = await trackingImport(store, { csv: lastCsv, commit: false }, 'a');
    await store.run('UPDATE shop_order SET revision = revision + 1 WHERE id = ?', orders[4].id);
    await assert.rejects(trackingImport(store, commit(lastCsv, lastPlan), 'a'), (error) => error.plan.rows[0].errors[0].code === 'STALE_REVISION');
  });
}

test('tracking API checks authentication, Origin, CSRF, fresh roles, body limits and private responses', async (t) => {
  const f = await sellerFixture(); t.after(() => f.close());
  const { headers } = await f.login(), url = '/api/v1/seller/orders/tracking-import', body = { csv: header + 'unknown,C,000,', commit: false };
  for (const [sent, status] of [[{}, 401], [{ cookie: headers.cookie, origin: f.origin }, 403], [{ cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] }, 403], [{ ...headers, origin: 'https://evil.invalid' }, 403]]) assert.equal((await f.request('POST', url, body, sent)).response.status, status);
  for (const role of ['OWNER', 'MANAGER', 'STAFF']) {
    await f.app.database.run('UPDATE seller_account SET role = ?', role);
    const answer = await f.request('POST', url, body, headers); assert.equal(answer.response.status, 200);
    assert.equal(answer.response.headers.get('cache-control'), 'no-store'); assert.equal(answer.response.headers.get('x-content-type-options'), 'nosniff');
  }
  await f.app.database.run('UPDATE seller_account SET active = 0');
  assert.equal((await f.request('POST', url, body, headers)).response.status, 401);
  await f.app.database.run('UPDATE seller_account SET active = 1');
  const fresh = await f.login();
  const api = await createApi({ store: f.app.database, config: f.config });
  const oversized = await api(new Request(f.origin + url, { method: 'POST', headers: { ...fresh.headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, csv: 'x'.repeat(6_100_001) }) }));
  assert.equal(oversized.status, 413);
  const sample = await sellerFixture({ sellerQuickLogin: true }); t.after(() => sample.close());
  assert.equal((await sample.request('POST', url, body, (await sample.login()).headers)).response.status, 403);
});

test('prefixed tracking import resolves only its tenant and refuses another tenant session', async (t) => {
  const alpha = await fixture(t, 'SQLite'), bravo = await fixture(t, 'SQLite');
  const orders = await alpha.make(1), origin = 'https://seller.example.test';
  const tenants = new Map();
  for (const [code, f] of [['alpha', alpha], ['bravo', bravo]]) {
    await ensureAdmin(f.store, 'fixture_owner', 'LocalFixture-Password-2026!');
    tenants.set(code, { status: 'ACTIVE', store: f.store, config: { basePath: '/' + code, sellerOrigin: origin, production: false } });
  }
  const api = await createApi({ registry: { resolve: async (request) => tenants.get(new URL(request.url).pathname.split('/')[1]) } });
  const login = async (code) => {
    const response = await api(new Request(`${origin}/${code}/api/v1/seller/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fixture_owner', password: 'LocalFixture-Password-2026!' }) }));
    assert.equal(response.status, 200);
    return { origin, 'content-type': 'application/json', cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await response.json()).csrfToken };
  };
  const a = await login('alpha'), b = await login('bravo'), body = JSON.stringify({ csv: csvOf(orders), commit: false });
  const call = (code, headers) => api(new Request(`${origin}/${code}/api/v1/seller/orders/tracking-import`, { method: 'POST', headers, body }));
  assert.equal((await call('bravo', a)).status, 401);
  const absent = await call('bravo', b);
  assert.equal((await absent.json()).rows[0].errors[0].code, 'ORDER_NOT_FOUND');
  assert.equal((await (await call('alpha', a)).json()).summary.ship, 1);
  assert.equal((await alpha.store.get('SELECT status FROM shop_order')).status, 'CONFIRMED');
});
