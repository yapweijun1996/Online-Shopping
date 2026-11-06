import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,cp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
const exec=promisify(execFile);
const caddy='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
const node='node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const label='shopping.mcp-production-transport';
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('DOCKER_'))delete env[key];
const docker=(args)=>exec('docker',['--host=unix:///var/run/docker.sock',...args],{env,timeout:60000,maxBuffer:512*1024});

// Transport fixture only: the backend uses the REAL Node toFetchRequest adapter
// and emits bounded synthetic metadata. This fixture grants no human authority
// and is not a claim of full OAuth/native production-profile acceptance.
export async function productionProxyFixture(t){
 const token=randomBytes(8).toString('hex'),tag='mcp-production-edge-'+token,folder=await mkdtemp(join(tmpdir(),tag+'-'));
 const names=[tag+'-node',tag+'-frontend',tag+'-tls'];
 t.after(async()=>{
  for(const name of names){
   const result=await docker(['ps','-aq','--filter','name=^/'+name+'$','--filter','label='+label+'='+token]).catch(()=>null);
   for(const id of result?.stdout.trim().split(/\s+/).filter(Boolean)||[])await docker(['rm','-f',id]);
  }
  await docker(['network','rm',tag+'-edge']).catch(()=>{});await docker(['network','rm',tag+'-private']).catch(()=>{});await rm(folder,{recursive:true,force:true});
 });
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const app=join(folder,'app'),cert=join(folder,'cert.pem'),key=join(folder,'key.pem');await mkdir(app);await mkdir(join(app,'node_modules'));
 await cp(resolve('src'),join(app,'src'),{recursive:true,dereference:true});await mkdir(join(app,'public'));await cp(resolve('public/shared'),join(app,'public/shared'),{recursive:true,dereference:true});await cp(resolve('package.json'),join(app,'package.json'));
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=seller.qa.test','-addext','subjectAltName=DNS:seller.qa.test,DNS:shop.qa.test'],{maxBuffer:8192});
 await writeFile(join(app,'probe.mjs'),`import http from 'node:http';
import {toFetchRequest} from './src/server.js';
const config={production:true,trustProxy:true,publicOrigin:'https://shop.qa.test:${port}',sellerOrigin:'https://seller.qa.test:${port}'};
http.createServer(async(req,res)=>{try{
 const request=toFetchRequest(req,config);const review=/^\\/(?:alpha\\/)?(?:oauth\\/operation|api\\/v1\\/seller\\/mcp\\/operations\\/)/.test(new URL(request.url).pathname);
 res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
 if(review){res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");}
 res.end(JSON.stringify({url:request.url,method:request.method,body:await request.text(),ip:request.headers.get('x-real-ip')}));
 }catch(error){req.resume();res.writeHead(error.status||500,{'cache-control':'no-store'});res.end();}}).listen(3000,'0.0.0.0');
`);
 await writeFile(join(folder,'gateway.Caddyfile'),`{\n admin off\n auto_https off\n}\nhttps://:8443 {\n tls /fixture/cert.pem /fixture/key.pem\n reverse_proxy frontend:80 {\n header_up X-Real-IP {remote_host}\n }\n}\n`);
 await docker(['network','create','--internal',tag+'-private']);await docker(['network','create',tag+'-edge']);
 const common=['--label',label+'='+token,'--restart','no','--read-only','--security-opt','no-new-privileges:true','--log-driver','none'];
 await docker(['run','-d','--pull=never','--name',names[0],...common,'--network',tag+'-private','--network-alias','backend','--user','1000:1000','--memory','192m','--pids-limit','64','--mount','type=bind,src='+app+',dst=/fixture,readonly','--mount','type=bind,src='+await realpath('node_modules')+',dst=/fixture/node_modules,readonly','--workdir','/fixture',node,'node','--max-old-space-size=96','probe.mjs']);
 await docker(['run','-d','--pull=never','--name',names[1],...common,'--network',tag+'-private','--network-alias','frontend','--memory','48m','--pids-limit','64','--tmpfs','/data:size=4m','--tmpfs','/config:size=1m','-e','SHOP_HOST=shop.qa.test','-e','SELLER_HOST=seller.qa.test','--mount','type=bind,src='+resolve('deploy/gcp/Caddyfile')+',dst=/etc/caddy/Caddyfile,readonly','--mount','type=bind,src='+resolve('public')+',dst=/srv/public,readonly',caddy]);
 await docker(['network','connect','--alias','frontend',tag+'-edge',names[1]]);
 await docker(['run','-d','--pull=never','--name',names[2],...common,'--network',tag+'-edge','--memory','48m','--pids-limit','64','--tmpfs','/data:size=4m','--tmpfs','/config:size=1m','-p','127.0.0.1:'+port+':8443','--mount','type=bind,src='+folder+',dst=/fixture,readonly','--mount','type=bind,src='+join(folder,'gateway.Caddyfile')+',dst=/etc/caddy/Caddyfile,readonly',caddy]);
 const request=async(path,{host='seller.qa.test',method='GET',body,headers={}}={})=>{
  const args=['--silent','--show-error','--noproxy','*','--path-as-is','--max-time','10','--cacert',cert,'--resolve',host+':'+port+':127.0.0.1','-X',method,'-D','-'];
  for(const[key,value]of Object.entries(headers))args.push('-H',key+': '+value);
  if(body!==undefined)args.push('--data-binary',body);
  const{stdout}=await exec('curl',[...args,'https://'+host+':'+port+path],{timeout:15000,maxBuffer:256*1024});const split=stdout.indexOf('\r\n\r\n'),head=stdout.slice(0,split).split('\r\n');
  const headerCounts={};for(const line of head.slice(1)){const name=line.slice(0,line.indexOf(':')).toLowerCase();headerCounts[name]=(headerCounts[name]??0)+1;}
  return{status:Number(head[0].split(' ')[1]),headerCounts,headers:Object.fromEntries(head.slice(1).map(line=>{const n=line.indexOf(':');return[line.slice(0,n).toLowerCase(),line.slice(n+1).trim()];})),body:stdout.slice(split+4)};
 };
 let ready=false,last='none';for(let n=0;n<40;n++){try{const response=await request('/health');last='HTTP '+response.status;if(response.status===200){ready=true;break;}}catch(error){last='client '+error.code;}await new Promise(r=>setTimeout(r,100));}
 if(!ready){for(const name of names){const state=await docker(['inspect','--format','{{json .State}}',name]);last+=' '+name+':'+state.stdout;}}
 assert.equal(ready,true,'Owned TLS/Node transport fixture must become ready: '+last);
 return{request,port,origin:'https://seller.qa.test:'+port,async internalReady(){const value=await docker(['exec',names[0],'node','-e',"fetch('http://127.0.0.1:3000/ready').then(async r=>console.log(await r.text()))"]);return JSON.parse(value.stdout);}};
}
