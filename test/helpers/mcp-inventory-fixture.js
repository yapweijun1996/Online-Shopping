import assert from 'node:assert/strict';
import { reviewFixture, reviewPassword } from './mcp-review-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './mcp-catalog-default-grant.js';
import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
export const inventoryScopes=legacyCatalogScopes+' inventory.read inventory.adjust';
export const inventoryConfig={mcpRedirectUris:['https://client.example.com/catalog-callback']};
export const inventoryDto=result=>{assert.equal(result.response.status,200,JSON.stringify(result.data));assert.ok(result.data.result,JSON.stringify(result.data));return result.data.result.structuredContent;};
export async function inventoryToolFixture(t,dialect,{scopes=inventoryScopes,...options}={}){
 const f=await reviewFixture(t,dialect,{operationTools:undefined,...options,config:{...inventoryConfig,...options.config}});
 await createCategory(f.store,{code:'INVENTORY',label:'Synthetic inventory'});let sequence=0;
 const product=(extra={})=>createProduct(f.store,{sku:'INV-'+ ++sequence,name:'Synthetic inventory item',description:'Synthetic',category:'INVENTORY',priceMinor:500,stockQuantity:8,active:true,...extra});
 const client=await freshCatalogAccess(f,scopes),summary=async id=>inventoryDto(await client.call('inventory.summary',{productId:id}));
 const preview=async(p,quantity,extra={})=>{const current=await summary(p.id);return client.call('inventory.preview_adjustment',{input:{productId:p.id,expectedRevision:current.revision,stockQuantity:quantity,reasonCode:'COUNT_CORRECTION',...extra},idempotencyKey:'synthetic-inventory-adjust-'+String(++sequence).padStart(8,'0')});};
 const approve=async(op,extra={})=>{const path='/api/v1/seller/mcp/operations/'+op.operationId,review=await f.call(path,'GET',undefined,client.headers);assert.equal(review.response.status,200,JSON.stringify(review.data));return f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password:reviewPassword,...extra},client.headers);};
 return{...f,client,product,summary,preview,approve,commit:op=>client.call('inventory.commit_adjustment',{operationId:op.operationId})};
}
