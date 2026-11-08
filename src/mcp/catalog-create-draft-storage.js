import { optionalStorageManifest } from './finish-storage.js';
import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';

const json=canonicalOperationJson, sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CREATE_DRAFT_STORAGE_VERSION=1;
export const CREATE_DRAFT_TABLES=Object.freeze(['seller_mcp_create_draft_schema','seller_mcp_create_draft','seller_mcp_create_draft_stage','seller_mcp_create_draft_event']);
export function createDraftStorageSql(dialect){
 if(!['sqlite','postgres'].includes(dialect))throw new TypeError('Unsupported create draft storage.');
 const strict=dialect==='sqlite'?' STRICT':'';
 return `CREATE TABLE seller_mcp_create_draft (
 id TEXT PRIMARY KEY, context_json TEXT NOT NULL, input_json TEXT NOT NULL, identity_json TEXT NOT NULL,
 tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, client_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 idempotency_hash TEXT NOT NULL, intent_hash TEXT NOT NULL, correlation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('OPEN','BOUND','COMMITTED','CANCELLED')),
 operation_id TEXT REFERENCES mcp_v2_operation(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(tenant_id,account_id,client_id,grant_id,idempotency_hash)
 )${strict};
 CREATE TABLE seller_mcp_create_draft_stage (
 draft_id TEXT NOT NULL REFERENCES seller_mcp_create_draft(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position>=0 AND position<10),
 stage_id TEXT NOT NULL UNIQUE REFERENCES mcp_v2_media_stage(id),
 target_product_id TEXT NOT NULL, target_slot TEXT NOT NULL CHECK(target_slot IN ('MAIN','GALLERY')),
 PRIMARY KEY(draft_id,position)
 )${strict};
 CREATE TABLE seller_mcp_create_draft_event(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES seller_mcp_create_draft(id),tenant_id TEXT NOT NULL,at TEXT NOT NULL,event TEXT NOT NULL CHECK(event IN ('BEGIN','APPEND','DISCARD')))${strict};
 CREATE INDEX seller_mcp_create_draft_event_owner ON seller_mcp_create_draft_event(draft_id,at,id);
 CREATE INDEX seller_mcp_create_draft_retention ON seller_mcp_create_draft(tenant_id,expires_at,id);
 CREATE INDEX seller_mcp_create_draft_operation ON seller_mcp_create_draft(operation_id);
 CREATE TABLE seller_mcp_create_draft_schema(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), ddl_digest TEXT NOT NULL CHECK(length(ddl_digest)=64),manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64))${strict};`;
}
export async function createDraftStorageExists(store){return Boolean(store.dialect==='sqlite'
 ?await store.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='seller_mcp_create_draft_schema'")
 :await store.get("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='seller_mcp_create_draft_schema'"));}
export async function assertCreateDraftStorage(store){
 if(!await createDraftStorageExists(store))throw new TypeError('Creation draft storage is not installed.');
 const row=await store.get('SELECT version,ddl_digest,manifest_digest FROM seller_mcp_create_draft_schema WHERE id=1');
 if(row?.version!==CREATE_DRAFT_STORAGE_VERSION||row.ddl_digest!==sha(createDraftStorageSql(store.dialect))||row.manifest_digest!==await optionalStorageManifest(store,'seller_mcp_create_draft'))throw new TypeError('Incompatible create draft storage.');
 if(store.dialect==='postgres'){
  const access=await store.get("SELECT bool_and(has_table_privilege(current_user,name,'SELECT') AND has_table_privilege(current_user,name,'INSERT') AND has_table_privilege(current_user,name,'UPDATE') AND has_table_privilege(current_user,name,'DELETE')) AS allowed FROM (VALUES('seller_mcp_create_draft'),('seller_mcp_create_draft_stage'),('seller_mcp_create_draft_event')) AS t(name)");
  if(access?.allowed!==true)throw new TypeError('Creation draft storage privileges are incomplete.');
 }
}
export async function initializeCreateDraftStorage(store){await store.transaction(async()=>{
 if(!await createDraftStorageExists(store)){
  const partial=store.dialect==='sqlite'?await store.get("SELECT name FROM sqlite_schema WHERE name LIKE 'seller_mcp_create_draft%'"):
   await store.get("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'seller_mcp_create_draft%'");
  if(partial)throw new TypeError('Unversioned create draft storage.');
  await store.exec(createDraftStorageSql(store.dialect));await store.run('INSERT INTO seller_mcp_create_draft_schema(id,version,ddl_digest,manifest_digest) VALUES(1,?,?,?)',CREATE_DRAFT_STORAGE_VERSION,sha(createDraftStorageSql(store.dialect)),await optionalStorageManifest(store,'seller_mcp_create_draft'));
 }
 await assertCreateDraftStorage(store);
});}
export async function readCreateDraft(read,id,context,{open=false}={}){
 const denied=()=>{throw new ApiError(409,'CREATE_DRAFT_UNAVAILABLE','The creation draft is unavailable. Prepare a fresh draft.');};
 if(!uuid.test(id||''))denied();
 const row=await read.get('SELECT * FROM seller_mcp_create_draft WHERE id=?',id);
 if(!row||context&&row.context_json!==json(context)||row.expires_at<=new Date().toISOString()||row.state==='CANCELLED'||open&&row.state!=='OPEN')denied();
 const stages=await read.all('SELECT position,stage_id,target_product_id,target_slot FROM seller_mcp_create_draft_stage WHERE draft_id=? ORDER BY position LIMIT 11',id);
 if(stages.length<1||stages.length>10||stages.some((stage,n)=>stage.position!==n))denied();
 return {...row,context:JSON.parse(row.context_json),normalizedInput:JSON.parse(row.input_json),creationIdentity:JSON.parse(row.identity_json),stages};
}
/** A source-owned draft relation is mandatory; this never accepts a public missing-product switch. */
export async function creationStageBinding(read,stageId,context,operation=undefined){
 const relation=await read.get('SELECT draft_id,position,target_product_id,target_slot FROM seller_mcp_create_draft_stage WHERE stage_id=?',stageId);
 if(!relation)return null;
 const draft=await readCreateDraft(read,relation.draft_id,context);
 if(operation&&(operation.tool_name!=='catalog.preview_create'||operation.media_policy_id!=='catalog-media-v1'||operation.resource_id!=='catalog'||
  draft.operation_id!==operation.id||draft.correlation_id!==operation.correlation_id||draft.state!=='BOUND'))throw new ApiError(409,'CREATE_DRAFT_UNAVAILABLE','Creation draft binding changed.');
 return {draft,relation};
}
export async function cleanupCreateDrafts(store,{tenantId,now=new Date().toISOString(),limit=50}={}){
 if(typeof tenantId!=='string'||!tenantId||!Number.isInteger(limit)||limit<1||limit>100||typeof now!=='string'||new Date(now).toISOString()!==now)throw new TypeError('Bounded tenant draft cleanup required.');
 if(!await createDraftStorageExists(store))return {removed:0};
 return store.transaction(async()=>{const rows=await store.all(`SELECT d.id FROM seller_mcp_create_draft d LEFT JOIN mcp_v2_operation o ON o.id=d.operation_id WHERE d.tenant_id=? AND d.expires_at<? AND (d.operation_id IS NULL OR o.receipt_expires_at<=?)
 AND NOT EXISTS(SELECT 1 FROM seller_mcp_create_draft_stage ds JOIN mcp_v2_media_stage s ON s.id=ds.stage_id WHERE ds.draft_id=d.id AND s.scrubbed_at IS NULL) ORDER BY d.id LIMIT ?`,tenantId,now,now,limit);let removed=0;
 for(const row of rows){
  const events=await store.all('SELECT id FROM seller_mcp_create_draft_event WHERE draft_id=? ORDER BY at,id LIMIT ?',row.id,limit-removed);
  for(const event of events){await store.run('DELETE FROM seller_mcp_create_draft_event WHERE id=? AND tenant_id=?',event.id,tenantId);removed++;}
  const count=(await store.get('SELECT COUNT(*) AS n FROM seller_mcp_create_draft_stage WHERE draft_id=?',row.id)).n;
  if(removed+count+1>limit||await store.get('SELECT id FROM seller_mcp_create_draft_event WHERE draft_id=? LIMIT 1',row.id))break;
  await store.run('DELETE FROM seller_mcp_create_draft_stage WHERE draft_id=?',row.id);await store.run('DELETE FROM seller_mcp_create_draft WHERE id=?',row.id);removed+=count+1;
 }return {removed};});
}
