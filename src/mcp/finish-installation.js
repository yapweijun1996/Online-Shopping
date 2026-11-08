import path from 'node:path';
import { openNodeStore } from '../store.js';
import { openPostgresStore } from '../postgres-store.js';
import { lstat, readFile } from 'node:fs/promises';
import { deploymentProfileAllowsProduction } from './deployment-profile.js';
import { operationStorageReady } from './operation-runtime.js';
import { assertFinishStorage, initializeFinishStorage } from './finish-storage.js';
import { assertCreateDraftStorage, initializeCreateDraftStorage } from './catalog-create-draft-storage.js';

const unavailable=()=>{throw new TypeError('Finish storage installation contract is not satisfied.');};
export function parseFinishInstallationArguments(args){
  const values={};
  for(const arg of args){
    const match=/^--(action|expected-origin|expected-database|expected-schema|tenant)=(.+)$/.exec(arg);
    if(!match || Object.hasOwn(values,match[1]))unavailable();values[match[1]]=match[2];
  }
  if(Object.keys(values).length!==5 || !['install','verify'].includes(values.action) || values['expected-schema']!=='34' ||
    !/^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(values.tenant))unavailable();
  try{const origin=new URL(values['expected-origin']);if(origin.origin!==values['expected-origin']||origin.protocol!=='https:')unavailable();}catch{unavailable();}
  return values;
}
// Host-only optional extension migration. This opens EXISTING stores only and
// never calls application bootstrap, migrations, login, consent or commerce.
export async function finishOwnerConnection(config,env=process.env){
  if(!env.FINISH_DATABASE_OWNER_PASSWORD_FILE)return null;
  if(!config.databaseUrl || !path.isAbsolute(env.FINISH_DATABASE_OWNER_PASSWORD_FILE))unavailable();
  const info=await lstat(env.FINISH_DATABASE_OWNER_PASSWORD_FILE);
  if(!info.isFile() || info.isSymbolicLink() || info.size<1 || info.size>512 || info.mode&0o077)unavailable();
  const owner=env.FINISH_DATABASE_OWNER_USER??'postgres';if(!/^[a-z_][a-z0-9_]{0,62}$/.test(owner))unavailable();
  const password=(await readFile(env.FINISH_DATABASE_OWNER_PASSWORD_FILE,'utf8')).replace(/\r?\n$/,'');
  if(!password || password.includes('\n') || password.includes('\r'))unavailable();
  const url=new URL(config.databaseUrl);url.username=owner;url.password=password;return url.href;
}
export async function runFinishInstallation(config,args,{ownerUrl=null}={}){
  const options=parseFinishInstallationArguments(args);
  if(config.sellerOrigin!==options['expected-origin'] || config.shopMode!=='manual' || config.sellerQuickLogin || config.mcpV2?.enabled!==true ||
    config.production && !deploymentProfileAllowsProduction(config.mcpV2.profile))unavailable();
  let store;
  try{
    if(config.databaseUrl){
      if(ownerUrl){
        const app=new URL(config.databaseUrl),owner=new URL(ownerUrl);
        if(app.hostname!==owner.hostname || app.port!==owner.port || app.pathname!==owner.pathname)unavailable();
      }
      store=openPostgresStore(ownerUrl??config.databaseUrl,{max:1});
      if((await store.get('SELECT current_database() AS name')).name!==options['expected-database'])unavailable();
    }else{
      if(path.resolve(config.dbPath)!==options['expected-database'] || !(await lstat(config.dbPath)).isFile())unavailable();
      store=openNodeStore(config.dbPath);
    }
    if(await store.schemaVersion()!==34 || !await operationStorageReady(store) || (await store.get('SELECT mode FROM shop_setup WHERE id=1'))?.mode!=='production')unavailable();
    for(const table of ['oauth_client','oauth_grant','mcp_v2_operation','mcp_v2_scope_consent','mcp_v2_media_stage'])
      if(await store.get(`SELECT tenant_id FROM ${table} WHERE tenant_id<>? LIMIT 1`,options.tenant))unavailable();
    if(options.action==='install'){
      if(config.production && store.dialect==='postgres' && !ownerUrl)unavailable();
      if(ownerUrl){const identity=await store.get(`SELECT current_user AS actor,pg_get_userbyid(d.datdba) AS owner,
        (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser FROM pg_database d WHERE d.datname=current_database()`);
        if(!identity || identity.actor!==identity.owner && identity.superuser!==true)unavailable();}

      await store.transaction(async()=>{
        await initializeFinishStorage(store);
        await initializeCreateDraftStorage(store);
        if(ownerUrl){
          const role=decodeURIComponent(new URL(config.databaseUrl).username);if(!/^[a-z_][a-z0-9_]{0,62}$/.test(role))unavailable();
          if(!await store.get('SELECT rolname FROM pg_roles WHERE rolname=?',role))unavailable();
          for(const table of ['seller_mcp_finish','seller_mcp_finish_item','seller_mcp_finish_event','seller_mcp_finish_revalidation','seller_mcp_create_draft','seller_mcp_create_draft_stage','seller_mcp_create_draft_event'])
            await store.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${table} TO "${role}"`);
          await store.exec(`GRANT SELECT ON TABLE seller_mcp_finish_schema,seller_mcp_create_draft_schema TO "${role}"`);
        }
      });
    }else {await assertFinishStorage(store);await assertCreateDraftStorage(store);}
    return {status:options.action==='install'?'INSTALLED':'VERIFIED',version:2,tenantId:options.tenant,schemaVersion:34};
  }finally{await store?.close();}
}
