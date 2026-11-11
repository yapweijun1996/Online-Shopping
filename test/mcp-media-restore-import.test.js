import { pgBinary } from './helpers/pg-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,chmod,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { operationStorageReady } from '../src/mcp/operation-runtime.js';
import { withMediaWriter, mediaHash } from '../src/mcp/media-storage.js';
import { importSqlite } from '../src/sqlite-import.js';
import { MEDIA_STORAGE_TABLES } from '../src/mcp/media-schema.js';
function tool(name,url,args){const p=new URL(url);assert.ok(['127.0.0.1','localhost'].includes(p.hostname));const result=spawnSync(pgBinary(name),args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:p.hostname,PGPORT:p.port,PGUSER:decodeURIComponent(p.username),PGPASSWORD:decodeURIComponent(p.password),PGDATABASE:p.pathname.slice(1),PGCONNECT_TIMEOUT:'5'},stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:1048576});assert.ok(result.status===0&&!result.error,'Synthetic media snapshot tool failed.');}
for(const dialect of ['sqlite','postgres'])test(`${dialect}: actual dataful schema31 snapshot preserves chunks, bound payload and quota without manufacturing authority`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL,timeout:30000},async t=>{
    const f=await mediaFixture(t,dialect),bytes=Buffer.alloc(524288,3),{stage,lease}=await f.upload(bytes),op=await f.operation(lease.codecDigest,f.now,lease.correlationId);
    const image=Buffer.alloc(524288,4),thumbnail=Buffer.alloc(81920,5);await f.writer(w=>w.bind(stage.stageId,lease.leaseToken,lease.version,{sourceSha256:lease.sourceSha256,image,thumbnail,mime:'image/png',width:2048,height:2048,codecDigest:lease.codecDigest},op));
    const dir=await mkdtemp(join(tmpdir(),'media-snapshot-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));
    let restored;
    if(dialect==='sqlite'){const path=join(dir,'snapshot.db');await f.store.run('VACUUM INTO ?',path);await chmod(path,0o600);restored=await openDatabase(path);t.after(()=>restored.close());}
    else{
      const base=process.env.SHOP_TEST_DATABASE_URL,pool=new pg.Pool({connectionString:base}),name='shopping_test_media_restore_'+randomUUID().replaceAll('-','');await pool.query(`CREATE DATABASE ${name}`);const url=new URL(base);url.pathname='/'+name;
      const path=join(dir,'snapshot.dump');await writeFile(path,'',{mode:0o600});tool('pg_dump',f.location,['--format=custom','--no-owner','--no-privileges','--file',path]);tool('pg_restore',url.href,['--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',name,path]);restored=await openPostgresDatabase(url.href);
      t.after(async()=>{await restored.close();await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end();});
    }
    assert.equal(await operationStorageReady(restored),true);
    const row=await restored.get('SELECT * FROM mcp_v2_media_stage WHERE id=?',stage.stageId);assert.equal(row.state,'BOUND');assert.equal(row.operation_id,op);assert.equal(row.reserved_bytes,1130496);assert.deepEqual(Buffer.from(row.canonical_data),image);assert.deepEqual(Buffer.from(row.thumbnail_data),thumbnail);
    const chunks=await restored.all('SELECT \"offset\",sha256,data FROM mcp_v2_media_chunk ORDER BY \"offset\"');assert.equal(chunks.length,15);assert.deepEqual(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.data))),bytes);assert.ok(chunks.every(chunk=>mediaHash(Buffer.from(chunk.data))===chunk.sha256));
    assert.ok((await restored.all('SELECT reserved_bytes,active_slots FROM mcp_v2_media_quota')).every(q=>q.reserved_bytes===1130496&&q.active_slots===1));
    const verified=await withMediaWriter(restored,f.context,w=>w.boundBytes(stage.stageId,op),{now:f.now});assert.deepEqual(verified.image,image);assert.deepEqual(verified.thumbnail,thumbnail);assert.equal((await restored.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n,1);
    await assert.rejects(withMediaWriter(restored,{...f.context,epochHash:'0'.repeat(64)},w=>w.get(stage.stageId)),{status:409});
  });
test('SQLite to PostgreSQL import excludes all live media bytes/authority and retains only metadata events',
  {skip:!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const source=await mediaFixture(t,'sqlite'),target=await mediaFixture(t,'postgres'),{stage}=await source.upload(Buffer.from('synthetic import bytes'));
    const history=(await source.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_event')).n;await importSqlite(source.store,target.store);
    for(const table of MEDIA_STORAGE_TABLES)assert.equal((await target.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,table==='mcp_v2_media_event'?history:0,table);
    assert.equal((await source.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage WHERE id=?',stage.stageId)).n,1);
    assert.equal(await operationStorageReady(target.store),true);
  });
