import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { orderDecisionTool } from '../src/mcp/order-tools.js';
import { valid } from '../src/mcp/tools.js';
export async function orderContractArtifact(){
 const store=await openDatabase(':memory:');
 try{
  const registry=createOperationTools({store,binding:{tenantId:'default',issuer:'https://seller.example.test',resource:'https://seller.example.test/mcp'},config:{mcpEnabled:true,production:false,shopMode:'manual',mcpV2:{enabled:true,epoch:Buffer.alloc(32,1).toString('base64url'),buildDigest:'a'.repeat(64)}},
   tenantGuard:{withActiveTenant:()=>{throw new Error('Contract export never executes requests.');}},quickLogin:false,entries:[orderDecisionTool()]});
  const id='00000000-0000-4000-8000-000000000001',examples={
   'orders.preview_decision':{arguments:{input:{orderId:id,decision:{action:'confirm'}},idempotencyKey:'synthetic-order-example-0001'},result:{operationId:id,status:'PENDING_APPROVAL',previewHash:'a'.repeat(64),expiresAt:'2026-11-05T00:10:00.000Z',replayed:false,reviewUrl:'https://seller.example.test/oauth/operation?operationId='+id}},
   'orders.commit_decision':{arguments:{operationId:id},result:{operationId:id,status:'COMMITTED',result:{orderId:id,orderNo:'OS-00000001',status:'CONFIRMED',revision:2,resourceRevision:'b'.repeat(64)},replayed:false}},
  },defs={},policies={};
  for(const tool of registry.catalogue){defs[tool.name+'.input']=tool.inputSchema;defs[tool.name+'.output']=tool.outputSchema;policies[tool.name]={scope:tool.scope,capability:'orders.decide',risk:'HIGH'};if(!valid(examples[tool.name].arguments,tool.inputSchema)||!valid(examples[tool.name].result,tool.outputSchema))throw new Error('Invalid synthetic order contract example.');}
  return{$schema:'https://json-schema.org/draft/2020-12/schema',$id:'urn:online-shopping:mcp-v2:orders-implemented:v1',description:'Actual trusted order descriptor schemas; synthetic examples are not authority or production acceptance.',$defs:defs,'x-toolPolicies':policies,'x-syntheticExamples':examples};
 }finally{await store.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await writeFile(new URL('../docs/mcp-v2/03-ORDERS-IMPLEMENTED.json',import.meta.url),JSON.stringify(await orderContractArtifact(),null,2)+'\n');
