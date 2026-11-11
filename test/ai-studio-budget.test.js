import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { getBudget, saveBudget, recordUsage, analytics, budgetStatus, usageEstimate, budgetStorageReady, migrateStudioBudget } from '../src/ai-studio/budget.js';
import { reserve, settle } from '../src/ai-studio/usage.js';
const base=process.env.SHOP_TEST_DATABASE_URL;
if(base&&(process.env.NODE_ENV!=='test'||!/test/.test(new URL(base).pathname)))throw new Error('Disposable PostgreSQL required.');
async function fixture(t,dialect) {
 if(dialect==='sqlite'){const s=await openDatabase(':memory:');t.after(()=>s.close());return s}
 const pool=new pg.Pool({connectionString:base}),name='budget_test_'+randomUUID().replaceAll('-','');await pool.query(`CREATE DATABASE ${name}`);const u=new URL(base);u.pathname='/'+name;const s=await openPostgresDatabase(u.href);t.after(async()=>{await s.close();await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end()});return s;
}
const now=new Date('2026-11-11T10:00:00Z');
const setting={dailyMicrousd:1000000,monthlyMicrousd:10000000,mode:'WARN',alertPercent:80,expectedRevision:1};
for(const dialect of ['sqlite','postgres']) {
 const options={skip:dialect==='postgres'&&!base};
 test(`${dialect}: budget settings validate, CAS, preserve audit and isolate stores`,options,async t=>{
 const s=await fixture(t,dialect);assert.equal((await getBudget(s)).dailyMicrousd,null);
 await assert.rejects(saveBudget(s,{...setting,dailyMicrousd:0},'owner'));await assert.rejects(saveBudget(s,{...setting,evil:1},'owner'));
 const race=await Promise.allSettled([saveBudget(s,setting,'owner'),saveBudget(s,{...setting,mode:'BLOCK'},'owner')]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal((await s.get('SELECT COUNT(*) AS n FROM ai_studio_budget_event')).n,1);assert.equal((await getBudget(s)).revision,2);
 const other=await fixture(t,dialect);assert.equal((await getBudget(other)).dailyMicrousd,null);
 });
 test(`${dialect}: metered calls, unknown history and UTC boundaries remain honest`,options,async t=>{
 const s=await fixture(t,dialect);const [known,unknown]=await reserve(s,['ANALYZE','IMAGE'],'owner',null,now);
 await recordUsage(s,known,{model:'gpt-6-astra',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:200}}});
 await settle(s,known,'OK');await settle(s,unknown,'AMBIGUOUS');await recordUsage(s,known,{model:'gpt-6-astra',usage:{input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0}}});
 const stats=await budgetStatus(s,now);assert.equal(stats.today.estimatedMicrousd,13200);assert.equal(stats.today.unknownCalls,1);assert.equal(stats.today.calls,2);
 assert.equal((await budgetStatus(s,new Date('2026-11-12T00:00:00Z'))).today.calls,0);assert.equal((await budgetStatus(s,new Date('2026-12-01T00:00:00Z'))).month.calls,0);
 const data=await analytics(s,new URLSearchParams({days:'month',limit:'1'}),now);assert.equal(data.items.length,1);assert.equal(data.nextOffset,1);const second=await analytics(s,new URLSearchParams({days:'month',limit:'1',offset:'1'}),now);assert.notEqual(data.items[0].id,second.items[0].id);assert.equal(second.nextOffset,null);
 await assert.rejects(analytics(s,new URLSearchParams({from:'2026-02-30',to:'2026-11-11'}),now));await assert.rejects(analytics(s,new URLSearchParams({offset:'-1'}),now));
 });
 test(`${dialect}: blocked budgets fail closed before reservations, warning allows calls`,options,async t=>{
 const s=await fixture(t,dialect);await saveBudget(s,{...setting,mode:'BLOCK'},'owner');
 const results=await Promise.allSettled(Array.from({length:4},()=>reserve(s,['IMAGE','REVIEW'],'owner',null,now)));assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='AI_STUDIO_BUDGET_UNCERTAIN'));assert.equal((await budgetStatus(s,now)).today.calls,0);
 await saveBudget(s,{...setting,expectedRevision:2},'owner');const [call]=await reserve(s,['ANALYZE'],'owner',null,now);await recordUsage(s,call,{model:'gpt-6-astra',usage:{input_tokens:100000,output_tokens:1000,input_tokens_details:{cached_tokens:0}}});await settle(s,call,'OK');await saveBudget(s,{...setting,mode:'BLOCK',expectedRevision:3},'owner');await assert.rejects(reserve(s,['ANALYZE'],'owner',null,now),{code:'AI_STUDIO_BUDGET'});
 });
 test(`${dialect}: additive35 to36 migration preserves usage, is idempotent and readiness checks fields`,options,async t=>{
 const s=await fixture(t,dialect);const [id]=await reserve(s,['ANALYZE'],'owner',null,now);await settle(s,id,'OK');const before=await s.all('SELECT * FROM ai_studio_usage');await s.exec('DROP TABLE ai_studio_cost; DROP TABLE ai_studio_budget_event; DROP TABLE ai_studio_budget');assert.equal(await budgetStorageReady(s),false);await s.setSchemaVersion(35);
 if(dialect==='postgres')await s.transaction(()=>upgradePostgres(s,35));else{await migrateStudioBudget(s);await s.setSchemaVersion(36)}assert.deepEqual(await s.all('SELECT * FROM ai_studio_usage'),before);await migrateStudioBudget(s);assert.equal(await budgetStorageReady(s),true);assert.equal((await budgetStatus(s,now)).today.unknownCalls,1);
 });
}
test('price snapshots reject missing, unknown and unsupported token details',()=>{
 assert.equal(usageEstimate('gpt-image-2.5-sunburst',{input_tokens:10,output_tokens:20,input_tokens_details:{text_tokens:2,image_tokens:8}}),674);
 assert.equal(usageEstimate('unknown',{input_tokens:10,output_tokens:20}),null);
 assert.equal(usageEstimate('gpt-6-astra',{input_tokens:10,output_tokens:20,input_tokens_details:{cached_tokens:11}}),null);
 assert.equal(usageEstimate('gpt-6-astra',{input_tokens:10,output_tokens:20,input_tokens_details:{cached_tokens:0,cache_write_tokens:2}}),null);
});

test('nonstandard provider tiers are not priced using standard rates',()=>{
 assert.equal(usageEstimate('gpt-6-astra',{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0}},'priority'),null);
 assert.equal(usageEstimate('gpt-image-2.5-sunburst',{input_tokens:10,output_tokens:20,input_tokens_details:{text_tokens:2,image_tokens:8}},'flex'),null);
});
