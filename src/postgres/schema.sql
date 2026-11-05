-- PostgreSQL baseline matching SQLite schema 30. Timestamps stay ISO text to preserve API snapshots.
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
  sender_name TEXT CHECK (sender_name IS NULL OR length(sender_name) BETWEEN 1 AND 120),
  sender_phone TEXT CHECK (sender_phone IS NULL OR (length(sender_phone) BETWEEN 8 AND 15 AND sender_phone ~ '^[0-9]+$')),
  sender_address_line1 TEXT CHECK (sender_address_line1 IS NULL OR length(sender_address_line1) BETWEEN 1 AND 240),
  sender_address_line2 TEXT CHECK (sender_address_line2 IS NULL OR length(sender_address_line2) BETWEEN 1 AND 240),
  sender_city TEXT CHECK (sender_city IS NULL OR length(sender_city) BETWEEN 1 AND 120),
  sender_state TEXT CHECK (sender_state IS NULL OR length(sender_state) BETWEEN 1 AND 120),
  sender_postcode TEXT CHECK (sender_postcode IS NULL OR length(sender_postcode) BETWEEN 1 AND 20),
  sender_country TEXT CHECK (sender_country IS NULL OR (length(sender_country) BETWEEN 2 AND 2 AND sender_country ~ '^[A-Z]{2}$')),
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
CREATE TABLE order_note (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 64),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);
CREATE INDEX order_note_order ON order_note(order_id, created_at);
CREATE TABLE product_event (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED')),
  changes TEXT NOT NULL CHECK (changes::jsonb IS NOT NULL AND length(changes) <= 4000),
  created_at TEXT NOT NULL
);
CREATE INDEX product_event_product ON product_event(product_id, created_at);
CREATE TABLE ai_studio_credential (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 provider TEXT NOT NULL CHECK (provider = 'OPENAI'),
 sealed BYTEA NOT NULL, key_id TEXT NOT NULL, last4 TEXT NOT NULL CHECK (length(last4) = 4),
 revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ai_studio_setting (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 daily_call_cap INTEGER NOT NULL DEFAULT 20 CHECK (daily_call_cap BETWEEN 1 AND 500),
 key_generation INTEGER NOT NULL DEFAULT 0 CHECK (key_generation >= 0),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO ai_studio_setting (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z');
CREATE TABLE ai_studio_usage (
 id TEXT PRIMARY KEY, day TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('ANALYZE','IMAGE','REVIEW')),
 actor TEXT NOT NULL, product_id TEXT,
 outcome TEXT NOT NULL CHECK (outcome IN ('PENDING','OK','ERROR','AMBIGUOUS')), created_at TEXT NOT NULL
);
CREATE INDEX ai_studio_usage_day ON ai_studio_usage(day);
CREATE TABLE ai_studio_image (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL, gallery_image_id TEXT NOT NULL,
 style TEXT NOT NULL CHECK (style IN ('studio','hero','lifestyle','flat_lay','macro','ugc','billboard')),
 verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','WARN','FAIL')), issues_json TEXT NOT NULL DEFAULT '[]',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX ai_studio_image_product ON ai_studio_image(product_id);
INSERT INTO schema_meta VALUES (1, 30);
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

ALTER TABLE seller_account ADD COLUMN oauth_auth_version BIGINT NOT NULL DEFAULT 0 CHECK (oauth_auth_version >= 0);
CREATE TABLE oauth_client (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, issuer TEXT NOT NULL,
 client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 80),
 redirect_uris_json TEXT NOT NULL CHECK (jsonb_typeof(redirect_uris_json::jsonb) = 'array' AND jsonb_array_length(redirect_uris_json::jsonb) BETWEEN 1 AND 5),
 auth_method TEXT NOT NULL CHECK (auth_method = 'none'),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, disabled_at TEXT, last_used_at TEXT
);
CREATE INDEX oauth_client_expiry ON oauth_client(expires_at);
CREATE TABLE oauth_authorization_request (
 id TEXT PRIMARY KEY, browser_nonce_hash TEXT NOT NULL UNIQUE CHECK (length(browser_nonce_hash) = 64),
 client_id TEXT NOT NULL REFERENCES oauth_client(id) ON DELETE RESTRICT,
 tenant_id TEXT NOT NULL, resource TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT NOT NULL,
 challenge TEXT NOT NULL CHECK (length(challenge) = 43), challenge_method TEXT NOT NULL CHECK (challenge_method = 'S256'),
 scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 account_id TEXT REFERENCES seller_account(id) ON DELETE RESTRICT, session_proof_hash TEXT,
 account_auth_version BIGINT, consumed_at TEXT
);
CREATE INDEX oauth_request_expiry ON oauth_authorization_request(expires_at);
CREATE TABLE oauth_grant (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES seller_account(id) ON DELETE RESTRICT,
 client_id TEXT NOT NULL REFERENCES oauth_client(id) ON DELETE RESTRICT,
 tenant_id TEXT NOT NULL, issuer TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL,
 account_auth_version BIGINT NOT NULL CHECK (account_auth_version >= 0), created_at TEXT NOT NULL,
 absolute_expires_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT,
 UNIQUE (id, account_id, client_id)
);
CREATE INDEX oauth_grant_account ON oauth_grant(account_id, revoked_at);
CREATE INDEX oauth_grant_client ON oauth_grant(client_id);
CREATE TABLE oauth_authorization_code (
 code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64), grant_id TEXT NOT NULL REFERENCES oauth_grant(id) ON DELETE RESTRICT,
 redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, challenge TEXT NOT NULL CHECK (length(challenge) = 43),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE oauth_token (
 token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64), kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
 grant_id TEXT NOT NULL REFERENCES oauth_grant(id) ON DELETE RESTRICT, resource TEXT NOT NULL, scopes TEXT NOT NULL,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT,
 generation BIGINT NOT NULL CHECK (generation >= 0),
 predecessor_hash TEXT REFERENCES oauth_token(token_hash) ON DELETE RESTRICT,
 UNIQUE (grant_id, kind, generation)
);
CREATE INDEX oauth_token_grant_expiry ON oauth_token(grant_id, expires_at);
CREATE INDEX oauth_token_predecessor ON oauth_token(predecessor_hash);
CREATE TABLE mcp_audit (
 id TEXT PRIMARY KEY, at TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT, client_id TEXT, grant_id TEXT,
 correlation_id TEXT NOT NULL,
 event TEXT NOT NULL CHECK (event IN ('AUTHORIZE','ISSUE','REVOKE','READ','DENY','INVALIDATE')),
 tool_name TEXT CHECK (tool_name IS NULL OR tool_name IN ('catalog.list','catalog.get','catalog.history','catalog.categories','catalog.low_stock','orders.list','orders.get','analytics.summary')),
 resource_id TEXT, outcome TEXT NOT NULL,
 duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0), result_count BIGINT NOT NULL CHECK (result_count >= 0)
);
CREATE INDEX mcp_audit_time ON mcp_audit(at);

CREATE TABLE whatsapp_qr_session (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 desired TEXT NOT NULL CHECK (desired IN ('OFF','PAIR','RUN')),
 state TEXT NOT NULL CHECK (state IN ('IDLE','PAIRING','CONNECTING','CONNECTED','RECONNECTING','LOGGED_OUT','ERROR')),
 generation INTEGER NOT NULL CHECK (generation > 0), auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
 qr_text TEXT, qr_expires_at TEXT, pair_started_at TEXT, phone_masked TEXT, phone_hash TEXT, last_error TEXT,
 lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT, last_claim_at TEXT,
 acknowledged_at TEXT, acknowledged_by TEXT, ack_notice_version TEXT,
 peer_key_sealed BYTEA, peer_key_id TEXT, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO whatsapp_qr_session (id,desired,state,generation,auth_version,revision,updated_at)
 VALUES (1,'OFF','IDLE',1,0,1,'1970-01-01T00:00:00.000Z');
CREATE TABLE whatsapp_qr_auth (
 generation INTEGER NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0), chunk_count INTEGER NOT NULL CHECK (chunk_count > 0 AND chunk_index < chunk_count),
 ciphertext BYTEA NOT NULL, key_id TEXT NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY (generation,record_type,record_id,chunk_index)
);
CREATE TABLE message_peer_suppression (
 phone_hash TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK (reason IN ('ERASED')), created_at TEXT NOT NULL
);
CREATE TABLE message_thread (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (provider = 'WHATSAPP_QR'), peer_hash TEXT NOT NULL UNIQUE,
 peer_sealed BYTEA, peer_key_id TEXT NOT NULL, display_name TEXT,
 phone_hash TEXT, last_inbound_at TEXT, last_message_at TEXT, unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
 suppressed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE message_thread_message (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES message_thread(id),
 direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')), provider_message_id TEXT,
 body TEXT CHECK (body IS NULL OR length(body) <= 4096),
 status TEXT NOT NULL CHECK (status IN ('RECEIVED','QUEUED','SENDING','SENT','FAILED','RECONCILE','CANCELLED')),
 error_code TEXT, actor TEXT, idempotency_key TEXT, body_digest TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 lease_expires_at TEXT, generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX qr_inbound_id ON message_thread_message(provider_message_id) WHERE direction = 'IN';
CREATE UNIQUE INDEX qr_reply_intent ON message_thread_message(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX qr_thread_time ON message_thread_message(thread_id,created_at,id);
CREATE INDEX qr_message_status ON message_thread_message(status,created_at,id);

CREATE TABLE ai_setting (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
 level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 0 AND 1),
 tone TEXT NOT NULL DEFAULT '' CHECK (length(tone) <= 300),
 business_notes TEXT NOT NULL DEFAULT '' CHECK (length(business_notes) <= 3000),
 daily_token_cap INTEGER NOT NULL DEFAULT 100000 CHECK (daily_token_cap BETWEEN 1000 AND 2000000),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO ai_setting (id, updated_at) VALUES (1,'1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
CREATE TABLE ai_usage (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('SUGGEST')),
 actor TEXT NOT NULL, thread_id TEXT,
 input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
 output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
 outcome TEXT NOT NULL CHECK (outcome IN ('OK','HANDOFF','ERROR','CAP')), created_at TEXT NOT NULL
);
CREATE INDEX ai_usage_day ON ai_usage(day);
CREATE TABLE ai_suggestion_audit (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
 action TEXT NOT NULL DEFAULT 'SUGGEST' CHECK (action IN ('SUGGEST','SETTINGS_UPDATED'))
);

-- MCP v2 durable operation storage, including self-contained compatibility metadata.

CREATE TABLE IF NOT EXISTS mcp_v2_authorization_request (
  request_id TEXT PRIMARY KEY REFERENCES oauth_authorization_request(id) ON DELETE CASCADE,
  epoch_hash TEXT NOT NULL CHECK (length(epoch_hash) = 64 AND epoch_hash ~ '^[0-9a-f]{64}$'),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_v2_scope_consent (
  grant_id TEXT NOT NULL REFERENCES oauth_grant(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, client_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('company.read','company.write','catalog.write','media.read','media.write','inventory.read','inventory.adjust','orders.decide','analytics.extended','operations.read','operations.cancel')),
  account_auth_version BIGINT NOT NULL CHECK (account_auth_version >= 0),
  epoch_hash TEXT NOT NULL CHECK (length(epoch_hash) = 64 AND epoch_hash ~ '^[0-9a-f]{64}$'),
  consented_at TEXT NOT NULL,
  PRIMARY KEY (grant_id, scope)
);
CREATE TABLE IF NOT EXISTS mcp_v2_operation (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tenant_revision BIGINT NOT NULL CHECK (tenant_revision >= 0), account_id TEXT NOT NULL,
  client_id TEXT NOT NULL, grant_id TEXT NOT NULL, epoch_hash TEXT NOT NULL CHECK (length(epoch_hash) = 64 AND epoch_hash ~ '^[0-9a-f]{64}$'),
  build_digest TEXT NOT NULL CHECK (length(build_digest) = 64 AND build_digest ~ '^[0-9a-f]{64}$'),
  issuer TEXT NOT NULL, resource TEXT NOT NULL,
  tool_name TEXT NOT NULL, required_scope TEXT NOT NULL CHECK (required_scope IN ('company.read','company.write','catalog.write','media.read','media.write','inventory.read','inventory.adjust','orders.decide','analytics.extended','operations.read','operations.cancel')),
  required_capability TEXT NOT NULL, risk TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  resource_type TEXT NOT NULL, resource_id TEXT, expected_revision TEXT,
  envelope_json TEXT CHECK (envelope_json IS NULL OR (length(envelope_json) >= 2 AND length(envelope_json) <= 65536 AND jsonb_typeof(envelope_json::jsonb) = 'object')),
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64 AND preview_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_hash TEXT NOT NULL CHECK (length(idempotency_hash) = 64 AND idempotency_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','PENDING_APPROVAL','APPROVED','COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > created_at), correlation_id TEXT NOT NULL,
  receipt_expires_at TEXT NOT NULL CHECK (receipt_expires_at > expires_at),
  redacted_at TEXT CHECK (redacted_at IS NULL OR redacted_at >= expires_at),
  result_json TEXT CHECK (result_json IS NULL OR (length(result_json) <= 65536 AND jsonb_typeof(result_json::jsonb) = 'object')),
  CHECK ((redacted_at IS NULL AND envelope_json IS NOT NULL) OR
    (redacted_at IS NOT NULL AND envelope_json IS NULL AND state IN ('COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED'))),
  UNIQUE (tenant_id, account_id, client_id, idempotency_hash)
);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_expiry ON mcp_v2_operation(expires_at, state);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_receipt_expiry ON mcp_v2_operation(receipt_expires_at, id);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_grant ON mcp_v2_operation(grant_id, state);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_tenant_active ON mcp_v2_operation(tenant_id, state, expires_at);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_client_active ON mcp_v2_operation(tenant_id, client_id, state, expires_at);
CREATE TABLE IF NOT EXISTS mcp_v2_approval_challenge (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64 AND nonce_hash ~ '^[0-9a-f]{64}$'),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > created_at), account_id TEXT,
  session_hash TEXT, account_auth_version BIGINT, bound_at TEXT, consumed_at TEXT,
  CHECK ((account_id IS NULL AND session_hash IS NULL AND account_auth_version IS NULL AND bound_at IS NULL)
    OR (account_id IS NOT NULL AND session_hash IS NOT NULL AND length(session_hash) = 64 AND session_hash ~ '^[0-9a-f]{64}$'
      AND account_auth_version IS NOT NULL AND account_auth_version >= 0 AND bound_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mcp_v2_challenge_expiry ON mcp_v2_approval_challenge(expires_at);
CREATE INDEX IF NOT EXISTS mcp_v2_challenge_operation ON mcp_v2_approval_challenge(operation_id);
CREATE TABLE IF NOT EXISTS mcp_v2_approval (
  operation_id TEXT PRIMARY KEY REFERENCES mcp_v2_operation(id) ON DELETE CASCADE,
  approver_id TEXT NOT NULL, session_hash TEXT NOT NULL CHECK (length(session_hash) = 64 AND session_hash ~ '^[0-9a-f]{64}$'),
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) = 64 AND preview_hash ~ '^[0-9a-f]{64}$'),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  approved_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > approved_at), consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS mcp_v2_event (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT,
  client_id TEXT, grant_id TEXT, tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128), resource_id TEXT,
  operation_id TEXT NOT NULL, approver_id TEXT,
  event TEXT NOT NULL CHECK (event IN ('PREPARE','REQUEST_APPROVAL','APPROVE','REJECT','COMMIT','CANCEL','EXPIRE','CONFLICT','FAIL','DENY')),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 80), correlation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_v2_event_time ON mcp_v2_event(at);
CREATE INDEX IF NOT EXISTS mcp_v2_event_operation ON mcp_v2_event(operation_id, at);

CREATE TABLE mcp_v2_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1),
      ddl_digest TEXT NOT NULL CHECK (length(ddl_digest) = 64),
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64)
    );
INSERT INTO mcp_v2_schema(id, version, ddl_digest, manifest_digest)
    VALUES (1, 1, '5deabb4f780c68580da9f23d85e2c80a33d1ce7ea194b39cf4567e6adc01ce6b', (SELECT encode(sha256(convert_to(jsonb_build_object(
    'tables', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name, ordinal_position) FROM (
      SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'mcp!_v2!_%' ESCAPE '!'
    ) t), '[]'::jsonb),
    'constraints', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name, conname) FROM (
      SELECT r.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND r.relname LIKE 'mcp!_v2!_%' ESCAPE '!'
    ) c), '[]'::jsonb),
    'indexes', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY tablename, indexname) FROM (
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename LIKE 'mcp!_v2!_%' ESCAPE '!'
    ) i), '[]'::jsonb)
  )::text, 'UTF8')), 'hex') AS digest));
