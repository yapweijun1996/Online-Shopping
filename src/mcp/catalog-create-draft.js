import { randomUUID,createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { catalogCreateTool } from './catalog-tools.js';
import { captureCatalogCreateIntent,readCatalogMediaCreateReview } from './catalog-media-create-adapter.js';
import { readCreateDraft } from './catalog-create-draft-storage.js';
import { decodeMediaParts } from './media-coordinator.js';
import { mediaObject } from './media-policy.js';
const json=canonicalOperationJson,hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>{throw new ApiError(400,'CREATE_DRAFT_INPUT','Invalid creation draft.');};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text=(minLength,maxLength)=>({type:'string',minLength,maxLength}),uuid={...text(36,36),pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'},sha={...text(64,64),pattern:'^[0-9a-f]{64}$'},key={...text(16,128),pattern:'^[A-Za-z0-9._~-]+$'};
const image=object({sourceSha256:sha,sourceMime:{...text(9,10),enum:['image/png','image/jpeg','image/webp']},declaredBytes:{type:'integer',minimum:1,maximum:524288}});
export const createDraftInput=object({input:{anyOf:[
 object({action:{...text(5,5),const:'begin'},product:catalogCreateTool().inputSchema,images:{type:'array',minItems:1,maxItems:10,items:image},idempotencyKey:key}),
 object({action:{...text(6,6),const:'append'},draftId:uuid,index:{type:'integer',minimum:0,maximum:9},offset:{type:'integer',minimum:0,maximum:524288},dataParts:{type:'array',minItems:1,maxItems:12,items:text(1,4096)}}),
 object({action:{...text(7,7),const:'discard'},draftId:uuid})
]}});
export const createDraftOutput=object({draftId:uuid,productId:uuid,listingId:uuid,state:{...text(4,9),enum:['OPEN','BOUND','COMMITTED','CANCELLED']},images:{type:'array',minItems:1,maxItems:10,items:object({index:{type:'integer',minimum:0,maximum:9},stageId:uuid,nextOffset:{type:'integer',minimum:0,maximum:524288}})},replayed:{type:'boolean'}});
const sameIdentity=(a,b)=>json(a)===json(b);
const coordinators=new WeakSet();export const isCreateDraftCoordinator=value=>coordinators.has(value);
/** The supplied write fence is constructor-owned and always rechecks the original
 * live catalog+media grant. Model inputs cannot choose authority or a store. */
export function createDraftCoordinator({store,write,reserve,codecDigest}){
 const dto=async(writer,draft,replayed=false)=>{
  const images=[];for(const stage of draft.stages)images.push({index:stage.position,stageId:stage.stage_id,nextOffset:(await writer.inspect(stage.stage_id)).nextOffset});
  return {draftId:draft.id,productId:draft.creationIdentity.productId,listingId:draft.creationIdentity.targetListingId??draft.creationIdentity.newListingId,state:draft.state,images,replayed};
 };
 const audit=async(context,draft,action)=>store.run('INSERT INTO seller_mcp_create_draft_event(id,draft_id,tenant_id,at,event) VALUES(?,?,?,?,?)',randomUUID(),draft.id,context.tenantId,new Date().toISOString(),action);
 const coordinator=Object.freeze({
 async renewParentDraft(id,context,writer){
  const original=await readCreateDraft(store,id,context);
  if(original.state!=='BOUND'||!original.operation_id)throw new ApiError(409,'RESTAGE_REQUIRED','Stage the original images again.');
  const operation=await store.get('SELECT state FROM mcp_v2_operation WHERE id=?',original.operation_id);
  if(!operation||operation.state==='COMMITTED')throw new ApiError(409,'REVIEW_NOT_REQUIRED','A committed creation cannot be recreated.');
  const sources=[];
  for(const row of original.stages){
   const stage=await writer.inspect(row.stage_id),chunks=await store.all('SELECT "offset",byte_length,sha256,data FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset" LIMIT 16',row.stage_id);let offset=0;const parts=[];
   for(const chunk of chunks){const bytes=Buffer.from(chunk.data);if(chunk.offset!==offset||chunk.byte_length!==bytes.length||hash(bytes)!==chunk.sha256)throw new ApiError(409,'RESTAGE_REQUIRED','The original source images must be staged again.');offset+=bytes.length;parts.push(bytes);}
   const bytes=Buffer.concat(parts);if(offset!==stage.declaredBytes||hash(bytes)!==stage.sourceSha256)throw new ApiError(409,'RESTAGE_REQUIRED','The original source images must be staged again.');
   sources.push({row,stage,bytes});
  }
  const draftId=randomUUID(),now=new Date().toISOString();
  await store.run(`INSERT INTO seller_mcp_create_draft(id,context_json,input_json,identity_json,tenant_id,account_id,client_id,grant_id,idempotency_hash,intent_hash,correlation_id,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)`,draftId,original.context_json,original.input_json,original.identity_json,context.tenantId,context.accountId,context.clientId,context.grantId,hash(draftId),original.intent_hash,randomUUID(),now,new Date(Date.parse(now)+1500000).toISOString());
  for(const {row,stage,bytes}of sources){const fresh=await writer.begin({productId:row.target_product_id,targetSlot:row.target_slot,expectedRevision:original.intent_hash,sourceSha256:stage.sourceSha256,sourceMime:stage.sourceMime,declaredBytes:stage.declaredBytes,codecDigest,idempotencyKey:hash(json([draftId,row.position]))},draftId);
   await store.run('INSERT INTO seller_mcp_create_draft_stage(draft_id,position,stage_id,target_product_id,target_slot) VALUES(?,?,?,?,?)',draftId,row.position,fresh.stageId,row.target_product_id,row.target_slot);
   for(let offset=0;offset<bytes.length;offset+=36864)await writer.append(fresh.stageId,offset,bytes.subarray(offset,offset+36864));
  }
  const draft=await readCreateDraft(store,draftId,context);await audit(context,draft,'BEGIN');return draft;
 },
 async bindParent(envelope,resolved,context){
  const draft=await readCreateDraft(store,resolved.draftId,context,{open:true});
  if(draft.correlation_id!==envelope.correlationId||draft.intent_hash!==envelope.proposal.creationMedia.intentHash||
   !sameIdentity(draft.creationIdentity,envelope.proposal.creationIdentity)||draft.stages.length!==resolved.images.length||draft.stages.some((row,n)=>row.stage_id!==resolved.images[n].stageId))throw new ApiError(409,'CREATE_DRAFT_UNAVAILABLE','Creation draft binding changed.');
  if(!await store.get("UPDATE seller_mcp_create_draft SET state='BOUND',operation_id=? WHERE id=? AND state='OPEN' AND operation_id IS NULL RETURNING id",envelope.operationId,draft.id))throw new ApiError(409,'CREATE_DRAFT_UNAVAILABLE','Creation draft is already bound.');
 },
 async consumeParent(envelope,context){const draft=await readCreateDraft(store,envelope.proposal.creationMedia.draftId,context);if(draft.operation_id!==envelope.operationId||draft.state!=='BOUND'||!await store.get("UPDATE seller_mcp_create_draft SET state='COMMITTED' WHERE id=? AND state='BOUND' AND operation_id=? RETURNING id",draft.id,envelope.operationId))throw new ApiError(409,'CREATE_DRAFT_UNAVAILABLE','Creation draft binding changed.');},
 async begin(bearer,input){await reserve(bearer,false);mediaObject(input,['product','images','idempotencyKey']);
  return write(bearer,async(writer,context,reader)=>{
   if(!Array.isArray(input.images)||input.images.length<1||input.images.length>10)invalid();
   const requestHash=hash(json(input)),idem=hash(input.idempotencyKey);
   const existing=await store.get('SELECT id,intent_hash FROM seller_mcp_create_draft WHERE tenant_id=? AND account_id=? AND client_id=? AND grant_id=? AND idempotency_hash=?',context.tenantId,context.accountId,context.clientId,context.grantId,idem);
   if(existing){if(existing.intent_hash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Creation draft retry changed.');const draft=await readCreateDraft(reader,existing.id,context);return dto(writer,draft,true);}
   const intent=await captureCatalogCreateIntent(reader,input.product),prepared=await readCatalogMediaCreateReview(reader,intent,codecDigest),holder=prepared.manifest.effects.find(row=>row.kind==='LISTING').after.holderId??intent.creationIdentity.productId;
   if(input.images.length>1&&intent.creationIdentity.targetListingId&&!prepared.manifest.effects.find(row=>row.kind==='PRODUCT'&&row.productId===holder)?.after.mainAssetKey)throw new ApiError(400,'MEDIA_MAIN_REQUIRED','The shared gallery needs its existing main image first.');
   const id=randomUUID(),now=new Date().toISOString(),expires=new Date(Date.parse(now)+1500000).toISOString();
   await store.run(`INSERT INTO seller_mcp_create_draft(id,context_json,input_json,identity_json,tenant_id,account_id,client_id,grant_id,idempotency_hash,intent_hash,correlation_id,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)`,id,json(context),json(intent.normalizedInput),json(intent.creationIdentity),context.tenantId,context.accountId,context.clientId,context.grantId,idem,requestHash,randomUUID(),now,expires);
   for(const [position,source]of input.images.entries()){
    mediaObject(source,['sourceSha256','sourceMime','declaredBytes']);const productId=position===0?intent.creationIdentity.productId:holder,targetSlot=position===0?'MAIN':'GALLERY';
    const stage=await writer.begin({productId,targetSlot,expectedRevision:requestHash,...source,codecDigest,idempotencyKey:hash(json([id,position]))},id);
    await store.run('INSERT INTO seller_mcp_create_draft_stage(draft_id,position,stage_id,target_product_id,target_slot) VALUES(?,?,?,?,?)',id,position,stage.stageId,productId,targetSlot);
   }
   const draft=await readCreateDraft(reader,id,context);await audit(context,draft,'BEGIN');return dto(writer,draft);
  });},
 async append(bearer,input){await reserve(bearer,true);mediaObject(input,['draftId','index','offset','dataParts']);const bytes=decodeMediaParts(input.dataParts);
  return write(bearer,async(writer,context,reader)=>{const draft=await readCreateDraft(reader,input.draftId,context,{open:true}),stage=draft.stages[input.index];if(!stage)invalid();await writer.append(stage.stage_id,input.offset,bytes);await audit(context,draft,'APPEND');return dto(writer,draft);});},
 async discard(bearer,input){await reserve(bearer,false);mediaObject(input,['draftId']);return write(bearer,async(writer,context,reader)=>{const draft=await readCreateDraft(reader,input.draftId,context,{open:true});for(const stage of draft.stages)await writer.discard(stage.stage_id);await store.run("UPDATE seller_mcp_create_draft SET state='CANCELLED' WHERE id=? AND state='OPEN'",draft.id);await audit(context,draft,'DISCARD');return dto(writer,{...draft,state:'CANCELLED'});});}
 });coordinators.add(coordinator);return coordinator;
}
export function catalogCreateDraftTool(runtime){if(!isCreateDraftCoordinator(runtime?.creation))throw new TypeError('Source-owned creation coordinator required.');return Object.freeze({kind:'creation-stage',name:'catalog.prepare_create',scope:'catalog.write',capability:'catalog.write',inputSchema:createDraftInput,outputSchema:createDraftOutput,coordinator:runtime.creation});}
