export function qrSchema(dialect) {
  const blob = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  return `
CREATE TABLE IF NOT EXISTS whatsapp_qr_session (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 desired TEXT NOT NULL CHECK (desired IN ('OFF','PAIR','RUN')),
 state TEXT NOT NULL CHECK (state IN ('IDLE','PAIRING','CONNECTING','CONNECTED','RECONNECTING','LOGGED_OUT','ERROR')),
 generation INTEGER NOT NULL CHECK (generation > 0), auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
 qr_text TEXT, qr_expires_at TEXT, phone_masked TEXT, phone_hash TEXT, last_error TEXT,
 lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT, last_claim_at TEXT,
 acknowledged_at TEXT, acknowledged_by TEXT, ack_notice_version TEXT,
 peer_key_sealed ${blob}, peer_key_id TEXT, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT INTO whatsapp_qr_session (id,desired,state,generation,auth_version,revision,updated_at)
 VALUES (1,'OFF','IDLE',1,0,1,'1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS whatsapp_qr_auth (
 generation INTEGER NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0), chunk_count INTEGER NOT NULL CHECK (chunk_count > 0 AND chunk_index < chunk_count),
 ciphertext ${blob} NOT NULL, key_id TEXT NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY (generation,record_type,record_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS message_peer_suppression (
 phone_hash TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK (reason IN ('ERASED')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_thread (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (provider = 'WHATSAPP_QR'), peer_hash TEXT NOT NULL UNIQUE,
 peer_sealed ${blob}, peer_key_id TEXT NOT NULL, display_name TEXT,
 phone_hash TEXT, last_inbound_at TEXT, last_message_at TEXT, unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
 suppressed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_thread_message (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES message_thread(id),
 direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')), provider_message_id TEXT,
 body TEXT CHECK (body IS NULL OR length(body) <= 4096),
 status TEXT NOT NULL CHECK (status IN ('RECEIVED','QUEUED','SENDING','SENT','FAILED','RECONCILE','CANCELLED')),
 error_code TEXT, actor TEXT, idempotency_key TEXT, body_digest TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 lease_expires_at TEXT, generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS qr_inbound_id ON message_thread_message(provider_message_id) WHERE direction = 'IN';
CREATE UNIQUE INDEX IF NOT EXISTS qr_reply_intent ON message_thread_message(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS qr_thread_time ON message_thread_message(thread_id,created_at,id);
CREATE INDEX IF NOT EXISTS qr_message_status ON message_thread_message(status,created_at,id);
`;
}

export async function migrateWhatsAppQr(store) {
  await store.exec(qrSchema(store.dialect));
}
