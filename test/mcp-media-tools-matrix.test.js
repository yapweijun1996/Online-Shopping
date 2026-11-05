import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { getProduct, addGalleryImage, updateProduct, setProductThumbnail } from '../src/products.js';
import { catalogue } from '../src/mcp/tools.js';
import { valid } from '../src/mcp/tools.js';
import { mediaListOutput } from '../src/mcp/media-contracts.js';

// Actual Request -> createApi -> live authority -> real services/stores. Only
// the decoder/initial consent fixture is synthetic; browser/native proof is separate.
const dto = response => response.data.result?.structuredContent;
const photo = bytes => 'data:image/png;base64,' + bytes.toString('base64');
const prepare = (f,input) => f.tool('media.prepare_upload',{input});
async function commands(f) {
  const current = dto(await f.tool('media.list',{productId:f.product.id}));
  return [
    ['media.list',{productId:f.product.id}],
    ['media.prepare_upload',{input:{action:'begin',...await f.input(png)}}],
    ['media.commit_upload',{operationId:randomUUID()}],
    ['media.preview_layout',{input:{productId:f.product.id,expectedRevision:current.revision,gallery:[{id:'main'}],removeMain:false},idempotencyKey:'matrix-authority-layout'}],
    ['media.commit_layout',{operationId:randomUUID()}],
  ];
}
async function unchanged(f) {
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
  assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',f.product.id)).stock_quantity,7);
}
async function layout(f,productId,gallery,key,removeMain=false) {
  const current = dto(await f.tool('media.list',{productId}));
  return f.tool('media.preview_layout',{input:{productId,expectedRevision:current.revision,gallery,removeMain},idempotencyKey:key});
}
for (const dialect of ['sqlite','postgres']) {
  const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
  for (const [number,kind,status] of [[1,'missing bearer',401],[2,'revoked grant',401],[3,'missing scopes',403],
    [4,'current Staff role',401],[5,'current demo mode',403],[6,'foreign tenant grant binding',401]]) {
    test(`${dialect}: matrix${number} all five tools reject ${kind} before resource or business writes`,options,async t=>{
      const f=await mediaToolsFixture(t,dialect),calls=await commands(f);
      if(number===2)await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?',new Date().toISOString(),f.grantId);
      if(number===3){
        await f.store.run("UPDATE oauth_grant SET scopes='catalog.read orders.read analytics.read' WHERE id=?",f.grantId);
        await f.store.run("UPDATE oauth_token SET scopes='catalog.read orders.read analytics.read' WHERE grant_id=?",f.grantId);
        assert.deepEqual((await f.rpc('tools/list',{})).data.result.tools,catalogue.map(({scope:_scope,...tool})=>tool));
      }
      if(number===4)await f.store.run("UPDATE seller_account SET role='STAFF' WHERE id=?",f.account.id);
      if(number===5)await f.store.run("UPDATE shop_setup SET mode='demo' WHERE id=1");
      if(number===6)await f.store.run("UPDATE oauth_grant SET tenant_id='foreign-shop' WHERE id=?",f.grantId);
      for(const [name,args] of calls){
        const result=number===1?await f.call('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},
          {accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'}):await f.tool(name,args);
        assert.equal(result.response.status,status,JSON.stringify({name,...result.data}));
        assert.equal(result.data.error,status===401?'invalid_token':number===3?'insufficient_scope':'access_denied');
      }
      await unchanged(f);
    });
  }
  test(`${dialect}: matrix7 begin retries retain original identity after portal edits and invalid new intent rolls back`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),input={action:'begin',...await f.input(png)},first=dto(await prepare(f,input)).stage;
    await updateProduct(f.store,f.product.id,{imageDataUrl:photo(Buffer.concat([png,Buffer.from('changed main')]))});
    const replay=dto(await prepare(f,input)).stage;assert.equal(replay.stageId,first.stageId);assert.equal(replay.replayed,true);
    assert.equal((await prepare(f,{...input,sourceSha256:'0'.repeat(64)})).data.error.code,-32009);
    assert.equal((await prepare(f,{...input,productId:randomUUID(),idempotencyKey:'matrix-invalid-new-begin'})).data.error.code,-32602);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,1);
    assert.ok((await f.store.all('SELECT active_slots,reserved_bytes FROM mcp_v2_media_quota')).every(row=>row.active_slots===1&&row.reserved_bytes===png.length+606208));
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_media_event WHERE event='BEGIN'")).n,1);
  });
  test(`${dialect}: matrix8 exposed begin reservations enforce persistent12 client slots without partial13th allocation`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),input={action:'begin',...await f.input(png)};
    for(let n=0;n<12;n++)assert.equal((await prepare(f,{...input,idempotencyKey:'matrix-slot-begin-'+String(n).padStart(3,'0')})).response.status,200);
    assert.equal((await prepare(f,{...input,idempotencyKey:'matrix-slot-begin-overflow'})).response.status,429);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n,12);
    assert.ok((await f.store.all('SELECT active_slots,reserved_bytes FROM mcp_v2_media_quota')).every(row=>row.active_slots===12&&row.reserved_bytes===12*(png.length+606208)));
  });
  test(`${dialect}: matrix9 checksum mismatch and cross-product existing gallery identities fail without a prepared operation`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),stage=dto(await prepare(f,{action:'begin',...await f.input(png),sourceSha256:'0'.repeat(64)})).stage;
    assert.equal((await prepare(f,{action:'append',stageId:stage.stageId,offset:0,dataParts:[png.toString('base64')]})).response.status,200);
    assert.equal((await prepare(f,{action:'seal',stageId:stage.stageId,idempotencyKey:'matrix-checksum-seal'})).data.error.code,-32009);
    const foreign=await f.make('FOREIGN');await addGalleryImage(f.store,foreign.id,photo(Buffer.concat([png,Buffer.from('foreign')])));
    const foreignId=(await getProduct(f.store,foreign.id,true)).galleryItems.find(item=>item.id!=='main').id;
    assert.equal((await layout(f,f.product.id,[{id:foreignId}],'matrix-foreign-existing')).data.error.code,-32602);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n,0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n,0);
  });
  test(`${dialect}: matrix10 holder10/own-main11 remains complete and variants cannot reorder shared selection`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),holder=await f.make('HOLDER',png,{variantGroup:'MATRIX-GROUP',variantLabel:'A'});
    for(let n=0;n<9;n++)await addGalleryImage(f.store,holder.id,photo(Buffer.concat([png,Buffer.from('shared-'+n)])));
    const variant=await f.make('VARIANT',Buffer.concat([png,Buffer.from('own')]),{variantGroup:'MATRIX-GROUP',variantLabel:'B'});
    const listed=dto(await f.tool('media.list',{productId:variant.id})),h=listed.items.find(item=>item.productId===holder.id),v=listed.items.find(item=>item.productId===variant.id);
    assert.equal(h.gallery.length,10);assert.equal(v.gallery.length,11);assert.equal(v.gallery[0].id,'main');
    const denied=await layout(f,variant.id,v.gallery.map(({id})=>({id})).reverse(),'matrix-variant-shared-reorder');
    assert.equal(denied.data.error.code,-32009);
    const selected=v.gallery.filter(item=>item.id!=='main').map(({id})=>({id}));
    const operation=dto(await layout(f,variant.id,selected,'matrix-variant-own-main-remove',true));assert.equal(operation.status,'PENDING_APPROVAL');
    await f.approve(operation);assert.equal(dto(await f.tool('media.commit_layout',{operationId:operation.operationId})).status,'COMMITTED');
    assert.equal((await getProduct(f.store,holder.id,true)).galleryItems.length,10);
    assert.equal((await getProduct(f.store,variant.id,true)).galleryItems.length,10);
    assert.equal((await f.store.get('SELECT image_data FROM product WHERE id=?',variant.id)).image_data,null);
  });
  test(`${dialect}: matrix11 duplicate pixels keep distinct physical associations and stable thumbnail changes invalidate approved no-op`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect);await addGalleryImage(f.store,f.product.id,photo(Buffer.concat([png,Buffer.from('legacy duplicate association')])));
    // A supported historical state can retain multiple physical IDs with the
    // same pixels; new portal uploads themselves already deduplicate content.
    await f.store.run('UPDATE product_gallery_image SET data=? WHERE product_id=?',png,f.product.id);
    const current=await getProduct(f.store,f.product.id,true),selected=current.galleryItems.map(({id})=>({id}));
    assert.equal(selected.length,2);assert.notEqual(selected[0].id,selected[1].id);
    const listed=dto(await f.tool('media.list',{productId:f.product.id}));assert.equal(listed.assets.length,1);
    const args={input:{productId:f.product.id,expectedRevision:listed.revision,gallery:selected,removeMain:false},idempotencyKey:'matrix-identical-no-op'};
    const operation=dto(await f.tool('media.preview_layout',args)),again=dto(await f.tool('media.preview_layout',args));
    assert.equal(again.operationId,operation.operationId);assert.equal(again.previewHash,operation.previewHash);
    await f.approve(operation);await setProductThumbnail(f.store,f.product.id,photo(Buffer.concat([png,Buffer.from('thumbnail backfill')])));
    assert.equal((await getProduct(f.store,f.product.id,true)).updatedAt,current.updatedAt);
    assert.deepEqual(dto(await f.tool('media.commit_layout',{operationId:operation.operationId})),{operationId:operation.operationId,error:'STALE_REVISION'});
    assert.deepEqual((await getProduct(f.store,f.product.id,true)).galleryItems.map(({id})=>({id})),selected);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
    const fresh=dto(await layout(f,f.product.id,selected,'matrix-no-op-current'));await f.approve(fresh);
    assert.equal(dto(await f.tool('media.commit_layout',{operationId:fresh.operationId})).status,'COMMITTED');
    assert.equal(dto(await f.tool('media.commit_layout',{operationId:fresh.operationId})).replayed,true);
    assert.deepEqual((await getProduct(f.store,f.product.id,true)).galleryItems.map(({id})=>({id})),selected);
  });
  test(`${dialect}: matrix12 mid-service database failure rolls back selected identities, history and approval consumption`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect);await addGalleryImage(f.store,f.product.id,photo(Buffer.concat([png,Buffer.from('rollback')])));
    const current=await getProduct(f.store,f.product.id,true),selected=current.galleryItems.map(({id})=>({id}));
    const operation=dto(await layout(f,f.product.id,[...selected].reverse(),'matrix-domain-failure'));await f.approve(operation);
    const run=f.store.run;let injected=false;
    f.store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO product_gallery_image')){injected=true;throw new Error('Synthetic mid-service database failure');}return run(sql,...args);};
    let failed;try{failed=await f.tool('media.commit_layout',{operationId:operation.operationId});}finally{f.store.run=run;}
    assert.equal(injected,true);assert.equal(failed.data.error.code,-32603);
    assert.deepEqual((await getProduct(f.store,f.product.id,true)).galleryItems.map(({id})=>({id})),selected);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n,0);
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?',operation.operationId)).consumed_at,null);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.operationId)).state,'FAILED');
    const retry=dto(await layout(f,f.product.id,[...selected].reverse(),'matrix-domain-failure-new'));await f.approve(retry);
    assert.equal(dto(await f.tool('media.commit_layout',{operationId:retry.operationId})).status,'COMMITTED');
  });
  test(`${dialect}: bounded metadata pagination preserves every long-Unicode member and full11-image associations`,options,async t=>{
    const f=await mediaToolsFixture(t,dialect),name='漢'.repeat(120),group='BOUNDED-MEDIA';
    const holder=await f.make('BOUNDED-000',png,{name,variantGroup:group,variantLabel:'000'});
    for(let n=0;n<9;n++)await addGalleryImage(f.store,holder.id,photo(Buffer.concat([png,Buffer.from('bounded-'+n)])));
    for(let n=1;n<26;n++)await f.make('BOUNDED-'+String(n).padStart(3,'0'),Buffer.concat([png,Buffer.from('own')]),{name,variantGroup:group,variantLabel:String(n).padStart(3,'0')});
    const pages=[];
    for(const offset of [0,25]){
      const response=await f.tool('media.list',{productId:holder.id,limit:25,offset});
      assert.equal(response.response.status,200,JSON.stringify(response.data));const value=dto(response);
      assert.equal(valid(value,mediaListOutput),true);assert.ok(Buffer.byteLength(JSON.stringify(value))<=65536);
      assert.ok(Buffer.byteLength(JSON.stringify(response.data))<=262144);assert.equal(value.membersTotal,26);pages.push(value);
      assert.doesNotMatch(JSON.stringify(value),/data:image|image_data|thumb_data|password|token|socket|customer|phone|address/);
    }
    assert.equal(pages[0].nextOffset,25);assert.equal(pages[1].nextOffset,null);assert.equal(pages[0].revision,pages[1].revision);
    const items=pages.flatMap(page=>page.items),ids=items.map(item=>item.productId).sort();
    assert.deepEqual(ids,(await f.store.all('SELECT id FROM product WHERE listing_id=? ORDER BY id',holder.listingId)).map(row=>row.id));
    assert.ok(items.every(item=>item.name===name&&item.gallery.length===(item.productId===holder.id?10:11)));
  });
}
