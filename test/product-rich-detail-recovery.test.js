import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { openPostgresStore } from '../src/postgres-store.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { ready, SCHEMA_VERSION } from '../src/db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { ensureAdmin } from '../src/auth.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { importSqlite, importTables, rowsDigest } from '../src/sqlite-import.js';
import { getProductDetail, saveProductDetail, stageProductDetailImage, getProductDetailImage } from '../src/product-detail.js';
const base=process.env.SHOP_TEST_DATABASE_URL;
const options={skip:!base,timeout:30000};
const sha=data=>createHash('sha256').update(data).digest('hex');
const tables=importTables.filter(table=>!['listing_detail','listing_detail_image'].includes(table));
const snapshot=async store=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,rowsDigest(await store.all(`SELECT * FROM ${table}`))])));
const photo='data:image/png;base64,'+(await readFile(new URL('../public/shop/icons/icon-192.png',import.meta.url))).toString('base64');
function pgTool(name,url,args){
 const u=new URL(url);assert.equal(process.env.NODE_ENV,'test');assert.ok(/test/i.test(u.pathname)&&['127.0.0.1','localhost'].includes(u.hostname));
 const result=spawnSync('/usr/lib/postgresql/16/bin/'+name,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:u.hostname,PGPORT:u.port,PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:u.pathname.slice(1),PGCONNECT_TIMEOUT:'5'},stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:1048576});
 assert.ok(result.status===0&&!result.error,'Owned synthetic rich detail snapshot tool failed.');
}
async function databases(t){
 const pool=new pg.Pool({connectionString:base}),names=[],stores=[];
 t.after(async()=>{for(const store of stores)await store.close();for(const name of names)await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end();});
 return {stores,async create(){const name='shopping_test_detail_restore_'+randomUUID().replaceAll('-','');await pool.query(`CREATE DATABASE ${name}`);names.push(name);const url=new URL(base);url.pathname='/'+name;return {name,url:url.href};}};
}

test('real PostgreSQL schema34 dump restores separately and upgrades with original commerce/audit digests unchanged',options,async t=>{
 const dbs=await databases(t),original=await dbs.create(),recovery=await dbs.create();
 const directory=await mkdtemp(join(tmpdir(),'shopping-detail34-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 // Strip ONLY the additive35 section and its two metadata strings. This exact
 // source hash is the real dfe0692 schema34 baseline, independent of git depth.
 const current=await readFile(new URL('../src/postgres/schema.sql',import.meta.url),'utf8');
 const old=current.split('\n-- Listing-owned rich product detail (schema 35).')[0].replace('matching SQLite schema 35','matching SQLite schema 34').replace('INSERT INTO schema_meta VALUES (1, 35);','INSERT INTO schema_meta VALUES (1, 34);');
 assert.equal(sha(old),'d0067a35d523accff71d4d6d61848f5f5a4d203adf3338c4b0d051bbf007f449');
 const source=openPostgresStore(original.url);dbs.stores.push(source);await source.exec(old);
 assert.equal(await source.schemaVersion(),34);assert.equal((await source.get("SELECT to_regclass('public.listing_detail') AS table_name")).table_name,null);
 await ensureAdmin(source,'synthetic_owner','SyntheticDetailRestorePassword123!');await createCategory(source,{code:'SYNTHETIC',label:'Synthetic'});
 await createProduct(source,{sku:'REAL34',name:'Synthetic original34',description:'Preserved summary',category:'SYNTHETIC',priceMinor:500,currency:'MYR',active:true});
 const before=await snapshot(source),path=join(directory,'schema34.dump');await writeFile(path,'',{mode:0o600});
 pgTool('pg_dump',original.url,['--format=custom','--no-owner','--no-privileges','--file',path]);const digest=sha(await readFile(path));
 pgTool('pg_restore',recovery.url,['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',recovery.name,path]);
 const restored=await openPostgresDatabase(recovery.url,{allowUpgrade:true});dbs.stores.push(restored);
 assert.equal(await restored.schemaVersion(),SCHEMA_VERSION);assert.equal(await ready(restored),true);assert.deepEqual(await snapshot(restored),before);
 await source.transaction(()=>upgradePostgres(source,34));assert.deepEqual(await snapshot(source),before);assert.equal(await ready(source),true);
 const p=await source.get('SELECT id FROM product WHERE sku=?','REAL34');await saveProductDetail(source,p.id,{expectedRevision:(await getProductDetail(source,p.id,true)).revision,document:{version:1,blocks:[{type:'paragraph',text:'After backup only'}]}},'synthetic_owner');
 assert.equal((await getProductDetail(restored,p.id,true)).document.blocks.length,0);assert.equal(sha(await readFile(path)),digest);
});

test('real PostgreSQL35 dump preserves rich document and encoded bytes independently of later original edits',options,async t=>{
 const f=await inventoryFixture(t,'postgres'),p=await f.product(),asset=await stageProductDetailImage(f.store,p.id,{imageDataUrl:photo});
 await saveProductDetail(f.store,p.id,{expectedRevision:(await getProductDetail(f.store,p.id,true)).revision,document:{version:1,blocks:[{type:'image',assetId:asset.id,alt:'Synthetic image',caption:'Original caption'}]}},'synthetic_owner');
 const before=await getProductDetail(f.store,p.id,true),imageDigest=sha((await getProductDetailImage(f.store,p.id,asset.id,true)).data);
 const directory=await mkdtemp(join(tmpdir(),'shopping-detail35-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'schema35.dump');await writeFile(path,'',{mode:0o600});pgTool('pg_dump',f.location,['--format=custom','--no-owner','--no-privileges','--file',path]);
 const dbs=await databases(t),recovery=await dbs.create();pgTool('pg_restore',recovery.url,['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',recovery.name,path]);
 const restored=await openPostgresDatabase(recovery.url);dbs.stores.push(restored);
 await saveProductDetail(f.store,p.id,{expectedRevision:before.revision,document:{version:1,blocks:[]}},'synthetic_owner');
 assert.deepEqual(await getProductDetail(restored,p.id,true),before);assert.equal(sha((await getProductDetailImage(restored,p.id,asset.id,true)).data),imageDigest);assert.equal(await ready(restored),true);
 await assert.rejects(()=>getProductDetailImage(f.store,p.id,asset.id,true),{status:404});
});

test('SQLite to PostgreSQL import preserves rich document/asset bytes and remains listing-scoped',options,async t=>{
 const source=await inventoryFixture(t,'sqlite'),p=await source.product(),asset=await stageProductDetailImage(source.store,p.id,{imageDataUrl:photo});
 await saveProductDetail(source.store,p.id,{expectedRevision:(await getProductDetail(source.store,p.id,true)).revision,document:{version:1,blocks:[{type:'image',assetId:asset.id,alt:'Synthetic imported image',caption:''}]}},'synthetic_owner');
 const before=await getProductDetail(source.store,p.id,true),target=await inventoryFixture(t,'postgres',{seed:false});
 await importSqlite(source.store,target.store);assert.deepEqual(await getProductDetail(target.store,p.id,true),before);
 for(const table of ['listing_detail','listing_detail_image'])assert.equal(rowsDigest(await source.store.all(`SELECT * FROM ${table}`)),rowsDigest(await target.store.all(`SELECT * FROM ${table}`)));
 assert.equal(await ready(target.store),true);
});
