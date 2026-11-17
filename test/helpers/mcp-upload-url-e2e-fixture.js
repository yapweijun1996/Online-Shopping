import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../../src/db.js';
import { openPostgresDatabase } from '../../src/postgres-db.js';
import { createApi } from '../../src/app.js';
import { toFetchRequest } from '../../src/server.js';
import { readConfig } from '../../src/config.js';
import { ensureAdmin } from '../../src/auth.js';
import { setupShop } from '../../src/shop-setup.js';
import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
import { secret } from '../../src/mcp/credentials.js';
import { reviewPassword } from './mcp-review-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './mcp-catalog-default-grant.js';

// Default server registrations, real OAuth, TLS, stores and sealed codec socket.
// No clock, decoder, HTTP, grant, approval or database mocks.
export async function uploadUrlE2eFixture(t, dialect, worker) {
  const dir = await mkdtemp(join(tmpdir(), 'shopping-url-e2e-')); await chmod(dir, 0o700);
  let store, admin, databaseName, config, api;
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem'), epochFile = join(dir, 'epoch');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
    '-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const ca = await readFile(cert);
  const server = createServer({ key: await readFile(key), cert: ca }, async (request, response) => {
    try {
      // Exercise the real configured-host HTTPS adapter at this local TLS edge.
      const result = await api(toFetchRequest(request, { ...config, production: true, trustProxy: true }), { clientAddress: 'url-e2e-loopback' });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end(); }
  });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await store?.close();
    if (admin) { await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); await admin.end(); }
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  await writeFile(epochFile, secret(), { mode: 0o600 }); await mkdir(join(dir, 'db'));
  const dbPath = join(dir, 'db/shop.sqlite'); let databaseUrl;
  if (dialect === 'sqlite') store = await openDatabase(dbPath);
  else {
    assert.equal(process.env.NODE_ENV, 'test'); assert.match(new URL(process.env.SHOP_TEST_DATABASE_URL).pathname, /test/i);
    admin = new pg.Pool({ connectionString: process.env.SHOP_TEST_DATABASE_URL });
    databaseName = 'shopping_test_upload_url_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.SHOP_TEST_DATABASE_URL); url.pathname = '/' + databaseName; databaseUrl = url.href;
    store = await openPostgresDatabase(databaseUrl);
  }
  config = readConfig({ NODE_ENV: 'test', ADMIN_USERNAME: 'synthetic_owner', ADMIN_PASSWORD: reviewPassword,
    DB_PATH: dbPath, ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}), SELLER_ORIGIN: origin, PUBLIC_ORIGIN: origin,
    SHOP_MODE: 'manual', SELLER_QUICK_LOGIN: '0', MCP_ENABLED: '1', MCP_V2_ENABLED: '1', MCP_V2_EPOCH_FILE: epochFile,
    MCP_REDIRECT_URIS: 'https://client.example.com/catalog-callback', MCP_V2_MEDIA_ENABLED: '1',
    MCP_V2_MEDIA_SOCKET_PATH: worker.socketPath, MCP_V2_MEDIA_TOKEN_FILE: worker.tokenFile, MCP_V2_MEDIA_CODEC_IDENTITY: worker.image });
  await ensureAdmin(store, config.username, config.password);
  await setupShop(store, { mode: 'production', shopName: 'Upload URL local acceptance' });
  await createCategory(store, { code: 'SYNTHETIC', label: 'Synthetic upload fixtures' });
  const product = await createProduct(store, { sku: 'URL-UPLOAD-LOCAL', name: 'Local JPEG upload target', description: 'Isolated acceptance fixture',
    category: 'SYNTHETIC', priceMinor: 100, active: true, stockQuantity: 7 });
  api = await createApi({ store, config });
  const call = (path, method = 'GET', body, headers = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpsRequest(origin + path, { method, ca, agent: false,
      headers: { ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = JSON.parse(text); } catch { data = text; }
        resolve({ response: { status: res.statusCode, headers: new Headers(Object.entries(res.headers)
          .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, item]))) }, data });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local HTTPS timeout'))); req.on('error', reject); req.end(bytes);
  });
  const binding = { tenantId: 'default', issuer: origin, resource: origin + '/mcp' };
  const client = await freshCatalogAccess({ store, config, binding, call }, legacyCatalogScopes + ' catalog.write media.read media.write operations.read');
  return { dir, cert, ca, store, product, origin, call, client };
}
