import { createApi } from './app.js';
import { ensureAdmin } from './auth.js';
import { readWorkerConfig } from './config.js';
import { migrateStore } from './db.js';
import { openDurableStore } from './durable-store.js';
import { errorResponse, json, readBody } from './http.js';

const apiPath = /^\/(?:api\/|health$|ready$)/;
const MAX_FORWARD_BODY = 1024 * 1024;

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
    if (!apiPath.test(url.pathname)) return env.ASSETS.fetch(request);
    // Only this Worker can reach the object, so it sets the client address the object trusts.
    const headers = new Headers(request.headers);
    headers.set('x-real-ip', request.headers.get('cf-connecting-ip') || 'unknown');
    // Buffer the bounded body first so the object never sees a half-sent stream.
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        body = await readBody(request, MAX_FORWARD_BODY);
      } catch (error) {
        return errorResponse(error);
      }
      headers.delete('content-length');
    }
    const stub = env.SHOP.get(env.SHOP.idFromName('shop'), { locationHint: 'apac' });
    return stub.fetch(new Request(request.url, { method: request.method, headers, body }));
  },
};
