import { SCHEMA_VERSION } from './db.js';

// A fresh Production database starts at the current application schema. The
// historical SQLite rebuild migrations remain owned by db.js for SQLite stores.
const schema = `
CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
CREATE TABLE shop (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  mode TEXT CHECK (mode IN ('demo', 'production')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE shop_code_alias (
  code TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
INSERT INTO shop(id, code, name, status, mode, created_at, updated_at)
  VALUES (gen_random_uuid()::text, 'main', 'Online Shopping', 'ACTIVE', NULL, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE session (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX session_expiry ON session(expires_at);
CREATE TABLE general_code (
  shop_id TEXT NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type = 'PRODUCT_CATEGORY'),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, type, code),
  UNIQUE (shop_id, type, label)
);
CREATE TABLE product (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000),
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  translations_json TEXT NOT NULL DEFAULT '{}',
  image_mime TEXT,
  image_data BYTEA,
  variant_group TEXT,
  variant_label TEXT,
  stock_quantity INTEGER CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, sku),
  CHECK ((image_mime IS NULL AND image_data IS NULL) OR
         (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
);
CREATE INDEX product_public ON product(shop_id, active, category, updated_at);
CREATE UNIQUE INDEX product_variant_option ON product(shop_id, variant_group, lower(variant_label));
CREATE INDEX product_variant_group ON product(shop_id, variant_group, active);
CREATE FUNCTION require_active_product_category() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.category <> OLD.category THEN
    IF NOT EXISTS (SELECT 1 FROM general_code WHERE shop_id = NEW.shop_id AND type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1) THEN
      RAISE EXCEPTION 'Unknown active product category';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_category_guard BEFORE INSERT OR UPDATE OF category ON product
  FOR EACH ROW EXECUTE FUNCTION require_active_product_category();
CREATE TABLE order_sequence (
  shop_id TEXT PRIMARY KEY REFERENCES shop(id) ON DELETE RESTRICT,
  value BIGINT NOT NULL CHECK (value >= 0)
);
INSERT INTO order_sequence(shop_id, value) SELECT id, 0 FROM shop;
CREATE TABLE shop_order (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  order_no TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  buyer_email TEXT,
  whatsapp_opt_in INTEGER NOT NULL CHECK (whatsapp_opt_in IN (0, 1)),
  whatsapp_consent_at TEXT,
  whatsapp_consent_version TEXT,
  locale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
  total_minor BIGINT NOT NULL CHECK (total_minor >= 0),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tracking_carrier TEXT,
  tracking_no TEXT,
  UNIQUE (shop_id, order_no),
  CHECK ((whatsapp_opt_in = 0 AND whatsapp_consent_at IS NULL AND whatsapp_consent_version IS NULL) OR
         (whatsapp_opt_in = 1 AND whatsapp_consent_at IS NOT NULL AND whatsapp_consent_version IS NOT NULL))
);
CREATE INDEX shop_order_queue ON shop_order(shop_id, status, submitted_at DESC);
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
);
CREATE TABLE order_item (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  sku_snapshot TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
  UNIQUE(delivery_id, position)
);
CREATE TABLE order_event (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('GUEST', 'SELLER')),
  actor_id TEXT,
  previous_status TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX order_event_history ON order_event(order_id, id);
CREATE TABLE checkout_idempotency (
  shop_id TEXT NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, key_hash)
);
CREATE TABLE company_setting (
  shop_id TEXT PRIMARY KEY REFERENCES shop(id) ON DELETE RESTRICT,
  default_currency TEXT NOT NULL CHECK (default_currency IN ('MYR', 'SGD')),
  seller_whatsapp_phone TEXT CHECK (seller_whatsapp_phone IS NULL OR seller_whatsapp_phone ~ '^[0-9]{8,15}$'),
  mobile_hide_bars_on_scroll INTEGER NOT NULL DEFAULT 0 CHECK (mobile_hide_bars_on_scroll IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO company_setting(shop_id, default_currency, updated_at)
  SELECT id, 'MYR', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM shop;
CREATE TABLE rate_limit_attempt (
  id BIGSERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  attempted_at BIGINT NOT NULL
);
CREATE INDEX rate_limit_lookup ON rate_limit_attempt(bucket, key_hash);
CREATE INDEX rate_limit_expiry ON rate_limit_attempt(bucket, attempted_at);
CREATE TABLE product_gallery_image (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(product_id, position)
);
CREATE INDEX product_gallery_product ON product_gallery_image(product_id, position);
INSERT INTO schema_meta(id, version) VALUES (1, ${SCHEMA_VERSION});
`;

// Schema version 13 had one implicit shop. Existing rows become the default shop "main".
const NOW = "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
const upgradeFrom13 = `
CREATE TABLE shop (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  mode TEXT CHECK (mode IN ('demo', 'production')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE shop_code_alias (
  code TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
INSERT INTO shop(id, code, name, status, mode, created_at, updated_at)
  SELECT gen_random_uuid()::text, 'main', shop_name, 'ACTIVE', mode, ${NOW}, ${NOW} FROM shop_setup WHERE id = 1;
ALTER TABLE general_code ADD COLUMN shop_id TEXT;
UPDATE general_code SET shop_id = (SELECT id FROM shop);
ALTER TABLE general_code ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE general_code ADD FOREIGN KEY (shop_id) REFERENCES shop(id) ON DELETE RESTRICT;
ALTER TABLE general_code DROP CONSTRAINT general_code_pkey;
ALTER TABLE general_code DROP CONSTRAINT general_code_type_label_key;
ALTER TABLE general_code ADD PRIMARY KEY (shop_id, type, code);
ALTER TABLE general_code ADD UNIQUE (shop_id, type, label);
ALTER TABLE product ADD COLUMN shop_id TEXT;
UPDATE product SET shop_id = (SELECT id FROM shop);
ALTER TABLE product ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE product ADD FOREIGN KEY (shop_id) REFERENCES shop(id) ON DELETE RESTRICT;
ALTER TABLE product DROP CONSTRAINT product_sku_key;
ALTER TABLE product ADD UNIQUE (shop_id, sku);
DROP INDEX product_public;
DROP INDEX product_variant_option;
DROP INDEX product_variant_group;
CREATE INDEX product_public ON product(shop_id, active, category, updated_at);
CREATE UNIQUE INDEX product_variant_option ON product(shop_id, variant_group, lower(variant_label));
CREATE INDEX product_variant_group ON product(shop_id, variant_group, active);
CREATE OR REPLACE FUNCTION require_active_product_category() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.category <> OLD.category THEN
    IF NOT EXISTS (SELECT 1 FROM general_code WHERE shop_id = NEW.shop_id AND type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1) THEN
      RAISE EXCEPTION 'Unknown active product category';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER TABLE shop_order ADD COLUMN shop_id TEXT;
UPDATE shop_order SET shop_id = (SELECT id FROM shop);
ALTER TABLE shop_order ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE shop_order ADD FOREIGN KEY (shop_id) REFERENCES shop(id) ON DELETE RESTRICT;
ALTER TABLE shop_order DROP CONSTRAINT shop_order_order_no_key;
ALTER TABLE shop_order ADD UNIQUE (shop_id, order_no);
DROP INDEX shop_order_queue;
CREATE INDEX shop_order_queue ON shop_order(shop_id, status, submitted_at DESC);
ALTER TABLE checkout_idempotency ADD COLUMN shop_id TEXT;
UPDATE checkout_idempotency SET shop_id = (SELECT id FROM shop);
ALTER TABLE checkout_idempotency ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE checkout_idempotency ADD FOREIGN KEY (shop_id) REFERENCES shop(id) ON DELETE RESTRICT;
ALTER TABLE checkout_idempotency DROP CONSTRAINT checkout_idempotency_pkey;
ALTER TABLE checkout_idempotency ADD PRIMARY KEY (shop_id, key_hash);
ALTER TABLE company_setting ADD COLUMN shop_id TEXT;
UPDATE company_setting SET shop_id = (SELECT id FROM shop);
ALTER TABLE company_setting DROP CONSTRAINT company_setting_pkey;
ALTER TABLE company_setting DROP COLUMN id;
ALTER TABLE company_setting ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE company_setting ADD PRIMARY KEY (shop_id);
ALTER TABLE company_setting ADD FOREIGN KEY (shop_id) REFERENCES shop(id) ON DELETE RESTRICT;
ALTER TABLE order_sequence ADD COLUMN shop_id TEXT;
UPDATE order_sequence SET shop_id = (SELECT id FROM shop);
ALTER TABLE order_sequence DROP CONSTRAINT order_sequence_pkey;
ALTER TABLE order_sequence DROP COLUMN id;
ALTER TABLE order_sequence ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE order_sequence ADD PRIMARY KEY (shop_id);
ALTER TABLE order_sequence ADD FOREIGN KEY (shop_id) REFERENCES shop(id) ON DELETE RESTRICT;
DROP TABLE shop_setup;
UPDATE schema_meta SET version = 14 WHERE id = 1;
`;

export function initializePostgresSchema(query) {
  const existing = query("SELECT to_regclass('public.schema_meta') AS name")[0]?.name;
  if (existing) {
    const version = query('SELECT version FROM schema_meta WHERE id = 1')[0]?.version;
    if (version === SCHEMA_VERSION) return;
    if (version !== 13) throw new Error(`Unsupported PostgreSQL schema version ${version}.`);
    query('BEGIN');
    try {
      query(upgradeFrom13);
      query('COMMIT');
    } catch (error) {
      query('ROLLBACK');
      throw error;
    }
    return;
  }
  const tables = query("SELECT COUNT(*)::integer AS count FROM pg_tables WHERE schemaname = current_schema()")[0].count;
  if (tables !== 0) throw new Error('PostgreSQL database is not empty and has no application schema version.');
  query('BEGIN');
  try {
    query(schema);
    query('COMMIT');
  } catch (error) {
    query('ROLLBACK');
    throw error;
  }
}
