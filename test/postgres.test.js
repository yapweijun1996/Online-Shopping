import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { openDatabase, ready } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { openPostgresStore, postgresSql } from '../src/postgres-store.js';
import { createCategory, getCompanySettings, updateCompanySettings } from '../src/settings.js';
import { createProduct, addGalleryImage, getProduct } from '../src/products.js';
import { createOptionType, createOptionValue, updateOptionValue, listOptionTypes } from '../src/options.js';
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
  // Two buyers race for the last unit: the pending order holds it, so exactly one submission is accepted.
  const race=await Promise.allSettled([createOrder(store,'pg-stock-intent-0001',input(product)),createOrder(store,'pg-stock-intent-0002',input(product))]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.find(r=>r.status==='rejected').reason.code,'OUT_OF_STOCK');
  const rows=await store.all('SELECT id FROM shop_order ORDER BY order_no');
  assert.equal(rows.length,1);
  const results=await Promise.allSettled(rows.map(row=>decideSellerOrder(store,row.id,'confirm',{expectedRevision:1},username)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await store.get('SELECT stock_quantity FROM product')).stock_quantity,0);
  await assert.rejects(store.transaction(async()=>{await store.run('UPDATE product SET stock_quantity=9');throw Error('abort')}),/abort/);
  assert.equal((await store.get('SELECT stock_quantity FROM product')).stock_quantity,0);
  const {SqlLimiter}=await import('../src/limiter.js');const limiter=new SqlLimiter(store,'pg-test',{limit:2,windowMs:10000});
  assert.equal((await Promise.all(Array.from({length:8},()=>limiter.attempt('synthetic-key')))).filter(Boolean).length,2);
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

// Real PostgreSQL fixtures, independent from the historical synchronous SQL mock suite.
for (const version of [10, 11, 12, 13, 14, 15, 16]) test(`PostgreSQL physical schema${version} upgrades explicitly to23, preserves bytes and supports gallery writes`, {skip:!base}, async t => {
  const url = await database(t), store = openPostgresStore(url);
  t.shoppingClosers.push(() => store.close());
  const {postgresSchema12Sql} = await import('../deploy/postgres/schema12.js');
  let sql = version === 13 ? readFileSync(new URL('./fixtures/postgres-schema13.sql',import.meta.url),'utf8') : postgresSchema12Sql;
  if (version < 12) sql = readFileSync(new URL('./fixtures/postgres-schema10.sql',import.meta.url),'utf8');
  if (version === 11) sql = sql.replace('position BETWEEN 1 AND 4', 'position BETWEEN 1 AND 9');
  await store.exec(sql); await store.setSchemaVersion(version);
  const now = new Date().toISOString(), bytes = readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
  await store.run("INSERT INTO general_code VALUES ('PRODUCT_CATEGORY','SYNTHETIC','Synthetic',1,?,?)",now,now);
  await store.run(`INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,image_mime,image_data,created_at,updated_at)
    VALUES ('synthetic-preserved','SYNTHETIC','Synthetic item','Fixture','SYNTHETIC',1200,'MYR',1,'image/png',?,?,?)`,bytes,now,now);
  await assert.rejects(openPostgresDatabase(url), /Unsupported database schema version/);
  const {upgradePostgres} = await import('../src/postgres/upgrade.js');
  const original = await store.get('SELECT * FROM product');
  await assert.rejects(store.transaction(() => upgradePostgres({...store,exec:async sql=>{
    await store.exec(sql); if (sql.includes('tracking_carrier')) throw Error('synthetic interruption');
  }},version)), /synthetic interruption/);
  assert.equal(await store.schemaVersion(),version);
  assert.deepEqual(await store.get('SELECT * FROM product'),original);
  const upgraded = await openPostgresDatabase(url,{allowUpgrade:true}); t.shoppingClosers.push(()=>upgraded.close());
  assert.equal(await upgraded.schemaVersion(),23);
  assert.deepEqual((await upgraded.get('SELECT image_data FROM product')).image_data,bytes);
  const {getProduct,updateProduct} = await import('../src/products.js');
  const before = await getProduct(upgraded,'synthetic-preserved',true);
  const edited = await updateProduct(upgraded,before.id,{gallery:[{id:'main'},{imageDataUrl:'data:image/png;base64,'+Buffer.concat([bytes,Buffer.from('distinct')]).toString('base64')}],expectedUpdatedAt:before.updatedAt});
  assert.equal(edited.images.length,2);
  assert.equal(edited.stockQuantity,null);
  await assert.rejects(updateProduct(upgraded,before.id,{gallery:[],expectedUpdatedAt:before.updatedAt}),error=>error.code==='PRODUCT_CHANGED');
  const restarted = await openPostgresDatabase(url);t.shoppingClosers.push(()=>restarted.close());
  assert.deepEqual((await getProduct(restarted,before.id,true)).galleryItems,edited.galleryItems);
});

test('PostgreSQL stores, trims and clears the storefront texts', {skip:!base}, async t => {
  const store = await openPostgresDatabase(await database(t)); t.shoppingClosers.push(()=>store.close());
  assert.equal((await getCompanySettings(store)).availabilityText, null);
  const saved = await updateCompanySettings(store, { availabilityText: '  Ships in 2 days  ', shippingText: 'Flat RM 8', returnsText: '' });
  assert.deepEqual([saved.availabilityText, saved.shippingText, saved.returnsText], ['Ships in 2 days', 'Flat RM 8', null]);
  await assert.rejects(() => updateCompanySettings(store, { returnsText: 'x'.repeat(1001) }), /at most 1000/);
  assert.equal((await updateCompanySettings(store, { shippingText: null })).shippingText, null);
});

test('PostgreSQL product options: tenant-defined types, combinations, derived labels and case-insensitive uniqueness', {skip:!base}, async t => {
  const store = await openPostgresDatabase(await database(t)); t.shoppingClosers.push(()=>store.close());
  await createCategory(store, { code: 'PHONE', label: 'Phones' });
  const color = await createOptionType(store, { name: 'Colour', display: 'swatch', translations: { 'zh-Hans': '颜色' } });
  const storage = await createOptionType(store, { name: 'Storage' });
  await assert.rejects(() => createOptionType(store, { name: 'colour' }), /already exists/);
  const red = await createOptionValue(store, color.id, { label: 'Red', swatchColor: '#FF0000' });
  const s256 = await createOptionValue(store, storage.id, { label: '256GB' });
  const s512 = await createOptionValue(store, storage.id, { label: '512GB' });
  await assert.rejects(() => createOptionValue(store, color.id, { label: 'RED' }), /already exists/);
  const product = overrides => ({ name: 'Phone', description: 'd', category: 'PHONE', priceMinor: 1000, currency: 'MYR', active: true, variantGroup: 'ph', ...overrides });
  const a = await createProduct(store, product({ sku: 'PG-1', options: [{ typeId: color.id, valueId: red.id }, { typeId: storage.id, valueId: s256.id }] }));
  assert.equal(a.variantLabel, 'Red / 256GB');
  await createProduct(store, product({ sku: 'PG-2', options: [{ typeId: color.id, valueId: red.id }, { typeId: storage.id, valueId: s512.id }] }));
  await assert.rejects(() => createProduct(store, product({ sku: 'PG-3', options: [{ typeId: color.id, valueId: red.id }, { typeId: storage.id, valueId: s512.id }] })), /already exists/);
  await updateOptionValue(store, color.id, red.id, { label: 'Wine' });
  const detail = await getProduct(store, a.id);
  assert.deepEqual(detail.variants.map(variant => variant.label).sort(), ['Wine / 256GB', 'Wine / 512GB']);
  assert.deepEqual(detail.optionTypes.map(axis => axis.name), ['Colour', 'Storage']);
  assert.equal((await listOptionTypes(store))[0].translations['zh-Hans'], '颜色');
});

test('PostgreSQL many buyers ordering at once get unique, gap-free order numbers; a failed submission burns no number', {skip:!base}, async t => {
  const store = await openPostgresDatabase(await database(t)); t.shoppingClosers.push(()=>store.close());
  const product = await seed(store);
  await store.run('UPDATE product SET stock_quantity = NULL WHERE id = ?', product.id);
  const submissions = Array.from({ length: 60 }, (_, index) => createOrder(store, `pg-concurrent-intent-${String(index).padStart(4, '0')}`, input(product)));
  // A rejected submission interleaved with the rest must roll back its number.
  const stale = createOrder(store, 'pg-concurrent-stale-0001', input({ ...product, priceMinor: product.priceMinor + 1 })).catch(error => error);
  const receipts = (await Promise.all(submissions)).map(result => result.receipt.orderNo);
  assert.equal((await stale).code, 'PRICE_CHANGED');
  assert.equal(new Set(receipts).size, 60, 'no duplicate order numbers');
  assert.deepEqual([...receipts].sort(), Array.from({ length: 60 }, (_, index) => `OS-${String(index + 1).padStart(8, '0')}`), 'numbers are contiguous');
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM shop_order')).n, 60);
});

test('PostgreSQL stock holds: 20 buyers racing for 5 units get exactly 5 orders and stock never goes negative', {skip:!base}, async t => {
  const store = await openPostgresDatabase(await database(t)); t.shoppingClosers.push(()=>store.close());
  const product = await seed(store);
  await store.run('UPDATE product SET stock_quantity = 5 WHERE id = ?', product.id);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => createOrder(store, `pg-hold-intent-${String(index).padStart(4, '0')}`, input(product))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'OUT_OF_STOCK'));
  const ids = (await store.all('SELECT id FROM shop_order ORDER BY order_no')).map(row => row.id);
  const confirmed = await Promise.allSettled(ids.map(id => decideSellerOrder(store, id, 'confirm', { expectedRevision: 1 }, username)));
  assert.equal(confirmed.filter(r => r.status === 'fulfilled').length, 5, 'every held order can be confirmed');
  assert.equal((await store.get('SELECT stock_quantity FROM product')).stock_quantity, 0);
});

test('PostgreSQL public list collapses variant groups to one card with the group size and price spread', {skip:!base}, async t => {
  const store = await openPostgresDatabase(await database(t)); t.shoppingClosers.push(()=>store.close());
  const {listProducts} = await import('../src/products.js');
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  const make = (sku, price, extra = {}) => createProduct(store, { sku, name: 'Tee', description: 'x', category: 'WEAR', priceMinor: price, currency: 'MYR', active: true, ...extra });
  await make('TEE-S', 1200, { variantGroup: 'TEE', variantLabel: 'S', stockQuantity: 0 });
  await make('TEE-M', 1400, { variantGroup: 'TEE', variantLabel: 'M' });
  await make('TEE-L', 1600, { variantGroup: 'TEE', variantLabel: 'L' });
  await make('MUG', 900);
  const shop = (await listProducts(store, new URLSearchParams(''), false)).items;
  assert.deepEqual(shop.map(p => p.sku).sort(), ['MUG', 'TEE-M']);
  const tee = shop.find(p => p.sku === 'TEE-M');
  assert.deepEqual([tee.variantCount, tee.priceVaries, tee.priceMinor], [3, true, 1400]);
  assert.deepEqual((await listProducts(store, new URLSearchParams('search=TEE-L'), false)).items.map(p => p.sku), ['TEE-L']);
  const sellerRows = (await listProducts(store, new URLSearchParams(''), true)).items;
  assert.equal(sellerRows.length, 2, 'the seller list has one row per listing');
  const teeRow = sellerRows.find(p => p.variantGroup === 'TEE');
  assert.deepEqual([teeRow.variantCount, teeRow.activeCount, teeRow.priceFromMinor, teeRow.priceToMinor, teeRow.stockTotal], [3, 3, 1200, 1600, null]);
});

test('PostgreSQL schema 17 upgrades into listings, keeping every product id and order line', {skip:!base}, async t => {
  const url = await database(t);
  const store = await openPostgresDatabase(url); t.shoppingClosers.push(()=>store.close());
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  const make = (sku, extra = {}) => createProduct(store, { sku, name: 'Tee', description: 'Soft', category: 'WEAR', priceMinor: 1200, currency: 'MYR', active: true, stockQuantity: 5, ...extra });
  const tee = await make('TEE', { variantGroup: 'TEE', variantLabel: 'S' });
  const teeM = await make('TEE-M', { variantGroup: 'TEE', variantLabel: 'M' });
  const mug = await make('MUG', { name: 'Mug' });
  const order = await createOrder(store, 'pg-listing-intent-0001', input(teeM));
  const before = await store.all('SELECT id, sku, name, price_minor, stock_quantity FROM product ORDER BY id');
  // Put the database back into its schema 17 shape.
  await store.exec('ALTER TABLE product ALTER COLUMN listing_id DROP NOT NULL; UPDATE product SET listing_id = NULL; DELETE FROM listing');
  await store.setSchemaVersion(17);
  const upgraded = await openPostgresDatabase(url, { allowUpgrade: true }); t.shoppingClosers.push(()=>upgraded.close());
  assert.equal(await upgraded.schemaVersion(), 23);
  assert.deepEqual(await upgraded.all('SELECT id, sku, name, price_minor, stock_quantity FROM product ORDER BY id'), before);
  assert.equal((await upgraded.get('SELECT COUNT(*)::int AS n FROM listing')).n, 2);
  assert.equal((await getProduct(upgraded, tee.id, true)).listingId, (await getProduct(upgraded, teeM.id, true)).listingId);
  assert.notEqual((await getProduct(upgraded, mug.id, true)).listingId, (await getProduct(upgraded, tee.id, true)).listingId);
  await assert.rejects(upgraded.run("UPDATE product SET listing_id = NULL WHERE id = ?", mug.id), /null value|not-null/i);
  assert.ok(order);
  assert.equal((await upgraded.get('SELECT COUNT(*)::int AS n FROM order_item WHERE product_id = ?', teeM.id)).n, 1);
});

test('PostgreSQL schema 18 upgrades to one shared gallery per listing and drops the per-colour copies', {skip:!base}, async t => {
  const url = await database(t);
  const store = await openPostgresDatabase(url); t.shoppingClosers.push(()=>store.close());
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  const png = readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
  const photo = label => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(label)]).toString('base64');
  const make = (sku, label) => createProduct(store, { sku, name: 'Tee', description: 'Soft', category: 'WEAR', priceMinor: 1200, currency: 'MYR', active: true, imageDataUrl: photo(label), variantGroup: 'TEE', variantLabel: sku });
  const white = await make('TEE-WHITE', 'white'), black = await make('TEE-BLACK', 'black');
  const extra = Buffer.concat([png, Buffer.from('extra')]);
  await store.run('DELETE FROM product_gallery_image');
  for (const [index, product] of [white, black].entries()) {
    await store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at) VALUES (?, ?, 1, ?, ?, ?)', `copy-${index}`, product.id, 'image/png', extra, new Date().toISOString());
    await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(['main', `copy-${index}`]), product.id);
  }
  // The real schema 18 has no preview columns; the gallery step of the upgrade must still copy photos.
  await store.exec('ALTER TABLE product DROP COLUMN thumb_mime; ALTER TABLE product DROP COLUMN thumb_data; ALTER TABLE product_gallery_image DROP COLUMN thumb_mime; ALTER TABLE product_gallery_image DROP COLUMN thumb_data');
  await store.setSchemaVersion(18);
  const upgraded = await openPostgresDatabase(url, { allowUpgrade: true }); t.shoppingClosers.push(()=>upgraded.close());
  assert.equal(await upgraded.schemaVersion(), 23);
  assert.equal((await upgraded.get('SELECT COUNT(*)::int AS n FROM product_gallery_image WHERE product_id = ?', black.id)).n, 0);
  assert.equal((await upgraded.get('SELECT gallery_layout_json FROM product WHERE id = ?', black.id)).gallery_layout_json, null);
  const shown = await getProduct(upgraded, black.id, true), holder = await getProduct(upgraded, white.id, true);
  assert.equal(shown.galleryItems[0].id, 'main');
  assert.deepEqual(shown.galleryItems.filter(item => item.shared).map(item => item.id), holder.galleryItems.filter(item => item.shared).map(item => item.id));
  assert.equal(holder.galleryItems.filter(item => item.shared).length, 2);
});

test('PostgreSQL stores image previews, serves them on request and upgrades from schema 19', {skip:!base}, async t => {
  const url = await database(t);
  const store = await openPostgresDatabase(url); t.shoppingClosers.push(()=>store.close());
  const { getProductImage, getGalleryImage, setProductThumbnail } = await import('../src/products.js');
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  const png = readFileSync(new URL('../public/shop/icons/icon-192.png',import.meta.url));
  const data = label => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(label)]).toString('base64');
  const made = await createProduct(store, { sku: 'THUMB-1', name: 'Thumb', description: 'x', category: 'WEAR', priceMinor: 1200, currency: 'MYR', active: true, imageDataUrl: data('full'), thumbDataUrl: data('small') });
  assert.deepEqual(Buffer.from((await getProductImage(store, made.id, true, true)).data), Buffer.concat([png, Buffer.from('small')]));
  assert.deepEqual(Buffer.from((await getProductImage(store, made.id, true, false)).data), Buffer.concat([png, Buffer.from('full')]));
  const added = await addGalleryImage(store, made.id, data('gallery'), 'manual', data('gallery-small'));
  const galleryId = added.galleryItems.find(item => item.id !== 'main').id;
  assert.deepEqual(Buffer.from((await getGalleryImage(store, made.id, galleryId, true, true)).data), Buffer.concat([png, Buffer.from('gallery-small')]));
  // The schema 19 shape: no preview columns yet; the upgrade adds them and keeps the images.
  await store.exec('ALTER TABLE product DROP COLUMN thumb_mime; ALTER TABLE product DROP COLUMN thumb_data; ALTER TABLE product_gallery_image DROP COLUMN thumb_mime; ALTER TABLE product_gallery_image DROP COLUMN thumb_data');
  await store.setSchemaVersion(19);
  const upgraded = await openPostgresDatabase(url, { allowUpgrade: true }); t.shoppingClosers.push(()=>upgraded.close());
  assert.equal(await upgraded.schemaVersion(), 23);
  assert.deepEqual(Buffer.from((await getProductImage(upgraded, made.id, true, true)).data), Buffer.concat([png, Buffer.from('full')]), 'no preview yet: the full image answers');
  await setProductThumbnail(upgraded, made.id, data('late'));
  assert.deepEqual(Buffer.from((await getProductImage(upgraded, made.id, true, true)).data), Buffer.concat([png, Buffer.from('late')]));
});
