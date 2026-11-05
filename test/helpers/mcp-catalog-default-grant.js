import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { secret } from '../../src/mcp/credentials.js';
import { reviewPassword } from './mcp-review-fixture.js';

export const legacyCatalogScopes = 'catalog.read orders.read analytics.read';
// Uses actual authorization/password/consent/token handlers, never seeded grants.
export async function freshCatalogAccess(f, scopes = legacyCatalogScopes + ' catalog.write', call = f.call, { username = 'synthetic_owner', password = reviewPassword } = {}) {
  const redirect = 'https://client.example.com/catalog-callback';
  const registered = await call('/oauth/register', 'POST', { client_name: 'Synthetic catalog client', redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
  const clientId = registered.data.client_id, verifier = secret() + secret();
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: scopes,
    state: secret(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: f.binding.resource });
  const staged = await call('/oauth/authorize?' + query);
  assert.equal(staged.response.status, 200, JSON.stringify(staged.data));
  const authorizationRequestId = /data-request="([^"]+)"/.exec(staged.data)?.[1], proof = /data-proof="([^"]+)"/.exec(staged.data)?.[1];
  assert.ok(authorizationRequestId); assert.ok(proof);
  const login = await call('/api/v1/seller/session', 'POST', { username, password,
    mcpAuthorization: { authorizationRequestId, proof } }, { origin: f.config.sellerOrigin });
  assert.equal(login.response.status, 200, JSON.stringify(login.data));
  const headers = { origin: f.config.sellerOrigin, cookie: login.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': login.data.csrfToken };
  const consent = await call('/api/v1/seller/mcp/consent', 'POST', { authorizationRequestId, decision: 'approve', scopes: scopes.split(' ') }, headers);
  assert.equal(consent.response.status, 200, JSON.stringify(consent.data));
  const code = new URL(consent.data.redirectTo).searchParams.get('code');
  const token = await call('/oauth/token', 'POST', new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
    code, code_verifier: verifier, redirect_uri: redirect, resource: f.binding.resource }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(token.response.status, 200, JSON.stringify(token.data));
  let seq = 0;
  const rpc = (method, params) => call('/mcp', 'POST', { jsonrpc: '2.0', id: ++seq, method, params }, {
    authorization: 'Bearer ' + token.data.access_token, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
  return { bearer: token.data.access_token, rpc, call: (name, args) => rpc('tools/call', { name, arguments: args }), headers };
}
