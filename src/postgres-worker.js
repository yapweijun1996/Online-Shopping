import { parentPort, workerData } from 'node:worker_threads';
import { createApi } from './app.js';
import { ensureAdmin } from './auth.js';
import { errorResponse } from './http.js';
import { openPostgresStore } from './postgres-store.js';
import { initializeShop } from './shop-setup.js';

const store = openPostgresStore(workerData.config);
ensureAdmin(store, workerData.config.username, workerData.config.password);
initializeShop(store, workerData.config);
const handle = createApi({ store, config: workerData.config });

// One database connection owns the shop. Queue complete requests so their
// transactions cannot interleave across async body parsing or password checks.
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(async () => {
    let response;
    try {
      const request = new Request(message.url, {
        method: message.method,
        headers: message.headers,
        body: message.body || undefined,
      });
      response = await handle(request, { clientAddress: message.clientAddress });
    } catch (error) {
      response = errorResponse(error);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    parentPort.postMessage({ id: message.id, status: response.status,
      headers: [...response.headers], body }, [body.buffer]);
  }).catch((error) => {
    parentPort.postMessage({ id: message.id, status: 500,
      headers: [['content-type', 'application/json; charset=utf-8']],
      body: new TextEncoder().encode(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } })) });
    console.error('PostgreSQL request failed:', error?.code || error?.name || 'ERROR');
  });
});
parentPort.postMessage({ ready: true });
