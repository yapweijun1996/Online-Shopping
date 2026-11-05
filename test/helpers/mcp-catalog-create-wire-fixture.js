import { buildMediaManifest,mediaAssetKey,mediaManifestRows } from '../../src/mcp/media-manifest.js';
import { catalogMediaReviewBinding } from '../../src/mcp/catalog-media-review-wire.js';
import { canonicalOperationJson,operationPreviewHash } from '../../src/mcp/operation-envelope.js';
import { operationReceiptExpiry } from '../../src/mcp/operation-maintenance.js';
import { mediaHash } from '../../src/mcp/media-storage.js';
import { randomUUID } from 'node:crypto';
import { wireId } from './mcp-catalog-wire-fixture.js';
export function createWireIdentity(existing=false){return {version:1,productId:wireId(10),targetCode:existing?'GROUP':null,targetListingId:existing?wireId(2):null,newListingId:existing?null:wireId(2)};}
export function createWireBinding(effects,creationIdentity){
 const products=effects.filter(row=>row.kind==='PRODUCT').sort((a,b)=>a.productId<b.productId?-1:1),listings=effects.filter(row=>row.kind==='LISTING');
 const views=side=>products.filter(row=>row[side]!==null).map(row=>{const state=row[side],listing=listings.find(value=>value.listingId===state.listingId)[side],keys=state.role==='single'?listing.galleryAssetKeys:[...(state.ownMainVisible?[state.mainAssetKey]:[]),...listing.galleryAssetKeys];
  return {productId:row.productId,role:state.role,holderId:listing.holderId,visible:keys.map(key=>({id:state.ownMainVisible&&key===state.mainAssetKey?'main':'shared-main:sha256:'+'a'.repeat(64),assetKey:key,shared:state.role!=='single'&&!(state.ownMainVisible&&key===state.mainAssetKey)}))};});
 return catalogMediaReviewBinding({toolName:'catalog.preview_create',creationIdentity,baseRevision:'1'.repeat(64),reviewLabels:products.map(row=>({productId:row.productId,...row.labels})),beforeViews:views('before'),afterViews:views('after')});
}
export function createWireInput(existing=false){
 const identity=createWireIdentity(existing),asset={source_kind:'PRODUCT_MAIN',source_id:wireId(1),source_product_id:wireId(1),stage_id:null,byte_sha256:'a'.repeat(64),mime:'image/png',byte_length:128},key=mediaAssetKey(asset.mime,asset.byte_sha256);
 const old={kind:'PRODUCT',productId:wireId(1),before:{listingId:wireId(2),role:'single',mainAssetKey:key,ownMainVisible:true},after:{listingId:wireId(2),role:'holder',mainAssetKey:key,ownMainVisible:false},labels:{before:{sku:'OLD',name:'Adopted shared name'},after:{sku:'OLD',name:'Adopted shared name'}}};
 const value={toolName:'catalog.preview_create',graphRevision:'1'.repeat(64),codecDigest:'2'.repeat(64),graphBytes:{oldBytes:existing?256:0,newBytes:0},assets:existing?[asset]:[],effects:[
  ...(existing?[old]:[]),{kind:'PRODUCT',productId:identity.productId,before:null,after:{listingId:wireId(2),role:existing?'variant':'single',mainAssetKey:null,ownMainVisible:false},labels:{before:null,after:{sku:'NEW',name:existing?'Adopted shared name':'New literal name'}}},
  {kind:'LISTING',listingId:wireId(2),before:existing?{holderId:null,galleryAssetKeys:[key]}:null,after:{holderId:existing?wireId(1):null,galleryAssetKeys:existing?[key]:[]}},
 ]};value.graphRevision=createWireBinding(value.effects,identity).revision;return value;
}
export function createWireProposal(manifest,identity=createWireIdentity(false)){
 const row=manifest.effects.find(value=>value.kind==='PRODUCT'&&value.before===null);
 return {kind:'create',creationIdentity:identity,before:null,after:{id:identity.productId,listingId:row.after.listingId,...row.labels.after,options:[]},optionReview:{before:[],after:[]},
  reviewLabels:manifest.effects.filter(value=>value.kind==='PRODUCT').map(value=>({productId:value.productId,...value.labels})),reviewBinding:createWireBinding(manifest.effects,identity).reviewBinding,media:manifest.descriptor};
}
export const createWireEnvelope=(manifest,identity=createWireIdentity())=>({toolName:'catalog.preview_create',resourceType:'catalog',resourceId:'catalog',risk:'HIGH',expectedRevision:manifest.descriptor.graphRevision,proposal:createWireProposal(manifest,identity)});
// SYNTHETIC retained prototype only. Actual runtime CREATE media remains denied.
export async function seedCreateWireOperation(f,{existing=false,proposalPatch={}}={}){
 const manifest=buildMediaManifest(createWireInput(existing)),identity=createWireIdentity(existing),c=f.context,id=randomUUID(),now=f.now,expires=new Date(Date.parse(now)+600000).toISOString();
 const envelope={version:1,operationId:id,tenantId:c.tenantId,tenantRevision:c.tenantRevision,accountId:c.accountId,clientId:c.clientId,grantId:c.grantId,
  epochHash:c.epochHash,buildDigest:c.buildDigest,issuer:c.issuer,resource:c.resource,toolName:'catalog.preview_create',resourceType:'catalog',resourceId:'catalog',
  expectedRevision:manifest.descriptor.graphRevision,requiredScope:'catalog.write',requiredCapability:'catalog.write',risk:'HIGH',createdAt:now,expiresAt:expires,idempotencyHash:mediaHash(id),correlationId:randomUUID(),proposal:{...createWireProposal(manifest,identity),...proposalPatch}};
 await f.store.run(`INSERT INTO mcp_v2_operation(id,tenant_id,tenant_revision,account_id,client_id,grant_id,epoch_hash,build_digest,issuer,resource,tool_name,required_scope,required_capability,risk,resource_type,resource_id,expected_revision,envelope_json,preview_hash,request_hash,idempotency_hash,state,created_at,expires_at,receipt_expires_at,correlation_id)
 VALUES(?,?,?,?,?,?,?,?,?,?,'catalog.preview_create','catalog.write','catalog.write','HIGH','catalog','catalog',?,?,?,?,?,'PREPARED',?,?,?,?)`,id,c.tenantId,c.tenantRevision,c.accountId,c.clientId,c.grantId,c.epochHash,c.buildDigest,c.issuer,c.resource,
 envelope.expectedRevision,canonicalOperationJson(envelope),operationPreviewHash(envelope),mediaHash('request-'+id),envelope.idempotencyHash,now,expires,operationReceiptExpiry(c.grantExpiresAt),envelope.correlationId);
 const policy=mediaManifestRows(manifest,{operationId:id,toolName:envelope.toolName,createdAt:now,expiresAt:expires}).policy;
 await f.store.run(`INSERT INTO mcp_v2_operation_media_policy(operation_id,policy_id,required_scopes,descriptor_hash,manifest_root,graph_revision,codec_digest,page_count,asset_count,effect_count,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  policy.operation_id,policy.policy_id,policy.required_scopes,policy.descriptor_hash,policy.manifest_root,policy.graph_revision,policy.codec_digest,policy.page_count,policy.asset_count,policy.effect_count,policy.created_at,policy.expires_at);
 await f.store.run("UPDATE mcp_v2_operation SET media_policy_id='catalog-media-v1' WHERE id=?",id);return {id,envelope,manifest};
}
