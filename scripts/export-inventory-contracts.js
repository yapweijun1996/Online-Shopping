import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { inventorySummaryTool,inventoryMovementsTool,inventoryAdjustmentTool } from '../src/mcp/inventory-tools.js';
import { valid } from '../src/mcp/tools.js';
export async function inventoryContractArtifact(){
 const store=await openDatabase(':memory:');
 try{
  // The real registry is introspected without requests, tokens or authority.
  const registry=createOperationTools({store,binding:{tenantId:'default',issuer:'https://seller.example.test',resource:'https://seller.example.test/mcp'},
   config:{mcpEnabled:true,production:false,shopMode:'manual',mcpV2:{enabled:true,epoch:Buffer.alloc(32,1).toString('base64url'),buildDigest:'a'.repeat(64)}},
   tenantGuard:{withActiveTenant:()=>{throw new Error('Contract export never executes requests.');}},quickLogin:false,entries:[inventorySummaryTool(),inventoryMovementsTool(),inventoryAdjustmentTool()]});
  const id='00000000-0000-4000-8000-000000000001',movement='00000000-0000-4000-8000-000000000002',at='2026-11-05T00:00:00.000Z',revision='a'.repeat(64),coverage={origin:'CREATED',startedAt:at,baselineQuantity:8,writerCoverage:'APPLICATION_WRITERS',preCoverageHistoryAvailable:false};
  const examples={
   'inventory.summary':{arguments:{productId:id},result:{product:{id,sku:'SYNTHETIC',name:'Synthetic inventory item',categoryCode:'SYNTHETIC',active:true},stockRevision:1,onHand:8,coverage,revision,held:2,available:6,shortfall:0,activeHoldOrders:1,confirmedOrders:0,reservationHours:48,asOf:at}},
   'inventory.movements':{arguments:{productId:id,limit:50},result:{productId:id,stockRevision:1,coverage,items:[{id:movement,productId:id,stockRevision:1,kind:'INITIALIZED',source:'PRODUCT',reasonCode:'PRODUCT_CREATE',beforeQuantity:null,afterQuantity:8,deltaQuantity:null,occurredAt:at}],nextBeforeRevision:null}},
   'inventory.preview_adjustment':{arguments:{input:{productId:id,expectedRevision:revision,stockQuantity:3,reasonCode:'COUNT_CORRECTION',note:'Synthetic human-reviewed count'},idempotencyKey:'synthetic-inventory-example-0001'},result:{operationId:id,status:'PENDING_APPROVAL',previewHash:'b'.repeat(64),expiresAt:at,replayed:false,reviewUrl:'https://seller.example.test/oauth/operation?operationId='+id}},
   'inventory.commit_adjustment':{arguments:{operationId:id},result:{operationId:id,status:'COMMITTED',result:{productId:id,movementId:movement,stockRevision:2,revision:'c'.repeat(64)},replayed:false}},
  };
  const defs={},policies={};for(const tool of registry.catalogue){defs[tool.name+'.input']=tool.inputSchema;defs[tool.name+'.output']=tool.outputSchema;policies[tool.name]={scope:tool.scope,capability:'catalog.write',risk:tool.name.includes('adjustment')?'HIGH':'LOW'};if(!valid(examples[tool.name].arguments,tool.inputSchema)||!valid(examples[tool.name].result,tool.outputSchema))throw new Error('Invalid synthetic inventory contract example.');}
  return{$schema:'https://json-schema.org/draft/2020-12/schema',$id:'urn:online-shopping:mcp-v2:inventory-implemented:v1',description:'Actual descriptor schemas. Synthetic examples are not authorization or production acceptance.',$defs:defs,'x-toolPolicies':policies,'x-syntheticExamples':examples};
 }finally{await store.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await writeFile(new URL('../docs/mcp-v2/03-INVENTORY-IMPLEMENTED.json',import.meta.url),JSON.stringify(await inventoryContractArtifact(),null,2)+'\n');
