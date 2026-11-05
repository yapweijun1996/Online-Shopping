import { createHash } from 'node:crypto';
import { mcpAuditSchema } from '../../src/mcp/audit-schema.js';
import { operationEventSchema } from '../../src/mcp/operation-schema.js';
import { operationStorageDdl, operationStorageMetaSchema, operationStorageManifestSql } from '../../src/mcp/operation-runtime.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const auditColumns='id,at,tenant_id,account_id,client_id,grant_id,correlation_id,event,tool_name,resource_id,outcome,duration_ms,result_count';
export const legacyMcpAuditFixtureSql=dialect=>`CREATE TEMP TABLE mcp_audit_fixture_rows AS SELECT ${auditColumns} FROM mcp_audit;
DROP TABLE mcp_audit;
${mcpAuditSchema(dialect,{version:33})}
INSERT INTO mcp_audit(${auditColumns}) SELECT ${auditColumns} FROM mcp_audit_fixture_rows;
DROP TABLE mcp_audit_fixture_rows;`;

// Tests that start from today's fresh baseline must restore actual pre34 audit
// DDL, not only lower schema_meta. All historical columns/UUIDs are preserved.
export async function restoreLegacyAuditFixture(store) {
  return store.transaction(async()=>{
    for(const [table,ddl] of [['mcp_audit',mcpAuditSchema(store.dialect,{version:33})],['mcp_v2_event',operationEventSchema(store.dialect,{auditSequence:false})]]) {
      const rows=await store.all(`SELECT * FROM ${table}`);
      await store.exec(`DROP TABLE ${table}`);await store.exec(ddl);
      for(const {sequence:_sequence,operation_id:operationId,...rest} of rows) {
        const row=table==='mcp_v2_event'?{...rest,operation_id:operationId}:rest,keys=Object.keys(row);
        await store.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(key=>row[key]));
      }
    }
    await store.exec('DROP TABLE mcp_v2_schema');await store.exec(operationStorageMetaSchema(store.dialect,{version:2}));
    const manifest=store.dialect==='postgres'?(await store.get(operationStorageManifestSql({legacy:true}))).digest:
      sha(JSON.stringify(await store.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'mcp_v2_*' OR tbl_name GLOB 'mcp_v2_*' ORDER BY type,name")));
    await store.run('INSERT INTO mcp_v2_schema VALUES(1,2,?,?)',sha(operationStorageDdl(store.dialect,{version:2})),manifest);
  });
}
