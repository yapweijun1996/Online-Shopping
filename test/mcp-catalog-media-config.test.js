import test from 'node:test';
import assert from 'node:assert/strict';
import {readMcpCatalogMediaUpdateConfig,catalogMediaUpdateEnabled,catalogMediaUpdateAllowed} from '../src/mcp/catalog-media-config.js';
const safe={production:false,mcpEnabled:true,mcpV2:{enabled:true},mcpMedia:{enabled:true,codecDigest:'a'.repeat(64)},shopMode:'manual',sellerQuickLogin:false};
const env={NODE_ENV:'test',MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED:'1'};
test('catalog media UPDATE configuration is independently default-off and explicit development-only',()=>{
 assert.deepEqual(readMcpCatalogMediaUpdateConfig({}),{enabled:false});assert.ok(Object.isFrozen(readMcpCatalogMediaUpdateConfig({})));
 assert.deepEqual(readMcpCatalogMediaUpdateConfig(env,safe),{enabled:true});
 for(const flag of ['true','false','',1,null])assert.throws(()=>readMcpCatalogMediaUpdateConfig({...env,MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED:flag},safe));
 for(const NODE_ENV of [undefined,'staging','production'])assert.throws(()=>readMcpCatalogMediaUpdateConfig({...env,NODE_ENV},safe));
 for(const patch of [{production:true},{production:undefined},{mcpEnabled:false},{mcpV2:undefined},{mcpMedia:{enabled:false}},
  {mcpMedia:{enabled:true,codecDigest:'bad'}},{shopMode:'demo'},{shopMode:'public-demo'},{sellerQuickLogin:true}])assert.throws(()=>readMcpCatalogMediaUpdateConfig(env,{...safe,...patch}));
});
test('runtime constructor eligibility needs the full trusted configuration and lifecycle guard',()=>{
 const config={...safe,mcpCatalogMediaUpdate:{enabled:true}},options={quickLogin:false,tenantGuard:{withActiveTenant(){}}};
 assert.equal(catalogMediaUpdateEnabled(config,options),true);
 for(const patch of [{mcpCatalogMediaUpdate:undefined},{production:true},{shopMode:'demo'},{mcpMedia:{enabled:false}},{mcpV2:{enabled:false}}])assert.equal(catalogMediaUpdateEnabled({...config,...patch},options),false);
 assert.equal(catalogMediaUpdateEnabled(config,{...options,quickLogin:true}),false);assert.equal(catalogMediaUpdateEnabled(config,{quickLogin:false}),false);
});
test('one source eligibility rule permits only the explicitly enabled product UPDATE tuple',()=>{
 const value={toolName:'catalog.preview_update',mediaPolicyId:'catalog-media-v1',resourceType:'product'};
 assert.equal(catalogMediaUpdateAllowed(true,value),true);assert.equal(catalogMediaUpdateAllowed(true,{...value,toolName:'catalog.commit_update'}),true);
 for(const enabled of [undefined,false,'true',1])assert.equal(catalogMediaUpdateAllowed(enabled,value),false);
 for(const patch of [{toolName:'catalog.preview_create'},{toolName:'catalog.commit_create'},{toolName:'media.preview_layout'},
  {mediaPolicyId:null},{mediaPolicyId:'media-layout-v1'},{resourceType:'catalog'},{resourceType:undefined}])assert.equal(catalogMediaUpdateAllowed(true,{...value,...patch}),false);
});
