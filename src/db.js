import { openNodeStore } from './store.js';

export const SCHEMA_VERSION = 3;

function migrate(store, version, sql) {
  store.transaction(() => {
    store.exec(sql);
    store.setSchemaVersion(version);
  });
}

export function openDatabase(file) {
  const store = openNodeStore(file);
  try {
    migrateStore(store);
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}

/* Applies pending migrations through the storage contract so every runtime shares one schema. */
export function migrateStore(store) {
  let version = store.schemaVersion();
  if (version === 0) {
    migrate(store, 1, `
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
    migrate(store, 2, `
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
    migrate(store, 3, `
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
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}.`);
}

export function ready(store) {
  try {
    return store.schemaVersion() === SCHEMA_VERSION &&
      Boolean(store.get('SELECT id FROM admin WHERE id = 1')) &&
      Boolean(store.get('SELECT id FROM order_sequence WHERE id = 1')) &&
      ['session', 'product', 'shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency']
        .every((table) => Array.isArray(store.all(`SELECT * FROM ${table} LIMIT 0`)));
  } catch {
    return false;
  }
}
