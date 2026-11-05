import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../src/db.js';
import {createOperationTools} from '../src/mcp/operation-tools.js';
import {catalogUpdateTool} from '../src/mcp/catalog-tools.js';
test('full UPDATE contracts come from actual descriptors while safe schemas stay unchanged',async t=>{
 execFileSync(process.execPath,[fileURLToPath(new URL('../docs/mcp-v2/export-catalog-media-update-contracts.mjs',import.meta.url)),'--check'],{stdio:'pipe'});
 const artifact=JSON.parse(await readFile(new URL('../docs/mcp-v2/03-CATALOG-MEDIA-UPDATE-IMPLEMENTED.json',import.meta.url),'utf8')),
  store=await openDatabase(':memory:');t.after(()=>store.close());
 const issuer='https://schemas.example.invalid',registry=createOperationTools({store,binding:{tenantId:'default',issuer,resource:issuer+'/mcp'},quickLogin:false,
  tenantGuard:{withActiveTenant(){throw new Error('Schema test must never enter a tenant.');}},config:{mcpEnabled:true,production:false,shopMode:'manual',
   mcpV2:{enabled:true,epoch:Buffer.alloc(32).toString('base64url'),buildDigest:'0'.repeat(64)}},entries:[catalogUpdateTool()]});
 for(const tool of registry.catalogue){
  assert.deepEqual(artifact.$defs[tool.name+'.input'],tool.inputSchema);assert.deepEqual(artifact.$defs[tool.name+'.output'],tool.outputSchema);
  assert.deepEqual(artifact['x-toolPolicies'][tool.name].requiredScopes,['catalog.write','media.write']);assert.equal(artifact['x-toolPolicies'][tool.name].risk,'HIGH');
  assert.equal(artifact['x-toolPolicies'][tool.name].capability,'catalog.write');
 }
 assert.deepEqual(Object.keys(artifact.$defs),['catalog.preview_update.input','catalog.preview_update.output','catalog.commit_update.input','catalog.commit_update.output']);
 assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
});
