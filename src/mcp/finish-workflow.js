import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readSession, sessionCookieFrom } from '../auth.js';
import { ApiError } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { hash, liveGrant, stamp } from './credentials.js';
import { operationEpochHash, operationEpochCurrent } from './operation-epoch.js';
import { canonicalOperationJson, readStoredOperation } from './operation-envelope.js';
import { operationAuthorityPolicy } from './operation-policy.js';
import { can } from '../roles.js';
import { readCommittedMediaFrame } from './media-frame-storage.js';
import { readMediaSnapshot } from './media-resources.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const eligible = new Set(['catalog.preview_create', 'catalog.preview_update', 'media.prepare_upload', 'media.preview_layout']);
const deny = () => { throw new ApiError(403, 'FORBIDDEN', 'Finish authorization failed.'); };
const invalid = () => { throw new ApiError(400, 'INVALID_INPUT', 'Invalid finish request.'); };
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const finished = item => item.state === 'VERIFIED';

// Job state is progress only. Every business write still crosses the existing
// operation engine's session/grant/consent/approval/image/revision/audit checks.
export function createFinishWorkflow({store, binding, config, tenantGuard, approve, execute, reprepare}) {
  if (config.production !== false || config.mcpFinish?.enabled !== true) throw new TypeError('Finish is isolated-development only.');
  const epochHash = operationEpochHash(config.mcpV2.epoch), limiter = new SqlLimiter(store,'mcp-finish-account',{limit:20,windowMs:900000});
  async function guarded(request, mutate, work) {
    const origin = config.sellerOrigin;
    if (!(request instanceof Request) || new URL(request.url).origin !== origin || request.headers.has('authorization') ||
        (mutate ? request.method !== 'POST' || request.headers.get('origin') !== origin : request.method !== 'GET' ||
          request.headers.has('origin') && request.headers.get('origin') !== origin)) deny();
    const cookie = request.headers.get('cookie') || '';
    if (cookie.split(';').filter(part => part.trim().startsWith('seller_session=')).length !== 1) deny();
    const token = sessionCookieFrom(cookie);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) deny();
    return tenantGuard.withActiveTenant(binding.tenantId, tenant => store.transaction(async () => {
      if (!Number.isSafeInteger(tenant?.revision) || tenant.revision < 0 || !operationEpochCurrent(config.mcpV2)) deny();
      const session = await readSession(store,token);
      if (!session || session.account.mustChangePassword || mutate && !equal(request.headers.get('x-csrf-token'),session.csrf_token)) deny();
      const result = await work(session,tenant);
      if (!operationEpochCurrent(config.mcpV2)) deny();
      return result;
    }));
  }
  async function operation(session,tenant,id,previewHash) {
    const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id=?',id);
    const grant = row && await liveGrant(store,row.grant_id,binding);
    let policy;try{policy=operationAuthorityPolicy(row?.tool_name,row?.media_policy_id??null);}catch{deny();}
    if (!row || !eligible.has(row.tool_name) || row.tenant_id !== binding.tenantId || row.account_id !== session.account.id ||
        row.tenant_revision !== tenant.revision || row.epoch_hash !== epochHash || row.build_digest !== config.mcpV2.buildDigest ||
        previewHash && row.preview_hash !== previewHash || !grant || grant.account_id !== session.account.id || grant.client_id !== row.client_id ||
        !can(session.account.role,policy.capability) || !policy.requiredScopes.every(scope=>grant.scopes.split(' ').includes(scope))) deny();
    for (const scope of policy.requiredScopes) {
      const consent = await store.get(`SELECT consented_at FROM mcp_v2_scope_consent WHERE grant_id=? AND tenant_id=? AND account_id=? AND client_id=?
        AND scope=? AND account_auth_version=? AND epoch_hash=? AND consented_at>=? AND consented_at<=?`,
      grant.id,binding.tenantId,session.account.id,row.client_id,scope,grant.account_auth_version,epochHash,grant.created_at,row.created_at);
      if (!consent) deny();
    }
    return row;
  }
  async function owned(session,tenant,id) {
    if (!uuid.test(id || '')) invalid();
    const job = await store.get(`SELECT * FROM seller_mcp_finish WHERE id=? AND tenant_id=? AND account_id=? AND session_hash=?
      AND epoch_hash=? AND build_digest=? AND tenant_revision=?`,id,binding.tenantId,session.account.id,session.token_hash,epochHash,config.mcpV2.buildDigest,tenant.revision);
    if (!job) deny();
    const items=await store.all('SELECT * FROM seller_mcp_finish_item WHERE job_id=? ORDER BY position',id);
    if (!items.length || items.length>5) deny();
    for(const item of items) {
      const row=await operation(session,tenant,item.operation_id,item.preview_hash);
      if(row.client_id!==job.client_id || row.grant_id!==job.grant_id) deny();
    }
    return {job,items};
  }
  async function update(request,id,operationId,state,code=null) {
    return guarded(request,true,async(session,tenant)=>{
      await owned(session,tenant,id);
      const old=await store.get('SELECT state FROM seller_mcp_finish_item WHERE job_id=? AND operation_id=?',id,operationId);
      if(!old || old.state==='VERIFIED')return;
      await store.run('UPDATE seller_mcp_finish_item SET state=?,error_code=?,updated_at=? WHERE job_id=? AND operation_id=?',state,code,stamp(),id,operationId);
      await store.run('INSERT INTO seller_mcp_finish_event(id,job_id,operation_id,event,at) VALUES(?,?,?,?,?)',randomUUID(),id,operationId,code??state,stamp());
    });
  }
  async function status(request,id,mutate=false) {
    return guarded(request,mutate,async(session,tenant)=>{
      const {items}=await owned(session,tenant,id);
      const outcomes=[];
      for(const item of items){const row=await operation(session,tenant,item.operation_id,item.preview_hash);
        outcomes.push({operationId:row.id,state:item.state,operationState:row.state,error:item.error_code,
          receipt:row.state==='COMMITTED'&&row.result_json?JSON.parse(row.result_json):null});}
      const complete=items.every(finished),blocked=items.some(item=>['FAILED','NEEDS_REVIEW'].includes(item.state));
      return {jobId:id,status:complete?'FINISHED':blocked?'PARTIAL':'IN_PROGRESS',completed:items.filter(finished).length,total:items.length,items:outcomes};
    });
  }
  async function prepare(request,input) {
    if(!input || Object.keys(input).sort().join(',')!=='idempotencyKey,items' ||
       !/^[A-Za-z0-9._~-]{16,128}$/.test(input.idempotencyKey||'') || !Array.isArray(input.items) ||
       input.items.length<1 || input.items.length>5 || new Set(input.items.map(item=>item?.operationId)).size!==input.items.length)invalid();
    for(const item of input.items)if(!item || Object.keys(item).sort().join(',')!=='operationId,previewHash' || !uuid.test(item.operationId||'') || !digest.test(item.previewHash||''))invalid();
    return guarded(request,true,async(session,tenant)=>{
      if(!await limiter.attempt(session.account.id))throw new ApiError(429,'RATE_LIMITED','Too many finish requests.');
      const rows=[];for(const item of input.items)rows.push(await operation(session,tenant,item.operationId,item.previewHash));
      const first=rows[0];if(rows.some(row=>row.client_id!==first.client_id||row.grant_id!==first.grant_id))deny();
      const requestHash=hash(canonicalOperationJson(input.items)),key=hash(input.idempotencyKey);
      const old=await store.get('SELECT * FROM seller_mcp_finish WHERE tenant_id=? AND account_id=? AND client_id=? AND idempotency_hash=?',binding.tenantId,session.account.id,first.client_id,key);
      if(old){if(old.request_hash!==requestHash||old.session_hash!==session.token_hash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Finish request changed.');return{jobId:old.id,replayed:true};}
      const count=await store.get('SELECT COUNT(*) AS count FROM seller_mcp_finish WHERE account_id=?',session.account.id);
      if(count.count>=1000)throw new ApiError(429,'FINISH_LIMIT','Finish retention limit reached.');
      const id=randomUUID(),now=stamp();
      await store.run(`INSERT INTO seller_mcp_finish(id,tenant_id,account_id,client_id,grant_id,session_hash,epoch_hash,build_digest,tenant_revision,idempotency_hash,request_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,binding.tenantId,session.account.id,first.client_id,first.grant_id,session.token_hash,epochHash,config.mcpV2.buildDigest,tenant.revision,key,requestHash,now);
      for(const [position,row]of rows.entries()){
        await store.run(`INSERT INTO seller_mcp_finish_item(job_id,position,operation_id,preview_hash,state,updated_at) VALUES(?,?,?,?,'PENDING',?)`,id,position,row.id,row.preview_hash,now);
        await store.run('INSERT INTO seller_mcp_finish_event(id,job_id,operation_id,event,at) VALUES(?,?,?,?,?)',randomUUID(),id,row.id,'PREPARED',now);
      }
      return {jobId:id,replayed:false};
    });
  }
  async function verify(request,id,operationId){
    return guarded(request,true,async(session,tenant)=>{
      await owned(session,tenant,id);const row=await operation(session,tenant,operationId);
      if(row.state!=='COMMITTED'||!row.result_json)throw new ApiError(409,'VERIFY_PENDING','Commit is not verified.');
      const envelope=readStoredOperation(row,binding),receipt=JSON.parse(row.result_json);
      if(!envelope)throw new ApiError(409,'VERIFY_UNAVAILABLE','Proposal is no longer available.');
      const productId=receipt.productId??row.resource_id;
      const product=await store.get('SELECT id,listing_id,sku,name,description,category,price_minor,currency,stock_quantity,active,variant_group,variant_label FROM product WHERE id=?',productId);
      if(!product)throw new ApiError(409,'VERIFY_CHANGED','Product read-back failed.');
      const after=envelope.proposal.after??envelope.proposal.product;
      const fields={id:product.id,listingId:product.listing_id,sku:product.sku,name:product.name,description:product.description,
        categoryCode:product.category,priceMinor:product.price_minor,currency:product.currency,stockQuantity:product.stock_quantity,
        active:product.active===1,variantGroup:product.variant_group,variantLabel:product.variant_label};
      if(after?.options)fields.options=(await store.all('SELECT option_type_id,option_value_id FROM product_option WHERE product_id=? ORDER BY option_type_id,option_value_id LIMIT 7',productId))
        .map(value=>({typeId:value.option_type_id,valueId:value.option_value_id}));
      if(after && Object.entries(after).some(([key,value])=>Object.hasOwn(fields,key) && canonicalOperationJson(fields[key])!==canonicalOperationJson(value))){
        throw new ApiError(409,'VERIFY_CHANGED','Product changed after commit.');
      }
      if(row.media_policy_id){
        const grant=await liveGrant(store,row.grant_id,binding);
        const context={tenantId:binding.tenantId,tenantRevision:tenant.revision,accountId:session.account.id,clientId:row.client_id,
          grantId:row.grant_id,accountAuthVersion:grant.account_auth_version,epochHash,buildDigest:config.mcpV2.buildDigest,
          issuer:binding.issuer,resource:binding.resource,grantExpiresAt:grant.absolute_expires_at};
        const manifest=await readCommittedMediaFrame(store,context,row.id,envelope.proposal.media),snapshot=await readMediaSnapshot(store,productId);
        for(const effect of manifest.effects){
          const target=effect.kind==='PRODUCT'?snapshot.before.products.find(value=>value.productId===effect.productId):
            snapshot.before.listings.find(value=>value.listingId===effect.listingId);
          if(!target)continue; // Other affected groups were verified atomically by the domain adapter.
          for(const [key,value]of Object.entries(effect.after??{})){
            const actual=key==='ownMainVisible'?Boolean(snapshot.views.find(value=>value.productId===effect.productId)?.visible.some(value=>value.id==='main')):target[key];
            if(canonicalOperationJson(actual)!==canonicalOperationJson(value))throw new ApiError(409,'VERIFY_CHANGED','Exact image roles changed after commit.');
          }
        }
      }
      return true;
    });
  }
  async function run(request,id){
    const initial=await status(request,id,true);
    for(const item of initial.items){
      if(item.state==='VERIFIED' || ['NEEDS_REVIEW','FAILED'].includes(item.state) && !['APPROVED','COMMITTED'].includes(item.operationState))continue;
      try{
        const row=await guarded(request,true,(session,tenant)=>operation(session,tenant,item.operationId));
        if(row.state==='PENDING_APPROVAL'){await update(request,id,row.id,'NEEDS_REVIEW','APPROVAL_REQUIRED');continue;}
        if(['CONFLICT','EXPIRED','CANCELLED','REJECTED','FAILED'].includes(row.state)){
          await update(request,id,row.id,'NEEDS_REVIEW',row.state==='CONFLICT'?'STALE_REVISION':row.state);continue;
        }
        const result=await execute(request,row.id);
        if(result.error){await update(request,id,row.id,'NEEDS_REVIEW',result.error);continue;}
        await update(request,id,row.id,'COMMITTED');
        await verify(request,id,row.id);await update(request,id,row.id,'VERIFIED');
      }catch(error){
        if(error?.status===403)throw error;
        const retry=!(error instanceof ApiError)||error.status>=500||error.status===429;
        await update(request,id,item.operationId,retry?'RETRY':'NEEDS_REVIEW',retry?'RETRY_REQUIRED':error.code==='VERIFY_CHANGED'?'VERIFY_CHANGED':'REVIEW_REQUIRED');
      }
    }
    return status(request,id,true);
  }
  async function approveAndRun(request,id,input,ip){
    if(!input||Object.keys(input).sort().join(',')!=='items,password'||typeof input.password!=='string'||!input.password.length||input.password.length>256||!Array.isArray(input.items))invalid();
    const packet=JSON.parse(canonicalOperationJson(input.items));
    const current=await status(request,id,true);
    if(packet.length!==current.total||packet.some((item,n)=>!item || typeof item!=='object' || Array.isArray(item) || item.operationId!==current.items[n].operationId ||
       !digest.test(item.previewHash||'') || !/^[A-Za-z0-9_-]{43}$/.test(item.challenge||'') ||
       Object.hasOwn(item,'mediaReviewed') && item.mediaReviewed!==true ||
       Object.keys(item).some(key=>!['operationId','previewHash','challenge','mediaReviewed'].includes(key))))invalid();
    // No password is stored in jobs, receipts, logs, or retry packets. Each
    // existing approval verifies it outside its own writer transaction.
    for(const item of packet){
      const row=await guarded(request,true,(session,tenant)=>operation(session,tenant,item.operationId,item.previewHash));
      if(['APPROVED','COMMITTED'].includes(row.state))continue;
      if(row.state!=='PENDING_APPROVAL'){await update(request,id,row.id,'NEEDS_REVIEW',row.state);continue;}
      try{await approve(request,{...item,password:input.password,decision:'approve'},ip);await update(request,id,row.id,'APPROVED');}
      catch(error){if(error?.status===403)throw error;await update(request,id,row.id,'RETRY','APPROVAL_RETRY_REQUIRED');}
    }
    return run(request,id);
  }
  async function revalidate(request,id,input){
    if(!input || Object.keys(input).sort().join(',')!=='idempotencyKey,operationId' || !uuid.test(input.operationId||'') ||
      !/^[A-Za-z0-9._~-]{16,128}$/.test(input.idempotencyKey||''))invalid();
    const prior=await guarded(request,true,async(session,tenant)=>{
      const {items}=await owned(session,tenant,id);
      const prior=await store.get('SELECT * FROM seller_mcp_finish_revalidation WHERE job_id=? AND idempotency_hash=?',id,hash(input.idempotencyKey));
      if(prior){
        if(prior.source_id!==input.operationId)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','The revalidation request changed.');
        const row=await operation(session,tenant,prior.replacement_id);
        return {operationId:row.id,status:row.state,previewHash:row.preview_hash,expiresAt:row.expires_at,replayed:true,
          reviewUrl:binding.issuer+'/oauth/operation?operationId='+row.id,jobId:id,renewedApprovalRequired:true};
      }
      const item=items.find(value=>value.operation_id===input.operationId);
      if(!item || !['NEEDS_REVIEW','RETRY'].includes(item.state))throw new ApiError(409,'REVIEW_NOT_REQUIRED','This item does not need revalidation.');
    });
    if(prior)return prior;
    // Re-run the original normalized intent through native decoding and the
    // original grant, outside the job transaction. Never alter an old envelope.
    const replacement=await reprepare(request,input.operationId,input.idempotencyKey);
    if(replacement.status!=='PENDING_APPROVAL')throw new ApiError(409,'REVIEW_REQUIRED','Prepare a fresh review.');
    return guarded(request,true,async(session,tenant)=>{
      const {items}=await owned(session,tenant,id),item=items.find(value=>value.operation_id===input.operationId);
      const row=await operation(session,tenant,replacement.operationId,replacement.previewHash);
      const old=await operation(session,tenant,input.operationId);
      if(!item || row.grant_id!==old.grant_id || row.client_id!==old.client_id)deny();
      const replaced=await store.get(`UPDATE seller_mcp_finish_item SET operation_id=?,preview_hash=?,state='PENDING',error_code='RENEWED_APPROVAL_REQUIRED',updated_at=?
        WHERE job_id=? AND operation_id=? AND state IN ('NEEDS_REVIEW','RETRY') RETURNING position`,row.id,row.preview_hash,stamp(),id,old.id);
      if(!replaced)throw new ApiError(409,'REVALIDATION_CONFLICT','The job changed. Reload its progress.');
      await store.run('INSERT INTO seller_mcp_finish_revalidation(job_id,idempotency_hash,source_id,replacement_id,created_at) VALUES(?,?,?,?,?)',id,hash(input.idempotencyKey),old.id,row.id,stamp());
      for(const [operationId,event]of [[old.id,'SUPERSEDED'],[row.id,'REVALIDATED_REVIEW_REQUIRED']])await store.run(
        'INSERT INTO seller_mcp_finish_event(id,job_id,operation_id,event,at) VALUES(?,?,?,?,?)',randomUUID(),id,operationId,event,stamp());
      return {...replacement,jobId:id,renewedApprovalRequired:true};
    });
  }
  return Object.freeze({prepare,status,run,approveAndRun,revalidate});
}
