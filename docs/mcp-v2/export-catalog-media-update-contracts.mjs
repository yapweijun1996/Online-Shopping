// Actual full UPDATE descriptors only. No operation, native session, credentials
// or listener is executed by this contract export.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {openDatabase} from '../../src/db.js';
import {createOperationTools} from '../../src/mcp/operation-tools.js';
import {catalogMediaUpdateTool} from '../../src/mcp/catalog-media-adapter.js';
import {operationAuthorityPolicy} from '../../src/mcp/operation-policy.js';
import {valid} from '../../src/mcp/tools.js';
const store=await openDatabase(':memory:');
try{
 const issuer='https://schemas.example.invalid',runtime={codecDigest:'0'.repeat(64),nativeSession(){throw new Error('Schema export cannot decode.');}},
  config={mcpEnabled:true,production:false,shopMode:'manual',mcpCatalogMediaUpdate:{enabled:true},mcpMedia:{enabled:true,codecDigest:runtime.codecDigest},
   mcpV2:{enabled:true,epoch:Buffer.alloc(32).toString('base64url'),buildDigest:'0'.repeat(64)}};
 const registry=createOperationTools({store,config,quickLogin:false,binding:{tenantId:'default',issuer,resource:issuer+'/mcp'},
  tenantGuard:{withActiveTenant(){throw new Error('Schema export cannot enter a tenant.');}},entries:[catalogMediaUpdateTool(runtime)]});
 const definitions={},policies={},examples={},operationId='10000000-0000-4000-8000-000000000001',productId='10000000-0000-4000-8000-000000000002';
 for(const tool of registry.catalogue){
  definitions[tool.name+'.input']=tool.inputSchema;definitions[tool.name+'.output']=tool.outputSchema;
  const policy=operationAuthorityPolicy(tool.name,'catalog-media-v1');
  policies[tool.name]={scope:policy.scope,requiredScopes:registry.requiredScopes(tool.name),capability:policy.capability,risk:policy.risk,mediaPolicyId:policy.mediaPolicyId};
  const preview=tool.name==='catalog.preview_update';
  const input=preview?{input:{id:productId,changes:{variantGroup:'TARGET',variantLabel:'Blue'}},idempotencyKey:'synthetic-catalog-media-update'}:{operationId};
  const output=preview?{operationId,status:'PENDING_APPROVAL',previewHash:'a'.repeat(64),expiresAt:'2099-01-01T00:10:00.000Z',replayed:false,
   reviewUrl:'https://synthetic.example/oauth/operation?operationId='+operationId}:
   {operationId,status:'COMMITTED',result:{productId,listingId:'10000000-0000-4000-8000-000000000003',revision:'b'.repeat(64)},replayed:false};
  assert.equal(valid(input,tool.inputSchema),true);assert.equal(valid(output,tool.outputSchema),true);examples[tool.name]={input,output};
 }
 const bundle={$schema:'https://json-schema.org/draft/2020-12/schema',$id:'urn:online-shopping:mcp-v2:catalog-media-update:implemented',
  $comment:'Generated from the actual full UPDATE factory and registry. Independent default-off development/test profile; production activation remains blocked. Full CREATE has its own independent flag. Examples are synthetic schema demonstrations, never live credentials, approvals or resource identities.',
  $defs:definitions,'x-toolPolicies':policies,'x-examples':examples};
 const text=JSON.stringify(bundle,null,2)+'\n',file=new URL('./03-CATALOG-MEDIA-UPDATE-IMPLEMENTED.json',import.meta.url);
 if(process.argv.includes('--check'))assert.equal(await readFile(file,'utf8'),text,'Catalog media UPDATE contracts are stale.');else await writeFile(file,text);
}finally{await store.close();}
