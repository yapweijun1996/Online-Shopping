import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { createProduct, updateProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

const orderInput = (firstId, secondId) => ({
  buyer: { fullName: 'Example Buyer', whatsappPhone: '+65 8123 4567', email: null },
  whatsappOrderContactOptIn: true,
  locale: 'en',
  deliveries: [
    {
      recipient: { fullName: 'Example Recipient One', phone: '+60 12-345 6789' },
      address: { line1: 'Example Street 1', postcode: '47810', country: 'MY' },
      items: [{ productId: firstId, quantity: 2, expectedPriceMinor: 900 }],
    },
    {
      recipient: { fullName: 'Example Recipient Two', phone: '+65 8123 4567' },
      address: { line1: 'Example Avenue 2', line2: 'Unit 03-01', city: 'Singapore', postcode: '123456', country: 'SG' },
      items: [{ productId: secondId, quantity: 1, expectedPriceMinor: 500 }],
    },
  ],
});

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-orders-'));
  const config = { username: 'order_owner', password: 'LocalOrderPass123!', dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null };
  const app = createApp(config);
  createCategory(app.database, { code: 'EXAMPLES', label: 'Examples' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const first = createProduct(app.database, {
    sku: 'item-a', name: 'Example item A', description: 'Description A', category: 'EXAMPLES', priceMinor: 900, currency: 'MYR', active: true,
  });
  const second = createProduct(app.database, {
    sku: 'item-b', name: 'Example item B', description: 'Description B', category: 'EXAMPLES', priceMinor: 500, currency: 'MYR', active: true,
  });
  return {
    app, config, directory, origin, first, second,
    async submit(key, body = orderInput(first.id, second.id), headers = {}) {
      const response = await fetch(`${origin}/api/v1/orders`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': key, ...headers },
        body: JSON.stringify(body),
      });
      return { response, data: await response.json() };
    },
    async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('checkout snapshots two destinations and server prices in one private order', async () => {
  const f = await fixture();
  try {
    const original = orderInput(f.first.id, f.second.id);
    const request = {
      ...original, totalMinor: 1, shippingMinor: 9999, gstMinor: 9999,
      deliveries: [{ ...original.deliveries[0], items: [{ ...original.deliveries[0].items[0], priceMinor: 1 }] }, original.deliveries[1]],
    };
    const result = await f.submit('order-intent-00000001', request);
    assert.equal(result.response.status, 201);
    assert.deepEqual(Object.keys(result.data).sort(), ['currency', 'orderNo', 'status', 'submittedAt', 'totalMinor']);
    assert.equal(result.data.orderNo, 'OS-00000001');
    assert.equal(result.data.status, 'SUBMITTED');
    assert.equal(result.data.currency, 'MYR');
    assert.equal(result.data.totalMinor, 2300);
    const order = f.app.database.prepare('SELECT * FROM shop_order').get();
    assert.equal(order.buyer_phone, '+6581234567');
    assert.equal(order.whatsapp_opt_in, 1);
    assert.equal(order.whatsapp_consent_at, order.submitted_at);
    assert.equal(order.whatsapp_consent_version, 'order-contact-v1');
    assert.equal(order.revision, 1);
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM delivery').get().count, 2);
    const recipients = f.app.database.prepare('SELECT recipient_phone, address_country FROM delivery ORDER BY position').all();
    assert.deepEqual(recipients.map(({ recipient_phone, address_country }) => [recipient_phone, address_country]),
      [['+60123456789', 'MY'], ['+6581234567', 'SG']]);
    const items = f.app.database.prepare('SELECT sku_snapshot, name_snapshot, price_minor, quantity, line_total_minor FROM order_item ORDER BY price_minor DESC').all();
    assert.deepEqual(items.map(({ sku_snapshot, price_minor, quantity, line_total_minor }) => [sku_snapshot, price_minor, quantity, line_total_minor]),
      [['ITEM-A', 900, 2, 1800], ['ITEM-B', 500, 1, 500]]);
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM order_event').get().count, 1);
    updateProduct(f.app.database, f.first.id, { name: 'Renamed item', priceMinor: 1200, active: false });
    assert.equal(f.app.database.prepare('SELECT name_snapshot, price_minor FROM order_item WHERE product_id = ?').get(f.first.id).name_snapshot,
      'Example item A');
    assert.equal(f.app.database.prepare('SELECT price_minor FROM order_item WHERE product_id = ?').get(f.first.id).price_minor, 900);
    assert.equal((await f.submit('order-intent-00000002')).data.error.code, 'PRODUCT_UNAVAILABLE');
    assert.equal((await fetch(`${f.origin}/api/v1/orders?phone=%2B6581234567`)).status, 404);
    assert.equal((await fetch(`${f.origin}/api/v1/orders/${result.data.orderNo}`)).status, 404);
  } finally { await f.close(); }
});

test('checkout rejects a changed price instead of charging the new amount', async () => {
  const f = await fixture();
  try {
    updateProduct(f.app.database, f.second.id, { priceMinor: 750 });
    const changed = await f.submit('order-intent-00000011');
    assert.equal(changed.response.status, 409);
    assert.equal(changed.data.error.code, 'PRICE_CHANGED');
    assert.equal(changed.data.error.field, 'deliveries.1.items.0.expectedPriceMinor');
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 0);
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM checkout_idempotency').get().count, 0);
    const original = orderInput(f.first.id, f.second.id);
    const missing = await f.submit('order-intent-00000012', {
      ...original,
      deliveries: [original.deliveries[0], { ...original.deliveries[1], items: [{ productId: f.second.id, quantity: 1 }] }],
    });
    assert.equal(missing.response.status, 400);
    assert.equal(missing.data.error.field, 'deliveries.1.items.0.expectedPriceMinor');
    const accepted = await f.submit('order-intent-00000013', {
      ...original,
      deliveries: [original.deliveries[0], { ...original.deliveries[1], items: [{ productId: f.second.id, quantity: 1, expectedPriceMinor: 750 }] }],
    });
    assert.equal(accepted.response.status, 201);
    assert.equal(accepted.data.totalMinor, 2550);
  } finally { await f.close(); }
});

test('idempotent retries return the original receipt and reject changed intent', async () => {
  const f = await fixture();
  try {
    const key = 'order-intent-00000003';
    const first = await f.submit(key);
    assert.equal(first.response.status, 201);
    updateProduct(f.app.database, f.first.id, { priceMinor: 2000, active: false });
    const replay = await f.submit(key);
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.data, first.data);
    const changed = await f.submit(key, { ...orderInput(f.first.id, f.second.id), whatsappOrderContactOptIn: false });
    assert.equal(changed.response.status, 409);
    assert.equal(changed.data.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 1);
    const stored = f.app.database.prepare('SELECT key_hash, request_hash FROM checkout_idempotency').get();
    assert.equal(stored.key_hash.length, 64);
    assert.notEqual(stored.key_hash, key);
  } finally { await f.close(); }
});

test('SGD orders retain SGD snapshots and mixed-currency orders make no writes', async () => {
  const f = await fixture();
  try {
    updateProduct(f.app.database, f.second.id, { currency: 'SGD' });
    const mixed = await f.submit('mixed-order-intent-001');
    assert.equal(mixed.response.status, 409);
    assert.equal(mixed.data.error.code, 'MIXED_CURRENCY');
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 0);
    const single = orderInput(f.second.id, f.first.id);
    const receipt = await f.submit('sgd-order-intent-0002', {
      ...single,
      deliveries: [{ ...single.deliveries[0], items: [{ ...single.deliveries[0].items[0], expectedPriceMinor: 500 }] }],
    });
    assert.equal(receipt.response.status, 201);
    assert.equal(receipt.data.currency, 'SGD');
    assert.equal(f.app.database.prepare('SELECT currency FROM shop_order').get().currency, 'SGD');
    assert.equal(f.app.database.prepare('SELECT currency FROM order_item').get().currency, 'SGD');
  } finally { await f.close(); }
});

test('concurrent submissions with one intent create only one order', async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([
      f.submit('order-intent-00000008'), f.submit('order-intent-00000008'),
    ]);
    assert.deepEqual([first.response.status, second.response.status].sort(), [200, 201]);
    assert.deepEqual(first.data, second.data);
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 1);
  } finally { await f.close(); }
});

test('checkout rejects invalid contact, assignment and unavailable product without writes', async () => {
  const f = await fixture();
  try {
    const original = orderInput(f.first.id, f.second.id);
    const invalidPhone = await f.submit('order-intent-00000004', {
      ...original,
      deliveries: [original.deliveries[0], { ...original.deliveries[1], recipient: { fullName: 'Example Recipient', phone: '+66 8123 4567' } }],
    });
    assert.equal(invalidPhone.response.status, 400);
    assert.equal(invalidPhone.data.error.field, 'deliveries.1.recipient.phone');
    const wrongOrigin = await f.submit('order-intent-00000009', original, { origin: 'https://elsewhere.example' });
    assert.equal(wrongOrigin.response.status, 403);
    const missingKey = await f.submit('', original);
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.data.error.field, 'Idempotency-Key');
    const duplicate = await f.submit('order-intent-00000005', {
      ...original,
      deliveries: [{ ...original.deliveries[0], items: [original.deliveries[0].items[0], original.deliveries[0].items[0]] }],
    });
    assert.equal(duplicate.response.status, 400);
    assert.equal(duplicate.data.error.field, 'deliveries.0.items.1.productId');
    const invalidQuantity = await f.submit('order-intent-00000010', {
      ...original,
      deliveries: [{ ...original.deliveries[0], items: [{ productId: f.first.id, quantity: 101 }] }],
    });
    assert.equal(invalidQuantity.response.status, 400);
    assert.equal(invalidQuantity.data.error.field, 'deliveries.0.items.0.quantity');
    updateProduct(f.app.database, f.second.id, { active: false });
    const unavailable = await f.submit('order-intent-00000006');
    assert.equal(unavailable.response.status, 409);
    assert.equal(unavailable.data.error.code, 'PRODUCT_UNAVAILABLE');
    assert.equal(unavailable.data.error.field, 'deliveries.1.items.0.productId');
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 0);
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM checkout_idempotency').get().count, 0);
  } finally { await f.close(); }
});

test('a failed persistence transaction returns no receipt and permits safe retry', async () => {
  const f = await fixture();
  try {
    f.app.database.exec(`CREATE TRIGGER fail_fixture_item BEFORE INSERT ON order_item
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    const failed = await f.submit('order-intent-00000007');
    assert.equal(failed.response.status, 500);
    assert.equal(failed.data.error.code, 'INTERNAL_ERROR');
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 0);
    assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM checkout_idempotency').get().count, 0);
    f.app.database.exec('DROP TRIGGER fail_fixture_item');
    const retry = await f.submit('order-intent-00000007');
    assert.equal(retry.response.status, 201);
    assert.equal(retry.data.orderNo, 'OS-00000001');
  } finally { await f.close(); }
});

test('schema version two upgrades without losing catalog records', async () => {
  const f = await fixture();
  await f.app.close();
  const old = new DatabaseSync(f.config.dbPath);
  old.exec(`DROP TABLE company_setting; DROP TABLE general_code;
    DROP TABLE checkout_idempotency; DROP TABLE order_event; DROP TABLE order_item;
    DROP TABLE delivery; DROP TABLE shop_order; DROP TABLE order_sequence; PRAGMA user_version = 2;`);
  const productSchema = old.prepare("SELECT sql FROM sqlite_schema WHERE name = 'product'").get().sql;
  old.exec(productSchema.replace(/^CREATE TABLE ["`]?product["`]?/i, 'CREATE TABLE product_v2')
    .replace("currency IN ('MYR', 'SGD')", "currency = 'MYR'"));
  old.exec(`INSERT INTO product_v2 SELECT * FROM product;
    DROP TABLE product; ALTER TABLE product_v2 RENAME TO product;
    CREATE INDEX product_public ON product(active, category, updated_at);`);
  old.close();
  const migrated = createApp(f.config);
  try {
    assert.equal(migrated.database.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM product').get().count, 2);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 0);
  } finally {
    migrated.database.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('schema version three upgrades an existing order without changing its snapshots', async () => {
  const f = await fixture();
  const placed = await f.submit('migration-intent-0001');
  assert.equal(placed.response.status, 201);
  await f.app.close();
  const old = new DatabaseSync(f.config.dbPath);
  old.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    for (const table of ['product', 'shop_order', 'order_item']) {
      const schema = old.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(table).sql;
      old.exec(schema.replace(new RegExp(`^CREATE TABLE ["\x60]?${table}["\x60]?`, 'i'), `CREATE TABLE ${table}_v3`)
        .replace("currency IN ('MYR', 'SGD')", "currency = 'MYR'"));
      old.exec(`INSERT INTO ${table}_v3 SELECT * FROM ${table}`);
      old.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_v3 RENAME TO ${table}`);
    }
    old.exec(`CREATE INDEX product_public ON product(active, category, updated_at);
      CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC);
      DROP TABLE company_setting; DROP TABLE general_code; PRAGMA user_version = 3; COMMIT`);
  } catch (error) { old.exec('ROLLBACK'); throw error; }
  old.exec('PRAGMA foreign_keys = ON');
  old.close();
  const migrated = createApp(f.config);
  try {
    assert.equal(migrated.database.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM shop_order').get().count, 1);
    assert.equal(migrated.database.prepare('SELECT currency, total_minor FROM shop_order').get().total_minor, 2300);
    assert.deepEqual(migrated.database.prepare('SELECT DISTINCT currency FROM order_item').all().map((row) => row.currency), ['MYR']);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM checkout_idempotency').get().count, 1);
    assert.equal(migrated.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(migrated.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    migrated.database.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
