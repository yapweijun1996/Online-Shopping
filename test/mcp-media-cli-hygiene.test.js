import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import pg from 'pg';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { runSellerMcpCleanup } from '../src/mcp/cleanup-runner.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createPlatformTenantOperationGuard } from '../src/platform/tenant-operation-guard.js';
import { createSecretBox,parseKeyFile } from '../src/secret-box.js';
const base=process.env.SHOP_TEST_DATABASE_URL;
test('actual suspended-tenant flag-off host hygiene removes expired media while ordinary authority remains denied',
  {skip:!base,timeout:30000},async t=>{
    const id=randomUUID(),name='t_mediatest_'+randomUUID().slice(0,8),f=await mediaFixture(t,'postgres',{now:'2020-01-01T00:00:00.000Z',tenantId:id,tenantRevision:0,databaseName:name});
    await f.upload(Buffer.alloc(1024,3));
    const control=new pg.Pool({connectionString:base}),platformName='shopping_test_media_platform_'+randomUUID().replaceAll('-','');await control.query(`CREATE DATABASE ${platformName}`);
    const url=new URL(base);url.pathname='/'+platformName;const platform=await openPlatformDatabase(url.href);
    t.after(async()=>{await platform.close();await control.query(`DROP DATABASE ${platformName} WITH (FORCE)`);await control.end();});
    const keys=parseKeyFile('k1='+randomBytes(32).toString('base64')),box=createSecretBox(keys),sealed=box.seal('SYNTHETIC_MEDIA_PASSWORD',`TENANT_DB:${id}`),now=new Date().toISOString();
    await platform.run(`INSERT INTO tenant(id,code,name,status,currency,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at)
      VALUES(?,'mediatest','Synthetic media shop','SUSPENDED','MYR',?,?,?,?,?,?)`,id,name,name,sealed.sealed,sealed.keyId,now,now);
    let authority=false,opens=0,fallback=false;const normal=createPlatformTenantOperationGuard(platform);
    await assert.rejects(normal.withActiveTenant(id,()=>{authority=true;}),{status:503});assert.equal(authority,false);
    const result=await runSellerMcpCleanup({config:{platform:{databaseUrl:url.href},integrationKeys:keys,mcpEnabled:false,mcpV2:{enabled:false}},tenantId:id,passes:2},{
      openPlatform:async()=>({...platform,close:async()=>{}}),openDefault:async()=>{fallback=true;throw new Error('Unexpected default store.');},
      openTenant:async value=>{const selected=new URL(value);assert.equal(selected.pathname,'/'+name);assert.equal(selected.username,name);assert.equal(selected.password,'SYNTHETIC_MEDIA_PASSWORD');opens++;return{...f.store,close:async()=>{}};},
    });
    assert.deepEqual(result,{cleanupPasses:2});assert.equal(opens,1);assert.equal(fallback,false);
    for(const table of ['mcp_v2_media_stage','mcp_v2_media_chunk','mcp_v2_media_pin','mcp_v2_media_quota'])assert.equal((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0,table);
    assert.equal((await platform.get('SELECT status FROM tenant WHERE id=?',id)).status,'SUSPENDED');
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_media_event WHERE outcome='SCRUBBED'")).n,1);
    await assert.rejects(normal.withActiveTenant(id,()=>{authority=true;}),{status:503});assert.equal(authority,false);
  });
