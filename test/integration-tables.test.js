import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db.js';
import { createOrder } from '../src/orders.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';
import { INTEGRATION_TABLE_NAMES, postgresIntegrationTablesSql } from '../src/integration-tables.js';

const now = '2026-10-07T00:00:00.000Z';

test('the PostgreSQL baseline contains exactly the integration tables the upgrade creates', () => {
  const baseline = readFileSync(new URL('../src/postgres/schema.sql', import.meta.url), 'utf8');
  assert.ok(baseline.includes(postgresIntegrationTablesSql.trim()), 'schema.sql and integration-tables.js have drifted');
  assert.match(baseline, /INSERT INTO schema_meta VALUES \(1, 18\);/);
  for (const name of INTEGRATION_TABLE_NAMES) assert.match(baseline, new RegExp(`CREATE TABLE IF NOT EXISTS ${name} `));
});

async function fixture() {
  const store = await openDatabase(':memory:');
  await createCategory(store, { code: 'REVIEW', label: 'Review' });
  const product = await createProduct(store, { sku: 'R-1', name: 'Item', description: 'x', category: 'REVIEW', priceMinor: 100, currency: 'MYR', active: true });
  await createOrder(store, 'integration-tables-intent-0001', { buyer: { fullName: 'Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
    deliveries: [{ recipient: { fullName: 'R', phone: '+60123456789' }, address: { line1: 'Street', postcode: '50000', country: 'MY' },
      items: [{ productId: product.id, quantity: 1, expectedPriceMinor: 100, expectedCurrency: 'MYR' }] }] });
  const order = await store.get('SELECT id FROM shop_order');
  const delivery = await store.get('SELECT id FROM delivery');
  return { store, orderId: order.id, deliveryId: delivery.id };
}

test('SQLite schema 18 creates the integration tables and enforces their rules', async () => {
  const { store, orderId, deliveryId } = await fixture();
  try {
    assert.equal(await store.schemaVersion(), 18);
    for (const name of INTEGRATION_TABLE_NAMES) assert.ok(Array.isArray(await store.all(`SELECT * FROM ${name} LIMIT 0`)), name);
    const connection = (provider = 'NINJAVAN') => store.run(`INSERT INTO integration_connection(id, provider, environment, status, created_at, updated_at)
      VALUES (?, ?, 'SANDBOX', 'NOT_CONFIGURED', ?, ?)`, `c-${provider}`, provider, now, now);
    await connection();
    await assert.rejects(connection(), /UNIQUE|constraint/i, 'one connection per provider and environment');
    // A secret must always come with the key that encrypted it.
    await assert.rejects(store.run("UPDATE integration_connection SET secret_ciphertext = x'00' WHERE id = 'c-NINJAVAN'"), /CHECK|constraint/i);
    await store.run("UPDATE integration_connection SET secret_ciphertext = x'00', secret_key_id = 'k1' WHERE id = 'c-NINJAVAN'");
    await assert.rejects(store.run("UPDATE integration_connection SET provider = 'OTHER' WHERE id = 'c-NINJAVAN'"), /CHECK|constraint/i);

    const shipment = (id, status, key) => store.run(`INSERT INTO shipment(id, order_id, delivery_id, connection_id, provider, idempotency_key, request_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, 'c-NINJAVAN', 'NINJAVAN', ?, 'h', ?, ?, ?)`, id, orderId, deliveryId, key, status, now, now);
    await shipment('s1', 'PENDING', 'k1');
    await assert.rejects(shipment('s2', 'CREATED', 'k2'), /UNIQUE|constraint/i, 'one live parcel per delivery');
    await store.run("UPDATE shipment SET status = 'CANCELLED' WHERE id = 's1'");
    await shipment('s2', 'PENDING', 'k2');
    await assert.rejects(shipment('s3', 'PENDING', 'k2'), /UNIQUE|constraint/i, 'idempotency key is unique');

    await connection('WHATSAPP_CLOUD');
    const message = (id, kind, key) => store.run(`INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, created_at, updated_at)
      VALUES (?, ?, 'c-WHATSAPP_CLOUD', ?, 'hash', 'order_submitted', 'en', ?, ?, ?)`, id, orderId, kind, key, now, now);
    await message('m1', 'ORDER_SUBMITTED', 'mk1');
    await assert.rejects(message('m2', 'ORDER_SUBMITTED', 'mk2'), /UNIQUE|constraint/i, 'a message kind is sent once per order');
    await message('m3', 'ORDER_SHIPPED', 'mk3');

    const inbound = (id, providerId) => store.run(`INSERT INTO message_inbound(id, connection_id, order_id, from_hash, provider_message_id, kind, body, received_at)
      VALUES (?, 'c-WHATSAPP_CLOUD', ?, 'hash', ?, 'TEXT', 'hello', ?)`, id, orderId, providerId, now);
    await inbound('i1', 'wamid.1');
    await assert.rejects(inbound('i2', 'wamid.1'), /UNIQUE|constraint/i, 'a reply is stored once');

    const receipt = () => store.run("INSERT INTO webhook_receipt(provider, dedupe_key, verified, received_at) VALUES ('NINJAVAN', 'evt-1', 1, ?)", now);
    await receipt();
    await assert.rejects(receipt(), /UNIQUE|constraint/i, 'a webhook event is recorded once');
    await store.run("INSERT INTO integration_audit(connection_id, actor, action, detail, occurred_at) VALUES ('c-NINJAVAN', 'seller', 'CONNECT', 'last4=1234', ?)", now);
    await assert.rejects(store.run("INSERT INTO integration_audit(actor, action, occurred_at) VALUES ('seller', 'LEAK', ?)", now), /CHECK|constraint/i);
  } finally { await store.close(); }
});
