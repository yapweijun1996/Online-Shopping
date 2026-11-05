import { createHash } from 'node:crypto';
import { mcpAuditSchema, MCP_AUDIT_TOOLS } from './audit-schema.js';
const legacy = Object.freeze({ sqlite: 'e087465d8086577057a47e85406e61e3b4d5ca6ce7e2902417c377b6255370cc', postgres: '8536efe90ed79edc1fb5ae9181ad6081b59c86811d65156521c7ad9b6140a914' });
const current = Object.freeze({ sqlite: 'a2ae15cd2f4703d620d9df4454a8ea78bade651390b57ed5bbb5b229aecbced9', postgres: '0bc8b42038d0075b129f7059af203c20ad27b1d7e07fbeb29d2f1c8b73b844e8' });
const oldColumns = 'id,at,tenant_id,account_id,client_id,grant_id,correlation_id,event,tool_name,resource_id,outcome,duration_ms,result_count';

// Only physical storage metadata; never includes audit record values.
export async function mcpAuditFingerprint(store) {
  let shape;
  if (store.dialect === 'sqlite') {
    shape = (await store.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name='mcp_audit' OR tbl_name='mcp_audit' ORDER BY type,name"))
      .map(row => ({ ...row, sql: row.sql?.replaceAll('"mcp_audit"', 'mcp_audit').replace(/\s+/g, ' ').trim() ?? null }));
  } else if (store.dialect === 'postgres') {
    const columns = await store.all("SELECT column_name,ordinal_position,data_type,is_nullable,column_default,is_identity,identity_generation,identity_start,identity_increment,identity_maximum,identity_minimum,identity_cycle FROM information_schema.columns WHERE table_schema='public' AND table_name='mcp_audit' ORDER BY ordinal_position");
    const constraints = await store.all("SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname='mcp_audit' ORDER BY c.conname");
    const indexes = await store.all("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='mcp_audit' ORDER BY indexname");
    shape = { columns, constraints, indexes };
  } else throw new TypeError('Unsupported audit store.');
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}
export async function assertMcpAuditUpgradeSource(store) {
  const fingerprint = await mcpAuditFingerprint(store);
  if (![legacy[store.dialect], current[store.dialect]].includes(fingerprint)) throw new Error('Incompatible schema33 MCP audit storage.');
  return fingerprint === legacy[store.dialect] ? 'LEGACY' : 'CURRENT';
}
export async function assertMcpAuditStorage(store) {
  if (await mcpAuditFingerprint(store) !== current[store.dialect]) throw new Error('Incompatible MCP audit storage.');
}
export async function resetAuditSequence(store, table) {
  if (store.dialect !== 'postgres' || !['mcp_audit', 'mcp_v2_event'].includes(table)) throw new TypeError('Unsupported audit sequence.');
  await store.get(`SELECT setval(pg_get_serial_sequence('${table}','sequence'),COALESCE((SELECT MAX(sequence) FROM ${table}),1),EXISTS(SELECT 1 FROM ${table}))`);
}
// Joins the explicit global33->34 migration transaction; never repairs unknown DDL.
export async function migrateMcpAuditStorage(store) {
  const fingerprint = await mcpAuditFingerprint(store);
  if (fingerprint === current[store.dialect]) return;
  if (fingerprint !== legacy[store.dialect]) throw new Error('Incompatible schema33 MCP audit storage.');
  if (store.dialect === 'sqlite') {
    if (await store.get("SELECT name FROM sqlite_schema WHERE name='mcp_audit_next34'")) throw new Error('Partial MCP audit migration.');
    await store.exec(mcpAuditSchema('sqlite', { table: 'mcp_audit_next34', indexes: false }));
    await store.exec(`INSERT INTO mcp_audit_next34(${oldColumns}) SELECT ${oldColumns} FROM mcp_audit ORDER BY at,id;
      DROP TABLE mcp_audit; ALTER TABLE mcp_audit_next34 RENAME TO mcp_audit;`);
  } else await migratePostgresAudit(store);
  await store.exec(mcpAuditSchema(store.dialect));
  await assertMcpAuditStorage(store);
}
async function migratePostgresAudit(store) {
  await store.exec(`ALTER TABLE mcp_audit DROP CONSTRAINT mcp_audit_pkey;
    ALTER TABLE mcp_audit ADD CONSTRAINT mcp_audit_id_key UNIQUE(id);
    ALTER TABLE mcp_audit ADD COLUMN operation_id TEXT;
    ALTER TABLE mcp_audit ADD COLUMN sequence BIGINT;
    WITH ordered AS(SELECT id,ROW_NUMBER() OVER(ORDER BY at,id) AS n FROM mcp_audit)
      UPDATE mcp_audit a SET sequence=o.n FROM ordered o WHERE a.id=o.id;
    ALTER TABLE mcp_audit ALTER COLUMN sequence SET NOT NULL;
    ALTER TABLE mcp_audit ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE mcp_audit ADD CONSTRAINT mcp_audit_pkey PRIMARY KEY(sequence);
    ALTER TABLE mcp_audit DROP CONSTRAINT mcp_audit_tool_name_check;
    ALTER TABLE mcp_audit ADD CONSTRAINT mcp_audit_tool_name_check CHECK(tool_name IS NULL OR tool_name IN (${MCP_AUDIT_TOOLS.map(name => `'${name}'`).join(',')}));
    ALTER TABLE mcp_audit DROP CONSTRAINT mcp_audit_event_check;
    ALTER TABLE mcp_audit ADD CONSTRAINT mcp_audit_event_check CHECK(event IN ('AUTHORIZE','ISSUE','REVOKE','READ','DENY','INVALIDATE','CALL'));`);
  await resetAuditSequence(store, 'mcp_audit');
}
