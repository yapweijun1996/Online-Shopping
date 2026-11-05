import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {openPlatformDatabase} from '../src/platform/platform-db.js';
import {createPlatformRegistry} from '../src/platform/registry.js';
import {catalogRuntimeFixture} from './helpers/mcp-catalog-runtime-fixture.js';
test('PostgreSQL actual C capture waits on the platform fence before the tenant writer; native is SYNTHETIC',
 {skip:!process.env.SHOP_TEST_DATABASE_URL},async t=>{
  const base=process.env.SHOP_TEST_DATABASE_URL;assert.equal(process.env.NODE_ENV,'test');assert.match(new URL(base).pathname,/test/i);
  const admin=new pg.Pool({connectionString:base}),name='shopping_test_c_platform_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE DATABASE ${name}`);const url=new URL(base);url.pathname='/'+name;
  const platform=await openPlatformDatabase(url.href),other=new pg.Client({connectionString:url.href});await other.connect();
  t.after(async()=>{await other.end();await platform.close();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();});
  const tenantId=randomUUID(),now=new Date().toISOString();
  await platform.run(`INSERT INTO tenant(id,code,name,status,currency,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at)
   VALUES(?,'alpha','Synthetic alpha','ACTIVE','MYR',?,?,?,'k1',?,?)`,tenantId,'t_alpha_12345678','t_alpha_12345678',Buffer.from('synthetic'),now,now);
  let registry;
  const f=await catalogRuntimeFixture(t,'postgres',{tenantId,config:{basePath:'/alpha',platform:{adminHost:'admin.example.test'}},
   registry:(store,config)=>(registry=createPlatformRegistry({store,config,platform,pool:{get:async()=>store}}))}),p=await f.product();
  await other.query('BEGIN');await other.query('SELECT id FROM tenant WHERE id=$1 FOR UPDATE',[tenantId]);
  const waiting=f.client.call('catalog.preview_update',{input:{id:p.id,changes:{name:'Fenced proposed literal'}},idempotencyKey:'actual-c-platform-fence'});
  let prepared;
  try{
   let blocked=false;for(let n=0;n<50;n++){
    const state=await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id, code, status, revision FROM tenant%'",[name]);
    if(state.rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.equal(blocked,true);assert.equal(f.decodes(),0);
   let timer;try{const read=await Promise.race([f.client.call('catalog.categories',{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('V1 read blocked behind C platform wait.')),1500);})]);
    assert.equal(read.response.status,200);assert.ok(read.data.result.structuredContent.items.some(row=>row.code==='SYNTHETIC'));
   }finally{clearTimeout(timer);}
  }finally{await other.query('COMMIT');prepared=await waiting;}
  assert.equal(prepared.response.status,200);assert.equal(prepared.data.result?.structuredContent?.status,'PENDING_APPROVAL',JSON.stringify(prepared.data));
  await platform.run("UPDATE tenant SET status='SUSPENDED' WHERE id=?",tenantId);registry.invalidate();
  const get=f.store.get,all=f.store.all;let reads=0;
  f.store.get=(...args)=>{reads++;return get(...args);};f.store.all=(...args)=>{reads++;return all(...args);};
  try{assert.equal((await f.client.call('catalog.commit_update',{operationId:prepared.data.result.structuredContent.operationId})).response.status,503);assert.equal(reads,0);}
  finally{f.store.get=get;f.store.all=all;}
 });
