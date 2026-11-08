import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { initializeFinishStorage, assertFinishStorage, maintainFinishStorage, finishStorageExists } from '../src/mcp/finish-storage.js';
import { assertCreateDraftStorage } from '../src/mcp/catalog-create-draft-storage.js';
import { runFinishInstallation, parseFinishInstallationArguments } from '../src/mcp/finish-installation.js';

for(const dialect of process.env.SHOP_TEST_DATABASE_URL?['sqlite','postgres']:['sqlite']){
 test(dialect+': optional finish storage installs explicitly and validates actual columns, indexes and constraints',async t=>{
  const f=await reviewFixture(t,dialect);
  assert.equal(await finishStorageExists(f.store),false);
  await assert.rejects(assertFinishStorage(f.store));
  assert.equal(await finishStorageExists(f.store),false,'assertion never creates tables');
  await initializeFinishStorage(f.store);await assertFinishStorage(f.store);
  await initializeFinishStorage(f.store);await assertFinishStorage(f.store);
  const before=await f.store.get('SELECT * FROM seller_mcp_finish_schema WHERE id=1');assert.equal(before.version,2);
  await f.store.exec('ALTER TABLE seller_mcp_finish ADD COLUMN unexpected TEXT');
  await assert.rejects(assertFinishStorage(f.store));
  await assert.rejects(initializeFinishStorage(f.store),'installer cannot silently bless drift');
 });
 test(dialect+': index or constraint drift is denied even with unchanged source digest metadata',async t=>{
  const f=await reviewFixture(t,dialect);await initializeFinishStorage(f.store);
  await f.store.exec('DROP INDEX seller_mcp_finish_retention');
  await assert.rejects(assertFinishStorage(f.store));
 });
 test(dialect+': extension cleanup is bounded, tenant-scoped and leaves recent jobs and business data untouched',async t=>{
  const f=await reviewFixture(t,dialect);await initializeFinishStorage(f.store);
  const old='2020-01-01T00:00:00.000Z',now='2026-11-08T00:00:00.000Z';
  for(const [id,tenant,at]of [['old-default','default',old],['old-other','other',old],['new-default','default',now]])
   await f.store.run(`INSERT INTO seller_mcp_finish(id,tenant_id,account_id,client_id,grant_id,session_hash,epoch_hash,build_digest,tenant_revision,idempotency_hash,request_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,tenant,'fixture-account','fixture-client','fixture-grant','a'.repeat(64),'b'.repeat(64),'c'.repeat(64),0,id,'d'.repeat(64),at);
  const result=await maintainFinishStorage(f.store,{tenantId:'default',now,limit:1});assert.equal(result.deleted,1);
  const ids=(await f.store.all('SELECT id FROM seller_mcp_finish ORDER BY id')).map(row=>row.id);assert.deepEqual(ids,['new-default','old-other']);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n,0);
  await assert.rejects(maintainFinishStorage(f.store,{tenantId:'default',now,limit:101}));
 });
 test(dialect+': unversioned or legacy finish prototypes are rejected rather than adopted',async t=>{
  const f=await reviewFixture(t,dialect);await f.store.exec('CREATE TABLE seller_mcp_finish(id TEXT PRIMARY KEY)');
  await assert.rejects(initializeFinishStorage(f.store));assert.equal(await finishStorageExists(f.store),false);
 });
}
test('host installer binds action, origin, existing database, tenant and schema',()=>{
 const values=['--action=install','--expected-origin=https://seller.example.test','--expected-database=online_shopping','--tenant=default','--expected-schema=34'];
 assert.equal(parseFinishInstallationArguments(values).action,'install');
 for(const args of [[],values.slice(1),[...values,'--action=verify'],values.map(value=>value==='--expected-schema=34'?'--expected-schema=35':value),values.map(value=>value==='--tenant=default'?'--tenant=invalid':value)])assert.throws(()=>parseFinishInstallationArguments(args));
});
if(process.env.SHOP_TEST_DATABASE_URL)test('postgres: host installer uses owner connection and grants only required extension app DML',async t=>{
 const f=await reviewFixture(t,'postgres'),name=(await f.store.get('SELECT current_database() AS name')).name;
 const role='finish_test_'+name.slice(-20),base=new URL(process.env.SHOP_TEST_DATABASE_URL);base.pathname='/'+name;
 const ownerUrl=base.href;base.username=role;const appUrl=base.href;
 await f.store.exec(`CREATE ROLE "${role}" LOGIN`);
 try{
  await f.store.exec(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
  await f.store.exec(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await f.store.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
  const config={...f.config,databaseUrl:appUrl,mcpV2:{enabled:true},sellerQuickLogin:false};
  const args=['--action=install','--expected-origin='+f.config.sellerOrigin,'--expected-database='+name,'--tenant=default','--expected-schema=34'];
  const result=await runFinishInstallation(config,args,{ownerUrl});assert.equal(result.status,'INSTALLED');
  const {openPostgresStore}=await import('../src/postgres-store.js'),app=openPostgresStore(appUrl,{max:1});
  try{
   await assertFinishStorage(app);await assertCreateDraftStorage(app);
   assert.equal((await app.get("SELECT has_table_privilege(current_user,'seller_mcp_finish','INSERT') AS allowed")).allowed,true);
   assert.equal((await app.get("SELECT has_table_privilege(current_user,'seller_mcp_finish_schema','UPDATE') AS allowed")).allowed,false);
   assert.equal((await app.get("SELECT has_table_privilege(current_user,'seller_mcp_create_draft','INSERT') AS allowed")).allowed,true);
   assert.equal((await app.get("SELECT has_table_privilege(current_user,'seller_mcp_create_draft_stage','DELETE') AS allowed")).allowed,true);
   assert.equal((await app.get("SELECT has_table_privilege(current_user,'seller_mcp_create_draft_event','INSERT') AS allowed")).allowed,true);
   assert.equal((await app.get("SELECT has_table_privilege(current_user,'seller_mcp_create_draft_schema','UPDATE') AS allowed")).allowed,false);
   assert.equal((await app.get("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).allowed,false);
   await assert.rejects(app.run('UPDATE seller_mcp_finish_schema SET version=2 WHERE id=1'));
  }finally{await app.close();}
 }finally{await f.store.exec(`DROP OWNED BY "${role}"`);await f.store.exec(`DROP ROLE "${role}"`);}
});
