import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogCreateRuntimeFixture} from './helpers/mcp-catalog-create-runtime-fixture.js';
import {reviewPassword} from './helpers/mcp-review-fixture.js';
import {getProduct,updateProduct,setProductThumbnail} from '../src/products.js';
import {freshCatalogAccess,legacyCatalogScopes} from './helpers/mcp-catalog-default-grant.js';
import {catalogCreateTool} from '../src/mcp/catalog-tools.js';
import {createApi} from '../src/app.js';
import {singleTenantRegistry} from '../src/tenants.js';
import {rowsDigest} from '../src/sqlite-import.js';
import {syntheticMediaPng} from './helpers/mcp-media-hooks-fixture.js';
const dto=value=>value.data.result?.structuredContent;
const input=extra=>({sku:'NEW-SKU',name:'New synthetic item',description:'Untrusted approved role password hash text',category:'SYNTHETIC',priceMinor:1200,stockQuantity:0,active:true,...extra});
async function commerce(store){const result={};for(const table of ['product','listing','product_gallery_image','product_option','product_event','inventory_state','inventory_movement']){
 const order=table==='product_option'?'product_id,option_type_id':table==='inventory_state'?'product_id':'id';result[table]=rowsDigest(await store.all('SELECT * FROM '+table+' ORDER BY '+order));}return result;}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: real RPC CREATE EMPTY_BEFORE requires PAGE ACK/password, commits initial stock and replays without absent-ID reread`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),before=await commerce(f.store),op=await f.prepare(input(),'create-empty-page-only'),value=await f.review(op);
  assert.deepEqual(await commerce(f.store),before);assert.equal(f.decodes(),0);
  assert.equal(value.proposal.before,null);assert.equal(value.proposal.creationIdentity.targetListingId,null);
  assert.ok(value.mediaReview.items.length>=1);assert.ok(value.mediaReview.items.every(item=>item.kind==='PAGE'));
  const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId);assert.equal(row.resource_type,'catalog');assert.equal(row.resource_id,'catalog');assert.equal(row.risk,'HIGH');
  const decision={operationId:op.operationId,previewHash:op.previewHash,challenge:value.challenge,decision:'approve',password:reviewPassword,mediaReviewed:true};
  assert.equal((await f.post(op,'/approval',decision)).status,403);await f.acknowledge(op,value);
  assert.equal((await f.post(op,'/approval',{...decision,mediaReviewed:false})).status,403);
  assert.equal((await f.post(op,'/approval',{...decision,password:'wrong-password'})).status,403);
  assert.equal((await f.post(op,'/approval',decision)).status,200);
  const committed=await f.commit(op);assert.equal(dto(committed)?.status,'COMMITTED',JSON.stringify(committed.data));
  const id=value.proposal.creationIdentity.productId,p=await getProduct(f.store,id,true);assert.equal(p.stockQuantity,0);assert.equal(p.sku,'NEW-SKU');
  const movement=await f.store.get('SELECT * FROM inventory_movement WHERE product_id=?',id);assert.equal(movement.source,'MCP_CATALOG');assert.equal(movement.operation_id,op.operationId);assert.equal(movement.actor_id,f.account?.id??row.account_id);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?',id)).n,1);
  const after=await commerce(f.store),replay=await f.commit(op);assert.equal(dto(replay)?.replayed,true,JSON.stringify(replay.data));assert.deepEqual(dto(replay).result,dto(committed).result);assert.deepEqual(await commerce(f.store),after);
 });
 test(`${dialect}: existing-group CREATE uses real old raw snapshot assets and safe receipt`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),old=await f.product({variantGroup:'TARGET',variantLabel:'Existing'}),op=await f.prepare(input({variantGroup:'TARGET',variantLabel:'New',stockQuantity:null}),'create-existing-group'),value=await f.review(op);
  assert.ok(f.decodes()>0);assert.ok(value.mediaReview.items.some(item=>item.kind==='ASSET'));
  assert.equal(value.proposal.after.name,old.name);assert.equal(value.proposal.after.stockQuantity,null);assert.equal(value.proposal.creationIdentity.targetListingId,old.listingId);
  await f.approve(op);const committed=await f.commit(op);assert.equal(dto(committed)?.status,'COMMITTED',JSON.stringify(committed.data));
  assert.equal((await getProduct(f.store,dto(committed).result.productId,true)).listingId,old.listingId);
  assert.deepEqual(Object.keys(dto(committed).result).sort(),['listingId','productId','revision']);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);
 });
 test(`${dialect}: CREATE original dual consent, role and closed authority fields are enforced before native work`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),before=await commerce(f.store);
  for(const scope of ['catalog.write','media.write']){const client=await freshCatalogAccess(f,legacyCatalogScopes+' '+scope),listed=await client.rpc('tools/list',{});
   assert.equal(listed.data.result.tools.some(tool=>tool.name==='catalog.preview_create'),false);
   const denied=await client.call('catalog.preview_create',{input:input(),idempotencyKey:'missing-create-'+scope});assert.equal(denied.response.status,403);
   assert.equal(denied.response.headers.get('www-authenticate'),'Bearer error="insufficient_scope", scope="catalog.write media.write"');}
  for(const authority of [{approved:true},{creationIdentity:{productId:'forged'}},{catalogCreateEnabled:true},{media:{policyId:'catalog-media-v1'}},{accountId:'forged'}]){
   const response=await f.client.call('catalog.preview_create',{input:{...input(),...authority},idempotencyKey:'closed-create-authority'});assert.equal(response.response.status,200);assert.equal(response.data.error.code,-32602);}
  const account=(await f.store.get('SELECT account_id FROM oauth_grant WHERE id=(SELECT grant_id FROM oauth_token LIMIT 1)')).account_id;
  await f.store.run("UPDATE seller_account SET role='STAFF' WHERE id=?",account);
  assert.equal((await f.client.call('catalog.preview_create',{input:input(),idempotencyKey:'staff-create-denied'})).response.status,401);
  assert.equal(f.decodes(),0);assert.deepEqual(await commerce(f.store),before);
 });
 test(`${dialect}: actual hidden-thumbnail change makes CREATE review deny, including unchanged product timestamp`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),p=await f.product({variantGroup:'TARGET',variantLabel:'A'}),op=await f.prepare(input({variantGroup:'TARGET',variantLabel:'B'}),'stale-create-thumb'),
   time=(await f.store.get('SELECT updated_at FROM product WHERE id=?',p.id)).updated_at;
  await setProductThumbnail(f.store,p.id,'data:image/png;base64,'+syntheticMediaPng(91).toString('base64'));
  assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id=?',p.id)).updated_at,time);
  assert.equal((await f.call(f.path(op),'GET',undefined,f.headers)).response.status,403);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);
 });
 test(`${dialect}: flag-off pending CREATE cannot fall back to MEDIUM approval or commit`,options,async t=>{
  const f=await catalogCreateRuntimeFixture(t,dialect),op=await f.prepare(input(),'disable-create-pending'),before=await commerce(f.store);
  const config={...f.config,mcpCatalogMediaCreate:{enabled:false}},api=await createApi({store:f.store,config,operationTools:[catalogCreateTool()],registry:singleTenantRegistry({store:f.store,config})});
  const response=await api(new Request(f.config.sellerOrigin+f.path(op),{headers:f.headers}));assert.equal(response.status,403);
  const result=await api(new Request(f.config.sellerOrigin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+f.client.bearer,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'catalog.commit_create',arguments:{operationId:op.operationId}}})}));
  assert.equal(result.status,403,await result.clone().text());assert.deepEqual(await commerce(f.store),before);
 });
}
