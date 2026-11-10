import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { catalogue } from '../src/mcp/tools.js';
import { getProduct, addGalleryImage } from '../src/products.js';
const dto = response => response.data.result?.structuredContent;
const parts = data => Array.from({length:Math.ceil(data.length/3072)},(_,n)=>data.subarray(n*3072,(n+1)*3072).toString('base64'));
const prepare = (f,input) => f.tool('media.prepare_upload',{input});
for(const dialect of ['sqlite','postgres']){
  const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
  test(`${dialect}: actual RPC media factory lists exactly six bounded tools and preserves legacy8`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),listed=await f.rpc('tools/list',{});
    assert.equal(listed.response.status,200,JSON.stringify(listed.data));
    assert.deepEqual(listed.data.result.tools.slice(0,8),catalogue.map(({scope:_scope,...tool})=>tool));
    assert.deepEqual(listed.data.result.tools.slice(8).map(tool=>tool.name),['media.list','media.prepare_upload','media.commit_upload','media.upload_file','media.preview_layout','media.commit_layout']);
    const media=await f.tool('media.list',{productId:f.product.id});
    assert.equal(media.response.status,200,JSON.stringify(media.data));assert.equal(dto(media).items[0].productId,f.product.id);
    assert.equal(dto(media).assets[0].mime,'image/png');assert.doesNotMatch(JSON.stringify(dto(media)),/data:image|imageDataUrl|thumbDataUrl|socketPath|tokenFile|stockQuantity|priceMinor/);
    const build=entries=>createOperationTools({store:f.store,binding:f.binding,config:f.config,tenantGuard:f.guard,quickLogin:false,entries});
    assert.throws(()=>build([{...f.entries[1],coordinator:{...f.coordinator}}]),TypeError);
    assert.throws(()=>build([{...f.entries[1],scope:'catalog.write'}]),TypeError);
    assert.throws(()=>build([{...f.entries[1],commitName:'company.commit_update'}]),TypeError);
    assert.throws(()=>build([f.entries[1],f.entries[1]]),TypeError);
  });
  test(`${dialect}: real RPC upload stage actions require protected HTTP review and commit once`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),source=Buffer.concat([png,Buffer.from('RPC-upload-new')]);
    const begun=await prepare(f,{action:'begin',...await f.input(source)});
    assert.equal(begun.response.status,200,JSON.stringify(begun.data));const stage=dto(begun).stage;assert.ok(stage.stageId);
    const ordinary=(await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n;
    const appended=await prepare(f,{action:'append',stageId:stage.stageId,offset:0,dataParts:parts(source)});
    assert.equal(appended.response.status,200,JSON.stringify(appended.data));assert.equal(dto(appended).stage.nextOffset,source.length);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n,ordinary);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-append'")).n,1);
    const sealed=await prepare(f,{action:'seal',stageId:stage.stageId,idempotencyKey:'synthetic-rpc-seal-0001'});
    assert.equal(sealed.response.status,200,JSON.stringify(sealed.data));const operation=dto(sealed).operation;assert.equal(operation.status,'PENDING_APPROVAL');
    assert.equal((await f.tool('media.commit_upload',{operationId:operation.operationId})).response.status,403);
    await f.approve(operation);
    const results=await Promise.all([0,1].map(()=>f.tool('media.commit_upload',{operationId:operation.operationId})));
    assert.deepEqual(results.map(value=>dto(value)?.replayed).sort(),[false,true]);
    assert.deepEqual(Object.keys(dto(results[0]).result).sort(),['listingId','productId','revision']);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'",operation.operationId)).n,1);
  });
  test(`${dialect}: real layout RPC reorders and removes only existing owned images`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect);await addGalleryImage(f.store,f.product.id,'data:image/png;base64,'+Buffer.concat([png,Buffer.from('other')]).toString('base64'));
    const listed=dto(await f.tool('media.list',{productId:f.product.id})),current=await getProduct(f.store,f.product.id,true),gallery=current.galleryItems.map(({id})=>({id})).reverse();
    const prepared=await f.tool('media.preview_layout',{input:{productId:f.product.id,expectedRevision:listed.revision,gallery,removeMain:false},idempotencyKey:'synthetic-layout-reorder-0001'});
    assert.equal(prepared.response.status,200,JSON.stringify(prepared.data));const operation=dto(prepared);assert.equal(operation.status,'PENDING_APPROVAL');
    await f.approve(operation);const committed=await f.tool('media.commit_layout',{operationId:operation.operationId});
    assert.equal(committed.response.status,200,JSON.stringify(committed.data));assert.equal(dto(committed).status,'COMMITTED');
    assert.deepEqual((await getProduct(f.store,f.product.id,true)).galleryItems.map(item=>item.id),gallery.map(item=>item.id));
    const next=dto(await f.tool('media.list',{productId:f.product.id}));
    const removed=await f.tool('media.preview_layout',{input:{productId:f.product.id,expectedRevision:next.revision,
      gallery:gallery.filter(item=>item.id!=='main'),removeMain:true},idempotencyKey:'synthetic-layout-remove-0001'});
    assert.equal(removed.response.status,200,JSON.stringify(removed.data));await f.approve(dto(removed));
    assert.equal(dto(await f.tool('media.commit_layout',{operationId:dto(removed).operationId})).status,'COMMITTED');
    assert.equal((await f.store.get('SELECT image_data FROM product WHERE id=?',f.product.id)).image_data,null);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',f.product.id)).stock_quantity,7);
  });
}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: only canonical APPEND bypasses ordinary120 and all successful attempts share persistent240`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await mediaToolsFixture(t,dialect),begun=dto(await prepare(f,{action:'begin',...await f.input(png)})).stage;
    const command={action:'append',stageId:begun.stageId,offset:0,dataParts:parts(png)};
    const ordinary=(await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n;
    for(let n=0;n<240;n++){
      const response=await prepare(f,command);assert.equal(response.response.status,200,JSON.stringify(response.data));
    }
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n,ordinary);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-append'")).n,240);
    assert.equal((await prepare(f,command)).response.status,429);
    const malformed=await prepare(f,{...command,dataParts:['AB==']});assert.equal(malformed.data.error.code,-32602);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp-call'")).n,ordinary+1);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-append'")).n,240);
    for(const input of [{...command,approved:true},{...command,tenantId:'other'},{...command,dataParts:['A'.repeat(4100)]}]){
      assert.equal((await prepare(f,input)).data.error.code,-32602);
    }
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  });
for(const dialect of ['sqlite','postgres'])test(`${dialect}: unknown resources, foreign references and disabled media return controlled errors`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await mediaToolsFixture(t,dialect),before=dto(await f.tool('media.list',{productId:f.product.id}));
    assert.equal((await f.tool('media.list',{productId:randomUUID()})).data.error.code,-32602);
    assert.equal((await prepare(f,{action:'begin',...await f.input(png),productId:randomUUID()})).data.error.code,-32602);
    const bad=await f.tool('media.preview_layout',{input:{productId:f.product.id,expectedRevision:before.revision,gallery:[{id:randomUUID()}],removeMain:false},idempotencyKey:'synthetic-foreign-gallery'});
    assert.equal(bad.data.error.code,-32602);
    const disabled=await mediaToolsFixture(t,dialect,{config:{mcpMedia:{enabled:false}}});
    const listed=await disabled.rpc('tools/list',{});assert.equal(listed.data.result.tools.length,8);
    assert.deepEqual(listed.data.result.tools,catalogue.map(({scope:_scope,...tool})=>tool));
    assert.equal((await disabled.tool('media.list',{productId:disabled.product.id})).data.error.code,-32602);
    assert.equal((await disabled.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  });
