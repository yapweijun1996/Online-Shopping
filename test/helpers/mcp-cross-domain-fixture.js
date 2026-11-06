import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {mkdtemp,readFile,writeFile,mkdir,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {openDatabase} from '../../src/db.js';
import {openPostgresDatabase} from '../../src/postgres-db.js';
import {createApi} from '../../src/app.js';
import {createApp} from '../../src/server.js';
import {operationBuildDigest} from '../../src/mcp/operation-runtime.js';
import {operationEpochCurrent} from '../../src/mcp/operation-epoch.js';
import {crossDomainProductionProxy,SYNTHETIC_BACKEND_IDENTITY} from './mcp-cross-domain-production-proxy.js';
import {serveStatic} from '../../src/static.js';
import {readConfig} from '../../src/config.js';
import {ensureAdmin} from '../../src/auth.js';
import {setupShop} from '../../src/shop-setup.js';
import {createCategory} from '../../src/settings.js';
import {singleTenantRegistry} from '../../src/tenants.js';
import {secret,V2_SCOPES} from '../../src/mcp/credentials.js';
import {reviewPassword} from './mcp-review-fixture.js';
import {freshCatalogAccess,legacyCatalogScopes} from './mcp-catalog-default-grant.js';

// Cross-domain actual default createApi/readConfig with both catalog profiles.
// No operationTools,
// native decoder, tenant guard, grant, approval or evidence injection.
export async function crossDomainBrowserFixture(t,dialect,worker,browser,{productionProxy=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'shopping-cross-domain-'));await chmod(dir,0o700);
 let store,server,context,admin,databaseName,api,config,app,proxy,ownedBrowser,closed=false;
 const dispose=async()=>{if(closed)return;closed=true;
  try{try{await context?.close();}finally{await ownedBrowser?.close();}}finally{try{if(server)server.closeAllConnections();if(app)await app.close();else if(server)await new Promise(resolve=>server.close(resolve));}
   finally{try{await proxy?.stop();}finally{try{if(!app)await store?.close();}finally{if(admin){await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);await admin.end();}await rm(dir,{recursive:true,force:true});}}}}
 };
 t.after(dispose);
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem'),epochFile=join(dir,'epoch');
 if(!productionProxy)execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 await writeFile(epochFile,secret(),{mode:0o600});await mkdir(join(dir,'db'),{mode:0o700});
 const dbPath=join(dir,'db','shop.sqlite');let databaseUrl;
 if(dialect==='sqlite'){if(!productionProxy)store=await openDatabase(dbPath);}
 else{const base=process.env.SHOP_TEST_DATABASE_URL;assert.equal(process.env.NODE_ENV,'test');assert.match(new URL(base).pathname,/test/i);
  admin=new pg.Pool({connectionString:base});databaseName='shopping_test_cross_domain_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${databaseName}`);
  const url=new URL(base);url.pathname='/'+databaseName;databaseUrl=url.href;if(!productionProxy)store=await openPostgresDatabase(databaseUrl);}
 if(!productionProxy){server=createServer({key:await readFile(key),cert:await readFile(cert)},async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const result=await api(new Request(`https://127.0.0.1:${server.address().port}${request.url}`,{method:request.method,headers:request.headers,
   ...(!['GET','HEAD'].includes(request.method)?{body:Buffer.concat(chunks)}:{})}),{clientAddress:'synthetic-catalog-runtime-browser'});
  response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
 if(productionProxy)proxy=await crossDomainProductionProxy(t);
 const origin=proxy?.origin??`https://127.0.0.1:${server.address().port}`,shopOrigin=proxy?.shopOrigin??origin;
 const password=productionProxy?'T7!pQ9xV4mK2rD8zL6nF1cH5jB3sA0wE':reviewPassword;
 config=readConfig({NODE_ENV:productionProxy?'production':'test',ADMIN_USERNAME:'synthetic_owner',ADMIN_PASSWORD:password,
  ...(productionProxy?{TRUST_PROXY:'1',MCP_V2_PRODUCTION_PROFILE:'seller-operations-v1',MCP_V2_BACKEND_IDENTITY:SYNTHETIC_BACKEND_IDENTITY}:{}),DB_PATH:dbPath,...(databaseUrl?{DATABASE_URL:databaseUrl}:{}),
  SELLER_ORIGIN:origin,PUBLIC_ORIGIN:shopOrigin,SHOP_MODE:'manual',SELLER_QUICK_LOGIN:'0',MCP_ENABLED:'1',MCP_V2_ENABLED:'1',MCP_V2_EPOCH_FILE:epochFile,
  MCP_REDIRECT_URIS:'https://client.example.com/catalog-callback',MCP_V2_MEDIA_ENABLED:'1',MCP_V2_MEDIA_SOCKET_PATH:worker.socketPath,
  MCP_V2_MEDIA_TOKEN_FILE:worker.tokenFile,MCP_V2_MEDIA_CODEC_IDENTITY:worker.image,MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED:'1',MCP_V2_CATALOG_MEDIA_CREATE_ENABLED:'1'});
 assert.equal(config.mcpCatalogMediaCreate.enabled,true);assert.equal(config.mcpCatalogMediaUpdate.enabled,true);
 if(productionProxy){
  assert.equal(config.production,true);assert.equal(config.trustProxy,true);assert.equal(config.mcpV2.profile.kind,'production');
  assert.equal(config.mcpV2.profile.backendIdentity,SYNTHETIC_BACKEND_IDENTITY);assert.equal(config.mcpV2.epochFile,epochFile);assert.equal(operationEpochCurrent(config.mcpV2),true);
  assert.equal(config.mcpV2.buildDigest,createHash('sha256').update(JSON.stringify({domain:'mcp-v2/production-build/v1',backendIdentity:SYNTHETIC_BACKEND_IDENTITY,sourceDigest:operationBuildDigest()})).digest('hex'));
  assert.equal(config.ai.enabled,false);assert.equal(config.whatsappQr.enabled,false);assert.equal(config.integrationKeys,null);
  app=await createApp(config);store=app.database;server=app.server;
  await new Promise(resolve=>server.listen(proxy.socketPath,resolve));await chmod(proxy.socketPath,0o660);
 }
 await ensureAdmin(store,config.username,config.password);await setupShop(store,{mode:'production',shopName:'Synthetic catalog runtime shop'});
 await createCategory(store,{code:'SYNTHETIC',label:'Synthetic catalog category'});
 const binding={tenantId:'default',issuer:origin,resource:origin+'/mcp'};
 const configure=async changes=>{
  if(productionProxy){assert.deepEqual(changes,{});return;}
  config={...config,...changes};api=await createApi({store,config,registry:singleTenantRegistry({store,config}),serveStatic});
 };
 await configure({});if(proxy)await proxy.start();
 // Finish Docker topology changes before Chromium starts observing networking.
 // Close this browser before removing the proxy networks in dispose().
 if(productionProxy)ownedBrowser=await browser.launch({headless:true});
 context=await (ownedBrowser??browser).newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:900}});
 const call=async(path,method='GET',body,headers={})=>{
  const requestOrigin=productionProxy&&/^(?:\/shop(?:\/|$)|\/api\/v1\/(?:shop|products|orders)(?:\/|$))/.test(path)?shopOrigin:origin;
  const response=await context.request.fetch(requestOrigin+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},
   ...(body===undefined?{}:{data:typeof body==='string'?body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return{response:{status:response.status(),headers:new Headers(response.headers())},data};
 };
 const authorize=scopes=>freshCatalogAccess({store,config,binding,call},scopes,call,{username:config.username,password});
 return{store,get config(){return config;},binding,origin,shopOrigin,password,context,call,configure,authorize,diagnostic:message=>t.diagnostic(message),...(productionProxy?{close:dispose}:{}),
  allScopes:legacyCatalogScopes+' '+V2_SCOPES.join(' ')};
}
