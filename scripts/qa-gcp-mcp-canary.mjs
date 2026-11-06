// Synthetic HTTP client executed inside the nonce-owned published backend.
// No server factory, registry, auth rows, approval injection or native import.
// stdout is a PRIVATE captured protocol: it includes synthetic credentials.
// The Python harness persists it root0600 and publishes only `evidence`.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const need = (ok, code) => { if (!ok) throw new Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function canonicalDefinitions(value) {
  if (Array.isArray(value)) return value.map(canonicalDefinitions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalDefinitions(value[key])]));
  return value;
}
function assertLegacyDefinitions(tools, trustedHash) {
  need(typeof trustedHash === 'string' && /^[a-f0-9]{64}$/.test(trustedHash), 'LEGACY_BASELINE_REQUIRED');
  const actual = hash(JSON.stringify(canonicalDefinitions(tools)));
  need(actual === trustedHash, 'LEGACY_BASELINE_MISMATCH');
  return actual;
}
const legacyScopes = ['catalog.read', 'orders.read', 'analytics.read'];
const scopes = [...legacyScopes, 'company.read', 'company.write', 'catalog.write', 'media.read', 'media.write',
  'inventory.read', 'inventory.adjust', 'orders.decide', 'analytics.extended', 'operations.read', 'operations.cancel'];
const legacyNames = ['catalog.list', 'catalog.get', 'catalog.categories', 'catalog.history', 'catalog.low_stock', 'orders.list', 'orders.get', 'analytics.summary'];
const names = [...legacyNames, 'company.get', 'company.preview_update', 'company.commit_update',
  'catalog.preview_create', 'catalog.commit_create', 'catalog.preview_update', 'catalog.commit_update',
  'media.list', 'media.prepare_upload', 'media.commit_upload', 'media.preview_layout', 'media.commit_layout',
  'inventory.summary', 'inventory.movements', 'inventory.preview_adjustment', 'inventory.commit_adjustment',
  'orders.preview_decision', 'orders.commit_decision', 'analytics.sales_trend', 'analytics.top_products', 'analytics.inventory_risk',
  'operations.get', 'operations.audit', 'operations.cancel'];
let input, state, evidence = {}, pool, seq = 0;

async function request(path, method = 'GET', body, headers = {}, socketPath) {
  need(path.startsWith('/') && path.length < 8192, 'HTTP_PATH');
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let timer;
    const req = http.request({ ...(socketPath ? { socketPath } : { hostname: '127.0.0.1', port: 3000 }), path, method, agent: false,
      maxHeaderSize: 8192, headers: { Host: socketPath ? 'localhost' : input.sellerHost, Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 700000) res.destroy(new Error('HTTP_BOUND')); else chunks.push(chunk); });
      res.on('error', reject); res.on('aborted', () => reject(new Error('HTTP_ABORT')));
      res.on('end', () => {
        clearTimeout(timer); const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'); let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, data, bytes });
      });
    });
    timer = setTimeout(() => { req.destroy(new Error('HTTP_DEADLINE')); }, 6000);
    req.on('error', error => { clearTimeout(timer); reject(error); }); req.end(payload);
  });
}

async function form(path, body) {
  return request(path, 'POST', new URLSearchParams(body).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
}

async function login(password = state.password, binding) {
  const result = await request('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password, ...(binding ? { mcpAuthorization: binding } : {}) }, { Origin: input.origin });
  need(result.status === 200, 'LOGIN');
  const cookie = result.headers['set-cookie']?.[0]?.split(';')[0];
  need(cookie?.startsWith('seller_session=') && typeof result.data.csrfToken === 'string', 'SESSION');
  return { Origin: input.origin, Cookie: cookie, 'X-CSRF-Token': result.data.csrfToken };
}

async function authorize(requested, exchange = true, unbound = false) {
  if (!state.clientId) {
    const registered = await request('/oauth/register', 'POST', { client_name: 'Synthetic canary client', redirect_uris: [input.redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    need(registered.status === 201, 'REGISTER'); state.clientId = registered.data.client_id;
  }
  const verifier = secret() + secret(), browserState = secret();
  const shell = await request('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: state.clientId,
    redirect_uri: input.redirect, scope: requested.join(' '), state: browserState, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: input.origin + '/mcp' }));
  need(shell.status === 200 && typeof shell.data === 'string', 'AUTHORIZE');
  const authorizationRequestId = /data-request="([^"]+)"/.exec(shell.data)?.[1], proof = /data-proof="([^"]+)"/.exec(shell.data)?.[1];
  need(/^[0-9a-f-]{36}$/.test(authorizationRequestId || '') && /^[A-Za-z0-9_-]{43}$/.test(proof || ''), 'AUTHORIZATION_PROOF');
  if (unbound) return { authorizationRequestId, proof, verifier };
  const session = await login(state.password, { authorizationRequestId, proof });
  const consent = await request('/api/v1/seller/mcp/consent', 'POST', { authorizationRequestId, decision: 'approve', scopes: requested }, session);
  need(consent.status === 200, 'EXPLICIT_CONSENT');
  const redirect = new URL(consent.data.redirectTo);
  need(redirect.origin + redirect.pathname === input.redirect && redirect.searchParams.get('state') === browserState, 'REDIRECT_BINDING');
  const code = redirect.searchParams.get('code'); need(code, 'CODE');
  const family = { session, code, verifier, clientId: state.clientId, requested };
  if (!exchange) return family;
  const token = await form('/oauth/token', { grant_type: 'authorization_code', client_id: state.clientId, code, code_verifier: verifier,
    redirect_uri: input.redirect, resource: input.origin + '/mcp' });
  need(token.status === 200 && typeof token.data.access_token === 'string' && typeof token.data.refresh_token === 'string', 'CODE_EXCHANGE');
  need(same([...token.data.scope.split(' ')].sort(), [...requested].sort()), 'CONSENT_SCOPE');
  return { ...family, access: token.data.access_token, refresh: token.data.refresh_token };
}

async function rpc(family, method, params) {
  return request('/mcp', 'POST', { jsonrpc: '2.0', id: ++seq, method, params }, {
    Authorization: 'Bearer ' + family.access, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' });
}

async function tool(family, name, args) {
  const response = await rpc(family, 'tools/call', { name, arguments: args });
  need(response.status === 200 && !response.data.error && response.data.result?.structuredContent, 'TOOL_RESULT');
  return response.data.result.structuredContent;
}

async function listed(family, expected) {
  const response = await rpc(family, 'tools/list', {});
  need(response.status === 200 && Array.isArray(response.data.result?.tools), 'TOOLS_LIST');
  const tools = response.data.result.tools;
  need(same(tools.map(x => x.name).sort(), [...expected].sort()), 'EXACT_TOOL_NAMES');
  if (expected === legacyNames) evidence.legacyDefinitionsSha256 = assertLegacyDefinitions(tools, input.legacyDefinitionsSha256);
  return tools;
}

async function query(sql, values = []) {
  need(/^SELECT\b/.test(sql), 'READ_ONLY_SQL');
  if (!pool) pool = new pg.Pool({ host: process.env.DATABASE_HOST, user: process.env.DATABASE_USER,
    database: process.env.DATABASE_NAME, password: (await readFile(process.env.DATABASE_PASSWORD_FILE, 'utf8')).trim(), max: 1,
    connectionTimeoutMillis: 3000, query_timeout: 4000, options: '-c default_transaction_read_only=on' });
  return (await pool.query(sql, values)).rows;
}

async function business() {
  const rows = await query('SELECT availability_text FROM company_setting WHERE id=1');
  const counts = (await query('SELECT (SELECT COUNT(*) FROM product)::int AS products,(SELECT COUNT(*) FROM shop_order)::int AS orders'))[0];
  need(counts.products === 0 && counts.orders === 0, 'SYNTHETIC_EMPTY_COMMERCE');
  return { marker: rows[0].availability_text, ...counts };
}

async function passwordApproval(path, body, session) {
  state.approvalAttempts ??= 0;
  need(state.approvalAttempts < 5, 'APPROVAL_BUDGET');
  state.approvalAttempts++;
  return request(path, 'POST', body, session);
}

async function company({ pending = false, previewOnly = false, wrongPassword = false } = {}) {
  const before = (await tool(state.full, 'company.get', {})).company;
  const marker = `Synthetic canary ${input.nonce} ${secret().slice(0, 8)}`;
  const op = await tool(state.full, 'company.preview_update', { input: { expectedRevision: before.revision, changes: { availabilityText: marker } }, idempotencyKey: 'synthetic-canary-' + secret() });
  need(op.status === 'PENDING_APPROVAL' && (await business()).marker === before.availabilityText, 'PREVIEW_NO_WRITE');
  const path = '/api/v1/seller/mcp/operations/' + op.operationId;
  need((await rpc(state.full, 'tools/call', { name: 'company.commit_update', arguments: { operationId: op.operationId } })).status === 403, 'COMMIT_REQUIRES_APPROVAL');
  let review = await request(path, 'GET', undefined, state.full.session);
  need(review.status === 200 && review.data.previewHash === op.previewHash && review.data.proposal.after.availabilityText === marker, 'PROTECTED_REVIEW');
  state.pending = op;
  if (previewOnly) { evidence.company = { previewOnly: true, syntheticApproval: false }; return; }
  const approval = () => ({ operationId: op.operationId, previewHash: op.previewHash, challenge: review.data.challenge, decision: 'approve', password: state.password });
  // The real approval route rejects CSRF before its persistent address quota.
  need((await request(path + '/approval', 'POST', approval(), { ...state.full.session, 'X-CSRF-Token': 'wrong' })).status === 403, 'APPROVAL_CSRF');
  if (wrongPassword) {
    need(input.action === 'on' && !state.wrongPasswordTested, 'WRONG_PASSWORD_ONCE');
    need((await passwordApproval(path + '/approval', { ...approval(), password: 'Wrong-synthetic-password-7391!' }, state.full.session)).status === 403, 'APPROVAL_PASSWORD');
    state.wrongPasswordTested = true;
  }
  review = await request(path, 'GET', undefined, state.full.session); need(review.status === 200, 'FRESH_REVIEW');
  need((await passwordApproval(path + '/approval', approval(), state.full.session)).status === 200, 'SYNTHETIC_PASSWORD_APPROVAL');
  if (pending) return;
  const first = await tool(state.full, 'company.commit_update', { operationId: op.operationId });
  const replay = await tool(state.full, 'company.commit_update', { operationId: op.operationId });
  need(first.status === 'COMMITTED' && first.replayed === false && replay.replayed === true && same(first.result, replay.result), 'EXACTLY_ONCE_RECEIPT');
  const lifecycle = (await query("SELECT COUNT(*)::int AS n FROM mcp_v2_event WHERE operation_id=$1 AND event='COMMIT'", [op.operationId]))[0].n;
  const audits = (await query("SELECT COUNT(*)::int AS n FROM mcp_audit WHERE operation_id=$1 AND event='CALL' AND outcome='COMMITTED'", [op.operationId]))[0].n;
  need(lifecycle === 1 && audits === 1 && (await business()).marker === marker, 'EXACTLY_ONCE_DATABASE');
  state.marker = marker; evidence.company = { commitEvents: lifecycle, committedCalls: audits, replayed: true, syntheticApproval: true };
  state.committed = { operationId: op.operationId, result: first.result };
}

async function full() {
  state.full = await authorize(scopes);
  const initialized = await rpc(state.full, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-canary', version: '1' } });
  need(initialized.status === 200 && initialized.data.result?.protocolVersion === '2025-06-18', 'PROTOCOL');
  const tools = await listed(state.full, names);
  evidence.tools = { count: tools.length, namesSha256: hash([...names].sort().join('\n')), exactNames: true, new24ResponseSchemasClaimed: false, explicitConsent: true };
}

async function native() {
  const wire = await import('/app/src/mcp/media-codec-wire.js');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==', 'base64');
  const token = (await readFile(process.env.MCP_V2_MEDIA_TOKEN_FILE, 'utf8')).trim();
  const socket = process.env.MCP_V2_MEDIA_SOCKET_PATH;
  const result = await request('/v1/decode', 'POST', bytes, { Authorization: 'Bearer ' + token, 'Content-Type': 'image/png', 'X-Source-Sha256': hash(bytes) }, socket);
  need(result.status === 200 && result.headers['content-type'] === 'application/octet-stream' &&
    Number(result.headers['content-length']) === result.bytes.length && result.bytes.length <= wire.MAX_OUTPUT, 'NATIVE_PACKET');
  const value = wire.decodeOutput(result.bytes, hash(bytes));
  need(value.width === 1 && value.height === 1 && value.imageBytes === value.image.length && value.thumbnailBytes === value.thumbnail.length &&
    value.sourceSha256 === hash(bytes) && value.imageSha256 === hash(value.image) && value.thumbnailSha256 === hash(value.thumbnail) &&
    value.imageBytes <= wire.MAX_SOURCE && value.thumbnailBytes <= wire.MAX_THUMBNAIL, 'NATIVE_HASHES_LIMITS');
  const badToken = await request('/v1/ready', 'GET', undefined, { Authorization: 'Bearer ' + (token[0] === 'A' ? 'B' : 'A') + token.slice(1) }, socket);
  need(badToken.status === 401, 'NATIVE_BAD_TOKEN');
  const invalid = Buffer.from('not-an-image');
  need((await request('/v1/decode', 'POST', invalid, { Authorization: 'Bearer ' + token, 'Content-Type': 'image/png', 'X-Source-Sha256': hash(invalid) }, socket)).status === 400, 'NATIVE_INVALID_IMAGE');
  evidence.native = { width: 1, height: 1, packetBytes: result.bytes.length, packetSha256: hash(result.bytes),
    sourceSha256: hash(bytes), imageBytes: value.imageBytes, imageSha256: value.imageSha256,
    thumbnailBytes: value.thumbnailBytes, thumbnailSha256: value.thumbnailSha256, negativeCases: 2 };
}

async function main() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; need(size <= 65536, 'INPUT_BOUND'); chunks.push(chunk); }
  input = JSON.parse(Buffer.concat(chunks)); state = input.state || {};
  need(/^[a-f0-9]{64}$/.test(input.legacyDefinitionsSha256 || ''), 'LEGACY_BASELINE_REQUIRED');
  need(/^[0-9a-f]{12}$/.test(input.nonce) && input.sellerHost === `seller.${input.nonce}.invalid` &&
    input.origin === 'https://' + input.sellerHost && input.redirect === `https://client.example.com/canary-${input.nonce}` &&
    process.env.NODE_ENV === 'production' && process.env.ADMIN_USERNAME === 'synthetic_owner' &&
    process.env.DATABASE_HOST === 'postgres' && process.env.DATABASE_NAME === 'online_shopping', 'SYNTHETIC_ENVIRONMENT');
  state.password ??= (await readFile(process.env.ADMIN_PASSWORD_FILE, 'utf8')).trim();
  if (input.action === 'baseline') {
    need((await request('/mcp')).status === 404, 'OFF_MCP');
    const session = await login();
    need((await request('/api/v1/seller/setup', 'POST', { mode: 'production', shopName: 'Synthetic isolated canary' }, session)).status === 200, 'SYNTHETIC_SETUP');
    need((await query('SELECT version FROM schema_meta WHERE id=1'))[0].version === 34, 'SCHEMA34');
    await business(); evidence.baseline = { schema: 34, products: 0, orders: 0, mcpOff: true };
  } else if (input.action === 'on') {
    await full(); state.legacy = await authorize(legacyScopes);
    await listed(state.legacy, legacyNames);
    need((await rpc(state.legacy, 'tools/call', { name: 'company.preview_update', arguments: { input: { expectedRevision: 'a'.repeat(64), changes: { availabilityText: 'Unconsented' } }, idempotencyKey: 'synthetic-denied-' + secret() } })).status === 403, 'LEGACY_WRITE_DENIED');
    await company({ wrongPassword: true }); await native();
  } else if (input.action === 'native') await native();
  else if (input.action === 'readiness-failed') {
    need((await request('/ready')).status === 503, 'CRASH_PRIVATE_READINESS'); evidence.privateReadinessFailed = true;
  }
  else if (input.action === 'grants-live') {
    await listed(state.full, names);
    await listed(state.legacy, legacyNames);
    const replay = await tool(state.full, 'company.commit_update', { operationId: state.committed.operationId });
    need(replay.status === 'COMMITTED' && replay.replayed === true && same(replay.result, state.committed.result), 'RECOVERED_COMMIT_REPLAY');
    need((await business()).marker === state.marker, 'COMMERCE_PRESERVED'); evidence.grantsPreserved = true;
    evidence.committedReplayAcrossRecovery = true;
  } else if (input.action === 'pending') await company({ pending: true });
  else if (input.action === 'epoch-fenced') {
    need((await rpc(state.full, 'tools/call', { name: 'company.commit_update', arguments: { operationId: state.pending.operationId } })).status === 403, 'EPOCH_PENDING_FENCE');
    await listed(state.legacy, legacyNames); need((await business()).marker === state.marker, 'ROLLBACK_NO_COMMERCE_UNDO');
    await full(); await company({ previewOnly: true }); evidence.sameBuildEpochFence = true;
  } else if (input.action === 'restore-prepare') {
    state.restoreFull = state.full; state.restoreLegacy = state.legacy;
    state.restoreCode = await authorize(legacyScopes, false);
    state.restoreUnbound = await authorize(legacyScopes, false, true);
    const counts = (await query('SELECT (SELECT COUNT(*) FROM oauth_grant WHERE revoked_at IS NULL)::int AS grants,(SELECT COUNT(*) FROM session)::int AS sessions,(SELECT COUNT(*) FROM oauth_authorization_code WHERE consumed_at IS NULL)::int AS codes,(SELECT COUNT(*) FROM oauth_authorization_request WHERE account_id IS NULL AND consumed_at IS NULL)::int AS unbound'))[0];
    need(counts.grants >= 2 && counts.sessions >= 1 && counts.codes >= 1 && counts.unbound >= 1, 'RESTORE_LIVE_CREDENTIALS'); evidence.snapshotCredentialCounts = counts;
  } else if (input.action === 'restore-revoke') {
    for (const family of [state.restoreFull, state.restoreLegacy]) need((await form('/oauth/revoke', { client_id: family.clientId, token: family.refresh })).status === 200, 'PRE_RESTORE_REVOKE');
    need((await rpc(state.restoreLegacy, 'tools/list', {})).status === 401, 'REVOKED_BEFORE_RESTORE'); evidence.revokedBeforeRestore = true;
  } else if (input.action === 'restore-finished') {
    for (const family of [state.restoreFull, state.restoreLegacy]) {
      need((await rpc(family, 'tools/list', {})).status === 401, 'RESTORED_BEARER_DENIED');
      const refreshed = await form('/oauth/token', { grant_type: 'refresh_token', client_id: family.clientId, refresh_token: family.refresh, resource: input.origin + '/mcp' });
      need(refreshed.status === 400 && refreshed.data.error === 'invalid_grant', 'RESTORED_REFRESH_DENIED');
      need((await request('/api/v1/seller/session', 'GET', undefined, family.session)).status === 401, 'RESTORED_SESSION_DENIED');
    }
    const staleCode = await form('/oauth/token', { grant_type: 'authorization_code', client_id: state.restoreCode.clientId, code: state.restoreCode.code,
      code_verifier: state.restoreCode.verifier, redirect_uri: input.redirect, resource: input.origin + '/mcp' });
    need(staleCode.status === 400 && staleCode.data.error === 'invalid_grant', 'RESTORED_CODE_DENIED');
    need((await request('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password: state.password }, { Origin: input.origin })).status === 401, 'OLD_PASSWORD_DENIED');
    const session = await login(input.temporaryPassword);
    const gated = await request('/api/v1/seller/company-settings', 'GET', undefined, session);
    need(gated.status === 403 && gated.data.error?.code === 'PASSWORD_CHANGE_REQUIRED', 'FORCED_PASSWORD_GATE');
    const nextPassword = 'Synthetic-new-' + secret() + '!';
    need((await request('/api/v1/seller/account/password', 'POST', { currentPassword: input.temporaryPassword, newPassword: nextPassword }, session)).status === 200, 'ACTUAL_PASSWORD_CHANGE');
    state.password = nextPassword;
    const unbound = await request('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password: state.password,
      mcpAuthorization: { authorizationRequestId: state.restoreUnbound.authorizationRequestId, proof: state.restoreUnbound.proof } }, { Origin: input.origin });
    need(unbound.status === 403, 'RESTORED_UNBOUND_DENIED');
    await full(); state.legacy = await authorize(legacyScopes);
    await listed(state.legacy, legacyNames);
    await company(); evidence.restoreHygiene = { staleFamilies: 2, sessionsDenied: 2, codeDenied: true, unboundDenied: true, actualPasswordChange: true };
  } else if (input.action === 'fallback-marker') {
    await company(); evidence.fallbackMarkerCommitted = true;
  } else if (input.action === 'off') {
    need((await request('/mcp')).status === 404 && (await business()).marker === state.marker, 'OFF_FALLBACK_COMMERCE');
    need(state.approvalAttempts === 5 && state.wrongPasswordTested === true, 'COMPLETE_APPROVAL_BUDGET');
    evidence.offFallback = { mcpOff: true, commercePreserved: true };
  } else throw new Error('ACTION');
  evidence.approvalAttempts = state.approvalAttempts ?? 0;
  if (pool) await pool.end();
  process.stdout.write(JSON.stringify({ ok: true, state, evidence }));
}

try { await main(); }
catch (error) {
  if (pool) await pool.end().catch(() => {});
  process.stdout.write(JSON.stringify({ ok: false, code: /^[A-Z_]{1,64}$/.test(error.message || '') ? error.message : 'CLIENT_FAILED' }));
  process.exitCode = 1;
}
