ALTER TABLE platform_admin ADD COLUMN email TEXT;
ALTER TABLE platform_admin ADD COLUMN email_key TEXT UNIQUE;
ALTER TABLE platform_admin ADD CONSTRAINT platform_admin_email_pair CHECK (
  (email IS NULL AND email_key IS NULL) OR
  (email IS NOT NULL AND email_key IS NOT NULL AND length(email) BETWEEN 3 AND 254
   AND email = lower(email) AND email_key = email
   AND email ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+([.][a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
   AND length(split_part(email, '@', 1)) <= 64));

CREATE TABLE platform_admin_claim (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  generation UUID,
  token_hash TEXT CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at TEXT,
  expires_at TEXT,
  used_at TEXT,
  closed_at TEXT,
  claimed_admin_id TEXT REFERENCES platform_admin(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CHECK ((issued_at IS NULL) = (expires_at IS NULL)),
  CHECK ((generation IS NULL) = (issued_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at > issued_at),
  CHECK (token_hash IS NULL OR (generation IS NOT NULL AND used_at IS NULL AND closed_at IS NULL)),
  CHECK (generation IS NULL OR closed_at IS NOT NULL OR token_hash IS NOT NULL),
  CHECK (used_at IS NULL OR (closed_at IS NOT NULL AND generation IS NOT NULL)),
  CHECK (closed_at IS NULL OR token_hash IS NULL),
  CHECK (claimed_admin_id IS NULL OR closed_at IS NOT NULL)
);
INSERT INTO platform_admin_claim(id, closed_at, claimed_admin_id)
SELECT 1, created_at, id FROM platform_admin;
INSERT INTO platform_admin_claim(id) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM platform_admin_claim);

-- Metadata-only history; raw codes and hashes must never be copied here.
CREATE TABLE platform_admin_claim_generation (
  generation UUID PRIMARY KEY,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > issued_at),
  consumed_at TEXT,
  attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  superseded_by UUID UNIQUE REFERENCES platform_admin_claim_generation(generation) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ISSUED', 'SUPERSEDED', 'CLAIMED', 'CLOSED')),
  CHECK (superseded_by IS NULL OR (superseded_by <> generation AND outcome = 'SUPERSEDED')),
  CHECK ((consumed_at IS NOT NULL) = (outcome = 'CLAIMED'))
);

CREATE FUNCTION platform_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'platform claim state cannot be removed'; END IF;
  IF OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'platform claim is permanently closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_claim_no_reopen BEFORE UPDATE OR DELETE ON platform_admin_claim FOR EACH ROW EXECUTE FUNCTION platform_claim_guard();
CREATE TRIGGER platform_claim_no_truncate BEFORE TRUNCATE ON platform_admin_claim FOR EACH STATEMENT EXECUTE FUNCTION platform_claim_guard();
CREATE FUNCTION platform_admin_close_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE platform_admin_claim SET closed_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    claimed_admin_id = NEW.id, token_hash = NULL, revision = revision + 1 WHERE id = 1 AND closed_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_admin_closes_claim AFTER INSERT ON platform_admin FOR EACH ROW EXECUTE FUNCTION platform_admin_close_claim();

ALTER TABLE platform_audit DROP CONSTRAINT platform_audit_action_check;
ALTER TABLE platform_audit ADD CONSTRAINT platform_audit_action_check CHECK (action IN (
  'TENANT_CREATE', 'TENANT_ACTIVE', 'TENANT_FAILED', 'TENANT_CLEANUP', 'TENANT_SUSPEND', 'TENANT_RESUME',
  'CODE_RENAME', 'SELLER_PASSWORD_RESET', 'TENANT_DELETE', 'LOGIN', 'LOGIN_FAILED', 'BACKUP',
  'LOGOUT', 'TOTP_ENROLLED', 'RECOVERY_USED', 'RECOVERY_REGENERATED', 'PASSWORD_CHANGED', 'ADMIN_RESET',
  'TENANT_DELETE_REQUESTED', 'TENANT_DELETE_CANCELLED', 'TENANT_PURGED', 'ADMIN_BOOTSTRAP',
  'ADMIN_CLAIM_ISSUED', 'ADMIN_CLAIMED', 'ADMIN_CLAIM_DENIED', 'ADMIN_CLAIM_RATE_LIMITED'));
