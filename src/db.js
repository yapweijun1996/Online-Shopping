import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 5;

function migrate(database, version, sql) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(sql);
    database.exec(`PRAGMA user_version = ${version}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file, { timeout: 5000 });
  if (file !== ':memory:') chmodSync(file, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  let version = database.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    migrate(database, 1, `
      CREATE TABLE admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX session_expiry ON session(expires_at);`);
    version = 1;
  }
  if (version === 1) {
    migrate(database, 2, `
      CREATE TABLE product (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000),
        currency TEXT NOT NULL CHECK (currency = 'MYR'),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
        image_mime TEXT,
        image_data BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((image_mime IS NULL AND image_data IS NULL) OR
               (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
      ) STRICT;
      CREATE INDEX product_public ON product(active, category, updated_at);`);
    version = 2;
  }
  if (version === 2) {
    migrate(database, 3, `
      CREATE TABLE order_sequence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      ) STRICT;
      INSERT INTO order_sequence(id, value) VALUES (1, 0);
      CREATE TABLE shop_order (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
        buyer_name TEXT NOT NULL,
        buyer_phone TEXT NOT NULL,
        buyer_email TEXT,
        whatsapp_opt_in INTEGER NOT NULL CHECK (whatsapp_opt_in IN (0, 1)),
        whatsapp_consent_at TEXT,
        whatsapp_consent_version TEXT,
        locale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        currency TEXT NOT NULL CHECK (currency = 'MYR'),
        total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((whatsapp_opt_in = 0 AND whatsapp_consent_at IS NULL AND whatsapp_consent_version IS NULL) OR
               (whatsapp_opt_in = 1 AND whatsapp_consent_at IS NOT NULL AND whatsapp_consent_version IS NOT NULL))
      ) STRICT;
      CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC);
      CREATE TABLE delivery (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        recipient_name TEXT NOT NULL,
        recipient_phone TEXT NOT NULL,
        address_line1 TEXT NOT NULL,
        address_line2 TEXT,
        address_city TEXT,
        address_region TEXT,
        address_postcode TEXT NOT NULL,
        address_country TEXT NOT NULL,
        UNIQUE(order_id, position)
      ) STRICT;
      CREATE TABLE order_item (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        sku_snapshot TEXT NOT NULL,
        name_snapshot TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
        line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
        currency TEXT NOT NULL CHECK (currency = 'MYR'),
        UNIQUE(delivery_id, position)
      ) STRICT;
      CREATE TABLE order_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('GUEST', 'SELLER')),
        actor_id TEXT,
        previous_status TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX order_event_history ON order_event(order_id, id);
      CREATE TABLE checkout_idempotency (
        key_hash TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT;`);
    version = 3;
  }
  if (version === 3) {
    migrate(database, 4, `
      CREATE TABLE general_code (
        type TEXT NOT NULL CHECK (type = 'PRODUCT_CATEGORY'),
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (type, code),
        UNIQUE (type, label)
      ) STRICT;
      INSERT INTO general_code(type, code, label, active, created_at, updated_at)
        SELECT 'PRODUCT_CATEGORY', category, category, 1, datetime('now'), datetime('now')
        FROM product GROUP BY category;`);
    version = 4;
  }
  if (version === 4) {
    // SQLite cannot relax a CHECK constraint in place. Rebuild each affected table
    // with foreign-key checking disabled only for this atomic migration.
    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec('BEGIN IMMEDIATE');
      for (const table of ['product', 'shop_order', 'order_item']) {
        const schema = database.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('table', table)?.sql;
        if (!schema || !schema.includes("currency = 'MYR'")) throw new Error(`Unexpected ${table} currency schema.`);
        database.exec(schema.replace(new RegExp(`^CREATE TABLE ["\x60]?${table}["\x60]?`, 'i'), `CREATE TABLE ${table}_new`)
          .replace("currency = 'MYR'", "currency IN ('MYR', 'SGD')"));
        const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name).join(', ');
        database.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      }
      database.exec('CREATE INDEX product_public ON product(active, category, updated_at)');
      database.exec('CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC)');
      database.exec(`CREATE TABLE company_setting (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_currency TEXT NOT NULL CHECK (default_currency IN ('MYR', 'SGD')),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO company_setting(id, default_currency, updated_at) VALUES (1, 'MYR', datetime('now'));
      CREATE TRIGGER product_category_insert BEFORE INSERT ON product
        WHEN NOT EXISTS (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1)
        BEGIN SELECT RAISE(ABORT, 'Unknown active product category'); END;
      CREATE TRIGGER product_category_update BEFORE UPDATE OF category ON product
        WHEN NEW.category <> OLD.category AND NOT EXISTS
          (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1)
        BEGIN SELECT RAISE(ABORT, 'Unknown active product category'); END;`);
      if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Currency migration failed foreign-key check.');
      database.exec('PRAGMA user_version = 5');
      database.exec('COMMIT');
      version = 5;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }
  if (version !== SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported database schema version ${version}.`);
  }
  return database;
}

export function ready(database) {
  try {
    return database.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION &&
      Boolean(database.prepare('SELECT id FROM admin WHERE id = 1').get()) &&
      Array.isArray(database.prepare('SELECT token_hash FROM session LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT id FROM product LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT code FROM general_code LIMIT 1').all()) &&
      Boolean(database.prepare('SELECT id FROM company_setting WHERE id = 1').get()) &&
      Boolean(database.prepare('SELECT id FROM order_sequence WHERE id = 1').get()) &&
      Array.isArray(database.prepare('SELECT id FROM shop_order LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT id FROM delivery LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT id FROM order_item LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT id FROM order_event LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT key_hash FROM checkout_idempotency LIMIT 1').all());
  } catch {
    return false;
  }
}
