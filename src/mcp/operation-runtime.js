import { readMcpDeploymentProfile, deploymentProfileAllowsProduction } from './deployment-profile.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOperationEpochFile } from './operation-epoch.js';
import { operationSchema, operationEventSchema } from './operation-schema.js';
import { mediaSchema, MEDIA_STORAGE_TABLES, mediaPolicyCheck } from './media-schema.js';
import { assertMcpAuditStorage, assertMcpAuditUpgradeSource, migrateMcpAuditStorage, resetAuditSequence } from './audit-storage.js';

export const OPERATION_STORAGE_VERSION = 3;
export const OPERATION_STORAGE_TABLES = Object.freeze([
  'mcp_v2_authorization_request', 'mcp_v2_scope_consent', 'mcp_v2_operation',
  'mcp_v2_approval_challenge', 'mcp_v2_approval', 'mcp_v2_event', ...MEDIA_STORAGE_TABLES,
]);
export const OPERATION_STORAGE_META = 'mcp_v2_schema';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Hash file names and bytes, independent of checkout path, timestamps, Git or
// operator-supplied revision labels. Fail closed if the installed source is incomplete.
export function operationBuildDigest(root = sourceRoot) {
  root = realpathSync(root);
  const hash = createHash('sha256');
  const files = ['package.json', 'package-lock.json'];
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(name);
      else throw new Error('MCP v2 source must contain only regular files.');
    }
  }
  visit('src');
  visit('public');
  for (const file of files.sort()) {
    const absolute = path.join(root, file), target = realpathSync(absolute);
    if (!target.startsWith(root + path.sep) || !lstatSync(target).isFile()) throw new Error('MCP v2 source must contain only regular files inside the source tree.');
    const bytes = readFileSync(target);
    // Existing public assets use internal file symlinks. Bind both their
    // destination and bytes without accepting paths outside the installed tree.
    hash.update(JSON.stringify([file, path.relative(root, target), bytes.length]) + '\n');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function readMcpV2Config(env, { mcpEnabled, sellerOrigin, dbPath, profile: suppliedProfile }) {
  const flag = env.MCP_V2_ENABLED ?? '0';
  if (!['0', '1'].includes(flag)) throw new Error('MCP_V2_ENABLED must be 0 or 1.');
  if (flag === '0') return Object.freeze({ enabled: false });
  const profile = readMcpDeploymentProfile(env, { mcpEnabled, sellerOrigin });
  if (suppliedProfile && JSON.stringify(suppliedProfile) !== JSON.stringify(profile)) throw new Error('MCP v2 deployment profile mismatch.');
  let origin;
  try { origin = new URL(sellerOrigin); } catch { /* Reject missing and malformed origins below. */ }
  if (mcpEnabled !== true || typeof sellerOrigin !== 'string' || origin?.protocol !== 'https:' ||
      origin.origin !== sellerOrigin || origin.username || origin.password) {
    throw new Error('MCP v2 requires MCP_ENABLED and an HTTPS SELLER_ORIGIN.');
  }
  if ((env.SHOP_MODE ?? 'manual') !== 'manual' || ![undefined, '0'].includes(env.SELLER_QUICK_LOGIN)) {
    throw new Error('MCP v2 requires a manual shop without quick login.');
  }
  let epoch, epochFile;
  try {
    if (typeof env.MCP_V2_EPOCH_FILE !== 'string' || !path.isAbsolute(env.MCP_V2_EPOCH_FILE)) throw new Error();
    const file = realpathSync(env.MCP_V2_EPOCH_FILE);
    // Caching an alias target would hide later replacement of the configured
    // pathname. Require the operator's actual canonical directory/file path.
    if (file !== path.resolve(env.MCP_V2_EPOCH_FILE) || !lstatSync(env.MCP_V2_EPOCH_FILE).isFile()) throw new Error();
    const databaseDirectory = path.dirname(path.resolve(dbPath));
    let resolvedDatabaseDirectory = databaseDirectory;
    try { resolvedDatabaseDirectory = realpathSync(databaseDirectory); } catch { /* A fresh database directory may not exist yet. */ }
    const publicDirectory = path.join(sourceRoot, 'public');
    if ([databaseDirectory, resolvedDatabaseDirectory, publicDirectory].some((directory) => file === directory || file.startsWith(directory + path.sep)) ||
        !lstatSync(file).isFile()) throw new Error();
    epoch = readOperationEpochFile(file);
    epochFile = file;
  } catch { throw new Error('MCP_V2_EPOCH_FILE must contain a canonical 32-byte epoch outside the database and public directories.'); }
  // Filesystem separation cannot establish separation from the backup domain.
  // Operators must still coordinate all-instance drain and rotation on restore.
  const sourceDigest = operationBuildDigest();
  // Trusted operator pin plus installed source. This is not self/hardware attestation.
  const buildDigest = deploymentProfileAllowsProduction(profile)
    ? sha256(JSON.stringify({ domain: 'mcp-v2/production-build/v1', backendIdentity: profile.backendIdentity, sourceDigest }))
    : sourceDigest;
  return Object.freeze({ enabled: true, epoch, epochFile, buildDigest, profile });
}

async function extensionObjects(store) {
  if (store.dialect === 'sqlite') {
    return store.all("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name GLOB 'mcp_v2_*' OR tbl_name GLOB 'mcp_v2_*' ORDER BY type, name");
  }
  if (store.dialect !== 'postgres') throw new TypeError('Unsupported database dialect.');
  const tables = await store.all("SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY table_name, ordinal_position");
  const constraints = await store.all("SELECT r.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY r.relname, c.conname");
  const indexes = await store.all("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'mcp!_v2!_%' ESCAPE '!' ORDER BY tablename, indexname");
  return { tables, constraints, indexes };
}

export function operationStorageManifestSql({ legacy = false } = {}) {
  return `SELECT encode(sha256(convert_to(jsonb_build_object(
    'tables', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name, ordinal_position) FROM (
      SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default${legacy ? '' : ', is_identity, identity_generation, identity_start, identity_increment, identity_maximum, identity_minimum, identity_cycle'}
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
  )::text, 'UTF8')), 'hex') AS digest`;
}

const manifestDigest = async (store, version = OPERATION_STORAGE_VERSION) => store.dialect === 'postgres'
  ? (await store.get(operationStorageManifestSql({ legacy: version < 3 }))).digest
  : sha256(JSON.stringify(await extensionObjects(store)));
export const operationStorageDdl = (dialect, { version = OPERATION_STORAGE_VERSION } = {}) => operationSchema(dialect, { auditSequence: version >= 3 }) + mediaSchema(dialect);
const ddlDigest = (store, version = OPERATION_STORAGE_VERSION) => sha256(operationStorageDdl(store.dialect, { version }));

async function assertStorage(store, version = OPERATION_STORAGE_VERSION) {
  if (![29, 30, 31, 32, 33, 34, 35].includes(await store.schemaVersion())) throw new Error('MCP v2 storage requires base schema 29 through 35.');
  const meta = await store.get('SELECT version, ddl_digest, manifest_digest FROM mcp_v2_schema WHERE id = 1');
  if (!meta || meta.version !== version || meta.ddl_digest !== ddlDigest(store, version) ||
      meta.manifest_digest !== await manifestDigest(store, version)) throw new Error('Incompatible MCP v2 storage extension.');
  for (const table of OPERATION_STORAGE_TABLES) await store.all(`SELECT * FROM ${table} LIMIT 0`);
}

export async function assertOperationStorage(store) {
  await assertStorage(store);
  if (await store.schemaVersion() >= 34) await assertMcpAuditStorage(store);
}
export async function assertOperationStorageForUpgrade(store) {
  const meta = await store.get('SELECT version FROM mcp_v2_schema WHERE id=1');
  if (![2,3].includes(meta?.version)) throw new Error('Incompatible operation storage upgrade.');
  await assertStorage(store, meta.version);
}

export async function operationStorageReady(store) {
  try { if (![34,35].includes(await store.schemaVersion())) return false; await assertStorage(store); await assertMcpAuditStorage(store); return true; } catch { return false; }
}

export function operationStorageMetaSchema(dialect, { version = OPERATION_STORAGE_VERSION } = {}) {
  if (!['sqlite', 'postgres'].includes(dialect) || ![2,3].includes(version)) throw new TypeError('Unsupported operation metadata schema.');
  return `CREATE TABLE mcp_v2_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = ${version}),
      ddl_digest TEXT NOT NULL CHECK (length(ddl_digest) = 64),
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64)
    )${dialect === 'sqlite' ? ' STRICT' : ''};`;
}

export function operationStorageSeedSql() {
  return `INSERT INTO mcp_v2_schema(id, version, ddl_digest, manifest_digest)
    VALUES (1, ${OPERATION_STORAGE_VERSION}, '${sha256(operationStorageDdl('postgres'))}', (${operationStorageManifestSql()}));`;
}

async function writeStorageMetadata(store, version = OPERATION_STORAGE_VERSION) {
  await store.run('INSERT INTO mcp_v2_schema(id, version, ddl_digest, manifest_digest) VALUES (1, ?, ?, ?)',
    version, ddlDigest(store, version), await manifestDigest(store, version));
  await assertStorage(store, version);
}

// The fresh SQL baseline initializes its metadata itself so direct SQL bootstrap
// and the JS loader have identical behavior. The loader verifies before commit.
export async function initializeFreshOperationStorage(store) {
  if (store.dialect !== 'postgres' || await store.schemaVersion() !== 35) throw new Error('Expected a fresh PostgreSQL schema 35.');
  await assertStorage(store);
  await assertMcpAuditStorage(store);
}

// Base migration29 calls this inside its transaction. Existing partial or
// unversioned prototypes are rejected, never adopted or silently repaired.
export async function initializeOperationStorage(store, options) {
  if (options === undefined || options?.enabled === false) return false;
  if (options?.enabled !== true) throw new TypeError('Explicit MCP v2 storage opt-in is required.');
  return store.transaction(async () => {
    if (![29, 30, 31, 32, 33, 34, 35].includes(await store.schemaVersion())) throw new Error('MCP v2 storage requires base schema 29 through 35.');
    const exists = store.dialect === 'sqlite'
      ? Boolean(await store.get("SELECT name FROM sqlite_schema WHERE name = 'mcp_v2_schema'"))
      : store.dialect === 'postgres' && Boolean((await store.get("SELECT to_regclass('public.mcp_v2_schema') AS name")).name);
    if (exists) { await assertOperationStorage(store); return true; }
    const objects = await extensionObjects(store);
    if (store.dialect === 'sqlite' ? objects.length : objects.tables.length || objects.constraints.length || objects.indexes.length) {
      throw new Error('Unversioned MCP v2 storage must be reviewed before initialization.');
    }
    await store.exec(operationStorageDdl(store.dialect));
    await store.exec(operationStorageMetaSchema(store.dialect));
    await writeStorageMetadata(store);
    return true;
  });
}

// Explicit global30->31 migration only. Never adopt partial prototypes or let a
// request silently upgrade an existing metadata version. Caller owns transaction.
export async function upgradeMediaStorage(store) {
  if (await store.schemaVersion() !== 30) throw new Error('Media storage migration requires schema30.');
  const meta = await store.get('SELECT version, ddl_digest, manifest_digest FROM mcp_v2_schema WHERE id = 1');
  if ([2,3].includes(meta?.version)) { await assertStorage(store, meta.version); return; }
  if (!meta || meta.version !== 1 || meta.ddl_digest !== sha256(operationSchema(store.dialect, { media: false })) ||
      meta.manifest_digest !== await manifestDigest(store, 1)) throw new Error('Incompatible schema30 operation storage.');
  await store.exec(`ALTER TABLE mcp_v2_operation ADD COLUMN media_policy_id TEXT CHECK (media_policy_id IS NULL OR (${mediaPolicyCheck('media_policy_id')}))`);
  await store.exec(mediaSchema(store.dialect));
  await store.exec('DROP TABLE mcp_v2_schema');
  await store.exec(operationStorageMetaSchema(store.dialect, { version: 2 }));
  await writeStorageMetadata(store, 2);
}

// Explicit schema33->34 only. Validate both known source stores before any DDL;
// the caller's outer transaction also owns global version/inventory checks.
export async function upgradeOperationAuditStorage(store) {
  if (await store.schemaVersion() !== 33) throw new Error('Operation audit migration requires schema33.');
  const auditSource = await assertMcpAuditUpgradeSource(store);
  await assertOperationStorageForUpgrade(store);
  const meta = await store.get('SELECT version FROM mcp_v2_schema WHERE id=1');
  if (auditSource === 'CURRENT') throw new Error('Partial schema34 audit storage.');
  if (meta.version === 2) {
    const columns = 'id,at,tenant_id,account_id,client_id,grant_id,tool_name,resource_id,operation_id,approver_id,event,outcome,correlation_id';
    if (store.dialect === 'sqlite') {
      if (await store.get("SELECT name FROM sqlite_schema WHERE name='mcp_v2_event_next34'")) throw new Error('Partial operation audit migration.');
      await store.exec(operationEventSchema('sqlite', { table: 'mcp_v2_event_next34', indexes: false }));
      await store.exec(`INSERT INTO mcp_v2_event_next34(${columns}) SELECT ${columns} FROM mcp_v2_event ORDER BY at,id;
        DROP TABLE mcp_v2_event; ALTER TABLE mcp_v2_event_next34 RENAME TO mcp_v2_event;`);
    } else {
      await store.exec(`ALTER TABLE mcp_v2_event DROP CONSTRAINT mcp_v2_event_pkey;
        ALTER TABLE mcp_v2_event ADD CONSTRAINT mcp_v2_event_id_key UNIQUE(id);
        ALTER TABLE mcp_v2_event ADD COLUMN sequence BIGINT;
        WITH ordered AS(SELECT id,ROW_NUMBER() OVER(ORDER BY at,id) AS n FROM mcp_v2_event)
          UPDATE mcp_v2_event e SET sequence=o.n FROM ordered o WHERE e.id=o.id;
        ALTER TABLE mcp_v2_event ALTER COLUMN sequence SET NOT NULL;
        ALTER TABLE mcp_v2_event ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY;
        ALTER TABLE mcp_v2_event ADD CONSTRAINT mcp_v2_event_pkey PRIMARY KEY(sequence);`);
      await resetAuditSequence(store, 'mcp_v2_event');
    }
    await store.exec(operationEventSchema(store.dialect));
  }
  await migrateMcpAuditStorage(store);
  await store.exec('DROP TABLE mcp_v2_schema');
  await store.exec(operationStorageMetaSchema(store.dialect));
  await writeStorageMetadata(store);
}
