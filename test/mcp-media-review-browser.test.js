import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mediaReviewFixture, sharedReviewGraph } from './helpers/mcp-media-review-fixture.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: real HTTPS Chromium automatically acknowledges every verified image before single-tap approval`,
  { skip: !modulePath, timeout: 60000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'shopping-media-browser-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    let api;
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const result = await api(new Request(`https://127.0.0.1:${server.address().port}${request.url}`, { method: request.method,
        headers: request.headers, ...(!['GET', 'HEAD'].includes(request.method) ? { body: Buffer.concat(chunks) } : {}) }), { clientAddress: 'synthetic-browser' });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `https://127.0.0.1:${server.address().port}`;
    const f = await mediaReviewFixture(t, dialect, { fixtureOptions: { config: { sellerOrigin: origin } }, prepareGraph: sharedReviewGraph }); api = f.api;
    const { chromium } = await import(modulePath), browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 900 } }); t.after(() => context.close());
    const login = await context.request.post(origin + '/api/v1/seller/session', { headers: { Origin: origin }, data: { username: 'synthetic_owner', password: reviewPassword } });
    assert.equal(login.status(), 200);
    const errors = [], external = [];
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    let corrupted = false;
    const corruptImage = async route => {
      const response = await route.fetch();
      if (!corrupted && response.headers()['content-type']?.startsWith('image/')) {
        corrupted = true; const bytes = await response.body(); bytes[bytes.length - 1] ^= 1;
        await route.fulfill({ response, body: bytes });
      } else await route.fulfill({ response });
    };
    await page.route('**/media/delivery', corruptImage);
    await page.goto(origin + '/oauth/operation?operationId=' + f.operation.operationId);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Image verification failed'));
    assert.equal(await page.locator('#approve').isDisabled(), true);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET' AND ack_at IS NOT NULL", f.operation.operationId)).n), 0);
    assert.equal(await page.locator('#media-image').isVisible(), false);
    await page.unroute('**/media/delivery', corruptImage);
    assert.equal(await page.locator('#media-ack, #media-image-ack, #decision input[type=password]').count(), 0);
    const count = Number((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_asset_ref WHERE operation_id=?", f.operation.operationId)).n);
    const finalAck = Promise.withResolvers(), release = Promise.withResolvers();
    let attempted = 0;
    await page.route('**/media/ack', async route => {
      if (route.request().postDataJSON().kind === 'ASSET' && ++attempted === count) {
        finalAck.resolve();
        await release.promise;
      }
      await route.continue();
    });
    await page.locator('#media-image-retry').click();
    await finalAck.promise;
    try {
      assert.equal(await page.locator('#approve').isDisabled(), true);
      assert.ok(await page.locator('#media-image').evaluate(image => !image.hidden && image.naturalWidth > 0));
    } finally { release.resolve(); }
    await page.locator('#approve:enabled').waitFor();
    assert.match(await page.locator('#media-effects').textContent(), /Before[\s\S]*After/);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET' AND ack_at IS NOT NULL", f.operation.operationId)).n), count);
    const repeated = page.locator('.media-reference').first(); await repeated.click();
    await page.waitForFunction(() => document.querySelector('#media-image').complete && document.querySelector('#media-image').naturalWidth > 0);
    await page.evaluate(() => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        HTMLImageElement.prototype.decode = decode;
        return Promise.reject(new DOMException('Synthetic decoder failure', 'EncodingError'));
      };
    });
    await page.locator('.media-reference').last().click();
    assert.equal(await page.locator('#media-image').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Image verification failed'));
    assert.equal(await page.locator('#media-image').isVisible(), false);
    await page.locator('#media-image-retry').click();
    await page.waitForFunction(() => document.querySelector('#media-image').naturalWidth > 0 && !document.querySelector('#media-image').hidden);
    await page.locator('#approve').click(); await page.locator('#decision').waitFor({ state: 'hidden' });
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).state, 'APPROVED');
    assert.equal((await f.commit()).replayed, false); assert.equal((await f.commit()).replayed, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
