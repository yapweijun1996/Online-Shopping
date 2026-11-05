import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApi } from '../src/app.js';
import { serveStatic } from '../src/static.js';
import { createCategory } from '../src/settings.js';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';
import { freshCatalogAccess } from './helpers/mcp-catalog-default-grant.js';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('real HTTPS catalog default tools create through Chromium review and replay once', { skip: !browserModule, timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-catalog-browser-')); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  await chmod(key, 0o600); await chmod(cert, 0o600);
  let api;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const target = `https://127.0.0.1:${server.address().port}${request.url}`;
    const result = await api(new Request(target, { method: request.method, headers: request.headers,
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: Buffer.concat(chunks) } : {}) }), { clientAddress: 'synthetic-catalog-browser' });
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `https://127.0.0.1:${server.address().port}`;
  const f = await reviewFixture(t, 'sqlite', { operationTools: undefined, config: { sellerOrigin: origin, publicOrigin: origin,
    mcpRedirectUris: ['https://client.example.com/catalog-callback'] } });
  api = await createApi({ store: f.store, config: f.config, serveStatic });
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic browser category' });
  const { chromium } = await import(browserModule), browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 900 } }); t.after(() => context.close());
  const external = [], errors = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
  // Actual HTTPS network calls exercise fresh PKCE, password login and exact write consent.
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await context.request.fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { data: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { response: { status: response.status(), headers: new Headers(response.headers()) }, data };
  };
  const client = await freshCatalogAccess(f, undefined, call);
  const listed = await client.rpc('tools/list', {}); assert.equal(listed.data.result.tools.length, 12);
  const injection = '</pre><script>window.__catalogInjected=true</script> Synthetic browser description';
  const prepared = await client.call('catalog.preview_create', { input: { sku: 'SYNTHETIC-BROWSER', name: 'Synthetic browser product',
    description: injection, category: 'SYNTHETIC', priceMinor: 1200, active: true, stockQuantity: 4 }, idempotencyKey: 'synthetic-browser-create-0001' });
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.data));
  const op = prepared.data.result.structuredContent;
  assert.equal((await client.call('catalog.commit_create', { operationId: op.operationId })).response.status, 403);
  assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 0);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(op.reviewUrl); await page.locator('#review').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__catalogInjected), undefined); assert.equal(await page.locator('#proposal script').count(), 0);
  assert.ok((await page.locator('#proposal').textContent()).includes(injection));
  assert.match(await page.locator('#proposal').textContent(), /SYNTHETIC-BROWSER/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#password').fill(reviewPassword); await page.locator('button[value="approve"]').click();
  await page.locator('#decision').waitFor({ state: 'hidden' });
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.operationId)).state, 'APPROVED');
  assert.equal(await page.locator('#password').inputValue(), '');
  const done = await client.call('catalog.commit_create', { operationId: op.operationId });
  assert.equal(done.response.status, 200, JSON.stringify(done.data)); const receipt = done.data.result.structuredContent;
  assert.equal(receipt.status, 'COMMITTED'); assert.equal(receipt.replayed, false);
  const replay = await client.call('catalog.commit_create', { operationId: op.operationId }); assert.equal(replay.data.result.structuredContent.replayed, true);
  assert.deepEqual(replay.data.result.structuredContent.result, receipt.result);
  const product = await call('/api/v1/products/' + receipt.result.productId);
  assert.equal(product.response.status, 200); assert.equal(product.data.name, 'Synthetic browser product');
  assert.equal(product.data.description, injection);
  assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id = ?', receipt.result.productId)).stock_quantity, 4);
  await page.goto(origin + '/shop/'); await page.locator('#catalog-grid .product-name-link').filter({ hasText: 'Synthetic browser product' }).waitFor();
  assert.equal(await page.evaluate(() => window.__catalogInjected), undefined);
  assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 1);
  assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM product_event WHERE action = 'CREATED'")).n), 1);
  assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n), 1);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});
