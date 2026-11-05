import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {mkdtemp,readFile,writeFile,mkdir,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {openDatabase} from '../../src/db.js';
import {openPostgresDatabase} from '../../src/postgres-db.js';
import {createApi} from '../../src/app.js';
import {serveStatic} from '../../src/static.js';
import {readConfig} from '../../src/config.js';
import {ensureAdmin} from '../../src/auth.js';
import {setupShop} from '../../src/shop-setup.js';
import {createCategory} from '../../src/settings.js';
import {singleTenantRegistry} from '../../src/tenants.js';
import {secret} from '../../src/mcp/credentials.js';
import {reviewPassword} from './mcp-review-fixture.js';
import {freshCatalogAccess,legacyCatalogScopes} from './mcp-catalog-default-grant.js';

// Actual default createApi + real OAuth/session/HTTPS. No operationTools,
// native decoder, tenant guard, grant, approval or evidence injection.
export async function catalogRuntimeBrowserFixture(t,dialect,worker,browser){
 const dir=await mkdtemp(join(tmpdir(),'shopping-catalog-runtime-'));await chmod(dir,0o700);
 let store,server,context,admin,databaseName,api,config;
 t.after(async()=>{await context?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await store?.close();if(admin){await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);await admin.end();}await rm(dir,{recursive:true,force:true});});
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem'),epochFile=join(dir,'epoch');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 await writeFile(epochFile,secret(),{mode:0o600});await mkdir(join(dir,'db'),{mode:0o700});
 const dbPath=join(dir,'db','shop.sqlite');let databaseUrl;
 if(dialect==='sqlite')store=await openDatabase(dbPath);
 else{const base=process.env.SHOP_TEST_DATABASE_URL;assert.equal(process.env.NODE_ENV,'test');assert.match(new URL(base).pathname,/test/i);
  admin=new pg.Pool({connectionString:base});databaseName='shopping_test_catalog_runtime_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${databaseName}`);
  const url=new URL(base);url.pathname='/'+databaseName;databaseUrl=url.href;store=await openPostgresDatabase(databaseUrl);}
 server=createServer({key:await readFile(key),cert:await readFile(cert)},async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const result=await api(new Request(`https://127.0.0.1:${server.address().port}${request.url}`,{method:request.method,headers:request.headers,
   ...(!['GET','HEAD'].includes(request.method)?{body:Buffer.concat(chunks)}:{})}),{clientAddress:'synthetic-catalog-runtime-browser'});
  response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`https://127.0.0.1:${server.address().port}`;
 config=readConfig({NODE_ENV:'test',ADMIN_USERNAME:'synthetic_owner',ADMIN_PASSWORD:reviewPassword,DB_PATH:dbPath,...(databaseUrl?{DATABASE_URL:databaseUrl}:{}),
  SELLER_ORIGIN:origin,PUBLIC_ORIGIN:origin,SHOP_MODE:'manual',SELLER_QUICK_LOGIN:'0',MCP_ENABLED:'1',MCP_V2_ENABLED:'1',MCP_V2_EPOCH_FILE:epochFile,
  MCP_REDIRECT_URIS:'https://client.example.com/catalog-callback',MCP_V2_MEDIA_ENABLED:'1',MCP_V2_MEDIA_SOCKET_PATH:worker.socketPath,
  MCP_V2_MEDIA_TOKEN_FILE:worker.tokenFile,MCP_V2_MEDIA_CODEC_IDENTITY:worker.image,MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED:'1'});
 assert.equal(config.mcpCatalogMediaUpdate.enabled,true);
 await ensureAdmin(store,config.username,config.password);await setupShop(store,{mode:'production',shopName:'Synthetic catalog runtime shop'});
 await createCategory(store,{code:'SYNTHETIC',label:'Synthetic catalog category'});
 const binding={tenantId:'default',issuer:origin,resource:origin+'/mcp'};
 const configure=async changes=>{config={...config,...changes};api=await createApi({store,config,registry:singleTenantRegistry({store,config}),serveStatic});};
 await configure({});context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:900}});
 const call=async(path,method='GET',body,headers={})=>{
  const response=await context.request.fetch(origin+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},
   ...(body===undefined?{}:{data:typeof body==='string'?body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return{response:{status:response.status(),headers:new Headers(response.headers())},data};
 };
 const authorize=scopes=>freshCatalogAccess({store,config,binding,call},scopes,call);
 return{store,get config(){return config;},binding,origin,context,call,configure,authorize,
  allScopes:legacyCatalogScopes+' catalog.write media.write media.read operations.read operations.cancel'};
}

export async function approveCatalogInBrowser(f,page,operation){
 await page.goto(operation.reviewUrl);await page.locator('#media-review').waitFor({state:'visible'});
 const rows=await f.store.all('SELECT kind,item_key,ack_at FROM mcp_v2_media_delivery WHERE operation_id=?',operation.operationId);
 assert.ok(rows.every(row=>row.ack_at===null||row.kind==='PAGE'));
 const assets=Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?',operation.operationId)).n);
 assert.equal(await page.locator('#media-ack').isChecked(),false);
 for(let n=1;n<=assets;n++){
  await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);
  assert.ok((await page.locator('#media-image').evaluate(node=>node.naturalWidth))>0);await page.locator('#media-image-ack').click();
  await page.waitForFunction(expected=>document.querySelector('#media-progress').textContent.startsWith(expected+' of '),n);
 }
 await page.waitForFunction(()=>!document.querySelector('#approve').disabled);
 assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_media_delivery WHERE operation_id=? AND ack_at IS NULL",operation.operationId)).n,0);
 await page.locator('#password').fill(reviewPassword);await page.locator('#approve').click();
 assert.match(await page.locator('#status').textContent(),/check the image acknowledgment/);
 await page.locator('#media-ack').check();await page.locator('#approve').click();await page.locator('#decision').waitFor({state:'hidden'});
 assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.operationId)).state,'APPROVED');
 assert.equal(await page.locator('#password').inputValue(),'');
}
