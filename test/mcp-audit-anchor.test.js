import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { OPERATION_AUDIT_ANCHORS_SQL,readOperationAuditAnchors } from '../src/mcp/audit.js';
const target='10000000-0000-0000-0000-000000000000',other='20000000-0000-0000-0000-000000000000';
const walk=node=>[node,...(node.Plans??[]).flatMap(walk)];
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual dual-anchor SQL seeks one composite-key endpoint despite old operation and unrelated replay rows`,
 {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
  const {store}=await mediaFixture(t,dialect);
  const numbers=dialect==='sqlite'?'WITH RECURSIVE numbers(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<60000)':'WITH numbers AS(SELECT generate_series(1,60000) AS n)';
  const id=dialect==='sqlite'?"printf('00000000-0000-0000-0000-%012d',n)":"'00000000-0000-0000-0000-'||lpad(n::TEXT,12,'0')";
  await store.exec(`${numbers} INSERT INTO mcp_audit(id,at,tenant_id,correlation_id,event,tool_name,outcome,duration_ms,result_count,operation_id)
    SELECT ${id},'2026-11-05T00:00:00.000Z','synthetic','30000000-0000-0000-0000-000000000000','CALL','orders.commit_decision','REPLAY',0,1,CASE WHEN n<=10000 THEN '${target}' ELSE '${other}' END FROM numbers`);
  await store.exec(`${numbers} INSERT INTO mcp_v2_event(id,at,tenant_id,tool_name,operation_id,event,outcome,correlation_id)
    SELECT ${id},'2026-11-05T00:00:00.000Z','synthetic','orders.preview_decision',CASE WHEN n<=10000 THEN '${target}' ELSE '${other}' END,'PREPARE','PREPARED','30000000-0000-0000-0000-000000000000' FROM numbers`);
  await store.exec('ANALYZE mcp_audit; ANALYZE mcp_v2_event');
  const params=[target,target,target,target];
  const plan=await store.all((dialect==='sqlite'?'EXPLAIN QUERY PLAN ':'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ')+OPERATION_AUDIT_ANCHORS_SQL,...params);
  if(dialect==='sqlite') {
    const details=plan.map(row=>row.detail).join('\n');
    for(const table of ['mcp_audit','mcp_v2_event'])assert.match(details,new RegExp('SEARCH '+table+' USING COVERING INDEX '+table+'_operation_anchor'));
    const code=await store.all('EXPLAIN '+OPERATION_AUDIT_ANCHORS_SQL,...params);
    assert.equal(code.filter(row=>row.opcode==='SeekLE').length,2);assert.equal(code.filter(row=>row.opcode==='DecrJumpZero').length,2);
    t.diagnostic(details);
  } else {
    const nodes=walk(plan[0]['QUERY PLAN'][0].Plan),scans=nodes.filter(node=>node['Index Name']);
    assert.equal(scans.length,2);
    for(const table of ['mcp_audit','mcp_v2_event']){
      const scan=scans.find(node=>node['Index Name']===table+'_operation_anchor');assert.ok(scan);
      assert.equal(scan['Scan Direction'],'Backward');assert.equal(scan['Actual Rows'],1);assert.equal(scan['Actual Loops'],1);
      assert.equal(scan['Rows Removed by Filter']??0,0);
    }
    assert.equal(nodes.some(node=>node['Node Type']==='Seq Scan'),false);
    t.diagnostic(JSON.stringify(scans.map(node=>({index:node['Index Name'],direction:node['Scan Direction'],rows:node['Actual Rows'],loops:node['Actual Loops'],removed:node['Rows Removed by Filter']??0,sharedHits:node['Shared Hit Blocks']}))));
  }
  const start=performance.now();for(let n=0;n<30;n++)assert.deepEqual({...await readOperationAuditAnchors(store,target)},{lifecycle:10000,calls:10000});
  t.diagnostic('30 endpoint reads mean milliseconds: '+(performance.now()-start)/30);
  assert.deepEqual({...await readOperationAuditAnchors(store,randomUUID())},{lifecycle:0,calls:0});
  // Metadata only: no grant/authorization is created here. An unsafe database
  // identity must fail closed, never be hidden by a JavaScript-safe SQL ceiling.
  if(dialect==='sqlite')await store.exec("UPDATE sqlite_sequence SET seq=9223372036854775806 WHERE name='mcp_audit'");
  else await store.exec("DO $$ BEGIN PERFORM setval(pg_get_serial_sequence('mcp_audit','sequence'),9223372036854775807,false); END $$");
  const uuid=randomUUID();await store.run("INSERT INTO mcp_audit(id,at,tenant_id,correlation_id,event,outcome,duration_ms,result_count,operation_id)VALUES(?,?,'synthetic',?,'READ','OK',0,1,?)",uuid,new Date().toISOString(),uuid,target);
  await assert.rejects(()=>readOperationAuditAnchors(store,target),RangeError);
 });
