import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readConfig} from '../src/config.js';
import {createApp} from '../src/server.js';
function get(port,path){return new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port,path},res=>{const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts))}));}).on('error',reject);});}
// Actual Node app with valid development independent flags. Production epoch
// policy itself is tested by the shared reader's production-profile fixtures.
test('actual Node readiness becomes unavailable after atomic external epoch replacement',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'mcp-ready-epoch-'));await mkdir(join(folder,'db'));const epoch=join(folder,'epoch');await writeFile(epoch,Buffer.alloc(32,7).toString('base64url'),{mode:0o600});
 let app;t.after(async()=>{if(app)await app.close();await rm(folder,{recursive:true,force:true});});
 const config=readConfig({NODE_ENV:'test',ADMIN_USERNAME:'synthetic_owner',ADMIN_PASSWORD:'Q7z!rK8mP4vN2tL6',DB_PATH:join(folder,'db','synthetic.db'),PUBLIC_ORIGIN:'https://shop.example.test',SELLER_ORIGIN:'https://seller.example.test',SHOP_MODE:'manual',SELLER_QUICK_LOGIN:'0',MCP_ENABLED:'1',MCP_REDIRECT_URIS:'https://client.example.com/callback',MCP_V2_ENABLED:'1',MCP_V2_EPOCH_FILE:epoch,APP_REVISION:'a'.repeat(40)});
 app=await createApp(config);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const port=app.server.address().port;
 assert.deepEqual(await get(port,'/ready'),{status:200,body:{status:'ready',revision:'a'.repeat(40)}});
 const replacement=join(folder,'replacement');await writeFile(replacement,Buffer.alloc(32,8).toString('base64url'),{mode:0o600});await rename(replacement,epoch);
 assert.deepEqual(await get(port,'/ready'),{status:503,body:{status:'unavailable',revision:'a'.repeat(40)}});
 assert.equal((await get(port,'/health')).status,200);
 assert.equal(config.mcpV2.epoch,Buffer.alloc(32,7).toString('base64url'),'A stale process never adopts the new epoch.');
 await rm(epoch);assert.equal((await get(port,'/ready')).status,503);
});
