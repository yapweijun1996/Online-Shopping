import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from '../db.js';
import { migrateLegacyVariants } from '../options.js';
import { migrateListings } from '../listings.js';
import { migrateSharedGalleries } from '../product-gallery.js';

// Tenant upgrades use their own roles and must never grant the legacy application's role access.
const legacyApplicationGrant = `current_database() !~ '^t_[a-z0-9]{3,30}_[0-9a-f]{8}$'
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'online_shopping_app')`;

// Called only by an explicit operator/test opt-in, inside the store-owned transaction.
export async function upgradePostgres(store, version) {
  if (![10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].includes(version)) throw new Error(`Unsupported PostgreSQL schema version ${version}.`);
  const columns = await store.all("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='product'");
  const has = name => columns.some(row => row.column_name === name);
  if (version === 13 && !has('stock_quantity') && !has('gallery_layout_json')) throw new Error('Unrecognized PostgreSQL product schema.');
  if (!has('stock_quantity')) await store.exec('ALTER TABLE product ADD COLUMN stock_quantity BIGINT CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000)');
  if (!has('gallery_layout_json')) await store.exec("ALTER TABLE product ADD COLUMN gallery_layout_json TEXT CHECK (gallery_layout_json IS NULL OR jsonb_typeof(gallery_layout_json::jsonb) = 'array')");
  if (!has('translations_json')) await store.exec("ALTER TABLE product ADD COLUMN translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL)");
  for (const [table, column, values] of [
    ['product_gallery_image','position','position BETWEEN 1 AND 10'],
    ['shop_order','status',"status IN ('SUBMITTED','CONFIRMED','REJECTED','SHIPPED','DELIVERED','CANCELLED')"],
    ['order_event','event_type',"event_type IN ('SUBMITTED','CONFIRMED','REJECTED','SHIPPED','DELIVERED','CANCELLED')"],
  ]) {
    // Only replace the known single-column constraints; retain unrelated checks.
    const constraints = await store.all(`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname='public' AND r.relname=? AND c.contype='c'`, table);
    const matches = constraints.filter(row => new RegExp(`\\b${column}\\b`).test(row.definition));
    if (matches.length !== 1) throw new Error(`Unrecognized ${table}.${column} constraints.`);
    const constraint = matches[0].conname.replaceAll('"','""');
    await store.exec(`ALTER TABLE ${table} DROP CONSTRAINT "${constraint}"; ALTER TABLE ${table} ADD CHECK (${values})`);
  }
  await store.exec('ALTER TABLE shop_order ADD COLUMN IF NOT EXISTS tracking_carrier TEXT; ALTER TABLE shop_order ADD COLUMN IF NOT EXISTS tracking_no TEXT');
  await store.exec('ALTER TABLE shop_order ADD COLUMN IF NOT EXISTS contact_erased_at TEXT; ALTER TABLE shop_order ADD COLUMN IF NOT EXISTS contact_erased_by TEXT');
  for (const column of ['availability_text', 'shipping_text', 'returns_text']) {
    await store.exec(`ALTER TABLE company_setting ADD COLUMN IF NOT EXISTS ${column} TEXT CHECK (${column} IS NULL OR length(${column}) BETWEEN 1 AND 1000)`);
  }
  await store.exec(`
    CREATE TABLE IF NOT EXISTS option_type (
      id TEXT PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 60), name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
      translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
      display TEXT NOT NULL DEFAULT 'button' CHECK (display IN ('button', 'swatch', 'image', 'dropdown')),
      position BIGINT NOT NULL DEFAULT 0, active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS option_type_code ON option_type(lower(code));
    CREATE TABLE IF NOT EXISTS option_value (
      id TEXT PRIMARY KEY, option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
      code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 60), label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
      translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
      swatch_color TEXT CHECK (swatch_color IS NULL OR swatch_color ~ '^#[0-9a-fA-F]{6}$'),
      position BIGINT NOT NULL DEFAULT 0, active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS option_value_code ON option_value(option_type_id, lower(code));
    CREATE TABLE IF NOT EXISTS product_option (
      product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
      option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
      option_value_id TEXT NOT NULL REFERENCES option_value(id) ON DELETE RESTRICT,
      PRIMARY KEY (product_id, option_type_id));
    CREATE INDEX IF NOT EXISTS product_option_value ON product_option(option_value_id);
    -- The application role was granted the tables that existed when it was created; give it the new ones.
    DO $$ BEGIN
      IF ${legacyApplicationGrant} THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON option_type, option_value, product_option TO online_shopping_app;
      END IF;
    END $$;`);
  await migrateLegacyVariants(store);
  await store.exec(`
    CREATE TABLE IF NOT EXISTS listing (
      id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    ALTER TABLE product ADD COLUMN IF NOT EXISTS listing_id TEXT REFERENCES listing(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS product_listing ON product(listing_id);
    DO $$ BEGIN
      IF ${legacyApplicationGrant} THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON listing TO online_shopping_app;
      END IF;
    END $$;`);
  await migrateListings(store);
  await store.exec('ALTER TABLE product ALTER COLUMN listing_id SET NOT NULL');
  // The gallery copy reads the preview columns, so they are added first.
  for (const table of ['product', 'product_gallery_image']) {
    await store.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS thumb_mime TEXT CHECK (thumb_mime IS NULL OR thumb_mime IN ('image/png', 'image/jpeg', 'image/webp'));
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS thumb_data BYTEA`);
  }
  await migrateSharedGalleries(store);
  await store.exec(`
CREATE TABLE IF NOT EXISTS integration_connection (
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
CREATE TABLE IF NOT EXISTS integration_audit (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  action TEXT NOT NULL CHECK (action IN ('CONNECT', 'ROTATE', 'DISCONNECT', 'CHECK_FAILED', 'RISK_ACKNOWLEDGED')),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_audit_time ON integration_audit(created_at);
CREATE TABLE IF NOT EXISTS webhook_receipt (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  verified BIGINT NOT NULL CHECK (verified IN (0, 1)),
  received_at TEXT NOT NULL,
  UNIQUE (provider, dedupe_key)
);
CREATE TABLE IF NOT EXISTS message_outbox (
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
CREATE INDEX IF NOT EXISTS message_outbox_due ON message_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS message_outbox_order ON message_outbox(order_id);
CREATE TABLE IF NOT EXISTS message_inbound (
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
CREATE INDEX IF NOT EXISTS message_inbound_order ON message_inbound(order_id);
CREATE INDEX IF NOT EXISTS message_inbound_unread ON message_inbound(received_at) WHERE read_at IS NULL;

    DO $$ BEGIN
      IF ${legacyApplicationGrant} THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON integration_connection, integration_audit, webhook_receipt, message_outbox, message_inbound TO online_shopping_app;
      END IF;
    END $$;`);
  await store.exec(`
CREATE TABLE IF NOT EXISTS seller_account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 64),
  username_key TEXT NOT NULL UNIQUE CHECK (length(username_key) BETWEEN 3 AND 64),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'STAFF')),
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password BIGINT NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, password_changed_at TEXT, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS account_event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES seller_account(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'ROLE_CHANGED', 'DEACTIVATED', 'ACTIVATED', 'PASSWORD_RESET', 'PASSWORD_CHANGED')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_event_time ON account_event(created_at);
ALTER TABLE session ADD COLUMN IF NOT EXISTS account_id TEXT;
DO $$ BEGIN
  IF ${legacyApplicationGrant} THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON seller_account, account_event TO online_shopping_app;
  END IF;
END $$;`);
  await store.exec(`
CREATE TABLE IF NOT EXISTS order_note (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 64),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_note_order ON order_note(order_id, created_at);
CREATE TABLE IF NOT EXISTS product_event (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED')),
  changes TEXT NOT NULL CHECK (changes::jsonb IS NOT NULL AND length(changes) <= 4000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_event_product ON product_event(product_id, created_at);
DO $$ BEGIN
  IF ${legacyApplicationGrant} THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON order_note, product_event TO online_shopping_app;
  END IF;
END $$;`);
  if (!await store.get('SELECT 1 AS found FROM seller_account LIMIT 1')) {
    const admin = await store.get('SELECT username, password_hash, created_at FROM admin WHERE id = 1');
    if (admin) {
      await store.run(`INSERT INTO seller_account(id, username, username_key, password_hash, role, active, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'OWNER', 1, 0, ?, ?)`, randomUUID(), admin.username, admin.username.toLowerCase(), admin.password_hash, admin.created_at, admin.created_at);
    }
  }
  await store.setSchemaVersion(SCHEMA_VERSION);
}
