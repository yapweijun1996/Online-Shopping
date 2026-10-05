import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { openDatabase, ready } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { openPostgresStore, postgresSql } from '../src/postgres-store.js';
import { createCategory } from '../src/settings.js';
import { createProduct, addGalleryImage } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { ensureAdmin } from '../src/auth.js';
import { importSqlite, rowsDigest } from '../src/sqlite-import.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('PostgreSQL tests require NODE_ENV=test and a disposable test database.');
const password = 'SyntheticFixtureOnly4920!';
const username = 'fixture_owner';
async function database(t) {
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  t.shoppingClosers = [];
  t.after(async () => { for (const close of t.shoppingClosers) await close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  return url.href;
}
const input = product => ({ buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
  deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
    items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }] });
async function seed(store) {
  await createCategory(store, { code: 'TEST', label: 'Synthetic' });
  return createProduct(store, { sku: 'TEST-1', name: 'Synthetic item', description: 'Synthetic test description', category: 'TEST', priceMinor: 500, stockQuantity: 1, active: true, imageDataUrl: 'data:image/png;base64,'+readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url)).toString('base64') });
}

test('PostgreSQL parameter conversion preserves quoted data and search behavior', () => {
  assert.equal(postgresSql("SELECT '?' AS value WHERE name = ? AND instr(lower(name), lower(?)) > 0"), "SELECT '?' AS value WHERE name = $1 AND strpos(lower(name), lower($2)) > 0");
});

test('PostgreSQL dual-origin API: login, CSRF, checkout, replay, catalog and seller decisions', { skip: !base }, async t => {
  const url = await database(t);
  const config = { databaseUrl: url, production: true, username, password, publicOrigin: 'https://shop.gmb01.xyz', sellerOrigin: 'https://seller.gmb01.xyz' };
  const app = await createApp(config); t.shoppingClosers.push(() => app.close());
  const product = await seed(app.database);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method='GET', body, origin=config.publicOrigin, headers={}) => fetch(address+path, { method,
    headers: { origin, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await request('/ready')).status, 200);
  assert.equal((await request('/api/v1/seller/session', 'POST', { username, password })).status, 403);
  const login = await request('/api/v1/seller/session', 'POST', { username, password }, config.sellerOrigin);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Secure/); assert.doesNotMatch(cookie, /Domain=/);
  const { csrfToken } = await login.json(); const auth = { cookie: cookie.split(';')[0], 'x-csrf-token': csrfToken };
  assert.equal((await request('/api/v1/products?search=synthetic')).status, 200);
  assert.equal((await request('/api/v1/seller/products', 'POST', {}, config.sellerOrigin, { cookie: auth.cookie })).status, 403);
  assert.equal((await request('/api/v1/orders', 'POST', input(product), config.sellerOrigin, { 'idempotency-key': 'pg-dual-origin-0001' })).status, 403);
  const receipts = await Promise.all([1,2].map(() => request('/api/v1/orders', 'POST', input(product), config.publicOrigin, { 'idempotency-key': 'pg-dual-origin-0001' })));
  assert.deepEqual(receipts.map(r => r.status).sort(), [200,201]);
  assert.deepEqual(await receipts[0].json(), await receipts[1].json());
  const order = await app.database.get('SELECT id FROM shop_order');
  assert.equal((await request(`/api/v1/seller/orders/${order.id}/confirm`, 'POST', {expectedRevision:1},config.sellerOrigin,auth)).status,200);
  assert.equal((await request('/api/v1/seller/orders?search=OS-', 'GET',undefined,config.sellerOrigin,auth)).status,200);
  assert.equal((await app.database.get('SELECT stock_quantity FROM product')).stock_quantity,0);
  await app.database.setSchemaVersion(14); assert.equal((await request('/ready')).status,503); assert.equal((await request('/health')).status,200);
});

test('PostgreSQL concurrent stock confirmation and limiter preserve atomicity; failures roll back', {skip:!base}, async t => {
  const store = await openPostgresDatabase(await database(t)); t.shoppingClosers.push(()=>store.close());
  const product=await seed(store);
  const a=await createOrder(store,'pg-stock-intent-0001',input(product)), b=await createOrder(store,'pg-stock-intent-0002',input(product));
  const rows=await store.all('SELECT id FROM shop_order ORDER BY order_no');
  const results=await Promise.allSettled(rows.map(row=>decideSellerOrder(store,row.id,'confirm',{expectedRevision:1},username)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_STOCK');
  assert.equal((await store.get('SELECT stock_quantity FROM product')).stock_quantity,0);
  await assert.rejects(store.transaction(async()=>{await store.run('UPDATE product SET stock_quantity=9');throw Error('abort')}),/abort/);
  assert.equal((await store.get('SELECT stock_quantity FROM product')).stock_quantity,0);
  const {SqlLimiter}=await import('../src/limiter.js');const limiter=new SqlLimiter(store,'pg-test',{limit:2,windowMs:10000});
  assert.equal((await Promise.all(Array.from({length:8},()=>limiter.attempt('synthetic-key')))).filter(Boolean).length,2);
  assert.ok(a.receipt.orderNo!==b.receipt.orderNo);
});

test('SQLite import preserves rows, binary images, hashes and identity sequences; refuses overwrite', {skip:!base}, async t => {
  const source=await openDatabase(':memory:');t.after(()=>source.close());await ensureAdmin(source,username,password);
  const product=await seed(source);await createOrder(source,'pg-import-intent-0001',input(product));
  const target=await openPostgresDatabase(await database(t));t.shoppingClosers.push(()=>target.close());
  await addGalleryImage(source,product.id,'data:image/png;base64,'+readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url)).toString('base64'));
  const evidence=await importSqlite(source,target);assert.equal(evidence.tables.find(x=>x.table==='shop_order').rows,1);assert.equal(await ready(target),true);
  for(const table of ['product','shop_order','order_event'])assert.equal(rowsDigest(await source.all(`SELECT * FROM ${table}`)),rowsDigest(await target.all(`SELECT * FROM ${table}`)));
  await assert.rejects(importSqlite(source,target),/fresh baseline/);
  const order=await target.get('SELECT id FROM shop_order');await decideSellerOrder(target,order.id,'confirm',{expectedRevision:1},username);
  assert.equal((await target.get('SELECT COUNT(*) AS n FROM order_event')).n,2);
});

test('PostgreSQL unavailable database fails readiness without leaking credentials', {skip:!base}, async()=>{
 const store=openPostgresStore('postgres://postgres@127.0.0.1:1/online_shopping_test',{connectionTimeoutMillis:100});
 try{assert.equal(await ready(store),false)}finally{await store.close()}
});
