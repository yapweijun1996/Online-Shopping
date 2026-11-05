import { OPERATION_SCOPES } from './operation-policy.js';

// Shared schema30 operation DDL for SQLite migration and the PostgreSQL baseline.
// Initialization and compatibility checks live in operation-runtime.js.
// Do not enable a write tool until those integrations and the first-party
// human approval flow have been reviewed and tested together.
export function operationSchema(dialect) {
  if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Unsupported database dialect.');
  const integer = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const strict = dialect === 'sqlite' ? ' STRICT' : '';
  const validObject = (column) => dialect === 'postgres'
    ? `jsonb_typeof(${column}::jsonb) = 'object'`
    : `json_valid(${column}) AND json_type(${column}) = 'object'`;
  const validHash = (column) => dialect === 'postgres'
    ? `length(${column}) = 64 AND ${column} ~ '^[0-9a-f]{64}$'`
    : `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
  const scopes = OPERATION_SCOPES.map((scope) => `'${scope}'`).join(',');
  return `
CREATE TABLE IF NOT EXISTS mcp_v2_authorization_request (
  request_id TEXT PRIMARY KEY REFERENCES oauth_authorization_request(id) ON DELETE CASCADE,
  epoch_hash TEXT NOT NULL CHECK (${validHash('epoch_hash')}),
  created_at TEXT NOT NULL
)${strict};
CREATE TABLE IF NOT EXISTS mcp_v2_scope_consent (
  grant_id TEXT NOT NULL REFERENCES oauth_grant(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, client_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN (${scopes})),
  account_auth_version ${integer} NOT NULL CHECK (account_auth_version >= 0),
  epoch_hash TEXT NOT NULL CHECK (${validHash('epoch_hash')}),
  consented_at TEXT NOT NULL,
  PRIMARY KEY (grant_id, scope)
)${strict};
CREATE TABLE IF NOT EXISTS mcp_v2_operation (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tenant_revision ${integer} NOT NULL CHECK (tenant_revision >= 0), account_id TEXT NOT NULL,
  client_id TEXT NOT NULL, grant_id TEXT NOT NULL, epoch_hash TEXT NOT NULL CHECK (${validHash('epoch_hash')}),
  build_digest TEXT NOT NULL CHECK (${validHash('build_digest')}),
  issuer TEXT NOT NULL, resource TEXT NOT NULL,
  tool_name TEXT NOT NULL, required_scope TEXT NOT NULL CHECK (required_scope IN (${scopes})),
  required_capability TEXT NOT NULL, risk TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  resource_type TEXT NOT NULL, resource_id TEXT, expected_revision TEXT,
  envelope_json TEXT CHECK (envelope_json IS NULL OR (length(envelope_json) BETWEEN 2 AND 65536 AND ${validObject('envelope_json')})),
  preview_hash TEXT NOT NULL CHECK (${validHash('preview_hash')}),
  request_hash TEXT NOT NULL CHECK (${validHash('request_hash')}),
  idempotency_hash TEXT NOT NULL CHECK (${validHash('idempotency_hash')}),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','PENDING_APPROVAL','APPROVED','COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > created_at), correlation_id TEXT NOT NULL,
  receipt_expires_at TEXT NOT NULL CHECK (receipt_expires_at > expires_at),
  redacted_at TEXT CHECK (redacted_at IS NULL OR redacted_at >= expires_at),
  result_json TEXT CHECK (result_json IS NULL OR (length(result_json) <= 65536 AND ${validObject('result_json')})),
  CHECK ((redacted_at IS NULL AND envelope_json IS NOT NULL) OR
    (redacted_at IS NOT NULL AND envelope_json IS NULL AND state IN ('COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED'))),
  UNIQUE (tenant_id, account_id, client_id, idempotency_hash)
)${strict};
CREATE INDEX IF NOT EXISTS mcp_v2_operation_expiry ON mcp_v2_operation(expires_at, state);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_receipt_expiry ON mcp_v2_operation(receipt_expires_at, id);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_grant ON mcp_v2_operation(grant_id, state);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_tenant_active ON mcp_v2_operation(tenant_id, state, expires_at);
CREATE INDEX IF NOT EXISTS mcp_v2_operation_client_active ON mcp_v2_operation(tenant_id, client_id, state, expires_at);
CREATE TABLE IF NOT EXISTS mcp_v2_approval_challenge (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL UNIQUE CHECK (${validHash('nonce_hash')}),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > created_at), account_id TEXT,
  session_hash TEXT, account_auth_version ${integer}, bound_at TEXT, consumed_at TEXT,
  CHECK ((account_id IS NULL AND session_hash IS NULL AND account_auth_version IS NULL AND bound_at IS NULL)
    OR (account_id IS NOT NULL AND session_hash IS NOT NULL AND ${validHash('session_hash')}
      AND account_auth_version IS NOT NULL AND account_auth_version >= 0 AND bound_at IS NOT NULL))
)${strict};
CREATE INDEX IF NOT EXISTS mcp_v2_challenge_expiry ON mcp_v2_approval_challenge(expires_at);
CREATE INDEX IF NOT EXISTS mcp_v2_challenge_operation ON mcp_v2_approval_challenge(operation_id);
CREATE TABLE IF NOT EXISTS mcp_v2_approval (
  operation_id TEXT PRIMARY KEY REFERENCES mcp_v2_operation(id) ON DELETE CASCADE,
  approver_id TEXT NOT NULL, session_hash TEXT NOT NULL CHECK (${validHash('session_hash')}),
  preview_hash TEXT NOT NULL CHECK (${validHash('preview_hash')}),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  approved_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > approved_at), consumed_at TEXT
)${strict};
CREATE TABLE IF NOT EXISTS mcp_v2_event (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT,
  client_id TEXT, grant_id TEXT, tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128), resource_id TEXT,
  operation_id TEXT NOT NULL, approver_id TEXT,
  event TEXT NOT NULL CHECK (event IN ('PREPARE','REQUEST_APPROVAL','APPROVE','REJECT','COMMIT','CANCEL','EXPIRE','CONFLICT','FAIL','DENY')),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 80), correlation_id TEXT NOT NULL
)${strict};
CREATE INDEX IF NOT EXISTS mcp_v2_event_time ON mcp_v2_event(at);
CREATE INDEX IF NOT EXISTS mcp_v2_event_operation ON mcp_v2_event(operation_id, at);
`;
}
