// Shared DDL keeps fresh/upgrade PostgreSQL and SQLite constraints equivalent.
export function oauthSchema(dialect, addVersion = true) {
  const integer = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const strict = dialect === 'postgres' ? '' : ' STRICT';
  const redirects = dialect === 'postgres' ? "jsonb_typeof(redirect_uris_json::jsonb) = 'array' AND jsonb_array_length(redirect_uris_json::jsonb) BETWEEN 1 AND 5" : "json_valid(redirect_uris_json) AND json_type(redirect_uris_json) = 'array' AND json_array_length(redirect_uris_json) BETWEEN 1 AND 5";
  return `
${addVersion ? `ALTER TABLE seller_account ADD COLUMN oauth_auth_version ${integer} NOT NULL DEFAULT 0 CHECK (oauth_auth_version >= 0);` : ''}
CREATE TABLE IF NOT EXISTS oauth_client (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, issuer TEXT NOT NULL,
 client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 80),
 redirect_uris_json TEXT NOT NULL CHECK (${redirects}), auth_method TEXT NOT NULL CHECK (auth_method = 'none'),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, disabled_at TEXT, last_used_at TEXT
)${strict};
CREATE INDEX IF NOT EXISTS oauth_client_expiry ON oauth_client(expires_at);
CREATE TABLE IF NOT EXISTS oauth_authorization_request (
 id TEXT PRIMARY KEY, browser_nonce_hash TEXT NOT NULL UNIQUE CHECK (length(browser_nonce_hash) = 64),
 client_id TEXT NOT NULL REFERENCES oauth_client(id) ON DELETE RESTRICT,
 tenant_id TEXT NOT NULL, resource TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT NOT NULL,
 challenge TEXT NOT NULL CHECK (length(challenge) = 43), challenge_method TEXT NOT NULL CHECK (challenge_method = 'S256'),
 scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 account_id TEXT REFERENCES seller_account(id) ON DELETE RESTRICT, session_proof_hash TEXT,
 account_auth_version ${integer}, consumed_at TEXT
)${strict};
CREATE INDEX IF NOT EXISTS oauth_request_expiry ON oauth_authorization_request(expires_at);
CREATE TABLE IF NOT EXISTS oauth_grant (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES seller_account(id) ON DELETE RESTRICT,
 client_id TEXT NOT NULL REFERENCES oauth_client(id) ON DELETE RESTRICT,
 tenant_id TEXT NOT NULL, issuer TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL,
 account_auth_version ${integer} NOT NULL CHECK (account_auth_version >= 0), created_at TEXT NOT NULL,
 absolute_expires_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT,
 UNIQUE (id, account_id, client_id)
)${strict};
CREATE INDEX IF NOT EXISTS oauth_grant_account ON oauth_grant(account_id, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_grant_client ON oauth_grant(client_id);
CREATE TABLE IF NOT EXISTS oauth_authorization_code (
 code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64), grant_id TEXT NOT NULL REFERENCES oauth_grant(id) ON DELETE RESTRICT,
 redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, challenge TEXT NOT NULL CHECK (length(challenge) = 43),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
)${strict};
CREATE TABLE IF NOT EXISTS oauth_token (
 token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64), kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
 grant_id TEXT NOT NULL REFERENCES oauth_grant(id) ON DELETE RESTRICT, resource TEXT NOT NULL, scopes TEXT NOT NULL,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT,
 generation ${integer} NOT NULL CHECK (generation >= 0),
 predecessor_hash TEXT REFERENCES oauth_token(token_hash) ON DELETE RESTRICT,
 UNIQUE (grant_id, kind, generation)
)${strict};
CREATE INDEX IF NOT EXISTS oauth_token_grant_expiry ON oauth_token(grant_id, expires_at);
CREATE TABLE IF NOT EXISTS mcp_audit (
 id TEXT PRIMARY KEY, at TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT, client_id TEXT, grant_id TEXT,
 correlation_id TEXT NOT NULL,
 event TEXT NOT NULL CHECK (event IN ('AUTHORIZE','ISSUE','REVOKE','READ','DENY','INVALIDATE')),
 tool_name TEXT CHECK (tool_name IS NULL OR tool_name IN ('catalog.list','catalog.get','catalog.history','catalog.categories','catalog.low_stock','orders.list','orders.get','analytics.summary')),
 resource_id TEXT, outcome TEXT NOT NULL,
 duration_ms ${integer} NOT NULL CHECK (duration_ms >= 0), result_count ${integer} NOT NULL CHECK (result_count >= 0)
)${strict};
CREATE INDEX IF NOT EXISTS mcp_audit_time ON mcp_audit(at);
`;
}

export async function migrateOAuth(store) {
  const columns = store.dialect === 'postgres'
    ? await store.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'seller_account'")
    : await store.all("SELECT name FROM pragma_table_info('seller_account')");
  await store.exec(oauthSchema(store.dialect, !columns.some((c) => c.name === 'oauth_auth_version')));
}
