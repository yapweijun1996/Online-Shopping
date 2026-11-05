import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaManifest,readMediaManifest,mediaManifestRows } from '../src/mcp/media-manifest.js';
import { catalogMediaReviewBinding,catalogReviewLabels,assertCatalogReviewBinding } from '../src/mcp/catalog-media-review-wire.js';
import { createWireInput,createWireIdentity,createWireBinding,createWireEnvelope } from './helpers/mcp-catalog-create-wire-fixture.js';
import { wireId,catalogWireInput } from './helpers/mcp-catalog-wire-fixture.js';
test('CREATE EMPTY requires two null-before effects and at least one bound canonical page with zero assets',()=>{
 const input=createWireInput(),manifest=buildMediaManifest(input),envelope=createWireEnvelope(manifest);
 assert.equal(manifest.pages.length,1);assert.equal(manifest.effects.length,2);assert.equal(manifest.assets.length,0);assert.equal(manifest.stages.length,0);
 assert.equal(assertCatalogReviewBinding(envelope,manifest).find(row=>row.productId===wireId(10)).before,null);
 const context={operationId:wireId(99),toolName:input.toolName,createdAt:'2026-11-05T00:00:00.000Z',expiresAt:'2026-11-05T00:10:00.000Z'};
 const operation={id:context.operationId,tool_name:input.toolName,media_policy_id:'catalog-media-v1',required_scope:'catalog.write',required_capability:'catalog.write',risk:'HIGH',created_at:context.createdAt,expires_at:context.expiresAt};
 assert.deepEqual(readMediaManifest(mediaManifestRows(manifest,context),operation),manifest);
});
test('CREATE existing target has exact complete old/new union and only old BEFORE asset owners',()=>{
 const input=createWireInput(true),manifest=buildMediaManifest(input),envelope=createWireEnvelope(manifest,createWireIdentity(true));
 assert.equal(manifest.assets.length,1);assert.equal(manifest.effects.length,3);assert.equal(manifest.assets[0].source_product_id,wireId(1));assert.equal(manifest.effects.find(row=>row.productId===wireId(10)).after.ownMainVisible,false);
 assert.equal(assertCatalogReviewBinding(envelope,manifest).length,2);
});
test('CREATE rejects toy fields stage aliases extra resources old mutations and mismatched nullness',()=>{
 for(const mutate of [value=>{delete value.effects[0].labels;},value=>{delete value.effects[0].after.ownMainVisible;},value=>{value.effects[0].labels.before={sku:'FAKE',name:'Fake before'};},
  value=>{value.effects[0].after.ownMainVisible=true;},value=>{value.effects.push(structuredClone(value.effects[1]));value.effects.at(-1).listingId=wireId(77);},value=>{value.graphBytes.newBytes=1;}]){const value=createWireInput();mutate(value);assert.throws(()=>buildMediaManifest(value));}
 for(const mutate of [value=>{value.effects[0].after.mainAssetKey=null;},value=>{value.effects[0].labels.after.sku='Edited old SKU';},value=>{value.effects[0].after.listingId=wireId(77);},
  value=>{value.effects[0].before=null;value.effects[0].labels.before=null;},value=>{value.assets[0].source_product_id=value.assets[0].source_id=wireId(10);},value=>{const asset=value.assets[0];asset.source_kind='STAGE';asset.source_id=asset.stage_id=wireId(77);}]){const value=createWireInput(true);mutate(value);assert.throws(()=>buildMediaManifest(value));}
});
test('CREATE binding has actual BEFORE subset and AFTER complete set, rejects fake new BEFORE views and UPDATE downgrade',()=>{
 const identity=createWireIdentity(),input=createWireInput(),labels=input.effects.filter(row=>row.kind==='PRODUCT').map(row=>({productId:row.productId,...row.labels})),afterViews=[{productId:identity.productId,role:'single',holderId:null,visible:[]}];
 const request={toolName:'catalog.preview_create',creationIdentity:identity,baseRevision:'1'.repeat(64),reviewLabels:labels,beforeViews:[],afterViews};
 assert.equal(catalogMediaReviewBinding(request).revision,input.graphRevision);
 for(const change of [{beforeViews:afterViews},{afterViews:[]},{creationIdentity:{...identity,productId:wireId(77)}},{toolName:'catalog.preview_update'}])assert.throws(()=>catalogMediaReviewBinding({...request,...change}));
 assert.throws(()=>catalogReviewLabels(labels));assert.deepEqual(catalogReviewLabels(labels,'catalog.preview_create'),labels);
 const update=catalogWireInput();assert.throws(()=>buildMediaManifest({...update,toolName:'catalog.preview_create'}));assert.notEqual(createWireBinding(input.effects,{...identity,newListingId:wireId(77)}).revision,input.graphRevision);
});
test('CREATE independently compares literal page labels root identity final metadata and option pair display',()=>{
 const manifest=buildMediaManifest(createWireInput()),envelope=createWireEnvelope(manifest);
 for(const mutate of [value=>value.resourceType='product',value=>value.resourceId=wireId(10),value=>value.risk='MEDIUM',value=>value.proposal.creationIdentity.productId=wireId(77),value=>value.proposal.after.sku='Unbound',value=>value.proposal.reviewLabels[0].after.name='Unbound',value=>value.proposal.before={},value=>value.proposal.after.options.push({typeId:wireId(50),valueId:wireId(51)})]){const value=structuredClone(envelope);mutate(value);assert.throws(()=>assertCatalogReviewBinding(value,manifest));}
});
test('CREATE joint300 includes the new member and rejects301 without changing page caps',()=>{
 const input=createWireInput(),identity=createWireIdentity(true),listing=wireId(2);
 input.effects=Array.from({length:299},(_,n)=>({kind:'PRODUCT',productId:wireId(1000+n),before:{listingId:listing,role:n?'variant':'holder',mainAssetKey:null,ownMainVisible:false},
  after:{listingId:listing,role:n?'variant':'holder',mainAssetKey:null,ownMainVisible:false},labels:{before:{sku:'S'+n,name:'Name'},after:{sku:'S'+n,name:'Name'}}}));
 input.effects.push({kind:'PRODUCT',productId:identity.productId,before:null,after:{listingId:listing,role:'variant',mainAssetKey:null,ownMainVisible:false},labels:{before:null,after:{sku:'NEW',name:'Name'}}},
  {kind:'LISTING',listingId:listing,before:{holderId:wireId(1000),galleryAssetKeys:[]},after:{holderId:wireId(1000),galleryAssetKeys:[]}});
 input.graphRevision=createWireBinding(input.effects,identity).revision;const manifest=buildMediaManifest(input);assert.equal(manifest.effects.length,301);assert.equal(manifest.assets.length,0);assert.ok(manifest.pages.length>=1&&manifest.pages.length<=16);assert.ok(manifest.pages.every(row=>Buffer.byteLength(row.page_json)<=16384));
 const extra=structuredClone(input.effects[0]);extra.productId=wireId(2000);extra.before.role=extra.after.role='variant';input.effects.push(extra);assert.throws(()=>buildMediaManifest(input));
});
test('UPDATE retains independently generated a695e8a revision page and root bytes',()=>{
 const manifest=buildMediaManifest(catalogWireInput());
 // Compared against the actual frozen a695e8a wire+manifest source in private
 // temporary modules, not regenerated from this implementation's expected data.
 assert.equal(manifest.descriptor.graphRevision,'c77461f43162b8718f0cbbd56e927c8c690b0f7af1ec8b457acf10154929834c');
 assert.deepEqual(manifest.pages.map(row=>row.page_hash),['881d0a0eb7fbfe1cc22f877a4666155a23e694700541fb5fb04b87d81e16ae99']);
 assert.equal(manifest.descriptor.manifestRoot,'9ef9909c835f2d6ad68fd7efcd2bbbeb637252432d08e59b6af717c6657830fb');
});
