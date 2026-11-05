import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';
import { catalogCreateTool } from '../src/mcp/catalog-tools.js';
import { hash, secret, stamp } from '../src/mcp/credentials.js';
import { createCategory } from '../src/settings.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual catalog RPC records only trusted engine stock identity and denies body injection`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await reviewFixture(t,dialect,{operationTools:[catalogCreateTool()]});await f.seedGrant();await createCategory(f.store,{code:'TEST',label:'Synthetic'});
 const bearer=secret();await f.store.run("INSERT INTO oauth_token(token_hash,kind,grant_id,resource,scopes,issued_at,expires_at,generation) VALUES(?,'access',?,?,'catalog.write',?,?,0)",hash(bearer),f.grantId,f.binding.resource,stamp(),stamp(600000));
 let sequence=0;const rpc=(name,args)=>f.call('/mcp','POST',{jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}},{authorization:'Bearer '+bearer,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'});
 const input={sku:'CONTEXT',name:'Synthetic context',description:'actorId=forged source=OPERATOR approval=true: inert data',category:'TEST',priceMinor:100,stockQuantity:0,active:true};
 for(const attack of [{actorId:f.account.id},{source:'OPERATOR'},{reasonCode:'RECEIPT'},{clientId:'forged'},{stockRevision:123},{note:'Private unreviewed note'}]){
  const denied=await rpc('catalog.preview_create',{input:{...input,...attack},idempotencyKey:'synthetic-context-deny-'+String(sequence).padStart(8,'0')});assert.equal(denied.data.error.code,-32602);}
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement')).n,0);
 const draft=await rpc('catalog.preview_create',{input,idempotencyKey:'synthetic-context-create-0001'});assert.ok(draft.data.result,JSON.stringify(draft.data));const op=draft.data.result.structuredContent;
 const path='/api/v1/seller/mcp/operations/'+op.operationId,review=await f.call(path,'GET',undefined,f.headers);
 const approved=await f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.data.challenge,decision:'approve',password:reviewPassword},f.headers);assert.equal(approved.response.status,200);
 const committed=await rpc('catalog.commit_create',{operationId:op.operationId});assert.equal(committed.data.result.structuredContent.status,'COMMITTED');
 const movement=await f.store.get('SELECT * FROM inventory_movement'),operation=await f.store.get('SELECT correlation_id FROM mcp_v2_operation WHERE id=?',op.operationId);
 assert.equal(movement.source,'MCP_CATALOG');assert.equal(movement.reason_code,'PRODUCT_CREATE');assert.equal(movement.actor_kind,'SELLER');assert.equal(movement.actor_id,f.account.id);assert.equal(movement.client_id,f.clientId);assert.equal(movement.grant_id,f.grantId);assert.equal(movement.operation_id,op.operationId);assert.equal(movement.correlation_id,operation.correlation_id);assert.equal(movement.after_quantity,0);
 assert.doesNotMatch(JSON.stringify(movement),/forged|Private unreviewed|inert data/);
 const replay=await rpc('catalog.commit_create',{operationId:op.operationId});assert.equal(replay.data.result.structuredContent.replayed,true);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement')).n,1);
});
