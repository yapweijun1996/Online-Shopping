import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { readConfig } from './config.js';
import { openDatabase, ready } from './db.js';
import { authenticate, cookieFor, createSession, deleteSession, ensureAdmin, LoginLimiter, readSession, sessionCookieFrom } from './auth.js';
import { ApiError, handleErrors, json, readJson, requireOrigin } from './http.js';
import { serveStatic } from './static.js';
import { createProduct, getProduct, getProductImage, listProducts, updateProduct } from './products.js';
import { createOrder } from './orders.js';
import { decideSellerOrder, getSellerOrder, listSellerOrders } from './seller-orders.js';

const productIdPath = /^\/api\/v1\/products\/([0-9a-f-]{36})(?:\/(image))?$/;
const sellerProductIdPath = /^\/api\/v1\/seller\/products\/([0-9a-f-]{36})(?:\/(image))?$/;
const sellerOrderIdPath = /^\/api\/v1\/seller\/orders\/([0-9a-f-]{36})(?:\/(confirm|reject))?$/;

function image(response, value) {
  if (!value?.mime || !value?.data) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  response.writeHead(200, {
    'Content-Type': value.mime, 'Content-Length': value.data.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  response.end(value.data);
}

function clientAddress(request, config) {
  const forwarded = request.headers['x-real-ip'];
  if (config.trustProxy && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress || 'unknown';
}

class CheckoutLimiter {
  #attempts = new Map();
  allowed(key) {
    const now = Date.now();
    const attempts = (this.#attempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
    if (attempts.length >= 30) return false;
    if (!this.#attempts.has(key) && this.#attempts.size >= 5000) {
      this.#attempts.delete(this.#attempts.keys().next().value);
    }
    attempts.push(now);
    this.#attempts.set(key, attempts);
    return true;
  }
}

export function createApp(config) {
  const database = openDatabase(config.dbPath);
  try {
    ensureAdmin(database, config.username, config.password);
  } catch (error) {
    database.close();
    throw error;
  }
  const limiter = new LoginLimiter();
  const checkoutLimiter = new CheckoutLimiter();
  const server = handleErrors(async (request, response) => {
    const host = request.headers.host;
    const url = new URL(request.url, `http://${host || 'localhost'}`);
    const pathname = url.pathname;
    const expectedOrigin = config.publicOrigin || `http://${host}`;
    if (request.method === 'GET' && pathname === '/health') return json(response, 200, { status: 'alive' });
    if (request.method === 'GET' && pathname === '/ready') {
      const healthy = ready(database);
      return json(response, healthy ? 200 : 503, { status: healthy ? 'ready' : 'unavailable' });
    }
    if (!pathname.startsWith('/api/')) return serveStatic(request, response, pathname);
    if (request.method === 'GET' && pathname === '/api/v1/products') return json(response, 200, listProducts(database, url.searchParams));
    const publicProduct = productIdPath.exec(pathname);
    if (request.method === 'GET' && publicProduct) {
      if (publicProduct[2] === 'image') return image(response, getProductImage(database, publicProduct[1]));
      const product = getProduct(database, publicProduct[1]);
      if (!product) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(response, 200, product);
    }
    if (request.method === 'POST' && pathname === '/api/v1/orders') {
      requireOrigin(request, expectedOrigin);
      if (!checkoutLimiter.allowed(clientAddress(request, config))) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many submissions. Try again later.');
      }
      const body = await readJson(request, 128 * 1024);
      const result = createOrder(database, request.headers['idempotency-key'], body);
      return json(response, result.replayed ? 200 : 201, result.receipt);
    }
    if (!pathname.startsWith('/api/v1/seller/')) throw new ApiError(404, 'NOT_FOUND', 'Not found.');

    if (request.method === 'POST' && pathname === '/api/v1/seller/session') {
      requireOrigin(request, expectedOrigin);
      const key = clientAddress(request, config);
      if (!limiter.attempt(key)) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try later.');
      const body = await readJson(request);
      if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
          body.username.length > 64 || body.password.length > 256 || !(await authenticate(database, body.username, body.password))) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials.');
      }
      limiter.clear(key);
      const session = createSession(database);
      return json(response, 200, { username: config.username, role: 'SUPER_ADMIN', csrfToken: session.csrfToken }, {
        'Set-Cookie': cookieFor(session.token, session.maxAge, config.production),
      });
    }

    const token = sessionCookieFrom(request.headers.cookie);
    const session = readSession(database, token);
    if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in required.');
    if (request.method === 'GET' && pathname === '/api/v1/seller/session') {
      return json(response, 200, { username: config.username, role: 'SUPER_ADMIN', csrfToken: session.csrf_token });
    }
    if (request.method === 'DELETE' && pathname === '/api/v1/seller/session') {
      requireOrigin(request, expectedOrigin);
      if (request.headers['x-csrf-token'] !== session.csrf_token) throw new ApiError(403, 'FORBIDDEN', 'CSRF token is required.');
      deleteSession(database, token);
      return json(response, 200, { signedOut: true }, { 'Set-Cookie': cookieFor('', 0, config.production) });
    }
    if (request.method === 'GET' && pathname === '/api/v1/seller/products') {
      return json(response, 200, listProducts(database, url.searchParams, true));
    }
    if (request.method === 'GET' && pathname === '/api/v1/seller/orders') {
      return json(response, 200, listSellerOrders(database, url.searchParams));
    }
    const sellerOrder = sellerOrderIdPath.exec(pathname);
    if (request.method === 'GET' && sellerOrder && !sellerOrder[2]) {
      const order = getSellerOrder(database, sellerOrder[1]);
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(response, 200, order);
    }
    if (request.method === 'POST' && sellerOrder?.[2]) {
      requireOrigin(request, expectedOrigin);
      if (request.headers['x-csrf-token'] !== session.csrf_token) throw new ApiError(403, 'FORBIDDEN', 'CSRF token is required.');
      const body = await readJson(request);
      return json(response, 200, decideSellerOrder(database, sellerOrder[1], sellerOrder[2], body, config.username));
    }
    const sellerProduct = sellerProductIdPath.exec(pathname);
    if (request.method === 'GET' && sellerProduct?.[2] === 'image') {
      return image(response, getProductImage(database, sellerProduct[1], true));
    }
    if ((request.method === 'POST' && pathname === '/api/v1/seller/products') ||
        (request.method === 'PATCH' && sellerProduct && !sellerProduct[2])) {
      requireOrigin(request, expectedOrigin);
      if (request.headers['x-csrf-token'] !== session.csrf_token) throw new ApiError(403, 'FORBIDDEN', 'CSRF token is required.');
      const body = await readJson(request, 750_000);
      if (request.method === 'POST') {
        const product = createProduct(database, body);
        return json(response, 201, product, { Location: `/api/v1/seller/products/${product.id}` });
      }
      const product = updateProduct(database, sellerProduct[1], body);
      if (!product) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return json(response, 200, product);
    }
    throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return { server, database, close: () => new Promise((resolve, reject) => server.close((error) => {
    database.close();
    if (error) reject(error);
    else resolve();
  })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  try {
    const config = readConfig();
    const app = createApp(config);
    app.server.listen(config.port, () => console.log(`Online Shopping listening on port ${app.server.address().port}`));
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
