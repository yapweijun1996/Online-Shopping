import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { usingPostgres } from './helpers/engine.js';
import { initializePostgresSchema as installVersion13 } from './helpers/postgres-schema13.js';

// Runs only when PGTEST_HOST points at a disposable PostgreSQL database.
test('PostgreSQL schema 13 upgrades to 14 keeping data under the default shop', { skip: !usingPostgres }, async () => {
  const { initializePostgresSchema } = await import('../src/postgres-schema.js');
  const Client = createRequire(import.meta.url)('pg-native');
  const client = new Client();
  const password = readFileSync(process.env.PGTEST_PASSWORD_FILE, 'utf8').trim();
  client.connectSync(`host=${process.env.PGTEST_HOST} port=${process.env.PGTEST_PORT || 5432} dbname=${process.env.PGTEST_DATABASE} user=${process.env.PGTEST_USER} password=${password}`);
  const q = (sql, params) => (params ? client.querySync(sql, params) : client.querySync(sql));
  try {
    q('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    installVersion13((sql) => q(sql));
    assert.equal(q('SELECT version FROM schema_meta')[0].version, 13);
    const ts = '2026-10-05T00:00:00.000Z';
    q("UPDATE shop_setup SET mode = 'production', shop_name = 'Legacy Shop'");
    q(`INSERT INTO general_code VALUES ('PRODUCT_CATEGORY','HOME','Home',1,'${ts}','${ts}')`);
    q(`INSERT INTO product(id, sku, name, description, category, price_minor, currency, active, created_at, updated_at) VALUES ('p1','SKU1','Mug','d','HOME',1000,'MYR',1,'${ts}','${ts}')`);
    q(`INSERT INTO shop_order(id, order_no, buyer_name, buyer_phone, whatsapp_opt_in, locale, status, revision, currency, total_minor, submitted_at, updated_at) VALUES ('o1','OS-00000001','B','+60123456789',0,'en','SUBMITTED',1,'MYR',1000,'${ts}','${ts}')`);
    q(`INSERT INTO checkout_idempotency VALUES ('k1','h','o1','${ts}')`);
    q('UPDATE order_sequence SET value = 1');
    q("UPDATE company_setting SET default_currency = 'SGD'");

    initializePostgresSchema((sql) => q(sql));
    const [shop] = q('SELECT * FROM shop');
    assert.deepEqual([shop.code, shop.name, shop.mode], ['main', 'Legacy Shop', 'production']);
    assert.equal(q('SELECT version FROM schema_meta')[0].version, 14);
    for (const table of ['general_code', 'product', 'shop_order', 'checkout_idempotency', 'company_setting', 'order_sequence']) {
      assert.equal(q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE shop_id = $1`, [shop.id])[0].n, 1, table);
    }
    assert.equal(q('SELECT default_currency FROM company_setting')[0].default_currency, 'SGD');
    assert.equal(q("SELECT to_regclass('public.shop_setup') AS r")[0].r, null);

    // The same SKU and category code are now allowed in a second shop, but not twice in one shop.
    const columns = '(id, shop_id, sku, name, description, category, price_minor, currency, active, created_at, updated_at)';
    q("INSERT INTO shop(id, code, name, status, created_at, updated_at) VALUES ('s2','other','Other','ACTIVE','x','x')");
    q(`INSERT INTO general_code(shop_id, type, code, label, active, created_at, updated_at) VALUES ('s2','PRODUCT_CATEGORY','HOME','Home',1,'${ts}','${ts}')`);
    q(`INSERT INTO product${columns} VALUES ('p2','s2','SKU1','Mug','d','HOME',1000,'MYR',1,'${ts}','${ts}')`);
    assert.throws(() => q(`INSERT INTO product${columns} VALUES ('p3','s2','SKU1','Mug','d','HOME',1000,'MYR',1,'${ts}','${ts}')`), /duplicate key/);
    assert.throws(() => q(`INSERT INTO product${columns} VALUES ('p4','s2','SKU9','Mug','d','NOPE',1000,'MYR',1,'${ts}','${ts}')`), /Unknown active product category/);
    // Running the upgrade again changes nothing.
    initializePostgresSchema((sql) => q(sql));
    assert.equal(q('SELECT COUNT(*)::int AS n FROM shop')[0].n, 2);
  } finally { client.end(() => {}); }
});
