import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../../src/db.js';
import { openPostgresDatabase } from '../../src/postgres-db.js';
import { withMediaWriter, mediaHash, storeMediaPolicy } from '../../src/mcp/media-storage.js';
import { operationReceiptExpiry } from '../../src/mcp/operation-maintenance.js';
export async function mediaFixture(t,dialect,{now:givenNow,tenantId='synthetic',tenantRevision=1,databaseName}={}) {
  let store,location;
  if(dialect==='sqlite'){store=await openDatabase(':memory:');t.after(()=>store.close());}
  else{
    const base=process.env.SHOP_TEST_DATABASE_URL;if(!base||process.env.NODE_ENV!=='test'||!/test/i.test(new URL(base).pathname))throw new Error('Disposable PostgreSQL required.');
    const pool=new pg.Pool({connectionString:base}),name=databaseName??('shopping_test_media_'+randomUUID().replaceAll('-',''));if(!/^[a-z0-9_]+$/.test(name))throw new Error('Invalid synthetic database.');await pool.query(`CREATE DATABASE ${name}`);
    const url=new URL(base);url.pathname='/'+name;location=url.href;store=await openPostgresDatabase(url.href);
    t.after(async()=>{await store.close();await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);await pool.end();});
  }
  const now=givenNow??new Date().toISOString(),context={tenantId,tenantRevision,accountId:randomUUID(),clientId:randomUUID(),grantId:randomUUID(),accountAuthVersion:0,
    epochHash:'a'.repeat(64),buildDigest:'b'.repeat(64),issuer:'https://seller.example.test',resource:'https://seller.example.test/mcp',grantExpiresAt:new Date(Date.parse(now)+86400000).toISOString()};
  const input=(bytes,key='synthetic-media-stage-0001')=>({productId:randomUUID(),targetSlot:'MAIN',expectedRevision:'c'.repeat(64),sourceSha256:mediaHash(bytes),sourceMime:'image/png',declaredBytes:bytes.length,codecDigest:'d'.repeat(64),idempotencyKey:key});
  const writer=(work,clock=now,identity=context)=>withMediaWriter(store,identity,work,{now:clock});
  const upload=async(bytes,key)=>{const args=input(bytes,key),stage=await writer(w=>w.begin(args));for(let offset=0;offset<bytes.length;offset+=36864)await writer(w=>w.append(stage.stageId,offset,bytes.subarray(offset,offset+36864)));return{args,stage,lease:await writer(w=>w.claimValidation(stage.stageId))};};
  const operation=async(codecDigest,clock=now,correlationId=randomUUID())=>{
    const id=randomUUID(),expires=new Date(Date.parse(clock)+600000).toISOString();
    await store.transaction(async()=>{
      await store.run(`INSERT INTO mcp_v2_operation(id,tenant_id,tenant_revision,account_id,client_id,grant_id,epoch_hash,build_digest,issuer,resource,tool_name,required_scope,required_capability,risk,resource_type,envelope_json,preview_hash,request_hash,idempotency_hash,state,created_at,expires_at,receipt_expires_at,correlation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,'media.prepare_upload','media.write','catalog.write','HIGH','product','{}',?,?,?,'PENDING_APPROVAL',?,?,?,?)`,id,context.tenantId,context.tenantRevision,context.accountId,context.clientId,context.grantId,context.epochHash,context.buildDigest,context.issuer,context.resource,'e'.repeat(64),'e'.repeat(64),mediaHash(id),clock,expires,operationReceiptExpiry(context.grantExpiresAt),correlationId);
      await storeMediaPolicy(store,context,id,{policyId:'media-upload-v1',manifestRoot:'f'.repeat(64),graphRevision:'e'.repeat(64),codecDigest,pageCount:1,assetCount:1,effectCount:1});
    });return id;
  };
  return{store,now,context,input,writer,upload,operation,location};
}
