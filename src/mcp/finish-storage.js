import { createHash } from 'node:crypto';

// Independently versioned optional extension. Production installation is an
// explicit host operation; application startup only asserts existing storage.
export const FINISH_STORAGE_VERSION = 2;
export const FINISH_RETENTION_MS = 90 * 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');

const unsupported = () => { throw new TypeError('Incompatible finish storage; run the reviewed host installer.'); };
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
  )${strict};
  CREATE INDEX seller_mcp_finish_retention ON seller_mcp_finish(tenant_id,created_at,id);
  CREATE INDEX seller_mcp_finish_account ON seller_mcp_finish(account_id,id);
  CREATE INDEX seller_mcp_finish_item_operation ON seller_mcp_finish_item(operation_id);
  CREATE INDEX seller_mcp_finish_event_job ON seller_mcp_finish_event(job_id,at,id);
  CREATE INDEX seller_mcp_finish_revalidation_source ON seller_mcp_finish_revalidation(source_id);
  CREATE INDEX seller_mcp_finish_revalidation_replacement ON seller_mcp_finish_revalidation(replacement_id);
  CREATE TABLE seller_mcp_finish_schema(id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL CHECK(version=2),ddl_digest TEXT NOT NULL CHECK(length(ddl_digest)=64),
    manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64))${strict};`;
}

export async function optionalStorageObjects(store,tablePrefix) {
  if(!['seller_mcp_finish','seller_mcp_create_draft'].includes(tablePrefix))throw new TypeError('Unsupported optional storage namespace.');
  const prefix=tablePrefix.replaceAll('_','!_')+'%';
  if (store.dialect === 'sqlite') return store.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB ? OR tbl_name GLOB ? ORDER BY type,name",tablePrefix+'*',tablePrefix+'*');
  if (store.dialect !== 'postgres') unsupported();
  const columns = await store.all(`SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default,
    collation_name,is_identity,identity_generation,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE '${prefix}' ESCAPE '!' ORDER BY table_name,ordinal_position`);
  const tables = await store.all(`SELECT r.relname AS table_name,r.relrowsecurity,r.relforcerowsecurity
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname LIKE '${prefix}' ESCAPE '!' AND r.relkind='r' ORDER BY r.relname`);
  const constraints = await store.all(`SELECT r.relname AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition,c.convalidated
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname LIKE '${prefix}' ESCAPE '!' ORDER BY r.relname,c.conname`);
  const indexes = await store.all(`SELECT r.relname AS table_name,i.relname AS index_name,pg_get_indexdef(x.indexrelid) AS definition,x.indisvalid,x.indisready
    FROM pg_index x JOIN pg_class r ON r.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname LIKE '${prefix}' ESCAPE '!' ORDER BY r.relname,i.relname`);
  const triggers = await store.all(`SELECT r.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname LIKE '${prefix}' ESCAPE '!' AND NOT t.tgisinternal ORDER BY r.relname,t.tgname`);
  return {tables,columns,constraints,indexes,triggers};
}
export const optionalStorageManifest = async (store,tablePrefix) => hash(JSON.stringify(await optionalStorageObjects(store,tablePrefix)));
const objects=store=>optionalStorageObjects(store,'seller_mcp_finish');
export async function finishStorageExists(store) {
  const row = store.dialect === 'sqlite'
    ? await store.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='seller_mcp_finish_schema'")
    : await store.get("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='seller_mcp_finish_schema'");
  return Boolean(row);
}
export async function assertFinishStorage(store) {
  if (!await finishStorageExists(store)) unsupported();
  let row;try { row = await store.get('SELECT version,ddl_digest,manifest_digest FROM seller_mcp_finish_schema WHERE id=1'); } catch { unsupported(); }
  if (row?.version !== FINISH_STORAGE_VERSION || row.ddl_digest !== hash(finishStorageSql(store.dialect)) ||
      row.manifest_digest !== hash(JSON.stringify(await objects(store)))) unsupported();
  if(store.dialect==='postgres'){
    const access=await store.get(`SELECT bool_and(has_table_privilege(current_user,name,'SELECT') AND has_table_privilege(current_user,name,'INSERT')
      AND has_table_privilege(current_user,name,'UPDATE') AND has_table_privilege(current_user,name,'DELETE')) AS allowed
      FROM (VALUES('seller_mcp_finish'),('seller_mcp_finish_item'),('seller_mcp_finish_event'),('seller_mcp_finish_revalidation')) AS t(name)`);
    if(access?.allowed!==true)unsupported();
  }
}
export async function initializeFinishStorage(store) {
  // This is an installer/development constructor, never a production route.
  return store.transaction(async () => {
    if (!await finishStorageExists(store)) {
      const existing = await objects(store);
      if (store.dialect === 'sqlite' ? existing.length : existing.tables.length) unsupported();
      await store.exec(finishStorageSql(store.dialect));
      await store.run('INSERT INTO seller_mcp_finish_schema(id,version,ddl_digest,manifest_digest) VALUES(1,?,?,?)',
        FINISH_STORAGE_VERSION,hash(finishStorageSql(store.dialect)),hash(JSON.stringify(await objects(store))));
    }
    await assertFinishStorage(store);
    return {version:FINISH_STORAGE_VERSION,installed:true};
  });
}

// Caller holds a trusted tenant lifecycle fence. Cleanup is metadata-only and
// never creates tables, grants authority, changes products or commits a proposal.
// At most limit rows (including children) are deleted in one call.
export async function maintainFinishStorage(store,{tenantId,now=new Date().toISOString(),limit=100}={}) {
  if (typeof tenantId !== 'string' || !tenantId || !Number.isSafeInteger(limit) || limit<1 || limit>100 ||
      typeof now !== 'string' || new Date(now).toISOString() !== now) throw new TypeError('Invalid finish cleanup bounds.');
  if (!await finishStorageExists(store)) return {deleted:0};
  return store.transaction(async () => {
    await assertFinishStorage(store);
    const cutoff=new Date(Date.parse(now)-FINISH_RETENTION_MS).toISOString();let deleted=0;
    for(const [table,keys] of [
      ['seller_mcp_finish_event',['id']],
      ['seller_mcp_finish_revalidation',['job_id','idempotency_hash']],
      ['seller_mcp_finish_item',['job_id','position']],
    ]) {
      if(deleted===limit)break;
      const rows=await store.all(`SELECT c.${keys.join(',c.')} FROM ${table} c JOIN seller_mcp_finish j ON j.id=c.job_id
        WHERE j.tenant_id=? AND j.created_at<=? ORDER BY c.${keys.join(',c.')} LIMIT ${limit-deleted}`,tenantId,cutoff);
      for(const row of rows){await store.run(`DELETE FROM ${table} WHERE ${keys.map(key=>key+'=?').join(' AND ')}`,...keys.map(key=>row[key]));deleted++;}
    }
    if(deleted<limit) {
      const jobs=await store.all(`SELECT j.id FROM seller_mcp_finish j WHERE j.tenant_id=? AND j.created_at<=?
        AND NOT EXISTS(SELECT 1 FROM seller_mcp_finish_item i WHERE i.job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM seller_mcp_finish_event e WHERE e.job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM seller_mcp_finish_revalidation r WHERE r.job_id=j.id)
        ORDER BY j.created_at,j.id LIMIT ${limit-deleted}`,tenantId,cutoff);
      for(const job of jobs){await store.run('DELETE FROM seller_mcp_finish WHERE id=?',job.id);deleted++;}
    }
    return {deleted};
  });
}
