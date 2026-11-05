import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { operationEpochHash } from './operation-epoch.js';
import { verifyOperationControlAuthority } from './operation-authorization.js';
import { recordMcpAudit, MCP_AUDIT_OUTCOMES, readOperationAuditAnchors } from './audit.js';
import { recordOperationEvent } from './operation-events.js';
import { expireOperationRecord } from './operation-expiry.js';
import { operationInstant } from './operation-maintenance.js';
import { OPERATION_CONTROL_CONTRACTS } from './operation-control-contracts.js';
import { valid } from './tools.js';
const denied=()=>{throw new ApiError(403,'FORBIDDEN','Operation authorization failed.');};
const invalid=()=>{throw new ApiError(400,'INVALID_INPUT','Invalid operation control arguments.');};
const corrupt=()=>{throw new ApiError(503,'AUDIT_UNAVAILABLE','Operation audit metadata is unavailable.');};
const nonterminal=new Set(['PREPARED','PENDING_APPROVAL','APPROVED']);
const historicalOutcomes=new Set([...MCP_AUDIT_OUTCOMES,'MEDIA_REVIEW_ACKNOWLEDGED','CURRENCY_CHANGE_ACKNOWLEDGED','FORBIDDEN']);
const cursorKeys='anchors,at,binding,expiresAt,limit,position,version';
// Only source-owned closures can select a store, scope policy or HMAC key.
export function createOperationControls({store,binding,config,tenantGuard,quickLogin}) {
  if(config.mcpEnabled!==true||config.mcpV2?.enabled!==true||config.production===true||config.shopMode==='public-demo'||quickLogin!==false||!tenantGuard?.withActiveTenant)denied();
  const {epoch,buildDigest}=config.mcpV2,epochHash=operationEpochHash(epoch);
  const key=createHmac('sha256',Buffer.from(epoch,'base64url')).update('mcp-v2/operation-audit-cursor/v1\0').digest();
  const mac=text=>createHmac('sha256',key).update(text).digest('base64url');
  function encode(value){const text=Buffer.from(canonicalOperationJson(value)).toString('base64url');return text+'.'+mac(text);}
  function decode(token,expected,limit) {
    if(typeof token!=='string'||token.length>3072||!/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.test(token))invalid();
    const [text,signature]=token.split('.');const actual=Buffer.from(signature,'base64url'),want=Buffer.from(mac(text),'base64url');
    if(actual.length!==want.length||actual.toString('base64url')!==signature||!timingSafeEqual(actual,want))invalid();
    let value;try{const bytes=Buffer.from(text,'base64url');if(bytes.toString('base64url')!==text)invalid();value=JSON.parse(bytes.toString('utf8'));if(canonicalOperationJson(value)!==bytes.toString('utf8'))invalid();}catch{invalid();}
    if(!value||Object.keys(value).sort().join(',')!==cursorKeys||value.version!==1||value.binding!==expected||value.limit!==limit||
      !operationInstant(value.at)||!operationInstant(value.expiresAt)||value.at>new Date().toISOString()||value.expiresAt<=new Date().toISOString()||Date.parse(value.expiresAt)-Date.parse(value.at)!==900000||
      !Array.isArray(value.anchors)||value.anchors.length!==2||!value.anchors.every(n=>Number.isSafeInteger(n)&&n>=0)||
      !Array.isArray(value.position)||value.position.length!==3||!operationInstant(value.position[0])||value.position[0]>value.at||![0,1].includes(value.position[1])||!Number.isSafeInteger(value.position[2])||value.position[2]<1||value.position[2]>value.anchors[value.position[1]])invalid();
    return value;
  }
  async function invocation(row,name,outcome){return recordMcpAudit(store,{tenantId:row.tenant_id,accountId:row.account_id,clientId:row.client_id,grantId:row.grant_id,
    toolName:name,resourceId:row.id,operationId:row.id,correlationId:row.correlation_id,event:name==='operations.cancel'?'CALL':'READ',outcome,durationMs:0,resultCount:1});}
  async function get(row) {
    let inventoryReason=null;
    if(row.tool_name==='inventory.preview_adjustment'&&row.state==='COMMITTED') {
      const records=await store.all("SELECT reason_code FROM inventory_movement WHERE product_id=? AND operation_id=? AND actor_id=? AND client_id=? AND grant_id=? AND correlation_id=? AND source='MCP_ADJUST' LIMIT 2",row.resource_id,row.id,row.account_id,row.client_id,row.grant_id,row.correlation_id);
      if(records.length!==1||!['COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER'].includes(records[0].reason_code))corrupt();
      inventoryReason=records[0].reason_code;
    }
    return {operationId:row.id,status:row.state,toolName:row.tool_name,resourceType:row.resource_type,resourceId:row.resource_id,risk:row.risk,
      createdAt:row.created_at,expiresAt:row.expires_at,receiptExpiresAt:row.receipt_expires_at,proposalRedacted:row.redacted_at!==null,
      proposalExpired:row.expires_at<=new Date().toISOString(),receiptAvailable:row.state==='COMMITTED'&&row.result_json!==null,inventoryReason};
  }
  async function cancel(row) {
    if(row.state==='CANCELLED'){await invocation(row,'operations.cancel','REPLAY');return{operationId:row.id,status:'CANCELLED',replayed:true};}
    if(!nonterminal.has(row.state))throw new ApiError(409,'OPERATION_TERMINAL','The operation is already terminal.');
    const now=new Date().toISOString();
    const approval=await store.get('SELECT expires_at FROM mcp_v2_approval WHERE operation_id=?',row.id);
    if(row.expires_at<=now||(row.state==='APPROVED'&&approval?.expires_at<=now)) {
      await expireOperationRecord(store,row,now);await invocation(row,'operations.cancel','EXPIRED');
      return {operationId:row.id,status:'EXPIRED',replayed:false};
    }
    const changed=await store.get("UPDATE mcp_v2_operation SET state='CANCELLED' WHERE id=? AND state=? RETURNING id",row.id,row.state);
    if(!changed)throw new ApiError(409,'OPERATION_CONFLICT','The operation changed concurrently.');
    await store.run('UPDATE mcp_v2_approval SET consumed_at=? WHERE operation_id=? AND consumed_at IS NULL',now,row.id);
    await store.run('UPDATE mcp_v2_approval_challenge SET consumed_at=? WHERE operation_id=? AND consumed_at IS NULL',now,row.id);
    await recordOperationEvent(store,row,'CANCEL','CANCELLED',null,{at:now,cancel:true});await invocation(row,'operations.cancel','CANCELLED');
    return {operationId:row.id,status:'CANCELLED',replayed:false};
  }
  async function audit(row,args,tenantRevision,authority) {
    const limit=args.limit??25;
    const cursorBinding=mac(canonicalOperationJson({operationId:row.id,tenantId:row.tenant_id,tenantRevision,accountId:row.account_id,clientId:row.client_id,grantId:row.grant_id,
      accountAuthVersion:authority.accountAuthVersion,grantExpiresAt:authority.grantExpiresAt,epochHash,buildDigest,issuer:binding.issuer,resource:binding.resource}));
    let cursor;
    if(args.cursor)cursor=decode(args.cursor,cursorBinding,limit);
    else {
      // A single statement captures both independent insertion sequence anchors.
      const anchors=await readOperationAuditAnchors(store,row.id);
      const at=new Date().toISOString();cursor={version:1,binding:cursorBinding,limit,anchors:[anchors.lifecycle,anchors.calls],at,expiresAt:new Date(Date.parse(at)+900000).toISOString(),position:null};
    }
    const keys=[row.id,row.tenant_id,row.account_id,row.client_id,row.grant_id,row.correlation_id];
    const cutoff=new Date(Date.parse(cursor.at)-90*86400000).toISOString();
    const position=cursor.position;
    const positionSql=source=>position?` AND (at>? OR (at=? AND (${source}>? OR (${source}=? AND sequence>?))))`:'';
    const argsPosition=position?[position[0],position[0],position[1],position[1],position[2]]:[];
    const rows=await store.all(`SELECT * FROM (
      SELECT * FROM (
      SELECT id,at,0 AS source_rank,sequence,tool_name,event,outcome,account_id,client_id,grant_id,approver_id,correlation_id FROM mcp_v2_event
        WHERE operation_id=? AND tenant_id=? AND account_id=? AND client_id=? AND grant_id=? AND correlation_id=? AND sequence<=? AND at>=? AND at<=?
        ${positionSql(0)} ORDER BY at,sequence LIMIT ?) lifecycle
      UNION ALL
      SELECT * FROM (
      SELECT id,at,1 AS source_rank,sequence,tool_name,event,outcome,account_id,client_id,grant_id,NULL AS approver_id,correlation_id FROM mcp_audit
        WHERE operation_id=? AND tenant_id=? AND account_id=? AND client_id=? AND grant_id=? AND correlation_id=? AND sequence<=? AND at>=? AND at<=? AND event IN ('READ','CALL')
        ${positionSql(1)} ORDER BY at,sequence LIMIT ?) calls
      ) records ORDER BY at,source_rank,sequence LIMIT ?`,...keys,cursor.anchors[0],cutoff,cursor.at,...argsPosition,limit+1,...keys,cursor.anchors[1],cutoff,cursor.at,...argsPosition,limit+1,limit+1);
    const items=rows.slice(0,limit).map(item=>({id:item.id,at:item.at,source:item.source_rank===0?'LIFECYCLE':'MCP',sequence:item.sequence,toolName:item.tool_name,
      event:item.event,outcome:historicalOutcomes.has(item.outcome)?item.outcome:'HISTORICAL_UNCLASSIFIED',actorAccount:item.account_id,actorClient:item.client_id,
      actorGrant:item.grant_id,humanAccount:item.approver_id,correlationId:item.correlation_id}));
    const last=rows[limit-1],nextCursor=rows.length>limit?encode({...cursor,position:[last.at,last.source_rank,last.sequence]}):null;
    return {operationId:row.id,items,nextCursor,coverage:{retentionDays:90,historicalUnlinkedCallsIncluded:false,preOperationStagesIncluded:false,
      lifecycleAnchor:cursor.anchors[0],callAnchor:cursor.anchors[1],snapshotAt:cursor.at}};
  }
  return Object.freeze({async call(name,args,bearer){
    if(!Object.hasOwn(OPERATION_CONTROL_CONTRACTS,name)||!valid(args,OPERATION_CONTROL_CONTRACTS[name].inputSchema))invalid();
    return tenantGuard.withActiveTenant(binding.tenantId,tenant=>store.transaction(async()=>{
      if(!tenant||!Number.isSafeInteger(tenant.revision)||tenant.revision<0)denied();
      const options={bearer,binding,toolName:name,epochHash,buildDigest,tenantRevision:tenant.revision,operationId:args.operationId};
      const {record,authority}=await verifyOperationControlAuthority(store,options),row=record.row;
      const dto=name==='operations.get'?await get(row):name==='operations.cancel'?await cancel(row):await audit(row,args,tenant.revision,authority);
      if(!valid(dto,OPERATION_CONTROL_CONTRACTS[name].outputSchema)||Buffer.byteLength(canonicalOperationJson(dto))>65536)corrupt();
      // Cancellation changes only state/proof consumption. Repeat original-grant
      // and immutable-record verification before the writer commits its result.
      await verifyOperationControlAuthority(store,options);
      if(name!=='operations.cancel')await invocation(row,name,'OK');
      return dto;
    }));
  }});
}
