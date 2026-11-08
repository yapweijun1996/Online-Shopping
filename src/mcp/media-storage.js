import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { ApiError } from '../http.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { operationInstant, operationReceiptExpiry } from './operation-maintenance.js';
import { MEDIA_LIMITS, MEDIA_POLICY_DESCRIPTOR_FIELDS } from './media-schema.js';
import { creationStageBinding } from './catalog-create-draft-storage.js';
import { catalogMediaAllowed, catalogMediaCreateAllowed } from './catalog-media-config.js';
export const mediaHash = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const isSha = value => typeof value === 'string' && sha.test(value);
const isUuid = value => typeof value === 'string' && uuid.test(value);
const terminal = new Set(['CONSUMED','FAILED','EXPIRED','CANCELLED']);
const invalid = () => { throw new ApiError(400, 'MEDIA_INPUT', 'Invalid media storage input.'); };
const conflict = () => { throw new ApiError(409, 'MEDIA_CONFLICT', 'Media storage changed.'); };
const integrity = () => { throw new ApiError(503, 'MEDIA_INTEGRITY', 'Media storage is inconsistent.'); };
const iso = value => new Date(value).toISOString();
const keys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid();
};
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max;
export function mediaContext(context) {
  keys(context, ['tenantId','tenantRevision','accountId','clientId','grantId','accountAuthVersion','epochHash','buildDigest','issuer','resource','grantExpiresAt']);
  for (const key of ['tenantId','accountId','clientId','grantId']) if (!text(context[key], key === 'tenantId' ? 100 : 128)) invalid();
  if (!integer(context.tenantRevision,0,Number.MAX_SAFE_INTEGER) || !integer(context.accountAuthVersion,0,Number.MAX_SAFE_INTEGER) ||
      !isSha(context.epochHash) || !isSha(context.buildDigest) || !text(context.issuer,8192) || !text(context.resource,8192) || !operationInstant(context.grantExpiresAt)) invalid();
  return Object.freeze({ ...context });
}
export const mediaQuotaOwner = context => mediaHash(canonicalOperationJson([context.accountId,context.clientId]));
export const MEDIA_STAGE_COLUMNS = 'id,tenant_id,tenant_revision,account_id,client_id,grant_id,account_auth_version,epoch_hash,build_digest,issuer,resource,product_id,target_slot,expected_revision,begin_request_hash,idempotency_hash,source_sha256,codec_digest,source_mime,declared_bytes,next_offset,reserved_bytes,quota_owner_key,state,version,validation_attempts,lease_hash,lease_until,operation_id,correlation_id,canonical_sha256,canonical_bytes,canonical_mime,width,height,thumbnail_sha256,thumbnail_bytes,created_at,upload_expires_at,absolute_expires_at,receipt_expires_at,bound_expires_at,scrubbed_at,terminal_at';
function beginFields(row) {
  return { productId: row.product_id, targetSlot: row.target_slot, expectedRevision: row.expected_revision, sourceSha256: row.source_sha256,
    sourceMime: row.source_mime, declaredBytes: row.declared_bytes, codecDigest: row.codec_digest, idempotencyHash: row.idempotency_hash };
}
function matches(row, context) {
  return row.tenant_id === context.tenantId && row.tenant_revision === context.tenantRevision && row.account_id === context.accountId &&
    row.client_id === context.clientId && row.grant_id === context.grantId && row.account_auth_version === context.accountAuthVersion &&
    row.epoch_hash === context.epochHash && row.build_digest === context.buildDigest && row.issuer === context.issuer && row.resource === context.resource;
}
// Operations retain grant identity; only the media stage additionally captures
// account_auth_version. The caller separately verifies live operation authority.
function matchesOperation(row, context) {
  return row.tenant_id === context.tenantId && row.tenant_revision === context.tenantRevision && row.account_id === context.accountId &&
    row.client_id === context.clientId && row.grant_id === context.grantId && row.epoch_hash === context.epochHash &&
    row.build_digest === context.buildDigest && row.issuer === context.issuer && row.resource === context.resource;
}
export function checkMediaStage(row) {
  if (!row || !isUuid(row.id) || !isUuid(row.correlation_id) || mediaHash(canonicalOperationJson(beginFields(row))) !== row.begin_request_hash ||
      row.quota_owner_key !== mediaQuotaOwner({ accountId: row.account_id, clientId: row.client_id }) ||
      !operationInstant(row.created_at) || !operationInstant(row.upload_expires_at) || !operationInstant(row.absolute_expires_at) || !operationInstant(row.receipt_expires_at) ||
      Date.parse(row.upload_expires_at) - Date.parse(row.created_at) !== MEDIA_LIMITS.uploadMs ||
      Date.parse(row.absolute_expires_at) - Date.parse(row.created_at) !== MEDIA_LIMITS.absoluteMs || row.receipt_expires_at <= row.absolute_expires_at) integrity();
  return row;
}
const metadata = (row, replayed = false) => ({ stageId: row.id, state: row.state, version: row.version, nextOffset: row.next_offset,
  uploadExpiresAt: row.upload_expires_at, absoluteExpiresAt: row.absolute_expires_at, operationId: row.operation_id, correlationId: row.correlation_id, replayed });

// Internal storage capability only: caller already verified platform->tenant and
// current authority. This wrapper joins its existing writer transaction (or opens
// a store transaction for isolated maintenance/tests); never chooses a tenant/store.
// The ephemeral writer cannot be reused after its callback. No model-facing guard.
export async function withMediaWriter(store, trustedContext, work, { now: suppliedNow } = {}) {
  const context = mediaContext(trustedContext);
  if ((suppliedNow !== undefined && !operationInstant(suppliedNow)) || typeof work !== 'function' || !store?.transaction) invalid();
  return store.transaction(async () => {
    const now = suppliedNow ?? new Date().toISOString();
    let active = true;
    const alive = () => { if (!active) throw new TypeError('Media writer is no longer active.'); };
    const load = async id => {
      alive(); if (!isUuid(id)) invalid();
      const row = await store.get(`SELECT ${MEDIA_STAGE_COLUMNS} FROM mcp_v2_media_stage WHERE id = ?`, id);
      if (!row || !matches(row,context)) conflict(); return checkMediaStage(row);
    };
    const current = row => { if (row.upload_expires_at <= now || row.reserved_bytes === 0 || terminal.has(row.state)) conflict(); };
    const event = async (row, kind, outcome, byteCount = 0) => {
      alive(); await store.run(`INSERT INTO mcp_v2_media_event(id,at,tenant_id,account_id,client_id,grant_id,stage_id,correlation_id,event,outcome,byte_count,tool_name,operation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(),now,row.tenant_id,row.account_id,row.client_id,row.grant_id,row.id,row.correlation_id,kind,outcome,byteCount,kind==='CONSUME'?'media.commit_upload':'media.prepare_upload',row.operation_id);
    };
    const quotas = async () => {
      const rows = await store.all('SELECT reserved_bytes,quota_owner_key FROM mcp_v2_media_stage WHERE tenant_id = ? AND reserved_bytes > 0 LIMIT 25',context.tenantId);
      if (rows.length > MEDIA_LIMITS.tenantSlots) integrity();
      const owner = mediaQuotaOwner(context), own = rows.filter(row => row.quota_owner_key === owner);
      for (const [kind,key,stages] of [['TENANT','tenant',rows],['CLIENT',owner,own]]) {
        const q = await store.get('SELECT reserved_bytes,active_slots FROM mcp_v2_media_quota WHERE tenant_id = ? AND kind = ? AND owner_key = ?',context.tenantId,kind,key);
        if ((q?.reserved_bytes ?? 0) !== stages.reduce((sum,row) => sum+row.reserved_bytes,0) || (q?.active_slots ?? 0) !== stages.length) integrity();
      }
      return owner;
    };
    const writer = {
      async begin(input, creationDraft = null) {
        alive(); keys(input,['productId','targetSlot','expectedRevision','sourceSha256','sourceMime','declaredBytes','codecDigest','idempotencyKey']);
        if (!isUuid(input.productId) || !['MAIN','GALLERY'].includes(input.targetSlot) || !isSha(input.expectedRevision) || !isSha(input.sourceSha256) ||
            !isSha(input.codecDigest) || !['image/png','image/jpeg','image/webp'].includes(input.sourceMime) || !integer(input.declaredBytes,1,MEDIA_LIMITS.sourceBytes) ||
            typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(input.idempotencyKey) || context.grantExpiresAt <= now) invalid();
        input={...input};
        const {idempotencyKey,...fields}=input, normalized={...fields,idempotencyHash:mediaHash(idempotencyKey)}, requestHash=mediaHash(canonicalOperationJson(normalized));
        const existing=await store.get(`SELECT ${MEDIA_STAGE_COLUMNS} FROM mcp_v2_media_stage WHERE tenant_id=? AND account_id=? AND client_id=? AND grant_id=? AND idempotency_hash=?`,context.tenantId,context.accountId,context.clientId,context.grantId,normalized.idempotencyHash);
        if(existing){if(!matches(existing,context)||checkMediaStage(existing).begin_request_hash!==requestHash)conflict();return metadata(existing,true);}
        const owner=await quotas(), reserved=input.declaredBytes+MEDIA_LIMITS.canonicalBytes+MEDIA_LIMITS.thumbnailBytes;
        for(const[kind,key,bytes,slots]of[['TENANT','tenant',MEDIA_LIMITS.tenantBytes,MEDIA_LIMITS.tenantSlots],['CLIENT',owner,MEDIA_LIMITS.clientBytes,MEDIA_LIMITS.clientSlots]]){
          await store.run('INSERT INTO mcp_v2_media_quota(tenant_id,kind,owner_key,reserved_bytes,active_slots)VALUES(?,?,?,0,0) ON CONFLICT DO NOTHING',context.tenantId,kind,key);
          if(!await store.get('UPDATE mcp_v2_media_quota SET reserved_bytes=reserved_bytes+?,active_slots=active_slots+1 WHERE tenant_id=? AND kind=? AND owner_key=? AND reserved_bytes<=? AND active_slots<? RETURNING owner_key',reserved,context.tenantId,kind,key,bytes-reserved,slots))throw new ApiError(429,'MEDIA_QUOTA','Media upload quota exceeded.');
        }
        let correlation=randomUUID();
        if(creationDraft!==null){
          const draft=await store.get("SELECT * FROM seller_mcp_create_draft WHERE id=? AND state='OPEN'",creationDraft);
          if(!draft||draft.context_json!==canonicalOperationJson(context)||draft.intent_hash!==input.expectedRevision||draft.expires_at<=now)conflict();
          const identity=JSON.parse(draft.identity_json);
          if(input.targetSlot==='MAIN'?input.productId!==identity.productId:input.productId!==(identity.targetListingId?await store.get('SELECT id FROM product WHERE listing_id=? ORDER BY created_at,id LIMIT 1',identity.targetListingId).then(row=>row?.id):identity.productId))conflict();
          correlation=draft.correlation_id;
        }
        const id=randomUUID();
        await store.run(`INSERT INTO mcp_v2_media_stage(id,tenant_id,tenant_revision,account_id,client_id,grant_id,account_auth_version,epoch_hash,build_digest,issuer,resource,
          product_id,target_slot,expected_revision,begin_request_hash,idempotency_hash,source_sha256,codec_digest,source_mime,declared_bytes,next_offset,reserved_bytes,quota_owner_key,state,version,validation_attempts,correlation_id,created_at,upload_expires_at,absolute_expires_at,receipt_expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'UPLOADING',0,0,?,?,?,?,?)`,id,context.tenantId,context.tenantRevision,context.accountId,context.clientId,context.grantId,context.accountAuthVersion,context.epochHash,context.buildDigest,context.issuer,context.resource,
          input.productId,input.targetSlot,input.expectedRevision,requestHash,normalized.idempotencyHash,input.sourceSha256,input.codecDigest,input.sourceMime,input.declaredBytes,reserved,owner,correlation,now,iso(Date.parse(now)+MEDIA_LIMITS.uploadMs),iso(Date.parse(now)+MEDIA_LIMITS.absoluteMs),operationReceiptExpiry(context.grantExpiresAt));
        const row=await load(id);await event(row,'BEGIN','UPLOADING');return metadata(row);
      },
      async get(id){return metadata(await load(id),true);},
      async inspect(id) {
        const row = await load(id);
        return Object.freeze({ ...metadata(row, true), productId: row.product_id, targetSlot: row.target_slot,
          expectedRevision: row.expected_revision, sourceSha256: row.source_sha256, sourceMime: row.source_mime,
          declaredBytes: row.declared_bytes, codecDigest: row.codec_digest, receiptExpiresAt: row.receipt_expires_at,
          validationAttempts: row.validation_attempts, leaseUntil: row.lease_until, boundExpiresAt: row.bound_expires_at,
          canonicalSha256: row.canonical_sha256, canonicalBytes: row.canonical_bytes, canonicalMime: row.canonical_mime,
          width: row.width, height: row.height, thumbnailSha256: row.thumbnail_sha256, thumbnailBytes: row.thumbnail_bytes });
      },
      async append(id,offset,bytes) {
        alive();if(!integer(offset,0,MEDIA_LIMITS.sourceBytes)||!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>MEDIA_LIMITS.chunkBytes)invalid();
        const data=Buffer.from(bytes), digest=mediaHash(data), row=await load(id);current(row);if(row.state!=='UPLOADING')conflict();await quotas();
        const prior=await store.get('SELECT byte_length,sha256,data FROM mcp_v2_media_chunk WHERE stage_id=? AND "offset"=?',id,offset);
        if(prior){if(prior.byte_length!==data.length||prior.sha256!==digest||!Buffer.from(prior.data).equals(data))conflict();return metadata(row,true);}
        if(offset!==row.next_offset||offset+data.length>row.declared_bytes)conflict();
        if((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk WHERE stage_id=?',id)).n>=MEDIA_LIMITS.chunks)conflict();
        await store.run('INSERT INTO mcp_v2_media_chunk(stage_id,"offset",byte_length,sha256,data)VALUES(?,?,?,?,?)',id,offset,data.length,digest,data);
        if(!await store.get("UPDATE mcp_v2_media_stage SET next_offset=?,version=version+1 WHERE id=? AND version=? AND state='UPLOADING' RETURNING id",offset+data.length,id,row.version))conflict();
        const after=await load(id);await event(after,'APPEND','APPENDED',data.length);return metadata(after);
      },
      async claimValidation(id) {
        const row=await load(id);current(row);await quotas();
        if(row.next_offset!==row.declared_bytes||row.validation_attempts>=MEDIA_LIMITS.validationAttempts||
            !(row.state==='UPLOADING'||(row.state==='VALIDATING'&&row.lease_until<=now))||Date.parse(row.upload_expires_at)-Date.parse(now)<MEDIA_LIMITS.decodeMs)conflict();
        const chunks=await store.all('SELECT "offset",byte_length,sha256,data FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset" LIMIT 16',id);
        let offset=0;const source=[];
        if(chunks.length>MEDIA_LIMITS.chunks)integrity();
        for(const chunk of chunks){const bytes=Buffer.from(chunk.data);if(chunk.offset!==offset||chunk.byte_length!==bytes.length||mediaHash(bytes)!==chunk.sha256)integrity();offset+=bytes.length;source.push(bytes);}
        const bytes=Buffer.concat(source);if(offset!==row.declared_bytes||mediaHash(bytes)!==row.source_sha256)conflict();
        const token=randomBytes(32).toString('base64url'),until=iso(Math.min(Date.parse(now)+MEDIA_LIMITS.leaseMs,Date.parse(row.upload_expires_at)));
        if(!await store.get("UPDATE mcp_v2_media_stage SET state='VALIDATING',version=version+1,validation_attempts=validation_attempts+1,lease_hash=?,lease_until=? WHERE id=? AND version=? RETURNING id",mediaHash(token),until,id,row.version))conflict();
        const after=await load(id);await event(after,'VALIDATE','LEASED');return {...metadata(after),leaseToken:token,leaseUntil:until,source:bytes,sourceMime:row.source_mime,sourceSha256:row.source_sha256,codecDigest:row.codec_digest};
      },
      async bind(id, leaseToken, version, result, operationId) {
        alive();keys(result,['image','thumbnail','mime','width','height','codecDigest','sourceSha256']);
        if(!(result.image instanceof Uint8Array)||!(result.thumbnail instanceof Uint8Array)||result.image.byteLength>MEDIA_LIMITS.canonicalBytes||result.thumbnail.byteLength>MEDIA_LIMITS.thumbnailBytes)invalid();
        result={...result,image:Buffer.from(result.image),thumbnail:Buffer.from(result.thumbnail)};
        const row=await load(id);current(row);await quotas();
        if(row.state!=='VALIDATING'||row.version!==version||typeof leaseToken!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(leaseToken)||row.lease_hash!==mediaHash(leaseToken)||row.lease_until<=now||!isUuid(operationId))conflict();
        if(!(result.image instanceof Uint8Array)||!(result.thumbnail instanceof Uint8Array)||result.image.byteLength<1||result.image.byteLength>MEDIA_LIMITS.canonicalBytes||
            result.thumbnail.byteLength<1||result.thumbnail.byteLength>MEDIA_LIMITS.thumbnailBytes||result.sourceSha256!==row.source_sha256||result.mime!==row.source_mime||result.codecDigest!==row.codec_digest||
            !integer(result.width,1,8192)||!integer(result.height,1,8192)||result.width*result.height>4194304)invalid();
        const operation=await store.get('SELECT * FROM mcp_v2_operation WHERE id=?',operationId),policy=await readMediaPolicy(store,context,operationId);
        const creation=operation?.tool_name==='catalog.preview_create'&&operation.media_policy_id==='catalog-media-v1'?await creationStageBinding(store,id,context,operation):null;
        if(!operation||!matchesOperation(operation,context)||(!creation&&operation.media_policy_id!=='media-upload-v1')||!policy||policy.policy_id!==operation.media_policy_id||policy.codec_digest!==row.codec_digest||
            !['PREPARED','PENDING_APPROVAL'].includes(operation.state)||operation.expires_at<=now||operation.expires_at>row.absolute_expires_at||
            Date.parse(operation.expires_at)-Date.parse(now)>600000||operation.created_at>now||operation.receipt_expires_at!==row.receipt_expires_at||operation.correlation_id!==row.correlation_id||(!creation&&operation.tool_name!=='media.prepare_upload')||policy.created_at!==operation.created_at||policy.expires_at!==operation.expires_at)conflict();
        const image=Buffer.from(result.image),thumbnail=Buffer.from(result.thumbnail),digest=mediaHash(image);
        await store.run('INSERT INTO mcp_v2_media_pin(stage_id,operation_id,canonical_sha256,codec_digest,created_at,expires_at)VALUES(?,?,?,?,?,?)',id,operationId,digest,row.codec_digest,now,operation.expires_at);
        if(!await store.get(`UPDATE mcp_v2_media_stage SET state='BOUND',version=version+1,lease_hash=NULL,lease_until=NULL,operation_id=?,bound_expires_at=?,canonical_data=?,canonical_sha256=?,canonical_bytes=?,canonical_mime=?,width=?,height=?,thumbnail_data=?,thumbnail_sha256=?,thumbnail_bytes=? WHERE id=? AND version=? AND state='VALIDATING' RETURNING id`,
          operationId,operation.expires_at,image,digest,image.length,result.mime,result.width,result.height,thumbnail,mediaHash(thumbnail),thumbnail.length,id,version))conflict();
        const after=await load(id);await event(after,'BOUND','BOUND',image.length);return metadata(after);
      },
      async boundBytes(id,operationId) {
        const row=await load(id),pin=await store.get('SELECT * FROM mcp_v2_media_pin WHERE stage_id=? AND operation_id=?',id,operationId);
        const operation=await store.get('SELECT * FROM mcp_v2_operation WHERE id=?',operationId),policy=await readMediaPolicy(store,context,operationId);
        const creation=operation?.tool_name==='catalog.preview_create'&&operation.media_policy_id==='catalog-media-v1'?await creationStageBinding(store,id,context,operation):null;
        if(row.state!=='BOUND'||row.operation_id!==operationId||!pin||pin.canonical_sha256!==row.canonical_sha256||pin.codec_digest!==row.codec_digest||
            !operation||!matchesOperation(operation,context)||!['PREPARED','PENDING_APPROVAL','APPROVED'].includes(operation.state)||operation.correlation_id!==row.correlation_id||
            operation.expires_at<=now||pin.expires_at!==operation.expires_at||row.bound_expires_at!==operation.expires_at||row.absolute_expires_at<=now||
            !policy||(!creation&&policy.policy_id!=='media-upload-v1')||policy.codec_digest!==row.codec_digest)conflict();
        const payload=await store.get('SELECT canonical_data,thumbnail_data FROM mcp_v2_media_stage WHERE id=?',id);
        const image=Buffer.from(payload.canonical_data),thumbnail=Buffer.from(payload.thumbnail_data);
        if(image.length!==row.canonical_bytes||thumbnail.length!==row.thumbnail_bytes||mediaHash(image)!==row.canonical_sha256||mediaHash(thumbnail)!==row.thumbnail_sha256)integrity();
        return{stageId:id,operationId,image,thumbnail,mime:row.canonical_mime,width:row.width,height:row.height,sourceSha256:row.source_sha256,canonicalSha256:row.canonical_sha256,thumbnailSha256:row.thumbnail_sha256,codecDigest:row.codec_digest};
      },
      async consume(id,operationId) {
        const row=await load(id),operation=await store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operationId);
        if(!operation||operation.state!=='APPROVED')conflict();
        await writer.boundBytes(id,operationId);await quotas();
        if(!await store.get(`UPDATE mcp_v2_media_stage SET state='CONSUMED',version=version+1,canonical_data=NULL,canonical_sha256=NULL,canonical_bytes=NULL,canonical_mime=NULL,width=NULL,height=NULL,thumbnail_data=NULL,thumbnail_sha256=NULL,thumbnail_bytes=NULL,terminal_at=? WHERE id=? AND version=? AND state='BOUND' RETURNING id`,now,id,row.version))conflict();
        const after=await load(id);await event(after,'CONSUME','CONSUMED');return metadata(after);
      },
      async discard(id) {
        const row=await load(id);if(row.state==='CANCELLED')return metadata(row,true);
        if(!['UPLOADING','VALIDATING'].includes(row.state))conflict();
        if(!await store.get("UPDATE mcp_v2_media_stage SET state='CANCELLED',version=version+1,lease_hash=NULL,lease_until=NULL,terminal_at=? WHERE id=? AND version=? RETURNING id",now,id,row.version))conflict();
        const after=await load(id);await event(after,'CANCEL','CANCELLED');return metadata(after);
      },
      async failValidation(id,leaseToken,version) {
        const row=await load(id);
        if(row.state!=='VALIDATING'||row.version!==version||typeof leaseToken!=='string'||row.lease_hash!==mediaHash(leaseToken)||row.lease_until<=now)conflict();
        if(!await store.get("UPDATE mcp_v2_media_stage SET state='FAILED',version=version+1,lease_hash=NULL,lease_until=NULL,terminal_at=? WHERE id=? AND version=? RETURNING id",now,id,version))conflict();
        const after=await load(id);await event(after,'FAIL','VALIDATION_FAILED');return metadata(after);
      },
    };
    try{return await work(Object.freeze(writer));}finally{active=false;}
  });
}

// Retained minimal descriptor storage. This is not a scope/approval checker and
// does not make the reserved catalog-media policy eligible for any runtime tool.
export async function storeMediaPolicy(store, trustedContext, operationId, descriptor, {catalogUpdateEnabled=false,catalogCreateEnabled=false}={}) {
  const context=mediaContext(trustedContext);
  keys(descriptor,MEDIA_POLICY_DESCRIPTOR_FIELDS);
  if(!isUuid(operationId)||!(['media-upload-v1','media-layout-v1'].includes(descriptor.policyId)||(catalogUpdateEnabled===true||catalogCreateEnabled===true)&&descriptor.policyId==='catalog-media-v1')||!isSha(descriptor.manifestRoot)||!isSha(descriptor.graphRevision)||!isSha(descriptor.codecDigest)||
      !integer(descriptor.pageCount,1,MEDIA_LIMITS.pages)||!integer(descriptor.assetCount,0,MEDIA_LIMITS.assets)||!integer(descriptor.effectCount,1,MEDIA_LIMITS.records))invalid();
  descriptor=Object.freeze({...descriptor});
  return store.transaction(async () => {
  const operation=await store.get('SELECT * FROM mcp_v2_operation WHERE id=?',operationId);
  const tools={'media-upload-v1':['media.prepare_upload'],'media-layout-v1':['media.preview_layout'],'catalog-media-v1':['catalog.preview_create','catalog.preview_update']};
  const catalog=descriptor.policyId==='catalog-media-v1';
  if(!operation||!matchesOperation(operation,context)||operation.media_policy_id!==null||!['PREPARED','PENDING_APPROVAL'].includes(operation.state)||!tools[descriptor.policyId].includes(operation.tool_name)||operation.required_scope!==(catalog?'catalog.write':'media.write')||operation.required_capability!=='catalog.write'||
    catalog&&(!catalogMediaAllowed({catalogUpdateEnabled,catalogCreateEnabled},{toolName:operation.tool_name,mediaPolicyId:descriptor.policyId,resourceType:operation.resource_type})||!(catalogMediaCreateAllowed(catalogCreateEnabled,{toolName:operation.tool_name,mediaPolicyId:descriptor.policyId,resourceType:operation.resource_type})?operation.resource_id==='catalog':isUuid(operation.resource_id))||operation.risk!=='HIGH'))conflict();
  const digest=mediaHash(canonicalOperationJson(descriptor)),scopes=descriptor.policyId==='catalog-media-v1'?'catalog.write media.write':'media.write';
  await store.run(`INSERT INTO mcp_v2_operation_media_policy(operation_id,policy_id,required_scopes,descriptor_hash,manifest_root,graph_revision,codec_digest,page_count,asset_count,effect_count,created_at,expires_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    operationId,descriptor.policyId,scopes,digest,descriptor.manifestRoot,descriptor.graphRevision,descriptor.codecDigest,descriptor.pageCount,descriptor.assetCount,descriptor.effectCount,operation.created_at,operation.expires_at);
  if(!await store.get('UPDATE mcp_v2_operation SET media_policy_id=? WHERE id=? AND media_policy_id IS NULL RETURNING id',descriptor.policyId,operationId))conflict();
  return digest;
  });
}

export async function readMediaPolicy(store,trustedContext,operationId) {
  const context=mediaContext(trustedContext);if(!isUuid(operationId))invalid();
  const operation=await store.get('SELECT * FROM mcp_v2_operation WHERE id=?',operationId);
  if(!operation||!matchesOperation(operation,context))conflict();
  const row=await store.get('SELECT * FROM mcp_v2_operation_media_policy WHERE operation_id=?',operationId);
  if(!row){if(operation.media_policy_id!==null)integrity();return null;}
  const descriptor={policyId:row.policy_id,manifestRoot:row.manifest_root,graphRevision:row.graph_revision,codecDigest:row.codec_digest,pageCount:row.page_count,assetCount:row.asset_count,effectCount:row.effect_count};
  const tools={'media-upload-v1':['media.prepare_upload'],'media-layout-v1':['media.preview_layout'],'catalog-media-v1':['catalog.preview_create','catalog.preview_update']};
  if(row.policy_id!==operation.media_policy_id||!tools[row.policy_id]?.includes(operation.tool_name)||
      row.required_scopes!==(row.policy_id==='catalog-media-v1'?'catalog.write media.write':'media.write')||
      operation.required_scope!==(row.policy_id==='catalog-media-v1'?'catalog.write':'media.write')||operation.required_capability!=='catalog.write'||
      row.created_at!==operation.created_at||row.expires_at!==operation.expires_at||mediaHash(canonicalOperationJson(descriptor))!==row.descriptor_hash)integrity();
  return {...row};
}
