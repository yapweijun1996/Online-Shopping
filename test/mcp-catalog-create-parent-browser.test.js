import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startContainer } from '../media-codec/scripts/dev-container.js';
import { catalogCreateRuntimeBrowserFixture } from './helpers/mcp-catalog-create-runtime-browser-fixture.js';
import { syntheticMediaPng } from './helpers/mcp-media-hooks-fixture.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { getProduct,createProduct } from '../src/products.js';
const enabled=process.env.CATALOG_MEDIA_CREATE_PARENT_NATIVE_BROWSER_TEST==='1'&&Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const content=response=>response.data.result?.structuredContent;
const product=extra=>({sku:'PARENT-SYNTHETIC',name:'Synthetic one-review product',description:'Literal seller review metadata',category:'SYNTHETIC',priceMinor:140,stockQuantity:100,active:true,...extra});
async function draft(f,client,value,colors=[7,8],key='parent-synthetic-draft-0001'){
 const images=colors.map(syntheticMediaPng),declarations=images.map(bytes=>({sourceSha256:mediaHash(bytes),sourceMime:'image/png',declaredBytes:bytes.length}));
 const result=await client.call('catalog.prepare_create',{input:{action:'begin',product:value,images:declarations,idempotencyKey:key}});assert.equal(result.response.status,200,JSON.stringify(result.data));const created=content(result);assert.ok(created?.draftId,JSON.stringify(result.data));
 const replay=content(await client.call('catalog.prepare_create',{input:{action:'begin',product:value,images:declarations,idempotencyKey:key}}));assert.equal(replay.draftId,created.draftId);assert.equal(replay.replayed,true);
 assert.equal(await getProduct(f.store,created.productId,true),null);
 for(const [index,bytes]of images.entries()){const result=await client.call('catalog.prepare_create',{input:{action:'append',draftId:created.draftId,index,offset:0,dataParts:[bytes.toString('base64')]}});assert.equal(result.response.status,200,JSON.stringify(result.data));}
 return created;
}
async function prepare(f,client,value,draft,key='parent-synthetic-preview-0001'){
 const response=await client.call('catalog.preview_create',{input:{...value,draftId:draft.draftId},idempotencyKey:key});assert.equal(response.response.status,200,JSON.stringify(response.data));const result=content(response);assert.ok(result?.operationId,JSON.stringify(response.data));return result;
}
async function reviewAndFinish(f,page,op){
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(op.reviewUrl);await page.locator('#media-review').waitFor({state:'visible'});
 const count=Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',op.operationId)).n);
 for(let n=1;n<=count;n++){await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);assert.ok(await page.locator('#media-image').evaluate(node=>node.naturalWidth)>0);await page.locator('#media-image-ack').click();await page.waitForFunction(value=>document.querySelector('#media-progress').textContent.startsWith(value+' of '),n);}
 await page.locator('#metadata-ack').check();await page.locator('#media-ack').check();assert.equal(await page.locator('#password').count(),0);
 await page.locator('#approve-finish').click();await page.waitForFunction(()=>document.querySelector('#finish-items').children.length>0);assert.match(await page.locator('#finish-summary').textContent(),/Finished\./,await page.locator('#status').textContent()+' '+await page.locator('#finish-items').textContent());assert.deepEqual(errors,[]);
}
test('unified CREATE parent default factory actual native/session/browser/commit on both databases',{skip:!enabled,timeout:240000},async t=>{
 const image=process.env.SHOP_TEST_MEDIA_CODEC_IMAGE??(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim(),worker=await startContainer(image);t.after(worker.stop);
 const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const dialect of ['sqlite','postgres'])await t.test(dialect,async child=>{
  const f=await catalogCreateRuntimeBrowserFixture(child,dialect,worker,browser);await f.configure({mcpFinish:{enabled:true}});const client=await f.authorize(f.allScopes),value=product();
  const listed=await client.rpc('tools/list',{});assert.ok(listed.data.result.tools.some(tool=>tool.name==='catalog.prepare_create'));
  const created=await draft(f,client,value),op=await prepare(f,client,value,created);
  assert.equal(await getProduct(f.store,created.productId,true),null);
  assert.equal((await client.call('catalog.commit_create',{operationId:op.operationId})).response.status,403);
  const row=await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',op.operationId),proposal=JSON.parse(row.envelope_json).proposal;assert.equal(proposal.after.active,true);assert.equal(proposal.creationMedia.images.length,2);
  const pages=await f.store.all('SELECT page_json FROM mcp_v2_media_manifest_page WHERE operation_id=?',op.operationId);assert.ok(pages.every(row=>JSON.parse(row.page_json).version===2));
  const page=await f.context.newPage();await reviewAndFinish(f,page,op);
  const actual=await getProduct(f.store,created.productId,true);assert.equal(actual.sku,value.sku);assert.equal(actual.active,true);assert.equal(actual.stockQuantity,100);assert.equal(actual.priceMinor,140);assert.equal(actual.images.length,2);
  assert.equal((await f.store.get('SELECT state FROM seller_mcp_create_draft WHERE id=?',created.draftId)).state,'COMMITTED');
  const stages=await f.store.all('SELECT state,canonical_data,thumbnail_data FROM mcp_v2_media_stage');assert.equal(stages.length,2);assert.ok(stages.every(row=>row.state==='CONSUMED'&&row.canonical_data===null&&row.thumbnail_data===null));
  const replay=content(await client.call('catalog.commit_create',{operationId:op.operationId}));assert.equal(replay.replayed,true);assert.equal(replay.result.productId,created.productId);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement WHERE product_id=?',created.productId)).n,1);
 });
});
