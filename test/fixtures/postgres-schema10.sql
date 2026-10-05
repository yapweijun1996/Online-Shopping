-- Synthetic schema10 fixture from draft PR11 commit0e2ca70ae5e25304da00f645db030c8f8e46a401.

CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
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
  type TEXT NOT NULL CHECK (type = 'PRODUCT_CATEGORY'),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (type, code),
  UNIQUE (type, label)
);
CREATE TABLE product (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((image_mime IS NULL AND image_data IS NULL) OR
         (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
);
CREATE INDEX product_public ON product(active, category, updated_at);
CREATE UNIQUE INDEX product_variant_option ON product(variant_group, lower(variant_label));
CREATE INDEX product_variant_group ON product(variant_group, active);
CREATE FUNCTION require_active_product_category() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.category <> OLD.category THEN
    IF NOT EXISTS (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1) THEN
      RAISE EXCEPTION 'Unknown active product category';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_category_guard BEFORE INSERT OR UPDATE OF category ON product
  FOR EACH ROW EXECUTE FUNCTION require_active_product_category();
CREATE TABLE order_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value BIGINT NOT NULL CHECK (value >= 0)
);
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
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
  total_minor BIGINT NOT NULL CHECK (total_minor >= 0),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((whatsapp_opt_in = 0 AND whatsapp_consent_at IS NULL AND whatsapp_consent_version IS NULL) OR
         (whatsapp_opt_in = 1 AND whatsapp_consent_at IS NOT NULL AND whatsapp_consent_version IS NOT NULL))
);
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
  event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('GUEST', 'SELLER')),
  actor_id TEXT,
  previous_status TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX order_event_history ON order_event(order_id, id);
CREATE TABLE checkout_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TABLE company_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_currency TEXT NOT NULL CHECK (default_currency IN ('MYR', 'SGD')),
  seller_whatsapp_phone TEXT CHECK (seller_whatsapp_phone IS NULL OR seller_whatsapp_phone ~ '^[0-9]{8,15}$'),
  mobile_hide_bars_on_scroll INTEGER NOT NULL DEFAULT 0 CHECK (mobile_hide_bars_on_scroll IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO company_setting(id, default_currency, updated_at)
  VALUES (1, 'MYR', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
CREATE TABLE rate_limit_attempt (
  id BIGSERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  attempted_at BIGINT NOT NULL
);
CREATE INDEX rate_limit_lookup ON rate_limit_attempt(bucket, key_hash);
CREATE INDEX rate_limit_expiry ON rate_limit_attempt(bucket, attempted_at);
CREATE TABLE shop_setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT CHECK (mode IN ('demo', 'production')),
  shop_name TEXT NOT NULL
);
INSERT INTO shop_setup(id, mode, shop_name) VALUES (1, NULL, 'Online Shopping');
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
INSERT INTO schema_meta(id, version) VALUES (1, 10);
