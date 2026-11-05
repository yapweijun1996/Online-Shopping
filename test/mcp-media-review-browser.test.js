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
for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: real HTTPS Chromium decodes and explicitly reviews every exact image before password approval`,
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
    assert.equal(await page.locator('#approve').isDisabled(), true); assert.equal(await page.locator('#media-image-ack').isDisabled(), true);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET' AND ack_at IS NOT NULL", f.operation.operationId)).n), 0);
    await page.unroute('**/media/delivery', corruptImage); await page.reload();
    await page.locator('#media-review').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#media-image-ack').disabled);
    assert.equal(await page.locator('#approve').isDisabled(), true); assert.equal(await page.locator('#media-ack').isChecked(), false);
    assert.match(await page.locator('#media-effects').textContent(), /Before[\s\S]*After/);
    const count = Number((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_asset_ref WHERE operation_id=?", f.operation.operationId)).n);
    for (let n = 1; n <= count; n++) {
      await page.locator('#media-image-ack').click();
      await page.waitForFunction(expected => document.querySelector('#media-progress').textContent.startsWith(expected + ' of '), n);
      if (n < count) await page.waitForFunction(() => !document.querySelector('#media-image-ack').disabled);
    }
    assert.equal(await page.locator('#approve').isDisabled(), false);
    const repeated = page.locator('.media-reference').first(); await repeated.click();
    await page.waitForFunction(() => document.querySelector('#media-image').complete && document.querySelector('#media-image').naturalWidth > 0);
    assert.equal(await page.locator('#media-image-ack').isDisabled(), true);
    await page.locator('#password').fill(reviewPassword); await page.locator('#approve').click();
    assert.match(await page.locator('#status').textContent(), /check the image acknowledgment/);
    await page.locator('#media-ack').check(); await page.locator('#approve').click(); await page.locator('#decision').waitFor({ state: 'hidden' });
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).state, 'APPROVED');
    assert.equal((await f.commit()).replayed, false); assert.equal((await f.commit()).replayed, true);
    assert.equal(await page.locator('#password').inputValue(), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
