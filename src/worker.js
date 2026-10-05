import { initializeShop, shopObjectName } from '../worker-runtime/shop-setup.js';
import { createApi } from '../worker-runtime/app.js';
import { ensureAdmin } from '../worker-runtime/auth.js';
import { readWorkerConfig, readShopMode, readDemoRevision } from '../worker-runtime/config.js';
import { migrateStore } from '../worker-runtime/db.js';
import { openDurableStore } from '../worker-runtime/durable-store.js';
import { errorResponse, json, readBody } from '../worker-runtime/http.js';
import { PRODUCT_MUTATION_BODY_LIMIT } from './request-limits.js';

const apiPath = /^\/(?:api\/|health$|ready$)/;
const MAX_FORWARD_BODY = 1024 * 1024;
const galleryPatchPath = /^\/api\/v1\/seller\/products\/[0-9a-f-]{36}$/;

/*
 * One Durable Object owns the whole shop database: it is the single SQLite writer,
 * like the one Node process in the Docker deployment.
 */
export class ShopStore {
  constructor(ctx, env) {
    ctx.blockConcurrencyWhile(async () => {
      try {
        const config = readWorkerConfig(env);
        const store = openDurableStore(ctx.storage);
        migrateStore(store);
        ensureAdmin(store, config.username, config.password);
        initializeShop(store, config);
        this.handle = createApi({ store, config });
      } catch (error) {
        console.error(`Startup failed: ${error.message}`);
      }
    });
  }

  async fetch(request) {
    if (!this.handle) return json(503, { status: 'unavailable' });
    return this.handle(request, { clientAddress: request.headers.get('x-real-ip') || 'unknown' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!apiPath.test(url.pathname)) {
      let decoded;
      try { decoded = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/'); } catch { return json(404, { error: { code: 'NOT_FOUND' } }); }
      if (/^\/demo(?:\/|$)/.test(decoded) && readShopMode(env) !== 'public-demo') return json(404, { error: { code: 'NOT_FOUND' } });
      return env.ASSETS.fetch(request);
    }
    // Only this Worker can reach the object, so it sets the client address the object trusts.
    const headers = new Headers(request.headers);
    headers.set('x-real-ip', request.headers.get('cf-connecting-ip') || 'unknown');
    // Buffer the bounded body first so the object never sees a half-sent stream.
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        // Only atomic Seller gallery edits need the larger image budget. Other
        // paths/methods retain the stricter ingress; API authorization still runs.
        const limit = request.method === 'PATCH' && galleryPatchPath.test(url.pathname)
          ? PRODUCT_MUTATION_BODY_LIMIT : MAX_FORWARD_BODY;
        body = await readBody(request, limit);
      } catch (error) {
        return errorResponse(error);
      }
      headers.delete('content-length');
    }
    const stub = env.SHOP.get(env.SHOP.idFromName(shopObjectName(readShopMode(env), readDemoRevision(env))), { locationHint: 'apac' });
    return stub.fetch(new Request(request.url, { method: request.method, headers, body }));
  },
};
