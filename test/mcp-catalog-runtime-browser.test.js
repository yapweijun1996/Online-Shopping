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
import {catalogRuntimeBrowserFixture,approveCatalogInBrowser} from './helpers/mcp-catalog-runtime-browser-fixture.js';
const enabled=process.env.CATALOG_MEDIA_NATIVE_BROWSER_TEST==='1'&&Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const content=value=>value.data.result?.structuredContent;
const photo=n=>'data:image/png;base64,'+syntheticMediaPng(n).toString('base64');
async function product(f,sku,group,label,image){return createProduct(f.store,{sku,name:'Literal '+sku,description:'Synthetic existing catalog product',category:'SYNTHETIC',
 priceMinor:1200,stockQuantity:7,active:true,...(group?{variantGroup:group,variantLabel:label}:{}),imageDataUrl:photo(image)});}
async function clientAndPage(f){
 const client=await f.authorize(f.allScopes),listed=await client.rpc('tools/list',{});
 assert.deepEqual(listed.data.result.tools.map(row=>row.name),[...catalogue.map(row=>row.name),
  'catalog.preview_create','catalog.commit_create','catalog.preview_update','catalog.commit_update','operations.get','operations.cancel','operations.audit',
  'media.list','media.prepare_upload','media.commit_upload','media.upload_file','media.preview_layout','media.commit_layout']);
 assert.deepEqual(listed.data.result.tools.slice(0,8),catalogue.map(({scope:_scope,...row})=>row));
 const page=await f.context.newPage(),errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));
 await f.context.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():(external.push(route.request().url()),route.abort()));
 return{client,page,errors,external};
}
async function prepare(f,client,id,changes,key){
 const response=await client.call('catalog.preview_update',{input:{id,changes},idempotencyKey:key});
 assert.equal(response.response.status,200,JSON.stringify(response.data));const value=content(response);assert.ok(value?.operationId,JSON.stringify(response.data));
 const row=await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',value.operationId);
 assert.equal(row.risk,'HIGH');assert.equal(row.media_policy_id,'catalog-media-v1');assert.equal(row.required_scope,'catalog.write');
 assert.equal((await f.store.get('SELECT required_scopes FROM mcp_v2_operation_media_policy WHERE operation_id=?',value.operationId)).required_scopes,'catalog.write media.write');
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin WHERE operation_id=?',value.operationId)).n,0);
 return value;
}
async function commit(client,operation){
 const value=await client.call('catalog.commit_update',{operationId:operation.operationId});assert.equal(value.response.status,200,JSON.stringify(value.data));
 const result=content(value);assert.equal(result?.status,'COMMITTED',JSON.stringify(value.data));assert.equal(result.replayed,false);
 const replay=content(await client.call('catalog.commit_update',{operationId:operation.operationId}));assert.equal(replay.replayed,true);assert.deepEqual(replay.result,result.result);
 assert.deepEqual(Object.keys(result.result).sort(),['listingId','productId','revision']);return result;
}
async function assertStorefront(f,operation,productId){
 const pages=await f.store.all('SELECT page_json FROM mcp_v2_media_manifest_page WHERE operation_id=? ORDER BY page_index',operation.operationId),
  records=pages.flatMap(row=>JSON.parse(row.page_json).records),product=records.find(row=>row.kind==='PRODUCT'&&row.productId===productId),
  listing=records.find(row=>row.kind==='LISTING'&&row.listingId===product.after.listingId),
  expected=product.after.role==='single'?listing.after.galleryAssetKeys:[...(product.after.ownMainVisible?[product.after.mainAssetKey]:[]),...listing.after.galleryAssetKeys];
 const value=await f.call('/api/v1/products/'+productId);assert.equal(value.response.status,200);assert.equal(value.data.images.length,expected.length);
 const keys=[];for(const path of value.data.images){const url=new URL(path,f.origin);assert.equal(url.origin,f.origin);
  const response=await f.context.request.get(url.href);assert.equal(response.status(),200);keys.push(mediaAssetKey(response.headers()['content-type'],hash(await response.body())));}
 assert.deepEqual(keys,expected);
}

test('default C UPDATE factory actual native/OAuth/MCP/browser gate preserves full graph proof on both databases',
 {skip:!enabled,timeout:180000},async t=>{
  assert.ok(process.env.SHOP_TEST_DATABASE_URL,'Both databases required for this acceptance gate.');
  const image=(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim(),worker=await startContainer(image);t.after(worker.stop);
  const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  for(const dialect of ['sqlite','postgres']){
   await t.test(dialect+': existing group move and SKU holder switch use real approvals and service history',async child=>{
    const f=await catalogRuntimeBrowserFixture(child,dialect,worker,browser),source=await product(f,'ZZZ','SOURCE','Source',1),
     target=await product(f,'AAA','TARGET','Target',2),sibling=await product(f,'BBB','TARGET','Sibling',3);
    await addGalleryImage(f.store,source.id,photo(4));await addGalleryImage(f.store,target.id,photo(5));
    // Deliberate synthetic legacy timestamp tie exercises the actual SQL holder
    // order; no fabricated rows or human evidence is introduced.
    await f.store.run('UPDATE product SET created_at=?','2026-01-01T00:00:00.000Z');
    const stock=await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),movements=await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),
     {client,page,errors,external}=await clientAndPage(f);
    for(const scopes of ['catalog.write','media.write']){
     const partial=await f.authorize(legacyCatalogScopes+' '+scopes),listed=await partial.rpc('tools/list',{});
     assert.equal(listed.data.result.tools.some(row=>['catalog.preview_update','catalog.commit_update'].includes(row.name)),false);
     const denied=await partial.call('catalog.preview_update',{input:{id:source.id,changes:{name:'Unconsented literal'}},idempotencyKey:'missing-domain-'+scopes});
     assert.equal(denied.response.status,403);assert.equal(denied.response.headers.get('www-authenticate'),'Bearer error="insufficient_scope", scope="catalog.write media.write"');
    }
    const move=await prepare(f,client,source.id,{variantGroup:'TARGET',variantLabel:'Moved'},'actual-catalog-runtime-move');
    await approveCatalogInBrowser(f,page,move);assert.match(await page.locator('#media-effects').textContent(),/Removed by this change/);
    const moved=await commit(client,move);await assertStorefront(f,move,source.id);assert.equal(moved.result.listingId,target.listingId);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',source.listingId),undefined);
    assert.equal((await getProduct(f.store,source.id,true)).name,target.name);
    const flip=await prepare(f,client,source.id,{sku:'000'},'actual-catalog-runtime-holder');await approveCatalogInBrowser(f,page,flip);await commit(client,flip);await assertStorefront(f,flip,sibling.id);
    assert.equal((await getProduct(f.store,sibling.id,true)).galleryHolderId,source.id);
    const get=await client.call('operations.get',{operationId:move.operationId});assert.equal(content(get).status,'COMMITTED');
    const audit=await client.call('operations.audit',{operationId:move.operationId});assert.ok(content(audit).items.some(row=>row.event==='APPROVE'));
    assert.deepEqual(await f.store.all('SELECT * FROM inventory_state ORDER BY product_id'),stock);assert.deepEqual(await f.store.all('SELECT * FROM inventory_movement ORDER BY id'),movements);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?',source.id)).n,2);
    const old=await f.authorize(legacyCatalogScopes),oldList=await old.rpc('tools/list',{});assert.deepEqual(oldList.data.result.tools,catalogue.map(({scope:_scope,...row})=>row));
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
   });
   await t.test(dialect+': leave uses server planned UUID, flag-off denies pending C and cancellation is exactonce',async child=>{
    const f=await catalogRuntimeBrowserFixture(child,dialect,worker,browser),holder=await product(f,'HOLDER','GROUP','A',6),variant=await product(f,'VARIANT','GROUP','B',7),
     {client,page,errors,external}=await clientAndPage(f),leave=await prepare(f,client,variant.id,{variantGroup:null},'actual-catalog-runtime-leave');
    const envelope=JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',leave.operationId)).envelope_json),planned=envelope.proposal.plannedIdentity;
    assert.ok(planned?.newListingId);assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?',planned.newListingId),undefined);
    await f.configure({mcpCatalogMediaUpdate:{enabled:false}});
    assert.equal((await f.call('/api/v1/seller/mcp/operations/'+leave.operationId,'GET',undefined,client.headers)).response.status,403);
    assert.equal((await client.call('catalog.commit_update',{operationId:leave.operationId})).response.status,403);
    assert.equal((await client.call('operations.get',{operationId:leave.operationId})).response.status,403);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',leave.operationId)).state,'PENDING_APPROVAL');
    const oldSafe=await client.call('catalog.preview_update',{input:{id:variant.id,changes:{priceMinor:1300}},idempotencyKey:'legacy-safe-before-c-profile'});
    assert.equal(oldSafe.response.status,200);const safeOperation=content(oldSafe);assert.ok(safeOperation?.operationId);
    assert.equal((await f.store.get('SELECT risk FROM mcp_v2_operation WHERE id=?',safeOperation.operationId)).risk,'MEDIUM');
    await f.configure({mcpCatalogMediaUpdate:{enabled:true}});
    assert.equal((await f.call('/api/v1/seller/mcp/operations/'+safeOperation.operationId,'GET',undefined,client.headers)).response.status,403);
    assert.equal((await client.call('catalog.commit_update',{operationId:safeOperation.operationId})).response.status,403);
    await approveCatalogInBrowser(f,page,leave);
    assert.match(await page.locator('#media-effects').textContent(),/Did not exist before this change/);
    assert.equal((await commit(client,leave)).result.listingId,planned.newListingId);await assertStorefront(f,leave,variant.id);assert.ok(await f.store.get('SELECT id FROM listing WHERE id=?',holder.listingId));
    const pending=await prepare(f,client,variant.id,{name:'Cancelled literal'},'actual-catalog-runtime-cancel'),before=await getProduct(f.store,variant.id,true);
    assert.equal(content(await client.call('operations.cancel',{operationId:pending.operationId})).replayed,false);
    assert.equal(content(await client.call('operations.cancel',{operationId:pending.operationId})).replayed,true);
    assert.equal((await client.call('catalog.commit_update',{operationId:pending.operationId})).response.status,403);
    assert.equal((await getProduct(f.store,variant.id,true)).name,before.name);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
   });
  }
 });
