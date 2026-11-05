import { randomUUID } from 'node:crypto';
import { mediaEngineFixture } from './mcp-media-engine-fixture.js';
import { png,stubDecode } from './mcp-media-coordinator-fixture.js';
import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
import { createMediaNativeSession } from '../../src/mcp/media-native.js';
import { catalogMediaCreateAdapter } from '../../src/mcp/catalog-media-create-adapter.js';
import { canonicalOperationJson,operationPreviewHash } from '../../src/mcp/operation-envelope.js';
import { mediaHash } from '../../src/mcp/media-storage.js';
import { mediaManifestRows } from '../../src/mcp/media-manifest.js';
import { persistMediaFrame } from '../../src/mcp/media-frame-storage.js';
import { operationReceiptExpiry } from '../../src/mcp/operation-maintenance.js';
import assert from 'node:assert/strict';
export const photo=label=>'data:image/png;base64,'+Buffer.concat([png,Buffer.from(label)]).toString('base64');
export const createInput=(extra={})=>({sku:'NEW',name:'Requested name',description:'Synthetic',category:'TEST',priceMinor:500,currency:'MYR',active:true,...extra});
// PRIVATE unit caller and synthetic native decoder. No human/engine CREATE
// approval is fabricated; the live registry still rejects this adapter.
export async function createAdapterFixture(t,dialect){
 const f=await mediaEngineFixture(t,dialect);await createCategory(f.store,{code:'TEST',label:'Synthetic'});let phase='idle',calls=0,sequence=0;
 const codec={socketPath:'/synthetic/not-contacted.sock',token:'A'.repeat(43),digest:'d'.repeat(64)};
 const runtime={codecDigest:codec.digest,nativeSession:options=>createMediaNativeSession(codec,{...options,decode:async packet=>{assert.equal(phase,'resolve');assert.equal(f.depth(),0);calls++;return stubDecode(packet);}})};
 const adapter=catalogMediaCreateAdapter(runtime),make=(group=null,extra={})=>createProduct(f.store,createInput({sku:'OLD-'+ ++sequence,stockQuantity:7,...(group?{variantGroup:group,variantLabel:'Old-'+sequence}:{}),...extra}));
 async function draft(args){phase='capture';const captured=await f.options.tenantGuard.withActiveTenant(f.context.tenantId,()=>f.store.transaction(()=>adapter.media.capture(f.store,args,f.context)));
  phase='resolve';const methods=['get','all','run','exec','transaction'],originals=new Map(methods.map(name=>[name,f.store[name]]));for(const name of methods)f.store[name]=()=>{throw new Error('Database access during CREATE resolve.');};
  let resolved;try{resolved=await adapter.media.resolve(captured.resources,{signal:new AbortController().signal,deadline:performance.now()+30000});}finally{for(const [name,method]of originals)f.store[name]=method;phase='preview';}
  const value=await f.options.tenantGuard.withActiveTenant(f.context.tenantId,()=>f.store.transaction(()=>adapter.preview(f.store,args,resolved,f.context)));phase='idle';return {captured,resolved,value};
 }
 return {...f,adapter,runtime,make,draft,nativeCalls:()=>calls};
}
// SYNTHETIC retained frame only: no approval/evidence rows, no HTTP permission.
export async function seedCreateAdapterFrame(f,draft){
 const id=randomUUID(),c=f.context,now=f.now,expires=new Date(Date.parse(now)+600000).toISOString(),proposal={...draft.proposal,media:draft.mediaManifest.descriptor};
 const envelope={version:1,operationId:id,tenantId:c.tenantId,tenantRevision:c.tenantRevision,accountId:c.accountId,clientId:c.clientId,grantId:c.grantId,epochHash:c.epochHash,buildDigest:c.buildDigest,issuer:c.issuer,resource:c.resource,
  toolName:'catalog.preview_create',resourceType:'catalog',resourceId:'catalog',expectedRevision:draft.expectedRevision,requiredScope:'catalog.write',requiredCapability:'catalog.write',risk:'HIGH',createdAt:now,expiresAt:expires,idempotencyHash:mediaHash(id),correlationId:randomUUID(),proposal};
 await f.store.transaction(async()=>{
  const columns=['id','tenant_id','tenant_revision','account_id','client_id','grant_id','epoch_hash','build_digest','issuer','resource','tool_name','required_scope','required_capability','risk','resource_type','resource_id','expected_revision','envelope_json','preview_hash','request_hash','idempotency_hash','state','created_at','expires_at','receipt_expires_at','correlation_id'];
  const values=[id,c.tenantId,c.tenantRevision,c.accountId,c.clientId,c.grantId,c.epochHash,c.buildDigest,c.issuer,c.resource,envelope.toolName,envelope.requiredScope,envelope.requiredCapability,envelope.risk,envelope.resourceType,envelope.resourceId,envelope.expectedRevision,canonicalOperationJson(envelope),operationPreviewHash(envelope),mediaHash('request-'+id),envelope.idempotencyHash,'PREPARED',now,expires,operationReceiptExpiry(c.grantExpiresAt),envelope.correlationId];
  await f.store.run(`INSERT INTO mcp_v2_operation(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,...values);
  const policy=mediaManifestRows(draft.mediaManifest,{operationId:id,toolName:envelope.toolName,createdAt:now,expiresAt:expires}).policy;
  const keys=['operation_id','policy_id','required_scopes','descriptor_hash','manifest_root','graph_revision','codec_digest','page_count','asset_count','effect_count','created_at','expires_at'];
  await f.store.run(`INSERT INTO mcp_v2_operation_media_policy(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(key=>policy[key]));await f.store.run("UPDATE mcp_v2_operation SET media_policy_id='catalog-media-v1' WHERE id=?",id);
  await persistMediaFrame(f.store,c,id,draft.mediaManifest);
 });
 return {id,envelope,proposal,applyContext:{accountId:c.accountId,clientId:c.clientId,grantId:c.grantId,operationId:id,correlationId:envelope.correlationId,mediaContext:c}};
}
