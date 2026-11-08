import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { restoreLegacyAuditFixture } from './helpers/legacy-audit-fixture.js';
import { migrateStore,SCHEMA_VERSION } from '../src/db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { openPostgresStore } from '../src/postgres-store.js';
import { inventoryStorageReady,inventoryOrderIndexReady,INVENTORY_ORDER_INDEX_SQL } from '../src/inventory-schema.js';
const migrate=store=>store.dialect==='sqlite'?migrateStore(store):store.transaction(()=>upgradePostgres(store,32));
for(const dialect of ['sqlite','postgres']){
 const options={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: exact32 index-only migration preserves frozen ledger metadata and rolls back index/version atomically`,options,async t=>{
  const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:8}),meta=await f.store.get('SELECT * FROM inventory_schema'),movement=await f.store.get('SELECT * FROM inventory_movement');
  await restoreLegacyAuditFixture(f.store);await f.store.exec('DROP INDEX order_item_inventory');await f.store.setSchemaVersion(32);const exec=f.store.exec;
  f.store.exec=async sql=>{await exec(sql);if(sql===INVENTORY_ORDER_INDEX_SQL)throw new Error('Synthetic33 index interruption');};
  await assert.rejects(migrate(f.store),/Synthetic33/);f.store.exec=exec;assert.equal(await f.store.schemaVersion(),32);assert.equal(await inventoryOrderIndexReady(f.store),false);
  await migrate(f.store);assert.equal(await f.store.schemaVersion(),SCHEMA_VERSION);assert.equal(await inventoryStorageReady(f.store),true);assert.deepEqual(await f.store.get('SELECT * FROM inventory_schema'),meta);assert.deepEqual(await f.store.get('SELECT * FROM inventory_movement'),movement);assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);
  await f.store.exec('DROP INDEX order_item_inventory');await f.store.exec('CREATE INDEX order_item_inventory ON order_item(delivery_id,product_id,id)');assert.equal(await inventoryStorageReady(f.store),false);
 });
 test(`${dialect}: malformed source32 ledger and preexisting index prototypes refuse version advancement`,options,async t=>{
  const f=await inventoryFixture(t,dialect);await restoreLegacyAuditFixture(f.store);await f.store.exec('DROP INDEX order_item_inventory');await f.store.setSchemaVersion(32);await f.store.exec('DROP INDEX inventory_movement_order');
  await assert.rejects(migrate(f.store),/Incompatible inventory/);assert.equal(await f.store.schemaVersion(),32);assert.equal(await inventoryOrderIndexReady(f.store),false);
  const prototype=await inventoryFixture(t,dialect);await restoreLegacyAuditFixture(prototype.store);await prototype.store.setSchemaVersion(32);await assert.rejects(migrate(prototype.store),/Unversioned inventory index prototype/);assert.equal(await prototype.store.schemaVersion(),32);
 });
 test(`${dialect}: covering per-product source lookup and movement revision pages use actual selective indexes`,options,async t=>{
  const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:null}),other=await f.product({stockQuantity:null}),order=await f.order([p]),delivery=await f.store.get('SELECT id FROM delivery WHERE order_id=?',order.id);
  await f.store.transaction(async()=>{for(let n=1;n<=1500;n++)await f.store.run(`INSERT INTO order_item(id,delivery_id,position,product_id,sku_snapshot,name_snapshot,price_minor,quantity,line_total_minor,currency) VALUES(?,?,?,?,?,?,1,1,1,'MYR')`,randomUUID(),delivery.id,n,other.id,'SYN','Synthetic');});await f.store.exec('ANALYZE order_item');
  const count='SELECT COUNT(*) AS n FROM (SELECT id FROM order_item WHERE product_id=? LIMIT 10001) inventory_lines';
  const select='SELECT i.id,i.delivery_id,i.quantity,d.order_id,o.status,o.revision,o.submitted_at FROM order_item i JOIN delivery d ON d.id=i.delivery_id JOIN shop_order o ON o.id=d.order_id WHERE i.product_id=? ORDER BY i.id LIMIT 10001';
  for(const sql of [count,select]){
   const plan=await f.store.all((dialect==='sqlite'?'EXPLAIN QUERY PLAN ':'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ')+sql,p.id);assert.match(JSON.stringify(plan),/order_item_inventory/);assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM order_item WHERE product_id=?',p.id)).n,1);
  }
  // With a keyset and DESC order, the existing composite uniqueness supplies
  // movement paging; it requires no additional ledger/table migration.
  const movement='SELECT revision FROM inventory_movement WHERE product_id=? AND revision<=? ORDER BY revision DESC LIMIT 101';
  const plan=await f.store.all((dialect==='sqlite'?'EXPLAIN QUERY PLAN ':'EXPLAIN (FORMAT JSON) ')+movement,p.id,Number.MAX_SAFE_INTEGER);
  assert.match(JSON.stringify(plan),dialect==='sqlite'?/sqlite_autoindex_inventory_movement_/ : /inventory_movement_product_id_revision_key/);
 });
}
test('actual immutable PostgreSQL32 baseline reaches33 without changing any inventory table fingerprint',{skip:!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const base=process.env.SHOP_TEST_DATABASE_URL,pool=new pg.Pool({connectionString:base}),name='shopping_test_inventory33_'+randomUUID().replaceAll('-','');await pool.query(`CREATE DATABASE ${name}`);const url=new URL(base);url.pathname='/'+name;const store=openPostgresStore(url.href);t.after(async()=>{await store.close();await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end();});
 const old=await readFile(new URL('./fixtures/postgres-schema32.sql',import.meta.url),'utf8');assert.match(old,/INSERT INTO schema_meta VALUES \(1, 32\)/);assert.doesNotMatch(old,/CREATE INDEX order_item_inventory/);await store.exec(old);const before=await store.get('SELECT * FROM inventory_schema');
 await store.transaction(()=>upgradePostgres(store,32));assert.equal(await inventoryStorageReady(store),true);assert.deepEqual(await store.get('SELECT * FROM inventory_schema'),before);
 const fresh=await readFile(new URL('../src/postgres/schema.sql',import.meta.url),'utf8');assert.equal(fresh.split(INVENTORY_ORDER_INDEX_SQL).length,2);
});
