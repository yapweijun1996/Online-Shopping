import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildMediaManifest,mediaAssetKey } from '../src/mcp/media-manifest.js';
import { canonicalOperationJson } from '../src/mcp/operation-envelope.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { catalogWireInput,wireId,wireProposal,wireBinding } from './helpers/mcp-catalog-wire-fixture.js';
const enabled=Boolean(process.env.QA_PLAYWRIGHT_MODULE);
test('SYNTHETIC transport C renderer verifies page labels and safely displays nullable listings; this is not C authorization proof',
 {skip:!enabled,timeout:60000},async t=>{
  const assets=Object.fromEntries(await Promise.all(['html','js','css'].map(async extension=>[extension,await readFile(new URL('../src/mcp/operation-review.'+extension,import.meta.url))])));
  const png=await readFile(new URL('../public/shop/icons/icon-192.png',import.meta.url)),input=catalogWireInput();
  input.assets[0].byte_sha256=mediaHash(png);input.assets[0].byte_length=png.length;input.graphBytes.oldBytes=png.length;
  const key=mediaAssetKey('image/png',mediaHash(png));input.effects[0].before.mainAssetKey=input.effects[0].after.mainAssetKey=key;input.effects[1].before.galleryAssetKeys=[key];
  input.effects[0].labels.after.name='<script>window.__CInjected=true</script> A\u202eB';
  input.graphRevision=wireBinding(input.effects).revision;
  const manifest=buildMediaManifest(input),items=[...manifest.pages.map(page=>({kind:'PAGE',itemKey:String(page.page_index),hash:page.page_hash,pageIndex:page.page_index,assetKey:null})),
   ...manifest.assets.map(asset=>({kind:'ASSET',itemKey:asset.asset_key,hash:asset.byte_sha256,pageIndex:null,assetKey:asset.asset_key}))];
  let corrupt=false;const approvals=[],acknowledgements=[];
  const server=createServer(async(request,response)=>{
   const path=new URL(request.url,'http://localhost').pathname.replace(/^\/alpha(?=\/)/,'');
   const json=value=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
   if(path==='/oauth/operation'){response.writeHead(200,{'Content-Type':'text/html'});response.end(assets.html);return;}
   if(/^\/oauth\/operation-review\.(js|css)$/.test(path)){const extension=path.endsWith('.js')?'js':'css';response.writeHead(200,{'Content-Type':extension==='js'?'text/javascript':'text/css'});response.end(assets[extension]);return;}
   if(path==='/api/v1/seller/session'){json({csrfToken:'synthetic-csrf'});return;}
   if(path==='/api/v1/seller/mcp/operations/'+wireId(1)&&request.method==='GET'){
    const proposal=structuredClone(wireProposal(manifest));if(corrupt)proposal.reviewLabels[0].after.name='Unbound latest name';
    json({operationId:wireId(1),shopName:'Synthetic transport shop',accountName:'synthetic_owner',clientName:'Synthetic render client',clientId:'synthetic-client',
     toolName:'catalog.preview_update',resourceType:'product',resourceId:wireId(1),risk:'HIGH',expiresAt:new Date(Date.now()+600000).toISOString(),previewHash:'c'.repeat(64),challenge:'A'.repeat(43),
     currencyAcknowledgementRequired:false,currencyWarning:null,proposal,mediaReview:{descriptor:manifest.descriptor,items,labels:[]}});return;
   }
   if(request.method==='POST'){
    const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
    if(path.endsWith('/media/delivery')){
     const item=items.find(value=>value.kind===body.kind&&value.itemKey===body.itemKey),bytes=body.kind==='PAGE'?Buffer.from(manifest.pages[Number(body.itemKey)].page_json):png;
     response.writeHead(200,{'Content-Type':body.kind==='PAGE'?'application/json':'image/png','X-Media-Nonce':'B'.repeat(43),'X-Media-Sha256':item.hash,'X-Media-Manifest':manifest.descriptor.manifestRoot,'X-Media-Item':body.kind+':'+body.itemKey});response.end(bytes);return;
    }
    if(path.endsWith('/media/ack')){acknowledgements.push(body);json({operationId:wireId(1),kind:body.kind,itemKey:body.itemKey,acknowledged:true});return;}
    if(path.endsWith('/approval')){approvals.push(body);json({operationId:wireId(1),status:'APPROVED'});return;}
   }
   response.writeHead(404);response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port,{chromium}=await import(process.env.QA_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  for(const [width,base] of [[1280,''],[390,'/alpha']]){
   const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close());const errors=[],external=[];
   await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   await page.goto(origin+base+'/oauth/operation?operationId='+wireId(1));await page.waitForFunction(()=>!document.querySelector('#media-image-ack').disabled);
   const text=await page.locator('#media-effects').textContent();assert.match(text,/Did not exist before this change/);assert.match(text,/Removed by this change/);
   assert.match(text,/Stored own main is hidden/);assert.match(text,/Old literal name/);assert.ok(text.includes('<script>window.__CInjected=true</script>'));assert.ok(text.includes('\\u202e'));
   assert.equal(await page.evaluate(()=>window.__CInjected),undefined);assert.equal(await page.locator('#media-effects script').count(),0);
   assert.equal(await page.locator('#media-ack').isChecked(),false);assert.equal(await page.locator('#approve').isDisabled(),true);
   const image=await page.locator('#media-image').evaluate(value=>({width:value.naturalWidth,height:value.naturalHeight}));assert.ok(image.width>0&&image.height>0);
   await page.locator('#media-image-ack').click();await page.waitForFunction(()=>!document.querySelector('#approve').disabled);
   const before=approvals.length;await page.locator('#password').fill('Synthetic-render-password');await page.locator('#approve').click();assert.equal(approvals.length,before);
   await page.locator('#media-ack').check();await page.locator('#approve').click();await page.locator('#decision').waitFor({state:'hidden'});
   assert.equal(approvals.length,before+1);assert.equal(approvals.at(-1).mediaReviewed,true);assert.equal(await page.locator('#password').inputValue(),'');
   assert.ok(acknowledgements.some(value=>value.kind==='ASSET'));assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await context.close();
  }
  corrupt=true;const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(origin+'/oauth/operation?operationId='+wireId(1));await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Image verification failed'));
  assert.equal(await page.locator('#approve').isDisabled(),true);assert.equal(await page.locator('#media-image-ack').isDisabled(),true);assert.equal(approvals.length,2);
 });
