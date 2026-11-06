import { mcpOperationRuntimeEnabled } from './deployment-profile.js';
import { orderDecisionTool } from './order-tools.js';
import { operationControlTools } from './operation-control-contracts.js';
import { inventorySummaryTool, inventoryMovementsTool, inventoryAdjustmentTool } from './inventory-tools.js';
import { readFile } from 'node:fs/promises';
import { ApiError, json, readBody } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { createOAuth, fail, OAuthError } from './oauth.js';
import { createProtocol } from './protocol.js';
import { audit, supportedScopes } from './credentials.js';
import { cleanupOAuth } from './cleanup.js';
import { parseJson } from './json.js';
import { createOperationApproval, createOperationReview, createMediaReviewDelivery } from './operation-approval.js';
import { initializeOperationStorage } from './operation-runtime.js';
import { createOperationTools } from './operation-tools.js';
import { maintainOperations } from './operation-maintenance.js';
import { companyReadTool, companyMutationTool } from './company-tools.js';
import { catalogCreateTool, catalogUpdateTool } from './catalog-tools.js';
import { analyticsSalesTrendTool, analyticsTopProductsTool, analyticsInventoryRiskTool } from './analytics-tools.js';
import { MEDIA_TOOLS_ACCEPTED, mediaTools } from './media-tools.js';
import { catalogMediaUpdateEnabled, catalogMediaCreateEnabled } from './catalog-media-config.js';
import { catalogMediaUpdateTool } from './catalog-media-adapter.js';
import { catalogMediaCreateTool } from './catalog-media-create-adapter.js';
import { createMediaRuntime } from './media-runtime.js';

export const connectorPath = (path) => /^\/(?:mcp$|oauth\/(?:register|authorize|token|revoke|consent\.js|consent\.css|operation|operation-review\.(?:js|css))$|\.well-known\/oauth-(?:protected-resource|authorization-server)(?:\/|$)|api\/v1\/seller\/mcp(?:\/|$))/.test(path);
const operationPath = (path) => path === '/oauth/operation' || /^\/oauth\/operation-review\.(?:js|css)$/.test(path) || /^\/api\/v1\/seller\/mcp\/(?:operations(?:\/|$)|approval(?:\/|$))/.test(path);
const reviewCsp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createConnector({ store, config, tenantId, tenantGuard, quickLogin, operationTools }) {
  const enabled = config.mcpEnabled === true && !quickLogin && Boolean(config.sellerOrigin) && new URL(config.sellerOrigin).protocol === 'https:';
  const limiters = new Map();
  const limit = async (bucket, key, count) => {
    if (!limiters.has(bucket)) limiters.set(bucket, new SqlLimiter(store, bucket, { limit: count, windowMs: 900000 }));
    if (!await limiters.get(bucket).attempt(key)) fail('temporarily_unavailable', 429, { 'Retry-After': '900' });
  };
  const oauth = createOAuth({ store, config, tenantId, limit });
  const safeV2 = enabled && mcpOperationRuntimeEnabled(config,{quickLogin,tenantGuard});
  const catalogUpdateEnabled = catalogMediaUpdateEnabled(config,{quickLogin,tenantGuard});
  const catalogCreateEnabled = catalogMediaCreateEnabled(config,{quickLogin,tenantGuard});
  if (config.mcpCatalogMediaCreate?.enabled === true && !catalogCreateEnabled) throw new TypeError('Safe catalog media CREATE configuration required.');
  if (config.mcpCatalogMediaUpdate?.enabled === true && !catalogUpdateEnabled) throw new TypeError('Safe catalog media UPDATE configuration required.');
  let registrations = operationTools;
  if (registrations === undefined) {
    if (!safeV2) registrations = [];
    else {
      const mediaOptions = {store,binding:oauth.binding,config,tenantGuard,quickLogin};
      const runtime = (MEDIA_TOOLS_ACCEPTED && config.mcpMedia?.enabled === true) || catalogUpdateEnabled || catalogCreateEnabled ? createMediaRuntime(mediaOptions) : null;
      registrations = [companyReadTool(),companyMutationTool(),catalogCreateEnabled ? catalogMediaCreateTool(runtime) : catalogCreateTool(),
        catalogUpdateEnabled ? catalogMediaUpdateTool(runtime) : catalogUpdateTool(),
        analyticsSalesTrendTool(),analyticsTopProductsTool(),analyticsInventoryRiskTool(),inventorySummaryTool(),inventoryMovementsTool(),inventoryAdjustmentTool(),orderDecisionTool(),...operationControlTools(),
        ...(MEDIA_TOOLS_ACCEPTED && config.mcpMedia?.enabled === true ? mediaTools(mediaOptions,runtime) : [])];
    }
  }
  const extensions = createOperationTools({ store, binding: oauth.binding, config, tenantGuard, quickLogin, entries: registrations });
  const maintain = async () => {
    if (!safeV2) return;
    try { await maintainOperations(store, { enabled: true, tenantGuard, tenantId }); }
    catch { /* Hygiene failure cannot change a decision already recorded. */ }
  };
  const protocol = createProtocol({ store, config, binding: oauth.binding, limit, operationTools: extensions, afterOperation: maintain });
  let operations;
  const operationHandlers = () => {
    if (!operations) {
      operations = (async () => {
        const options = { store, binding: { ...oauth.binding, mcpV2: config.mcpV2 }, sellerOrigin: config.sellerOrigin,
          quickLogin, ...config.mcpV2, tenantGuard, mcpMedia: config.mcpMedia, catalogUpdateEnabled, catalogCreateEnabled };
        const review = createOperationReview(options), approve = createOperationApproval(options), media = createMediaReviewDelivery(options);
        await tenantGuard.withActiveTenant(tenantId, () => initializeOperationStorage(store, { enabled: true }));
        return { review, approve, media };
      })().catch((error) => { operations = null; throw error; });
    }
    return operations;
  };
  async function handle(request, ip) {
    const url = new URL(request.url), path = url.pathname, operation = operationPath(path);
    if (operation && (!safeV2 || url.origin !== config.sellerOrigin)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (!config.mcpEnabled) return null;
    if (!connectorPath(path)) return null;
    if (!enabled || url.host !== new URL(config.sellerOrigin).host) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    const origin = request.headers.get('origin');
    const approved = origin === config.sellerOrigin || (config.mcpBrowserOrigins || []).includes(origin);
    let response;
    try {
      if (operation && origin !== null && origin !== config.sellerOrigin) fail('access_denied', 403);
      if (origin !== null) {
        let canonical = false;
        try { canonical = new URL(origin).origin === origin; } catch { /* Reject malformed Origin below. */ }
        if (!approved || !canonical || origin === 'null') fail('access_denied', 403);
      }
      if (request.url.length > 8192) fail('invalid_request', 414);
      if (operation) {
        const match = /^\/api\/v1\/seller\/mcp\/operations\/([0-9a-f-]+)(\/(?:approval|media\/(?:delivery|ack)))?$/.exec(path);
        const page = path === '/oauth/operation', asset = /^\/oauth\/operation-review\.(js|css)$/.exec(path);
        if (!page && !asset && (!match || !uuid.test(match[1]))) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
        const method = match?.[2] ? 'POST' : 'GET';
        if (request.method !== method) fail('invalid_request', 405, { Allow: method });
        if (page ? [...url.searchParams.keys()].length !== 1 || !uuid.test(url.searchParams.get('operationId') || '') : Boolean(url.search)) fail('invalid_request', 400);
        if (page || asset) {
          // This public shell carries no proposal or proof. Session cookies keep
          // the existing narrow authenticated API path.
          const extension = page ? 'html' : asset[1];
          response = new Response(await readFile(new URL(`./operation-review.${extension}`, import.meta.url)), {
            headers: { 'Content-Type': ({ html: 'text/html', js: 'text/javascript', css: 'text/css' })[extension] + '; charset=utf-8' },
          });
        } else {
          const handlers = await operationHandlers();
          if (match[2]) {
            if (origin !== config.sellerOrigin) fail('access_denied', 403);
            if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('invalid_request', 415);
            const bytes = await readBody(request, 4096, 5000);
            let input;
            try { input = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_request', 400); }
            if (input?.operationId !== match[1]) fail('invalid_request', 400);
            if (match[2] === '/media/delivery') response = await handlers.media.deliver(request, input);
            else if (match[2] === '/media/ack') response = json(200, await handlers.media.ack(request, input));
            else response = json(200, await handlers.approve(request, input, ip));
          } else response = json(200, await handlers.review(request, match[1]));
        }
      } else if (request.method === 'OPTIONS') {
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
        response = path.includes('protected-resource') ? json(200, { resource, authorization_servers: [issuer], scopes_supported: supportedScopes(config), bearer_methods_supported: ['header'] }) : json(200, { issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token', registration_endpoint: issuer + '/oauth/register', revocation_endpoint: issuer + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: supportedScopes(config), authorization_response_iss_parameter_supported: true });
      } else {
        const handlers = { '/oauth/register': ['POST', oauth.register], '/oauth/authorize': ['GET', oauth.authorize], '/oauth/token': ['POST', oauth.token], '/oauth/revoke': ['POST', oauth.revoke], '/mcp': ['POST', protocol], '/api/v1/seller/mcp/consent': ['POST', oauth.consent] };
        const handler = handlers[path];
        if (!handler) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
        if (request.method !== handler[0]) fail('invalid_request', 405, { Allow: handler[0] });
        response = await handler[1](request, ip);
        if (path === '/mcp') {
          try { await cleanupOAuth(store); }
          catch { /* Cleanup failure cannot misreport an already committed operation. */ }
        } else await cleanupOAuth(store);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw e;
      if (operation && [400, 401, 403].includes(e.status)) {
        try {
          await tenantGuard.withActiveTenant(tenantId, async () => {
            await limit('mcp-v2-deny-audit', 'global', 120);
            await store.transaction(() => audit(store, tenantId, 'DENY', {}, 'operation_review_denied'));
          });
        } catch { /* Lifecycle denial or unavailable audit must remain a denial. */ }
      } else if (e instanceof OAuthError && [400, 401, 403].includes(e.status)) {
        try {
          await limit('mcp-deny-audit', ip, 120);
          await store.transaction(() => audit(store, tenantId, 'DENY', {}, e.error));
        } catch { /* Denial never releases data; an unavailable audit cannot turn it into success. */ }
      }
      response = json(e instanceof OAuthError ? e.status : e instanceof ApiError ? e.status : 503, { error: e instanceof OAuthError ? e.error : 'temporarily_unavailable' }, e.headers || {});
    }
    if (operation && response.ok && path.startsWith('/api/')) await maintain();
    response.headers.set('Referrer-Policy', 'no-referrer'); response.headers.set('X-Content-Type-Options', 'nosniff'); response.headers.set('Cache-Control', 'no-store');
    if (operation) { response.headers.set('Content-Security-Policy', reviewCsp); response.headers.set('X-Frame-Options', 'DENY'); response.headers.set('X-Robots-Tag', 'noindex'); }
    if (!operation && origin && approved) { response.headers.set('Access-Control-Allow-Origin', origin); response.headers.set('Vary', 'Origin'); response.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version'); }
    return response;
  }
  return { handle, initialize: async () => {
    if (safeV2) await operationHandlers();
  }, bindLogin: async (...args) => {
    if (!enabled) return;
    try { await oauth.bindLogin(...args); }
    catch (e) { if (e instanceof OAuthError) throw new ApiError(e.status, 'FORBIDDEN', 'Authorization proof is invalid.'); throw e; }
  } };
}
