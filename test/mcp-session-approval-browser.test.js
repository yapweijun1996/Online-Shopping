import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startContainer} from '../media-codec/scripts/dev-container.js';
import {catalogCreateRuntimeBrowserFixture} from './helpers/mcp-catalog-create-runtime-browser-fixture.js';
import {createProduct} from '../src/products.js';
import {readMediaSnapshot} from '../src/mcp/media-resources.js';
import {syntheticMediaPng} from './helpers/mcp-media-hooks-fixture.js';
import {hash} from '../src/mcp/credentials.js';
import {reviewPassword} from './helpers/mcp-review-fixture.js';
const enabled=process.env.QA_SESSION_APPROVAL_BROWSER_TEST==='1'&&Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const dto=value=>value.data.result?.structuredContent;
const input=sku=>({sku,name:sku,description:'Synthetic session-only approval browser',category:'SYNTHETIC',priceMinor:140,stockQuantity:3,active:true});
async function fixture(t,dialect,worker,browser){
 const f=await catalogCreateRuntimeBrowserFixture(t,dialect,worker,browser);await f.configure({mcpFinish:{enabled:true}});
 const client=await f.authorize(f.allScopes),page=await f.context.newPage();
 const prepare=async sku=>{const result=await client.call('catalog.preview_create',{input:input(sku),idempotencyKey:'session-browser-create-'+sku});assert.equal(result.response.status,200);return dto(result);};
 return{...f,client,page,prepare};
}
test('session approval recovery, early reject and complete batch sign-in continuation',{skip:!enabled,timeout:120000},async t=>{
 const pin=(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim(),worker=await startContainer(pin);t.after(worker.stop);
 const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const dialect of process.env.SHOP_TEST_DATABASE_URL?['sqlite','postgres']:['sqlite']){
  await t.test(dialect+': first batch item can be explicitly rejected before advancing and without a password prompt',async child=>{
   const f=await fixture(child,dialect,worker,browser),a=await f.prepare('EARLY-A'),b=await f.prepare('EARLY-B');
   await f.page.goto(f.origin+'/oauth/operation?operationIds='+a.operationId+','+b.operationId);
   await f.page.locator('#review-next').waitFor({state:'visible'});assert.equal(await f.page.locator('#password').count(),0);
   await f.page.getByRole('button',{name:'Reject this change'}).click();await f.page.locator('#decision').waitFor({state:'hidden'});
   assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',a.operationId)).state,'REJECTED');
   assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',b.operationId)).state,'PENDING_APPROVAL');
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
  });
  await t.test(dialect+': synthetic lost approval request restores pending review with a new challenge and unchecked acknowledgments',async child=>{
   const f=await fixture(child,dialect,worker,browser),op=await f.prepare('LOST-REQUEST');
   await f.page.goto(op.reviewUrl);await f.page.locator('#metadata-ack').waitFor({state:'visible'});
   await f.page.locator('#media-ack').check();await f.page.locator('#metadata-ack').check();
   const old=await f.store.get('SELECT id FROM mcp_v2_approval_challenge WHERE operation_id=?',op.operationId);
   await f.page.route('**/finishes/*/approve',route=>route.abort('failed'));
   await f.page.locator('#approve-finish').click();await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('could not be confirmed'));
   assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',op.operationId)).state,'PENDING_APPROVAL');
   await f.page.unroute('**/finishes/*/approve');await f.page.reload();await f.page.locator('#metadata-ack').waitFor({state:'visible'});
   assert.equal(await f.page.locator('#finish-progress').isVisible(),false);assert.equal(await f.page.locator('#approve-finish').isVisible(),true);
   assert.equal(await f.page.locator('#media-ack').isChecked(),false);assert.equal(await f.page.locator('#metadata-ack').isChecked(),false);
   assert.equal(await f.page.locator('#password').count(),0);
   const fresh=await f.store.get('SELECT id FROM mcp_v2_approval_challenge WHERE operation_id=?',op.operationId);assert.notEqual(fresh.id,old.id);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).n,0);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
  });
  await t.test(dialect+': lost upload approval restores exact-image delivery and requires image acknowledgment again',async child=>{
   const f=await fixture(child,dialect,worker,browser),product=await createProduct(f.store,input('UPLOAD-LOST')),bytes=syntheticMediaPng(3);
   const begin=dto(await f.client.call('media.prepare_upload',{input:{action:'begin',productId:product.id,targetSlot:'MAIN',expectedRevision:(await readMediaSnapshot(f.store,product.id)).revision,
    sourceSha256:hash(bytes),sourceMime:'image/png',declaredBytes:bytes.length,idempotencyKey:'session-upload-lost-begin'}}));
   const stageId=begin.stage.stageId;assert.equal((await f.client.call('media.prepare_upload',{input:{action:'append',stageId,offset:0,dataParts:[bytes.toString('base64')]}})).response.status,200);
   const op=dto(await f.client.call('media.prepare_upload',{input:{action:'seal',stageId,idempotencyKey:'session-upload-lost-seal'}})).operation;
   await f.page.goto(op.reviewUrl);await f.page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);await f.page.locator('#media-image-ack').click();
   await f.page.waitForFunction(()=>!document.querySelector('#approve-finish').disabled);await f.page.locator('#media-ack').check();await f.page.locator('#metadata-ack').check();
   const old=await f.store.get('SELECT id FROM mcp_v2_approval_challenge WHERE operation_id=?',op.operationId);
   await f.page.route('**/finishes/*/approve',route=>route.abort('failed'));await f.page.locator('#approve-finish').click();
   await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('could not be confirmed'));await f.page.unroute('**/finishes/*/approve');
   await f.page.reload();await f.page.locator('#metadata-ack').waitFor({state:'visible'});await f.page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);
   const fresh=await f.store.get('SELECT id FROM mcp_v2_approval_challenge WHERE operation_id=?',op.operationId);assert.notEqual(fresh.id,old.id);
   assert.equal(await f.page.locator('#approve-finish').isDisabled(),true);assert.equal(await f.page.locator('#media-ack').isChecked(),false);
   assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET' AND ack_at IS NOT NULL",op.operationId)).n,0);
   assert.equal((await f.store.get('SELECT image_mime FROM product WHERE id=?',product.id)).image_mime,null);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id=?',op.operationId)).n,0);
  });
  await t.test(dialect+': unauthenticated batch signs in and returns to every bounded UUID without approving',async child=>{
   const f=await fixture(child,dialect,worker,browser),a=await f.prepare('LOGIN-A'),b=await f.prepare('LOGIN-B'),ids=a.operationId+','+b.operationId;
   const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});child.after(()=>context.close());const page=await context.newPage();
   await page.goto(f.origin+'/oauth/operation?operationIds='+ids);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Sign in to Seller Studio'));
   assert.equal(await page.locator('#seller-link').getAttribute('href'),'/seller/?reviewOperations='+ids);await page.locator('#seller-link').click();
   await page.locator('#login-form').waitFor({state:'visible'});await page.locator('#username').fill('synthetic_owner');await page.locator('#password').fill(reviewPassword);
   await page.locator('#login-submit').click();await page.waitForURL(f.origin+'/oauth/operation?operationIds='+ids);await page.locator('#review-next').waitFor({state:'visible'});
   assert.equal(await page.locator('#password').count(),0);assert.match(await page.locator('#batch-progress').textContent(),/Review 1 of 2/);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n,0);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
   for(const query of ['reviewOperations='+ids+'&returnTo=https://evil.example/','reviewOperations='+a.operationId+','+a.operationId,'reviewOperations='+ids+'&reviewOperations='+ids]){
    await page.goto(f.origin+'/seller/?'+query);await page.locator('#workspace').waitFor({state:'visible'});assert.equal(new URL(page.url()).pathname,'/seller/');
   }
  });
 }
});
