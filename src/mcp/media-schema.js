// Schema31 storage only. These constants and tables grant no tool authority.
export const MEDIA_LIMITS = Object.freeze({ sourceBytes: 524288, canonicalBytes: 524288, thumbnailBytes: 81920,
  chunkBytes: 36864, chunks: 15, uploadMs: 900000, absoluteMs: 1500000, leaseMs: 45000, coordinatorMs: 30000,
  decodeMs: 5000, validationAttempts: 2, tenantSlots: 24, clientSlots: 12, tenantBytes: 33554432, clientBytes: 16777216,
  products: 300, listings: 2, oldAssets: 32, newAssets: 10, assets: 42, records: 512, pages: 16, pageRecords: 32,
  pageBytes: 16384, oldBytes: 16777216, newBytes: 8388608, graphBytes: 25165824, cleanupRows: 100, cleanupBytes: 1048576 });
export const MEDIA_POLICY_IDS = Object.freeze(['media-upload-v1', 'media-layout-v1', 'catalog-media-v1']);
export const MEDIA_STORAGE_TABLES = Object.freeze(['mcp_v2_operation_media_policy', 'mcp_v2_media_quota', 'mcp_v2_media_stage',
  'mcp_v2_media_chunk', 'mcp_v2_media_pin', 'mcp_v2_media_manifest_page', 'mcp_v2_media_asset_ref', 'mcp_v2_media_delivery',
  'mcp_v2_media_approval_evidence', 'mcp_v2_media_event']);
export const mediaPolicyCheck = column => `${column} IN ('media-upload-v1','media-layout-v1','catalog-media-v1')`;
export function mediaSchema(dialect) {
  if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Unsupported database dialect.');
  const pg = dialect === 'postgres', integer = pg ? 'BIGINT' : 'INTEGER', binary = pg ? 'BYTEA' : 'BLOB', strict = pg ? '' : ' STRICT';
  const hash = c => `length(${c}) = 64 AND ${pg ? `${c} ~ '^[0-9a-f]{64}$'` : `${c} NOT GLOB '*[^0-9a-f]*'`}`;
  const uuid = c => `length(${c}) = 36 AND substr(${c},9,1) = '-' AND substr(${c},14,1) = '-' AND substr(${c},19,1) = '-' AND substr(${c},24,1) = '-' AND length(replace(${c},'-','')) = 32 AND ${pg ? `replace(${c},'-','') ~ '^[0-9a-f]{32}$'` : `replace(${c},'-','') NOT GLOB '*[^0-9a-f]*'`}`;
  const time = c => `length(${c}) = 24 AND ${pg ? `${c} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'` : `${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`}`;
  const bytes = c => pg ? `octet_length(${c})` : `length(CAST(${c} AS BLOB))`;
  const object = c => pg ? `jsonb_typeof(${c}::jsonb) = 'object'` : `json_valid(${c}) AND json_type(${c}) = 'object'`;
  const h = c => `${c} TEXT NOT NULL CHECK (${hash(c)})`, t = c => `${c} TEXT NOT NULL CHECK (${time(c)})`, u = c => `${c} TEXT NOT NULL CHECK (${uuid(c)})`;
  return `
CREATE TABLE mcp_v2_operation_media_policy (
  operation_id TEXT PRIMARY KEY REFERENCES mcp_v2_operation(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL CHECK (${mediaPolicyCheck('policy_id')}), required_scopes TEXT NOT NULL,
  ${h('descriptor_hash')}, ${h('manifest_root')}, ${h('graph_revision')}, ${h('codec_digest')},
  page_count ${integer} NOT NULL CHECK (page_count >= 1 AND page_count <= 16),
  asset_count ${integer} NOT NULL CHECK (asset_count >= 0 AND asset_count <= 42),
  effect_count ${integer} NOT NULL CHECK (effect_count >= 1 AND effect_count <= 512),
  ${t('created_at')}, ${t('expires_at')}, CHECK (expires_at > created_at),
  CHECK ((policy_id IN ('media-upload-v1','media-layout-v1') AND required_scopes = 'media.write') OR
    (policy_id = 'catalog-media-v1' AND required_scopes = 'catalog.write media.write'))
)${strict};
CREATE INDEX mcp_v2_media_policy_root ON mcp_v2_operation_media_policy(manifest_root);
CREATE TABLE mcp_v2_media_quota (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) >= 1 AND length(tenant_id) <= 100),
  kind TEXT NOT NULL CHECK (kind IN ('TENANT','CLIENT')), owner_key TEXT NOT NULL,
  reserved_bytes ${integer} NOT NULL CHECK (reserved_bytes >= 0), active_slots ${integer} NOT NULL CHECK (active_slots >= 0),
  PRIMARY KEY (tenant_id,kind,owner_key),
  CHECK ((kind = 'TENANT' AND owner_key = 'tenant' AND reserved_bytes <= 33554432 AND active_slots <= 24) OR
    (kind = 'CLIENT' AND ${hash('owner_key')} AND reserved_bytes <= 16777216 AND active_slots <= 12))
)${strict};
CREATE TABLE mcp_v2_media_stage (
  id TEXT PRIMARY KEY CHECK (${uuid('id')}), tenant_id TEXT NOT NULL CHECK (length(tenant_id) >= 1 AND length(tenant_id) <= 100),
  tenant_revision ${integer} NOT NULL CHECK (tenant_revision >= 0), account_id TEXT NOT NULL CHECK (length(account_id) >= 1 AND length(account_id) <= 128), client_id TEXT NOT NULL CHECK (length(client_id) >= 1 AND length(client_id) <= 128), grant_id TEXT NOT NULL CHECK (length(grant_id) >= 1 AND length(grant_id) <= 128),
  account_auth_version ${integer} NOT NULL CHECK (account_auth_version >= 0), ${h('epoch_hash')}, ${h('build_digest')},
  issuer TEXT NOT NULL CHECK (length(issuer) >= 1 AND length(issuer) <= 8192), resource TEXT NOT NULL CHECK (length(resource) >= 1 AND length(resource) <= 8192),
  ${u('product_id')}, target_slot TEXT NOT NULL CHECK (target_slot IN ('MAIN','GALLERY')), ${h('expected_revision')},
  ${h('begin_request_hash')}, ${h('idempotency_hash')}, ${h('source_sha256')}, ${h('codec_digest')},
  source_mime TEXT NOT NULL CHECK (source_mime IN ('image/png','image/jpeg','image/webp')),
  declared_bytes ${integer} NOT NULL CHECK (declared_bytes >= 1 AND declared_bytes <= 524288),
  next_offset ${integer} NOT NULL CHECK (next_offset >= 0 AND next_offset <= declared_bytes),
  reserved_bytes ${integer} NOT NULL CHECK (reserved_bytes = declared_bytes + 606208 OR reserved_bytes = 0), ${h('quota_owner_key')},
  state TEXT NOT NULL CHECK (state IN ('UPLOADING','VALIDATING','BOUND','CONSUMED','FAILED','EXPIRED','CANCELLED')),
  version ${integer} NOT NULL CHECK (version >= 0), validation_attempts ${integer} NOT NULL CHECK (validation_attempts >= 0 AND validation_attempts <= 2),
  lease_hash TEXT CHECK (lease_hash IS NULL OR (${hash('lease_hash')})), lease_until TEXT CHECK (lease_until IS NULL OR (${time('lease_until')})),
  operation_id TEXT CHECK (operation_id IS NULL OR (${uuid('operation_id')})), ${u('correlation_id')},
  canonical_data ${binary}, canonical_sha256 TEXT, canonical_bytes ${integer}, canonical_mime TEXT, width ${integer}, height ${integer},
  thumbnail_data ${binary}, thumbnail_sha256 TEXT, thumbnail_bytes ${integer},
  ${t('created_at')}, ${t('upload_expires_at')}, ${t('absolute_expires_at')}, ${t('receipt_expires_at')},
  bound_expires_at TEXT CHECK (bound_expires_at IS NULL OR (${time('bound_expires_at')})),
  scrubbed_at TEXT CHECK (scrubbed_at IS NULL OR (${time('scrubbed_at')})), terminal_at TEXT CHECK (terminal_at IS NULL OR (${time('terminal_at')})),
  UNIQUE (tenant_id,account_id,client_id,grant_id,idempotency_hash),
  CHECK (upload_expires_at > created_at AND absolute_expires_at > upload_expires_at AND receipt_expires_at > absolute_expires_at),
  CHECK ((state = 'VALIDATING' AND lease_hash IS NOT NULL AND lease_until IS NOT NULL AND lease_until <= upload_expires_at AND next_offset = declared_bytes) OR
    (state <> 'VALIDATING' AND lease_hash IS NULL AND lease_until IS NULL)),
  CHECK ((state IN ('UPLOADING','VALIDATING','BOUND') AND terminal_at IS NULL) OR (state IN ('CONSUMED','FAILED','EXPIRED','CANCELLED') AND terminal_at IS NOT NULL)),
  CHECK ((reserved_bytes > 0 AND scrubbed_at IS NULL) OR (reserved_bytes = 0 AND scrubbed_at IS NOT NULL AND state IN ('CONSUMED','FAILED','EXPIRED','CANCELLED'))),
  CHECK ((operation_id IS NULL AND bound_expires_at IS NULL) OR (operation_id IS NOT NULL AND bound_expires_at IS NOT NULL AND bound_expires_at > created_at AND bound_expires_at <= absolute_expires_at)),
  CHECK ((state = 'BOUND' AND operation_id IS NOT NULL AND next_offset = declared_bytes AND canonical_data IS NOT NULL AND canonical_sha256 IS NOT NULL AND canonical_bytes IS NOT NULL
    AND canonical_mime IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND thumbnail_data IS NOT NULL AND thumbnail_sha256 IS NOT NULL AND thumbnail_bytes IS NOT NULL
    AND ${hash('canonical_sha256')} AND ${hash('thumbnail_sha256')} AND canonical_mime = source_mime
    AND canonical_bytes >= 1 AND canonical_bytes <= 524288 AND ${bytes('canonical_data')} = canonical_bytes
    AND thumbnail_bytes >= 1 AND thumbnail_bytes <= 81920 AND ${bytes('thumbnail_data')} = thumbnail_bytes
    AND width >= 1 AND width <= 8192 AND height >= 1 AND height <= 8192 AND width * height <= 4194304) OR
    (state <> 'BOUND' AND canonical_data IS NULL AND canonical_sha256 IS NULL AND canonical_bytes IS NULL AND canonical_mime IS NULL
      AND width IS NULL AND height IS NULL AND thumbnail_data IS NULL AND thumbnail_sha256 IS NULL AND thumbnail_bytes IS NULL))
)${strict};
CREATE INDEX mcp_v2_media_stage_owner ON mcp_v2_media_stage(tenant_id,account_id,client_id,state,upload_expires_at,id);
CREATE INDEX mcp_v2_media_stage_lease ON mcp_v2_media_stage(state,lease_until,id);
CREATE INDEX mcp_v2_media_stage_expiry ON mcp_v2_media_stage(absolute_expires_at,id);
CREATE INDEX mcp_v2_media_stage_quota ON mcp_v2_media_stage(tenant_id,quota_owner_key) WHERE reserved_bytes > 0;
CREATE INDEX mcp_v2_media_stage_product ON mcp_v2_media_stage(product_id,id);
CREATE TABLE mcp_v2_media_chunk (
  stage_id TEXT NOT NULL REFERENCES mcp_v2_media_stage(id) ON DELETE RESTRICT, "offset" ${integer} NOT NULL CHECK ("offset" >= 0),
  byte_length ${integer} NOT NULL CHECK (byte_length >= 1 AND byte_length <= 36864), ${h('sha256')}, data ${binary} NOT NULL,
  PRIMARY KEY (stage_id,"offset"), CHECK (${bytes('data')} = byte_length)
)${strict};
CREATE TABLE mcp_v2_media_pin (
  stage_id TEXT PRIMARY KEY REFERENCES mcp_v2_media_stage(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE RESTRICT,
  ${h('canonical_sha256')}, ${h('codec_digest')}, ${t('created_at')}, ${t('expires_at')}, CHECK (expires_at > created_at),
  UNIQUE (stage_id,operation_id)
)${strict};
CREATE INDEX mcp_v2_media_pin_operation ON mcp_v2_media_pin(operation_id);
CREATE TABLE mcp_v2_media_manifest_page (
  operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE RESTRICT,
  page_index ${integer} NOT NULL CHECK (page_index >= 0 AND page_index <= 15),
  page_json TEXT NOT NULL CHECK (${bytes('page_json')} >= 2 AND ${bytes('page_json')} <= 16384 AND ${object('page_json')}),
  ${h('page_hash')}, record_count ${integer} NOT NULL CHECK (record_count >= 1 AND record_count <= 32), ${t('created_at')},
  PRIMARY KEY (operation_id,page_index)
)${strict};
CREATE TABLE mcp_v2_media_asset_ref (
  operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE RESTRICT, ${h('asset_key')}, ${h('byte_sha256')},
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  byte_length ${integer} NOT NULL CHECK (byte_length >= 1 AND byte_length <= 524288),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('PRODUCT_MAIN','GALLERY','STAGE')), ${u('source_id')}, ${u('source_product_id')}, stage_id TEXT,
  before_needed ${integer} NOT NULL CHECK (before_needed IN (0,1)), after_needed ${integer} NOT NULL CHECK (after_needed IN (0,1)),
  CHECK (before_needed = 1 OR after_needed = 1),
  CHECK ((source_kind = 'STAGE' AND stage_id IS NOT NULL AND stage_id = source_id) OR (source_kind <> 'STAGE' AND stage_id IS NULL)),
  PRIMARY KEY (operation_id,asset_key), FOREIGN KEY (stage_id,operation_id) REFERENCES mcp_v2_media_pin(stage_id,operation_id) ON DELETE RESTRICT
)${strict};
CREATE INDEX mcp_v2_media_asset_stage ON mcp_v2_media_asset_ref(stage_id,operation_id);
CREATE TABLE mcp_v2_media_delivery (
  challenge_id TEXT NOT NULL REFERENCES mcp_v2_approval_challenge(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('PAGE','ASSET')), item_key TEXT NOT NULL CHECK (length(item_key) >= 1 AND length(item_key) <= 64),
  ${h('manifest_root')}, ${h('expected_hash')}, ${h('nonce_hash')}, ${t('issued_at')}, ${t('expires_at')},
  ack_at TEXT CHECK (ack_at IS NULL OR (${time('ack_at')})), page_index ${integer}, asset_key TEXT,
  CHECK (expires_at > issued_at AND (ack_at IS NULL OR (ack_at >= issued_at AND ack_at <= expires_at))),
  CHECK ((kind = 'PAGE' AND page_index IS NOT NULL AND page_index >= 0 AND page_index <= 15 AND asset_key IS NULL AND item_key = CAST(page_index AS TEXT)) OR
    (kind = 'ASSET' AND asset_key IS NOT NULL AND ${hash('asset_key')} AND item_key = asset_key AND page_index IS NULL)),
  PRIMARY KEY (challenge_id,kind,item_key),
  FOREIGN KEY (operation_id,page_index) REFERENCES mcp_v2_media_manifest_page(operation_id,page_index) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id,asset_key) REFERENCES mcp_v2_media_asset_ref(operation_id,asset_key) ON DELETE RESTRICT
)${strict};
CREATE INDEX mcp_v2_media_delivery_expiry ON mcp_v2_media_delivery(expires_at,challenge_id);
CREATE TABLE mcp_v2_media_approval_evidence (
  operation_id TEXT PRIMARY KEY REFERENCES mcp_v2_operation(id) ON DELETE RESTRICT,
  challenge_id TEXT NOT NULL REFERENCES mcp_v2_approval_challenge(id) ON DELETE RESTRICT,
  ${h('manifest_root')}, ${h('descriptor_hash')}, approver_id TEXT NOT NULL CHECK (length(approver_id) >= 1 AND length(approver_id) <= 128), ${h('session_hash')},
  account_auth_version ${integer} NOT NULL CHECK (account_auth_version >= 0), ${h('epoch_hash')}, ${h('build_digest')},
  tenant_revision ${integer} NOT NULL CHECK (tenant_revision >= 0), policy_id TEXT NOT NULL CHECK (${mediaPolicyCheck('policy_id')}),
  ${t('approved_at')}, ${t('expires_at')}, ${t('acknowledged_at')},
  CHECK (expires_at > approved_at AND acknowledged_at <= approved_at),
  FOREIGN KEY (operation_id) REFERENCES mcp_v2_approval(operation_id) ON DELETE RESTRICT
)${strict};
CREATE TABLE mcp_v2_media_event (
  id TEXT PRIMARY KEY CHECK (${uuid('id')}), ${t('at')}, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, client_id TEXT NOT NULL,
  grant_id TEXT NOT NULL, ${u('stage_id')}, ${u('correlation_id')},
  event TEXT NOT NULL CHECK (event IN ('BEGIN','APPEND','VALIDATE','BOUND','CONSUME','EXPIRE','CANCEL','FAIL','DENY')),
  outcome TEXT NOT NULL CHECK (length(outcome) >= 1 AND length(outcome) <= 80 AND ${pg ? "outcome ~ '^[A-Z][A-Z0-9_]*$'" : "outcome NOT GLOB '*[^A-Z0-9_]*' AND substr(outcome,1,1) GLOB '[A-Z]'"}),
  byte_count ${integer} NOT NULL CHECK (byte_count >= 0 AND byte_count <= 524288),
  tool_name TEXT CHECK (tool_name IS NULL OR tool_name IN ('media.prepare_upload','media.commit_upload','media.preview_layout','media.commit_layout')),
  operation_id TEXT CHECK (operation_id IS NULL OR (${uuid('operation_id')}))
)${strict};
CREATE INDEX mcp_v2_media_event_time ON mcp_v2_media_event(at,id);
CREATE INDEX mcp_v2_media_event_stage ON mcp_v2_media_event(stage_id,at,id);
`;
}
