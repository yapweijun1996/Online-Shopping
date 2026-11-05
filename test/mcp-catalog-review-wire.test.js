import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaManifest } from '../src/mcp/media-manifest.js';
import { catalogReviewLabels,assertCatalogReviewBinding,catalogMediaReviewBinding,catalogMediaGraphBytes } from '../src/mcp/catalog-media-review-wire.js';
import { catalogWireInput,wireProposal,wireEnvelope,wireId,directWireInput } from './helpers/mcp-catalog-wire-fixture.js';
test('C wire binds physical main/literal labels/nullable listings without separate view records',()=>{
 const value=buildMediaManifest(catalogWireInput()),product=value.effects.find(row=>row.kind==='PRODUCT');
 assert.equal(value.effects.length,3);assert.equal(value.stages.length,0);assert.equal(product.before.mainAssetKey,product.after.mainAssetKey);assert.equal(product.after.ownMainVisible,false);
 assert.deepEqual(assertCatalogReviewBinding(wireEnvelope(value),value),wireProposal(value).reviewLabels);
 assert.ok(value.effects.some(row=>row.kind==='LISTING'&&row.before===null));assert.ok(value.effects.some(row=>row.kind==='LISTING'&&row.after===null));
});
test('C rejects malformed visibility/labels/new products/stages rather than guessing DIRECT fields',()=>{
 for(const mutate of [
  value=>{delete value.effects[0].before.ownMainVisible;},value=>{value.effects[0].after.ownMainVisible='false';},
  value=>{value.effects[0].after.mainAssetKey=null;value.effects[0].after.ownMainVisible=true;},value=>{value.effects[0].before=null;},
  value=>{delete value.effects[0].labels;},value=>{value.effects[0].labels.after.name='\ud800';},value=>{value.effects[0].labels.before.extra=true;},
  value=>{value.effects[0].after.extra=false;},value=>{value.graphBytes.newBytes=1;},
  value=>{const asset=value.assets[0];asset.source_kind='STAGE';asset.source_id=asset.stage_id=wireId(9);},
 ]){const value=catalogWireInput();mutate(value);assert.throws(()=>buildMediaManifest(value),TypeError);}
 const value=buildMediaManifest(catalogWireInput()),envelope=wireEnvelope(value);
 for(const rows of [[],[...envelope.proposal.reviewLabels,...envelope.proposal.reviewLabels],[{...envelope.proposal.reviewLabels[0],productId:wireId(8)}]])assert.throws(()=>assertCatalogReviewBinding({...envelope,proposal:{...envelope.proposal,reviewLabels:rows}},value),TypeError);
 const changed=structuredClone(envelope);changed.proposal.reviewLabels[0].after.name='Forged after label';assert.throws(()=>assertCatalogReviewBinding(changed,value),TypeError);
});
test('DIRECT retains pinned ce1e13c canonical page/root bytes and rejects C-only fields',()=>{
 const input=directWireInput(),manifest=buildMediaManifest(input);
 // Generated independently from git show ce1e13c:src/mcp/media-manifest.js.
 assert.equal(manifest.pages[0].page_hash,'ba95b4a43c53229c32fdfbdb6acab33736653807c0667f533bec743a8787b92c');
 assert.equal(manifest.descriptor.manifestRoot,'4e4c63042c776dcb9cf891371d99e44d6aefbb6984b022c1712a110742e35af2');
 assert.deepEqual(Object.keys(manifest.descriptor),['assetCount','codecDigest','effectCount','graphRevision','manifestRoot','pageCount','policyId']);
 input.effects[0].before.ownMainVisible=true;assert.throws(()=>buildMediaManifest(input),TypeError);
 delete input.effects[0].before.ownMainVisible;input.effects[0].labels=catalogWireInput().effects[0].labels;assert.throws(()=>buildMediaManifest(input),TypeError);
});
test('complete300-product C labels and visibility stay within old record/page limits, oversize text rejects503',()=>{
 const input=catalogWireInput(),listing=wireId(999);input.assets=[];input.graphBytes={oldBytes:0,newBytes:0};
 input.effects=Array.from({length:300},(_,n)=>({kind:'PRODUCT',productId:wireId(n+1),
  before:{listingId:listing,role:n?'variant':'holder',mainAssetKey:null,ownMainVisible:false},
  after:{listingId:listing,role:n?'variant':'holder',mainAssetKey:null,ownMainVisible:false},
  labels:{before:{sku:'S'+n,name:'Name '+n},after:{sku:'S'+n,name:'Name '+n}}}));
 input.effects.push({kind:'LISTING',listingId:listing,before:{holderId:wireId(1),galleryAssetKeys:[]},after:{holderId:wireId(1),galleryAssetKeys:[]}});
 const manifest=buildMediaManifest(input);assert.equal(manifest.effects.length,301);assert.equal(manifest.assets.length,0);assert.ok(manifest.pages.length<=16);
 assert.ok(manifest.pages.every(page=>Buffer.byteLength(page.page_json)<=16384));assert.equal(manifest.pages.reduce((sum,page)=>sum+page.record_count,0),301);
 assert.equal(catalogReviewLabels(wireProposal(manifest).reviewLabels).length,300);
 for(const row of input.effects.filter(value=>value.kind==='PRODUCT'))row.labels.before.name=row.labels.after.name='漢'.repeat(120);
 assert.throws(()=>buildMediaManifest(input),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
});
test('composite binds every literal visibility position through bounded records without whole-graph envelope serialization',()=>{
 const labels=Array.from({length:300},(_,n)=>({productId:wireId(n+1),before:{sku:'S'+n,name:'N'+n},after:{sku:'S'+n,name:'N'+n}}));
 const views=labels.map((row,n)=>({productId:row.productId,role:n?'variant':'holder',holderId:wireId(1),
  visible:[{id:'main',assetKey:'a'.repeat(64),shared:false},...Array.from({length:10},(_,i)=>({id:wireId(1000+i),assetKey:String(i).repeat(64),shared:true}))]}));
 const input={productId:wireId(1),baseRevision:'b'.repeat(64),reviewLabels:labels,beforeViews:views,afterViews:structuredClone(views)};
 const original=catalogMediaReviewBinding(input);assert.equal(original.revision.length,64);
 assert.equal(original.reviewBinding.version,1);assert.equal(original.reviewBinding.baseRevision,input.baseRevision);
 for(const mutate of [value=>{value.baseRevision='c'.repeat(64);},value=>{value.afterViews[299].visible.reverse();},
  value=>{value.beforeViews[299].visible[10].assetKey='f'.repeat(64);},value=>{value.reviewLabels[299].after.name='Changed literal';}]){
  const changed=structuredClone(input);mutate(changed);assert.notEqual(catalogMediaReviewBinding(changed).revision,original.revision);
 }
 for(const mutate of [value=>value.afterViews.pop(),value=>{value.afterViews[1].productId=value.afterViews[0].productId;},
  value=>{value.beforeViews[0].visible[0].shared=true;},value=>{value.afterViews[1].extra=true;},
  value=>{value.beforeViews[0].visible.push({id:wireId(9000),assetKey:'f'.repeat(64),shared:true});}]){
  const changed=structuredClone(input);mutate(changed);assert.throws(()=>catalogMediaReviewBinding(changed),TypeError);
 }
 const accessor=structuredClone(input);Object.defineProperty(accessor.afterViews,'0',{enumerable:true,get(){throw new Error('Getter must not run');}});
 assert.throws(()=>catalogMediaReviewBinding(accessor),TypeError);
 const manifest=buildMediaManifest(catalogWireInput()),envelope=wireEnvelope(manifest);
 for(const key of ['baseRevision','reviewProjectionHash']){const changed=structuredClone(envelope);changed.proposal.reviewBinding[key]='f'.repeat(64);assert.throws(()=>assertCatalogReviewBinding(changed,manifest),TypeError);}
});
test('shared catalog byte mapper bounds both physical sides and conservatively covers copy/thumbnail growth',()=>{
 assert.deepEqual(catalogMediaGraphBytes({beforeOldBytes:10,afterOldBytes:15}),{oldBytes:15,newBytes:0});
 assert.deepEqual(catalogMediaGraphBytes({beforeOldBytes:15,afterOldBytes:10}),{oldBytes:15,newBytes:0});
 for(const value of [{beforeOldBytes:-1,afterOldBytes:0},{beforeOldBytes:0,afterOldBytes:0,extra:true}])assert.throws(()=>catalogMediaGraphBytes(value),TypeError);
 for(const value of [{beforeOldBytes:16777217,afterOldBytes:0},{beforeOldBytes:0,afterOldBytes:16777217}])assert.throws(()=>catalogMediaGraphBytes(value),{status:503,code:'CATALOG_REVIEW_TOO_LARGE'});
});
