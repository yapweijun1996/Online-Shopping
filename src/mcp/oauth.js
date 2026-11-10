import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { json, readBody } from '../http.js';
import { readSession, sessionCookieFrom } from '../auth.js';
import { audit, effective, eligible, hash, liveGrant, revokeGrant, secret, stamp, supportedScopes, V2_SCOPES, v2Epoch } from './credentials.js';
import { parseJson } from './json.js';
import { operationEpochCurrent } from './operation-epoch.js';
import { cleanupOAuth } from './cleanup.js';

const DAY = 86400000;
export class OAuthError extends Error {
  constructor(error = 'invalid_request', status = 400, headers = {}) { super(error); this.error = error; this.status = status; this.headers = headers; }
}
export const fail = (error, status, headers) => { throw new OAuthError(error, status, headers); };
export function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) fail();
  return value;
}
export function scopes(value, config) {
  if (typeof value !== 'string') fail('invalid_scope');
  const available = supportedScopes(config);
  const list = value.split(' ');
  if (!list.length || list.some((s) => !available.includes(s)) || new Set(list).size !== list.length) fail('invalid_scope');
  return available.filter((s) => list.includes(s));
}
export function safeRedirect(value, allowlist) {
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 2048 || !allowlist.includes(value)) return false;
    const url = new URL(value), hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || isIP(hostname) || hostname.includes(':') || !hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname)) return false;
    if ([...url.searchParams.keys()].some((key) => ['code', 'state', 'iss', 'error', 'error_description'].includes(key))) return false;
    return url.href === value;
  } catch { return false; }
}
async function readJson(request, maximum) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('invalid_request', 415);
  const bytes = await readBody(request, maximum);
  try { return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(); }
}
export async function form(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') fail('invalid_request', 415);
  let text;
  const bytes = await readBody(request, 8192);
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  if (/%(?![a-f\d]{2})/i.test(text)) fail();
  try { decodeURIComponent(text.replaceAll('+', ' ')); } catch { fail(); }
  const params = new URLSearchParams(text), result = Object.create(null);
  for (const [key, value] of params) { if (Object.hasOwn(result, key)) fail(); result[key] = value; }
  return result;
}
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const scopeDescriptions = {
  'catalog.read': 'Read products, categories, product history and low stock.',
  'orders.read': 'Read orders with the existing buyer-contact redactions.',
  'analytics.read': 'Read the sales summary.',
  'company.read': 'Read company settings; may contain seller-entered business information.',
  'company.write': 'Propose changes to company settings, including currency. Requires separate approval for each change.',
  'catalog.write': 'Propose product and listing changes, including prices. Requires separate approval for each change.',
  'media.read': 'Read catalog media and layout information.',
  'media.write': 'Propose product image uploads, replacement and layout changes. Requires separate visual review and approval.',
  'inventory.read': 'Read inventory quantities and movements.',
  'inventory.adjust': 'Propose stock quantity adjustments. Requires separate approval for each adjustment.',
  'orders.decide': 'Propose order decisions that may change order state or stock. Requires separate approval for each decision.',
  'analytics.extended': 'Read sales trends, top products and inventory risks.',
  'operations.read': 'Read safe status and audit metadata for your own operations. The original operation permissions are also required; proposals and private notes are excluded.',
  'operations.cancel': 'Directly cancel your own uncommitted operations without another approval. Original operation permissions are also required. Committed shop changes are never undone.',
};
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export function createOAuth({ store, config, tenantId, limit }) {
  const base = config.basePath || '', issuer = config.sellerOrigin + base, resource = issuer + '/mcp';
  const binding = { tenantId, issuer, resource, ...(config.mcpV2?.enabled === true ? { mcpV2: { ...config.mcpV2 } } : {}) };
  const fresh = () => { if (!operationEpochCurrent(binding.mcpV2)) fail('access_denied', 403); };
  const transaction = (work) => store.transaction(async () => {
    fresh(); const result = await work(); fresh(); return result;
  });
  const parseScopes = (value) => scopes(value, { mcpV2: binding.mcpV2 });
  const epochHash = v2Epoch({ mcpV2: binding.mcpV2 });
  async function requestEpoch(row) {
    if (!operationEpochCurrent(binding.mcpV2)) return false;
    if (!row.scopes.split(' ').some((scope) => V2_SCOPES.includes(scope))) return true;
    if (!epochHash) return false;
    const evidence = await store.get('SELECT epoch_hash, created_at FROM mcp_v2_authorization_request WHERE request_id = ?', row.id);
    return evidence?.epoch_hash === epochHash && evidence.created_at >= row.created_at && evidence.created_at <= stamp();
  }
  async function client(id) {
    const row = typeof id === 'string' && id.length <= 128 && await store.get('SELECT * FROM oauth_client WHERE id = ?', id);
    if (!row || row.disabled_at || row.tenant_id !== tenantId || row.issuer !== issuer) fail('invalid_client', 401);
    if (row.expires_at <= stamp() && !await store.get('SELECT id FROM oauth_grant WHERE client_id = ? AND revoked_at IS NULL AND absolute_expires_at > ? LIMIT 1', id, stamp())) fail('invalid_client', 401);
    return row;
  }
  async function register(request, ip) {
    fresh();
    await limit('oauth-register', ip, 20);
    const known = ['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method'], body = await readJson(request, 16384);
    // RFC 7591: ignore metadata this server does not use (e.g. scope, client_uri); only the known fields are stored and echoed.
    const input = fields(body && typeof body === 'object' && !Array.isArray(body) ? Object.fromEntries(known.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]])) : body, known);
    if (typeof input.client_name !== 'string' || !input.client_name.trim() || input.client_name.length > 80 || /[\u0000-\u001f]/.test(input.client_name) || JSON.stringify(input.grant_types) !== JSON.stringify(['authorization_code', 'refresh_token']) || JSON.stringify(input.response_types) !== '["code"]' || input.token_endpoint_auth_method !== 'none') fail('invalid_client_metadata');
    if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 5 || new Set(input.redirect_uris).size !== input.redirect_uris.length || input.redirect_uris.some((uri) => !safeRedirect(uri, config.mcpRedirectUris || []))) fail('invalid_redirect_uri');
    // Only well-formed registrations spend the shop-wide budget, so anonymous junk cannot lock every connector out.
    await limit('oauth-register-shop', 'shop', 100);
    // Reclamation must commit even if an older database still exceeds the hard cap.
    await cleanupOAuth(store);
    return transaction(async () => {
      const { count } = await store.get('SELECT COUNT(*) AS count FROM oauth_client');
      if (count >= 100) {
        const unused = await store.get(`SELECT c.id FROM oauth_client c WHERE c.last_used_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_authorization_request r WHERE r.client_id = c.id)
          ORDER BY c.created_at, c.id LIMIT 1`);
        if (!unused) fail('temporarily_unavailable', 429, { 'Retry-After': '900' });
        await store.run('DELETE FROM oauth_client WHERE id = ?', unused.id);
        if (count > 100) return json(429, { error: 'temporarily_unavailable' }, { 'Retry-After': '900' });
      }
      const id = secret();
      await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'none', ?, ?)`, id, tenantId, issuer, input.client_name, JSON.stringify(input.redirect_uris), stamp(), stamp(3600000));
      return json(201, { ...input, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    });
  }
  async function authorize(request, ip) {
    fresh();
    await limit('oauth-authorize', ip, 30);
    const url = new URL(request.url), params = Object.create(null);
    for (const [key, value] of url.searchParams) { if (Object.hasOwn(params, key)) fail(); params[key] = value; }
    const required = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'];
    // Optional display preference only; unsupported locales retain the English consent UI.
    fields(params, [...required, 'ui_locales'], required);
    const registered = await client(params.client_id);
    if (!JSON.parse(registered.redirect_uris_json).includes(params.redirect_uri)) fail('invalid_redirect_uri');
    if (params.response_type !== 'code') fail('unsupported_response_type');
    if (params.resource !== resource) fail('invalid_target');
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(params.state) || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge) || params.code_challenge_method !== 'S256') fail();
    const requested = parseScopes(params.scope).join(' '), id = randomUUID(), nonce = secret();
    await cleanupOAuth(store);
    await transaction(async () => {
      const { count } = await store.get('SELECT COUNT(*) AS count FROM oauth_authorization_request WHERE consumed_at IS NULL AND expires_at > ?', stamp());
      if (count >= 100) fail('temporarily_unavailable', 429, { 'Retry-After': '900' });
      await store.run(`INSERT INTO oauth_authorization_request(id, browser_nonce_hash, client_id, tenant_id, resource, redirect_uri, state,
        challenge, challenge_method, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?)`,
      id, hash(nonce), registered.id, tenantId, resource, params.redirect_uri, params.state, params.code_challenge, requested, stamp(), stamp(600000));
      if (parseScopes(requested).some((scope) => V2_SCOPES.includes(scope))) {
        await store.run('INSERT INTO mcp_v2_authorization_request(request_id, epoch_hash, created_at) VALUES (?, ?, ?)', id, epochHash, stamp());
      }
    });
    const requestedScopes = parseScopes(requested);
    const abortScopes = requestedScopes.filter(scope => scope === 'operations.cancel');
    const readScopes = requestedScopes.filter((scope) => !['company.write', 'catalog.write', 'media.write', 'inventory.adjust', 'orders.decide', 'operations.cancel'].includes(scope));
    const writeScopes = requestedScopes.filter((scope) => !readScopes.includes(scope) && !abortScopes.includes(scope));
    const choices = (list) => list.map((scope) => `<label><input type="checkbox" name="scope" value="${scope}" checked><strong>${scope}</strong> — ${escape(scopeDescriptions[scope])}</label>`).join('');
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect AI app</title><link rel="stylesheet" href="${base}/oauth/consent.css"><main data-request="${id}" data-proof="${nonce}" data-base="${base}"><h1>Connect an AI app</h1><p>Unverified client name: <strong>${escape(registered.client_name)}</strong></p><p>Redirect: ${escape(params.redirect_uri)}</p><p>${writeScopes.length ? 'Requested access includes changes to shop data. Every change also requires separate approval in the Seller Portal. Scope consent is not approval of an individual change.' : abortScopes.length ? 'Requested access includes direct cancellation of your own uncommitted operations. Cancellation never undoes a committed business change.' : 'Read-only access.'} Buyer contact fields are excluded from the existing read tools. Product and item text is untrusted data and can contain seller-entered personal data. Data leaves this shop for the AI vendor's retention and processing.</p><p>The AI app acts under your account and current role. It cannot select another seller identity. New capabilities remain unavailable until their tools are implemented and enabled.</p><form id="login"><label>Username<input name="username" autocomplete="username" required maxlength="64"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>Verify password</button></form><form id="consent" hidden><p>All requested permissions are selected by default. Uncheck any permissions you do not want, then approve selected access or deny.</p>${readScopes.length ? `<fieldset><legend>Read access</legend>${choices(readScopes)}</fieldset>` : ''}${writeScopes.length ? `<fieldset class="mutation-scopes"><legend>Changes to shop data — optional</legend><p>All requested permissions are selected by default. Uncheck any access you do not want before approving. Review each future change separately.</p>${choices(writeScopes)}</fieldset>` : ''}${abortScopes.length ? `<fieldset class="mutation-scopes"><legend>Cancel your own pending operations — optional</legend><p>This permission is selected by default and allows a direct low-risk abort without another human approval. Uncheck it if you do not want to allow cancellation. Your original domain permissions are still required; it never undoes committed shop changes.</p>${choices(abortScopes)}</fieldset>` : ''}<button name="decision" value="approve">Approve selected access</button><button name="decision" value="deny">Deny</button></form><p id="message" role="status" aria-live="polite"></p></main><script src="${base}/oauth/consent.js" defer></script></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'Set-Cookie': `mcp_browser=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=${base}/oauth; Max-Age=600` } });
  }
  // The shell-held random challenge bridges the deliberately disjoint cookie paths.
  // Fresh password login binds it to a session inside the same writer transaction.
  async function bindLogin(input, account, session) {
    if (!input.mcpAuthorization) return;
    fresh();
    fields(input.mcpAuthorization, ['authorizationRequestId', 'proof']);
    const { authorizationRequestId: id, proof } = input.mcpAuthorization;
    const row = typeof id === 'string' && await store.get('SELECT * FROM oauth_authorization_request WHERE id = ?', id);
    const live = await store.get('SELECT * FROM seller_account WHERE id = ?', account.id);
    if (!eligible(live) || !row || row.consumed_at || row.expires_at <= stamp() || row.created_at > stamp() || row.tenant_id !== tenantId || row.resource !== resource || typeof proof !== 'string' || proof.length !== 43 || hash(proof) !== row.browser_nonce_hash || row.session_proof_hash || !await requestEpoch(row)) fail('access_denied', 403);
    await store.run('UPDATE oauth_authorization_request SET account_id = ?, session_proof_hash = ?, account_auth_version = ? WHERE id = ? AND session_proof_hash IS NULL', account.id, hash(session.token), live.oauth_auth_version, id);
    fresh();
  }
  async function consent(request) {
    fresh();
    if (request.headers.get('origin') !== config.sellerOrigin) fail('access_denied', 403);
    const input = fields(await readJson(request, 4096), ['authorizationRequestId', 'decision', 'scopes']);
    if (!['approve', 'deny'].includes(input.decision) || !Array.isArray(input.scopes) || input.scopes.length > supportedScopes({ mcpV2: binding.mcpV2 }).length || input.scopes.some((scope) => !supportedScopes({ mcpV2: binding.mcpV2 }).includes(scope)) || new Set(input.scopes).size !== input.scopes.length) fail();
    const initial = await readSession(store, sessionCookieFrom(request.headers.get('cookie') || ''));
    if (!initial || request.headers.get('x-csrf-token') !== initial.csrf_token) fail('access_denied', 403);
    await limit('oauth-consent', initial.account.id, 20);
    return transaction(async () => {
      const session = await readSession(store, sessionCookieFrom(request.headers.get('cookie') || ''));
      if (!session || request.headers.get('x-csrf-token') !== session.csrf_token) fail('access_denied', 403);
      const row = typeof input.authorizationRequestId === 'string' && await store.get('SELECT * FROM oauth_authorization_request WHERE id = ?', input.authorizationRequestId);
      const account = await store.get('SELECT * FROM seller_account WHERE id = ?', session.account.id);
      if (!row || row.consumed_at || row.expires_at <= stamp() || row.created_at > stamp() || row.account_id !== account.id || row.session_proof_hash !== session.token_hash || row.account_auth_version !== account.oauth_auth_version || row.tenant_id !== tenantId || row.resource !== resource || !eligible(account) || !await requestEpoch(row)) fail('access_denied', 403);
      await client(row.client_id);
      const submitted = input.scopes.length ? parseScopes(input.scopes.join(' ')) : [];
      if (input.decision === 'approve' && !submitted.length) fail('invalid_scope');
      const selected = input.decision === 'approve' ? submitted : [];
      if (selected.some((s) => !row.scopes.split(' ').includes(s) || !effective(account, row.scopes, { mcpV2: binding.mcpV2 }).includes(s))) fail('invalid_scope');
      await store.run('UPDATE oauth_authorization_request SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', stamp(), row.id);
      const redirect = new URL(row.redirect_uri); redirect.searchParams.set('state', row.state); redirect.searchParams.set('iss', issuer);
      if (input.decision === 'deny') {
        redirect.searchParams.set('error', 'access_denied');
        await audit(store, tenantId, 'DENY', { account_id: account.id, client_id: row.client_id }, 'access_denied');
      } else {
        const grantId = randomUUID(), code = secret(), consentedAt = stamp();
        await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes, account_auth_version, created_at, absolute_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, grantId, account.id, row.client_id, tenantId, issuer, resource, selected.join(' '), account.oauth_auth_version, consentedAt, stamp(30 * DAY));
        for (const scope of selected.filter((scope) => V2_SCOPES.includes(scope))) {
          await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grantId, tenantId, account.id, row.client_id, scope, account.oauth_auth_version, epochHash, consentedAt);
        }
        await store.run('UPDATE oauth_client SET last_used_at = ?, expires_at = ? WHERE id = ?', stamp(), stamp(30 * DAY), row.client_id);
        await store.run(`INSERT INTO oauth_authorization_code(code_hash, grant_id, redirect_uri, resource, challenge, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, hash(code), grantId, row.redirect_uri, resource, row.challenge, stamp(), stamp(60000));
        await audit(store, tenantId, 'AUTHORIZE', { account_id: account.id, client_id: row.client_id, grant_id: grantId });
        redirect.searchParams.set('code', code);
      }
      return json(200, { redirectTo: redirect.href });
    });
  }
  async function issue(grant, scope, generation, predecessor = null) {
    const access = secret(), refresh = secret();
    for (const [value, kind, ttl] of [[access, 'access', 900000], [refresh, 'refresh', 7 * DAY]]) {
      await store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation, predecessor_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, hash(value), kind, grant.id, resource, scope, stamp(), new Date(Math.min(Date.now() + ttl, Date.parse(grant.absolute_expires_at))).toISOString(), generation, predecessor);
    }
    await store.run('UPDATE oauth_client SET last_used_at = ? WHERE id = ?', stamp(), grant.client_id);
    await audit(store, tenantId, 'ISSUE', grant);
    return json(200, { access_token: access, token_type: 'Bearer', expires_in: Math.min(900, Math.floor((Date.parse(grant.absolute_expires_at) - Date.now()) / 1000)), refresh_token: refresh, scope, resource });
  }
  async function token(request, ip) {
    fresh();
    await limit('oauth-token', ip, 60);
    if (request.headers.has('authorization')) fail('invalid_client', 401);
    const input = await form(request);
    const refresh = input.grant_type === 'refresh_token';
    if (!refresh && input.grant_type !== 'authorization_code') fail('unsupported_grant_type');
    const required = refresh ? ['grant_type', 'client_id', 'refresh_token', 'resource'] : ['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier', 'resource'];
    fields(input, refresh ? [...required, 'scope'] : required, required);
    await client(input.client_id); await limit('oauth-token-client', input.client_id, 60);
    if (input.resource !== resource) fail('invalid_target');
    return transaction(async () => {
      await client(input.client_id);
      const value = refresh ? input.refresh_token : input.code;
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('invalid_grant');
      const digest = hash(value);
      const row = await store.get(refresh ? 'SELECT * FROM oauth_token WHERE token_hash = ? AND kind = \'refresh\'' : 'SELECT * FROM oauth_authorization_code WHERE code_hash = ?', digest);
      const grant = row && await liveGrant(store, row.grant_id, binding, refresh ? row.issued_at : row.created_at);
      if (!row || !grant || grant.client_id !== input.client_id || row.resource !== resource) fail('invalid_grant');
      if (refresh && row.used_at) {
        await revokeGrant(store, grant.id, 'REFRESH_REUSE');
        await audit(store, tenantId, 'REVOKE', grant, 'REFRESH_REUSE');
        // Return rather than throw: revocation must commit even though exchange fails.
        return json(400, { error: 'invalid_grant' });
      }
      if (row.expires_at <= stamp() || (refresh ? row.issued_at : row.created_at) > stamp() || row.revoked_at || row.consumed_at) fail('invalid_grant');
      if (refresh) {
        const selected = input.scope === undefined ? row.scopes.split(' ') : parseScopes(input.scope);
        if (selected.some((s) => !row.scopes.split(' ').includes(s) || !grant.allowed.includes(s))) fail('invalid_scope');
        await store.run('UPDATE oauth_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', stamp(), digest);
        await store.run("UPDATE oauth_token SET revoked_at = ? WHERE grant_id = ? AND kind = 'access' AND revoked_at IS NULL", stamp(), grant.id);
        return issue(grant, selected.join(' '), row.generation + 1, digest);
      }
      if (!grant.allowed.length || grant.scopes.split(' ').some((scope) => V2_SCOPES.includes(scope) && !grant.allowed.includes(scope))) fail('invalid_grant');
      if (row.redirect_uri !== input.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier) || createHash('sha256').update(input.code_verifier).digest('base64url') !== row.challenge) fail('invalid_grant');
      await store.run('UPDATE oauth_authorization_code SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL', stamp(), digest);
      return issue(grant, grant.allowed.join(' '), 0);
    });
  }
  async function revoke(request, ip) {
    await limit('oauth-revoke', ip, 60);
    const input = fields(await form(request), ['client_id', 'token', 'token_type_hint'], ['client_id', 'token']);
    if (input.token_type_hint !== undefined && !['access_token', 'refresh_token'].includes(input.token_type_hint)) fail();
    if (input.token.length > 128 || input.client_id.length > 128) fail();
    return transaction(async () => {
      const row = await store.get(`SELECT g.* FROM oauth_token t JOIN oauth_grant g ON g.id = t.grant_id WHERE t.token_hash = ? AND g.client_id = ? AND g.tenant_id = ? AND g.resource = ?`, hash(input.token), input.client_id, tenantId, resource);
      if (row) { await revokeGrant(store, row.id); await audit(store, tenantId, 'REVOKE', row); }
      return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    });
  }
  return { register, authorize, token, revoke, consent, bindLogin, binding };
}
