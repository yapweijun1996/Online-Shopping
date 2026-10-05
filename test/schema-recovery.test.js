import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrateStore } from '../worker-runtime/db.js';
import { openNodeStore } from '../worker-runtime/store.js';
import { setupShop } from '../worker-runtime/shop-setup.js';
import { listProducts, addGalleryImage } from '../worker-runtime/products.js';
import { createOrder } from '../worker-runtime/orders.js';

const snapshot = store => Object.fromEntries(['product', 'product_gallery_image', 'shop_order', 'delivery',
  'order_item', 'order_event', 'checkout_idempotency', 'company_setting'].map(table => [table,
  store.all(`SELECT * FROM ${table} ORDER BY ${table === 'checkout_idempotency' ? 'key_hash' : 'id'}`).map(row => {
    const value = { ...row }; if (table === 'product') delete value.gallery_layout_json; return value;
  })]));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function oldFixture(file) {
  const store = openDatabase(file); setupShop(store, { mode: 'demo' });
  const product = listProducts(store, new URLSearchParams('limit=1')).items[0];
  const image = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');
  for (let index = 0; index < 4; index++) addGalleryImage(store, product.id, image);
  const order = {
    buyer: { fullName: 'Synthetic Buyer', whatsappPhone: null, email: 'fixture@example.invalid' },
    whatsappOrderContactOptIn: false, locale: 'en', deliveries: [{
      recipient: { fullName: 'Synthetic Recipient', phone: '+60 12-345 6789' },
      address: { line1: 'Synthetic Street', postcode: '00000', country: 'MY' },
      items: [{ productId: product.id, quantity: 2, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }],
    }],
  };
  createOrder(store, 'synthetic-schema-order-0001', order);
  // This only constructs a disposable historical fixture. It is not a shipped
  // downgrade/rollback operation and never touches live or shared data.
  store.run('UPDATE product SET gallery_layout_json = NULL');
  store.exec(`ALTER TABLE product_gallery_image RENAME TO historical_gallery_fixture;
    CREATE TABLE product_gallery_image(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4), mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
      data BLOB NOT NULL, created_at TEXT NOT NULL, UNIQUE(product_id,position)) STRICT;
    INSERT INTO product_gallery_image SELECT * FROM historical_gallery_fixture;
    DROP TABLE historical_gallery_fixture;
    CREATE INDEX product_gallery_product ON product_gallery_image(product_id,position);
    ALTER TABLE product DROP COLUMN gallery_layout_json;`);
  store.setSchemaVersion(10);
  return { store, order };
}

test('closed schema10 backup restores independently and upgrades to15 without changing images or order snapshots', t => {
  const directory = mkdtempSync(join(tmpdir(), 'shopping-schema-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = join(directory, 'original.db'), backup = join(directory, 'pre-upgrade.db'), restored = join(directory, 'isolated-restore.db');
  const fixture = oldFixture(original), before = snapshot(fixture.store); fixture.store.close();
  copyFileSync(original, backup); const backupHash = hash(backup);
  const upgraded = openDatabase(original);
  try {
    assert.equal(upgraded.schemaVersion(), 15); assert.deepEqual(snapshot(upgraded), before);
    createOrder(upgraded, 'synthetic-schema-order-0002', fixture.order);
    assert.equal(upgraded.get('SELECT COUNT(*) n FROM shop_order').n, 2);
    copyFileSync(backup, restored);
    const recovery = openDatabase(restored);
    try {
      assert.equal(recovery.schemaVersion(), 15); assert.deepEqual(snapshot(recovery), before);
      assert.equal(recovery.get('SELECT COUNT(*) n FROM shop_order').n, 1);
      assert.equal(upgraded.get('SELECT COUNT(*) n FROM shop_order').n, 2);
      assert.equal(hash(backup), backupHash);
    } finally { recovery.close(); }
  } finally { upgraded.close(); }
});

test('schema15 failure rolls back new columns and tables while retaining schema13 and all historical data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'shopping-schema-fault-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.db'); const fixture = oldFixture(file), before = snapshot(fixture.store); fixture.store.close();
  const store = openNodeStore(file); t.after(() => store.close());
  const faulty = { ...store, exec(sql) {
    const insert = sql.indexOf('INSERT INTO product_gallery_image_v15');
    if (insert >= 0) { store.exec(sql.slice(0, insert)); throw new Error('synthetic interrupted schema15 rebuild'); }
    store.exec(sql);
  } };
  assert.throws(() => migrateStore(faulty), /synthetic interrupted/);
  assert.equal(store.schemaVersion(), 13); assert.deepEqual(snapshot(store), before);
  assert.ok(!store.all('PRAGMA table_info(product)').some(column => column.name === 'gallery_layout_json'));
  assert.equal(store.get("SELECT COUNT(*) n FROM sqlite_schema WHERE name = 'product_gallery_image_v15'").n, 0);
  migrateStore(store); assert.equal(store.schemaVersion(), 15); assert.deepEqual(snapshot(store), before);
});
