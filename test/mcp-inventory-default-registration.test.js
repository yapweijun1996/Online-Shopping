import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApi } from '../src/app.js';
import { catalogue } from '../src/mcp/tools.js';
import { inventoryToolFixture,inventoryScopes } from './helpers/mcp-inventory-fixture.js';
import { freshCatalogAccess,legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { inventoryContractArtifact } from '../scripts/export-inventory-contracts.js';
const names=['inventory.summary','inventory.movements','inventory.preview_adjustment','inventory.commit_adjustment'];
for(const dialect of ['sqlite','postgres'])test(`${dialect}: default four inventory tools require exact fresh scopes; all eligible defaults preserve original eight definitions`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryToolFixture(t,dialect),list=(await f.client.rpc('tools/list',{})).data.result.tools,base=catalogue.map(({scope:_scope,...tool})=>tool);assert.deepEqual(list.slice(0,8),base);assert.deepEqual(list.slice(8).map(tool=>tool.name),names);
 const artifact=JSON.parse(await readFile(new URL('../docs/mcp-v2/03-INVENTORY-IMPLEMENTED.json',import.meta.url),'utf8'));assert.deepEqual(artifact,await inventoryContractArtifact());
 for(const tool of list.slice(8)){assert.deepEqual(tool.inputSchema,artifact.$defs[tool.name+'.input']);assert.deepEqual(tool.outputSchema,artifact.$defs[tool.name+'.output']);}
 const old=await freshCatalogAccess(f,legacyCatalogScopes);assert.deepEqual((await old.rpc('tools/list',{})).data.result.tools,base);
 const read=await freshCatalogAccess(f,legacyCatalogScopes+' inventory.read');assert.deepEqual((await read.rpc('tools/list',{})).data.result.tools.slice(8).map(tool=>tool.name),names.slice(0,2));
 const adjust=await freshCatalogAccess(f,legacyCatalogScopes+' inventory.adjust');assert.deepEqual((await adjust.rpc('tools/list',{})).data.result.tools.slice(8).map(tool=>tool.name),names.slice(2));
 const all=await freshCatalogAccess(f,inventoryScopes+' company.read company.write catalog.write analytics.extended'),allNames=(await all.rpc('tools/list',{})).data.result.tools.map(tool=>tool.name);
 assert.deepEqual(allNames,[...base.map(tool=>tool.name),'company.get','company.preview_update','company.commit_update','catalog.preview_create','catalog.commit_create','catalog.preview_update','catalog.commit_update','analytics.sales_trend','analytics.top_products','analytics.inventory_risk',...names]);
});
test('explicit empty, null, default-off, demo and production constructor boundaries expose no inventory authority',async t=>{
 const f=await inventoryToolFixture(t,'sqlite'),base=catalogue.map(({scope:_scope,...tool})=>tool);
 for(const extra of [{operationTools:[]},{config:{...f.config,mcpV2:{enabled:false}}},{config:{...f.config,production:true}},{config:{...f.config,shopMode:'public-demo'}}]){
  const api=await createApi({store:f.store,config:f.config,...extra}),response=await api(new Request(f.binding.resource,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.client.bearer,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}));
  if(response.status===200){const data=await response.json();assert.deepEqual(data.result.tools,base);}else assert.equal(response.status,401);
 }
 await assert.rejects(createApi({store:f.store,config:f.config,operationTools:null}),TypeError);
});
