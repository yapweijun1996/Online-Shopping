import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { addGalleryImage,getProduct,updateProduct } from '../src/products.js';
const photo=data=>'data:image/png;base64,'+data.toString('base64');
const dto=value=>value.data.result?.structuredContent;
async function graph(f){
  const holder=await f.make('HOLDER',png,{variantGroup:'LEGACY-GROUP',variantLabel:'A'});
  await addGalleryImage(f.store,holder.id,photo(Buffer.concat([png,Buffer.from('shared-second')])));
  const variant=await f.make('VARIANT',Buffer.concat([png,Buffer.from('own-main')]),{variantGroup:'LEGACY-GROUP',variantLabel:'B'});
  // Supported historical drift fixture, not an application mutation path.
  await f.store.run('UPDATE listing SET name=? WHERE id=?','Parent legacy copy',holder.listingId);
  await f.store.run('UPDATE product SET name=? WHERE id=?','Holder legacy copy',holder.id);
  await f.store.run('UPDATE product SET name=? WHERE id=?','Variant legacy copy',variant.id);
  return{holder,variant};
}
async function names(f,listingId){
  return{listing:(await f.store.get('SELECT name FROM listing WHERE id=?',listingId)).name,
    members:await f.store.all('SELECT id,name FROM product WHERE listing_id=? ORDER BY id',listingId)};
}
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: portal media-only edit preserves all legacy names while real metadata edits still synchronize`,options,async t=>{
  const f=await mediaToolsFixture(t,dialect),{holder,variant}=await graph(f),before=await names(f,holder.listingId);
  let current=await getProduct(f.store,holder.id,true);
  await updateProduct(f.store,holder.id,{gallery:current.galleryItems.map(({id})=>({id})).reverse(),expectedUpdatedAt:current.updatedAt});
  assert.deepEqual(await names(f,holder.listingId),before);
  current=await getProduct(f.store,variant.id,true);
  await updateProduct(f.store,variant.id,{gallery:[{id:'unknown-ignored-like-existing-portal'}],expectedUpdatedAt:current.updatedAt});
  assert.deepEqual(await names(f,holder.listingId),before);
  await updateProduct(f.store,holder.id,{name:'Approved shared metadata'});
  const changed=await names(f,holder.listingId);assert.equal(changed.listing,'Approved shared metadata');
  assert.ok(changed.members.every(item=>item.name==='Approved shared metadata'));
 });
 test(`${dialect}: MCP gallery-only commit preserves legacy names and audit failure rolls every media change back`,options,async t=>{
  const f=await mediaToolsFixture(t,dialect),{holder}=await graph(f),before=await names(f,holder.listingId);
  const listed=dto(await f.tool('media.list',{productId:holder.id})),current=await getProduct(f.store,holder.id,true),gallery=current.galleryItems.map(({id})=>({id})).reverse();
  const prepared=await f.tool('media.preview_layout',{input:{productId:holder.id,expectedRevision:listed.revision,gallery,removeMain:false},idempotencyKey:'synthetic-layout-copy'});
  assert.equal(prepared.response.status,200,JSON.stringify(prepared.data));await f.approve(dto(prepared));
  const original=f.store.run;
  f.store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO mcp_v2_event')&&args.includes('COMMIT'))throw new Error('Synthetic layout audit failure');return original(sql,...args);};
  let failed;try{failed=await f.tool('media.commit_layout',{operationId:dto(prepared).operationId});}finally{f.store.run=original;}
  assert.equal(failed.data.error.code,-32603);
  assert.deepEqual((await getProduct(f.store,holder.id,true)).galleryItems.map(item=>item.id),current.galleryItems.map(item=>item.id));
  assert.deepEqual(await names(f,holder.listingId),before);
  const retry=dto(await f.tool('media.preview_layout',{input:{productId:holder.id,expectedRevision:listed.revision,gallery,removeMain:false},idempotencyKey:'synthetic-layout-copy-retry'}));
  await f.approve(retry);const committed=await f.tool('media.commit_layout',{operationId:retry.operationId});
  assert.equal(dto(committed).status,'COMMITTED');assert.deepEqual(await names(f,holder.listingId),before);
  assert.deepEqual((await getProduct(f.store,holder.id,true)).galleryItems.map(item=>item.id),gallery.map(item=>item.id));
 });
}
