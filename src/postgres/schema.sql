-- PostgreSQL baseline matching SQLite schema 17. Timestamps stay ISO text to preserve API snapshots.
CREATE TABLE admin (
        id BIGINT PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, account_id TEXT
      );
CREATE TABLE seller_account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 64),
  username_key TEXT NOT NULL UNIQUE CHECK (length(username_key) BETWEEN 3 AND 64),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'STAFF')),
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password BIGINT NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, password_changed_at TEXT, last_login_at TEXT
);
CREATE TABLE account_event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES seller_account(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'ROLE_CHANGED', 'DEACTIVATED', 'ACTIVATED', 'PASSWORD_RESET', 'PASSWORD_CHANGED')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  created_at TEXT NOT NULL
);
CREATE INDEX account_event_time ON account_event(created_at);
CREATE TABLE general_code (
        type TEXT NOT NULL CHECK (type = 'PRODUCT_CATEGORY'),
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        active BIGINT NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (type, code),
        UNIQUE (type, label)
      );
CREATE TABLE company_setting (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  default_currency TEXT NOT NULL CHECK (default_currency IN ('MYR', 'SGD')),
  updated_at TEXT NOT NULL,
  seller_whatsapp_phone TEXT CHECK (seller_whatsapp_phone IS NULL OR
    (length(seller_whatsapp_phone) BETWEEN 8 AND 15 AND seller_whatsapp_phone ~ '^[0-9]+$')),
  mobile_hide_bars_on_scroll BIGINT NOT NULL DEFAULT 0 CHECK (mobile_hide_bars_on_scroll IN (0, 1)),
  availability_text TEXT CHECK (availability_text IS NULL OR length(availability_text) BETWEEN 1 AND 1000),
  shipping_text TEXT CHECK (shipping_text IS NULL OR length(shipping_text) BETWEEN 1 AND 1000),
  returns_text TEXT CHECK (returns_text IS NULL OR length(returns_text) BETWEEN 1 AND 1000)
);
CREATE TABLE shop_setup (
        id BIGINT PRIMARY KEY CHECK (id = 1),
        mode TEXT CHECK (mode IN ('demo', 'production')),
        shop_name TEXT NOT NULL
      );
CREATE TABLE listing (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE "product" (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        price_minor BIGINT NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        active BIGINT NOT NULL CHECK (active IN (0, 1)),
        translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
        gallery_layout_json TEXT CHECK (gallery_layout_json IS NULL OR jsonb_typeof(gallery_layout_json::jsonb) = 'array'),
        image_mime TEXT,
        image_data BYTEA,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, variant_group TEXT, variant_label TEXT, listing_id TEXT NOT NULL REFERENCES listing(id) ON DELETE RESTRICT, thumb_mime TEXT CHECK (thumb_mime IS NULL OR thumb_mime IN ('image/png', 'image/jpeg', 'image/webp')), thumb_data BYTEA, stock_quantity BIGINT
        CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000),
        CHECK ((image_mime IS NULL AND image_data IS NULL) OR
               (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
      );
CREATE TABLE "product_gallery_image" (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        position BIGINT NOT NULL CHECK (position BETWEEN 1 AND 10),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
        data BYTEA NOT NULL,
        created_at TEXT NOT NULL,
        thumb_mime TEXT CHECK (thumb_mime IS NULL OR thumb_mime IN ('image/png', 'image/jpeg', 'image/webp')),
        thumb_data BYTEA,
        UNIQUE(product_id, position)
      );
CREATE TABLE order_sequence (
        id BIGINT PRIMARY KEY CHECK (id = 1),
        value BIGINT NOT NULL CHECK (value >= 0)
      );
CREATE TABLE "shop_order" (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
        buyer_name TEXT NOT NULL,
        buyer_phone TEXT NOT NULL,
        buyer_email TEXT,
        whatsapp_opt_in BIGINT NOT NULL CHECK (whatsapp_opt_in IN (0, 1)),
        whatsapp_consent_at TEXT,
        whatsapp_consent_version TEXT,
        locale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
        revision BIGINT NOT NULL CHECK (revision >= 1),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        total_minor BIGINT NOT NULL CHECK (total_minor >= 0),
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, tracking_carrier TEXT, tracking_no TEXT, contact_erased_at TEXT, contact_erased_by TEXT,
        CHECK ((whatsapp_opt_in = 0 AND whatsapp_consent_at IS NULL AND whatsapp_consent_version IS NULL) OR
               (whatsapp_opt_in = 1 AND whatsapp_consent_at IS NOT NULL AND whatsapp_consent_version IS NOT NULL))
      );
CREATE TABLE delivery (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
        position BIGINT NOT NULL CHECK (position >= 0),
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
CREATE TABLE "order_item" (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
        position BIGINT NOT NULL CHECK (position >= 0),
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        sku_snapshot TEXT NOT NULL,
        name_snapshot TEXT NOT NULL,
        price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
        quantity BIGINT NOT NULL CHECK (quantity BETWEEN 1 AND 100),
        line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        UNIQUE(delivery_id, position)
      );
CREATE TABLE "order_event" (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('GUEST', 'SELLER')),
        actor_id TEXT,
        previous_status TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        occurred_at TEXT NOT NULL
      );
CREATE TABLE checkout_idempotency (
        key_hash TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );
CREATE TABLE rate_limit_attempt (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        bucket TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        attempted_at BIGINT NOT NULL
      );
CREATE INDEX session_expiry ON session(expires_at);
CREATE INDEX product_public ON product(active, category, updated_at);
CREATE INDEX rate_limit_lookup ON rate_limit_attempt(bucket, key_hash);
CREATE INDEX rate_limit_expiry ON rate_limit_attempt(bucket, attempted_at);
CREATE UNIQUE INDEX product_variant_option ON product(variant_group, lower(variant_label));
CREATE INDEX product_variant_group ON product(variant_group, active);
CREATE INDEX product_gallery_product ON product_gallery_image(product_id, position);
CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC);
CREATE INDEX order_event_history ON order_event(order_id, id);
CREATE TABLE schema_meta (id BIGINT PRIMARY KEY CHECK(id = 1), version BIGINT NOT NULL);
CREATE TABLE option_type (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 60),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
  display TEXT NOT NULL DEFAULT 'button' CHECK (display IN ('button', 'swatch', 'image', 'dropdown')),
  position BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX option_type_code ON option_type(lower(code));
CREATE TABLE option_value (
  id TEXT PRIMARY KEY,
  option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 60),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
  swatch_color TEXT CHECK (swatch_color IS NULL OR swatch_color ~ '^#[0-9a-fA-F]{6}$'),
  position BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX option_value_code ON option_value(option_type_id, lower(code));
CREATE TABLE product_option (
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
  option_value_id TEXT NOT NULL REFERENCES option_value(id) ON DELETE RESTRICT,
  PRIMARY KEY (product_id, option_type_id)
);
CREATE INDEX product_option_value ON product_option(option_value_id);
CREATE INDEX product_listing ON product(listing_id);
CREATE TABLE integration_connection (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED')),
  public_config TEXT NOT NULL DEFAULT '{}' CHECK (public_config::jsonb IS NOT NULL),
  secret_ciphertext BYTEA,
  secret_key_id TEXT CHECK (secret_key_id IS NULL OR length(secret_key_id) BETWEEN 1 AND 32),
  secret_hint TEXT CHECK (secret_hint IS NULL OR length(secret_hint) <= 12),
  last_checked_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (provider, environment),
  CHECK ((secret_ciphertext IS NULL) = (secret_key_id IS NULL))
);
CREATE TABLE integration_audit (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  action TEXT NOT NULL CHECK (action IN ('CONNECT', 'ROTATE', 'DISCONNECT', 'CHECK_FAILED', 'RISK_ACKNOWLEDGED')),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at TEXT NOT NULL
);
CREATE INDEX integration_audit_time ON integration_audit(created_at);
CREATE TABLE webhook_receipt (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  verified BIGINT NOT NULL CHECK (verified IN (0, 1)),
  received_at TEXT NOT NULL,
  UNIQUE (provider, dedupe_key)
);
CREATE TABLE message_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('ORDER_SUBMITTED', 'ORDER_CONFIRMED', 'ORDER_REJECTED', 'ORDER_SHIPPED')),
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) BETWEEN 16 AND 128),
  template TEXT NOT NULL CHECK (length(template) BETWEEN 1 AND 100),
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 10),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'READ', 'FAILED', 'RECONCILE')),
  provider_message_id TEXT UNIQUE CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX message_outbox_due ON message_outbox(status, next_attempt_at);
CREATE INDEX message_outbox_order ON message_outbox(order_id);
CREATE TABLE message_inbound (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES shop_order(id) ON DELETE RESTRICT,
  from_hash TEXT NOT NULL CHECK (length(from_hash) BETWEEN 16 AND 128),
  provider_message_id TEXT NOT NULL UNIQUE CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('TEXT', 'MEDIA_UNSUPPORTED', 'OTHER')),
  body TEXT CHECK (body IS NULL OR length(body) <= 4096),
  received_at TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX message_inbound_order ON message_inbound(order_id);
CREATE INDEX message_inbound_unread ON message_inbound(received_at) WHERE read_at IS NULL;
INSERT INTO schema_meta VALUES (1, 23);
INSERT INTO order_sequence VALUES (1, 0);
INSERT INTO company_setting(id, default_currency, updated_at) VALUES (1, 'MYR', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
INSERT INTO shop_setup(id, mode, shop_name) VALUES (1, NULL, 'Online Shopping');
CREATE FUNCTION check_product_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.category = OLD.category THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1) THEN
    RAISE EXCEPTION 'Unknown active product category' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_category_insert BEFORE INSERT ON product FOR EACH ROW EXECUTE FUNCTION check_product_category();
CREATE TRIGGER product_category_update BEFORE UPDATE OF category ON product FOR EACH ROW EXECUTE FUNCTION check_product_category();
