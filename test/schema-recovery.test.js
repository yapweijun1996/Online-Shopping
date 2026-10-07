import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { openNodeStore } from '../src/store.js';
import { setupShop } from '../src/shop-setup.js';
import { listProducts, addGalleryImage } from '../src/products.js';
import { createOrder } from '../src/orders.js';

const snapshot = async store => Object.fromEntries(await Promise.all(['product', 'product_gallery_image', 'shop_order', 'delivery',
  'order_item', 'order_event', 'checkout_idempotency', 'company_setting'].map(async table => [table,
  (await store.all(`SELECT * FROM ${table} ORDER BY ${table === 'checkout_idempotency' ? 'key_hash' : 'id'}`)).map(row => {
    const value = { ...row }; if (table === 'product') delete value.gallery_layout_json;
    if (table === 'product_gallery_image') { delete value.thumb_mime; delete value.thumb_data; }  // previews arrived with schema 20
    return value;
  })])));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function oldFixture(file) {
  const store = await openDatabase(file); await setupShop(store, { mode: 'demo' });
  const product = (await listProducts(store, new URLSearchParams('limit=1'))).items[0];
  const image = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');
  for (let index = 0; index < 4; index++) await addGalleryImage(store, product.id, image);
  const order = {
    buyer: { fullName: 'Synthetic Buyer', whatsappPhone: null, email: 'fixture@example.invalid' },
    whatsappOrderContactOptIn: false, locale: 'en', deliveries: [{
      recipient: { fullName: 'Synthetic Recipient', phone: '+60 12-345 6789' },
      address: { line1: 'Synthetic Street', postcode: '00000', country: 'MY' },
      items: [{ productId: product.id, quantity: 2, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }],
    }],
  };
  await createOrder(store, 'synthetic-schema-order-0001', order);
  // This only constructs a disposable historical fixture. It is not a shipped
  // downgrade/rollback operation and never touches live or shared data.
  await store.run('UPDATE product SET gallery_layout_json = NULL');
  await store.exec(`ALTER TABLE product_gallery_image RENAME TO historical_gallery_fixture;
    CREATE TABLE product_gallery_image(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4), mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
      data BLOB NOT NULL, created_at TEXT NOT NULL, UNIQUE(product_id,position)) STRICT;
    INSERT INTO product_gallery_image (id,product_id,position,mime,data,created_at) SELECT id,product_id,position,mime,data,created_at FROM historical_gallery_fixture;
    DROP TABLE historical_gallery_fixture;
    CREATE INDEX product_gallery_product ON product_gallery_image(product_id,position);
    ALTER TABLE product DROP COLUMN gallery_layout_json;`);
  await store.setSchemaVersion(10);
  return { store, order };
}

test('closed schema10 backup restores independently and upgrades to the current schema without changing images or order snapshots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shopping-schema-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = join(directory, 'original.db'), backup = join(directory, 'pre-upgrade.db'), restored = join(directory, 'isolated-restore.db');
  const fixture = await oldFixture(original), before = await snapshot(fixture.store); await fixture.store.close();
  copyFileSync(original, backup); const backupHash = hash(backup);
  const upgraded = await openDatabase(original);
  try {
    assert.equal(await upgraded.schemaVersion(), SCHEMA_VERSION); assert.deepEqual(await snapshot(upgraded), before);
    await createOrder(upgraded, 'synthetic-schema-order-0002', fixture.order);
    assert.equal((await upgraded.get('SELECT COUNT(*) n FROM shop_order')).n, 2);
    copyFileSync(backup, restored);
    const recovery = await openDatabase(restored);
    try {
      assert.equal(await recovery.schemaVersion(), SCHEMA_VERSION); assert.deepEqual(await snapshot(recovery), before);
      assert.equal((await recovery.get('SELECT COUNT(*) n FROM shop_order')).n, 1);
      assert.equal((await upgraded.get('SELECT COUNT(*) n FROM shop_order')).n, 2);
      assert.equal(hash(backup), backupHash);
    } finally { await recovery.close(); }
  } finally { await upgraded.close(); }
});

test('schema15 failure rolls back new columns and tables while retaining schema13 and all historical data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shopping-schema-fault-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.db'); const fixture = await oldFixture(file), before = await snapshot(fixture.store); await fixture.store.close();
  const store = openNodeStore(file); t.after(async () => await store.close());
  const faulty = { ...store, async exec(sql) {
    const insert = sql.indexOf('INSERT INTO product_gallery_image_v15');
    if (insert >= 0) { await store.exec(sql.slice(0, insert)); throw new Error('synthetic interrupted schema15 rebuild'); }
    await store.exec(sql);
  } };
  await assert.rejects(() => migrateStore(faulty), /synthetic interrupted/);
  assert.equal(await store.schemaVersion(), 13); assert.deepEqual(await snapshot(store), before);
  assert.ok(!(await store.all('PRAGMA table_info(product)')).some(column => column.name === 'gallery_layout_json'));
  assert.equal((await store.get("SELECT COUNT(*) n FROM sqlite_schema WHERE name = 'product_gallery_image_v15'")).n, 0);
  await migrateStore(store); assert.equal(await store.schemaVersion(), SCHEMA_VERSION); assert.deepEqual(await snapshot(store), before);
});
