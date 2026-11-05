import { coordinatorFixture, stubDecode } from './mcp-media-coordinator-fixture.js';
import { createApi } from '../../src/app.js';
import { createMediaNativeSession } from '../../src/mcp/media-native.js';
import { mediaListTool, mediaUploadTool, mediaLayoutTool } from '../../src/mcp/media-tools.js';
import { mediaHash } from '../../src/mcp/media-storage.js';
import { reviewPassword } from './mcp-review-fixture.js';
import assert from 'node:assert/strict';

// Actual HTTP/auth/store with explicitly synthetic decoder and seeded consent.
// Full acceptance separately requires actual OAuth/browser/native worker.
export async function mediaToolsFixture(t, dialect, options = {}) {
  const f = await coordinatorFixture(t,dialect), grant = await f.store.get('SELECT created_at FROM oauth_grant WHERE id=?',f.grantId);
  const scopes = 'catalog.read orders.read analytics.read catalog.write media.read media.write';
  await f.store.run('UPDATE oauth_grant SET scopes=? WHERE id=?',scopes,f.grantId);
  await f.store.run('UPDATE oauth_token SET scopes=? WHERE grant_id=?',scopes,f.grantId);
  await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at)
    VALUES(?,?,?,?,'media.read',?,?,?)`,f.grantId,f.binding.tenantId,f.account.id,f.clientId,f.account.oauth_auth_version,f.epochHash,grant.created_at);
  const runtime = { coordinator:f.coordinator,codecDigest:f.options.codec.digest,
    nativeSession:settings=>createMediaNativeSession(f.options.codec,{...settings,decode:stubDecode}) };
  const entries = [mediaListTool(),mediaUploadTool(runtime),mediaLayoutTool(runtime)];
  const config = {...f.config,mcpMedia:{enabled:true},...options.config};
  const api = await createApi({store:f.store,config,operationTools:Object.hasOwn(options,'entries')?options.entries:entries});
  let serial=0;
  async function call(path,method='GET',body,headers={},address='synthetic-media-tools-address-'+ ++serial){
    const response=await api(new Request(f.binding.issuer+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},
      ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),{clientAddress:address});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{response,data};
  }
  const rpc=(method,params,address)=>call('/mcp','POST',{jsonrpc:'2.0',id:++serial,method,params},{authorization:'Bearer '+f.bearer,
    accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},address);
  const tool=(name,args,address)=>rpc('tools/call',{name,arguments:args},address);
  async function approve(operation){
    const path='/api/v1/seller/mcp/operations/'+operation.operationId;
    const reviewed=await call(path,'GET',undefined,f.headers);assert.equal(reviewed.response.status,200,JSON.stringify(reviewed.data));
    const value=reviewed.data;
    for(const item of value.mediaReview.items){
      const fields={operationId:operation.operationId,previewHash:operation.previewHash,challenge:value.challenge,kind:item.kind,itemKey:item.itemKey};
      const delivered=await api(new Request(f.binding.issuer+path+'/media/delivery',{method:'POST',headers:{'content-type':'application/json',...f.headers},body:JSON.stringify(fields)}),{clientAddress:'synthetic-http-review'});
      assert.equal(delivered.status,200);assert.equal(mediaHash(Buffer.from(await delivered.arrayBuffer())),item.hash);
      const ack=await call(path+'/media/ack','POST',{...fields,expectedHash:item.hash,nonce:delivered.headers.get('x-media-nonce')},f.headers);
      assert.equal(ack.response.status,200,JSON.stringify(ack.data));
    }
    const approved=await call(path+'/approval','POST',{operationId:operation.operationId,previewHash:operation.previewHash,challenge:value.challenge,
      decision:'approve',password:reviewPassword,mediaReviewed:true},f.headers);
    assert.equal(approved.response.status,200,JSON.stringify(approved.data));return value;
  }
  return{...f,config,api,call,rpc,tool,entries,runtime,approve};
}
