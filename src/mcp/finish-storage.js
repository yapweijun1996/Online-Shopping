import { createHash } from 'node:crypto';

// Independently opted-in development extension. No production migration is
// implicit; the normal operation storage manifest remains unchanged.
export function finishStorageSql(dialect) {
  if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Unsupported finish storage.');
  const strict = dialect === 'sqlite' ? ' STRICT' : '';
  return `CREATE TABLE seller_mcp_finish (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, client_id TEXT NOT NULL, grant_id TEXT NOT NULL,
    session_hash TEXT NOT NULL, epoch_hash TEXT NOT NULL, build_digest TEXT NOT NULL, tenant_revision INTEGER NOT NULL,
    idempotency_hash TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(tenant_id,account_id,client_id,idempotency_hash)
  )${strict};
  CREATE TABLE seller_mcp_finish_item (
    job_id TEXT NOT NULL REFERENCES seller_mcp_finish(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position>=0 AND position<5),
    operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE CASCADE, preview_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','COMMITTED','VERIFIED','NEEDS_REVIEW','FAILED','RETRY')),
    error_code TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(job_id,position), UNIQUE(job_id,operation_id)
  )${strict};
  CREATE TABLE seller_mcp_finish_revalidation (
    job_id TEXT NOT NULL REFERENCES seller_mcp_finish(id) ON DELETE CASCADE,
    idempotency_hash TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE CASCADE,
    replacement_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
    PRIMARY KEY(job_id,idempotency_hash)
  )${strict};
  CREATE TABLE seller_mcp_finish_event (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES seller_mcp_finish(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL REFERENCES mcp_v2_operation(id) ON DELETE CASCADE, event TEXT NOT NULL, at TEXT NOT NULL
  )${strict};`;
}
export async function initializeFinishStorage(store) {
  const ddl = finishStorageSql(store.dialect), digest = createHash('sha256').update(ddl).digest('hex');
  await store.transaction(async () => {
    const exists = store.dialect === 'sqlite'
      ? await store.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='seller_mcp_finish_schema'")
      : await store.get("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='seller_mcp_finish_schema'");
    if (!exists) {
      // Refuse to adopt an unversioned prototype.
      const partial = store.dialect === 'sqlite'
        ? await store.get("SELECT name FROM sqlite_schema WHERE name LIKE 'seller_mcp_finish%'")
        : await store.get("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'seller_mcp_finish%'");
      if (partial) throw new TypeError('Unversioned finish storage.');
      await store.exec(ddl);
      await store.exec(`CREATE TABLE seller_mcp_finish_schema(id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL)${store.dialect === 'sqlite' ? ' STRICT' : ''}`);
      await store.run('INSERT INTO seller_mcp_finish_schema(id,digest) VALUES(1,?)', digest);
    }
    if ((await store.get('SELECT digest FROM seller_mcp_finish_schema WHERE id=1'))?.digest !== digest) throw new TypeError('Incompatible finish storage.');
  });
}
