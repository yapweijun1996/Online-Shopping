import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,lstat,readFile,writeFile,chmod,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {docker} from '../../media-codec/scripts/dev-container.js';

const exec=promisify(execFile),label='shopping.mcp-cross-domain-production';
const caddy='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
// A SYNTHETIC operator pin for a host-Node fixture, never image attestation.
export const SYNTHETIC_BACKEND_IDENTITY='sha256:'+ 'c'.repeat(64);

// Docker's host veth/bridge IPv6 DAD can finish after HTTP is already ready.
// Observe only our own interfaces; never change host networking or retry an
// interrupted review/approval. Chromium starts after this readiness gate.
async function waitForOwnedNetworkSettlement(t,networks,token){
 const devices=[];
 for(const network of networks){
  const [description]=JSON.parse(await docker(['network','inspect',network]));
  assert.equal(description.Labels[label],token);assert.equal(description.Driver,'bridge');
  const bridge=description.Options['com.docker.network.bridge.name']||'br-'+description.Id.slice(0,12);
  assert.match(bridge,/^[a-zA-Z0-9_.-]+$/);
  devices.push(bridge,...await readdir('/sys/class/net/'+bridge+'/brif'));
 }
 assert.equal(new Set(devices).size,5,'Only two owned bridges and three owned veth interfaces');
 const enabled=await Promise.all(devices.map(async name=>(await readFile('/proc/sys/net/ipv6/conf/'+name+'/disable_ipv6','utf8')).trim()==='0'));
 const started=Date.now();let previous,stable=0,initialTentative,maxTentative=0;
 while(Date.now()-started<10000){
  const interfaces=await Promise.all(devices.map(async name=>JSON.parse((await exec('ip',['-j','address','show','dev',name],{timeout:1000,maxBuffer:16384})).stdout)[0]));
  const tentative=interfaces.reduce((n,device)=>n+device.addr_info.filter(address=>address.tentative||address.dadfailed||address.flags?.some(flag=>['tentative','dadfailed'].includes(flag))).length,0);
  initialTentative??=tentative;maxTentative=Math.max(maxTentative,tentative);
  const ready=tentative===0&&interfaces.every((device,index)=>device.flags.includes('UP')&&device.flags.includes('LOWER_UP')&&
   (!enabled[index]||device.addr_info.some(address=>address.family==='inet6'&&address.scope==='link')));
  const fingerprint=createHash('sha256').update(JSON.stringify(interfaces)).digest('hex');
  stable=ready?(fingerprint===previous?stable+1:1):0;previous=fingerprint;
  if(stable>=2){t.diagnostic(JSON.stringify({ownedNetworkReady:true,ownedInterfaces:devices.length,initialTentative,maxTentative,finalTentative:tentative,stableObservations:stable,waitMs:Date.now()-started,fingerprint}));return;}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.fail('Owned Docker network did not finish address initialization within 10 seconds.');
}

// No API, auth, tenant, decoder or approval injection. The caller runs the actual
// createApp server on a test-owned Unix HTTP socket. Only the real GCP
// Caddyfile upstream literal is substituted; host/path/policy rules stay exact.
// This does not prove GCP backend TCP reachability or an executed backend image.
export async function crossDomainProductionProxy(t){
 const token=randomBytes(8).toString('hex'),tag='mcp-cross-prod-'+token,folder=await mkdtemp(join(tmpdir(),tag+'-'));
 const names=[tag+'-frontend',tag+'-tls'],networks=[tag+'-private',tag+'-edge'];let stopped=false;
 const stop=async()=>{
  if(stopped)return;stopped=true;
  for(const name of names){
   const owner=await docker(['inspect','--format','{{index .Config.Labels "'+label+'"}}',name]).catch(()=>null);
   if(owner===token)await docker(['rm','-f',name]);
  }
  for(const name of [...networks].reverse()){
   const owner=await docker(['network','inspect','--format','{{index .Labels "'+label+'"}}',name]).catch(()=>null);
   if(owner===token)await docker(['network','rm',name]);
  }
  await rm(folder,{recursive:true,force:true});
 };
 t.after(stop);
 try{
  const listeners=[createServer(),createServer()];let port;
  try{
   await new Promise((ok,no)=>{listeners[0].once('error',no);listeners[0].listen(0,'127.0.0.1',ok);});port=listeners[0].address().port;
   await new Promise((ok,no)=>{listeners[1].once('error',no);listeners[1].listen(port,'127.0.0.2',ok);});
  }finally{for(const listener of listeners)if(listener.listening)await new Promise(resolve=>listener.close(resolve));}
  const cert=join(folder,'cert.pem'),key=join(folder,'key.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,IP:127.0.0.2'],{maxBuffer:8192});
  // Root with dropped DAC capabilities reads only this host-owner group.
  await chmod(folder,0o710);await chmod(key,0o640);await chmod(cert,0o640);
  await docker(['network','create','--internal','--label',label+'='+token,networks[0]]);
  await docker(['network','create','--label',label+'='+token,networks[1]]);
  assert.equal(JSON.parse(await docker(['network','inspect',networks[0]]))[0].Internal,true);
  const socketDir=join(folder,'backend'),socketPath=join(socketDir,'backend.sock');await mkdir(socketDir,{mode:0o710});await chmod(socketDir,0o710);
  const origin='https://127.0.0.1:'+port,shopOrigin='https://127.0.0.2:'+port;
  const common=['--label',label+'='+token,'--restart','no','--read-only','--cap-drop=ALL','--cap-add=NET_BIND_SERVICE','--group-add','1000','--security-opt','no-new-privileges:true',
   '--log-driver','none','--memory','48m','--memory-swap','48m','--pids-limit','64','--tmpfs','/data:size=4m','--tmpfs','/config:size=1m'];
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])common.push('--env',key+'=');
  let started=false;
  const start=async()=>{
   assert.equal(started,false);const socket=await lstat(socketPath);
   assert.equal(socket.isSocket(),true);assert.equal(socket.uid,1000);assert.equal(socket.gid,1000);assert.equal(socket.mode&0o7777,0o660);started=true;
   const source=await readFile(resolve('deploy/gcp/Caddyfile'),'utf8'),modified=source.replaceAll('backend:3000','unix//run/mcp-qa-backend/backend.sock');
   assert.notEqual(modified,source);assert.equal(modified.replaceAll('unix//run/mcp-qa-backend/backend.sock','backend:3000'),source);
   await writeFile(join(folder,'frontend.Caddyfile'),modified);
   await writeFile(join(folder,'gateway.Caddyfile'),'{\n admin off\n auto_https off\n}\nhttps://:8443 {\n tls /fixture/cert.pem /fixture/key.pem\n reverse_proxy frontend:80 {\n header_up X-Real-IP {remote_host}\n }\n}\n');
   await docker(['run','-d','--pull=never','--name',names[0],...common,'--network',networks[0],'--network-alias','frontend','--mount','type=bind,src='+socketDir+',dst=/run/mcp-qa-backend,readonly',
    '-e','SHOP_HOST=127.0.0.2','-e','SELLER_HOST=127.0.0.1','--mount','type=bind,src='+join(folder,'frontend.Caddyfile')+',dst=/etc/caddy/Caddyfile,readonly',
    '--mount','type=bind,src='+resolve('public')+',dst=/srv/public,readonly',caddy]);
   await docker(['network','connect','--alias','frontend',networks[1],names[0]]);
   await docker(['run','-d','--pull=never','--name',names[1],...common,'--network',networks[1],'-p','127.0.0.1:'+port+':8443','-p','127.0.0.2:'+port+':8443',
    '--mount','type=bind,src='+folder+',dst=/fixture,readonly','--mount','type=bind,src='+join(folder,'gateway.Caddyfile')+',dst=/etc/caddy/Caddyfile,readonly',caddy]);
   let ready=false,last='none';
   for(let n=0;n<50;n++){
    try{const{stdout}=await exec('curl',['--silent','--show-error','--noproxy','*','--max-time','2','--cacert',cert,'--fail',origin+'/ready'],{timeout:3000,maxBuffer:8192});if(JSON.parse(stdout).status==='ready'){ready=true;break;}}
    catch(error){last='curl '+error.code;/* Do not log internal errors or credentials. */}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   if(!ready){
    for(const name of names){const state=JSON.parse(await docker(['inspect','--format','{{json .State}}',name]));last+=' '+name+':'+JSON.stringify({running:state.Running,exit:state.ExitCode,oom:state.OOMKilled});}
   }
   assert.equal(ready,true,'Real Caddy/TLS/Node production-profile readiness must succeed: '+last);
   // Verify both SAN/IP host routes with normal TLS verification, not browser's
   // self-signed test-certificate exception. Never use --insecure.
   for(const url of [origin,shopOrigin])await exec('curl',['--silent','--show-error','--noproxy','*','--max-time','5','--cacert',cert,'--fail',url+'/health'],{timeout:6000,maxBuffer:8192});
   await waitForOwnedNetworkSettlement(t,networks,token);
  };
  return{origin,shopOrigin,socketPath,start,stop};
 }catch(error){await stop();throw error;}
}
