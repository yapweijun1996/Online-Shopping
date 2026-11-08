import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir } from 'node:fs/promises';
import { startContainer } from '../media-codec/scripts/dev-container.js';
import { catalogCreateRuntimeBrowserFixture } from './helpers/mcp-catalog-create-runtime-browser-fixture.js';
import { createProduct, getProduct, getProductImage } from '../src/products.js';
import { syntheticMediaPng } from './helpers/mcp-media-hooks-fixture.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { hash } from '../src/mcp/credentials.js';
const enabled=process.env.QA_FINISH_BROWSER_TEST==='1'&&Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const content=response=>response.data.result?.structuredContent;
const input=sku=>({sku,name:sku+' product',description:'Synthetic finish browser fixture',category:'SYNTHETIC',priceMinor:140,stockQuantity:100,active:true});
async function prepare(client,sku,key,extra={}){
 const response=await client.call('catalog.preview_create',{input:{...input(sku),...extra},idempotencyKey:key});
 assert.equal(response.response.status,200,JSON.stringify(response.data));const op=content(response);assert.ok(op?.operationId,JSON.stringify(response.data));return op;
}
async function review(f,page,op,{navigate=true}={}){
 if(navigate)await page.goto(op.reviewUrl);
 await page.locator('#metadata-ack').waitFor({state:'visible'});
 assert.equal(await page.locator('#metadata-ack').isChecked(),false);
 const count=Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',op.operationId)).n);
 for(let n=0;n<count;n++){
  await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);
  assert.ok(await page.locator('#media-image').evaluate(node=>node.naturalWidth>0));
  await page.locator('#media-image-ack').click();
  await page.waitForFunction(expected=>document.querySelector('#media-progress').textContent.startsWith(expected+' of'),n+1);
 }
 await page.locator('#media-ack').check();await page.locator('#metadata-ack').check();
}
async function finish(page){
 assert.equal(await page.locator('#password').count(),0);await page.locator('#approve-finish').click();
}
async function finished(page){
 await page.waitForFunction(()=>document.querySelector('#finish-items').children.length>0);
 assert.match(await page.locator('#finish-summary').textContent(),/Finished\./,await page.locator('#status').textContent()+' '+await page.locator('#finish-items').textContent());
}
async function fixture(t,dialect,worker,browser){
 const f=await catalogCreateRuntimeBrowserFixture(t,dialect,worker,browser);await f.configure({mcpFinish:{enabled:true}});
 const client=await f.authorize(f.allScopes),page=await f.context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 return {...f,client,page,errors};
}
test('one-click finish uses actual HTTPS, OAuth, session, native image decoding and browser review',{skip:!enabled,timeout:240000},async t=>{
 const image=(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim(),worker=await startContainer(image);t.after(worker.stop);
 const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true,...(process.env.QA_BROWSER_EXECUTABLE?{executablePath:process.env.QA_BROWSER_EXECUTABLE}:{})});t.after(()=>browser.close());
 const dialects=process.env.SHOP_TEST_DATABASE_URL?['sqlite','postgres']:['sqlite'];
 for(const dialect of dialects){
  await t.test(dialect+': zero-image create; missing acknowledgment denies without repeated password; one click and reload finish once',async child=>{
   const f=await fixture(child,dialect,worker,browser),op=await prepare(f.client,'BROWSER-EMPTY','finish-browser-empty-01');
   await f.page.goto(op.reviewUrl);await f.page.locator('#approve-finish').waitFor({state:'visible'});
   await f.page.waitForFunction(()=>!document.querySelector('#approve-finish').disabled);
   await finish(f.page);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
   assert.match(await f.page.locator('#status').textContent(),/check both acknowledgments/);
   await review(f,f.page,op,{navigate:false});await finish(f.page);await finished(f.page);
   assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'COMMITTED');
   const product=await f.store.get('SELECT id FROM product WHERE sku=?','BROWSER-EMPTY');
   const catalog=await f.client.call('catalog.get',{id:product.id});assert.equal(catalog.response.status,200);assert.ok(content(catalog));
   assert.equal((await getProduct(f.store,product.id,true)).active,true);
   await f.page.reload();await finished(f.page);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,1);
   assert.deepEqual(f.errors,[]);
  });
  await t.test(dialect+': exact inherited images, responsive light/dark review, native decode and public read-back',async child=>{
   const f=await fixture(child,dialect,worker,browser);
   const old=await createProduct(f.store,{...input('IMAGE-OLD'),variantGroup:'GROUP',variantLabel:'Old',imageDataUrl:'data:image/png;base64,'+syntheticMediaPng(1).toString('base64')});
   const op=await prepare(f.client,'IMAGE-NEW','finish-browser-images-01',{variantGroup:'GROUP',variantLabel:'New'});
   await review(f,f.page,op);
   const dir=process.env.QA_FINISH_ARTIFACTS;
   for(const [width,colorScheme]of [[320,'light'],[390,'dark'],[1440,'light']]){
    await f.page.setViewportSize({width,height:1000});await f.page.emulateMedia({colorScheme});
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(dir){await mkdir(dir,{recursive:true});await f.page.screenshot({path:`${dir}/${dialect}-${width}-${colorScheme}.png`,fullPage:true});}
   }
   await finish(f.page);await finished(f.page);
   const product=await f.store.get('SELECT id FROM product WHERE sku=?','IMAGE-NEW');
   const readback=await getProduct(f.store,product.id,true);assert.equal(readback.listingId,old.listingId);
   const publicRead=await f.call('/api/v1/products/'+product.id);assert.equal(publicRead.response.status,200);
   assert.deepEqual(f.errors,[]);
  });
  await t.test(dialect+': actual staged image upload commits only reviewed bytes and its replay is once',async child=>{
   const f=await fixture(child,dialect,worker,browser),p=await createProduct(f.store,input('UPLOAD'));
   const bytes=syntheticMediaPng(2),revision=(await readMediaSnapshot(f.store,p.id)).revision;
   const begin=content(await f.client.call('media.prepare_upload',{input:{action:'begin',productId:p.id,targetSlot:'MAIN',expectedRevision:revision,sourceSha256:hash(bytes),sourceMime:'image/png',declaredBytes:bytes.length,idempotencyKey:'finish-upload-begin-01'}}));
   assert.ok(begin?.stage?.stageId,JSON.stringify(begin));const stageId=begin.stage.stageId;
   const append=await f.client.call('media.prepare_upload',{input:{action:'append',stageId,offset:0,dataParts:[bytes.toString('base64')]}});assert.equal(append.response.status,200);
   const sealed=content(await f.client.call('media.prepare_upload',{input:{action:'seal',stageId,idempotencyKey:'finish-upload-seal-001'}}));assert.ok(sealed?.operation,JSON.stringify(sealed));
   const op=sealed.operation;
   const unreviewed=await f.call('/api/v1/seller/mcp/operations/'+op.operationId),headers={origin:f.origin,'x-csrf-token':f.client.headers['x-csrf-token']};
   assert.equal(unreviewed.response.status,200);
   const prepared=await f.call('/api/v1/seller/mcp/finishes','POST',{items:[{operationId:op.operationId,previewHash:op.previewHash}],idempotencyKey:'finish-unreviewed-image-01'},headers);
   assert.equal(prepared.response.status,200);
   const denied=await f.call('/api/v1/seller/mcp/finishes/'+prepared.data.jobId+'/approve','POST',{
    items:[{operationId:op.operationId,previewHash:op.previewHash,challenge:unreviewed.data.challenge,mediaReviewed:true}]},headers);
   assert.equal(denied.response.status,403);assert.equal((await f.store.get('SELECT image_mime FROM product WHERE id=?',p.id)).image_mime,null);
   await review(f,f.page,op);await finish(f.page);await finished(f.page);
   const image=await getProductImage(f.store,p.id,true);assert.ok(image?.data?.length);
   const pin=await f.store.get('SELECT canonical_sha256 FROM mcp_v2_media_pin WHERE operation_id=?',op.operationId);assert.equal(hash(image.data),pin.canonical_sha256);
   const row=await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',op.operationId),thumb=await getProductImage(f.store,p.id,true,true);
   assert.equal(hash(thumb.data),JSON.parse(row.envelope_json).proposal.thumbnail.sha256);
   const stage=await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?',stageId);assert.equal(stage.state,'CONSUMED');
   await f.page.reload();await finished(f.page);
   assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n,1);
   assert.deepEqual(f.errors,[]);
  });
  await t.test(dialect+': batch reviews once, finishes first CREATE, holds stale second and requires fresh review',async child=>{
   const f=await fixture(child,dialect,worker,browser),a=await prepare(f.client,'BATCH-A','finish-browser-batch-a01'),b=await prepare(f.client,'BATCH-B','finish-browser-batch-b01');
   await f.page.goto(f.origin+'/oauth/operation?operationIds='+a.operationId+','+b.operationId);
   await review(f,f.page,a,{navigate:false});assert.equal(await f.page.locator('#password').count(),0);await f.page.locator('#review-next').click();
   await f.page.waitForFunction(()=>document.querySelector('#batch-progress').textContent.startsWith('Review 2'));
   await review(f,f.page,b,{navigate:false});await finish(f.page);
   await f.page.waitForFunction(()=>document.querySelector('#finish-summary').textContent.includes('Some items need'));
   assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',a.operationId)).state,'COMMITTED');
   assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',b.operationId)).state,'CONFLICT');
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,1);
   await f.page.getByRole('button',{name:'Revalidate and review again'}).click();
   await f.page.waitForURL(url=>url.searchParams.has('operationId')&&url.searchParams.get('operationId')!==b.operationId);
   const replacementId=new URL(f.page.url()).searchParams.get('operationId');
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id=?',replacementId)).n,0);
   await review(f,f.page,{operationId:replacementId},{navigate:false});await finish(f.page);await finished(f.page);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,2);assert.deepEqual(f.errors,[]);
  });
 }
});
