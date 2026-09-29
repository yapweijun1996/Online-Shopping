import { initializeShop } from './shop-setup.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApi } from './app.js';
import { ensureAdmin } from './auth.js';
import { readConfig } from './config.js';
import { openDatabase } from './db.js';
import { clientAddress, toFetchRequest, writeFetchResponse } from './node-http.js';
import { createPostgresApp } from './postgres-server.js';
import { serveStatic } from './static.js';

export function createApp(config) {
  const database = openDatabase(config.dbPath);
  try {
    ensureAdmin(database, config.username, config.password);
    initializeShop(database, config);
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
    const app = config.databaseEngine === 'postgres' ? await createPostgresApp(config) : createApp(config);
    app.server.listen(config.port, () => console.log(`Online Shopping listening on port ${app.server.address().port}`));
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
