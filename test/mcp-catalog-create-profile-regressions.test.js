import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewFixture} from './helpers/mcp-review-fixture.js';
import {catalogCreateRuntimeFixture} from './helpers/mcp-catalog-create-runtime-fixture.js';
import {freshCatalogAccess,legacyCatalogScopes} from './helpers/mcp-catalog-default-grant.js';
import {catalogCreateTool} from '../src/mcp/catalog-tools.js';
import {catalogMediaCreateTool} from '../src/mcp/catalog-media-create-adapter.js';
import {createCategory} from '../src/settings.js';
import {createConnector} from '../src/mcp/routes.js';
import {createApi} from '../src/app.js';
import {singleTenantRegistry} from '../src/tenants.js';
import {catalogue} from '../src/mcp/tools.js';
const input={sku:'PROFILE-NEW',name:'Synthetic profile regression',description:'Literal data',category:'SYNTHETIC',priceMinor:1200,stockQuantity:0,active:true};
async function rpc(f,api,bearer,method,params){const response=await api(new Request(f.config.sellerOrigin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+bearer,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));return{response,data:await response.json()};}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: enabling full CREATE denies actual older MEDIUM pending approval and cannot reuse its safe adapter`,options,async t=>{
  const f=await reviewFixture(t,dialect,{operationTools:[catalogCreateTool()],config:{mcpRedirectUris:['https://client.example.com/catalog-callback']}});
  await createCategory(f.store,{code:'SYNTHETIC',label:'Synthetic category'});
  const client=await freshCatalogAccess(f,legacyCatalogScopes+' catalog.write media.write'),prepared=await client.call('catalog.preview_create',{input,idempotencyKey:'old-medium-create-real'}),op=prepared.data.result?.structuredContent;
  assert.ok(op?.operationId,JSON.stringify(prepared.data));assert.equal((await f.store.get('SELECT risk FROM mcp_v2_operation WHERE id=?',op.operationId)).risk,'MEDIUM');
  const runtime={codecDigest:'d'.repeat(64),nativeSession:()=>({decode:()=>{throw new Error('An old MEDIUM proposal must never enter native resolve.');}})},
   config={...f.config,mcpMedia:{enabled:true,codecDigest:runtime.codecDigest},mcpCatalogMediaCreate:{enabled:true}},
   api=await createApi({store:f.store,config,registry:singleTenantRegistry({store:f.store,config}),operationTools:[catalogMediaCreateTool(runtime)]});
  const response=await api(new Request(f.config.sellerOrigin+'/api/v1/seller/mcp/operations/'+op.operationId,{headers:client.headers}));assert.equal(response.status,403);
  assert.equal((await rpc(f,api,client.bearer,'tools/call',{name:'catalog.commit_create',arguments:{operationId:op.operationId}})).response.status,403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
 test(`${dialect}: full CREATE respects explicit empty registration and rejects null or unavailable actual runtime at startup`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),create=operationTools=>createApi({store:f.store,config:f.config,registry:singleTenantRegistry({store:f.store,config:f.config}),operationTools}),
   api=await create([]),listed=await rpc(f,api,f.client.bearer,'tools/list',{});
  assert.equal(listed.response.status,200);assert.deepEqual(listed.data.result.tools,catalogue.map(({scope:_scope,...row})=>row));
  const denied=await rpc(f,api,f.client.bearer,'tools/call',{name:'catalog.preview_create',arguments:{input,idempotencyKey:'empty-registration-create'}});
  assert.equal(denied.response.status,200);assert.equal(denied.data.error.code,-32602);await assert.rejects(create(null),TypeError);
  // This fixture intentionally has no real socket/token; default construction
  // must fail rather than select the safe MEDIUM adapter. No decode is injected.
  const registry=singleTenantRegistry({store:f.store,config:f.config}),tenant=await registry.resolve(new Request(f.config.sellerOrigin+'/mcp'));
  assert.throws(()=>createConnector({store:f.store,config:f.config,tenantId:'default',tenantGuard:registry.operationGuard(tenant),quickLogin:false}),
   {message:'MCP media requires a trusted sealed local codec configuration.'});assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
 });
}
