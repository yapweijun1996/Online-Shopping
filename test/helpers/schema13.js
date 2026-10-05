/*
 * Turns a current database back into the shape of schema version 13 (one shop, singleton
 * settings and sequence rows, global SKU and order-number uniqueness) so migration tests can
 * start from a genuine older layout. `db` needs exec(sql) and get(sql).
 */
export function revertTenantSchema(db) {
  const shopId = db.get('SELECT id FROM shop ORDER BY created_at, id LIMIT 1')?.id;
  if (!shopId) throw new Error('No shop to revert.');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE shop_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT CHECK (mode IN ('demo', 'production')),
        shop_name TEXT NOT NULL
      ) STRICT;
      INSERT INTO shop_setup(id, mode, shop_name) SELECT 1, mode, name FROM shop WHERE id = '${shopId}';
      DROP TRIGGER product_category_insert; DROP TRIGGER product_category_update;
      CREATE TABLE general_code_old (
        type TEXT NOT NULL CHECK (type = 'PRODUCT_CATEGORY'), code TEXT NOT NULL, label TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (type, code), UNIQUE (type, label)
      ) STRICT;
      INSERT INTO general_code_old SELECT type, code, label, active, created_at, updated_at FROM general_code;
      DROP TABLE general_code; ALTER TABLE general_code_old RENAME TO general_code;
      CREATE TABLE product_old (
        id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')), active INTEGER NOT NULL CHECK (active IN (0, 1)),
        translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
        image_mime TEXT, image_data BLOB, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, variant_group TEXT, variant_label TEXT, stock_quantity INTEGER
        CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000),
        CHECK ((image_mime IS NULL AND image_data IS NULL) OR
               (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
      ) STRICT;
      INSERT INTO product_old SELECT id, sku, name, description, category, price_minor, currency, active, translations_json,
        image_mime, image_data, created_at, updated_at, variant_group, variant_label, stock_quantity FROM product;
      DROP TABLE product; ALTER TABLE product_old RENAME TO product;
      CREATE INDEX product_public ON product(active, category, updated_at);
      CREATE INDEX product_variant_group ON product(variant_group, active);
      CREATE UNIQUE INDEX product_variant_option ON product(variant_group, variant_label COLLATE NOCASE);
      CREATE TRIGGER product_category_insert BEFORE INSERT ON product
        WHEN NOT EXISTS (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1)
        BEGIN SELECT RAISE(ABORT, 'Unknown active product category'); END;
      CREATE TRIGGER product_category_update BEFORE UPDATE OF category ON product
        WHEN NEW.category <> OLD.category AND NOT EXISTS
          (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1)
        BEGIN SELECT RAISE(ABORT, 'Unknown active product category'); END;
      CREATE TABLE shop_order_old (
        id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, buyer_name TEXT NOT NULL, buyer_phone TEXT NOT NULL, buyer_email TEXT,
        whatsapp_opt_in INTEGER NOT NULL CHECK (whatsapp_opt_in IN (0, 1)), whatsapp_consent_at TEXT, whatsapp_consent_version TEXT,
        locale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
        revision INTEGER NOT NULL CHECK (revision >= 1), currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        total_minor INTEGER NOT NULL CHECK (total_minor >= 0), submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        tracking_carrier TEXT, tracking_no TEXT,
        CHECK ((whatsapp_opt_in = 0 AND whatsapp_consent_at IS NULL AND whatsapp_consent_version IS NULL) OR
               (whatsapp_opt_in = 1 AND whatsapp_consent_at IS NOT NULL AND whatsapp_consent_version IS NOT NULL))
      ) STRICT;
      INSERT INTO shop_order_old SELECT id, order_no, buyer_name, buyer_phone, buyer_email, whatsapp_opt_in, whatsapp_consent_at,
        whatsapp_consent_version, locale, status, revision, currency, total_minor, submitted_at, updated_at,
        tracking_carrier, tracking_no FROM shop_order;
      DROP TABLE shop_order; ALTER TABLE shop_order_old RENAME TO shop_order;
      CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC);
      CREATE TABLE checkout_idempotency_old (
        key_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id) ON DELETE RESTRICT, created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO checkout_idempotency_old SELECT key_hash, request_hash, order_id, created_at FROM checkout_idempotency;
      DROP TABLE checkout_idempotency; ALTER TABLE checkout_idempotency_old RENAME TO checkout_idempotency;
      CREATE TABLE company_setting_old (
        id INTEGER PRIMARY KEY CHECK (id = 1), default_currency TEXT NOT NULL CHECK (default_currency IN ('MYR', 'SGD')),
        updated_at TEXT NOT NULL,
        seller_whatsapp_phone TEXT CHECK (seller_whatsapp_phone IS NULL OR
          (length(seller_whatsapp_phone) BETWEEN 8 AND 15 AND seller_whatsapp_phone NOT GLOB '*[^0-9]*')),
        mobile_hide_bars_on_scroll INTEGER NOT NULL DEFAULT 0 CHECK (mobile_hide_bars_on_scroll IN (0, 1))
      ) STRICT;
      INSERT INTO company_setting_old SELECT 1, default_currency, updated_at, seller_whatsapp_phone, mobile_hide_bars_on_scroll
        FROM company_setting WHERE shop_id = '${shopId}';
      DROP TABLE company_setting; ALTER TABLE company_setting_old RENAME TO company_setting;
      CREATE TABLE order_sequence_old (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL CHECK (value >= 0)) STRICT;
      INSERT INTO order_sequence_old SELECT 1, value FROM order_sequence WHERE shop_id = '${shopId}';
      DROP TABLE order_sequence; ALTER TABLE order_sequence_old RENAME TO order_sequence;
      DROP TABLE shop_code_alias; DROP TABLE shop;
      PRAGMA user_version = 13`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
