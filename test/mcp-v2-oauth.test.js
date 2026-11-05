import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { ensureAdmin } from '../src/auth.js';
import { createApi } from '../src/app.js';
import { createAccount, resetPasswordFromHost, updateAccount } from '../src/accounts.js';
import { hash, secret, liveGrant, SCOPES, supportedScopes, v2Epoch } from '../src/mcp/credentials.js';
import { initializeOperationStorage } from '../src/mcp/operation-runtime.js';
import { verifyOperationAuthority } from '../src/mcp/operation-authorization.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable PostgreSQL test database required.');
const origin = 'https://seller.example.com', redirect = 'https://connector.example.com/callback';
const password = 'Synthetic-Owner-Password-2026!';
const enabled = () => ({ enabled: true, epoch: secret(), buildDigest: 'a'.repeat(64) });
async function fixture(t, engine, mcpV2 = enabled()) {
  let store;
  if (engine === 'postgres') {
    const pool = new pg.Pool({ connectionString: base }), name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  } else { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  await ensureAdmin(store, 'fixture_owner', password);
  // Explicit isolated extension installation; this fixture does not activate a deployment migration.
  if (mcpV2?.enabled) await initializeOperationStorage(store, { enabled: true });
  const config = { sellerOrigin: origin, publicOrigin: 'https://shop.example.com', mcpEnabled: true,
    mcpRedirectUris: [redirect], production: false, shopMode: 'manual', mcpV2 };
  let api = await createApi({ store, config }), sequence = 0;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await api(new Request(origin + path, { method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), { clientAddress: `oauth-v2-${++sequence}` });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  };
  const register = async () => {
    const result = await call('/oauth/register', 'POST', { client_name: 'Fictional AI', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); return result.data.client_id;
  };
  const stage = async (clientId, scope = 'catalog.read catalog.write', extra = '') => {
    const verifier = secret() + secret();
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect,
      scope, state: secret(), code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', resource: origin + '/mcp' });
    const result = await call('/oauth/authorize?' + query + extra);
    return { ...result, verifier, authorizationRequestId: /data-request="([^"]+)"/.exec(result.data)?.[1], proof: /data-proof="([^"]+)"/.exec(result.data)?.[1] };
  };
  const login = async (staged, username = 'fixture_owner', pass = password) => {
    const result = await call('/api/v1/seller/session', 'POST', { username, password: pass,
      mcpAuthorization: { authorizationRequestId: staged.authorizationRequestId, proof: staged.proof } }, { origin });
    return { ...result, headers: { origin, cookie: result.response.headers.get('set-cookie')?.split(';')[0] || '', 'x-csrf-token': result.data.csrfToken || '' } };
  };
  const approve = (staged, signed, scopes, extra = {}) => call('/api/v1/seller/mcp/consent', 'POST',
    { authorizationRequestId: staged.authorizationRequestId, decision: 'approve', scopes, ...extra }, signed.headers);
  const exchange = (clientId, code, verifier) => call('/oauth/token', 'POST', new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
    redirect_uri: redirect, resource: origin + '/mcp' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  const refresh = (grant, patch = {}) => call('/oauth/token', 'POST', new URLSearchParams({
    grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh_token, resource: origin + '/mcp', ...patch
  }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  const grant = async (requested = 'catalog.read catalog.write', selected = requested.split(' ')) => {
    const clientId = await register(), staged = await stage(clientId, requested);
    assert.equal(staged.response.status, 200, JSON.stringify(staged.data));
    const signed = await login(staged); assert.equal(signed.response.status, 200, JSON.stringify(signed.data));
    const accepted = await approve(staged, signed, selected); assert.equal(accepted.response.status, 200, JSON.stringify(accepted.data));
    const code = new URL(accepted.data.redirectTo).searchParams.get('code');
    const issued = await exchange(clientId, code, staged.verifier); assert.equal(issued.response.status, 200, JSON.stringify(issued.data));
    return { clientId, staged, signed, code, ...issued.data };
  };
  const rpc = (token, method, params = {}) => call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method, params },
    { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
  const binding = () => ({ tenantId: 'default', issuer: origin, resource: origin + '/mcp', mcpV2: config.mcpV2 });
  return { store, config, call, register, stage, login, approve, exchange, grant, refresh, rpc, binding,
    recreate: async () => { api = await createApi({ store, config }); } };
}

for (const engine of ['sqlite', 'postgres']) {
  const options = { skip: engine === 'postgres' && !base };
  test(`${engine}: v2 is default-off and scope strings cannot activate authority`, options, async (t) => {
    const f = await fixture(t, engine, null);
    // Legacy callers have no v2 configuration and no extension tables.
    delete f.config.mcpV2; await f.recreate();
    assert.deepEqual(supportedScopes(f.config), SCOPES);
    const clientId = await f.register();
    assert.equal((await f.stage(clientId, 'catalog.write')).data.error, 'invalid_scope');
    const legacy = await f.grant('catalog.read');
    await f.store.run("UPDATE oauth_grant SET scopes = 'catalog.read catalog.write' WHERE client_id = ?", legacy.clientId);
    assert.equal((await f.refresh(legacy, { scope: 'catalog.write' })).data.error, 'invalid_scope');
    const rotated = await f.refresh(legacy); assert.equal(rotated.data.scope, 'catalog.read');
    assert.equal((await f.rpc(rotated.data.access_token, 'tools/list')).data.result.tools.length, 5);
  });
  test(`${engine}: fresh OAuth consent records exact v2 identity and exposes only consented implemented tools`, options, async (t) => {
    const f = await fixture(t, engine), grant = await f.grant('catalog.read orders.read analytics.read catalog.write company.read inventory.adjust');
    assert.match(grant.staged.data, /Read access/); assert.match(grant.staged.data, /Changes to shop data/);
    assert.doesNotMatch(grant.staged.data, /value="(?:catalog.write|company.read|inventory.adjust)" checked/);
    assert.match(grant.staged.data, /Scope consent is not approval of an individual change/);
    const listed = (await f.rpc(grant.access_token, 'tools/list')).data.result.tools;
    assert.equal(listed.length, 9);
    assert.deepEqual(listed.slice(8).map((tool) => tool.name), ['company.get']);
    assert.equal((await f.rpc(grant.access_token, 'tools/call', { name: 'catalog.commit_create', arguments: {} })).data.error.code, -32602);
    const token = await f.store.get('SELECT * FROM oauth_token WHERE token_hash = ?', hash(grant.access_token));
    const evidence = await f.store.all('SELECT * FROM mcp_v2_scope_consent WHERE grant_id = ? ORDER BY scope', token.grant_id);
    assert.deepEqual(evidence.map((row) => row.scope), ['catalog.write', 'company.read', 'inventory.adjust']);
    assert.ok(evidence.every((row) => row.client_id === grant.clientId && row.tenant_id === 'default' && row.epoch_hash === v2Epoch(f.config) && row.consented_at <= token.issued_at));
    assert.ok((await liveGrant(f.store, token.grant_id, f.binding(), token.issued_at)).allowed.includes('catalog.write'));
    await f.store.transaction(() => verifyOperationAuthority(f.store, { bearer: grant.access_token, binding: f.binding(), toolName: 'catalog.preview_create', epochHash: v2Epoch(f.config) }));
    const rotated = await f.refresh(grant); assert.equal(rotated.response.status, 200); assert.equal(rotated.data.scope, grant.scope);
  });
  test(`${engine}: v2 rejects unrequested, duplicate, ambiguous and impersonation fields`, options, async (t) => {
    const f = await fixture(t, engine), clientId = await f.register();
    for (const scope of ['operations.read', 'operations.cancel', 'catalog.write catalog.write', 'unknown.read']) assert.equal((await f.stage(clientId, scope)).data.error, 'invalid_scope');
    assert.equal((await f.stage(clientId, 'catalog.write', '&scope=catalog.read')).data.error, 'invalid_request');
    const staged = await f.stage(clientId), signed = await f.login(staged);
    for (const selected of [['catalog.write', 'catalog.write'], ['catalog.read catalog.write'], [null], ['company.write']]) assert.equal((await f.approve(staged, signed, selected)).response.status, 400);
    assert.equal((await f.approve(staged, signed, ['catalog.write'], { accountId: randomUUID() })).data.error, 'invalid_request');
    assert.equal((await f.approve(staged, signed, [])).data.error, 'invalid_scope');
    const accepted = await f.approve(staged, signed, ['catalog.read']); assert.equal(accepted.response.status, 200);
    const issued = await f.exchange(clientId, new URL(accepted.data.redirectTo).searchParams.get('code'), staged.verifier);
    assert.equal(issued.data.scope, 'catalog.read');
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n, 0);
  });
  test(`${engine}: adding write strings to old grant and tokens cannot supply separate consent`, options, async (t) => {
    const f = await fixture(t, engine), grant = await f.grant('catalog.read');
    const token = await f.store.get('SELECT * FROM oauth_token WHERE token_hash = ?', hash(grant.access_token));
    await f.store.run("UPDATE oauth_grant SET scopes = 'catalog.read catalog.write' WHERE id = ?", token.grant_id);
    await f.store.run("UPDATE oauth_token SET scopes = 'catalog.read catalog.write' WHERE grant_id = ?", token.grant_id);
    assert.deepEqual((await liveGrant(f.store, token.grant_id, f.binding(), token.issued_at)).allowed, ['catalog.read']);
    assert.equal((await f.refresh(grant)).data.error, 'invalid_scope');
    await assert.rejects(f.store.transaction(() => verifyOperationAuthority(f.store, { bearer: grant.access_token, binding: f.binding(), toolName: 'catalog.preview_create', epochHash: v2Epoch(f.config) })));
    const narrowed = await f.refresh(grant, { scope: 'catalog.read' }); assert.equal(narrowed.data.scope, 'catalog.read');
  });
  test(`${engine}: old read grant refresh stays read-only after v2 is enabled`, options, async (t) => {
    const f = await fixture(t, engine, { enabled: false }), grant = await f.grant('catalog.read');
    await initializeOperationStorage(f.store, { enabled: true }); f.config.mcpV2 = enabled(); await f.recreate();
    assert.equal((await f.refresh(grant, { scope: 'catalog.write' })).data.error, 'invalid_scope');
    const result = await f.refresh(grant); assert.equal(result.data.scope, 'catalog.read');
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n, 0);
  });
  test(`${engine}: consent epoch, identity and issuance cutoff fence token use and refresh`, options, async (t) => {
    const f = await fixture(t, engine), grant = await f.grant();
    const token = await f.store.get('SELECT * FROM oauth_token WHERE token_hash = ?', hash(grant.access_token));
    const original = await f.store.get('SELECT * FROM mcp_v2_scope_consent WHERE grant_id = ?', token.grant_id);
    for (const [column, value] of [['tenant_id', 'other'], ['account_id', randomUUID()], ['client_id', 'other'], ['account_auth_version', original.account_auth_version + 1], ['epoch_hash', '0'.repeat(64)], ['consented_at', new Date(Date.parse(token.issued_at) + 1000).toISOString()]]) {
      await f.store.run(`UPDATE mcp_v2_scope_consent SET ${column} = ? WHERE grant_id = ?`, value, token.grant_id);
      assert.ok(!(await liveGrant(f.store, token.grant_id, f.binding(), token.issued_at)).allowed.includes('catalog.write'), column);
      assert.equal((await f.refresh(grant)).data.error, 'invalid_scope', column);
      await f.store.run(`UPDATE mcp_v2_scope_consent SET ${column} = ? WHERE grant_id = ?`, original[column], token.grant_id);
    }
    f.config.mcpV2 = enabled(); await f.recreate();
    assert.ok(!(await liveGrant(f.store, token.grant_id, f.binding(), token.issued_at)).allowed.includes('catalog.write'));
    assert.equal((await f.refresh(grant)).data.error, 'invalid_scope');
    await assert.rejects(f.store.transaction(() => verifyOperationAuthority(f.store, { bearer: grant.access_token, binding: f.binding(), toolName: 'catalog.preview_create', epochHash: v2Epoch(f.config) })));
  });
  test(`${engine}: restore epoch fences pending v2 consent and code exchange`, options, async (t) => {
    const f = await fixture(t, engine), clientId = await f.register(), staged = await f.stage(clientId), signed = await f.login(staged);
    const fresh = await f.stage(clientId), freshSigned = await f.login(fresh), consent = await f.approve(fresh, freshSigned, ['catalog.read', 'catalog.write']);
    const code = new URL(consent.data.redirectTo).searchParams.get('code');
    f.config.mcpV2 = enabled(); await f.recreate();
    assert.equal((await f.approve(staged, signed, ['catalog.write'])).response.status, 403);
    assert.equal((await f.login(staged)).response.status, 403);
    const issued = await f.exchange(clientId, code, fresh.verifier);
    assert.equal(issued.data.error, 'invalid_grant');
    assert.doesNotMatch(JSON.stringify(issued.data), /access_token|catalog.write/);
  });
  test(`${engine}: future token and authorization timestamps fail closed`, options, async (t) => {
    const f = await fixture(t, engine), grant = await f.grant();
    const future = new Date(Date.now() + 60000).toISOString();
    await f.store.run('UPDATE oauth_token SET issued_at = ? WHERE token_hash = ?', future, hash(grant.access_token));
    assert.equal((await f.rpc(grant.access_token, 'ping')).response.status, 401);
    await f.store.run('UPDATE oauth_token SET issued_at = ? WHERE token_hash = ?', future, hash(grant.refresh_token));
    assert.equal((await f.refresh(grant)).data.error, 'invalid_grant');
    const staged = await f.stage(grant.clientId);
    await f.store.run('UPDATE oauth_authorization_request SET created_at = ? WHERE id = ?', future, staged.authorizationRequestId);
    assert.equal((await f.login(staged)).response.status, 403);
    const next = await f.stage(grant.clientId), signed = await f.login(next);
    await f.store.run('UPDATE mcp_v2_authorization_request SET created_at = ? WHERE request_id = ?', future, next.authorizationRequestId);
    assert.equal((await f.approve(next, signed, ['catalog.write'])).response.status, 403);
    const fresh = await f.stage(grant.clientId), freshSigned = await f.login(fresh);
    const accepted = await f.approve(fresh, freshSigned, ['catalog.write']);
    const code = new URL(accepted.data.redirectTo).searchParams.get('code');
    await f.store.run('UPDATE oauth_authorization_code SET created_at = ? WHERE code_hash = ?', future, hash(code));
    assert.equal((await f.exchange(grant.clientId, code, fresh.verifier)).data.error, 'invalid_grant');
  });
  test(`${engine}: current seller role is enforced for scope consent and existing v2 tokens`, options, async (t) => {
    const f = await fixture(t, engine), owner = await f.store.get("SELECT id FROM seller_account WHERE role = 'OWNER'");
    const manager = await createAccount(f.store, { username: 'fixture_manager', password: 'Temporary-Fixture-2026!', role: 'MANAGER' }, 'fixture_owner');
    await resetPasswordFromHost(f.store, manager.username, 'Permanent-Fixture-2026!', { forceChange: false });
    const clientId = await f.register(), staged = await f.stage(clientId, 'company.read catalog.write'), signed = await f.login(staged, manager.username, 'Permanent-Fixture-2026!');
    assert.equal((await f.approve(staged, signed, ['company.read'])).data.error, 'invalid_scope');
    const consent = await f.approve(staged, signed, ['catalog.write']); assert.equal(consent.response.status, 200);
    const issued = await f.exchange(clientId, new URL(consent.data.redirectTo).searchParams.get('code'), staged.verifier); assert.equal(issued.data.scope, 'catalog.write');
    await updateAccount(f.store, manager.id, { role: 'STAFF' }, 'fixture_owner', owner.id);
    assert.equal((await f.rpc(issued.data.access_token, 'ping')).response.status, 401);
    assert.equal((await f.refresh({ clientId, ...issued.data })).data.error, 'invalid_grant');
  });
}
