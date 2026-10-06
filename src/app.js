import { createDemoSandbox } from './demo-sandbox.js';
import { getShopSetup, resetDemo, setupShop, shopObjectName } from './shop-setup.js';
import { authenticate, cookieFor, createSession, deleteSession, readSession, sessionCookieFrom } from './auth.js';
import { ready } from './db.js';
import { ApiError, errorResponse, json, readJson, requireOrigin } from './http.js';
import { SqlLimiter } from './limiter.js';
import { createOrder, lookupOrderStatuses } from './orders.js';
import { addGalleryImage, createProduct, deleteGalleryImage, getGalleryImage, getProduct, getProductImage, listProducts, updateProduct } from './products.js';
import { decideSellerOrder, getSellerOrder, listSellerOrders, pendingOrderSummary } from './seller-orders.js';
import { createCategory, publicBusinessContact, getCompanySettings, storefrontTexts, listCategories, updateCategory, updateCompanySettings } from './settings.js';
import { FieldError } from './validation.js';
import { presentCatalogCopy, presentShopName } from './catalog-copy.js';
import { PRODUCT_MUTATION_BODY_LIMIT } from './request-limits.js';
import { integrationCatalog } from '../public/shared/integration-catalog.js';

const productIdPath = /^\/api\/v1\/products\/([0-9a-f-]{36})(?:\/(image))?$/;
const sellerProductIdPath = /^\/api\/v1\/seller\/products\/([0-9a-f-]{36})(?:\/(image))?$/;
const productGalleryPath = /^\/api\/v1\/(seller\/)?products\/([0-9a-f-]{36})\/gallery\/([0-9a-f-]{36})$/;
const sellerOrderIdPath = /^\/api\/v1\/seller\/orders\/([0-9a-f-]{36})(?:\/(confirm|reject|ship|deliver|cancel))?$/;
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
export async function createApi({ store, config, serveStatic = null }) {
  const demoEnabled = config.shopMode === 'public-demo' && (await getShopSetup(store)).mode === 'demo';
  const demoRoute = createDemoSandbox({ enabled: demoEnabled, production: config.production });
  const loginLimiter = new SqlLimiter(store, 'login', { limit: 5, windowMs: LIMIT_WINDOW_MS });
  const checkoutLimiter = new SqlLimiter(store, 'checkout', { limit: 30, windowMs: LIMIT_WINDOW_MS });
  const demoLoginLimiter = new SqlLimiter(store, 'demo-login', { limit: 30, windowMs: LIMIT_WINDOW_MS });
  const orderStatusLimiter = new SqlLimiter(store, 'order-status', { limit: 30, windowMs: LIMIT_WINDOW_MS });

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
        demoRolesAvailable: demoEnabled,
        // This setting is explicitly the public shop contact, never an account or buyer phone.
        sellerWhatsAppPhone: setup.mode && config.shopMode !== 'public-demo' ? publicBusinessContact(company) : null,
        mobileHideBarsOnScroll: company.mobileHideBarsOnScroll,
        storefrontTexts: storefrontTexts(company),
      });
    }
    if (method === 'GET' && pathname === '/api/v1/products') return json(200, await listProducts(store, url.searchParams, false, config.shopMode));
    const galleryImage = productGalleryPath.exec(pathname);
    if (method === 'GET' && galleryImage && !galleryImage[1]) {
      const value = await getGalleryImage(store, galleryImage[2], galleryImage[3]);
      return image(value, Boolean(value) && url.searchParams.get('v') === value.version);
    }
    const publicProduct = productIdPath.exec(pathname);
    if (method === 'GET' && publicProduct) {
      if (publicProduct[2] === 'image') {
        const value = await getProductImage(store, publicProduct[1]);
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
      if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
          body.username.length > 64 || body.password.length > 256 || !await authenticate(store, body.username, body.password)) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials.');
      }
      await loginLimiter.clear(clientAddress);
      const session = await createSession(store);
      return json(200, { username: config.username, role: 'SUPER_ADMIN', csrfToken: session.csrfToken }, {
        'Set-Cookie': cookieFor(session.token, session.maxAge, config.production),
      });
    }

    // Public fictional demo only: opens the normal seller session without a password.
    if (method === 'POST' && pathname === '/api/v1/seller/demo-session') {
      if (!demoEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      requireOrigin(request, expectedOrigin);
      if (!await demoLoginLimiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try later.');
      const session = await createSession(store);
      return json(200, { username: config.username, role: 'SUPER_ADMIN', csrfToken: session.csrfToken }, {
        'Set-Cookie': cookieFor(session.token, session.maxAge, config.production),
      });
    }

    const token = sessionCookieFrom(request.headers.get('cookie') ?? '');
    const session = await readSession(store, token);
    if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in required.');
    if (method === 'GET' && pathname === '/api/v1/seller/session') {
      return json(200, { username: config.username, role: 'SUPER_ADMIN', csrfToken: session.csrf_token });
    }
    if (method === 'DELETE' && pathname === '/api/v1/seller/session') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      await deleteSession(store, token);
      return json(200, { signedOut: true }, { 'Set-Cookie': cookieFor('', 0, config.production) });
    }
    if (method === 'GET' && pathname === '/api/v1/seller/setup') return json(200, presentShopName(await getShopSetup(store)));
    if (method === 'GET' && pathname === '/api/v1/seller/integrations') return json(200, integrationCatalog());
    if (method === 'POST' && pathname === '/api/v1/seller/setup') {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      return json(200, await setupShop(store, await readJson(request)));
    }
    if (method === 'POST' && pathname === '/api/v1/seller/demo/reset') {
      if (!demoEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
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
      const body = await readJson(request);
      if (pathname === '/api/v1/seller/company-settings') return json(200, await updateCompanySettings(store, body));
      if (method === 'POST') return json(201, await createCategory(store, body));
      let code;
      try { code = decodeURIComponent(pathname.slice('/api/v1/seller/categories/'.length)); }
      catch { throw new ApiError(404, 'NOT_FOUND', 'Category not found.'); }
      if (!code || code.includes('/')) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
      return json(200, await updateCategory(store, code, body));
    }
    if (method === 'GET' && pathname === '/api/v1/seller/orders/summary') return json(200, await pendingOrderSummary(store));
    if (method === 'GET' && pathname === '/api/v1/seller/orders') {
      return json(200, await listSellerOrders(store, url.searchParams));
    }
    const sellerOrder = sellerOrderIdPath.exec(pathname);
    if (method === 'GET' && sellerOrder && !sellerOrder[2]) {
      const order = await getSellerOrder(store, sellerOrder[1]);
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, order);
    }
    if (method === 'POST' && sellerOrder?.[2]) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      const body = await readJson(request);
      return json(200, await decideSellerOrder(store, sellerOrder[1], sellerOrder[2], body, config.username));
    }
    const sellerProduct = sellerProductIdPath.exec(pathname);
    if (method === 'GET' && sellerProduct && !sellerProduct[2]) {
      const product = await getProduct(store, sellerProduct[1], true, config.shopMode);
      if (!product) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(200, presentCatalogCopy(product, config.shopMode));
    }
    if (method === 'GET' && sellerProduct?.[2] === 'image') {
      return image(await getProductImage(store, sellerProduct[1], true));
    }
    if (galleryImage?.[1]) {
      if (method === 'GET') return image(await getGalleryImage(store, galleryImage[2], galleryImage[3], true));
      if (method === 'DELETE') {
        requireOrigin(request, expectedOrigin);
        requireCsrf(request, session);
        return json(200, await deleteGalleryImage(store, galleryImage[2], galleryImage[3], config.shopMode));
      }
    }
    if (method === 'POST' && /^\/api\/v1\/seller\/products\/[0-9a-f-]{36}\/gallery$/.test(pathname)) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      const id = pathname.split('/')[5];
      const body = await readJson(request, 750_000);
      if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'imageDataUrl')) {
        throw new FieldError('imageDataUrl', 'Choose an image.');
      }
      return json(201, await addGalleryImage(store, id, body.imageDataUrl, config.shopMode));
    }
    if ((method === 'POST' && pathname === '/api/v1/seller/products') ||
        (method === 'PATCH' && sellerProduct && !sellerProduct[2])) {
      requireOrigin(request, expectedOrigin);
      requireCsrf(request, session);
      const body = await readJson(request, PRODUCT_MUTATION_BODY_LIMIT);
      if (method === 'POST') {
        const product = await createProduct(store, body);
        return json(201, product, { Location: `/api/v1/seller/products/${product.id}` });
      }
      const product = await updateProduct(store, sellerProduct[1], body, config.shopMode);
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
