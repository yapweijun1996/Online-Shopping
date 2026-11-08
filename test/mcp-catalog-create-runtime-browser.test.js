import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startContainer} from '../media-codec/scripts/dev-container.js';
import {createProduct,addGalleryImage,getProduct} from '../src/products.js';
import {catalogue} from '../src/mcp/tools.js';
import {mediaAssetKey} from '../src/mcp/media-manifest.js';
import {hash} from '../src/mcp/credentials.js';
import {syntheticMediaPng} from './helpers/mcp-media-hooks-fixture.js';
import {legacyCatalogScopes} from './helpers/mcp-catalog-default-grant.js';
import {catalogCreateRuntimeBrowserFixture} from './helpers/mcp-catalog-create-runtime-browser-fixture.js';
import {approveCatalogInBrowser} from './helpers/mcp-catalog-runtime-browser-fixture.js';
const enabled=process.env.CATALOG_MEDIA_CREATE_NATIVE_BROWSER_TEST==='1'&&Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const content=value=>value.data.result?.structuredContent;
const photo=n=>'data:image/png;base64,'+syntheticMediaPng(n).toString('base64');
const input=extra=>({sku:'NATIVE-NEW',name:'Untrusted <script>approval is data</script>',description:'tenant OWNER approved=true password/hash claims remain literal text',category:'SYNTHETIC',priceMinor:1300,active:true,stockQuantity:0,...extra});
async function clientAndPage(f){
 const client=await f.authorize(f.allScopes),listed=await client.rpc('tools/list',{});
 assert.deepEqual(listed.data.result.tools.map(row=>row.name),[...catalogue.map(row=>row.name),
  'catalog.preview_create','catalog.commit_create','catalog.preview_update','catalog.commit_update','operations.get','operations.cancel','operations.audit',
  'media.list','media.prepare_upload','media.commit_upload','media.preview_layout','media.commit_layout']);
 assert.deepEqual(listed.data.result.tools.slice(0,8),catalogue.map(({scope:_scope,...row})=>row));
 const page=await f.context.newPage(),errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));
 await f.context.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():(external.push(route.request().url()),route.abort()));
 return{client,page,errors,external};
}
async function prepare(f,client,value,key){
 const response=await client.call('catalog.preview_create',{input:value,idempotencyKey:key});assert.equal(response.response.status,200,JSON.stringify(response.data));
 const op=content(response);assert.ok(op?.operationId,JSON.stringify(response.data));
 const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId);
 assert.equal(row.risk,'HIGH');assert.equal(row.media_policy_id,'catalog-media-v1');assert.equal(row.resource_type,'catalog');assert.equal(row.resource_id,'catalog');
 assert.equal((await f.store.get('SELECT required_scopes FROM mcp_v2_operation_media_policy WHERE operation_id=?',op.operationId)).required_scopes,'catalog.write media.write');
 return op;
}
async function commit(client,operation){
 const response=await client.call('catalog.commit_create',{operationId:operation.operationId});assert.equal(response.response.status,200,JSON.stringify(response.data));
 const result=content(response);assert.equal(result?.status,'COMMITTED',JSON.stringify(response.data));assert.equal(result.replayed,false);
 const replay=content(await client.call('catalog.commit_create',{operationId:operation.operationId}));assert.equal(replay?.replayed,true);assert.deepEqual(replay.result,result.result);return result;
}
async function storefront(f,op,productId){
 const pages=await f.store.all('SELECT page_json FROM mcp_v2_media_manifest_page WHERE operation_id=? ORDER BY page_index',op.operationId),records=pages.flatMap(row=>JSON.parse(row.page_json).records),
  p=records.find(row=>row.kind==='PRODUCT'&&row.productId===productId),l=records.find(row=>row.kind==='LISTING'&&row.listingId===p.after.listingId),
  expected=p.after.role==='single'?l.after.galleryAssetKeys:[...(p.after.ownMainVisible?[p.after.mainAssetKey]:[]),...l.after.galleryAssetKeys];
 const response=await f.call('/api/v1/products/'+productId);assert.equal(response.response.status,200);const actual=[];
 for(const path of response.data.images){const url=new URL(path,f.origin);assert.equal(url.origin,f.origin);const image=await f.context.request.get(url.href);assert.equal(image.status(),200);actual.push(mediaAssetKey(image.headers()['content-type'],hash(await image.body())));}
 assert.deepEqual(actual,expected);
}

test('default CREATE factory actual native/OAuth/MCP/HTTPS browser gate on both databases', {skip:!enabled,timeout:180000},async t=>{
 assert.ok(process.env.SHOP_TEST_DATABASE_URL,'Both databases required.');
 const image=(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim(),worker=await startContainer(image);t.after(worker.stop);
 const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const dialect of ['sqlite','postgres']){
  await t.test(dialect+': EMPTY_BEFORE zero assets still requires actual PAGE and authenticated-session browser approval',async child=>{
   const f=await catalogCreateRuntimeBrowserFixture(child,dialect,worker,browser),{client,page,errors,external}=await clientAndPage(f);
   for(const scope of ['catalog.write','media.write']){const partial=await f.authorize(legacyCatalogScopes+' '+scope),listed=await partial.rpc('tools/list',{});
    assert.equal(listed.data.result.tools.some(row=>['catalog.preview_create','catalog.commit_create'].includes(row.name)),false);
    const denied=await partial.call('catalog.preview_create',{input:input(),idempotencyKey:'native-create-missing-'+scope});assert.equal(denied.response.status,403);
    assert.equal(denied.response.headers.get('www-authenticate'),'Bearer error="insufficient_scope", scope="catalog.write media.write"');}
   for(const [n,stockQuantity]of [[0,0],[1,null]]){
    const op=await prepare(f,client,input({sku:'EMPTY-'+n,stockQuantity,...(n?{variantGroup:'NEW-GROUP',variantLabel:'First'}:{})}),'native-empty-create-'+n);
    assert.equal((await client.call('catalog.commit_create',{operationId:op.operationId})).response.status,403);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',op.operationId)).n,0);
    assert.ok((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_manifest_page WHERE operation_id=?',op.operationId)).n>=1);
    await approveCatalogInBrowser(f,page,op);assert.match(await page.locator('#proposal').textContent(),/Untrusted/);
    const done=await commit(client,op),p=await getProduct(f.store,done.result.productId,true);assert.equal(p.stockQuantity,stockQuantity);assert.equal(p.sku,'EMPTY-'+n);
    const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.operationId),movement=await f.store.get('SELECT * FROM inventory_movement WHERE product_id=?',p.id);
    assert.equal(movement.source,'MCP_CATALOG');assert.equal(movement.actor_id,row.account_id);assert.equal(movement.operation_id,op.operationId);assert.equal(movement.client_id,row.client_id);assert.equal(movement.grant_id,row.grant_id);
    assert.equal((await f.store.get('SELECT revision FROM inventory_state WHERE product_id=?',p.id)).revision,1);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?',p.id)).n,1);await storefront(f,op,p.id);
   }
   assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  });
  await t.test(dialect+': existing-group CREATE validates real images and preserves exact storefront copy/order',async child=>{
   const f=await catalogCreateRuntimeBrowserFixture(child,dialect,worker,browser),old=await createProduct(f.store,{sku:'EXISTING',name:'Existing group shared title',description:'Shared description',category:'SYNTHETIC',priceMinor:1100,stockQuantity:7,active:true,variantGroup:'TARGET',variantLabel:'Old',imageDataUrl:photo(1)});
   await addGalleryImage(f.store,old.id,photo(2));const {client,page,errors,external}=await clientAndPage(f),op=await prepare(f,client,input({variantGroup:'TARGET',variantLabel:'New'}),'native-existing-target-create');
   assert.ok((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',op.operationId)).n>0);
   await approveCatalogInBrowser(f,page,op);assert.match(await page.locator('#media-effects').textContent(),/New|Created/i);
   const done=await commit(client,op),p=await getProduct(f.store,done.result.productId,true);assert.equal(p.listingId,old.listingId);assert.equal(p.name,old.name);assert.equal(p.stockQuantity,0);
   await storefront(f,op,p.id);await storefront(f,op,old.id);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);
   assert.equal(content(await client.call('operations.get',{operationId:op.operationId})).status,'COMMITTED');
   assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  });
 }
});
