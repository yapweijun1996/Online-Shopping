// Schema 18: courier and messaging integrations (see docs/INTEGRATION_DESIGN.md, section 4).
// The SQLite text runs in a migration; the PostgreSQL text is the same tables, kept verbatim in
// src/postgres/schema.sql (test/integration-tables.test.js fails if they drift) and run by upgrade.js.
// Secrets are only ever stored encrypted in integration_connection.secret_ciphertext.
export const INTEGRATION_TABLE_NAMES = ['integration_connection', 'shipment', 'shipment_event', 'message_outbox',
  'message_inbound', 'webhook_receipt', 'integration_audit'];

export const sqliteIntegrationTablesSql = `
  CREATE TABLE IF NOT EXISTS integration_connection (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
    environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
    status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED')),
    public_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(public_config)),
    secret_ciphertext BLOB,
    secret_key_id TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (provider, environment),
    CHECK ((secret_ciphertext IS NULL) = (secret_key_id IS NULL))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS shipment (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
    delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
    connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CREATED', 'FAILED', 'CANCELLED', 'RECONCILE')),
    tracking_no TEXT, carrier TEXT, label_ref TEXT, provider_payload TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS shipment_active_delivery ON shipment(delivery_id) WHERE status NOT IN ('CANCELLED', 'FAILED');
  CREATE INDEX IF NOT EXISTS shipment_order ON shipment(order_id);
  CREATE TABLE IF NOT EXISTS shipment_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id TEXT NOT NULL REFERENCES shipment(id) ON DELETE RESTRICT,
    status TEXT NOT NULL, raw_status TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    received_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS shipment_event_history ON shipment_event(shipment_id, id);
  CREATE TABLE IF NOT EXISTS message_outbox (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
    connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('ORDER_SUBMITTED', 'ORDER_CONFIRMED', 'ORDER_REJECTED', 'ORDER_SHIPPED')),
    recipient_hash TEXT NOT NULL, template TEXT NOT NULL, locale TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'READ', 'FAILED', 'RECONCILE')),
    provider_message_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (order_id, kind)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS message_outbox_due ON message_outbox(status, next_attempt_at);
  CREATE TABLE IF NOT EXISTS message_inbound (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
    order_id TEXT REFERENCES shop_order(id) ON DELETE RESTRICT,
    from_hash TEXT NOT NULL,
    provider_message_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('TEXT', 'MEDIA_UNSUPPORTED', 'OTHER')),
    body TEXT CHECK (body IS NULL OR length(body) <= 4096),
    received_at TEXT NOT NULL, read_at TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS message_inbound_order ON message_inbound(order_id, received_at);
  CREATE INDEX IF NOT EXISTS message_inbound_unread ON message_inbound(received_at) WHERE read_at IS NULL;
  CREATE TABLE IF NOT EXISTS webhook_receipt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
    received_at TEXT NOT NULL,
    UNIQUE (provider, dedupe_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS integration_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT REFERENCES integration_connection(id) ON DELETE RESTRICT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('CONNECT', 'ROTATE', 'DISCONNECT', 'ENABLE', 'DISABLE', 'ACK_RISK')),
    detail TEXT, occurred_at TEXT NOT NULL
  ) STRICT;`;

export const postgresIntegrationTablesSql = `
CREATE TABLE IF NOT EXISTS integration_connection (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN', 'WHATSAPP_CLOUD', 'WHATSAPP_QR')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED')),
  public_config TEXT NOT NULL DEFAULT '{}' CHECK (public_config::jsonb IS NOT NULL),
  secret_ciphertext BYTEA,
  secret_key_id TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (provider, environment),
  CHECK ((secret_ciphertext IS NULL) = (secret_key_id IS NULL))
);
CREATE TABLE IF NOT EXISTS shipment (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('NINJAVAN')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CREATED', 'FAILED', 'CANCELLED', 'RECONCILE')),
  tracking_no TEXT, carrier TEXT, label_ref TEXT, provider_payload TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_active_delivery ON shipment(delivery_id) WHERE status NOT IN ('CANCELLED', 'FAILED');
CREATE INDEX IF NOT EXISTS shipment_order ON shipment(order_id);
CREATE TABLE IF NOT EXISTS shipment_event (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipment(id) ON DELETE RESTRICT,
  status TEXT NOT NULL, raw_status TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shipment_event_history ON shipment_event(shipment_id, id);
CREATE TABLE IF NOT EXISTS message_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('ORDER_SUBMITTED', 'ORDER_CONFIRMED', 'ORDER_REJECTED', 'ORDER_SHIPPED')),
  recipient_hash TEXT NOT NULL, template TEXT NOT NULL, locale TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'READ', 'FAILED', 'RECONCILE')),
  provider_message_id TEXT,
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (order_id, kind)
);
CREATE INDEX IF NOT EXISTS message_outbox_due ON message_outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS message_inbound (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES shop_order(id) ON DELETE RESTRICT,
  from_hash TEXT NOT NULL,
  provider_message_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('TEXT', 'MEDIA_UNSUPPORTED', 'OTHER')),
  body TEXT CHECK (body IS NULL OR length(body) <= 4096),
  received_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS message_inbound_order ON message_inbound(order_id, received_at);
CREATE INDEX IF NOT EXISTS message_inbound_unread ON message_inbound(received_at) WHERE read_at IS NULL;
CREATE TABLE IF NOT EXISTS webhook_receipt (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  verified BIGINT NOT NULL CHECK (verified IN (0, 1)),
  received_at TEXT NOT NULL,
  UNIQUE (provider, dedupe_key)
);
CREATE TABLE IF NOT EXISTS integration_audit (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  connection_id TEXT REFERENCES integration_connection(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CONNECT', 'ROTATE', 'DISCONNECT', 'ENABLE', 'DISABLE', 'ACK_RISK')),
  detail TEXT, occurred_at TEXT NOT NULL
);`;
