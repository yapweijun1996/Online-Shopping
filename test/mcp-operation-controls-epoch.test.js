import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {secret} from '../src/mcp/credentials.js';
import {orderToolFixture,orderDto,orderScopes} from './helpers/mcp-order-fixture.js';

for(const dialect of ['sqlite','postgres'])for(const tool of ['operations.get','operations.audit','operations.cancel']) {
 test(`${dialect}: ${tool} rolls back state, proof and typed audit when epoch rotates after its final audit INSERT`,{
  skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL,
 },async t=>{
  const directory=await mkdtemp(join(tmpdir(),'controls-epoch-')),epochFile=join(directory,'epoch'),epoch=secret();
  await writeFile(epochFile,epoch,{mode:0o600});t.after(()=>rm(directory,{recursive:true,force:true}));
  const f=await orderToolFixture(t,dialect,{scopes:orderScopes+' operations.read operations.cancel',config:{mcpV2:{enabled:true,epoch,epochFile,buildDigest:'e'.repeat(64)}}});
  const product=await f.product(),order=await f.order([product]);
  const operation=orderDto(await f.preview(order.id,{action:'confirm'}));
  assert.equal((await f.approve(operation)).response.status,200);
  const snapshot=async()=>({
   state:await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',operation.operationId),
   approval:await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id=?',operation.operationId),
   challenge:await f.store.all('SELECT * FROM mcp_v2_approval_challenge WHERE operation_id=? ORDER BY id',operation.operationId),
   events:await f.store.all('SELECT * FROM mcp_v2_event WHERE operation_id=? ORDER BY sequence',operation.operationId),
   audits:await f.store.all('SELECT * FROM mcp_audit WHERE operation_id=? AND tool_name=? ORDER BY sequence',operation.operationId,tool),
  });
  const before=await snapshot();assert.equal(before.state.state,'APPROVED');assert.equal(before.approval.consumed_at,null);
  const run=f.store.run;let rotated=0;
  f.store.run=async(sql,...args)=>{
   const result=await run(sql,...args);
   if(/INSERT INTO mcp_audit/.test(sql)&&args.includes(tool)){
    const replacement=join(directory,'next');await writeFile(replacement,secret(),{mode:0o600});await rename(replacement,epochFile);rotated++;
   }
   return result;
  };
  let denied;
  try{denied=await f.client.call(tool,{operationId:operation.operationId});}finally{f.store.run=run;}
  assert.equal(rotated,1);assert.equal(denied.response.status,403);assert.equal(denied.data.error,'access_denied');
  assert.deepEqual(await snapshot(),before);
  assert.equal((await f.store.get('SELECT status FROM shop_order WHERE id=?',order.id)).status,'SUBMITTED');
  assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',product.id)).stock_quantity,10);
  assert.equal((await f.client.call(tool,{operationId:operation.operationId})).response.status,401);
 });
}
