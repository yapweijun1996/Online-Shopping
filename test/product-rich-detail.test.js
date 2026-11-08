import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { sellerFixture } from './helpers/seller-app.js';
import { getProduct, updateProduct } from '../src/products.js';
import { getProductDetail, saveProductDetail, stageProductDetailImage, getProductDetailImage, discardProductDetailImage, normalizeDetailDocument, detailImageDimensions } from '../src/product-detail.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { catalogUpdateRevision } from '../src/mcp/catalog-tools.js';
import { readCatalogCreateMediaMetadata } from '../src/mcp/catalog-create-media-state.js';
import { decodeProductImage } from '../src/product-image.js';
import { migrateStore, ready, SCHEMA_VERSION } from '../src/db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { productDetailStorageReady, assertProductDetailStorage } from '../src/product-detail-schema.js';
import { operationStorageReady } from '../src/mcp/operation-runtime.js';
import { inventoryStorageReady } from '../src/inventory-schema.js';
import { rowsDigest, importTables } from '../src/sqlite-import.js';

const photo = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');
const paragraph = text => ({ version: 1, blocks: [{ type: 'paragraph', text }] });
const save = async (store, productId, document) => saveProductDetail(store, productId, { expectedRevision: (await getProductDetail(store, productId, true)).revision, document }, 'synthetic_owner');
const selectedImage = (id, caption = '') => ({ type:'image', assetId:id, alt:'An example image', caption });

for (const dialect of ['sqlite','postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: rich detail is shared, staged images private, committed only on CAS save and explicitly removed`, options, async t => {
    const f = await inventoryFixture(t, dialect), p = await f.product({ variantGroup:'DETAIL', variantLabel:'One' });
    const sibling = await f.product({ variantGroup:'DETAIL', variantLabel:'Two' });
    const initial = await getProductDetail(f.store,p.id,true);
    assert.equal(initial.document.blocks.length,0); assert.match(initial.revision,/^[0-9a-f]{64}$/);
    const updatedAt = (await getProduct(f.store,p.id,true)).updatedAt;
    const staged = await stageProductDetailImage(f.store,p.id,{imageDataUrl:photo});
    assert.equal(staged.width,192); assert.equal(staged.height,192);
    assert.equal((await getProductDetail(f.store,p.id)).assets.length,0);
    await assert.rejects(()=>getProductDetailImage(f.store,p.id,staged.id),{status:404});
    assert.equal((await getProductDetailImage(f.store,p.id,staged.id,true)).mime,'image/png');
    const document = {version:1,blocks:[{type:'heading',text:'Usage'}, {type:'paragraph',text:'<script>alert(1)</script>',bold:true}, {type:'list',items:['One','Two']}, selectedImage(staged.id), {type:'specs',rows:[{label:'Size',value:'Small'}]}]};
    const saved = await saveProductDetail(f.store,p.id,{expectedRevision:initial.revision,document},'synthetic_owner');
    assert.notEqual(saved.revision,initial.revision); assert.equal(saved.assets[0].id,staged.id);
    const shared = await getProductDetail(f.store,sibling.id);
    assert.deepEqual(shared.document,document); assert.match(shared.assets[0].src,new RegExp(sibling.id));
    assert.equal((await getProduct(f.store,p.id,true)).updatedAt,updatedAt);
    await assert.rejects(()=>saveProductDetail(f.store,p.id,{expectedRevision:initial.revision,document:paragraph('stale')},'synthetic_owner'),{code:'DETAIL_CHANGED'});
    assert.deepEqual((await getProductDetail(f.store,p.id)).document,document);
    await updateProduct(f.store,p.id,{active:false});
    await assert.rejects(()=>getProductDetailImage(f.store,p.id,staged.id),{status:404});
    assert.equal((await getProductDetailImage(f.store,sibling.id,staged.id)).mime,'image/png');
    await save(f.store,sibling.id,paragraph('Replacement'));
    await assert.rejects(()=>getProductDetailImage(f.store,sibling.id,staged.id,true),{status:404});
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id = ?',p.id)).n,1);
  });
  test(`${dialect}: foreign images, expired stages and concurrent stale edits fail without changing stored document`,options,async t=>{
    const f=await inventoryFixture(t,dialect),a=await f.product(),b=await f.product();
    const asset=await stageProductDetailImage(f.store,a.id,{imageDataUrl:photo});
    await assert.rejects(()=>getProductDetailImage(f.store,b.id,asset.id,true),{status:404});
    await assert.rejects(()=>save(f.store,b.id,{version:1,blocks:[selectedImage(asset.id)]}),{field:'document'});
    assert.equal((await getProductDetail(f.store,b.id,true)).document.blocks.length,0);
    const revision=(await getProductDetail(f.store,a.id,true)).revision;
    const race=await Promise.allSettled(['first','second'].map(value=>saveProductDetail(f.store,a.id,{expectedRevision:revision,document:paragraph(value)},'synthetic_owner')));
    assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(race.find(result=>result.status==='rejected').reason.code,'DETAIL_CHANGED');
    await f.store.run('UPDATE listing_detail_image SET created_at = ? WHERE id = ?','2000-01-01T00:00:00.000Z',asset.id);
    await assert.rejects(()=>getProductDetailImage(f.store,a.id,asset.id,true),{status:404});
    await assert.rejects(()=>save(f.store,a.id,{version:1,blocks:[selectedImage(asset.id)]}),{field:'document'});
    assert.equal((await getProductDetail(f.store,a.id,true)).document.blocks[0].type,'paragraph');
  });
  test(`${dialect}: rich shared detail blocks membership changes atomically, unchanged group edits work, membership invalidates old revision`,options,async t=>{
    const f=await inventoryFixture(t,dialect),a=await f.product({variantGroup:'SHARED',variantLabel:'One'});
    const before=await getProductDetail(f.store,a.id,true);
    await f.product({variantGroup:'SHARED',variantLabel:'Two'});
    await assert.rejects(()=>saveProductDetail(f.store,a.id,{expectedRevision:before.revision,document:paragraph('stale membership')},'synthetic_owner'),{code:'DETAIL_CHANGED'});
    await save(f.store,a.id,paragraph('Shared detail'));
    await updateProduct(f.store,a.id,{variantGroup:'SHARED',variantLabel:'One',description:'Updated summary'});
    await assert.rejects(()=>updateProduct(f.store,a.id,{variantGroup:null,variantLabel:null}),{code:'DETAIL_MEMBERSHIP_CONFLICT'});
    const current=await getProduct(f.store,a.id,true);assert.equal(current.variantGroup,'SHARED');
    assert.equal((await getProductDetail(f.store,a.id,true)).document.blocks[0].text,'Shared detail');
    const other=await f.product();
    await assert.rejects(()=>updateProduct(f.store,other.id,{variantGroup:'SHARED',variantLabel:'Three'}),{code:'DETAIL_MEMBERSHIP_CONFLICT'});
    assert.equal((await getProduct(f.store,other.id,true)).variantGroup,null);
    await save(f.store,a.id,{version:1,blocks:[]});
    await updateProduct(f.store,a.id,{variantGroup:null,variantLabel:null});
    assert.equal((await getProductDetail(f.store,a.id,true)).document.blocks.length,0);
  });
  test(`${dialect}: protected catalog graph and metadata revisions reject rich detail, inventory unaffected`,options,async t=>{
    const f=await inventoryFixture(t,dialect),p=await f.product({variantGroup:'GUARDED',variantLabel:'One'});
    const initial=await readMediaSnapshot(f.store,p.id);assert.ok(initial.revision);
    await save(f.store,p.id,paragraph('Protected rich detail'));
    await assert.rejects(()=>readMediaSnapshot(f.store,p.id),{code:'CATALOG_RICH_DETAIL_UNSUPPORTED'});
    await assert.rejects(()=>catalogUpdateRevision(f.store,p.id),{code:'CATALOG_RICH_DETAIL_UNSUPPORTED'});
    await assert.rejects(()=>readCatalogCreateMediaMetadata(f.store,{normalizedInput:{sku:'NEW',name:'Example',description:'Example',category:'TEST',priceMinor:500,currency:'MYR',active:true,variantGroup:'GUARDED',variantLabel:'Two'},creationIdentity:{version:1,productId:randomUUID(),targetCode:'GUARDED',targetListingId:p.listingId,newListingId:null}}),{code:'CATALOG_RICH_DETAIL_UNSUPPORTED'});
    assert.equal(await operationStorageReady(f.store),true);assert.equal(await inventoryStorageReady(f.store),true);
  });
  test(`${dialect}: staged discard frees quota but cannot delete live, foreign, or concurrently committed assets`,options,async t=>{
    const f=await inventoryFixture(t,dialect),p=await f.product(),other=await f.product();
    const asset=await stageProductDetailImage(f.store,p.id,{imageDataUrl:photo});
    await assert.rejects(()=>discardProductDetailImage(f.store,other.id,asset.id),{status:404});
    assert.deepEqual(await discardProductDetailImage(f.store,p.id,asset.id),{deleted:true});
    await assert.rejects(()=>getProductDetailImage(f.store,p.id,asset.id,true),{status:404});
    const live=await stageProductDetailImage(f.store,p.id,{imageDataUrl:photo});
    await save(f.store,p.id,{version:1,blocks:[selectedImage(live.id)]});
    await assert.rejects(()=>discardProductDetailImage(f.store,p.id,live.id),{code:'DETAIL_IMAGE_IN_USE'});
    assert.ok((await getProductDetailImage(f.store,p.id,live.id)).data.length);
  });
  test(`${dialect}: rich detail readiness rejects missing indexes and altered constraints`,options,async t=>{
    const f=await inventoryFixture(t,dialect);assert.equal(await productDetailStorageReady(f.store),true);
    await f.store.exec('DROP INDEX listing_detail_image_owner');
    assert.equal(await productDetailStorageReady(f.store),false);assert.equal(await ready(f.store),false);
    await assert.rejects(()=>assertProductDetailStorage(f.store),/Incompatible rich detail/);
  });
  test(`${dialect}: schema34 backup fixture upgrades additively and reruns without rewriting historical rows`,options,async t=>{
    const f=await inventoryFixture(t,dialect);await f.product();
    const tables=importTables.filter(table=>!['listing_detail','listing_detail_image'].includes(table));
    const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,rowsDigest(await f.store.all(`SELECT * FROM ${table}`))])));
    const before=await snapshot();
    await f.store.exec('DROP TABLE listing_detail_image; DROP TABLE listing_detail;');await f.store.setSchemaVersion(34);
    const migrate=()=>dialect==='sqlite'?migrateStore(f.store):f.store.transaction(()=>upgradePostgres(f.store,34));
    await migrate();assert.equal(await f.store.schemaVersion(),SCHEMA_VERSION);assert.equal(await ready(f.store),true);assert.deepEqual(await snapshot(),before);
    await migrate();assert.deepEqual(await snapshot(),before);
    // Isolated pre-traffic rollback rehearsal only: no schema35 business rows.
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM listing_detail')).n,0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM listing_detail_image')).n,0);
    await f.store.exec('DROP TABLE listing_detail_image; DROP TABLE listing_detail;');await f.store.setSchemaVersion(34);
    assert.equal(await operationStorageReady(f.store),true);assert.equal(await inventoryStorageReady(f.store),true);assert.deepEqual(await snapshot(),before);
    await migrate();assert.deepEqual(await snapshot(),before);assert.equal(await ready(f.store),true);
  });
}

test('rich detail HTTP checks authentication, capability, Origin, CSRF and does not expose draft assets',async t=>{
  const f=await sellerFixture();t.after(()=>f.close());const endpoint=`/api/v1/seller/products/${f.product.id}/detail`,pub=`/api/v1/products/${f.product.id}/detail`;
  assert.equal((await f.request('GET',endpoint)).response.status,401);
  const auth=await f.login();
  const initial=await f.request('GET',endpoint,null,auth.headers);assert.equal(initial.response.status,200);
  const payload={expectedRevision:initial.data.revision,document:paragraph('HTTP detail')};
  for(const headers of [{cookie:auth.cookie},{origin:f.origin,cookie:auth.cookie},{...auth.headers,origin:'https://invalid.example'}])assert.equal((await f.request('PUT',endpoint,payload,headers)).response.status,403);
  assert.equal((await f.request('PUT',endpoint,payload,auth.headers)).response.status,200);
  assert.equal((await f.request('GET',pub)).data.document.blocks[0].text,'HTTP detail');
  const stage=await f.request('POST',`${endpoint}/images`,{imageDataUrl:photo},auth.headers);assert.equal(stage.response.status,201);
  assert.equal((await f.request('GET',`${pub}/images/${stage.data.id}`)).response.status,404);
  const account=await f.request('POST','/api/v1/seller/accounts',{username:'detail_staff',password:'SyntheticStaffPassword123!',role:'STAFF'},auth.headers);assert.equal(account.response.status,201);
  const staff=await f.login('detail_staff','SyntheticStaffPassword123!');
  assert.equal((await f.request('PUT',endpoint,payload,staff.headers)).response.status,403);
  assert.equal((await f.request('POST',`${endpoint}/images`,{imageDataUrl:photo},staff.headers)).response.status,403);
});

test('rich detail rejects executable attributes, unknown formats, unbounded text and missing accessible alt',()=>{
  const bad=[{version:1,blocks:[],html:'<p>bad</p>'},{version:2,blocks:[]},{version:1,blocks:[{type:'html',html:'<script>bad</script>'}]},{version:1,blocks:[{type:'paragraph',text:'ok',onclick:'bad'}]},{version:1,blocks:[{type:'image',src:'https://example.invalid/img.png',alt:'bad',caption:''}]},{version:1,blocks:[selectedImage(randomUUID()),...Array.from({length:40},()=>({type:'heading',text:'x'}))]},{version:1,blocks:[{...selectedImage(randomUUID()),alt:''}]},paragraph('x'.repeat(5001))];
  for(const document of bad)assert.throws(()=>normalizeDetailDocument(document),{field:'document'});
  assert.equal(normalizeDetailDocument(paragraph('<img src=x onerror=alert(1)>')).blocks[0].text,'<img src=x onerror=alert(1)>');
  assert.throws(()=>detailImageDimensions(decodeProductImage('data:image/png;base64,iVBORw0KGgo=')),{field:'imageDataUrl'});
});
