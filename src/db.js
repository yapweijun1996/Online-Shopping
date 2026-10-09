import { randomUUID } from 'node:crypto';
import { openNodeStore } from './store.js';
import { migrateLegacyVariants } from './options.js';
import { migrateListings } from './listings.js';
import { migrateSharedGalleries } from './product-gallery.js';

export const SCHEMA_VERSION = 24;

// Column lists of the tables rebuilt by migration 5, as created by migration 3.
const rebuildColumns = {
  product: ['id', 'sku', 'name', 'description', 'category', 'price_minor', 'currency', 'active', 'translations_json',
    'image_mime', 'image_data', 'created_at', 'updated_at'],
  shop_order: ['id', 'order_no', 'buyer_name', 'buyer_phone', 'buyer_email', 'whatsapp_opt_in', 'whatsapp_consent_at',
    'whatsapp_consent_version', 'locale', 'status', 'revision', 'currency', 'total_minor', 'submitted_at', 'updated_at'],
  order_item: ['id', 'delivery_id', 'position', 'product_id', 'sku_snapshot', 'name_snapshot', 'price_minor', 'quantity',
    'line_total_minor', 'currency'],
};


// Tenant-defined product options (see options.js). Values and types are never deleted, only deactivated.
const optionTablesSql = `
  CREATE TABLE IF NOT EXISTS option_type (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(code) BETWEEN 1 AND 60),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
    display TEXT NOT NULL DEFAULT 'button' CHECK (display IN ('button', 'swatch', 'image', 'dropdown')),
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS option_value (
    id TEXT PRIMARY KEY,
    option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
    code TEXT NOT NULL COLLATE NOCASE CHECK (length(code) BETWEEN 1 AND 60),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
    swatch_color TEXT CHECK (swatch_color IS NULL OR (length(swatch_color) = 7 AND swatch_color LIKE '#%')),
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (option_type_id, code)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS product_option (
    product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
    option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
    option_value_id TEXT NOT NULL REFERENCES option_value(id) ON DELETE RESTRICT,
    PRIMARY KEY (product_id, option_type_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS product_option_value ON product_option(option_value_id);`;

const listingTableSql = `
  CREATE TABLE IF NOT EXISTS listing (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`;

/* Provider connections, audit trail, webhook dedupe and WhatsApp message queues (see docs/WHATSAPP_IMPLEMENTATION_PLAN.md). */
const integrationTablesSql = `
CREATE TABLE IF NOT EXISTS integration_connection (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED')),
  public_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(public_config)),
  secret_ciphertext BLOB,
  secret_key_id TEXT CHECK (secret_key_id IS NULL OR length(secret_key_id) BETWEEN 1 AND 32),
  secret_hint TEXT CHECK (secret_hint IS NULL OR length(secret_hint) <= 12),
  last_checked_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (provider, environment),
  CHECK ((secret_ciphertext IS NULL) = (secret_key_id IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS integration_audit (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  action TEXT NOT NULL CHECK (action IN ('CONNECT', 'ROTATE', 'DISCONNECT', 'CHECK_FAILED', 'RISK_ACKNOWLEDGED')),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS integration_audit_time ON integration_audit(created_at);
CREATE TABLE IF NOT EXISTS webhook_receipt (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  received_at TEXT NOT NULL,
  UNIQUE (provider, dedupe_key)
) STRICT;
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
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
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
) STRICT;
CREATE INDEX IF NOT EXISTS message_inbound_order ON message_inbound(order_id);
CREATE INDEX IF NOT EXISTS message_inbound_unread ON message_inbound(received_at) WHERE read_at IS NULL;
`;

// Seller accounts (SEL-04): one row per person who can sign in, replacing the single `admin` row. The old row is copied in
// as the OWNER and stays untouched. `account_event` records changes to accounts, never passwords.
const accountTablesSql = `
CREATE TABLE IF NOT EXISTS seller_account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 64),
  username_key TEXT NOT NULL UNIQUE CHECK (length(username_key) BETWEEN 3 AND 64),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'STAFF')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, password_changed_at TEXT, last_login_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS account_event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES seller_account(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'ROLE_CHANGED', 'DEACTIVATED', 'ACTIVATED', 'PASSWORD_RESET', 'PASSWORD_CHANGED')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS account_event_time ON account_event(created_at);
`;

// Internal order notes (append-only, seller-written) and the history of product edits (who changed what, never deleted).
const historyTablesSql = `
CREATE TABLE IF NOT EXISTS order_note (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 64),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS order_note_order ON order_note(order_id, created_at);
CREATE TABLE IF NOT EXISTS product_event (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED')),
  changes TEXT NOT NULL CHECK (json_valid(changes) AND length(changes) <= 4000),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS product_event_product ON product_event(product_id, created_at);
`;

async function migrateAccounts(store) {
  await store.exec(accountTablesSql);
  const present = (await store.all("SELECT name FROM pragma_table_info('session')")).map(column => column.name);
  if (!present.includes('account_id')) await store.exec('ALTER TABLE session ADD COLUMN account_id TEXT');
  const admin = await store.get('SELECT username, password_hash, created_at FROM admin WHERE id = 1');
  if (admin && !await store.get('SELECT 1 AS found FROM seller_account LIMIT 1')) {
    await store.run(`INSERT INTO seller_account(id, username, username_key, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'OWNER', 1, 0, ?, ?)`, randomUUID(), admin.username, admin.username.toLowerCase(), admin.password_hash, admin.created_at, admin.created_at);
  }
}

async function migrate(store, version, sql) {
  await store.transaction(async () => {
    await store.exec(sql);
    await store.setSchemaVersion(version);
  });
}

export async function openDatabase(file) {
  const store = openNodeStore(file);
  try {
    await migrateStore(store);
  } catch (error) {
    await store.close();
    throw error;
  }
  return store;
}

/* Applies pending migrations through the storage contract so every runtime shares one schema. */
export async function migrateStore(store) {
  let version = await store.schemaVersion();
  if (version === 0) {
    await migrate(store, 1, `
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
    await migrate(store, 2, `
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
    await migrate(store, 3, `
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
    await migrate(store, 4, `
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
    // SQLite cannot relax a CHECK constraint in place, so rebuild each affected table.
    // rebuildTransaction suspends foreign-key enforcement until the rebuild is complete.
    await store.rebuildTransaction(async () => {
      for (const table of ['product', 'shop_order', 'order_item']) {
        const schema = (await store.get('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?', 'table', table))?.sql;
        if (!schema || !schema.includes("currency = 'MYR'")) throw new Error(`Unexpected ${table} currency schema.`);
        await store.exec(schema.replace(new RegExp(`^CREATE TABLE ["\x60]?${table}["\x60]?`, 'i'), `CREATE TABLE ${table}_new`)
          .replace("currency = 'MYR'", "currency IN ('MYR', 'SGD')"));
        const columns = rebuildColumns[table].join(', ');
        await store.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`);
        await store.exec(`DROP TABLE ${table}`);
        await store.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      }
      await store.exec(`CREATE INDEX product_public ON product(active, category, updated_at);
        CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC);
        CREATE TABLE company_setting (
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
      await store.setSchemaVersion(5);
    });
    version = 5;
  }
  if (version === 5) {
    await migrate(store, 6, `
      CREATE TABLE rate_limit_attempt (
        id INTEGER PRIMARY KEY,
        bucket TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        attempted_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX rate_limit_lookup ON rate_limit_attempt(bucket, key_hash);
      CREATE INDEX rate_limit_expiry ON rate_limit_attempt(bucket, attempted_at);`);
    version = 6;
  }
  if (version === 6) {
    await migrate(store, 7, `
      CREATE TABLE shop_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT CHECK (mode IN ('demo', 'production')),
        shop_name TEXT NOT NULL
      ) STRICT;
      INSERT INTO shop_setup(id, mode, shop_name)
        SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM product) OR EXISTS (SELECT 1 FROM shop_order)
          OR EXISTS (SELECT 1 FROM general_code) THEN 'production' ELSE NULL END, 'Online Shopping';`);
    version = 7;
  }
  if (version === 7) {
    await migrate(store, 8, `
      ALTER TABLE product ADD COLUMN variant_group TEXT;
      ALTER TABLE product ADD COLUMN variant_label TEXT;
      CREATE UNIQUE INDEX product_variant_option ON product(variant_group, variant_label COLLATE NOCASE);
      CREATE INDEX product_variant_group ON product(variant_group, active);
      CREATE TABLE product_gallery_image (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(product_id, position)
      ) STRICT;
      CREATE INDEX product_gallery_product ON product_gallery_image(product_id, position);`);
    version = 8;
  }
  if (version === 8) {
    await migrate(store, 9, `
      ALTER TABLE company_setting ADD COLUMN seller_whatsapp_phone TEXT
        CHECK (seller_whatsapp_phone IS NULL OR
          (length(seller_whatsapp_phone) BETWEEN 8 AND 15 AND seller_whatsapp_phone NOT GLOB '*[^0-9]*'));
      UPDATE company_setting SET seller_whatsapp_phone = NULL
        WHERE id = 1 AND EXISTS (SELECT 1 FROM shop_setup WHERE mode = 'demo');`);
    version = 9;
  }
  if (version === 9) {
    await migrate(store, 10, `
      ALTER TABLE company_setting ADD COLUMN mobile_hide_bars_on_scroll INTEGER NOT NULL DEFAULT 0
        CHECK (mobile_hide_bars_on_scroll IN (0, 1));`);
    version = 10;
  }
  if (version === 10) {
    await migrate(store, 11, `
      CREATE TABLE product_gallery_image_v11 (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 9),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(product_id, position)
      ) STRICT;
      INSERT INTO product_gallery_image_v11 SELECT id, product_id, position, mime, data, created_at FROM product_gallery_image;
      DROP TABLE product_gallery_image;
      ALTER TABLE product_gallery_image_v11 RENAME TO product_gallery_image;
      CREATE INDEX product_gallery_product ON product_gallery_image(product_id, position);`);
    version = 11;
  }
  if (version === 11) {
    // NULL means unlimited, so existing products keep selling without a stock count.
    const stockPresent = (await store.all("SELECT name FROM pragma_table_info('product')")).some(column => column.name === 'stock_quantity');
    await migrate(store, 12, stockPresent ? '' : `
      ALTER TABLE product ADD COLUMN stock_quantity INTEGER
        CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000);`);
    version = 12;
  }
  if ([12, 13].includes(version)) {
    const columns = await store.all("SELECT name FROM pragma_table_info('product')");
    if (!columns.some(column => column.name === 'stock_quantity')) {
      if (!columns.some(column => column.name === 'gallery_layout_json')) throw new Error('Unrecognized product schema.');
      await store.transaction(async () => {
        await store.exec('ALTER TABLE product ADD COLUMN stock_quantity INTEGER CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000)');
      });
    }
  }
  if (version === 12) {
    // Fulfilment adds order statuses, so the CHECK constraints are rebuilt and tracking columns added.
    await store.rebuildTransaction(async () => {
      const rebuild = async (table, columns, from, to) => {
        const schema = (await store.get('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?', 'table', table))?.sql;
        if (schema?.includes(to)) return; // already rebuilt, e.g. a database restored to an earlier version number
        if (!schema || !schema.includes(from)) throw new Error(`Unexpected ${table} status schema.`);
        await store.exec(schema.replace(new RegExp(`^CREATE TABLE ["\x60]?${table}["\x60]?`, 'i'), `CREATE TABLE ${table}_new`).replace(from, to));
        await store.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`);
        await store.exec(`DROP TABLE ${table}`);
        await store.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      };
      const statuses = "'SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED'";
      await rebuild('shop_order', rebuildColumns.shop_order.join(', '),
        "status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')", `status IN (${statuses})`);
      await rebuild('order_event', 'id, order_id, event_type, actor_type, actor_id, previous_status, status, reason, occurred_at',
        "event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')", `event_type IN (${statuses})`);
      const orderSql = (await store.get('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?', 'table', 'shop_order')).sql;
      if (!orderSql.includes('tracking_carrier')) await store.exec('ALTER TABLE shop_order ADD COLUMN tracking_carrier TEXT');
      if (!orderSql.includes('tracking_no')) await store.exec('ALTER TABLE shop_order ADD COLUMN tracking_no TEXT');
      await store.exec(`CREATE INDEX IF NOT EXISTS shop_order_queue ON shop_order(status, submitted_at DESC);
        CREATE INDEX IF NOT EXISTS order_event_history ON order_event(order_id, id);`);
      await store.setSchemaVersion(13);
    });
    version = 13;
  }
  if (version === 13) {
    await store.transaction(async () => {
      const columns = await store.all("SELECT name FROM pragma_table_info('product')");
      if (!columns.some(column => column.name === 'gallery_layout_json')) {
        await store.exec("ALTER TABLE product ADD COLUMN gallery_layout_json TEXT CHECK (gallery_layout_json IS NULL OR (json_valid(gallery_layout_json) AND json_type(gallery_layout_json) = 'array'))");
      }
      await store.exec(`CREATE TABLE product_gallery_image_v15 (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
        data BLOB NOT NULL, created_at TEXT NOT NULL, UNIQUE(product_id, position)
      ) STRICT;
      INSERT INTO product_gallery_image_v15 SELECT id, product_id, position, mime, data, created_at FROM product_gallery_image;
      DROP TABLE product_gallery_image;
      ALTER TABLE product_gallery_image_v15 RENAME TO product_gallery_image;
      CREATE INDEX product_gallery_product ON product_gallery_image(product_id, position);`);
      await store.setSchemaVersion(15);
    });
    version = 15;
  }
  if (version === 15) {
    // Optional storefront texts shown on the product page; NULL keeps the built-in wording.
    await store.transaction(async () => {
      const present = (await store.all("SELECT name FROM pragma_table_info('company_setting')")).map(column => column.name);
      for (const column of ['availability_text', 'shipping_text', 'returns_text']) {
        if (!present.includes(column)) await store.exec(`ALTER TABLE company_setting ADD COLUMN ${column} TEXT CHECK (${column} IS NULL OR length(${column}) BETWEEN 1 AND 1000)`);
      }
      await store.setSchemaVersion(16);
    });
    version = 16;
  }
  if (version === 16) {
    await store.transaction(async () => {
      await store.exec(optionTablesSql);
      await migrateLegacyVariants(store);
      await store.setSchemaVersion(17);
    });
    version = 17;
  }
  if (version === 17) {
    // One listing per product (shared title, description, category) with the old product rows as its variants.
    await store.transaction(async () => {
      await store.exec(listingTableSql);
      const present = (await store.all("SELECT name FROM pragma_table_info('product')")).map(column => column.name);
      if (!present.includes('listing_id')) await store.exec('ALTER TABLE product ADD COLUMN listing_id TEXT REFERENCES listing(id) ON DELETE RESTRICT');
      await store.exec('CREATE INDEX IF NOT EXISTS product_listing ON product(listing_id)');
      await migrateListings(store);
      await store.setSchemaVersion(18);
    });
    version = 18;
  }
  if (version === 18) {
    // Data only: one shared photo gallery per listing, and the per-variant copies of it are removed.
    await store.transaction(async () => {
      // The gallery copy below reads the preview columns, so they must exist before schema 20 is reached.
      await addThumbnailColumns(store);
      await migrateSharedGalleries(store);
      await store.setSchemaVersion(19);
    });
    version = 19;
  }
  if (version === 19) {
    // Small previews of product and gallery images, so lists need not download full-size photos.
    await store.transaction(async () => {
      await addThumbnailColumns(store);
      await store.setSchemaVersion(20);
    });
    version = 20;
  }
  if (version === 20) {
    // Additive: tables for provider connections and WhatsApp messages. Nothing reads them yet.
    await migrate(store, 21, integrationTablesSql);
    version = 21;
  }
  if (version === 21) {
    // Additive: when and by whom an order's buyer contact and delivery data were erased (see erase-contact.js).
    await store.transaction(async () => {
      const present = (await store.all("SELECT name FROM pragma_table_info('shop_order')")).map(column => column.name);
      for (const column of ['contact_erased_at', 'contact_erased_by']) {
        if (!present.includes(column)) await store.exec(`ALTER TABLE shop_order ADD COLUMN ${column} TEXT`);
      }
      await store.setSchemaVersion(22);
    });
    version = 22;
  }
  if (version === 22) {
    // Sessions now belong to an account. Existing sessions have none, so they stop working and everyone signs in again.
    await store.transaction(async () => {
      await migrateAccounts(store);
      await store.setSchemaVersion(23);
    });
    version = 23;
  }
  if (version === 23) {
    await migrate(store, 24, historyTablesSql);
    version = 24;
  }
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}.`);
}

async function addThumbnailColumns(store) {
  for (const table of ['product', 'product_gallery_image']) {
    const present = (await store.all(`SELECT name FROM pragma_table_info('${table}')`)).map(column => column.name);
    if (!present.includes('thumb_mime')) await store.exec(`ALTER TABLE ${table} ADD COLUMN thumb_mime TEXT CHECK (thumb_mime IS NULL OR thumb_mime IN ('image/png', 'image/jpeg', 'image/webp'))`);
    if (!present.includes('thumb_data')) await store.exec(`ALTER TABLE ${table} ADD COLUMN thumb_data BLOB`);
  }
}

export async function ready(store) {
  try {
    return await store.schemaVersion() === SCHEMA_VERSION &&
      Array.isArray(await store.all('SELECT stock_quantity, gallery_layout_json FROM product LIMIT 0')) &&
      Array.isArray(await store.all('SELECT tracking_carrier, tracking_no, contact_erased_at, contact_erased_by FROM shop_order LIMIT 0')) &&
      Array.isArray(await store.all('SELECT availability_text, shipping_text, returns_text FROM company_setting LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id FROM option_type LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id FROM listing LIMIT 0')) &&
      Array.isArray(await store.all('SELECT listing_id FROM product LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id FROM option_value LIMIT 0')) &&
      Array.isArray(await store.all('SELECT product_id FROM product_option LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id, username_key, role, active, must_change_password FROM seller_account LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id, account_id, action FROM account_event LIMIT 0')) &&
      Array.isArray(await store.all('SELECT account_id FROM session LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id, order_id, author FROM order_note LIMIT 0')) &&
      Array.isArray(await store.all('SELECT id, product_id, changes FROM product_event LIMIT 0')) &&
      Boolean(await store.get('SELECT id FROM seller_account WHERE role = ? AND active = 1 LIMIT 1', 'OWNER')) &&
      Boolean(await store.get('SELECT id FROM order_sequence WHERE id = 1')) &&
      Boolean(await store.get('SELECT id FROM company_setting WHERE id = 1')) &&
      Boolean(await store.get('SELECT id FROM shop_setup WHERE id = 1')) &&
      (await Promise.all(['session', 'product', 'general_code', 'shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency',
        'rate_limit_attempt', 'shop_setup', 'product_gallery_image']
        .map(async (table) => Array.isArray(await store.all(`SELECT * FROM ${table} LIMIT 0`))))).every(Boolean);
  } catch {
    return false;
  }
}
