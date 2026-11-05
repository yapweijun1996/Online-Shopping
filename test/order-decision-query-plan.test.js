import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { orderToolFixture,orderDto as dto } from './helpers/mcp-order-fixture.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual complete order preview uses selective header/delivery/line/product indexes under unrelated order history`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await orderToolFixture(t,dialect),targetProduct=await f.product(),other=await f.product({stockQuantity:null}),target=await f.order([targetProduct],1);
 for(let n=0;n<1000;n++)await f.order([other],1);
 for(const table of ['shop_order','delivery','order_item'])await f.store.exec('ANALYZE '+table);
 const methods={get:f.store.get,all:f.store.all},queries=[];for(const method of Object.keys(methods))f.store[method]=(sql,...args)=>{if(/^\s*SELECT/.test(sql))queries.push({sql,args});return methods[method](sql,...args);};
 const start=performance.now();let result;try{result=dto(await f.preview(target.id,{action:'confirm'}));}finally{Object.assign(f.store,methods);}const elapsed=performance.now()-start;assert.equal(result.status,'PENDING_APPROVAL');
 const cases=[
  [query=>query.sql.includes('AS revision_text'),dialect==='sqlite'?/sqlite_autoindex_shop_order_1/:/shop_order_pkey/],
  [query=>query.sql.includes('SELECT id,position FROM delivery'),dialect==='sqlite'?/sqlite_autoindex_delivery_/:/delivery_order_id_position_key/],
  [query=>query.sql.includes('AS price_text'),dialect==='sqlite'?/sqlite_autoindex_order_item_/:/order_item_delivery_id_position_key/],
  [query=>query.sql.includes('affected_lines'),/order_item_inventory/],
 ];
 for(const[select,index]of cases){const captured=queries.find(select);assert.ok(captured);const rows=await f.store.all((dialect==='sqlite'?'EXPLAIN QUERY PLAN ':'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ')+captured.sql,...captured.args);assert.match(JSON.stringify(rows),index);}
 t.diagnostic('Selective complete order preview milliseconds: '+elapsed.toFixed(2));
 assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM shop_order')).n,1001);const proposal=JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?',result.operationId)).envelope_json).proposal;assert.equal(proposal.items.length,1);assert.equal(proposal.stockEffects.length,1);assert.equal(proposal.stockEffects[0].quantity,1);
});
