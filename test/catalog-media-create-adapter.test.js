import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdapterFixture,seedCreateAdapterFrame,createInput,photo } from './helpers/mcp-catalog-create-adapter-fixture.js';
import { catalogMediaCreateTool,parseCatalogMediaCreateProposal } from '../src/mcp/catalog-media-create-adapter.js';
import { catalogCreateTool } from '../src/mcp/catalog-tools.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { createOptionType,createOptionValue } from '../src/options.js';
import { applyPlannedProductCreate,getProduct } from '../src/products.js';
import { readCatalogCreateMediaMetadata } from '../src/mcp/catalog-create-media-state.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { canonicalOperationJson } from '../src/mcp/operation-envelope.js';
import { recordOperationCall } from '../src/mcp/audit.js';
import { rowsDigest } from '../src/sqlite-import.js';
const identity=()=>({version:1,productId:randomUUID(),targetCode:null,targetListingId:null,newListingId:randomUUID()});
const commerce=async store=>{const rows=[];for(const table of ['product','listing','product_option','product_gallery_image','product_event','inventory_coverage','inventory_state','inventory_movement'])rows.push(rowsDigest(await store.all('SELECT * FROM '+table)));return rows;};
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 for(const mode of ['private','new-group','existing-copy','full11'])test(`${dialect}: PRIVATE CREATE ${mode} uses real D0 and lock-free synthetic native, not approval`,options,async t=>{
  const f=await createAdapterFixture(t,dialect);let holder;
  if(['existing-copy','full11'].includes(mode))holder=await f.make('GROUP',{name:'Adopted shared name',description:'Adopted description',imageDataUrl:photo('main'),thumbDataUrl:photo('thumb')});
  if(mode==='full11'){await f.make('GROUP');await f.store.run('DELETE FROM product_gallery_image WHERE product_id=?',holder.id);for(let n=1;n<=10;n++)await f.store.run("INSERT INTO product_gallery_image(id,product_id,position,mime,data,created_at) VALUES(?,?,?,'image/png',?,'2026-01-01T00:00:00.000Z')",randomUUID(),holder.id,n,Buffer.from(photo('gallery-'+n).split(',')[1],'base64'));await f.store.run('UPDATE product SET gallery_layout_json=NULL WHERE id=?',holder.id);}
  const args=createInput({name:'  Requested name  ',stockQuantity:mode==='private'?null:4,...(mode==='private'?{}:{variantGroup:mode==='new-group'?'FRESH':'GROUP',variantLabel:'New'})});if(mode==='private')delete args.currency;
  const baseline=await commerce(f.store),{captured,resolved,value}=await f.draft(args);assert.deepEqual(await commerce(f.store),baseline);assert.equal(captured.resourceId,'catalog');assert.equal(value.resourceId,'catalog');assert.equal(value.expectedRevision,captured.expectedRevision);
  assert.equal(f.nativeCalls(),value.mediaManifest.assets.length);assert.equal(captured.resources.old.length,value.mediaManifest.assets.length);assert.equal(value.proposal.before,null);assert.equal(Object.hasOwn(value.proposal.after,'createdAt'),false);
  if(holder){assert.equal(value.proposal.after.name,'Adopted shared name');assert.deepEqual(value.proposal.warnings.map(row=>row.code),['ADOPT_SHARED_LISTING','SHARE_LISTING_GALLERY']);}else{assert.equal(value.proposal.warnings.length,0);assert.equal(value.mediaManifest.assets.length,0);assert.ok(value.mediaManifest.pages.length>=1);}
  const op=await seedCreateAdapterFrame(f,value);parseCatalogMediaCreateProposal(op.proposal);await f.adapter.media.persistResources(null,op.envelope,resolved,f.context);assert.deepEqual(await f.adapter.currentRevision(f.store,op.envelope),{exists:true,revision:value.expectedRevision});
  const receipt=await f.adapter.apply(f.store,op.proposal,op.applyContext);assert.equal(f.adapter.validReceipt(receipt),true);assert.deepEqual(Object.keys(receipt),['productId','listingId','revision']);assert.equal(receipt.productId,op.proposal.creationIdentity.productId);assert.equal(receipt.listingId,op.proposal.after.listingId);assert.notEqual(receipt.revision,value.expectedRevision);
  const actual=await getProduct(f.store,receipt.productId,true);assert.equal(actual.stockQuantity,args.stockQuantity);assert.equal(actual.name,op.proposal.after.name);if(mode==='full11')assert.equal((await getProduct(f.store,holder.id,true)).galleryItems.length,11);
  const afterMetadata=await readCatalogCreateMediaMetadata(f.store,{normalizedInput:op.proposal.normalizedInput,creationIdentity:op.proposal.creationIdentity}),snapshot=await readMediaSnapshot(f.store,receipt.productId);
  assert.equal(receipt.revision,mediaHash(canonicalOperationJson({version:1,kind:'catalog-media-create-result',productId:receipt.productId,listingId:receipt.listingId,catalogRevision:afterMetadata.revision,mediaRevision:snapshot.revision})));
  const movements=await f.store.all('SELECT source,reason_code,operation_id,actor_id,client_id,grant_id,correlation_id FROM inventory_movement WHERE product_id=?',receipt.productId);assert.deepEqual(movements.map(row=>({...row})),[{source:'MCP_CATALOG',reason_code:'PRODUCT_CREATE',operation_id:op.id,actor_id:f.account.id,client_id:f.context.clientId,grant_id:f.context.grantId,correlation_id:op.applyContext.correlationId}]);
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM product_event WHERE product_id=?',receipt.productId)).n,1);const after=await commerce(f.store);await assert.rejects(f.adapter.apply(f.store,op.proposal,op.applyContext),{code:'CATALOG_DEPENDENCY_CHANGED'});assert.deepEqual(await commerce(f.store),after);assert.deepEqual(await f.adapter.currentRevision(f.store,op.envelope),{exists:true,revision:null});
 });
 test(`${dialect}: PRIVATE CREATE canonical base and final clipped option labels remain separate`,options,async t=>{
  const f=await createAdapterFixture(t,dialect);
  for(const [n,first,second]of [[0,'A'.repeat(79),'B'],[1,'A'.repeat(76),'😀']]){
   const a=await createOptionType(f.store,{name:'First-'+n,position:1}),b=await createOptionType(f.store,{name:'Second-'+n,position:2}),av=await createOptionValue(f.store,a.id,{label:first}),bv=await createOptionValue(f.store,b.id,{label:second});
   const {value}=await f.draft(createInput({sku:'OPTIONS-'+n,variantGroup:'OPTIONS-'+n,variantLabel:'Canonical base',options:[{typeId:a.id,valueId:av.id},{typeId:b.id,valueId:bv.id}]})),op=await seedCreateAdapterFrame(f,value);
   assert.equal(op.proposal.normalizedInput.variantLabel,'Canonical base');assert.equal(op.proposal.after.variantLabel.length,80);assert.ok(op.proposal.after.variantLabel.endsWith(n?'�':' '));const result=await f.adapter.apply(f.store,op.proposal,op.applyContext);assert.equal((await getProduct(f.store,result.productId,true)).variantLabel,op.proposal.after.variantLabel);
  }
 });
}
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: raw source changes stale CREATE before normalizer/target adoption and physical changes also stale`,options,async t=>{
  const f=await createAdapterFixture(t,dialect);
  for(const mutation of ['code','id','currency','physical']){
   const target=mutation==='physical'?await f.make('PHYSICAL',{imageDataUrl:photo('old'),thumbDataUrl:photo('thumb')}):null,args=createInput({sku:'NEW-'+mutation.toUpperCase(),...(target?{variantGroup:'PHYSICAL',variantLabel:'New'}:mutation==='code'?{variantGroup:'APPEARS',variantLabel:'New'}:{})});
   const {value}=await f.draft(args),op=await seedCreateAdapterFrame(f,value);
   if(mutation==='code')await f.make('APPEARS');if(mutation==='id')await applyPlannedProductCreate(f.store,createInput({sku:'OTHER'}),{...identity(),productId:op.proposal.creationIdentity.productId});
   if(mutation==='currency')await f.store.run("UPDATE company_setting SET default_currency='SGD' WHERE id=1");
   if(mutation==='physical')await f.store.run('UPDATE product SET thumb_data=? WHERE id=?',Buffer.from(photo('changed').split(',')[1],'base64'),target.id);
   const baseline=await commerce(f.store),calls=[],get=f.store.get;f.store.get=(sql,...args)=>{calls.push(sql);return get(sql,...args);};try{assert.deepEqual(await f.adapter.currentRevision(f.store,op.envelope),{exists:true,revision:null});}finally{f.store.get=get;}
   if(mutation!=='physical')assert.equal(calls.some(sql=>sql.startsWith('SELECT default_currency, seller_whatsapp_phone')),false);
   await assert.rejects(f.adapter.apply(f.store,op.proposal,op.applyContext),{code:'CATALOG_DEPENDENCY_CHANGED'});assert.deepEqual(await commerce(f.store),baseline);if(mutation==='currency')await f.store.run("UPDATE company_setting SET default_currency='MYR' WHERE id=1");
  }
 });
 test(`${dialect}: PRIVATE factory input DTO contexts and warnings cannot become runtime authority`,options,async t=>{
  const f=await createAdapterFixture(t,dialect),tool=catalogMediaCreateTool(f.runtime),safe=catalogCreateTool();assert.deepEqual(tool.inputSchema,safe.inputSchema);assert.deepEqual(tool.receiptSchema,safe.receiptSchema);assert.throws(()=>createOperationTools({...f.options,entries:[tool]}));
  for(const extra of [{productId:randomUUID()},{creationIdentity:identity()},{imageDataUrl:photo('blocked')},{stageId:randomUUID()},{warnings:[]},{approved:true}])await assert.rejects(f.adapter.media.capture(f.store,createInput(extra),f.context),{status:400});
  const {resolved,value}=await f.draft(createInput()),op=await seedCreateAdapterFrame(f,value),baseline=await commerce(f.store);
  for(const mutate of [data=>data.warnings=[{code:'APPROVED'}],data=>data.after.name='Changed',data=>data.creationIdentity.productId=randomUUID(),data=>data.sourceRevision.catalogRevision='f'.repeat(64)]){const bad=structuredClone(op.proposal);mutate(bad);await assert.rejects(f.adapter.apply(f.store,bad,op.applyContext));}
  await assert.rejects(f.adapter.preview(f.store,createInput(),resolved,{...f.context,tenantId:'other'}));await assert.rejects(f.adapter.apply(f.store,op.proposal,{...op.applyContext,clientId:'other'}));assert.deepEqual(await commerce(f.store),baseline);
 });
 test(`${dialect}: global overflow rejects early and settings preflight precedes the complete legacy reader`,options,async t=>{
  const f=await createAdapterFixture(t,dialect),target=await f.make();
  for(const kind of ['global','settings']){if(kind==='global')await f.store.run('UPDATE product SET description=? WHERE id=?','D'.repeat(70000),target.id);else await f.store.run('UPDATE company_setting SET availability_text=? WHERE id=1','S'.repeat(1000));
   const calls=[],get=f.store.get,all=f.store.all;f.store.get=(sql,...args)=>{calls.push(sql);return get(sql,...args);};f.store.all=(sql,...args)=>{calls.push(sql);return all(sql,...args);};
   try{if(kind==='global')await assert.rejects(f.adapter.media.capture(f.store,createInput(),f.context),{status:503});else{const captured=await f.adapter.media.capture(f.store,createInput(),f.context);assert.equal(JSON.stringify(captured.resources).includes('S'.repeat(1000)),false);}}finally{f.store.get=get;f.store.all=all;}
   if(kind==='global')assert.equal(calls.some(sql=>sql.startsWith('SELECT default_currency, seller_whatsapp_phone')),false);
   else {const preflight=calls.findIndex(sql=>sql.includes(' AS bytes FROM company_setting'));assert.ok(preflight>=0&&preflight<calls.findIndex(sql=>sql.startsWith('SELECT default_currency, seller_whatsapp_phone')));}
   assert.equal(calls.some(sql=>/^SELECT (image_data|data)/.test(sql)),false);
   if(kind==='global')await f.store.run('UPDATE product SET description=? WHERE id=?','Restored',target.id);else await f.store.run('UPDATE company_setting SET availability_text=NULL WHERE id=1');
  }
  assert.equal((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_operation')).n,0);
 });
}
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: PRIVATE writer rolls wrong after effects history audit and invalid receipts back atomically`,options,async t=>{
  const f=await createAdapterFixture(t,dialect),target=await f.make('GROUP',{imageDataUrl:photo('main'),thumbDataUrl:photo('thumb')}),{value}=await f.draft(createInput({variantGroup:'GROUP',variantLabel:'New',stockQuantity:4})),op=await seedCreateAdapterFrame(f,value),baseline=await commerce(f.store);
  for(const fault of ['stock','thumbnail','ledger','history','audit','receipt']){const run=f.store.run;let injected=false;f.store.run=async(sql,...args)=>{
    if(fault==='history'&&sql.startsWith('INSERT INTO product_event')||fault==='audit'&&sql.startsWith('INSERT INTO mcp_audit')){injected=true;throw new Error('Synthetic '+fault+' failure');}
    const result=await run(sql,...args);
    if(!injected&&fault==='stock'&&/^INSERT INTO product\s/.test(sql)){injected=true;await run('UPDATE product SET stock_quantity=stock_quantity+1 WHERE id=?',target.id);}
    if(!injected&&fault==='thumbnail'&&sql.startsWith('INSERT INTO product_gallery_image')){injected=true;await run('UPDATE product SET thumb_data=? WHERE id=?',Buffer.from(photo('bad').split(',')[1],'base64'),target.id);}
    if(!injected&&fault==='ledger'&&sql.startsWith('INSERT INTO inventory_movement')){injected=true;await run("UPDATE inventory_movement SET client_id='unexpected' WHERE product_id=?",op.proposal.creationIdentity.productId);}
    return result;
   };
   try{await assert.rejects(f.store.transaction(async()=>{const result=await f.adapter.apply(f.store,op.proposal,op.applyContext);if(fault==='receipt'){injected=true;assert.equal(f.adapter.validReceipt({...result,privateNote:'Never persisted'}),false);throw new Error('Synthetic receipt failure');}
    await recordOperationCall(f.store,await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?',op.id),'catalog.commit_create','COMMITTED');}),['stock','thumbnail','ledger'].includes(fault)?{code:'CATALOG_DEPENDENCY_CHANGED'}:new RegExp('Synthetic '+fault+' failure'));}finally{f.store.run=run;}
   assert.equal(injected,true,fault);assert.deepEqual(await commerce(f.store),baseline,fault);assert.equal((await f.store.get("SELECT COUNT(*) n FROM mcp_audit WHERE event='CALL'")).n,0);
  }
  assert.equal(f.adapter.validReceipt(await f.adapter.apply(f.store,op.proposal,op.applyContext)),true);
 });
 test(`${dialect}: native integrity/deadline and retained-frame tampering produce no CREATE`,options,async t=>{
  const f=await createAdapterFixture(t,dialect);await f.make('GROUP',{imageDataUrl:photo('main')});const args=createInput({variantGroup:'GROUP',variantLabel:'New'}),captured=await f.adapter.media.capture(f.store,args,f.context),baseline=await commerce(f.store);
  await assert.rejects(f.adapter.media.resolve(captured.resources,{signal:new AbortController().signal,deadline:performance.now()-1}),{code:'MEDIA_DEADLINE'});const bad=structuredClone(captured.resources);bad.old[0].bytes[0]^=1;
  await assert.rejects(f.adapter.media.resolve(bad,{signal:new AbortController().signal,deadline:performance.now()+30000}),{code:'MEDIA_CODEC_FAILED'});assert.deepEqual(await commerce(f.store),baseline);
  const {value}=await f.draft(args),op=await seedCreateAdapterFrame(f,value);await f.store.run("UPDATE mcp_v2_media_manifest_page SET page_json='{}' WHERE operation_id=?",op.id);await assert.rejects(f.adapter.apply(f.store,op.proposal,op.applyContext),{code:'MEDIA_FRAME_INTEGRITY'});assert.deepEqual(await commerce(f.store),baseline);
 });
}
