import { buildMediaManifest,mediaAssetKey } from '../../src/mcp/media-manifest.js';
import { randomUUID } from 'node:crypto';
import { canonicalOperationJson,operationPreviewHash } from '../../src/mcp/operation-envelope.js';
import { mediaHash } from '../../src/mcp/media-storage.js';
import { mediaManifestRows } from '../../src/mcp/media-manifest.js';
import { operationReceiptExpiry } from '../../src/mcp/operation-maintenance.js';
import { catalogMediaReviewBinding } from '../../src/mcp/catalog-media-review-wire.js';
export const wireId=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export function catalogWireInput(){
 const productId=wireId(1),oldListing=wireId(2),newListing=wireId(3),asset={source_kind:'PRODUCT_MAIN',source_id:productId,source_product_id:productId,stage_id:null,byte_sha256:'a'.repeat(64),mime:'image/png',byte_length:128};
 const key=mediaAssetKey(asset.mime,asset.byte_sha256),labels={before:{sku:'BEFORE',name:'Old literal name'},after:{sku:'AFTER',name:'New literal name'}};
 const input={toolName:'catalog.preview_update',graphRevision:'1'.repeat(64),codecDigest:'2'.repeat(64),graphBytes:{oldBytes:128,newBytes:0},assets:[asset],effects:[
  {kind:'PRODUCT',productId,before:{listingId:oldListing,role:'single',mainAssetKey:key,ownMainVisible:true},after:{listingId:newListing,role:'single',mainAssetKey:key,ownMainVisible:false},labels},
  {kind:'LISTING',listingId:oldListing,before:{holderId:null,galleryAssetKeys:[key]},after:null},
  {kind:'LISTING',listingId:newListing,before:null,after:{holderId:null,galleryAssetKeys:[]}},
 ]};input.graphRevision=wireBinding(input.effects).revision;return input;
}
// Synthetic test graphs use single-product listing views only.
export function wireBinding(effects){
 const products=effects.filter(row=>row.kind==='PRODUCT');
 return catalogMediaReviewBinding({productId:wireId(1),baseRevision:'1'.repeat(64),
  reviewLabels:products.map(row=>({productId:row.productId,...row.labels})),
  ...Object.fromEntries(['before','after'].map(side=>[side+'Views',products.map(row=>({productId:row.productId,role:row[side].role,
   holderId:row[side].role==='single'?null:products.find(value=>value[side].listingId===row[side].listingId&&value[side].role==='holder').productId,
   visible:row[side].ownMainVisible?[{id:'main',assetKey:row[side].mainAssetKey,shared:false}]:[]}))]))});
}
export const wireProposal=manifest=>({reviewLabels:manifest.effects.filter(row=>row.kind==='PRODUCT').map(row=>({productId:row.productId,...row.labels})),reviewBinding:wireBinding(manifest.effects).reviewBinding,media:manifest.descriptor});
export const wireEnvelope=manifest=>({toolName:'catalog.preview_update',resourceType:'product',resourceId:wireId(1),risk:'HIGH',expectedRevision:manifest.descriptor.graphRevision,proposal:wireProposal(manifest)});
export function directWireInput(){
 const value=catalogWireInput(),product=value.effects[0],listing=value.effects[1];value.toolName='media.preview_layout';value.graphRevision='1'.repeat(64);
 delete product.labels;delete product.before.ownMainVisible;product.after={...product.before};listing.after=structuredClone(listing.before);value.effects=[product,listing];return value;
}
export const catalogWire=()=>{const input=catalogWireInput();input.graphRevision=wireBinding(input.effects).revision;return buildMediaManifest(input);};

// SYNTHETIC retained frame only. Runtime storeMediaPolicy/engine still reject C.
export async function seedCatalogWireOperation(f,manifest=catalogWire(),proposalPatch={}){
 const c=f.context,id=randomUUID(),now=f.now,expires=new Date(Date.parse(now)+600000).toISOString();
 const envelope={version:1,operationId:id,tenantId:c.tenantId,tenantRevision:c.tenantRevision,accountId:c.accountId,clientId:c.clientId,grantId:c.grantId,
  epochHash:c.epochHash,buildDigest:c.buildDigest,issuer:c.issuer,resource:c.resource,toolName:'catalog.preview_update',resourceType:'product',resourceId:wireId(1),
  expectedRevision:manifest.descriptor.graphRevision,requiredScope:'catalog.write',requiredCapability:'catalog.write',risk:'HIGH',createdAt:now,expiresAt:expires,idempotencyHash:mediaHash(id),correlationId:randomUUID(),proposal:{...wireProposal(manifest),...proposalPatch}};
 await f.store.run(`INSERT INTO mcp_v2_operation(id,tenant_id,tenant_revision,account_id,client_id,grant_id,epoch_hash,build_digest,issuer,resource,tool_name,required_scope,required_capability,risk,resource_type,resource_id,expected_revision,envelope_json,preview_hash,request_hash,idempotency_hash,state,created_at,expires_at,receipt_expires_at,correlation_id)
 VALUES(?,?,?,?,?,?,?,?,?,?,'catalog.preview_update','catalog.write','catalog.write','HIGH','product',?,?,?,?,?,?,'PREPARED',?,?,?,?)`,
 id,c.tenantId,c.tenantRevision,c.accountId,c.clientId,c.grantId,c.epochHash,c.buildDigest,c.issuer,c.resource,envelope.resourceId,envelope.expectedRevision,
 canonicalOperationJson(envelope),operationPreviewHash(envelope),mediaHash('request-'+id),envelope.idempotencyHash,now,expires,operationReceiptExpiry(c.grantExpiresAt),envelope.correlationId);
 const row=mediaManifestRows(manifest,{operationId:id,toolName:envelope.toolName,createdAt:now,expiresAt:expires}).policy;
 await f.store.run(`INSERT INTO mcp_v2_operation_media_policy(operation_id,policy_id,required_scopes,descriptor_hash,manifest_root,graph_revision,codec_digest,page_count,asset_count,effect_count,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  row.operation_id,row.policy_id,row.required_scopes,row.descriptor_hash,row.manifest_root,row.graph_revision,row.codec_digest,row.page_count,row.asset_count,row.effect_count,row.created_at,row.expires_at);
 await f.store.run("UPDATE mcp_v2_operation SET media_policy_id='catalog-media-v1' WHERE id=?",id);return{id,manifest,envelope};
}
