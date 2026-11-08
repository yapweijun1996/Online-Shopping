import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
const env={NODE_ENV:'test',ADMIN_USERNAME:'synthetic_owner',ADMIN_PASSWORD:'Synthetic-config-password-2026!',DB_PATH:':memory:'};
test('finish flag defaults off and rejects unsafe or unrecognized enablement',()=>{
 assert.equal(readConfig(env).mcpFinish.enabled,false);
 for(const flag of ['1','true','2'])assert.throws(()=>readConfig({...env,MCP_V2_FINISH_ENABLED:flag}),/FINISH/);
 assert.throws(()=>readConfig({...env,ADMIN_PASSWORD:'M7$uv4Uq9!bF6dTc2Lw8nS3x',NODE_ENV:'production',PUBLIC_ORIGIN:'https://shop.example.test',SELLER_ORIGIN:'https://seller.example.test',MCP_V2_FINISH_ENABLED:'1'}),/FINISH/);
});
test('default off exposes no finish API, batch review or finish storage',async t=>{
 const f=await reviewFixture(t);
 const request=await f.call('/api/v1/seller/mcp/finishes','POST',{},f.headers);assert.equal(request.response.status,404);
 assert.equal((await f.store.all("SELECT name FROM sqlite_schema WHERE name LIKE 'seller_mcp_finish%' ")).length,0);
 const page=await f.call('/oauth/operation?operationIds=11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222');assert.equal(page.response.status,400);
});
