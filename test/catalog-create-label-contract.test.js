import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { createOptionType,createOptionValue } from '../src/options.js';
import { preparePlannedProductCreate,applyPlannedProductCreate,updateProduct } from '../src/products.js';
import { readCatalogCreateMediaMetadata,readCatalogCreateMediaState } from '../src/mcp/catalog-create-media-state.js';
import { projectCatalogMediaCreate } from '../src/mcp/catalog-media-projection.js';
import { canonicalOperationJson } from '../src/mcp/operation-envelope.js';
const input=(extra={})=>({sku:'SYNTHETIC-LABEL',name:'Synthetic',description:'Synthetic',category:'TEST',priceMinor:500,currency:'MYR',active:true,variantGroup:'LABEL',variantLabel:'Canonical manual base',...extra});
const identity=target=>({version:1,productId:randomUUID(),targetCode:'LABEL',targetListingId:target?.listingId??null,newListingId:target?null:randomUUID()});
async function choices(store,first,second){const a=await createOptionType(store,{name:'A',position:1}),b=await createOptionType(store,{name:'B',position:2});
 const av=await createOptionValue(store,a.id,{label:first}),bv=await createOptionValue(store,b.id,{label:second});return [{typeId:a.id,valueId:av.id},{typeId:b.id,valueId:bv.id}];}
for(const dialect of ['sqlite','postgres']){const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 for(const edge of ['trailing-space','unicode-clip'])test(`${dialect}: canonical request and final preparation remain distinct at ${edge}`,options,async t=>{
  const f=await inventoryFixture(t,dialect),selected=await choices(f.store,'A'.repeat(edge==='trailing-space'?79:76),edge==='trailing-space'?'B':'😀'),request={normalizedInput:input({options:selected}),creationIdentity:identity()};
  const captured=await readCatalogCreateMediaState(f.store,request),projection=await projectCatalogMediaCreate(f.store,captured);
  assert.deepEqual(captured.normalizedInput,request.normalizedInput);assert.equal(captured.normalizedInput.variantLabel,'Canonical manual base');assert.notEqual(captured.preparedInput.variantLabel,captured.normalizedInput.variantLabel);
  assert.equal(captured.preparedInput.variantLabel.length,80);assert.equal(captured.preparedInput.variantLabel.isWellFormed(),true);assert.equal(captured.preparedInput.variantLabel.endsWith(edge==='trailing-space'?' ':'�'),true);
  assert.equal(Object.isFrozen(captured.normalizedInput),true);assert.equal(Object.isFrozen(captured.preparedInput),true);
  const preimage={version:1,kind:'catalog-media-create',catalogRevision:captured.catalogRevision,mediaRevision:captured.mediaRevision,
   identity:captured.creationIdentity,prepared:captured.preparedInput,after:captured.after,optionReview:captured.optionReview,order:[]};
  assert.equal(captured.revision,createHash('sha256').update(canonicalOperationJson(preimage)).digest('hex'));
  const replay=await readCatalogCreateMediaState(f.store,{normalizedInput:captured.normalizedInput,creationIdentity:captured.creationIdentity});assert.equal(replay.revision,captured.revision);
  if(edge==='trailing-space')await assert.rejects(readCatalogCreateMediaState(f.store,{normalizedInput:captured.preparedInput,creationIdentity:captured.creationIdentity}),{code:'CATALOG_CREATE_MEDIA_INPUT'});
  const bad=structuredClone(captured);bad.preparedInput.variantLabel='Forged prepared label';await assert.rejects(projectCatalogMediaCreate(f.store,bad),{code:'MEDIA_PROJECTION_CHANGED'});
  const actual=await applyPlannedProductCreate(f.store,captured.normalizedInput,captured.creationIdentity);
  assert.equal(actual.variantLabel,captured.preparedInput.variantLabel);assert.equal(actual.variantLabel,projection.newProduct.after.variantLabel);
  assert.deepEqual(actual.options.map(row=>({typeId:row.type.id,valueId:row.value.id})),selected);
 });
 test(`${dialect}: canonical base-label validation is preserved before otherwise valid derived choices`,options,async t=>{
  const f=await inventoryFixture(t,dialect),holder=await f.product({variantGroup:'LABEL',variantLabel:'Existing manual'}),selected=await choices(f.store,'Red','Small'),request={normalizedInput:input({options:selected}),creationIdentity:identity(holder)};
  const captured=await readCatalogCreateMediaState(f.store,request);assert.equal(captured.normalizedInput.variantLabel,'Canonical manual base');assert.equal(captured.preparedInput.variantLabel,'Red / Small');
  await updateProduct(f.store,holder.id,{variantLabel:'Canonical manual base'});
  assert.notEqual((await readCatalogCreateMediaMetadata(f.store,request)).revision,captured.catalogRevision);
  for(const work of [()=>readCatalogCreateMediaState(f.store,request),()=>applyPlannedProductCreate(f.store,captured.normalizedInput,captured.creationIdentity),()=>projectCatalogMediaCreate(f.store,captured)])await assert.rejects(work(),error=>error.code==='DUPLICATE_VARIANT'&&error.field==='variantLabel');
  // Passing a final label as new intent could evade that intermediate check.
  // The contract therefore never substitutes preparedInput for normalizedInput.
  assert.equal((await preparePlannedProductCreate(f.store,captured.preparedInput,captured.creationIdentity)).variantLabel,'Red / Small');
  assert.equal(await f.store.get('SELECT id FROM product WHERE id=?',captured.creationIdentity.productId),undefined);
 });
}
