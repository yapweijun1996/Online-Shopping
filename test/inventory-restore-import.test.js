import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inventoryFixture, dropInventoryForLegacyFixture } from './helpers/inventory-fixture.js';
import { openDatabase, migrateStore } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { inventoryStorageReady } from '../src/inventory-schema.js';
import { operationStorageReady } from '../src/mcp/operation-runtime.js';
import { importSqlite, rowsDigest, importTables, excludedImportTables } from '../src/sqlite-import.js';
import { updateProduct } from '../src/products.js';
import { decideSellerOrder } from '../src/seller-orders.js';
const evidenceTables=['product','inventory_coverage','inventory_state','inventory_movement','order_item','shop_order','order_event'];
const evidence=async store=>{const out=[];for(const name of evidenceTables)out.push([name,rowsDigest(await store.all(`SELECT * FROM ${name}`))]);return out;};
function pgTool(name,url,args){const u=new URL(url);assert.ok(['127.0.0.1','localhost'].includes(u.hostname));const result=spawnSync('/usr/lib/postgresql/16/bin/'+name,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:u.hostname,PGPORT:u.port,PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:u.pathname.slice(1),PGCONNECT_TIMEOUT:'5'},stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:1048576});assert.ok(result.status===0&&!result.error,'Owned synthetic inventory snapshot tool failed.');}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual snapshot restores exact stock, coverage and ledger; later original writes stay separate`,{skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL,timeout:30000},async t=>{
 const f=await inventoryFixture(t,dialect),p=await f.product({stockQuantity:8}),order=await f.order([p],2);
 await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');const before=await evidence(f.store);
 const dir=await mkdtemp(join(tmpdir(),'inventory-snapshot-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));let restored;
 if(dialect==='sqlite'){
  const path=join(dir,'snapshot.db');await f.store.run('VACUUM INTO ?',path);await chmod(path,0o600);
  await updateProduct(f.store,p.id,{stockQuantity:20});restored=await openDatabase(path);t.after(()=>restored.close());
 }else{
  const path=join(dir,'snapshot.dump');await writeFile(path,'',{mode:0o600});pgTool('pg_dump',f.location,['--format=custom','--no-owner','--no-privileges','--file',path]);
  await updateProduct(f.store,p.id,{stockQuantity:20});
  const pool=new pg.Pool({connectionString:process.env.SHOP_TEST_DATABASE_URL}),name='shopping_test_inventory_restore_'+randomUUID().replaceAll('-','');await pool.query(`CREATE DATABASE ${name}`);const url=new URL(process.env.SHOP_TEST_DATABASE_URL);url.pathname='/'+name;
  try{pgTool('pg_restore',url.href,['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',name,path]);restored=await openPostgresDatabase(url.href);}catch(error){await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end();throw error;}
  t.after(async()=>{await restored.close();await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end();});
 }
 assert.equal(await inventoryStorageReady(restored),true);assert.equal(await operationStorageReady(restored),true);assert.deepEqual(await evidence(restored),before);assert.notDeepEqual(await evidence(f.store),before);
 await decideSellerOrder(restored,order.id,'cancel',{expectedRevision:2,reason:'Synthetic restore cancellation'},'synthetic_owner');
 assert.equal((await restored.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,8);
 assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?',p.id)).stock_quantity,20);
 await restored.exec('DROP INDEX inventory_movement_product');assert.equal(await inventoryStorageReady(restored),false);
});
test('SQLite import preserves exact migrated/created coverage, state and movements in FK order and rolls back late failure',{skip:!process.env.SHOP_TEST_DATABASE_URL},async t=>{
 const f=await inventoryFixture(t,'sqlite'),p=await f.product({stockQuantity:9});await dropInventoryForLegacyFixture(f.store);await f.store.setSchemaVersion(31);await migrateStore(f.store);
 await updateProduct(f.store,p.id,{stockQuantity:7});const created=await f.product({stockQuantity:null}),order=await f.order([p],2);await decideSellerOrder(f.store,order.id,'confirm',{expectedRevision:1},'synthetic_owner');
 const target=await inventoryFixture(t,'postgres',{seed:false}),before=await evidence(f.store),run=target.store.run;
 assert.ok(importTables.indexOf('inventory_coverage')>importTables.indexOf('shop_order'));assert.ok(importTables.indexOf('inventory_state')>importTables.indexOf('inventory_coverage'));assert.ok(excludedImportTables.includes('inventory_schema'));
 target.store.run=async(sql,...args)=>{await run(sql,...args);if(sql.startsWith('INSERT INTO inventory_movement'))throw new Error('Synthetic import ledger failure');};
 await assert.rejects(importSqlite(f.store,target.store),/Synthetic import ledger/);target.store.run=run;
 for(const table of evidenceTables)assert.equal((await target.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0,table);
 assert.equal(await inventoryStorageReady(target.store),true);await importSqlite(f.store,target.store);assert.deepEqual(await evidence(target.store),before);assert.equal(await inventoryStorageReady(target.store),true);
 assert.equal((await target.store.get('SELECT origin FROM inventory_coverage WHERE product_id=?',p.id)).origin,'MIGRATED');assert.equal((await target.store.get('SELECT origin FROM inventory_coverage WHERE product_id=?',created.id)).origin,'CREATED');
 await assert.rejects(importSqlite(f.store,target.store),/fresh baseline/);assert.deepEqual(await evidence(f.store),before);
});
