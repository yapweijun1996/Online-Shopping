import test from 'node:test';
import assert from 'node:assert/strict';
import {productionProxyFixture} from './helpers/mcp-production-proxy-fixture.js';
const enabled=process.env.MCP_PRODUCTION_PROXY_TEST==='1';
function assertSecurityHeaders(response){
 for(const[name,value]of [['x-content-type-options','nosniff'],['strict-transport-security','max-age=31536000']]){
  assert.equal(response.headerCounts[name],1,name+' must have one effective policy');
  assert.equal(response.headers[name],value);
 }
}
test('real Node adapter through GCP Caddy and verified local TLS preserves origin/private review policy',{skip:!enabled,timeout:90000},async t=>{
 const f=await productionProxyFixture(t),id='11111111-1111-1111-1111-111111111111';
 for(const[host,landing]of [['shop.qa.test','/shop'],['seller.qa.test','/seller']]){
  const redirect=await f.request(landing,{host});assert.equal(redirect.status,302);assertSecurityHeaders(redirect);
  const ready=await f.request('/ready',{host});assert.equal(ready.status,200);
  t.diagnostic(JSON.stringify({host,path:'/ready',nosniffCount:ready.headerCounts['x-content-type-options'],hstsCount:ready.headerCounts['strict-transport-security']}));
  assertSecurityHeaders(ready);
 }
 for(const prefix of ['', '/alpha']){
  const api=prefix+'/api/v1/seller/mcp/operations/'+id;
  for(const[path,method]of [[prefix+'/oauth/operation?operationId='+id,'GET'],[prefix+'/oauth/operation-review.js','GET'],[prefix+'/oauth/operation-review.css','GET'],[api,'GET'],[api+'/approval','POST'],[api+'/media/delivery','POST'],[api+'/media/ack','POST']]){
   const body=method==='POST'?'{"synthetic":"transport metadata only"}':undefined;
   const r=await f.request(path,{method,body,headers:{'x-forwarded-proto':'http','forwarded':'host=attacker.invalid;proto=http','x-real-ip':'198.51.100.5'}});
   assert.equal(r.status,200,r.body);const value=JSON.parse(r.body);assert.equal(value.url,f.origin+path);assert.equal(value.method,method);assert.equal(value.body,body??'');assert.notEqual(value.ip,'198.51.100.5');
   assertSecurityHeaders(r);
   for(const name of ['cache-control','referrer-policy','x-frame-options','content-security-policy'])assert.equal(r.headerCounts[name],1,name+' must have one effective policy');
   assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');assert.equal(r.headers['x-frame-options'],'DENY');
   assert.match(r.headers['content-security-policy'],/img-src 'self' blob:/);assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);assert.doesNotMatch(r.headers['content-security-policy'],/unsafe-inline|unsafe-eval/);
   assert.equal((await f.request(path,{host:'shop.qa.test',method,body})).status,404);
  }
 }
 for(const path of ['/oauth/unknown','/alpha/oauth/unknown','/alpha/mcp/extra','/mcp/extra','/%61lpha/mcp','//alpha/mcp','/alpha/\\oauth/operation'])assert.equal((await f.request(path)).status,404,path);
 const wrong=await f.request('/ready',{headers:{host:'wrong.qa.test','x-forwarded-proto':'https'}});assert.equal(wrong.status,404,wrong.body);
 assert.match((await f.internalReady()).url,/^http:\/\/127\.0\.0\.1:3000\/ready$/);
 const legacy=await f.request('/.well-known/oauth-authorization-server');assert.equal(legacy.status,200);assert.equal(legacy.headers['cache-control'],'no-store');assertSecurityHeaders(legacy);
});
