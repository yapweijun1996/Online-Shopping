import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { useWorkerIngress } from '../test/browser/worker-harness.mjs';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/share-ui'); mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const sha = b => createHash('sha256').update(b).digest('hex');
const paths = ['public/shop/product-share.js','public/shop/product-detail.js','public/shop/shop-route.js','public/shop/app.js','public/shop/version.js','public/shop/sw.js','public/shared/i18n.js','src/app.js','src/auth.js','src/worker.js','test/browser/worker-harness.mjs','scripts/qa-share-ui-branches.mjs'];
const hashes = () => Object.fromEntries(paths.map(p => [p,sha(readFileSync(p))]));
const report = { sourceHead: head, gitStatusBefore: execFileSync('git',['status','--porcelain'],{encoding:'utf8'}), sourceHashes: hashes(), versions: Object.fromEntries(['shop','seller'].map(s => [s,/v\d+/.exec(readFileSync(`public/${s}/version.js`,'utf8'))[0]])), scope: 'Criterion12 controlled browser API application branches only; actual Share button, real local Worker/API products, no native panel/real clipboard authorization/outbound sending/new permission, criterion94 share-response subset only', cases: [], pageErrors: [], externalRequests: [], domainWrites: [], cleanup: [] };
const secrets = new Set(); let browser,app,context,page,width,stage,gateway,origin,A,B,domainBefore,domain,serial=0;
const tick = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
function controlledShareAPIs() {
  const qa = window.__shareQA = { events: [], pending: {}, next: 0, config: {} };
  document.addEventListener('click', e => { if (e.target.closest?.('.product-share')) qa.events.push({kind:'click',trusted:e.isTrusted}); },true);
  const fail = name => new DOMException('Controlled local QA branch',name);
  const call = (kind,data) => {
    const event = {kind,data,id:++qa.next,userActivation:navigator.userActivation.isActive}; qa.events.push(event);
    const mode = kind==='share' ? qa.config.share : qa.config.copy;
    if (mode==='throw') throw fail('NotAllowedError');
    if (mode==='abort') return Promise.reject(fail('AbortError'));
    if (mode==='deny') return Promise.reject(fail('NotAllowedError'));
    if (mode==='pending') return new Promise((resolve,reject) => { qa.pending[event.id]={resolve,reject}; });
    return Promise.resolve();
  };
  qa.configure = config => {
    qa.config = config;
    Object.defineProperty(navigator,'share',{configurable:true,value:config.share==='unsupported'?undefined:data=>call('share',data)});
    Object.defineProperty(navigator,'canShare',{configurable:true,value:config.can==='missing'?undefined:data=>{qa.events.push({kind:'canShare',data});return config.can!=='false';}});
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:config.copy==='missing'?undefined:{writeText:url=>call('copy',url)}});
  };
  qa.settle = ({id,outcome}) => { const p=qa.pending[id];if(!p)throw Error('Unknown controlled pending operation');delete qa.pending[id];outcome==='resolve'?p.resolve():p.reject(fail(outcome==='abort'?'AbortError':'NotAllowedError')); };
  qa.configure({share:'unsupported',copy:'deny',can:'true'});
}
const configure = c => page.evaluate(c => window.__shareQA.configure(c),c);
const events = () => page.evaluate(() => window.__shareQA.events);
const canonical = p => origin+'/shop/#product/'+p.id;
const ready = async p => { await page.waitForFunction(sku => document.querySelector('.product-key-details')?.textContent.includes(sku),p.sku);await page.locator('.related-card').waitFor();await tick(page); };
const change = async p => { await page.evaluate(id => location.hash='#product/'+id,p.id);await ready(p); };
const share = () => page.locator('.product-share');
const feedback = () => page.locator('.product-heading-block [role=status]');
async function expectStatus(text) { await page.waitForFunction(text => document.querySelector('.product-heading-block [role=status]')?.textContent===text,text);assert.equal(await share().isDisabled(),false);assert.equal(await share().getAttribute('aria-busy'),null); }
async function manualLink(p) { await expectStatus('Select and copy this product link.');const input=page.locator('.share-url');await input.waitFor({state:'visible'});assert.equal(await input.inputValue(),canonical(p));assert.equal(await input.getAttribute('readonly'),'');assert.equal(await input.getAttribute('aria-label'),'Product link');assert.deepEqual(await input.evaluate(x=>({focused:document.activeElement===x,start:x.selectionStart,end:x.selectionEnd})),{focused:true,start:0,end:canonical(p).length}); }
const snapshot = () => page.evaluate(() => ({hash:location.hash,title:document.title,content:document.querySelector('#product-view').innerHTML,quantity:document.querySelector('#detail-quantity')?.value,feedback:document.querySelector('.product-heading-block [role=status]')?.textContent,manual:{hidden:document.querySelector('.share-url')?.hidden,value:document.querySelector('.share-url')?.value},focus:{tag:document.activeElement.tagName,id:document.activeElement.id,cls:document.activeElement.className},storage:Object.fromEntries(Object.entries(localStorage))}));
async function checked(label,fn) {
  if(process.env.QA_CASE_FILTER&&!new RegExp(process.env.QA_CASE_FILTER).test(label))return;
  stage=label;page=await context.newPage();page.setDefaultTimeout(8000);const c={label,width,status:'UNVERIFIED'},errors=report.pageErrors.length;
  page.on('pageerror',e=>report.pageErrors.push({width,label,error:e.message}));page.on('request',r=>{if(['POST','PATCH','DELETE'].includes(r.method())&&new URL(r.url()).pathname.startsWith('/api/'))report.domainWrites.push({width,label,method:r.method(),path:new URL(r.url()).pathname});});
  try { await page.goto(origin+'/shop/?tracking=fictional-private-query#product/'+A.id);await ready(A);await fn(c);assert.equal(report.pageErrors.length,errors);assert.deepEqual(domain(),domainBefore);assert.equal(report.domainWrites.length,0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);c.status='PASS'; }
  catch(e) { let message=e.stack||e.message;for(const s of secrets)message=message.replaceAll(s,'[REDACTED]');c.error=message;c.status='FAIL'; }
  finally { c.events=await events();c.current=await snapshot();c.domainAfter=domain();c.newPageErrors=report.pageErrors.slice(errors);const filename=`case-${++serial}-${width}-${c.status}.png`;await page.screenshot({path:out+'/'+filename,fullPage:true});c.screenshot=filename;report.cases.push(c);console.log(c.status+' '+width+' '+label+(c.error?' '+c.error.split('\n')[0]:''));await page.close();page=null; }
}
try {
  const config={dbPath:':memory:',shopMode:'manual',username:'synthetic_share_qa',password:randomUUID()+randomUUID(),production:false,publicOrigin:null};secrets.add(config.password);
  app=createApp(config);gateway=useWorkerIngress(app,config);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+app.server.address().port;
  const login=await fetch(origin+'/api/v1/seller/session',{method:'POST',signal:AbortSignal.timeout(8000),headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:config.username,password:config.password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrfToken;secrets.add(cookie);secrets.add(csrf);
  const api=async(method,path,body)=>{const r=await fetch(origin+path,{method,signal:AbortSignal.timeout(8000),headers:{origin,cookie,'x-csrf-token':csrf,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,'Synthetic setup API '+r.status);return r.json();};
  await api('POST','/api/v1/seller/setup',{mode:'production',shopName:'Fictional local Share test'});await api('POST','/api/v1/seller/categories',{code:'SHARE_QA',label:'Fictional sharing category'});
  const product=tag=>api('POST','/api/v1/seller/products',{sku:'SYNTHETIC-SHARE-'+tag,name:'Fictional '+tag,description:'Disposable local Share fixture',category:'SHARE_QA',priceMinor:1290,active:true});A=await product('ALPHA');B=await product('BETA');await api('DELETE','/api/v1/seller/session');
  const tables=app.database.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('admin','session','rate_limit_attempt') ORDER BY name").map(r=>r.name);domain=()=>Object.fromEntries(tables.map(t=>{assert.match(t,/^[a-z_]+$/);const rows=app.database.all('SELECT * FROM '+t+' ORDER BY rowid');return[t,{rows:rows.length,sha256:sha(JSON.stringify(rows))}];}));domainBefore=domain();report.domainBefore=domainBefore;report.fixture={A:{id:A.id,sku:A.sku,name:A.name},B:{id:B.id,sku:B.sku,name:B.name},serverProduction:false,credentialsSerialized:false};const startRequests=gateway.records.length;
  browser=await chromium.launch({headless:true});report.browser=browser.version();
  for(width of [390,1280]) {
    context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'});await context.addInitScript(controlledShareAPIs);await context.route('**/*',r=>{if(!r.request().url().startsWith(origin+'/')){report.externalRequests.push({scheme:new URL(r.request().url()).protocol});return r.abort();}return r.continue();});
    const normal=[['Controlled share success without canShare',{share:'resolve',copy:'resolve',can:'missing'},'Share panel finished.',1,0],['Pending share rejects duplicate clicks',{share:'pending',copy:'resolve',can:'true'},'Share panel finished.',1,0],['AbortError cancellation never copies',{share:'abort',copy:'resolve',can:'true'},'Sharing canceled. No link was copied.',1,0],['Share unavailable copies canonical product URL',{share:'unsupported',copy:'resolve',can:'true'},'Product link copied.',0,1],['canShare false skips share and copies',{share:'throw',copy:'resolve',can:'false'},'Product link copied.',0,1],['Share denied falls back to successful copy',{share:'deny',copy:'resolve',can:'true'},'Product link copied.',1,1],['Synchronous share throw falls back to copy',{share:'throw',copy:'resolve',can:'true'},'Product link copied.',1,1],['Share unavailable and clipboard denied show manual link',{share:'unsupported',copy:'deny',can:'true'},'Select and copy this product link.',0,1],['Share failure and copy failure offer manual link; explicit retry recovers',{share:'deny',copy:'deny',can:'true'},'Select and copy this product link.',1,1],['Missing clipboard offers selected manual link',{share:'unsupported',copy:'missing',can:'true'},'Select and copy this product link.',0,0]];
    for(const [label,config,status,nshare,ncopy] of normal) await checked(label,async c=>{
      await configure(config);await share().click();
      if(config.share==='pending'){assert.equal(await share().isDisabled(),true);assert.equal(await share().getAttribute('aria-busy'),'true');await share().evaluate(b=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal((await events()).filter(x=>x.kind==='share').length,1);await page.evaluate(()=>{const id=__shareQA.events.find(x=>x.kind==='share').id;__shareQA.settle({id,outcome:'resolve'});});c.duplicate='One trusted initial click; an explicitly injected duplicate event causes no second call';}
      await expectStatus(status);if(status.startsWith('Select'))await manualLink(A);else assert.equal(await page.locator('.share-url').isVisible(),false);
      const calls=await events(),shares=calls.filter(x=>x.kind==='share'),copies=calls.filter(x=>x.kind==='copy');assert.equal(shares.length,nshare);assert.equal(copies.length,ncopy);assert.equal(calls.filter(x=>x.kind==='click'&&x.trusted).length,1);
      for(const x of shares){assert.deepEqual(x.data,{title:A.name,url:canonical(A)});assert.equal(x.userActivation,true);}for(const x of copies)assert.equal(x.data,canonical(A));c.branch={expectedStatus:status,shareCalls:nshare,copyCalls:ncopy,payloadQueryRemoved:true,actualTrustedButtonClick:true,controlledAPIOnly:true};
      if(label.includes('retry')){await page.screenshot({path:out+`/manual-copy-failure-${width}.png`,fullPage:true});await configure({share:'unsupported',copy:'resolve',can:'true'});await share().click();await expectStatus('Product link copied.');assert.equal(await page.locator('.share-url').isVisible(),false);assert.equal((await events()).filter(x=>x.kind==='copy').length,2);c.explicitRetry='Controlled successful copy clears prior manual field/status';}
    });
    for(const transition of ['A→B','A→B→A'])for(const operation of ['share-resolve','share-abort','share-deny','copy-resolve','copy-deny'])await checked('Late '+operation+' after '+transition,async c=>{
      const kind=operation.startsWith('share')?'share':'copy',outcome=operation.split('-')[1];await configure({share:kind==='share'?'pending':'unsupported',copy:kind==='copy'?'pending':'resolve',can:'true'});await share().click();const old=(await events()).find(x=>x.kind===kind);assert.ok(old);assert.equal(old.userActivation,true);assert.deepEqual(old.data,kind==='share'?{title:A.name,url:canonical(A)}:canonical(A));
      await change(B);const current=transition==='A→B'?B:A;if(current===A)await change(A);await page.locator('#detail-quantity').fill('3');await page.locator('#detail-quantity').dispatchEvent('input');await page.locator('#detail-quantity').focus();await tick(page);const before=await snapshot();
      await page.evaluate(x=>__shareQA.settle(x),{id:old.id,outcome});await tick(page);assert.deepEqual(await snapshot(),before,'Old result cannot change fresh product/title/quantity/status/manual link/focus/storage');const completed=await events();assert.equal(completed.filter(x=>x.kind===kind).length,1);assert.equal(completed.filter(x=>x.kind==='copy').length,kind==='copy'?1:0);c.currentBefore=before;c.currentAfter=await snapshot();c.oldClipboard='Copy branch may already have one intended old-URL request; no additional fallback/copy and no real clipboard operation';
      await configure({share:'unsupported',copy:'resolve',can:'true'});await share().click();await expectStatus('Product link copied.');assert.equal((await events()).filter(x=>x.kind==='copy').at(-1).data,canonical(current));c.newExplicitShare={currentProductId:current.id,canonicalURL:canonical(current),status:'Controlled copy branch succeeds'};
    });
    await checked('Old A share cannot end newer B pending share',async c=>{
      await configure({share:'pending',copy:'resolve',can:'true'});await share().click();const old=(await events()).find(x=>x.kind==='share');await change(B);await share().click();const fresh=(await events()).filter(x=>x.kind==='share').at(-1);assert.notEqual(old.id,fresh.id);const before=await snapshot();await page.evaluate(x=>__shareQA.settle(x),{id:old.id,outcome:'deny'});await tick(page);assert.deepEqual(await snapshot(),before);assert.equal(await share().isDisabled(),true);assert.equal(await share().getAttribute('aria-busy'),'true');assert.equal((await events()).filter(x=>x.kind==='copy').length,0);assert.deepEqual(fresh.data,{title:B.name,url:canonical(B)});await page.evaluate(x=>__shareQA.settle(x),{id:fresh.id,outcome:'resolve'});await expectStatus('Share panel finished.');c.overlap={oldCallbackDiscarded:true,newButtonRemainsBusyUntilOwnResult:true,copyCalls:0,controlledAPIOnly:true};
    });
    await context.close();context=null;report.cleanup.push({width,browserContextClosed:true});
  }
  report.workerRequests=gateway.records.slice(startRequests).map(({method,path,query,status})=>({method,path,query,status}));assert.ok(report.workerRequests.every(r=>r.method==='GET'));assert.deepEqual(domain(),domainBefore);assert.equal(report.externalRequests.length,0);assert.equal(report.pageErrors.length,0);
} catch(e) {let message=e.stack||e.message;for(const s of secrets)message=message.replaceAll(s,'[REDACTED]');report.fatal=message;process.exitCode=1;}
finally {if(context)await context.close();if(browser)await browser.close();if(app){report.domainAfter=domain?.();await app.close();report.cleanup.push({browserClosed:true,serverClosed:true,inMemoryDatabaseClosed:true});}report.sourceHashesAfter=hashes();assert.deepEqual(report.sourceHashesAfter,report.sourceHashes);report.completedAt=new Date().toISOString();report.expectedCases=42;report.caseFilter=process.env.QA_CASE_FILTER||null;report.runCompleted=!report.fatal;report.selectedPass=report.cases.every(c=>c.status==='PASS');if(!report.selectedPass||report.fatal)process.exitCode=1;writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({head,cases:report.cases.length,pass:report.cases.filter(c=>c.status==='PASS').length,fail:report.cases.filter(c=>c.status==='FAIL').length,pageErrors:report.pageErrors.length,fatal:report.fatal,cleanup:report.cleanup}));}
