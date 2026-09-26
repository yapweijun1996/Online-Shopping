import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.js';
import { ensureAdmin } from './auth.js';
import { readConfig } from './config.js';
import { openDatabase } from './db.js';
import { serveStatic } from './static.js';

function clientAddress(request, config) {
  const forwarded = request.headers['x-real-ip'];
  if (config.trustProxy && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress || 'unknown';
}

function toFetchRequest(request) {
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

export function createApp(config) {
  const database = openDatabase(config.dbPath);
  try {
    ensureAdmin(database, config.username, config.password);
  } catch (error) {
    database.close();
    throw error;
  }
  const handle = createApi({ store: database, config, serveStatic });
  const server = createServer(async (request, response) => {
    try {
      const result = await handle(toFetchRequest(request), { clientAddress: clientAddress(request, config) });
      await writeFetchResponse(response, result);
    } catch (error) {
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
