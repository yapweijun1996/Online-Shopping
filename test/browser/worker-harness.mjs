import { Readable } from 'node:stream';
import { createApi } from '../../src/app.js';
import { serveStatic } from '../../src/static.js';
import worker from '../../src/worker.js';
import { shopObjectName } from '../../src/shop-setup.js';
import { errorResponse, json } from '../../src/http.js';

export function useWorkerIngress(app, config) {
  const records = [], controls = { failNextCatalog: false, holdNextCatalog: null, held: null };
  const api = createApi({ store: app.database, config });
  const env = { SHOP_MODE: config.shopMode, SHOP_DEMO_REVISION: config.demoRevision,
    ASSETS: { fetch: request => serveStatic(request, new URL(request.url).pathname) },
    SHOP: { idFromName: name => name, get(id) {
      if (id !== shopObjectName(config.shopMode, config.demoRevision)) throw new Error('Unexpected synthetic namespace');
      return { async fetch(request) {
        const url = new URL(request.url), path = url.pathname;
        const bytes = await request.clone().arrayBuffer();
        const record = { method: request.method, path, query: url.search, bodyBytes: bytes.byteLength, workerForwarded: true };
        records.push(record);
        if (controls.failNextCatalog && request.method === 'GET' && path === '/api/v1/products') { controls.failNextCatalog = false; record.syntheticFailure = true; record.status = 503; return json(503, { error: { code: 'UNAVAILABLE' } }); }
        const result = await api(request, { clientAddress: request.headers.get('x-real-ip') || 'unknown' });
        record.status = result.status;
        const delay = controls.holdNextCatalog;
        if (request.method === 'GET' && path === '/api/v1/products' && delay && url.searchParams.get('search') === delay.search && url.searchParams.get('offset') === delay.offset) {
          controls.holdNextCatalog = null; record.realAPIDelayed = true;
          await new Promise(resolve => { controls.held = { release: resolve, query: url.search }; });
          controls.held = null; record.delayReleased = true;
          if (delay.failAfterRelease) { record.syntheticFailure = true; record.status = 503; return json(503, { error: { code: 'UNAVAILABLE' } }); }
        }
        return result;
      } };
    } },
  };
  app.server.removeAllListeners('request');
  app.server.on('request', async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (let n = 0; n < incoming.rawHeaders.length; n += 2) headers.append(incoming.rawHeaders[n], incoming.rawHeaders[n + 1]);
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
      const request = new Request(new URL(incoming.url, 'http://' + incoming.headers.host), {
        method: incoming.method, headers, ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      let result;
      try { result = await worker.fetch(request, env); } catch (error) { result = errorResponse(error); }
      const responseHeaders = Object.fromEntries([...result.headers].filter(([name]) => name !== 'set-cookie'));
      const cookies = result.headers.getSetCookie(); if (cookies.length) responseHeaders['set-cookie'] = cookies;
      const body = result.body ? Buffer.from(await result.arrayBuffer()) : null;
      outgoing.writeHead(result.status, responseHeaders); outgoing.end(body);
    } catch (error) { outgoing.writeHead(500); outgoing.end('Synthetic harness response failed'); console.error(error); }
  });
  return { records, controls };
}
