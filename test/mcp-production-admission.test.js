import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaHooksFixture} from './helpers/mcp-media-hooks-fixture.js';
import {createOperationEngine} from '../src/mcp/operation-engine.js';
import {readMcpDeploymentProfile} from '../src/mcp/deployment-profile.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withMediaWriter} from '../src/mcp/media-storage.js';
import {createMediaCoordinator} from '../src/mcp/media-coordinator.js';
import {createMediaRuntime} from '../src/mcp/media-runtime.js';
function profile(){return readMcpDeploymentProfile({NODE_ENV:'production',TRUST_PROXY:'1',MCP_ENABLED:'1',MCP_V2_ENABLED:'1',MCP_V2_MEDIA_ENABLED:'1',MCP_V2_CATALOG_MEDIA_CREATE_ENABLED:'1',MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED:'1',MCP_V2_PRODUCTION_PROFILE:'seller-operations-v1',MCP_V2_BACKEND_IDENTITY:'sha256:'+'a'.repeat(64)},
 {production:true,mcpEnabled:true,sellerOrigin:'https://seller.example.test',shopMode:'manual',sellerQuickLogin:false});}
function engine(f,override={}){return createOperationEngine({...f.options,production:true,profile:f.binding.mcpV2.profile,adapters:{'media.prepare_upload':{...f.adapter,...override}}});}
async function fixture(t,dialect){const f=await mediaHooksFixture(t,dialect),folder=await mkdtemp(join(tmpdir(),'production-epoch-')),epochFile=join(folder,'epoch');await writeFile(epochFile,f.options.epoch,{mode:0o600});t.after(()=>rm(folder,{recursive:true,force:true}));f.binding.mcpV2=Object.freeze({enabled:true,epoch:f.options.epoch,epochFile,buildDigest:f.options.buildDigest,profile:profile()});return f;}
async function tenant(f,id){for(const table of ['oauth_client','oauth_grant','mcp_v2_scope_consent'])await f.store.run('UPDATE '+table+' SET tenant_id=?',id);f.context.tenantId=id;f.binding.tenantId=id;}
for(const dialect of ['sqlite','postgres']){
 const opts={skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL};
 test(`${dialect}: sole production engine shares one admission across different tenant instances before any capture/blob read`,opts,async t=>{
  // Storage/engine paths are real; resolver and review are explicitly SYNTHETIC.
  const one=await fixture(t,dialect),two=await fixture(t,dialect);await tenant(one,'one');await tenant(two,'two');
  const stage1=await one.startStage(),stage2=await two.startStage();let started,release;
  const began=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  const first=engine(one,{media:{...one.adapter.media,resolve:async(...args)=>{assert.equal(one.depth(),0);started();await blocked;return one.adapter.media.resolve(...args);}}}),second=engine(two);
  const running=one.prepare(stage1,'production-media-first',first);await began;
  let blobReads=0;const get=two.store.get,all=two.store.all,inspect=sql=>{if(/^SELECT\b/i.test(sql)&&/\b(image_data|thumb_data|data)\b.*\bFROM\s+(product|product_gallery_image)\b/is.test(sql))blobReads++;};
  two.store.get=(sql,...args)=>{inspect(sql);return get(sql,...args);};two.store.all=(sql,...args)=>{inspect(sql);return all(sql,...args);};
  try{await assert.rejects(two.prepare(stage2,'production-media-second',second),{status:503,code:'MEDIA_BUSY'});assert.equal(two.counters.capture,0);assert.equal(blobReads,0);
   assert.equal((await withMediaWriter(two.store,two.context,w=>w.inspect(stage2.stageId))).state,'UPLOADING');
  }finally{two.store.get=get;two.store.all=all;release();}
  const op=await running;assert.equal(op.status,'PENDING_APPROVAL');assert.equal((await two.prepare(stage2,'production-media-second',second)).status,'PENDING_APPROVAL');
  // Replay must bypass media admission/capture while a different request owns it.
  const third=await two.startStage('synthetic-media-stage-third');let began3,release3;const started3=new Promise(resolve=>began3=resolve),held3=new Promise(resolve=>release3=resolve);
  const thirdEngine=engine(two,{media:{...two.adapter.media,resolve:async(...args)=>{began3();await held3;return two.adapter.media.resolve(...args);}}});
  const running3=two.prepare(third,'production-media-third',thirdEngine);await started3;
  try{assert.equal((await one.prepare(stage1,'production-media-first',first)).replayed,true);}finally{release3();await running3;}
 });
 test(`${dialect}: capture, resolver and final persistence failure all release the production admission lease`,opts,async t=>{
  const f=await fixture(t,dialect);
  for(const kind of ['capture','resolve','preview']){
   const stage=await f.startStage('synthetic-stage-'+kind),failure=()=>{throw new Error('Synthetic '+kind+' failure');};
   const broken=engine(f,kind==='preview'?{preview:failure}:{media:{...f.adapter.media,[kind]:failure}});
   await assert.rejects(f.prepare(stage,'production-failure-'+kind,broken),new RegExp('Synthetic '+kind+' failure'));
   const next=await f.startStage('synthetic-follow-'+kind);assert.equal((await f.prepare(next,'production-follow-'+kind,engine(f))).status,'PENDING_APPROVAL');
  }
 });
}
test('production media constructors keep actual production profile and reject injected decoder overrides',async t=>{
 const issuer='https://seller.example.test',store={transaction(){}},tenantGuard={withActiveTenant(){}},base={store,tenantGuard,binding:{tenantId:'default',issuer,resource:issuer+'/mcp'},epoch:Buffer.alloc(32).toString('base64url'),buildDigest:'a'.repeat(64),codec:{digest:'b'.repeat(64),socketPath:'/private/codec.sock',token:Buffer.alloc(32).toString('base64url')},enabled:true,quickLogin:false,production:true};
 assert.throws(()=>createMediaCoordinator(base),TypeError);
 const folder=await mkdtemp(join(tmpdir(),'coordinator-epoch-')),epochFile=join(folder,'epoch');await writeFile(epochFile,base.epoch,{mode:0o600});t.after(()=>rm(folder,{recursive:true,force:true}));
 base.binding.mcpV2={enabled:true,epoch:base.epoch,epochFile,buildDigest:base.buildDigest,profile:profile()};
 assert.ok(createMediaCoordinator({...base,profile:base.binding.mcpV2.profile}));
 const noop=()=>{},adapter={resourceType:'company',preview:noop,currentRevision:noop,apply:noop,validResult:noop,toReceipt:noop,validReceipt:noop};
 for(const mcpV2 of [undefined,{...base.binding.mcpV2,epochFile:undefined},{...base.binding.mcpV2,epoch:Buffer.alloc(32,1).toString('base64url')}])assert.throws(()=>createOperationEngine({...base,profile:profile(),binding:{...base.binding,mcpV2},adapters:{'company.preview_update':adapter}}),TypeError);
 assert.throws(()=>createMediaCoordinator({...base,profile:profile(),decode(){}}),TypeError);
 const config={production:true,mcpEnabled:true,sellerOrigin:issuer,shopMode:'manual',mcpV2:{enabled:true,profile:profile(),buildDigest:'a'.repeat(64)},mcpMedia:{enabled:true,codecDigest:'b'.repeat(64)},mcpCatalogMediaCreate:{enabled:true},mcpCatalogMediaUpdate:{enabled:true}};
 assert.throws(()=>createMediaRuntime({store,binding:base.binding,config,tenantGuard,quickLogin:false,decode(){}}),TypeError);
});
