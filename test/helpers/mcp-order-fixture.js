import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reviewFixture,reviewPassword } from './mcp-review-fixture.js';
import { freshCatalogAccess,legacyCatalogScopes } from './mcp-catalog-default-grant.js';
import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
import { createOrder } from '../../src/orders.js';
export const orderScopes=legacyCatalogScopes+' orders.decide';
export const orderConfig={mcpRedirectUris:['https://client.example.com/catalog-callback']};
export const orderDto=result=>{assert.equal(result.response.status,200,JSON.stringify(result.data));assert.ok(result.data.result,JSON.stringify(result.data));return result.data.result.structuredContent;};
export async function orderToolFixture(t,dialect,{scopes=orderScopes,...options}={}){
 const f=await reviewFixture(t,dialect,{operationTools:undefined,...options,config:{...orderConfig,...options.config}});await createCategory(f.store,{code:'ORDER_TEST',label:'Synthetic order items'});let sequence=0;
 const product=(extra={})=>createProduct(f.store,{sku:'ORDER-'+ ++sequence,name:'Synthetic order product',description:'Synthetic',category:'ORDER_TEST',priceMinor:500,stockQuantity:10,active:true,...extra});
 const order=async(products,quantity=2,deliveries=1)=>{const result=await createOrder(f.store,'synthetic-order-tools-'+randomUUID(),{buyer:{fullName:'Synthetic private buyer',whatsappPhone:'+6581234567',email:'synthetic-private@example.invalid'},whatsappOrderContactOptIn:true,
  deliveries:Array.from({length:deliveries},()=>({recipient:{fullName:'Synthetic private recipient',phone:'+60123456789'},address:{line1:'Synthetic private street',city:'Synthetic private city',postcode:'50000',country:'MY'},items:products.map(p=>({productId:p.id,quantity,expectedPriceMinor:p.priceMinor,expectedCurrency:p.currency}))}))});return f.store.get('SELECT id,order_no,status,revision,currency,total_minor FROM shop_order WHERE order_no=?',result.receipt.orderNo);};
 const client=await freshCatalogAccess(f,scopes);
 const preview=(id,decision,extra={})=>client.call('orders.preview_decision',{input:{orderId:id,decision,...extra},idempotencyKey:'synthetic-order-decision-'+String(++sequence).padStart(8,'0')});
 const approve=async(op,extra={})=>{const path='/api/v1/seller/mcp/operations/'+op.operationId,review=await f.call(path,'GET',undefined,client.headers);assert.equal(review.response.status,200,JSON.stringify(review.data));return f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password:reviewPassword,...extra},client.headers);};
 return{...f,client,product,order,preview,approve,commit:op=>client.call('orders.commit_decision',{operationId:op.operationId})};
}
