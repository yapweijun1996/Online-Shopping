import { OPERATION_SCOPE_POLICIES } from './operation-policy.js';
export const LEGACY_MCP_AUDIT_TOOLS = Object.freeze(['catalog.list','catalog.get','catalog.history','catalog.categories','catalog.low_stock','orders.list','orders.get','analytics.summary']);
export const MCP_AUDIT_TOOLS = Object.freeze([...LEGACY_MCP_AUDIT_TOOLS, ...Object.keys(OPERATION_SCOPE_POLICIES)]);

export function mcpAuditSchema(dialect, { version = 34, table = 'mcp_audit', indexes = true } = {}) {
  if (!['sqlite', 'postgres'].includes(dialect) || ![33, 34].includes(version) || !['mcp_audit', 'mcp_audit_next34'].includes(table)) throw new TypeError('Unsupported audit schema.');
  const integer = dialect === 'postgres' ? 'BIGINT' : 'INTEGER', strict = dialect === 'sqlite' ? ' STRICT' : '';
  const tools = (version === 33 ? LEGACY_MCP_AUDIT_TOOLS : MCP_AUDIT_TOOLS).map(name => `'${name}'`).join(',');
  const id = version === 33 ? 'id TEXT PRIMARY KEY' : 'id TEXT NOT NULL UNIQUE';
  const sequence = dialect === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY';
  return `CREATE TABLE IF NOT EXISTS ${table} (
 ${id}, at TEXT NOT NULL, tenant_id TEXT NOT NULL, account_id TEXT, client_id TEXT, grant_id TEXT,
 correlation_id TEXT NOT NULL,
 event TEXT NOT NULL CHECK (event IN ('AUTHORIZE','ISSUE','REVOKE','READ','DENY','INVALIDATE'${version === 34 ? ",'CALL'" : ''})),
 tool_name TEXT CHECK (tool_name IS NULL OR tool_name IN (${tools})),
 resource_id TEXT, outcome TEXT NOT NULL,
 duration_ms ${integer} NOT NULL CHECK (duration_ms >= 0), result_count ${integer} NOT NULL CHECK (result_count >= 0)${version === 34 ? `,
 operation_id TEXT, sequence ${sequence}` : ''}
)${strict};
${indexes ? `CREATE INDEX IF NOT EXISTS mcp_audit_time ON ${table}(at);
${version === 34 ? `CREATE INDEX IF NOT EXISTS mcp_audit_operation_sequence ON ${table}(operation_id,at,sequence);\nCREATE INDEX IF NOT EXISTS mcp_audit_operation_anchor ON ${table}(operation_id,sequence);\n` : ''}` : ''}`;
}
