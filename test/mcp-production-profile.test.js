import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { ensureAdmin } from '../src/auth.js';
import { setupShop } from '../src/shop-setup.js';
import { createApi } from '../src/app.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { catalogue } from '../src/mcp/tools.js';
import { companyReadTool, companyMutationTool } from '../src/mcp/company-tools.js';
import { operationBuildDigest } from '../src/mcp/operation-runtime.js';
import { deploymentProfileAllowsProduction, readMcpDeploymentProfile, mcpOperationRuntimeEnabled, mcpMediaRuntimeEnabled } from '../src/mcp/deployment-profile.js';
import { catalogMediaCreateEnabled, catalogMediaUpdateEnabled } from '../src/mcp/catalog-media-config.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';

const run = promisify(execFile), identity = 'sha256:' + 'a'.repeat(64), codec = 'sha256:' + 'b'.repeat(64);
const password = 'T7!pQ9xV4mK2rD8zL6nF1cH5jB3sA0wE';
const common = { production: true, mcpEnabled: true, sellerOrigin: 'https://seller.example.com', shopMode: 'manual', sellerQuickLogin: false };
const full = { NODE_ENV: 'production', TRUST_PROXY: '1', MCP_ENABLED: '1', MCP_V2_ENABLED: '1', MCP_V2_MEDIA_ENABLED: '1',
  MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED: '1', MCP_V2_CATALOG_MEDIA_CREATE_ENABLED: '1',
  MCP_V2_PRODUCTION_PROFILE: 'seller-operations-v1', MCP_V2_BACKEND_IDENTITY: identity };
const guard = { withActiveTenant() {} }, context = { quickLogin: false, tenantGuard: guard };
const physicalOptions = { skip: process.platform !== 'linux' || process.getuid() !== 1000 || process.getgid() !== 1000 ||
  spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status !== 0 ? 'Requires real Linux UID/GID1000 and test-owned socket chown support.' : false };

test('production profile is explicit, closed and frozen; partial mode and invalid image pins fail before filesystem work', () => {
  const profile = readMcpDeploymentProfile(full, common);
  assert.deepEqual(profile, { version: 1, kind: 'production', name: 'seller-operations-v1', backendIdentity: identity });
  assert.equal(Object.isFrozen(profile), true); assert.equal(deploymentProfileAllowsProduction(profile), true);
  for (const value of [undefined, true, { ...profile }, Object.freeze({ ...profile, backendIdentity: 'bad' }),
    Object.freeze({ ...profile, version: 2 }), Object.freeze({ ...profile, allowWrites: true }),
    Object.freeze({ ...profile, [Symbol('extra')]: true }), Object.freeze(Object.defineProperty({ ...profile }, 'hidden', { value: true }))]) assert.equal(deploymentProfileAllowsProduction(value), false);
  for (const key of ['MCP_ENABLED', 'MCP_V2_ENABLED', 'MCP_V2_MEDIA_ENABLED', 'MCP_V2_CATALOG_MEDIA_CREATE_ENABLED', 'MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED']) {
    for (const value of [undefined, '0', 'true', 1]) assert.throws(() => readMcpDeploymentProfile({ ...full, [key]: value }, common));
  }
  assert.throws(() => readMcpDeploymentProfile({ ...full, MCP_V2_PRODUCTION_PROFILE: undefined }, { ...common, production: false }));
  for (const value of [undefined, '0', 'true', 1]) assert.throws(() => readMcpDeploymentProfile({ ...full, TRUST_PROXY: value }, common));
  for (const value of [undefined, '', 'full', 'seller-operations-v2']) assert.throws(() => readMcpDeploymentProfile({ ...full, MCP_V2_PRODUCTION_PROFILE: value }, common));
  for (const value of [undefined, '', 'sha256:' + 'A'.repeat(64), 'sha256:abc', 'a'.repeat(64)]) assert.throws(() => readMcpDeploymentProfile({ ...full, MCP_V2_BACKEND_IDENTITY: value }, common));
  for (const patch of [{ production: false }, { mcpEnabled: false }, { sellerOrigin: 'http://seller.example.com' },
    { sellerOrigin: 'https://seller.example.com/path' }, { shopMode: 'public-demo' }, { sellerQuickLogin: true }]) assert.throws(() => readMcpDeploymentProfile(full, { ...common, ...patch }));
});

test('all v2 off preserves legacy production without epoch, codec or backend identity reads; development remains independently configurable', () => {
  const env = { NODE_ENV: 'production', ADMIN_USERNAME: 'synthetic_owner', ADMIN_PASSWORD: password,
    DATABASE_URL: 'postgres://unused.invalid/synthetic', PUBLIC_ORIGIN: 'https://shop.example.com', SELLER_ORIGIN: common.sellerOrigin, MCP_ENABLED: '1' };
  for (const key of ['MCP_V2_EPOCH_FILE', 'MCP_V2_BACKEND_IDENTITY', 'MCP_V2_MEDIA_SOCKET_PATH', 'MCP_V2_MEDIA_TOKEN_FILE']) {
    Object.defineProperty(env, key, { get() { throw new Error('OFF must not read ' + key); } });
  }
  const config = readConfig(env); assert.deepEqual(config.mcpV2, { enabled: false }); assert.deepEqual(config.mcpMedia, { enabled: false });
  assert.equal(mcpOperationRuntimeEnabled(config, context), false);
  assert.equal(readMcpDeploymentProfile({ NODE_ENV: 'production', MCP_ENABLED: '1' }, common).kind, 'disabled');
  assert.equal(readMcpDeploymentProfile({ NODE_ENV: 'test', MCP_V2_ENABLED: '1', MCP_V2_MEDIA_ENABLED: '0' }, { production: false }).kind, 'development');
  for (const flag of ['unknown', '', '1']) assert.throws(() => readMcpDeploymentProfile({ NODE_ENV: 'production', MCP_V2_PRODUCTION_PROFILE: flag }, common));
  const base = { production: false, mcpEnabled: true, shopMode: 'manual', mcpV2: { enabled: true } };
  assert.equal(mcpOperationRuntimeEnabled(base, context), true); assert.equal(mcpMediaRuntimeEnabled(base, context), false);
  assert.equal(mcpOperationRuntimeEnabled({ ...base, production: true }, context), false);
});

// Physical permission fixture only: no native decoder, fake approval or transport
// override. Registration/configuration must never connect to this socket.
async function sealed(t) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
  const dir = await mkdtemp(join(tmpdir(), 'shopping-production-profile-')); await chmod(dir, 0o700);
  const sockets = join(dir, 'socket'), socketPath = join(sockets, 'codec.sock'), tokenFile = join(dir, 'token'), epoch = join(dir, 'epoch');
  await mkdir(sockets, { mode: 0o710 }); await chmod(sockets, 0o710);
  await writeFile(tokenFile, secret(), { mode: 0o640 }); await chmod(tokenFile, 0o640); await writeFile(epoch, secret(), { mode: 0o600 });
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); assert.equal(connections, 0); });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o660);
  await run('sudo', ['-n', 'chown', '10001:1000', '--', socketPath]);
  const env = { ...full, ADMIN_USERNAME: 'synthetic_owner', ADMIN_PASSWORD: password,
    PUBLIC_ORIGIN: 'https://shop.example.com', SELLER_ORIGIN: common.sellerOrigin, DB_PATH: join(dir, 'data', 'shop.db'),
    MCP_REDIRECT_URIS: 'https://client.example.com/catalog-callback', MCP_V2_EPOCH_FILE: epoch,
    MCP_V2_MEDIA_CODEC_IDENTITY: codec, MCP_V2_MEDIA_SOCKET_PATH: socketPath, MCP_V2_MEDIA_TOKEN_FILE: tokenFile };
  return { env, socketPath, tokenFile };
}

test('physical production configuration keeps actual production mode, source and immutable backend identity bindings, strict sealed credentials', physicalOptions, async t => {
  const f = await sealed(t), config = readConfig(f.env), profile = config.mcpV2.profile;
  assert.equal(config.production, true); assert.equal(profile.kind, 'production'); assert.equal(config.mcpMedia.enabled, true);
  assert.equal(catalogMediaCreateEnabled(config, context), true); assert.equal(catalogMediaUpdateEnabled(config, context), true);
  assert.equal(mcpOperationRuntimeEnabled(config, context), true); assert.equal(mcpMediaRuntimeEnabled(config, context), true);
  const sourceDigest = operationBuildDigest(), expected = createHash('sha256').update(JSON.stringify({ domain: 'mcp-v2/production-build/v1', backendIdentity: identity, sourceDigest })).digest('hex');
  assert.equal(config.mcpV2.buildDigest, expected); assert.notEqual(expected, sourceDigest);
  const changed = readConfig({ ...f.env, MCP_V2_BACKEND_IDENTITY: 'sha256:' + 'c'.repeat(64) }); assert.notEqual(changed.mcpV2.buildDigest, expected);
  assert.equal(readConfig(f.env).mcpV2.buildDigest, expected);
  for (const patch of [{ mcpV2: { ...config.mcpV2, profile: undefined } }, { mcpCatalogMediaCreate: { enabled: false } },
    { mcpCatalogMediaUpdate: { enabled: false } }, { mcpMedia: { enabled: false } }, { shopMode: 'public-demo' }]) assert.equal(mcpOperationRuntimeEnabled({ ...config, ...patch }, context), false);
  assert.equal(mcpOperationRuntimeEnabled(config, { ...context, quickLogin: true }), false);
  assert.equal(mcpOperationRuntimeEnabled(config, { quickLogin: false }), false);
  await chmod(f.tokenFile, 0o644); assert.throws(() => readConfig(f.env), /trusted sealed local codec/);
  await chmod(f.tokenFile, 0o640); assert.equal(readConfig(f.env).mcpMedia.enabled, true);
});

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: actual production-profile OAuth keeps legacy eight/read refresh and separate consent; backend identity change invalidates approved proposal`,
  { skip: physicalOptions.skip || (dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL ? 'Disposable PostgreSQL not configured.' : false) }, async t => {
  const physical = await sealed(t); let config = readConfig(physical.env);
  let store;
  if (dialect === 'sqlite') { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  else {
    const base = process.env.SHOP_TEST_DATABASE_URL; assert.equal(process.env.NODE_ENV, 'test'); assert.match(new URL(base).pathname, /test/i);
    const admin = new pg.Pool({ connectionString: base }), name = 'shopping_test_production_profile_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE DATABASE ${name}`); const url = new URL(base); url.pathname = '/' + name;
    try { store = await openPostgresDatabase(url.href); } catch (error) { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); throw error; }
    t.after(async () => { await store.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  }
  await ensureAdmin(store, config.username, password); await setupShop(store, { mode: 'production', shopName: 'Synthetic production profile' });
  const entries = [companyReadTool(), companyMutationTool()];
  let api = await createApi({ store, config, operationTools: entries }), refresh;
  const binding = { tenantId: 'default', issuer: config.sellerOrigin, resource: config.sellerOrigin + '/mcp' };
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await api(new Request(config.sellerOrigin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), { clientAddress: 'synthetic-production-profile' });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (path === '/oauth/token' && response.status === 200) refresh = data.refresh_token;
    return { response, data };
  };
  const f = { store, config, binding, call }, login = { username: config.username, password };
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n), 0);
  const old = await freshCatalogAccess(f, legacyCatalogScopes, call, login);
  assert.deepEqual((await old.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...value }) => value));
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n), 0);
  const token = await store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?', hash(old.bearer)), oldGrant = await store.get('SELECT * FROM oauth_grant WHERE id=?', token.grant_id);
  const renewed = await call('/oauth/token', 'POST', new URLSearchParams({ grant_type: 'refresh_token', client_id: oldGrant.client_id, refresh_token: refresh, resource: binding.resource }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(renewed.response.status, 200); assert.equal(renewed.data.scope, legacyCatalogScopes);
  await store.run('UPDATE oauth_grant SET scopes=? WHERE id=?', legacyCatalogScopes + ' company.write', oldGrant.id);
  await store.run('UPDATE oauth_token SET scopes=? WHERE token_hash=?', legacyCatalogScopes + ' company.write', hash(renewed.data.access_token));
  const forbidden = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'company.preview_update', arguments: { input: { expectedRevision: 'a'.repeat(64), changes: { availabilityText: 'Unconsented' } }, idempotencyKey: 'production-unconsented-test' } } },
    { authorization: 'Bearer ' + renewed.data.access_token, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
  assert.equal(forbidden.response.status, 403); assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
  const current = await freshCatalogAccess(f, legacyCatalogScopes + ' company.read company.write', call, login);
  assert.equal((await current.rpc('tools/list', {})).data.result.tools.length, 11); // Explicit fixture entries, NOT a full32/native gate.
  const company = (await current.call('company.get', {})).data.result.structuredContent.company;
  const prepared = await current.call('company.preview_update', { input: { expectedRevision: company.revision, changes: { availabilityText: 'Synthetic reviewed text' } }, idempotencyKey: 'production-reviewed-company' });
  assert.equal(prepared.response.status, 200); const op = prepared.data.result.structuredContent, path = '/api/v1/seller/mcp/operations/' + op.operationId;
  const reviewed = await call(path, 'GET', undefined, current.headers); assert.equal(reviewed.response.status, 200);
  const approved = await call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash, challenge: reviewed.data.challenge, decision: 'approve', password }, current.headers);
  assert.equal(approved.response.status, 200); assert.equal((await store.get('SELECT state FROM mcp_v2_operation WHERE id=?', op.operationId)).state, 'APPROVED');
  config = readConfig({ ...physical.env, MCP_V2_BACKEND_IDENTITY: 'sha256:' + 'd'.repeat(64) });
  api = await createApi({ store, config, operationTools: entries });
  assert.equal((await current.call('company.commit_update', { operationId: op.operationId })).response.status, 403);
  assert.equal((await store.get('SELECT availability_text FROM company_setting WHERE id=1')).availability_text, null);
  config = readConfig({ ...physical.env, MCP_V2_ENABLED: '0', MCP_V2_MEDIA_ENABLED: '0', MCP_V2_CATALOG_MEDIA_CREATE_ENABLED: '0',
    MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED: '0', MCP_V2_PRODUCTION_PROFILE: undefined, MCP_V2_BACKEND_IDENTITY: undefined });
  api = await createApi({ store, config, operationTools: entries });
  assert.deepEqual((await current.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...value }) => value));
});

for(const dialect of ['sqlite','postgres'])test(dialect+': enabled production finish asserts preinstalled storage and never creates or repairs tables at startup',
 {skip:physicalOptions.skip || dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
  const physical=await sealed(t),config=readConfig({...physical.env,MCP_V2_FINISH_ENABLED:'1'});
  let store,admin,name;
  if(dialect==='sqlite')store=await openDatabase(':memory:');
  else{admin=new pg.Pool({connectionString:process.env.SHOP_TEST_DATABASE_URL});name='shopping_test_finish_start_'+randomUUID().replaceAll('-','');
   await admin.query(`CREATE DATABASE ${name}`);const url=new URL(process.env.SHOP_TEST_DATABASE_URL);url.pathname='/'+name;store=await openPostgresDatabase(url.href);}
  t.after(async()=>{await store.close();if(admin){await admin.query(`DROP DATABASE ${name} WITH(FORCE)`);await admin.end();}});
  await ensureAdmin(store,config.username,password);await setupShop(store,{mode:'production',shopName:'Synthetic finish production'});
  const original=store.exec;let ddl=0;
  const denyDdl=async sql=>{if(/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)){ddl++;throw new Error('Unexpected production DDL');}return original(sql);};
  const probe=async()=>{const api=await createApi({store,config,operationTools:[]});return api(new Request(config.sellerOrigin+'/ready'));};
  store.exec=denyDdl;assert.equal((await probe()).status,500);assert.equal(ddl,0);
  store.exec=original;const{initializeFinishStorage}=await import('../src/mcp/finish-storage.js');await initializeFinishStorage(store);
  // Synthetic sealed codec socket closes requests, so readiness remains 503;
  // successful tenant construction is distinguished from the missing/drifted 500.
  store.exec=denyDdl;assert.equal((await probe()).status,503);assert.equal(ddl,0);
  store.exec=original;await store.exec('DROP INDEX seller_mcp_finish_retention');store.exec=denyDdl;
  assert.equal((await probe()).status,500);assert.equal(ddl,0);
 });
