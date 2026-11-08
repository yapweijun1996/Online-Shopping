import assert from 'node:assert/strict';
import {reviewFixture,reviewPassword} from './mcp-review-fixture.js';
import {freshCatalogAccess,legacyCatalogScopes} from './mcp-catalog-default-grant.js';
import {catalogMediaCreateTool} from '../../src/mcp/catalog-media-create-adapter.js';
import {operationControlTools} from '../../src/mcp/operation-control-contracts.js';
import {createProduct} from '../../src/products.js';
import {createCategory} from '../../src/settings.js';
import {syntheticMediaPng} from './mcp-media-hooks-fixture.js';
import {mediaHash} from '../../src/mcp/media-storage.js';
import {singleTenantRegistry} from '../../src/tenants.js';

// Real Fetch API/OAuth/password/nonce/evidence/services; SYNTHETIC decoder only.
// This is a runtime failure/race fixture, not native or browser acceptance.
export async function catalogCreateRuntimeFixture(t,dialect,{beforeDecode,config:extraConfig={},registry,tenantId}={}){
 let f,decodes=0,guardDepth=0;
 const runtime={codecDigest:'d'.repeat(64),nativeSession:options=>({async decode(bytes,mime,expected){
  decodes++;assert.equal(guardDepth,0);assert.equal(mediaHash(bytes),expected);assert.ok(options.signal instanceof AbortSignal);assert.ok(options.deadline>performance.now());
  if(beforeDecode)await beforeDecode({f,bytes,mime,expected});return{width:12,height:12};
 }})};
 f=await reviewFixture(t,dialect,{operationTools:[catalogMediaCreateTool(runtime),...operationControlTools()],tenantId,
  registry:registry??((store,config)=>{const real=singleTenantRegistry({store,config});return{resolve:real.resolve,operationGuard:identity=>{
   const guard=real.operationGuard(identity);if(!guard)return null;return{async withActiveTenant(id,work){guardDepth++;try{return await guard.withActiveTenant(id,work);}finally{guardDepth--;}}};
  }};}),
  config:{mcpMedia:{enabled:true,codecDigest:runtime.codecDigest},mcpCatalogMediaCreate:{enabled:true},
   mcpRedirectUris:['https://client.example.com/catalog-callback'],...extraConfig}});
 await createCategory(f.store,{code:'SYNTHETIC',label:'Synthetic catalog'});
 let sequence=0;
 const product=extra=>createProduct(f.store,{sku:'C-RUNTIME-'+ ++sequence,name:'Synthetic catalog '+sequence,description:'Synthetic runtime fixture',
  category:'SYNTHETIC',priceMinor:1200,stockQuantity:7,active:true,imageDataUrl:'data:image/png;base64,'+syntheticMediaPng(sequence).toString('base64'),...extra});
 const client=await freshCatalogAccess(f,legacyCatalogScopes+' catalog.write media.write operations.read operations.cancel');
 const prepare=async(input,key='synthetic-create-runtime-'+sequence)=>{
  const response=await client.call('catalog.preview_create',{input,idempotencyKey:key});
  assert.equal(response.response.status,200,JSON.stringify(response.data));assert.ok(response.data.result?.structuredContent?.operationId,JSON.stringify(response.data));
  return response.data.result.structuredContent;
 };
 const path=op=>'/api/v1/seller/mcp/operations/'+op.operationId;
 const post=(op,suffix,input)=>f.api(new Request(f.config.sellerOrigin+path(op)+suffix,{method:'POST',headers:{'content-type':'application/json',...f.headers},body:JSON.stringify(input)}),
  {clientAddress:'synthetic-catalog-runtime-http'});
 const review=async op=>{const result=await f.call(path(op),'GET',undefined,f.headers);assert.equal(result.response.status,200,JSON.stringify(result.data));return result.data;};
 const acknowledge=async(op,value)=>{
  for(const item of value.mediaReview.items){const args={operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,kind:item.kind,itemKey:item.itemKey},
    delivery=await post(op,'/media/delivery',args);assert.equal(delivery.status,200,await delivery.clone().text());
   assert.equal(mediaHash(Buffer.from(await delivery.arrayBuffer())),item.hash);
   const response=await post(op,'/media/ack',{...args,expectedHash:item.hash,nonce:delivery.headers.get('x-media-nonce')});assert.equal(response.status,200,await response.clone().text());}
 };
 const approve=async op=>{const value=await review(op);await acknowledge(op,value);const response=await post(op,'/approval',
  {operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,decision:'approve',mediaReviewed:true});
  assert.equal(response.status,200,await response.clone().text());return value;};
 return{...f,client,runtime,product,prepare,review,acknowledge,approve,post,path,decodes:()=>decodes,
  commit:op=>client.call('catalog.commit_create',{operationId:op.operationId})};
}
