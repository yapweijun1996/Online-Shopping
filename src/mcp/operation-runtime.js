import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationEpochHash } from './operation-epoch.js';
import { operationSchema } from './operation-schema.js';
import { mediaSchema, MEDIA_STORAGE_TABLES, mediaPolicyCheck } from './media-schema.js';

export const OPERATION_STORAGE_VERSION = 2;
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

export function readMcpV2Config(env, { mcpEnabled, sellerOrigin, dbPath }) {
  const flag = env.MCP_V2_ENABLED ?? '0';
  if (!['0', '1'].includes(flag)) throw new Error('MCP_V2_ENABLED must be 0 or 1.');
  if (flag === '0') return Object.freeze({ enabled: false });
  // This branch is an isolated implementation, without an operational restore
  // rehearsal, coordinated epoch rotation, retention policy or release review.
  if (env.NODE_ENV === 'production') throw new Error('MCP v2 production activation requires a reviewed release.');
  let origin;
  try { origin = new URL(sellerOrigin); } catch { /* Reject missing and malformed origins below. */ }
  if (mcpEnabled !== true || typeof sellerOrigin !== 'string' || origin?.protocol !== 'https:' ||
      origin.origin !== sellerOrigin || origin.username || origin.password) {
    throw new Error('MCP v2 requires MCP_ENABLED and an HTTPS SELLER_ORIGIN.');
  }
  if ((env.SHOP_MODE ?? 'manual') !== 'manual' || ![undefined, '0'].includes(env.SELLER_QUICK_LOGIN)) {
    throw new Error('MCP v2 requires a manual shop without quick login.');
  }
  let epoch;
  try {
    if (typeof env.MCP_V2_EPOCH_FILE !== 'string' || !path.isAbsolute(env.MCP_V2_EPOCH_FILE)) throw new Error();
    const file = realpathSync(env.MCP_V2_EPOCH_FILE);
    const databaseDirectory = path.dirname(path.resolve(dbPath));
    let resolvedDatabaseDirectory = databaseDirectory;
    try { resolvedDatabaseDirectory = realpathSync(databaseDirectory); } catch { /* A fresh database directory may not exist yet. */ }
    const publicDirectory = path.join(sourceRoot, 'public');
    if ([databaseDirectory, resolvedDatabaseDirectory, publicDirectory].some((directory) => file === directory || file.startsWith(directory + path.sep)) ||
        !lstatSync(file).isFile()) throw new Error();
    epoch = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    operationEpochHash(epoch);
  } catch { throw new Error('MCP_V2_EPOCH_FILE must contain a canonical 32-byte epoch outside the database and public directories.'); }
  // Filesystem separation cannot establish separation from the backup domain.
  // Operators must still coordinate all-instance drain and rotation on restore.
  return Object.freeze({ enabled: true, epoch, buildDigest: operationBuildDigest() });
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

export function operationStorageManifestSql() {
  return `SELECT encode(sha256(convert_to(jsonb_build_object(
    'tables', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name, ordinal_position) FROM (
      SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
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

const manifestDigest = async (store) => store.dialect === 'postgres'
  ? (await store.get(operationStorageManifestSql())).digest
  : sha256(JSON.stringify(await extensionObjects(store)));
export const operationStorageDdl = dialect => operationSchema(dialect) + mediaSchema(dialect);
const ddlDigest = (store) => sha256(operationStorageDdl(store.dialect));

async function assertStorage(store) {
  if (![29, 30, 31, 32].includes(await store.schemaVersion())) throw new Error('MCP v2 storage requires base schema 29, 30, 31 or 32.');
  const meta = await store.get('SELECT version, ddl_digest, manifest_digest FROM mcp_v2_schema WHERE id = 1');
  if (!meta || meta.version !== OPERATION_STORAGE_VERSION || meta.ddl_digest !== ddlDigest(store) ||
      meta.manifest_digest !== await manifestDigest(store)) throw new Error('Incompatible MCP v2 storage extension.');
  for (const table of OPERATION_STORAGE_TABLES) await store.all(`SELECT * FROM ${table} LIMIT 0`);
}

export const assertOperationStorage = store => assertStorage(store);

export async function operationStorageReady(store) {
  try { if (await store.schemaVersion() !== 32) return false; await assertStorage(store); return true; } catch { return false; }
}

export function operationStorageMetaSchema(dialect) {
  if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Unsupported database dialect.');
  return `CREATE TABLE mcp_v2_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 2),
      ddl_digest TEXT NOT NULL CHECK (length(ddl_digest) = 64),
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64)
    )${dialect === 'sqlite' ? ' STRICT' : ''};`;
}

export function operationStorageSeedSql() {
  return `INSERT INTO mcp_v2_schema(id, version, ddl_digest, manifest_digest)
    VALUES (1, ${OPERATION_STORAGE_VERSION}, '${sha256(operationStorageDdl('postgres'))}', (${operationStorageManifestSql()}));`;
}

async function writeStorageMetadata(store) {
  await store.run('INSERT INTO mcp_v2_schema(id, version, ddl_digest, manifest_digest) VALUES (1, ?, ?, ?)',
    OPERATION_STORAGE_VERSION, ddlDigest(store), await manifestDigest(store));
  await assertStorage(store);
}

// The fresh SQL baseline initializes its metadata itself so direct SQL bootstrap
// and the JS loader have identical behavior. The loader verifies before commit.
export async function initializeFreshOperationStorage(store) {
  if (store.dialect !== 'postgres' || await store.schemaVersion() !== 32) throw new Error('Expected a fresh PostgreSQL schema 32.');
  await assertStorage(store);
}

// Base migration29 calls this inside its transaction. Existing partial or
// unversioned prototypes are rejected, never adopted or silently repaired.
export async function initializeOperationStorage(store, options) {
  if (options === undefined || options?.enabled === false) return false;
  if (options?.enabled !== true) throw new TypeError('Explicit MCP v2 storage opt-in is required.');
  return store.transaction(async () => {
    if (![29, 30, 31, 32].includes(await store.schemaVersion())) throw new Error('MCP v2 storage requires base schema 29, 30, 31 or 32.');
    const exists = store.dialect === 'sqlite'
      ? Boolean(await store.get("SELECT name FROM sqlite_schema WHERE name = 'mcp_v2_schema'"))
      : store.dialect === 'postgres' && Boolean((await store.get("SELECT to_regclass('public.mcp_v2_schema') AS name")).name);
    if (exists) { await assertStorage(store); return true; }
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
  if (meta?.version === OPERATION_STORAGE_VERSION) { await assertStorage(store); return; }
  if (!meta || meta.version !== 1 || meta.ddl_digest !== sha256(operationSchema(store.dialect, { media: false })) ||
      meta.manifest_digest !== await manifestDigest(store)) throw new Error('Incompatible schema30 operation storage.');
  await store.exec(`ALTER TABLE mcp_v2_operation ADD COLUMN media_policy_id TEXT CHECK (media_policy_id IS NULL OR (${mediaPolicyCheck('media_policy_id')}))`);
  await store.exec(mediaSchema(store.dialect));
  await store.exec('DROP TABLE mcp_v2_schema');
  await store.exec(operationStorageMetaSchema(store.dialect));
  await writeStorageMetadata(store);
}
