import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { setupShop, resetDemo } from '../src/shop-setup.js';
import { listProducts } from '../src/products.js';
import { createOrder } from '../src/orders.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('PostgreSQL tests require NODE_ENV=test and a disposable test database.');
const TABLES = ['integration_connection', 'integration_audit', 'webhook_receipt', 'message_outbox', 'message_inbound'];
const now = '2026-10-08T00:00:00.000Z';
const hash = 'a'.repeat(64);

async function expectRejected(promise, pattern) {
  await assert.rejects(promise, pattern);
}

async function seedRows(store, orderId) {
  await store.run(`INSERT INTO integration_connection(id, provider, environment, status, created_at, updated_at) VALUES ('c1', 'WHATSAPP_CLOUD', 'SANDBOX', 'CONNECTED', ?, ?)`, now, now);
  await store.run(`INSERT INTO integration_audit(id, provider, environment, action, actor, created_at) VALUES ('a1', 'WHATSAPP_CLOUD', 'SANDBOX', 'CONNECT', 'owner', ?)`, now);
  await store.run(`INSERT INTO webhook_receipt(id, provider, dedupe_key, verified, received_at) VALUES ('w1', 'WHATSAPP_CLOUD', 'wamid.1', 1, ?)`, now);
  await store.run(`INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, created_at, updated_at)
    VALUES ('m1', ?, 'c1', 'ORDER_SUBMITTED', ?, 'order_submitted', 'en', ?, ?, ?)`, orderId, hash, `${orderId}:ORDER_SUBMITTED`, now, now);
  await store.run(`INSERT INTO message_inbound(id, connection_id, order_id, from_hash, provider_message_id, kind, body, received_at, created_at)
    VALUES ('i1', 'c1', ?, ?, 'wamid.in.1', 'TEXT', 'Thank you', ?, ?)`, orderId, hash, now, now);
}

const orderInput = (product) => ({ buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
  deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
    items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }] });

test('SQLite schema 21: tables are created, the upgrade from 20 is repeatable, and constraints hold', async () => {
  const store = await openDatabase(':memory:');
  try {
    assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 21);
    for (const table of TABLES) await store.get(`SELECT COUNT(*) AS n FROM ${table}`);
    // A schema 20 database has none of the tables; the upgrade adds them and a second run changes nothing.
    await store.exec(`DROP TABLE message_inbound; DROP TABLE message_outbox; DROP TABLE webhook_receipt; DROP TABLE integration_audit; DROP TABLE integration_connection`);
    await store.setSchemaVersion(20);
    await migrateStore(store); await migrateStore(store);
    assert.equal(await store.schemaVersion(), 21);

    await setupShop(store, { mode: 'demo' });
    const order = await createOrder(store, 'schema21-intent-0001', orderInput((await listProducts(store, new URLSearchParams('limit=1'))).items[0]));
    const orderId = (await store.get('SELECT id FROM shop_order LIMIT 1')).id;
    await seedRows(store, orderId);
    await expectRejected(store.run(`INSERT INTO integration_connection(id, provider, environment, created_at, updated_at) VALUES ('c2', 'WHATSAPP_CLOUD', 'SANDBOX', ?, ?)`, now, now), /UNIQUE/);
    await expectRejected(store.run(`INSERT INTO integration_connection(id, provider, environment, secret_ciphertext, created_at, updated_at) VALUES ('c3', 'NINJAVAN', 'SANDBOX', x'00', ?, ?)`, now, now), /CHECK/);
    await expectRejected(store.run(`INSERT INTO integration_connection(id, provider, environment, created_at, updated_at) VALUES ('c4', 'OTHER', 'SANDBOX', ?, ?)`, now, now), /CHECK/);
    await expectRejected(store.run(`INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, created_at, updated_at)
      VALUES ('m2', ?, 'c1', 'ORDER_SUBMITTED', ?, 't', 'en', ?, ?, ?)`, orderId, hash, `${orderId}:ORDER_SUBMITTED`, now, now), /UNIQUE/);
    await expectRejected(store.run(`INSERT INTO message_inbound(id, connection_id, from_hash, provider_message_id, kind, received_at, created_at) VALUES ('i2', 'c1', ?, 'wamid.in.1', 'TEXT', ?, ?)`, hash, now, now), /UNIQUE/);
    await expectRejected(store.run(`INSERT INTO webhook_receipt(id, provider, dedupe_key, verified, received_at) VALUES ('w2', 'WHATSAPP_CLOUD', 'wamid.1', 1, ?)`, now), /UNIQUE/);

    // The demo reset deletes orders; messages that point at them must go first instead of blocking it.
    await resetDemo(store);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM message_outbox')).n, 0);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM message_inbound')).n, 0);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM integration_connection')).n, 1, 'connections are not order data and are kept');
    assert.ok(order);
  } finally { await store.close(); }
});

async function physicalSchema(url) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const columns = (await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, column_name`, [TABLES])).rows;
    const constraints = (await pool.query(`SELECT r.relname AS table_name, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND r.relname = ANY($1) ORDER BY r.relname, pg_get_constraintdef(c.oid)`, [TABLES])).rows;
    const indexes = (await pool.query(`SELECT tablename, regexp_replace(indexdef, 'INDEX \\S+ ', 'INDEX ') AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1) AND indexname NOT LIKE '%_pkey' AND indexname NOT LIKE '%_key' ORDER BY tablename, definition`, [TABLES])).rows;
    return { columns, constraints, indexes };
  } finally { await pool.end(); }
}

test('PostgreSQL schema 20 upgrades to 21 and matches a fresh schema 21, repeatably; the app role can use the new tables', { skip: !base }, async (t) => {
  const admin = new pg.Pool({ connectionString: base });
  const names = [`shopping_test_${randomUUID().replaceAll('-', '')}`, `shopping_test_${randomUUID().replaceAll('-', '')}`];
  const urlOf = (name) => { const url = new URL(base); url.pathname = '/' + name; return url.href; };
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); for (const name of names) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  for (const name of names) await admin.query(`CREATE DATABASE ${name}`);
  // The production application role; created here so the upgrade's grant branch runs as it does in production.
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'online_shopping_app') THEN CREATE ROLE online_shopping_app NOLOGIN; END IF; END $$`);

  const fresh = await openPostgresDatabase(urlOf(names[0]));
  const old = await openPostgresDatabase(urlOf(names[1]));
  closers.push(() => fresh.close());
  assert.equal(await fresh.schemaVersion(), 21);
  await old.exec(`DROP TABLE message_inbound; DROP TABLE message_outbox; DROP TABLE webhook_receipt; DROP TABLE integration_audit; DROP TABLE integration_connection`);
  await old.setSchemaVersion(20);
  await old.close();

  const upgraded = await openPostgresDatabase(urlOf(names[1]), { allowUpgrade: true });
  assert.equal(await upgraded.schemaVersion(), 21);
  assert.deepEqual(await physicalSchema(urlOf(names[1])), await physicalSchema(urlOf(names[0])), 'upgraded and fresh schemas are identical');
  await upgraded.close();
  const again = await openPostgresDatabase(urlOf(names[1]), { allowUpgrade: true });   // already 21: opens without changes
  assert.equal(await again.schemaVersion(), 21);
  await again.close();

  // Superuser tests cannot see missing grants, so act as the application role inside a transaction that is rolled back.
  const pool = new pg.Pool({ connectionString: urlOf(names[1]) });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE online_shopping_app');
      for (const table of TABLES) {
        await client.query(`SELECT COUNT(*) FROM ${table}`);
        await client.query(`DELETE FROM ${table} WHERE false`);
        await client.query(`UPDATE ${table} SET id = id WHERE false`);
      }
      await client.query(`INSERT INTO integration_connection(id, provider, environment, created_at, updated_at) VALUES ('c1', 'NINJAVAN', 'SANDBOX', 'x', 'x')`);
      await client.query(`INSERT INTO integration_audit(id, provider, environment, action, actor, created_at) VALUES ('a1', 'NINJAVAN', 'SANDBOX', 'CONNECT', 'owner', 'x')`);
      await client.query(`INSERT INTO webhook_receipt(id, provider, dedupe_key, verified, received_at) VALUES ('w1', 'NINJAVAN', 'k', 0, 'x')`);
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await pool.end(); }
});
