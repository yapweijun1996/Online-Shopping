import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCodecServer} from '../media-codec/src/server.js';
import {probeCodecViaSocket,decodeViaSocket} from '../src/mcp/media-codec-client.js';
import {mediaCodecReady} from '../src/mcp/media-readiness.js';
import {CODEC_READY_TEXT,CODEC_READY_PATH,sha256} from '../src/mcp/media-codec-wire.js';
const token=Buffer.alloc(32,7).toString('base64url');
async function listen(t,server){const folder=await mkdtemp(join(tmpdir(),'codec-ready-')),socketPath=join(folder,'codec.sock');
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});});return socketPath;}
function get(socketPath,headers={},method='GET',path=CODEC_READY_PATH){return new Promise((resolve,reject)=>{const req=http.request({socketPath,path,method,headers:{authorization:'Bearer '+token,...headers}},res=>{const data=[];res.on('data',part=>data.push(part));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(data).toString()}));});req.on('error',reject);req.end();});}
test('authenticated actual UDS readiness does no decode even while a native job is busy',async t=>{
 let decodes=0,started,release;const began=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
 const socketPath=await listen(t,createCodecServer({token,decode:async()=>{decodes++;started();await blocked;throw new Error('Synthetic decoder result intentionally fails.');}}));
 assert.equal(await probeCodecViaSocket({socketPath,token}),true);assert.equal(decodes,0);
 const bytes=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex'),work=decodeViaSocket({socketPath,token,bytes,mime:'image/png'});const rejected=assert.rejects(work);
 try{await began;assert.equal(await probeCodecViaSocket({socketPath,token}),true);assert.equal(decodes,1);}finally{release();await rejected;}
});
test('readiness requires the real bearer and closed no-body headers/method/path',async t=>{
 let decodes=0;const socketPath=await listen(t,createCodecServer({token,decode:()=>{decodes++;throw new Error('No native decode permitted.');}}));
 await assert.rejects(probeCodecViaSocket({socketPath,token:Buffer.alloc(32,9).toString('base64url')}));
 for(const headers of [{'content-length':'0'},{'x-source-sha256':sha256(Buffer.from('x'))},{'content-type':'application/json'}])assert.equal((await get(socketPath,headers)).status,400);
 assert.equal((await get(socketPath,{},'POST')).status,404);assert.equal((await get(socketPath,{},'GET',CODEC_READY_PATH+'?x=1')).status,404);assert.equal(decodes,0);
});
test('readiness client rejects forged/noncanonical/oversized/slow worker responses',async t=>{
 let kind='ok';const socketPath=await listen(t,http.createServer((req,res)=>{
  if(kind==='slow')return;
  const body=kind==='wrong'?CODEC_READY_TEXT.replace('ready','other'):kind==='extra'?CODEC_READY_TEXT+' ':CODEC_READY_TEXT;
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','content-length':kind==='large'?999999:Buffer.byteLength(body)});res.end(body);
 }));
 assert.equal(await probeCodecViaSocket({socketPath,token}),true);
 for(kind of ['wrong','extra','large','slow'])await assert.rejects(probeCodecViaSocket({socketPath,token,timeoutMs:25}));
 for(const timeoutMs of [0,1001,1.5,null])await assert.rejects(probeCodecViaSocket({socketPath,token,timeoutMs}));
});
test('public readiness wrapper fails closed on disabled/unsafe seals without IPC or native import',async t=>{
 let calls=0;const socketPath=await listen(t,http.createServer(()=>{calls++;throw new Error('Unsealed config must not perform IPC.');}));
 assert.equal(await mediaCodecReady({enabled:false,socketPath}),false);assert.equal(await mediaCodecReady({enabled:true,socketPath,tokenFile:'/nonexistent/private-token',codecDigest:'a'.repeat(64)}),false);
 assert.equal(await mediaCodecReady({enabled:true,socketPath},{timeoutMs:1001}),false);assert.equal(calls,0);
});
