import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inventoryFixture, dropInventoryForLegacyFixture } from './helpers/inventory-fixture.js';
import { migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { inventoryStorageReady, inventorySchema, inventorySeedSql } from '../src/inventory-schema.js';
import { operationStorageReady } from '../src/mcp/operation-runtime.js';
import { rowsDigest } from '../src/sqlite-import.js';
const upgrade = store => store.dialect==='sqlite' ? migrateStore(store) : store.transaction(()=>upgradePostgres(store,31));
for(const dialect of ['sqlite','postgres']) {
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: exact31 migration preserves commerce rows, seeds honest coverage and rolls back DDL failure`,options,async t=>{
   const f=await inventoryFixture(t,dialect),a=await f.product({stockQuantity:0}),b=await f.product({stockQuantity:9}),c=await f.product();await f.order([b],2);
   const tableNames=['product','listing','product_event','shop_order','order_item','order_event'],before=await Promise.all(tableNames.map(async n=>rowsDigest(await f.store.all(`SELECT * FROM ${n}`))));
   await dropInventoryForLegacyFixture(f.store);await f.store.setSchemaVersion(31);
   const exec=f.store.exec;f.store.exec=async sql=>{await exec(sql);if(sql.includes('CREATE TABLE inventory_movement'))throw new Error('Synthetic schema32 DDL failure');};
   await assert.rejects(upgrade(f.store),/Synthetic schema32/);f.store.exec=exec;assert.equal(await f.store.schemaVersion(),31);
   const objects=dialect==='sqlite'?await f.store.all("SELECT name FROM sqlite_schema WHERE name GLOB 'inventory_*'"):await f.store.all("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'inventory!_%' ESCAPE '!'");assert.deepEqual(objects,[]);
   await upgrade(f.store);assert.equal(await f.store.schemaVersion(),SCHEMA_VERSION);assert.equal(await inventoryStorageReady(f.store),true);assert.equal(await operationStorageReady(f.store),true);
   assert.deepEqual(await Promise.all(tableNames.map(async n=>rowsDigest(await f.store.all(`SELECT * FROM ${n}`)))),before);
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement')).n,0);
   assert.deepEqual((await f.store.all('SELECT product_id,baseline_quantity,origin FROM inventory_coverage ORDER BY product_id')).map(r=>[r.product_id,r.baseline_quantity,r.origin]),[[a.id,0,'MIGRATED'],[b.id,9,'MIGRATED'],[c.id,null,'MIGRATED']].sort((x,y)=>x[0].localeCompare(y[0])));
   assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM inventory_state WHERE revision=0')).n,3);
   await f.store.exec('DROP INDEX inventory_movement_product');assert.equal(await inventoryStorageReady(f.store),false);
 });
 test(`${dialect}: corrupt31 operation schema and partial inventory prototypes cannot advance32`,options,async t=>{
   const f=await inventoryFixture(t,dialect);await dropInventoryForLegacyFixture(f.store);await f.store.setSchemaVersion(31);
   await f.store.exec('DROP INDEX mcp_v2_media_stage_lease');await assert.rejects(upgrade(f.store),/Incompatible/);assert.equal(await f.store.schemaVersion(),31);
   const count=await f.store.get(dialect==='sqlite'?"SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='inventory_schema'":"SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name='inventory_schema'");assert.equal(count.n,0);
   const fresh=await inventoryFixture(t,dialect);await dropInventoryForLegacyFixture(fresh.store);await fresh.store.setSchemaVersion(31);await fresh.store.exec('CREATE TABLE inventory_partial(id TEXT)');
   await assert.rejects(upgrade(fresh.store),/Unrecognized inventory/);assert.equal(await fresh.store.schemaVersion(),31);
 });
 test(`${dialect}: schema32 rejects malformed movement deltas, identities, source reasons and parent deletion`,options,async t=>{
   const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:3});
   for(const sql of ["UPDATE inventory_movement SET source='MCP_ADJUST'", "UPDATE inventory_movement SET reason_code='COUNT_CORRECTION'", "UPDATE inventory_movement SET delta_quantity=1", "UPDATE inventory_movement SET revision=0", "UPDATE inventory_coverage SET baseline_quantity=1000001"])await assert.rejects(f.store.run(sql));
   await assert.rejects(f.store.run('DELETE FROM product WHERE id=?',p.id));assert.equal(await inventoryStorageReady(f.store),true);
 });
}
test('PostgreSQL fresh32 embeds exact generated inventoryDDL and actual frozen31 baseline upgrades identically',{skip:!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,'postgres',{seed:false}),fresh=(await f.store.get('SELECT * FROM inventory_schema'));
 const baseline=await readFile(new URL('../src/postgres/schema.sql',import.meta.url),'utf8');assert.ok(baseline.includes(inventorySchema('postgres')+inventorySeedSql()+'\n'));
 // Independent checked-in pre-inventory baseline from immutable source5eba37b.
 const old=await readFile(new URL('./fixtures/postgres-schema31.sql',import.meta.url),'utf8');assert.doesNotMatch(old,/CREATE TABLE inventory_/);assert.match(old,/INSERT INTO schema_meta VALUES \(1, 31\)/);
 // Explicit fixture dependency drops; no CASCADE hides unknown dependencies.
 const tables=await f.store.all("SELECT tablename FROM pg_tables WHERE schemaname='public'");
 const left=new Set(tables.map(r=>r.tablename));
 while(left.size){let progressed=false;for(const name of left){const depend=await f.store.get("SELECT COUNT(*) AS n FROM pg_constraint c JOIN pg_class p ON p.oid=c.confrelid JOIN pg_class child ON child.oid=c.conrelid WHERE c.contype='f' AND p.relname=? AND child.relname<>p.relname AND child.relnamespace='public'::regnamespace",name);if(depend.n===0){await f.store.exec(`DROP TABLE ${name}`);left.delete(name);progressed=true;}}assert.ok(progressed,'Known baseline FK graph must be acyclic');}
 await f.store.exec('DROP FUNCTION check_product_category()');
 await f.store.exec(old);await f.store.transaction(()=>upgradePostgres(f.store,31));assert.deepEqual(await f.store.get('SELECT * FROM inventory_schema'),fresh);
});
test('restricted tenant owner upgrades frozen31 to32 without granting unrelated legacy role access',{skip:!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const {default:pg}=await import('pg'),{randomBytes}=await import('node:crypto'),{openPostgresStore}=await import('../src/postgres-store.js');
 const pool=new pg.Pool({connectionString:process.env.SHOP_TEST_DATABASE_URL}),suffix=randomBytes(4).toString('hex'),name='t_inv32_'+suffix,role='inventory_test_role_'+suffix,password=randomBytes(24).toString('hex');let store;
 // All names/password bytes are generated here, never from commerce data.
 await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
 try {
  await pool.query(`CREATE DATABASE ${name} OWNER ${role}`);await pool.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  const url=new URL(process.env.SHOP_TEST_DATABASE_URL);url.pathname='/'+name;url.username=role;url.password=password;
  store=openPostgresStore(url.href);await store.exec(await readFile(new URL('./fixtures/postgres-schema31.sql',import.meta.url),'utf8'));
  assert.equal((await store.get('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rolsuper,false);
  await store.transaction(()=>upgradePostgres(store,31));assert.equal(await inventoryStorageReady(store),true);assert.equal(await operationStorageReady(store),true);
  const legacy=await pool.query("SELECT 1 FROM pg_roles WHERE rolname='online_shopping_app'");
  if(legacy.rowCount)for(const table of ['inventory_schema','inventory_coverage','inventory_state','inventory_movement'])assert.equal((await store.get("SELECT has_table_privilege('online_shopping_app',?,'SELECT') AS allowed",table)).allowed,false);
 }finally{if(store)await store.close();await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await pool.query(`DROP ROLE ${role}`);await pool.end();}
});
