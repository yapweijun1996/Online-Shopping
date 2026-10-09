import { createDemoSandbox } from './demo-sandbox.js';
import { getShopSetup, resetDemo, setupShop, shopObjectName } from './shop-setup.js';
import { authenticate, cookieFor, createSession, deleteSession, readSession, sampleAccount, sessionCookieFrom } from './auth.js';
import { changeOwnPassword, createAccount, listAccounts, updateAccount } from './accounts.js';
import { can, capabilitiesOf } from './roles.js';
import { ready } from './db.js';
import { ApiError, errorResponse, json, readBody, readJson, requireOrigin } from './http.js';
import { SqlLimiter } from './limiter.js';
import { createOrder, lookupOrderStatuses } from './orders.js';
import { addGalleryImage, createProduct, deleteGalleryImage, getGalleryImage, getProduct, getProductImage, listProducts, setGalleryThumbnail, setProductThumbnail, updateProduct } from './products.js';
import { decideSellerOrder, getSellerOrder, listSellerOrders, pendingOrderSummary, withProductLinks } from './seller-orders.js';
import { listAuditEvents } from './audit-log.js';
import { eraseOrderContact } from './erase-contact.js';
import { dashboardFigures } from './dashboard-figures.js';
import { addOrderNote } from './order-notes.js';
import { exportProductsCsv } from './product-export.js';
import { IMPORT_MAX_CHARS, importProducts, planImport, presentPlan } from './product-import.js';
import { bulkSetActive, listProductHistory, trackCreate, trackUpdate } from './product-history.js';
import { exportOrdersCsv } from './order-export.js';
import { OPTION_LIMITS } from './option-limits.js';
import { createOptionType, createOptionValue, listOptionTypes, updateOptionType, updateOptionValue } from './options.js';
import { createCategory, publicBusinessContact, getCompanySettings, storefrontTexts, listCategories, updateCategory, updateCompanySettings } from './settings.js';
import { FieldError } from './validation.js';
import { presentCatalogCopy, presentShopName } from './catalog-copy.js';
import { PRODUCT_MUTATION_BODY_LIMIT } from './request-limits.js';
import { isCrawler, previewPage, priceText, summary } from './share.js';
import { createSecretBox } from './secret-box.js';
import { singleTenantRegistry } from './tenants.js';
import { listAttentionMessages, listReplies, markReplyRead, messageSummary, orderMessages, resolveMessage } from './whatsapp-messages.js';
import { createWhatsAppTransport } from './whatsapp-transport.js';
import { disconnectWhatsAppConnection, listWhatsAppConnections, saveWhatsAppConnection } from './integration-connections.js';
import { MAX_WEBHOOK_BYTES, answerWhatsAppHandshake, receiveWhatsAppWebhook } from './whatsapp-inbound.js';
import { integrationCatalog } from '../public/shared/integration-catalog.js';

const productIdPath = /^\/api\/v1\/products\/([0-9a-f-]{36})(?:\/(image))?$/;
const sellerProductIdPath = /^\/api\/v1\/seller\/products\/([0-9a-f-]{36})(?:\/(image))?$/;
const thumbnailPath = /^\/api\/v1\/seller\/products\/([0-9a-f-]{36})(?:\/gallery\/([0-9a-f-]{36}))?\/thumbnail$/;
const optionTypePath = /^\/api\/v1\/seller\/option-types(?:\/([0-9a-f-]{36})(?:(\/values)(?:\/([0-9a-f-]{36}))?)?)?$/;
const productGalleryPath = /^\/api\/v1\/(seller\/)?products\/([0-9a-f-]{36})\/gallery\/([0-9a-f-]{36})$/;
const sellerOrderIdPath = /^\/api\/v1\/seller\/orders\/([0-9a-f-]{36})(?:\/(confirm|reject|ship|deliver|cancel|erase-contact|notes))?$/;
const whatsappConnectionPath = /^\/api\/v1\/seller\/integrations\/whatsapp(?:\/(SANDBOX|PRODUCTION))?$/;
const messagePath = /^\/api\/v1\/seller\/messages\/(summary|replies|outbox)(?:\/([0-9a-f-]{36})\/(read|resolve))?$/;
const orderMessagesPath = /^\/api\/v1\/seller\/orders\/([0-9a-f-]{36})\/messages$/;
const LIMIT_WINDOW_MS = 15 * 60 * 1000;

function image(value, cacheable = false) {
  if (!value?.mime || !value?.data) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  return new Response(value.data, {
    headers: {
      'Content-Type': value.mime,
      'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function requireCsrf(request, session) {
  if (request.headers.get('x-csrf-token') !== session.csrf_token) throw new ApiError(403, 'FORBIDDEN', 'CSRF token is required.');
}

/*
 * Runtime-neutral API. Takes a Fetch API Request and returns a Response, so the Node
 * server and the test harness share one set of routes. The runtime supplies
 * the client address it trusts and, optionally, a handler for non-API paths.
 */
/* Routes for one tenant (one shop, one store). Built once per tenant by createApi. */
async function createTenantApi({ store, config, serveStatic = null, whatsappTransport = createWhatsAppTransport() }) {
  const demoEnabled = config.shopMode === 'public-demo' && (await getShopSetup(store)).mode === 'demo';
  // Explicit opt-in: passwordless seller sign-in for a sample site. Never enable it for a real tenant.
  const quickLogin = demoEnabled || config.sellerQuickLogin === true;
  const sessionView = (account, csrfToken) => ({ username: account.username, role: account.role, quickLogin, mustChangePassword: account.mustChangePassword && !quickLogin,
    capabilities: capabilitiesOf(account.role), csrfToken });
  const demoRoute = createDemoSandbox({ enabled: demoEnabled, production: config.production });
  const loginLimiter = new SqlLimiter(store, 'login', { limit: 5, windowMs: LIMIT_WINDOW_MS });
  const checkoutLimiter = new SqlLimiter(store, 'checkout', { limit: 30, windowMs: LIMIT_WINDOW_MS });
  const passwordLimiter = new SqlLimiter(store, 'password', { limit: 10, windowMs: LIMIT_WINDOW_MS });
  const demoLoginLimiter = new SqlLimiter(store, 'demo-login', { limit: 30, windowMs: LIMIT_WINDOW_MS });
  const orderStatusLimiter = new SqlLimiter(store, 'order-status', { limit: 30, windowMs: LIMIT_WINDOW_MS });
  const webhookLimiter = new SqlLimiter(store, 'whatsapp-webhook', { limit: 600, windowMs: LIMIT_WINDOW_MS });
  const connectionLimiter = new SqlLimiter(store, 'integration-connect', { limit: 10, windowMs: LIMIT_WINDOW_MS });
  const secretBox = config.integrationKeys ? createSecretBox(config.integrationKeys) : null;

  async function route(request, clientAddress) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    const expectedOrigin = pathname.startsWith('/api/v1/seller/')
      ? config.sellerOrigin || config.publicOrigin || url.origin
      : config.publicOrigin || url.origin;
    const demoResponse = await demoRoute(request, expectedOrigin, clientAddress);
    if (demoResponse) return demoResponse;
    if (method === 'GET' && pathname === '/health') return json(200, { status: 'alive', ...(config.appRevision ? { revision: config.appRevision } : {}) });
    if (method === 'GET' && pathname === '/ready') {
      const healthy = await ready(store);
      return json(healthy ? 200 : 503, { status: healthy ? 'ready' : 'unavailable', ...(config.appRevision ? { revision: config.appRevision } : {}) });
    }
    // WhatsApp Cloud webhook: called by Meta, so no session, origin or CSRF check; the signature over the raw body is the
    // authentication (docs/threat-model.md). Unsigned requests store nothing.
    if (pathname === '/api/v1/webhooks/whatsapp' && (method === 'GET' || method === 'POST')) {
      if (!await webhookLimiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests.');
      if (method === 'GET') {
        const challenge = await answerWhatsAppHandshake(store, url.searchParams);
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      const rawBody = await readBody(request, MAX_WEBHOOK_BYTES);
      await receiveWhatsAppWebhook(store, secretBox, { rawBody, signature: request.headers.get('x-hub-signature-256') });
      return json(200, { received: true });
    }
    // Link previews for Facebook, WhatsApp and similar apps (see share.js).
    const sharePath = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(pathname);
    if (method === 'GET' && (sharePath || pathname === '/s/home')) {
      const origin = config.publicOrigin || url.origin;
      const setup = presentShopName(await getShopSetup(store));
      const crawler = isCrawler(request.headers.get('user-agent'));
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' };
      if (!sharePath) {
        const page = previewPage({ title: setup.shopName, description: `${setup.shopName} — browse products and order online.`,
          image: `${origin}/shop/share.png`, imageAlt: setup.shopName, url: `${origin}/shop/`, siteName: setup.shopName, enter: '/shop/' });
        return new Response(page, { status: 200, headers });
      }
      const id = sharePath[1].toLowerCase();
      const product = await getProduct(store, id, false, config.shopMode);
      if (!product) return new Response('Product not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      const enter = `/shop/#product/${id}`;
      if (!crawler) return new Response(null, { status: 302, headers: { Location: enter, 'Cache-Control': 'no-store' } });
      const picture = product.imageMedia?.[0]?.src || product.images?.[0] || product.imageUrl;
      const page = previewPage({
        title: product.name, description: summary(`${priceText(product.priceMinor, product.currency)} · ${product.description}`),
        image: picture ? new URL(picture, origin).href : undefined, imageAlt: product.name, url: `${origin}/p/${id}`,
        siteName: setup.shopName, type: 'product', price: { amount: (product.priceMinor / 100).toFixed(2), currency: product.currency }, enter,
      });
      return new Response(page, { status: 200, headers });
    }
    if (!pathname.startsWith('/api/')) {
      let decoded;
      try { decoded = decodeURIComponent(pathname).replace(/\/{2,}/g, '/'); } catch { throw new ApiError(404, 'NOT_FOUND', 'Not found.'); }
      if (/^\/demo(?:\/|$)/.test(decoded) && !demoEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      if (serveStatic) return serveStatic(request, pathname);
      throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    }
    if (method === 'GET' && pathname === '/api/v1/shop') {
      const setup = await getShopSetup(store);
      const company = await getCompanySettings(store);
      return json(200, {
        ...presentShopName(setup),
        ...(config.shopMode === 'public-demo' ? { demoNamespace: shopObjectName(config.shopMode, config.demoRevision) } : {}),
        currency: company.defaultCurrency,
        demoRolesAvailable: quickLogin,
        // This setting is explicitly the public shop contact, never an account or buyer phone.
        sellerWhatsAppPhone: setup.mode && config.shopMode !== 'public-demo' ? publicBusinessContact(company) : null,
        mobileHideBarsOnScroll: company.mobileHideBarsOnScroll,
        storefrontTexts: storefrontTexts(company),
      });
    }
    if (method === 'GET' && pathname === '/api/v1/products') return json(200, await listProducts(store, url.searchParams, false, config.shopMode));
    const galleryImage = productGalleryPath.exec(pathname);
    if (method === 'GET' && galleryImage && !galleryImage[1]) {
      const value = await getGalleryImage(store, galleryImage[2], galleryImage[3], false, url.searchParams.get('size') === 'thumb');
      return image(value, Boolean(value) && url.searchParams.get('v') === value.version);
    }
    const publicProduct = productIdPath.exec(pathname);
    if (method === 'GET' && publicProduct) {
      if (publicProduct[2] === 'image') {
        const value = await getProductImage(store, publicProduct[1], false, url.searchParams.get('size') === 'thumb');
        return image(value, Boolean(value) && url.searchParams.get('v') === value.version);
      }
      const product = await getProduct(store, publicProduct[1], false, config.shopMode);
      if (!product) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, presentCatalogCopy(product, config.shopMode));
    }
    if (method === 'POST' && pathname === '/api/v1/orders') {
      requireOrigin(request, expectedOrigin);
      if (!await checkoutLimiter.attempt(clientAddress)) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many submissions. Try again later.');
      }
      const body = await readJson(request, 128 * 1024);
      const result = await createOrder(store, request.headers.get('idempotency-key'), body);
      return json(result.replayed ? 200 : 201, result.receipt);
    }
    if (method === 'POST' && pathname === '/api/v1/orders/statuses') {
      requireOrigin(request, expectedOrigin);
      if (!await orderStatusLimiter.attempt(clientAddress)) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many status checks. Try again later.');
      }
      return json(200, await lookupOrderStatuses(store, await readJson(request, 12 * 1024)));
    }
    if (!pathname.startsWith('/api/v1/seller/')) throw new ApiError(404, 'NOT_FOUND', 'Not found.');

    if (method === 'POST' && pathname === '/api/v1/seller/session') {
      requireOrigin(request, expectedOrigin);
      if (!await loginLimiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try later.');
      const body = await readJson(request);
      const account = typeof body.username === 'string' && typeof body.password === 'string' && body.username.length <= 64 && body.password.length <= 256
        ? await authenticate(store, body.username, body.password) : null;
      if (!account) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials.');
      await loginLimiter.clear(clientAddress);
      const session = await createSession(store, account.id);
      return json(200, sessionView(account, session.csrfToken), {
        'Set-Cookie': cookieFor(session.token, session.maxAge, config.production),
      });
    }

    // Sample sites only: opens the normal seller session without a password.
    if (method === 'POST' && pathname === '/api/v1/seller/demo-session') {
      if (!quickLogin) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      requireOrigin(request, expectedOrigin);
      if (!await demoLoginLimiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try later.');
      const account = await sampleAccount(store);
      if (!account) throw new ApiError(503, 'UNAVAILABLE', 'No account is available.');
      const session = await createSession(store, account.id);
      return json(200, sessionView(account, session.csrfToken), {
        'Set-Cookie': cookieFor(session.token, session.maxAge, config.production),
      });
    }

    const token = sessionCookieFrom(request.headers.get('cookie') ?? '');
    const session = await readSession(store, token);
    if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in required.');
    const account = session.account;
    const allow = (capability) => { if (!can(account.role, capability)) throw new ApiError(403, 'FORBIDDEN', 'Your role cannot do this.'); };
    if (method === 'GET' && pathname === '/api/v1/seller/session') return json(200, sessionView(account, session.csrf_token));
    if (method === 'DELETE' && pathname === '/api/v1/seller/session') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      await deleteSession(store, token);
      return json(200, { signedOut: true }, { 'Set-Cookie': cookieFor('', 0, config.production) });
    }
    // A temporary password (new account or reset) must be replaced before anything else works.
    // (On a quick sign-in site passwords cannot be changed, so the flag is ignored there rather than locking everyone out.)
    if (account.mustChangePassword && !quickLogin && pathname !== '/api/v1/seller/account/password') {
      throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first.');
    }
    if (method === 'POST' && pathname === '/api/v1/seller/account/password') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      // A passwordless sample site signs everyone in as the Owner, so it must never change the Owner's password.
      if (quickLogin) throw new ApiError(403, 'FORBIDDEN', 'Passwords cannot be changed on a sample site.');
      if (!await passwordLimiter.attempt(account.id)) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try later.');
      return json(200, await changeOwnPassword(store, account.id, await readJson(request, 2048), token));
    }
    const accountRoute = /^\/api\/v1\/seller\/accounts(?:\/([0-9a-f-]{36}))?$/.exec(pathname);
    if (accountRoute) {
      allow('staff.manage');
      if (quickLogin) throw new ApiError(403, 'FORBIDDEN', 'Accounts are not available on a sample site.');
      if (method === 'GET' && !accountRoute[1]) return json(200, await listAccounts(store));
      if ((method === 'POST' && !accountRoute[1]) || (method === 'PATCH' && accountRoute[1])) {
        requireOrigin(request, expectedOrigin);
        requireCsrf(request, session);
        const body = await readJson(request, 4096);
        if (method === 'POST') return json(201, await createAccount(store, body, account.username));
        return json(200, await updateAccount(store, accountRoute[1], body, account.username, account.id));
      }
    }
    if (method === 'GET' && pathname === '/api/v1/seller/setup') return json(200, presentShopName(await getShopSetup(store)));
    if (method === 'GET' && pathname === '/api/v1/seller/integrations') return json(200, integrationCatalog());
    // Provider connections hold the seller's own WhatsApp credentials. A passwordless (sample) site must never accept or
    // show them, so every route answers "unavailable" while quick sign-in is on. Secrets are write-only: nothing returns them.
    const connectionRoute = whatsappConnectionPath.exec(pathname);
    if (connectionRoute) {
      const environment = connectionRoute[1];
      if (method === 'GET' && !environment) {
        if (quickLogin || !secretBox) return json(200, { available: false, connections: [] });
        // Every role may learn that WhatsApp is on (it decides whether Messages shows); only the Owner sees the connection.
        if (!can(account.role, 'settings.write')) return json(200, { available: true, connections: [] });
        return json(200, { available: true, webhookUrl: `${config.publicOrigin || url.origin}/api/v1/webhooks/whatsapp`, connections: await listWhatsAppConnections(store) });
      }
      if ((method === 'PUT' || method === 'DELETE') && environment) {
        requireOrigin(request, expectedOrigin);
        requireCsrf(request, session);
        allow('settings.write');
        if (quickLogin) throw new ApiError(403, 'FORBIDDEN', 'Connections are not available on a sample site.');
        if (!secretBox) throw new ApiError(503, 'INTEGRATIONS_UNAVAILABLE', 'Integrations are not configured.');
        const actor = `seller:${account.username}`;
        if (method === 'DELETE') return json(200, await disconnectWhatsAppConnection(store, environment, actor));
        if (!await connectionLimiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many connection attempts. Try again later.');
        const body = await readJson(request, 8 * 1024);
        if (body.environment !== undefined && body.environment !== environment) throw new FieldError('environment', 'The environment comes from the URL.');
        return json(200, await saveWhatsAppConnection(store, secretBox, whatsappTransport, { ...body, environment }, actor));
      }
    }
    // Replies and message problems. Empty while quick sign-in is on, so a passwordless visitor never sees buyer text.
    const messageRoute = messagePath.exec(pathname), orderMessageRoute = orderMessagesPath.exec(pathname);
    if (messageRoute || orderMessageRoute) {
      const [, collection, id, action] = messageRoute ?? [];
      if (method === 'GET' && messageRoute && !id) {
        if (quickLogin) return json(200, collection === 'summary' ? { unreadReplies: 0, reconcile: 0, failed: 0 } : { items: [], nextOffset: null });
        if (collection === 'summary') return json(200, await messageSummary(store));
        return json(200, collection === 'replies' ? await listReplies(store, url.searchParams) : await listAttentionMessages(store, url.searchParams));
      }
      if (method === 'GET' && orderMessageRoute) {
        if (quickLogin) return json(200, { replies: [], messages: [] });
        if (!await getSellerOrder(store, orderMessageRoute[1])) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
        return json(200, await orderMessages(store, orderMessageRoute[1]));
      }
      if (method === 'POST' && messageRoute && id && ((collection === 'replies' && action === 'read') || (collection === 'outbox' && action === 'resolve'))) {
        requireOrigin(request, expectedOrigin);
        requireCsrf(request, session);
        if (action === 'resolve') allow('messages.act');
        if (quickLogin) throw new ApiError(403, 'FORBIDDEN', 'Messages are not available on a sample site.');
        return json(200, action === 'read' ? await markReplyRead(store, id) : await resolveMessage(store, id, await readJson(request, 1024)));
      }
    }
    if (method === 'POST' && pathname === '/api/v1/seller/setup') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('settings.write');
      return json(200, await setupShop(store, await readJson(request)));
    }
    if (method === 'POST' && pathname === '/api/v1/seller/demo/reset') {
      if (!demoEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('settings.write');
      const body = await readJson(request, 1024);
      if (Object.keys(body).length !== 1 || body.confirm !== true) throw new FieldError('confirm', 'Confirm the reset.');
      return json(200, await resetDemo(store));
    }
    if (method === 'GET' && pathname === '/api/v1/seller/products') {
      return json(200, await listProducts(store, url.searchParams, true, config.shopMode));
    }
    if (method === 'GET' && pathname === '/api/v1/seller/categories') {
      return json(200, { items: await listCategories(store) });
    }
    if (method === 'GET' && pathname === '/api/v1/seller/company-settings') {
      return json(200, await getCompanySettings(store));
    }
    if ((method === 'POST' && pathname === '/api/v1/seller/categories') ||
        (method === 'PATCH' && pathname.startsWith('/api/v1/seller/categories/')) ||
        (method === 'PATCH' && pathname === '/api/v1/seller/company-settings')) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow(pathname === '/api/v1/seller/company-settings' ? 'settings.write' : 'catalog.write');
      const body = await readJson(request);
      if (pathname === '/api/v1/seller/company-settings') return json(200, await updateCompanySettings(store, body));
      if (method === 'POST') return json(201, await createCategory(store, body));
      let code;
      try { code = decodeURIComponent(pathname.slice('/api/v1/seller/categories/'.length)); }
      catch { throw new ApiError(404, 'NOT_FOUND', 'Category not found.'); }
      if (!code || code.includes('/')) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
      return json(200, await updateCategory(store, code, body));
    }
    const optionRoute = optionTypePath.exec(pathname);
    if (optionRoute) {
      const [, typeId, valuesPart, valueId] = optionRoute;
      if (method === 'GET' && !typeId) return json(200, { items: await listOptionTypes(store), limits: OPTION_LIMITS });
      if (['POST', 'PATCH'].includes(method)) {
        requireOrigin(request, expectedOrigin);
        requireCsrf(request, session);
        allow('catalog.write');
        const body = await readJson(request);
        if (method === 'POST' && !typeId) return json(201, await createOptionType(store, body));
        if (method === 'PATCH' && typeId && !valuesPart) return json(200, await updateOptionType(store, typeId, body));
        if (method === 'POST' && typeId && valuesPart && !valueId) return json(201, await createOptionValue(store, typeId, body));
        if (method === 'PATCH' && typeId && valuesPart && valueId) return json(200, await updateOptionValue(store, typeId, valueId, body));
      }
    }
    if (method === 'GET' && pathname === '/api/v1/seller/orders/summary') return json(200, await pendingOrderSummary(store));
    if (method === 'GET' && pathname === '/api/v1/seller/dashboard') { allow('figures.read'); return json(200, await dashboardFigures(store)); }
    if (method === 'GET' && pathname === '/api/v1/seller/orders/export.csv') {
      allow('data.export');
      // The file holds buyer names, numbers and emails, so a passwordless sample site must not offer it.
      if (quickLogin) throw new ApiError(403, 'FORBIDDEN', 'Export is not available on a sample site.');
      const csv = await exportOrdersCsv(store, url.searchParams);
      return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"` } });
    }
    if (method === 'GET' && pathname === '/api/v1/seller/orders') {
      return json(200, await listSellerOrders(store, url.searchParams));
    }
    if (method === 'GET' && pathname === '/api/v1/seller/audit-log') return json(200, await listAuditEvents(store, url.searchParams));
    const sellerOrder = sellerOrderIdPath.exec(pathname);
    if (method === 'GET' && sellerOrder && !sellerOrder[2]) {
      const order = await getSellerOrder(store, sellerOrder[1]);
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, withProductLinks(order, config.publicOrigin || url.origin));
    }
    if (method === 'POST' && sellerOrder?.[2]) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow({ 'erase-contact': 'data.erase', ship: 'orders.fulfil', deliver: 'orders.fulfil', notes: 'orders.fulfil' }[sellerOrder[2]] ?? 'orders.decide');
      const body = await readJson(request, sellerOrder[2] === 'notes' ? 4096 : undefined);
      if (sellerOrder[2] === 'notes') return json(201, await addOrderNote(store, sellerOrder[1], body, account.username));
      if (sellerOrder[2] === 'erase-contact') {
        // A passwordless sample site is open to anyone, so it must never be able to erase data permanently.
        if (quickLogin) throw new ApiError(403, 'FORBIDDEN', 'Erasing contact data is not available on a sample site.');
        await eraseOrderContact(store, sellerOrder[1], body, account.username);
        return json(200, withProductLinks(await getSellerOrder(store, sellerOrder[1]), config.publicOrigin || url.origin));
      }
      return json(200, withProductLinks(await decideSellerOrder(store, sellerOrder[1], sellerOrder[2], body, account.username), config.publicOrigin || url.origin));
    }
    if (method === 'GET' && pathname === '/api/v1/seller/products/export.csv') {
      allow('catalog.write');
      const csv = await exportProductsCsv(store, url.searchParams);
      return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"` } });
    }
    if (method === 'POST' && pathname === '/api/v1/seller/products/import') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('catalog.write');
      const body = await readJson(request, IMPORT_MAX_CHARS * 2 + 1024);
      if (Object.keys(body).some((key) => !['csv', 'commit'].includes(key)) || typeof body.commit !== 'boolean') throw new FieldError('import', 'Send csv and commit.');
      if (!body.commit) return json(200, presentPlan(await planImport(store, body.csv)));
      try { return json(200, presentPlan(await importProducts(store, body.csv, account.username, config.shopMode))); }
      catch (error) { if (error.plan) return json(409, { error: { code: error.code, message: error.message }, ...presentPlan(error.plan) }); throw error; }
    }
    const productHistory = /^\/api\/v1\/seller\/products\/([0-9a-f-]{36})\/history$/.exec(pathname);
    if (method === 'GET' && productHistory) {
      allow('catalog.write');
      if (!await getProduct(store, productHistory[1], true, config.shopMode)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, await listProductHistory(store, productHistory[1], url.searchParams));
    }
    if (method === 'POST' && pathname === '/api/v1/seller/products/bulk') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('catalog.write');
      const body = await readJson(request, 8192);
      if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !['ids', 'action'].includes(key)) || !['activate', 'deactivate'].includes(body.action)) {
        throw new FieldError('action', 'Choose activate or deactivate, and the products.');
      }
      return json(200, await bulkSetActive(store, body.ids, body.action === 'activate', account.username, (id, patch) => updateProduct(store, id, patch, config.shopMode)));
    }
    const sellerProduct = sellerProductIdPath.exec(pathname);
    if (method === 'GET' && sellerProduct && !sellerProduct[2]) {
      const product = await getProduct(store, sellerProduct[1], true, config.shopMode);
      if (!product) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, presentCatalogCopy(product, config.shopMode));
    }
    if (method === 'GET' && sellerProduct?.[2] === 'image') {
      return image(await getProductImage(store, sellerProduct[1], true, url.searchParams.get('size') === 'thumb'));
    }
    if (galleryImage?.[1]) {
      if (method === 'GET') return image(await getGalleryImage(store, galleryImage[2], galleryImage[3], true, url.searchParams.get('size') === 'thumb'));
      if (method === 'DELETE') {
        requireOrigin(request, expectedOrigin);
        requireCsrf(request, session);
        allow('catalog.write');
        return json(200, await deleteGalleryImage(store, galleryImage[2], galleryImage[3], config.shopMode));
      }
    }
    if (method === 'POST' && /^\/api\/v1\/seller\/products\/[0-9a-f-]{36}\/gallery$/.test(pathname)) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('catalog.write');
      const id = pathname.split('/')[5];
      const body = await readJson(request, 900_000);
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      if (!Object.hasOwn(body || {}, 'imageDataUrl') || keys.some((key) => key !== 'imageDataUrl' && key !== 'thumbDataUrl')) {
        throw new FieldError('imageDataUrl', 'Choose an image.');
      }
      return json(201, await addGalleryImage(store, id, body.imageDataUrl, config.shopMode, body.thumbDataUrl ?? null));
    }
    const thumbnail = thumbnailPath.exec(pathname);
    if (method === 'PUT' && thumbnail) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('catalog.write');
      const body = await readJson(request, 200_000);
      if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'thumbDataUrl')) throw new FieldError('thumbDataUrl', 'Send a preview image.');
      return json(200, thumbnail[2] ? await setGalleryThumbnail(store, thumbnail[1], thumbnail[2], body.thumbDataUrl) : await setProductThumbnail(store, thumbnail[1], body.thumbDataUrl));
    }
    if ((method === 'POST' && pathname === '/api/v1/seller/products') ||
        (method === 'PATCH' && sellerProduct && !sellerProduct[2])) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      allow('catalog.write');
      const body = await readJson(request, PRODUCT_MUTATION_BODY_LIMIT);
      if (method === 'POST') {
        const product = await trackCreate(store, account.username, () => createProduct(store, body));
        return json(201, product, { Location: `/api/v1/seller/products/${product.id}` });
      }
      const product = await trackUpdate(store, sellerProduct[1], account.username, () => updateProduct(store, sellerProduct[1], body, config.shopMode));
      if (!product) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, presentCatalogCopy(product, config.shopMode));
    }
    throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  }

  return async function handle(request, { clientAddress = 'unknown' } = {}) {
    try {
      return await route(request, clientAddress);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/*
 * The public API. Takes either one store and config (today's single shop) or a tenant registry. Each request is
 * resolved to a tenant first; an unknown tenant is 404 and a suspended one 503 without touching any database.
 * Every tenant gets its own route table (limiters, secret box, quick sign-in decision), built on first use.
 */
export async function createApi({ store, config, registry = null, serveStatic = null, whatsappTransport = createWhatsAppTransport() }) {
  const tenants = registry ?? singleTenantRegistry({ store, config });
  const handlers = new Map();
  const handlerFor = (tenant) => {
    if (!handlers.has(tenant.id)) {
      handlers.set(tenant.id, createTenantApi({ store: tenant.store, config: tenant.config, serveStatic, whatsappTransport })
        .catch((error) => { handlers.delete(tenant.id); throw error; }));
    }
    return handlers.get(tenant.id);
  };
  return async function handle(request, context = {}) {
    try {
      const tenant = await tenants.resolve(request);
      if (!tenant) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      if (tenant.status !== 'ACTIVE') throw new ApiError(503, 'SHOP_UNAVAILABLE', 'This shop is not available right now.');
      return await (await handlerFor(tenant))(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
