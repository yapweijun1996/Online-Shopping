import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {externalRequestUrl} from '../src/request-origin.js';
import {toFetchRequest,createApp} from '../src/server.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const config={production:true,trustProxy:true,publicOrigin:'https://shop.example.test',sellerOrigin:'https://seller.example.test',platform:{adminHost:'admin.example.test'}};
const incoming=(url='/',host='seller.example.test',extra={})=>({url,method:'GET',headers:{host},rawHeaders:['Host',host],socket:{remoteAddress:'127.0.0.1'},...extra});
test('trusted production maps only configured host bindings to canonical HTTPS',()=>{
 for(const [host,origin]of [['shop.example.test',config.publicOrigin],['SELLER.EXAMPLE.TEST',config.sellerOrigin],['seller.example.test:443',config.sellerOrigin],['admin.example.test','https://admin.example.test']]){
  const req=incoming('/alpha/oauth/operation?operationId=x',host);req.headers['x-forwarded-proto']='http';req.headers.forwarded='host=attacker.test;proto=http';
  assert.equal(externalRequestUrl(req,config).href,origin+'/alpha/oauth/operation?operationId=x');
 }
});
test('unknown/malformed/duplicate hosts cannot choose an authenticated origin',()=>{
 for(const host of ['attacker.test','seller.example.test:8443','seller.example.test.','user@seller.example.test','%73eller.example.test','seller.example.test/path','seller.example.test,shop.example.test','localhost:3000']){
  assert.throws(()=>externalRequestUrl(incoming('/api/v1/seller/session',host),config),{status:404});
 }
 assert.throws(()=>externalRequestUrl(incoming('/', 'seller.example.test',{rawHeaders:['Host','seller.example.test','Host','shop.example.test']}),config),{status:404});
});
test('only local exact GET health probes retain private HTTP origin',()=>{
 for(const host of ['127.0.0.1:3000','localhost:3000','[::1]:3000'])for(const path of ['/ready','/health'])assert.equal(externalRequestUrl(incoming(path,host),config).protocol,'http:');
 for(const extra of [{method:'POST'},{socket:{remoteAddress:'192.0.2.1'}},{socket:{remoteAddress:'::ffff:192.0.2.1'}}])assert.throws(()=>externalRequestUrl(incoming('/ready','localhost:3000',extra),config),{status:404});
 for(const path of ['/ready?x=1','/api/v1/seller/session','/alpha/ready'])assert.throws(()=>externalRequestUrl(incoming(path,'localhost:3000'),config),{status:404});
 assert.equal(externalRequestUrl(incoming('/ready','localhost:3000',{socket:{remoteAddress:'::ffff:127.0.0.1'}}),config).protocol,'http:');
});
test('raw target normalization cannot switch tenant or external origin',()=>{
 for(const target of ['https://seller.example.test/mcp','//seller.example.test/mcp','/alpha/../mcp','/alpha/%2e%2e/mcp','/alpha/\\mcp','/mcp#fragment','/mcp\n'])assert.throws(()=>externalRequestUrl(incoming(target),config),{status:404});
});
test('nonproxy/development and private QR retain HTTP without forwarding trust',()=>{
 for(const policy of [{},{production:true,trustProxy:false},{production:false,trustProxy:true}]){
  const request=incoming('/internal/whatsapp-qr','backend:3001');request.headers['x-forwarded-proto']='https';
  assert.equal(externalRequestUrl(request,policy).href,'http://backend:3001/internal/whatsapp-qr');
 }
});
function call(port,path,headers={},method='GET',body){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);});}
test('actual Node adapter preserves method/body/headers while mapping proxy origin',async t=>{
 const server=http.createServer(async(req,res)=>{try{const request=toFetchRequest(req,config);res.setHeader('content-type','application/json');res.end(JSON.stringify({url:request.url,method:request.method,body:await request.text(),origin:request.headers.get('origin')}));}catch(error){res.writeHead(error.status??500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const port=server.address().port;
 const response=await call(port,'/alpha/api/v1/seller/mcp/operations/11111111-1111-1111-1111-111111111111/approval',{host:'seller.example.test',origin:config.sellerOrigin,'content-type':'application/json','x-forwarded-proto':'http'},'POST','{"decision":"reject"}');
 assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{url:config.sellerOrigin+'/alpha/api/v1/seller/mcp/operations/11111111-1111-1111-1111-111111111111/approval',method:'POST',body:'{"decision":"reject"}',origin:config.sellerOrigin});
 assert.equal((await call(port,'/mcp',{host:'wrong.example.test','x-forwarded-proto':'https'})).status,404);
 assert.equal(JSON.parse((await call(port,'/ready',{host:'127.0.0.1:'+port})).body).url,'http://127.0.0.1:'+port+'/ready');
});
test('actual production Node application retains loopback readiness and rejects unknown hosts',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'production-origin-'));let app;t.after(async()=>{if(app)await app.close();await rm(folder,{recursive:true,force:true});});
 app=await createApp({...config,platform:null,dbPath:join(folder,'synthetic.db'),username:'synthetic_owner',password:'Q7z!rK8mP4vN2tL6',shopMode:'manual',sellerQuickLogin:false,appRevision:'a'.repeat(40)});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const port=app.server.address().port;
 const ready=await call(port,'/ready',{host:'127.0.0.1:'+port});assert.equal(ready.status,200);assert.deepEqual(JSON.parse(ready.body),{status:'ready',revision:'a'.repeat(40)});
 assert.equal((await call(port,'/health',{host:'wrong.example.test'})).status,404);
 const login=await call(port,'/api/v1/seller/session',{host:'seller.example.test',origin:config.sellerOrigin,'content-type':'application/json'},'POST',JSON.stringify({username:'synthetic_owner',password:'Q7z!rK8mP4vN2tL6'}));
 assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/; Secure/);assert.match(login.headers['set-cookie'][0],/Path=\/api\/v1\/seller/);
});
