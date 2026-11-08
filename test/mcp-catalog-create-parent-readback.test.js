import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
import{startContainer}from'../media-codec/scripts/dev-container.js';
import{catalogCreateRuntimeBrowserFixture}from'./helpers/mcp-catalog-create-runtime-browser-fixture.js';
import{syntheticMediaPng}from'./helpers/mcp-media-hooks-fixture.js';
import{mediaHash}from'../src/mcp/media-storage.js';
import{createProduct,updateProduct}from'../src/products.js';
const enabled=process.env.CATALOG_MEDIA_CREATE_PARENT_NATIVE_BROWSER_TEST==='1'&&Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const product=extra=>({sku:'PARENT-NEW',name:'Synthetic parent',description:'Reviewed shared description',category:'SYNTHETIC',priceMinor:140,stockQuantity:100,active:true,...extra});
test('native parent first resume checks complete affected sibling metadata after a genuine commit',{skip:!enabled,timeout:240000},async t=>{
 const worker=await startContainer(process.env.SHOP_TEST_MEDIA_CODEC_IMAGE??(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim());t.after(worker.stop);
 const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const dialect of ['sqlite','postgres'])for(const field of ['unchanged','priceMinor','stockQuantity','description','active'])await t.test(dialect+': '+field,async child=>{
 const f=await catalogCreateRuntimeBrowserFixture(child,dialect,worker,browser);await f.configure({mcpFinish:{enabled:true}});const client=await f.authorize(f.allScopes);
 const holder=await createProduct(f.store,product({sku:'PARENT-HOLDER',variantGroup:'PARENT-GROUP',variantLabel:'Holder',imageDataUrl:'data:image/png;base64,'+syntheticMediaPng(31).toString('base64')}));
 const value=product({variantGroup:'PARENT-GROUP',variantLabel:'New'}),bytes=[syntheticMediaPng(32),syntheticMediaPng(33)],content=r=>r.data.result.structuredContent;
 const draft=content(await client.call('catalog.prepare_create',{input:{action:'begin',product:value,images:bytes.map(b=>({sourceSha256:mediaHash(b),sourceMime:'image/png',declaredBytes:b.length})),idempotencyKey:'readback-draft-key-001'}}));
 for(const[index,b]of bytes.entries())await client.call('catalog.prepare_create',{input:{action:'append',draftId:draft.draftId,index,offset:0,dataParts:[b.toString('base64')]}});
 const op=content(await client.call('catalog.preview_create',{input:{...value,draftId:draft.draftId},idempotencyKey:'readback-preview-key-001'})),path='/api/v1/seller/mcp/operations/'+op.operationId;
 const review=(await f.call(path,'GET',undefined,client.headers)).data;
 for(const item of review.mediaReview.items){const args={operationId:op.operationId,previewHash:op.previewHash,challenge:review.challenge,kind:item.kind,itemKey:item.itemKey},delivery=await f.context.request.fetch(f.origin+path+'/media/delivery',{method:'POST',headers:client.headers,data:args});assert.equal(delivery.status(),200);assert.equal(mediaHash(await delivery.body()),item.hash);assert.equal((await f.call(path+'/media/ack','POST',{...args,nonce:delivery.headers()['x-media-nonce'],expectedHash:item.hash},client.headers)).response.status,200);}
 const job=await f.call('/api/v1/seller/mcp/finishes','POST',{items:[{operationId:op.operationId,previewHash:op.previewHash}],idempotencyKey:'readback-finish-key-001'},client.headers);assert.equal(job.response.status,200);
 assert.equal((await f.call(path+'/approval','POST',{operationId:op.operationId,previewHash:op.previewHash,challenge:review.challenge,decision:'approve',mediaReviewed:true},client.headers)).response.status,200);
 assert.equal(content(await client.call('catalog.commit_create',{operationId:op.operationId})).status,'COMMITTED');
 if(field!=='unchanged')await updateProduct(f.store,holder.id,{[field]:{priceMinor:999,stockQuantity:4,description:'Later authorized shared description',active:false}[field]});
 const resumed=await f.call('/api/v1/seller/mcp/finishes/'+job.data.jobId+'/resume','POST',{},client.headers);
 assert.equal(resumed.data.status,field==='unchanged'?'FINISHED':'PARTIAL',JSON.stringify(resumed.data));
 if(field!=='unchanged')assert.equal(resumed.data.items[0].error,'VERIFY_CHANGED');
 assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",op.operationId)).n),1);
 });
});
