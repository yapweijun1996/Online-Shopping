import { readFile } from 'node:fs/promises';
import { ApiError, json } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { createOAuth, fail, OAuthError } from './oauth.js';
import { createProtocol } from './protocol.js';
import { audit, SCOPES } from './credentials.js';
import { cleanupOAuth } from './cleanup.js';

export const connectorPath = (path) => /^\/(?:mcp$|oauth\/(?:register|authorize|token|revoke|consent\.js|consent\.css)$|\.well-known\/oauth-(?:protected-resource|authorization-server)(?:\/|$)|api\/v1\/seller\/mcp(?:\/|$))/.test(path);
export function createConnector({ store, config, tenantId, quickLogin }) {
  const enabled = config.mcpEnabled === true && !quickLogin && Boolean(config.sellerOrigin) && new URL(config.sellerOrigin).protocol === 'https:';
  const limiters = new Map();
  const limit = async (bucket, key, count) => {
    if (!limiters.has(bucket)) limiters.set(bucket, new SqlLimiter(store, bucket, { limit: count, windowMs: 900000 }));
    if (!await limiters.get(bucket).attempt(key)) fail('temporarily_unavailable', 429, { 'Retry-After': '900' });
  };
  const oauth = createOAuth({ store, config, tenantId, limit });
  const protocol = createProtocol({ store, config, binding: oauth.binding, limit });
  async function handle(request, ip) {
    if (!config.mcpEnabled) return null;
    const url = new URL(request.url), path = url.pathname;
    if (!connectorPath(path)) return null;
    if (!enabled || url.host !== new URL(config.sellerOrigin).host) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    const origin = request.headers.get('origin');
    const approved = origin === config.sellerOrigin || (config.mcpBrowserOrigins || []).includes(origin);
    let response;
    try {
      if (origin !== null) {
        let canonical = false;
        try { canonical = new URL(origin).origin === origin; } catch { /* Reject malformed Origin below. */ }
        if (!approved || !canonical || origin === 'null') fail('access_denied', 403);
      }
      if (request.url.length > 8192) fail('invalid_request', 414);
      if (request.method === 'OPTIONS') {
        const requested = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
        if (!origin || !approved || !['GET', 'POST'].includes(request.headers.get('access-control-request-method')) || requested.some((s) => !['authorization', 'content-type', 'mcp-protocol-version'].includes(s))) fail('access_denied', 403);
        response = new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Cache-Control': 'no-store' } });
      } else if (['/oauth/consent.js', '/oauth/consent.css'].includes(path)) {
        if (request.method !== 'GET') fail('invalid_request', 405, { Allow: 'GET' });
        const extension = path.endsWith('.js') ? 'js' : 'css';
        response = new Response(await readFile(new URL(`./consent.${extension}`, import.meta.url)), {
          headers: { 'Content-Type': extension === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' },
        });
      } else if (/^\/\.well-known\/oauth-(?:protected-resource(?:\/mcp)?|authorization-server)$/.test(path)) {
        if (request.method !== 'GET') fail('invalid_request', 405, { Allow: 'GET' });
        await limit('mcp-discovery', ip, 120);
        const { issuer, resource } = oauth.binding;
        response = path.includes('protected-resource') ? json(200, { resource, authorization_servers: [issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'] }) : json(200, { issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token', registration_endpoint: issuer + '/oauth/register', revocation_endpoint: issuer + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true });
      } else {
        const handlers = { '/oauth/register': ['POST', oauth.register], '/oauth/authorize': ['GET', oauth.authorize], '/oauth/token': ['POST', oauth.token], '/oauth/revoke': ['POST', oauth.revoke], '/mcp': ['POST', protocol], '/api/v1/seller/mcp/consent': ['POST', oauth.consent] };
        const handler = handlers[path];
        if (!handler) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
        if (request.method !== handler[0]) fail('invalid_request', 405, { Allow: handler[0] });
        response = await handler[1](request, ip);
        await cleanupOAuth(store);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw e;
      if (e instanceof OAuthError && [400, 401, 403].includes(e.status)) {
        try {
          await limit('mcp-deny-audit', ip, 120);
          await store.transaction(() => audit(store, tenantId, 'DENY', {}, e.error));
        } catch { /* Denial never releases data; an unavailable audit cannot turn it into success. */ }
      }
      response = json(e instanceof OAuthError ? e.status : e instanceof ApiError ? e.status : 503, { error: e instanceof OAuthError ? e.error : 'temporarily_unavailable' }, e.headers || {});
    }
    response.headers.set('Referrer-Policy', 'no-referrer'); response.headers.set('X-Content-Type-Options', 'nosniff'); response.headers.set('Cache-Control', 'no-store');
    if (origin && approved) { response.headers.set('Access-Control-Allow-Origin', origin); response.headers.set('Vary', 'Origin'); response.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version'); }
    return response;
  }
  return { handle, bindLogin: async (...args) => {
    if (!enabled) return;
    try { await oauth.bindLogin(...args); }
    catch (e) { if (e instanceof OAuthError) throw new ApiError(e.status, 'FORBIDDEN', 'Authorization proof is invalid.'); throw e; }
  } };
}
