import { randomUUID } from 'node:crypto';
import { stamp } from './credentials.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Logical proof, distinct from the typed RPC invocation record. Trusted callers
// supply only fixed events/outcomes inside the operation writer transaction.
export function recordOperationEvent(store,row,event,outcome,approverId=null,{at=stamp(),cancel=false}={}) {
  return store.run(`INSERT INTO mcp_v2_event(id,at,tenant_id,account_id,client_id,grant_id,tool_name,resource_id,
    operation_id,approver_id,event,outcome,correlation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  randomUUID(),at,row.tenant_id,row.account_id,row.client_id,row.grant_id,cancel?'operations.cancel':row.tool_name,
  uuid.test(row.resource_id || '')?row.resource_id:null,row.id,approverId,event,outcome,row.correlation_id);
}
