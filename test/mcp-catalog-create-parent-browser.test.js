import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir } from 'node:fs/promises';
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
async function reviewExact(f,page,op,{navigate=true}={}){
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 if(navigate)await page.goto(op.reviewUrl);await page.locator('#media-review').waitFor({state:'visible'});
 const count=Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',op.operationId)).n);
 for(let n=1;n<=count;n++){await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);assert.ok(await page.locator('#media-image').evaluate(node=>node.naturalWidth)>0);await page.locator('#media-image-ack').click();await page.waitForFunction(value=>document.querySelector('#media-progress').textContent.startsWith(value+' of '),n);}
 await page.locator('#metadata-ack').check();await page.locator('#media-ack').check();assert.equal(await page.locator('#password').count(),0);
 assert.deepEqual(errors,[]);
}
async function finishExact(page){
 await page.locator('#approve-finish').click();await page.waitForFunction(()=>document.querySelector('#finish-items').children.length>0);assert.match(await page.locator('#finish-summary').textContent(),/Finished\./,await page.locator('#status').textContent()+' '+await page.locator('#finish-items').textContent());
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
  const page=await f.context.newPage();await reviewExact(f,page,op);
  if(process.env.QA_FINISH_ARTIFACTS){await mkdir(process.env.QA_FINISH_ARTIFACTS,{recursive:true});for(const [width,colorScheme]of [[320,'light'],[390,'dark'],[1440,'light']]){await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${process.env.QA_FINISH_ARTIFACTS}/parent-${dialect}-${width}-${colorScheme}.png`,fullPage:true});}}
  await finishExact(page);
  const actual=await getProduct(f.store,created.productId,true);assert.equal(actual.sku,value.sku);assert.equal(actual.active,true);assert.equal(actual.stockQuantity,100);assert.equal(actual.priceMinor,140);assert.equal(actual.images.length,2);
  assert.equal((await f.store.get('SELECT state FROM seller_mcp_create_draft WHERE id=?',created.draftId)).state,'COMMITTED');
  const stages=await f.store.all('SELECT state,canonical_data,thumbnail_data FROM mcp_v2_media_stage');assert.equal(stages.length,2);assert.ok(stages.every(row=>row.state==='CONSUMED'&&row.canonical_data===null&&row.thumbnail_data===null));
  const replay=content(await client.call('catalog.commit_create',{operationId:op.operationId}));assert.equal(replay.replayed,true);assert.equal(replay.result.productId,created.productId);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement WHERE product_id=?',created.productId)).n,1);
  // Two genuine parent approvals in a batch; the first CREATE changes the
  // global catalog revision. The second stops and resumes only after fresh
  // native validation and a new complete human review, preserving planned IDs.
  const aValue=product({sku:'PARENT-BATCH-A'}),bValue=product({sku:'PARENT-BATCH-B'}),aDraft=await draft(f,client,aValue,[21,22],'parent-batch-draft-a'),bDraft=await draft(f,client,bValue,[23,24],'parent-batch-draft-b');
  const a=await prepare(f,client,aValue,aDraft,'parent-batch-preview-a'),b=await prepare(f,client,bValue,bDraft,'parent-batch-preview-b');
  await page.goto(f.origin+'/oauth/operation?operationIds='+a.operationId+','+b.operationId);await reviewExact(f,page,a,{navigate:false});await page.locator('#review-next').click();await page.waitForFunction(()=>document.querySelector('#batch-progress').textContent.startsWith('Review 2'));
  await reviewExact(f,page,b,{navigate:false});await page.locator('#approve-finish').click();await page.waitForFunction(()=>document.querySelector('#finish-summary').textContent.includes('Some items need'));
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',a.operationId)).state,'COMMITTED');assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',b.operationId)).state,'CONFLICT');assert.equal(await getProduct(f.store,bDraft.productId,true),null);
  await page.reload();await page.getByRole('button',{name:'Revalidate and review again'}).click();await page.waitForURL(url=>url.searchParams.has('operationId')&&url.searchParams.get('operationId')!==b.operationId);
  const replacementId=new URL(page.url()).searchParams.get('operationId'),newRow=await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',replacementId),newProposal=JSON.parse(newRow.envelope_json).proposal;
  assert.equal(newProposal.creationIdentity.productId,bDraft.productId);assert.equal(newProposal.creationIdentity.newListingId,bDraft.listingId);assert.notEqual(newProposal.creationMedia.draftId,bDraft.draftId);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id=?',replacementId)).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_approval_evidence WHERE operation_id=?',replacementId)).n,0);
  assert.equal((await client.call('catalog.commit_create',{operationId:replacementId})).response.status,403);
  await reviewExact(f,page,{operationId:replacementId},{navigate:false});await finishExact(page);assert.ok((await getProduct(f.store,bDraft.productId,true)).active);await page.reload();assert.match(await page.locator('#finish-summary').textContent(),/Finished\./);
  // Material affected-sibling insertion cannot silently rebase old approval.
  const holder=await createProduct(f.store,{...product({sku:'PARENT-HOLDER',variantGroup:'PARENT-GROUP',variantLabel:'Holder'}),imageDataUrl:'data:image/png;base64,'+syntheticMediaPng(31).toString('base64')});
  const sharedValue=product({sku:'PARENT-SHARED',variantGroup:'PARENT-GROUP',variantLabel:'New'}),sharedDraft=await draft(f,client,sharedValue,[32,33],'parent-shared-draft'),oldShared=await prepare(f,client,sharedValue,sharedDraft,'parent-shared-preview');
  const sibling=await createProduct(f.store,{...product({sku:'PARENT-SIBLING',variantGroup:'PARENT-GROUP',variantLabel:'Sibling'})});
  assert.equal((await f.call('/api/v1/seller/mcp/operations/'+oldShared.operationId)).response.status,403);
  const freshShared=await prepare(f,client,sharedValue,sharedDraft,'parent-shared-renewed-preview'),sharedRow=await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',freshShared.operationId),sharedProposal=JSON.parse(sharedRow.envelope_json).proposal;
  assert.equal(sharedProposal.creationIdentity.productId,sharedDraft.productId);assert.ok(sharedProposal.reviewLabels.some(row=>row.productId===sibling.id));assert.equal(sharedProposal.reviewLabels.length,3);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id=?',freshShared.operationId)).n,0);
  await reviewExact(f,page,freshShared);await finishExact(page);const shared=await getProduct(f.store,sharedDraft.productId,true);assert.equal(shared.listingId,holder.listingId);assert.equal(shared.images.length,3);
  // Duplicate canonical MAIN/GALLERY is explicitly rejected, never reordered.
  const duplicateValue=product({sku:'PARENT-DUPLICATE'}),duplicateDraft=await draft(f,client,duplicateValue,[40,40],'parent-duplicate-draft'),duplicate=await client.call('catalog.preview_create',{input:{...duplicateValue,draftId:duplicateDraft.draftId},idempotencyKey:'parent-duplicate-preview'});
  assert.equal(duplicate.data.error?.code,-32602);assert.equal(await getProduct(f.store,duplicateDraft.productId,true),null);await client.call('catalog.prepare_create',{input:{action:'discard',draftId:duplicateDraft.draftId}});

 });
});
