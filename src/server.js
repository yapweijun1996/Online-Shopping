import { initializeShop } from './shop-setup.js';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.js';
import { ensureAdmin } from './auth.js';
import { readConfig } from './config.js';
import { openDatabase } from './db.js';
import { openPostgresDatabase } from './postgres-db.js';
import { serveStatic } from './static.js';
import { createSecretBox } from './secret-box.js';
import { createWhatsAppTransport } from './whatsapp-transport.js';
import { startWhatsAppWorker } from './whatsapp-outbox.js';
import { createPlatformRuntime } from './platform/runtime.js';
import { ApiError, errorResponse } from './http.js';

function clientAddress(request, config) {
  const forwarded = request.headers['x-real-ip'];
  if (config.trustProxy && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress || 'unknown';
}

function toFetchRequest(request, config) {
  // WHATWG URLs normalize encoded dot segments. Reject the raw code position before that normalization.
  if (config.platform && /^\/[^/?]*%|^\/\/|\\/.test(request.url)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(new URL(request.url, `http://${request.headers.host || 'localhost'}`), {
    method: request.method,
    headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeFetchResponse(response, result) {
  const body = result.body ? Buffer.from(await result.arrayBuffer()) : null;
  const headers = {};
  for (const [name, value] of result.headers) {
    if (name !== 'set-cookie') headers[name] = value;
  }
  const cookies = result.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  if (body && !headers['content-length']) headers['content-length'] = body.length;
  response.writeHead(result.status, headers);
  response.end(body);
}

export async function createApp(config) {
  const database = config.databaseUrl ? await openPostgresDatabase(config.databaseUrl) : await openDatabase(config.dbPath);
  try {
    await ensureAdmin(database, config.username, config.password);
    await initializeShop(database, config);
  } catch (error) {
    await database.close();
    throw error;
  }
  const platform = config.platform ? createPlatformRuntime({ store: database, config }) : null;
  const handle = await createApi({ store: database, config, serveStatic, registry: platform?.registry,
    platformHandler: platform ? (request, context) => platform.handle(request, context) : null });
  platform?.connect().catch(() => {});
  const server = createServer(async (request, response) => {
    try {
      const result = await handle(toFetchRequest(request, config), { clientAddress: clientAddress(request, config) });
      await writeFetchResponse(response, result);
    } catch (error) {
      if (error instanceof ApiError && !response.headersSent) { await writeFetchResponse(response, errorResponse(error)); return; }
      console.error('Response failed:', error?.code || error?.name || 'ERROR');
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }));
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  // The message worker is started by the process entry point only (never by tests). It needs the master keys and must
  // not run on a passwordless sample site, where the buyers and credentials are not real.
  let worker = null;
  const startWorker = () => {
    if (worker || !config.integrationKeys || config.sellerQuickLogin || config.shopMode === 'public-demo') return false;
    worker = startWhatsAppWorker({ store: database, secretBox: createSecretBox(config.integrationKeys), transport: createWhatsAppTransport() });
    return true;
  };
  return { server, database, platform, startWorker, close: () => new Promise((resolve, reject) => server.close(async (error) => {
    worker?.stop();
    await platform?.close();
    await database.close();
    if (error) reject(error);
    else resolve();
  })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  try {
    const config = readConfig();
    const app = await createApp(config);
    app.server.listen(config.port, () => {
      console.log(`Online Shopping listening on port ${app.server.address().port}`);
      app.startWorker();
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      app.close().then(() => process.exit(0), () => process.exit(1));
    });
  } catch (error) {
    console.error('Startup failed:', error?.code || error?.name || 'ERROR');
    process.exitCode = 1;
  }
}
