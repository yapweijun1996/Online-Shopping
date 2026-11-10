import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp,readFile,writeFile,mkdir,chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createApi } from '../src/app.js';
import { serveStatic } from '../src/static.js';
import { readConfig } from '../src/config.js';
import { ensureAdmin } from '../src/auth.js';
import { setupShop } from '../src/shop-setup.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { singleTenantRegistry } from '../src/tenants.js';
import { secret,hash } from '../src/mcp/credentials.js';
import { startContainer } from '../media-codec/scripts/dev-container.js';
import { freshCatalogAccess,legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';
import { catalogue } from '../src/mcp/tools.js';
import { syntheticMediaPng } from './helpers/mcp-media-hooks-fixture.js';
import { createMediaRuntime } from '../src/mcp/media-runtime.js';
import { mediaTools } from '../src/mcp/media-tools.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
const enabled=Boolean(process.env.QA_PLAYWRIGHT_MODULE)&&process.env.MEDIA_TOOLS_NATIVE_BROWSER_TEST==='1';
const dto=value=>value.data.result?.structuredContent;
async function environment(t,dialect,worker,browser,seedExisting=false){
 const dir=await mkdtemp(join(tmpdir(),'shopping-media-tools-browser-'));await chmod(dir,0o700);
 let store,server,context,admin,databaseName;
 t.after(async()=>{await context?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await store?.close();if(admin){await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);await admin.end();}await rm(dir,{recursive:true,force:true});});
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem'),epochFile=join(dir,'epoch');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 await writeFile(epochFile,secret(),{mode:0o600});await mkdir(join(dir,'db'),{mode:0o700});
 const dbPath=join(dir,'db','shop.sqlite');let databaseUrl;
 if(dialect==='sqlite')store=await openDatabase(dbPath);
 else{
  const base=process.env.SHOP_TEST_DATABASE_URL;assert.equal(process.env.NODE_ENV,'test');assert.match(new URL(base).pathname,/test/i);
  admin=new pg.Pool({connectionString:base});databaseName='shopping_test_media_browser_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${databaseName}`);
  const url=new URL(base);url.pathname='/'+databaseName;databaseUrl=url.href;store=await openPostgresDatabase(databaseUrl);
 }
 let api;
 server=createServer({key:await readFile(key),cert:await readFile(cert)},async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const result=await api(new Request(`https://127.0.0.1:${server.address().port}${request.url}`,{method:request.method,headers:request.headers,
   ...(!['GET','HEAD'].includes(request.method)?{body:Buffer.concat(chunks)}:{})}),{clientAddress:'synthetic-native-media-browser'});
  response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`https://127.0.0.1:${server.address().port}`;
 const config=readConfig({NODE_ENV:'test',ADMIN_USERNAME:'synthetic_owner',ADMIN_PASSWORD:reviewPassword,DB_PATH:dbPath,...(databaseUrl?{DATABASE_URL:databaseUrl}:{}),
  SELLER_ORIGIN:origin,PUBLIC_ORIGIN:origin,SHOP_MODE:'manual',SELLER_QUICK_LOGIN:'0',MCP_ENABLED:'1',MCP_V2_ENABLED:'1',MCP_V2_EPOCH_FILE:epochFile,
  MCP_REDIRECT_URIS:'https://client.example.com/catalog-callback',MCP_V2_MEDIA_ENABLED:'1',MCP_V2_MEDIA_SOCKET_PATH:worker.socketPath,
  MCP_V2_MEDIA_TOKEN_FILE:worker.tokenFile,MCP_V2_MEDIA_CODEC_IDENTITY:worker.image});
 assert.equal(config.mcpMedia.enabled,true);assert.equal(Object.hasOwn(config.mcpMedia,'token'),false);
 await ensureAdmin(store,config.username,config.password);await setupShop(store,{mode:'production',shopName:'Synthetic native media shop'});
 await createCategory(store,{code:'SYNTHETIC',label:'Synthetic media category'});
 const product=seedExisting?await createProduct(store,{sku:'SYNTHETIC-MEDIA',name:'<script>window.__mediaInjected=true</script> Synthetic media',description:'Synthetic existing media fixture',
  category:'SYNTHETIC',priceMinor:1200,stockQuantity:7,active:true,imageDataUrl:'data:image/png;base64,'+syntheticMediaPng(9).toString('base64')}):null;
 const binding={tenantId:'default',issuer:origin,resource:origin+'/mcp'},registry=singleTenantRegistry({store,config});
 // Acceptance must exercise the actual built-in constructor. No operationTools
 // injection, native adapter override, session/grant/evidence fixture or fake fence.
 api=await createApi({store,config,registry,serveStatic});
 context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:900}});
 const call=async(path,method='GET',body,headers={})=>{
  const response=await context.request.fetch(origin+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},
   ...(body===undefined?{}:{data:typeof body==='string'?body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return{response:{status:response.status(),headers:new Headers(response.headers())},data};
 };
 return{store,config,binding,registry,origin,product,context,call};
}
async function reviewInBrowser(f,page,operation){
 await page.goto(operation.reviewUrl);await page.locator('#media-review').waitFor({state:'visible'});
 const assets=(await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',operation.operationId)).n;
 assert.equal(await page.locator('#media-ack').isChecked(),false);
 for(let index=1;index<=assets;index++){
  await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);
  const image=await page.locator('#media-image').evaluate(element=>({width:element.naturalWidth,height:element.naturalHeight,complete:element.complete,src:element.currentSrc}));
  assert.ok(image.complete&&image.width>0&&image.height>0);assert.match(image.src,/^blob:/);
  await page.locator('#media-image-ack').click();
  await page.waitForFunction(expected=>document.querySelector('#media-progress').textContent.startsWith(expected+' of '),index);
 }
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET' AND ack_at IS NOT NULL",operation.operationId)).n,assets);
 await page.locator('#password').fill(reviewPassword);await page.locator('#approve').click();
 assert.match(await page.locator('#status').textContent(),/check the image acknowledgment/);
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.operationId)).state,'PENDING_APPROVAL');
 await page.locator('#media-ack').check();
 const approvalResponse=page.waitForResponse(response=>response.request().method()==='POST'&&
  response.url()===f.origin+'/api/v1/seller/mcp/operations/'+operation.operationId+'/approval');
 await page.locator('#approve').click();
 const approval=await approvalResponse;assert.equal(approval.status(),200,'Seller approval HTTP status');
 await page.locator('#decision').waitFor({state:'hidden'});
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.operationId)).state,'APPROVED');
 assert.equal(await page.locator('#password').inputValue(),'');
 assert.equal(await page.evaluate(()=>window.__mediaInjected),undefined);
}
async function upload(client,productId,bytes,mime,slot,key){
 const listing=dto(await client.call('media.list',{productId}));assert.ok(listing?.revision);
 const begun=await client.call('media.prepare_upload',{input:{action:'begin',productId,targetSlot:slot,expectedRevision:listing.revision,
  sourceSha256:hash(bytes),sourceMime:mime,declaredBytes:bytes.length,idempotencyKey:key+'-begin'}});
 assert.equal(begun.response.status,200,JSON.stringify(begun.data));const stage=dto(begun).stage;
 for(let offset=0;offset<bytes.length;offset+=36864){
  const chunk=bytes.subarray(offset,offset+36864),dataParts=Array.from({length:Math.ceil(chunk.length/3072)},(_,n)=>chunk.subarray(n*3072,(n+1)*3072).toString('base64'));
  const append=await client.call('media.prepare_upload',{input:{action:'append',stageId:stage.stageId,offset,dataParts}});assert.equal(append.response.status,200,JSON.stringify(append.data));
 }
 const sealed=await client.call('media.prepare_upload',{input:{action:'seal',stageId:stage.stageId,idempotencyKey:key+'-seal'}});
 assert.equal(sealed.response.status,200,JSON.stringify(sealed.data));return{stage,operation:dto(sealed).operation};
}
async function reviewMetadata(f,page,operation){
 await page.goto(operation.reviewUrl);await page.locator('#review').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.__mediaInjected),undefined);
 await page.locator('#password').fill(reviewPassword);await page.locator('#approve').click();await page.locator('#decision').waitFor({state:'hidden'});
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.operationId)).state,'APPROVED');
 assert.equal(await page.locator('#password').inputValue(),'');
}
async function authorized(f){
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n,0);
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n,0);
 const scopes=legacyCatalogScopes+' company.read company.write catalog.write analytics.extended inventory.read inventory.adjust media.read media.write';
 const client=await freshCatalogAccess(f,scopes,f.call),tools=await client.rpc('tools/list',{});
 assert.deepEqual(tools.data.result.tools.map(tool=>tool.name),[...catalogue.map(tool=>tool.name),
  'company.get','company.preview_update','company.commit_update','catalog.preview_create','catalog.commit_create','catalog.preview_update','catalog.commit_update',
  'analytics.sales_trend','analytics.top_products','analytics.inventory_risk','inventory.summary','inventory.movements','inventory.preview_adjustment','inventory.commit_adjustment',
  'media.list','media.prepare_upload','media.commit_upload','media.upload_file','media.preview_layout','media.commit_layout']);
 assert.equal(tools.data.result.tools.length,28);assert.deepEqual(tools.data.result.tools.slice(0,8),catalogue.map(({scope:_scope,...tool})=>tool));
 const errors=[],external=[];await f.context.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():(external.push(route.request().url()),route.abort()));
 const page=await f.context.newPage();page.on('pageerror',error=>errors.push(error.message));return{client,page,errors,external};
}
async function legacyEight(f){
 const old=await freshCatalogAccess(f,legacyCatalogScopes,f.call),tools=await old.rpc('tools/list',{});
 assert.deepEqual(tools.data.result.tools,catalogue.map(({scope:_scope,...tool})=>tool));
 assert.equal((await old.call('media.list',{productId:f.product.id})).response.status,403);
}
test('actual native worker and fresh OAuth MCP Chromium flow A creates/uploads/publishes and independent flow B restores gallery layouts',
 {skip:!enabled,timeout:180000},async t=>{
  assert.ok(process.env.SHOP_TEST_DATABASE_URL,'Both databases required for native browser acceptance.');
  const imageId=(await readFile(new URL('../.local/media-codec-image-id',import.meta.url),'utf8')).trim();
  const worker=await startContainer(imageId);t.after(worker.stop);
  const {chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  for(const dialect of ['sqlite','postgres']){
   await t.test(dialect+':A real MCP create -> native upload -> real MCP publish',async child=>{
    const f=await environment(child,dialect,worker,browser),{client,page,errors,external}=await authorized(f);
    const created=await client.call('catalog.preview_create',{input:{sku:'SYNTHETIC-MEDIA',name:'<script>window.__mediaInjected=true</script> Synthetic media',
     description:'Synthetic actual MCP catalog create',category:'SYNTHETIC',priceMinor:1200,stockQuantity:7,active:false},idempotencyKey:'actual-media-catalog-create'});
    assert.equal(created.response.status,200,JSON.stringify(created.data));await reviewMetadata(f,page,dto(created));
    const createDone=await client.call('catalog.commit_create',{operationId:dto(created).operationId});assert.equal(dto(createDone).status,'COMMITTED');
    f.product={id:dto(createDone).result.productId};
    const initial=await upload(client,f.product.id,syntheticMediaPng(9),'image/png','MAIN','actual-native-first');
    assert.equal((await client.call('media.commit_upload',{operationId:initial.operation.operationId})).response.status,403);
    await reviewInBrowser(f,page,initial.operation);
    const committed=await client.call('media.commit_upload',{operationId:initial.operation.operationId});assert.equal(dto(committed).status,'COMMITTED');
    const firstSha=hash((await f.store.get('SELECT image_data FROM product WHERE id=?',f.product.id)).image_data);
    assert.equal((await f.store.get('SELECT active FROM product WHERE id=?',f.product.id)).active,0);
    assert.equal((await f.call('/api/v1/products/'+f.product.id)).response.status,404);
    const publish=await client.call('catalog.preview_update',{input:{id:f.product.id,changes:{active:true}},idempotencyKey:'actual-media-catalog-publish'});
    assert.equal(publish.response.status,200,JSON.stringify(publish.data));await reviewMetadata(f,page,dto(publish));
    assert.equal(dto(await client.call('catalog.commit_update',{operationId:dto(publish).operationId})).status,'COMMITTED');
    assert.equal(dto(await client.call('media.commit_upload',{operationId:initial.operation.operationId})).replayed,true);
    const product=await f.call('/api/v1/products/'+f.product.id);assert.equal(product.response.status,200);
    const actual=await f.context.request.get(new URL(product.data.imageUrl,f.origin).href);assert.equal(actual.status(),200);assert.equal(hash(await actual.body()),firstSha);
    await page.goto(f.origin+'/shop/');await page.locator('#catalog-grid .product-name-link').filter({hasText:'Synthetic media'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__mediaInjected),undefined);await legacyEight(f);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    child.diagnostic(JSON.stringify({nativeImage:imageId,realOAuth:true,realMcpCreate:true,realMcpPublish:true,browserApprovals:3,syntheticHumanEvidence:false,storefrontSha:firstSha}));
   });
   await t.test(dialect+':B existing image -> native gallery upload -> reorder -> restore',async child=>{
    const f=await environment(child,dialect,worker,browser,true),{client,page,errors,external}=await authorized(f);
    const firstSha=hash((await f.store.get('SELECT image_data FROM product WHERE id=?',f.product.id)).image_data);
    const galleryUpload=await upload(client,f.product.id,syntheticMediaPng(81),'image/png','GALLERY','actual-native-gallery');
    await reviewInBrowser(f,page,galleryUpload.operation);
    assert.equal(dto(await client.call('media.commit_upload',{operationId:galleryUpload.operation.operationId})).status,'COMMITTED');
    const current=dto(await client.call('media.list',{productId:f.product.id})),original=current.items[0].gallery.map(({id})=>({id}));
    assert.equal(original.length,2);const reversed=[...original].reverse();
    const reorder=await client.call('media.preview_layout',{input:{productId:f.product.id,expectedRevision:current.revision,gallery:reversed,removeMain:false},idempotencyKey:'actual-native-reorder'});
    assert.equal(reorder.response.status,200,JSON.stringify(reorder.data));await reviewInBrowser(f,page,dto(reorder));
    assert.equal(dto(await client.call('media.commit_layout',{operationId:dto(reorder).operationId})).status,'COMMITTED');
    let product=await f.call('/api/v1/products/'+f.product.id);assert.equal(product.response.status,200);assert.equal(product.data.galleryItems[0].id,reversed[0].id);
    const after=dto(await client.call('media.list',{productId:f.product.id}));
    const restore=await client.call('media.preview_layout',{input:{productId:f.product.id,expectedRevision:after.revision,gallery:original,removeMain:false},idempotencyKey:'actual-native-restore'});
    assert.equal(restore.response.status,200,JSON.stringify(restore.data));await reviewInBrowser(f,page,dto(restore));
    assert.equal(dto(await client.call('media.commit_layout',{operationId:dto(restore).operationId})).status,'COMMITTED');
    assert.equal(dto(await client.call('media.commit_layout',{operationId:dto(restore).operationId})).replayed,true);
    product=await f.call('/api/v1/products/'+f.product.id);assert.equal(product.response.status,200);assert.deepEqual(product.data.galleryItems.map(item=>item.id),original.map(item=>item.id));
    const actual=await f.context.request.get(new URL(product.data.imageUrl,f.origin).href);assert.equal(actual.status(),200);assert.equal(hash(await actual.body()),firstSha);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',f.product.id)).stock_quantity,7);
    await page.goto(f.origin+'/shop/');await page.locator('#catalog-grid .product-name-link').filter({hasText:'Synthetic media'}).waitFor();
    assert.equal(await page.evaluate(()=>window.__mediaInjected),undefined);await legacyEight(f);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    child.diagnostic(JSON.stringify({nativeImage:imageId,realOAuth:true,realMcpGalleryCommit:true,browserApprovals:3,syntheticHumanEvidence:false,restoredMainSha:firstSha}));
   });
   // Each format has its own fresh store/account fixture. Two approvals remain
   // within the real per-address budget; no limiter reset or alternate IP is used.
   for(const mime of ['image/jpeg','image/png','image/webp'])await t.test(dialect+':C '+mime+' synthetic file transport with real OAuth, native codec and browser MAIN/GALLERY approval',async child=>{
    const f=await environment(child,dialect,worker,browser,true),{client,page,errors,external}=await authorized(f);
    const identity=await f.registry.resolve(new Request(f.origin)),tenantGuard=f.registry.operationGuard(identity);
    const binding={...f.binding,mcpV2:{...f.config.mcpV2}};
    const options={store:f.store,binding,config:f.config,tenantGuard,quickLogin:false};
    const runtime=createMediaRuntime(options);
    let source;
    const registered=createOperationTools({...options,entries:mediaTools(options,runtime),
     downloadFile:async()=>({bytes:source.bytes,mime:source.mime})});
    let approved=0;
    for(const targetSlot of ['MAIN','GALLERY']){
     const encoded=await page.evaluate(({mime,slot})=>{
      const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;
      const context=canvas.getContext('2d');context.fillStyle=slot==='MAIN'?'#cc7b31':'#398ca1';context.fillRect(0,0,96,96);
      context.fillStyle='#e9e2ca';context.fillRect(11,19,43,37);return canvas.toDataURL(mime,0.88);
     },{mime,slot:targetSlot});
     assert.ok(encoded.startsWith('data:'+mime+';base64,'));
     source={bytes:Buffer.from(encoded.split(',')[1],'base64'),mime};
     const before=dto(await client.call('media.list',{productId:f.product.id}));
     const operation=await registered.call('media.upload_file',{productId:f.product.id,targetSlot,expectedRevision:before.revision,
      idempotencyKey:'actual-file-'+mime.replace('/','-')+'-'+targetSlot,
      file:{download_url:'https://files.oaiusercontent.com/synthetic-native-browser-file',file_id:'synthetic-file',mime_type:mime}},client.bearer);
     assert.equal(operation.status,'PENDING_APPROVAL');
     const stage=await f.store.get('SELECT source_sha256,canonical_sha256 FROM mcp_v2_media_stage WHERE operation_id=?',operation.operationId);
     assert.equal(stage.source_sha256,hash(source.bytes));assert.match(stage.canonical_sha256,/^[a-f0-9]{64}$/);
     assert.equal((await client.call('media.commit_upload',{operationId:operation.operationId})).response.status,403);
     await reviewInBrowser(f,page,operation);approved++;
     assert.equal(dto(await client.call('media.commit_upload',{operationId:operation.operationId})).status,'COMMITTED');
     const after=dto(await client.call('media.list',{productId:f.product.id}));
     assert.notEqual(after.revision,before.revision);
     const persisted=after.assets.find(asset=>asset.sha256===stage.canonical_sha256);assert.ok(persisted);
     if(targetSlot==='MAIN')assert.equal(after.items[0].mainAssetKey,persisted.assetKey);
     else{
      assert.equal(after.items[0].mainAssetKey,before.items[0].mainAssetKey);
      assert.equal(after.items[0].gallery.length,before.items[0].gallery.length+1);
      assert.ok(after.items[0].gallery.some(image=>image.assetKey===persisted.assetKey));
     }
    }
    assert.equal(approved,2);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    child.diagnostic(JSON.stringify({nativeImage:imageId,realOAuth:true,realNativeFormats:[mime],
     browserApprovals:approved,slots:['MAIN','GALLERY'],syntheticFileTransport:true,syntheticHumanEvidence:false,externalChatGptDownload:false}));
   });
  }
 });
