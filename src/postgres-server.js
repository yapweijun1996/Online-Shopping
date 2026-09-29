import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { ApiError, errorResponse, json, readBody } from './http.js';
import { clientAddress, toFetchRequest, writeFetchResponse } from './node-http.js';

const MAX_FORWARD_BODY = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 12_000;

export async function createPostgresApp(config) {
  const worker = new Worker(new URL('./postgres-worker.js', import.meta.url), { workerData: { config } });
  const pending = new Map();
  let nextId = 0;
  let unavailable = false;
  let ready;
  const startup = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const startupTimeout = setTimeout(() => ready?.reject(new Error('PostgreSQL startup timed out.')), 30_000);
  worker.on('message', (message) => {
    if (message.ready) {
      clearTimeout(startupTimeout);
      ready?.resolve();
      ready = null;
      return;
    }
    const current = pending.get(message.id);
    if (!current) return;
    pending.delete(message.id);
    clearTimeout(current.timeout);
    current.resolve(new Response(message.body, { status: message.status, headers: message.headers }));
  });
  const fail = (error) => {
    unavailable = true;
    clearTimeout(startupTimeout);
    ready?.reject(error);
    ready = null;
    for (const [id, current] of pending) {
      pending.delete(id);
      clearTimeout(current.timeout);
      current.resolve(json(503, { status: 'unavailable' }));
    }
  };
  worker.once('error', fail);
  worker.once('exit', (code) => fail(new Error(`PostgreSQL worker exited (${code}).`)));
  try { await startup; }
  catch (error) { await worker.terminate(); throw error; }

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        await writeFetchResponse(response, json(200, { status: 'alive' }));
        return;
      }
      if (unavailable) throw new ApiError(503, 'UNAVAILABLE', 'Database unavailable.');
      const fetchRequest = toFetchRequest(request);
      const body = request.method === 'GET' || request.method === 'HEAD'
        ? null : await readBody(fetchRequest, MAX_FORWARD_BODY);
      const id = ++nextId;
      const result = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          resolve(json(503, { status: 'unavailable' }));
        }, RESPONSE_TIMEOUT_MS);
        pending.set(id, { resolve, timeout });
        worker.postMessage({ id, url: fetchRequest.url, method: request.method,
          headers: [...fetchRequest.headers], body, clientAddress: clientAddress(request, config) });
      });
      await writeFetchResponse(response, result);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else await writeFetchResponse(response, errorResponse(error));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return { server, close: () => new Promise((resolve, reject) => server.close(async (error) => {
    await worker.terminate();
    if (error) reject(error);
    else resolve();
  })) };
}
