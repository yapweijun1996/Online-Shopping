import test from 'node:test';
import assert from 'node:assert/strict';
import {readMcpCatalogMediaCreateConfig,catalogMediaCreateEnabled,catalogMediaCreateAllowed,catalogMediaAllowed,catalogMediaUpdateAllowed} from '../src/mcp/catalog-media-config.js';
const safe={production:false,mcpEnabled:true,mcpV2:{enabled:true},mcpMedia:{enabled:true,codecDigest:'a'.repeat(64)},shopMode:'manual',sellerQuickLogin:false};
const env={NODE_ENV:'test',MCP_V2_CATALOG_MEDIA_CREATE_ENABLED:'1'};
test('catalog media CREATE configuration is independently default-off and explicit development-only',()=>{
 assert.deepEqual(readMcpCatalogMediaCreateConfig({}),{enabled:false});assert.ok(Object.isFrozen(readMcpCatalogMediaCreateConfig({})));
 assert.deepEqual(readMcpCatalogMediaCreateConfig(env,safe),{enabled:true});
 for(const flag of ['true','false','',1,null])assert.throws(()=>readMcpCatalogMediaCreateConfig({...env,MCP_V2_CATALOG_MEDIA_CREATE_ENABLED:flag},safe));
 for(const NODE_ENV of [undefined,'staging','production'])assert.throws(()=>readMcpCatalogMediaCreateConfig({...env,NODE_ENV},safe));
 for(const patch of [{production:true},{production:undefined},{mcpEnabled:false},{mcpV2:undefined},{mcpMedia:{enabled:false}},
  {mcpMedia:{enabled:true,codecDigest:'bad'}},{shopMode:'demo'},{shopMode:'public-demo'},{sellerQuickLogin:true}])assert.throws(()=>readMcpCatalogMediaCreateConfig(env,{...safe,...patch}));
});
test('runtime constructor eligibility needs the full trusted configuration and lifecycle guard',()=>{
 const config={...safe,mcpCatalogMediaCreate:{enabled:true}},options={quickLogin:false,tenantGuard:{withActiveTenant(){}}};
 assert.equal(catalogMediaCreateEnabled(config,options),true);
 for(const patch of [{mcpCatalogMediaCreate:undefined},{production:true},{shopMode:'demo'},{mcpMedia:{enabled:false}},{mcpV2:{enabled:false}}])assert.equal(catalogMediaCreateEnabled({...config,...patch},options),false);
 assert.equal(catalogMediaCreateEnabled(config,{...options,quickLogin:true}),false);assert.equal(catalogMediaCreateEnabled(config,{quickLogin:false}),false);
});
test('one source eligibility rule permits only the explicitly enabled catalog CREATE tuple',()=>{
 const value={toolName:'catalog.preview_create',mediaPolicyId:'catalog-media-v1',resourceType:'catalog'};
 assert.equal(catalogMediaCreateAllowed(true,value),true);assert.equal(catalogMediaCreateAllowed(true,{...value,toolName:'catalog.commit_create'}),true);
 for(const enabled of [undefined,false,'true',1])assert.equal(catalogMediaCreateAllowed(enabled,value),false);
 for(const patch of [{toolName:'catalog.preview_update'},{toolName:'catalog.commit_update'},{toolName:'media.preview_layout'},
  {mediaPolicyId:null},{mediaPolicyId:'media-layout-v1'},{resourceType:'product'},{resourceType:undefined}])assert.equal(catalogMediaCreateAllowed(true,{...value,...patch}),false);
});

test('CREATE and UPDATE flags cannot authorize each other or substitute root types',()=>{
 const create={toolName:'catalog.preview_create',mediaPolicyId:'catalog-media-v1',resourceType:'catalog'};
 const update={toolName:'catalog.preview_update',mediaPolicyId:'catalog-media-v1',resourceType:'product'};
 assert.equal(catalogMediaAllowed({catalogUpdateEnabled:true},create),false);
 assert.equal(catalogMediaAllowed({catalogCreateEnabled:true},update),false);
 assert.equal(catalogMediaAllowed({catalogCreateEnabled:true},create),true);
 assert.equal(catalogMediaAllowed({catalogUpdateEnabled:true},update),true);
 assert.equal(catalogMediaUpdateAllowed(true,create),false);
 assert.equal(catalogMediaCreateAllowed(true,update),false);
 assert.equal(catalogMediaAllowed({catalogCreateEnabled:true},{...create,resourceType:'product'}),false);
 assert.equal(catalogMediaAllowed({catalogCreateEnabled:true},{...create,mediaPolicyId:'media-upload-v1'}),false);
});
