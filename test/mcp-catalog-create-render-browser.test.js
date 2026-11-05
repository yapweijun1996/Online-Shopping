import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildMediaManifest,mediaAssetKey } from '../src/mcp/media-manifest.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { createWireInput,createWireIdentity,createWireBinding,createWireProposal } from './helpers/mcp-catalog-create-wire-fixture.js';
import { wireId } from './helpers/mcp-catalog-wire-fixture.js';
test('SYNTHETIC transport CREATE renderer verifies null BEFORE/options/page ACK, not actual CREATE authorization',
 {skip:!process.env.QA_PLAYWRIGHT_MODULE,timeout:60000},async t=>{
 const assets=Object.fromEntries(await Promise.all(['html','js','css'].map(async extension=>[extension,await readFile(new URL('../src/mcp/operation-review.'+extension,import.meta.url))]))),png=await readFile(new URL('../public/shop/icons/icon-192.png',import.meta.url));
 let current,corrupt=false;const acknowledgements=[],approvals=[];
 const server=createServer(async(request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname.replace(/^\/alpha(?=\/)/,'');
  const json=value=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
  if(path==='/oauth/operation'){response.writeHead(200,{'Content-Type':'text/html'});response.end(assets.html);return;}
  if(/^\/oauth\/operation-review\.(js|css)$/.test(path)){const extension=path.endsWith('.js')?'js':'css';response.writeHead(200,{'Content-Type':extension==='js'?'text/javascript':'text/css'});response.end(assets[extension]);return;}
  if(path==='/api/v1/seller/session'){json({csrfToken:'synthetic-csrf'});return;}
  if(path==='/api/v1/seller/mcp/operations/'+wireId(99)&&request.method==='GET'){
   const proposal=structuredClone(current.proposal);if(corrupt)proposal.reviewLabels.find(row=>row.before===null).after.name='Unbound current name';
   json({operationId:wireId(99),shopName:'Synthetic transport shop',accountName:'synthetic_owner',clientName:'Synthetic client',clientId:'synthetic',toolName:'catalog.preview_create',resourceType:'catalog',resourceId:'catalog',risk:'HIGH',
    expiresAt:new Date(Date.now()+600000).toISOString(),previewHash:'c'.repeat(64),challenge:'A'.repeat(43),currencyAcknowledgementRequired:false,currencyWarning:null,proposal,mediaReview:{descriptor:current.manifest.descriptor,items:current.items,labels:[]}});return;
  }
  if(request.method==='POST'){
   const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
   if(path.endsWith('/media/delivery')){const item=current.items.find(value=>value.kind===body.kind&&value.itemKey===body.itemKey),bytes=body.kind==='PAGE'?Buffer.from(current.manifest.pages[Number(body.itemKey)].page_json):png;
    response.writeHead(200,{'Content-Type':body.kind==='PAGE'?'application/json':'image/png','X-Media-Nonce':'B'.repeat(43),'X-Media-Sha256':item.hash,'X-Media-Manifest':current.manifest.descriptor.manifestRoot,'X-Media-Item':body.kind+':'+body.itemKey});response.end(bytes);return;}
   if(path.endsWith('/media/ack')){acknowledgements.push(body);json({operationId:wireId(99),kind:body.kind,itemKey:body.itemKey,acknowledged:true});return;}
   if(path.endsWith('/approval')){approvals.push(body);json({operationId:wireId(99),status:'APPROVED'});return;}
  }
  response.writeHead(404);response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const origin='http://127.0.0.1:'+server.address().port,{chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const [existing,width,base]of [[false,1280,''],[true,390,'/alpha']]){
  const input=createWireInput(existing),identity=createWireIdentity(existing),fresh=input.effects.find(row=>row.kind==='PRODUCT'&&row.before===null);
  fresh.labels.after.name='<script>window.__DInjected=true</script> A\u202eB';
  if(existing){input.assets[0].byte_sha256=mediaHash(png);input.assets[0].byte_length=png.length;input.graphBytes.oldBytes=2*png.length;const key=mediaAssetKey('image/png',mediaHash(png));
   for(const row of input.effects)for(const side of ['before','after'])if(row[side]){if(row.kind==='PRODUCT'&&row[side].mainAssetKey!==null)row[side].mainAssetKey=key;if(row.kind==='LISTING')row[side].galleryAssetKeys=row[side].galleryAssetKeys.map(()=>key);}}
  input.graphRevision=createWireBinding(input.effects,identity).revision;const manifest=buildMediaManifest(input),proposal=createWireProposal(manifest,identity);
  proposal.after.options=[{typeId:wireId(50),valueId:wireId(51)}];proposal.optionReview.after=[{typeId:wireId(50),valueId:wireId(51),typeName:'Colour',typeCode:'colour',valueLabel:'Blue',valueCode:'blue',typeActive:true,valueActive:true}];
  current={manifest,proposal,items:[...manifest.pages.map(page=>({kind:'PAGE',itemKey:String(page.page_index),hash:page.page_hash,pageIndex:page.page_index,assetKey:null})),...manifest.assets.map(asset=>({kind:'ASSET',itemKey:asset.asset_key,hash:asset.byte_sha256,pageIndex:null,assetKey:asset.asset_key}))]};
  const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close());const page=await context.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const ackStart=acknowledgements.length;await page.goto(origin+base+'/oauth/operation?operationId='+wireId(99));await page.waitForFunction(()=>document.querySelector('#media-effects').textContent.includes('Not yet created.'));
  const text=await page.locator('#media-effects').textContent();assert.match(text,/Not yet created\./);assert.match(text,/Options: Colour: Blue/);assert.ok(text.includes('<script>window.__DInjected=true</script>'));assert.ok(text.includes('\\u202e'));
  assert.equal(await page.evaluate(()=>window.__DInjected),undefined);assert.equal(await page.locator('#media-effects script').count(),0);assert.ok(acknowledgements.slice(ackStart).some(row=>row.kind==='PAGE'));
  assert.equal(await page.locator('#media-ack').isChecked(),false);
  if(existing){await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);await page.locator('#media-image-ack').click();}
  else {assert.equal(await page.locator('#media-image-ack').isDisabled(),true);assert.equal(acknowledgements.slice(ackStart).some(row=>row.kind==='ASSET'),false);}
  await page.waitForFunction(()=>!document.querySelector('#approve').disabled);const before=approvals.length;await page.locator('#password').fill('Synthetic-render-password');await page.locator('#approve').click();assert.equal(approvals.length,before);
  await page.locator('#media-ack').check();await page.locator('#approve').click();await page.locator('#decision').waitFor({state:'hidden'});assert.equal(approvals.length,before+1);assert.equal(approvals.at(-1).mediaReviewed,true);assert.equal(await page.locator('#password').inputValue(),'');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();
 }
 corrupt=true;const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(origin+'/oauth/operation?operationId='+wireId(99));await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Image verification failed'));
 assert.equal(await page.locator('#approve').isDisabled(),true);assert.equal(approvals.length,2);
});
