-- Platform database: one per installation. Holds the SuperAdmin, the tenant registry and the platform audit trail.
-- Shop data never lives here; every tenant has its own database (docs/MULTI_TENANT_SUPERADMIN_PLAN.md).
CREATE TABLE schema_meta (id BIGINT PRIMARY KEY CHECK (id = 1), version BIGINT NOT NULL);
CREATE TABLE platform_admin (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 64),
  username_key TEXT NOT NULL UNIQUE CHECK (length(username_key) BETWEEN 3 AND 64),
  password_hash TEXT NOT NULL,
  totp_secret_sealed BYTEA,
  totp_key_id TEXT CHECK (totp_key_id IS NULL OR length(totp_key_id) BETWEEN 1 AND 32),
  totp_enabled BIGINT NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_last_step BIGINT,
  failed_attempts BIGINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((totp_secret_sealed IS NULL) = (totp_key_id IS NULL)),
  CHECK (totp_enabled = 0 OR totp_secret_sealed IS NOT NULL)
);
-- One bootstrap administrator per installation, enforced even across concurrent starts.
CREATE UNIQUE INDEX platform_admin_singleton ON platform_admin ((true));
CREATE TABLE platform_recovery_code (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES platform_admin(id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE platform_session (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES platform_admin(id) ON DELETE RESTRICT,
  csrf_token TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('PASSWORD', 'FULL')),
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX platform_session_expiry ON platform_session(expires_at);
CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{3,30}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'FAILED', 'DELETING', 'PURGED')),
  currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
  is_default BIGINT NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sample BIGINT NOT NULL DEFAULT 0 CHECK (sample IN (0, 1)),
  database_name TEXT UNIQUE CHECK (database_name IS NULL OR database_name ~ '^t_[a-z0-9]{3,30}_[0-9a-f]{8}$'),
  database_role TEXT UNIQUE CHECK (database_role IS NULL OR database_role ~ '^t_[a-z0-9]{3,30}_[0-9a-f]{8}$'),
  database_password_sealed BYTEA,
  database_key_id TEXT CHECK (database_key_id IS NULL OR length(database_key_id) BETWEEN 1 AND 32),
  seller_username TEXT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  delete_after TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  -- The default tenant is today's database and uses the server's own settings; every other tenant has its own credentials.
  CHECK (is_default = 1 OR (database_name IS NOT NULL AND database_role IS NOT NULL AND database_password_sealed IS NOT NULL AND database_key_id IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_one_default ON tenant(is_default) WHERE is_default = 1;
CREATE TABLE tenant_code_alias (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9]{3,30}$'),
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TABLE platform_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('TENANT_CREATE', 'TENANT_ACTIVE', 'TENANT_FAILED', 'TENANT_CLEANUP', 'TENANT_SUSPEND', 'TENANT_RESUME',
    'CODE_RENAME', 'SELLER_PASSWORD_RESET', 'TENANT_DELETE', 'LOGIN', 'LOGIN_FAILED', 'BACKUP',
    'LOGOUT', 'TOTP_ENROLLED', 'RECOVERY_USED', 'RECOVERY_REGENERATED', 'PASSWORD_CHANGED', 'ADMIN_RESET',
    'TENANT_DELETE_REQUESTED', 'TENANT_DELETE_CANCELLED', 'TENANT_PURGED', 'ADMIN_BOOTSTRAP')),
  tenant_id TEXT,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at TEXT NOT NULL
);
CREATE INDEX platform_audit_time ON platform_audit(created_at);
-- Append-only, even for a role that holds UPDATE or DELETE.
CREATE FUNCTION platform_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'platform_audit is append-only'; END $$;
CREATE TRIGGER platform_audit_no_change BEFORE UPDATE OR DELETE ON platform_audit FOR EACH ROW EXECUTE FUNCTION platform_audit_append_only();
CREATE TRIGGER platform_audit_no_truncate BEFORE TRUNCATE ON platform_audit FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_append_only();
INSERT INTO schema_meta VALUES (1, 1);
CREATE TABLE rate_limit_attempt (bucket TEXT NOT NULL, key_hash TEXT NOT NULL, attempted_at BIGINT NOT NULL);
CREATE INDEX platform_rate_limit_lookup ON rate_limit_attempt(bucket, key_hash, attempted_at);
