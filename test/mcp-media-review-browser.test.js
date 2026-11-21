import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mediaReviewFixture, sharedReviewGraph } from './helpers/mcp-media-review-fixture.js';
import { assertDecisionClearance } from './helpers/mcp-operation-review-browser-fixture.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
for (const dialect of ['sqlite', 'postgres']) for (const targetSlot of ['MAIN', 'GALLERY']) test(`${dialect}: HTTPS Chromium reviews ${targetSlot} placement before approval`,
  { skip: !modulePath || (dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL), timeout: 60000 }, async t => {
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
    const f = await mediaReviewFixture(t, dialect, { fixtureOptions: { config: { sellerOrigin: origin } }, prepareGraph: targetSlot === 'MAIN' ? sharedReviewGraph : undefined, targetSlot }); api = f.api;
    const { chromium } = await import(modulePath), browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } }); t.after(() => context.close());
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
    if (targetSlot === 'GALLERY') {
      await page.goto(origin + '/oauth/operation?operationId=' + f.operation.operationId);
      await page.locator('#approve:enabled').waitFor();
      assert.equal(await page.locator('#operation-heading').textContent(), 'Add 1 gallery photo');
      assert.equal(await page.locator('#approve').textContent(), 'Approve adding 1 photo');
      assert.equal(await page.locator('#image-change-summary').textContent(), 'Add one photo to the gallery. The main product photo stays the same.');
      assert.equal(await page.locator('#image-impact').textContent(), 'Gallery goes from 1 to 2 photos · Main photo stays the same');
      assert.equal(await page.locator('.gallery-additions .media-reference').count(), 1);
      assert.equal(await page.locator('.gallery-existing').getAttribute('open'), null);
      await page.getByText('Existing photos (1)', { exact: true }).click();
      assert.equal(await page.getByRole('button', { name: /Main photo · Gallery photo 1/ }).isVisible(), true);
      await assertDecisionClearance(page, 'media');
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      return;
    }
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
    const ackRequests = [];
    await page.route('**/media/ack', async route => {
      const { kind, itemKey } = route.request().postDataJSON();
      if (kind === 'ASSET') {
        ackRequests.push(itemKey);
        if (ackRequests.length === count) {
          finalAck.resolve();
          await release.promise;
        }
      }
      await route.continue();
    });
    const retry = page.locator('.media-card-retry:visible, #media-image-retry:visible').first();
    const retryBox = await retry.boundingBox();
    assert.match(await retry.getAttribute('aria-label') || await retry.textContent(), /^Retry (Main product photo|Gallery photo|image verification)/);
    assert.ok(retryBox.width >= 44 && retryBox.height >= 44);
    await retry.click();
    await finalAck.promise;
    try {
      assert.equal(await page.locator('#approve').isDisabled(), true);
      assert.equal(await page.locator('#media-viewer').getAttribute('open'), null);
      assert.equal(await page.locator('#media-image').isVisible(), false);
      assert.ok(await page.locator('#media-image').evaluate(image => !image.hidden && image.naturalWidth > 0));
    } finally { release.resolve(); }
    await page.locator('#approve:enabled').waitFor();
    assert.equal(await page.locator('#media-viewer').getAttribute('open'), null);
    assert.equal(ackRequests.length, count);
    assert.equal(new Set(ackRequests).size, count);
    assert.match(await page.locator('#media-effects').textContent(), /Before[\s\S]*After/);
    const mediaEffects = page.locator('#media-effects');
    assert.equal(await page.locator('#technical-details').getAttribute('open'), null);
    const visibleText = await page.locator('body').innerText();
    assert.match(visibleText, /Synthetic MEDIA-TARGET/);
    assert.doesNotMatch(visibleText, /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
    assert.doesNotMatch(visibleText, /Listing role|No own main image/);
    assert.equal(await page.locator('#operation-heading').textContent(), 'Replace the main photo');
    assert.equal(await page.locator('#approve').textContent(), 'Approve main photo change');
    assert.match(await page.locator('#image-change-summary').textContent(), /^Replace the main product photo\./);
    const unchanged = mediaEffects.locator('.gallery-existing');
    if (await unchanged.getAttribute('open') !== null) await unchanged.locator('summary').click();
    const galleryHeading = unchanged.locator('h3').filter({ hasText: /Gallery · Synthetic/i });
    assert.equal(await galleryHeading.count(), 1);
    assert.equal(await galleryHeading.isVisible(), false);
    assert.match(await page.locator('#image-impact').textContent(), /main product photo/i);
    const mainPhoto = mediaEffects.locator('.media-comparison').first();
    const [before, after] = await Promise.all((await mainPhoto.locator('.media-state').all()).map(side => side.boundingBox()));
    assert.ok(after.y >= before.y + before.height, '390px image comparison is stacked');
    await page.waitForFunction(() => [...document.querySelectorAll('.media-reference img')].every(image => image.naturalWidth > 0));
    for (const side of ['Before', 'After']) {
      const urls = await mediaEffects.locator(`.media-reference[aria-label$=" · ${side}"] img`).evaluateAll(images => images.map(image => image.src));
      assert.ok(urls.length > 0);
      assert.equal(new Set(urls).size, urls.length, `${side} displays each asset once`);
    }
    for (const button of await mediaEffects.locator('.media-reference:visible').all()) {
      assert.match(await button.ariaSnapshot(), /^- button "(?:Main product photo|Gallery photo \d+) · (?:Before|After)"/);
      const box = await button.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44);
      assert.equal(await button.evaluate(node => node.offsetWidth), await button.locator('xpath=..').evaluate(node => node.clientWidth));
      assert.ok(await button.locator('img').evaluate(image => image.naturalWidth > 0 && new URL(image.src).protocol === 'blob:'));
    }
    await assertDecisionClearance(page, 'media');
    for (const [width, height, cap] of [[390, 844, 240], [768, 1024, 320], [1440, 900, 320]]) {
      await page.setViewportSize({ width, height });
      for (const image of await mediaEffects.locator('.media-reference:visible img').all()) {
        const box = await image.boundingBox();
        assert.ok(box.width >= 240 && box.height <= cap, `preview dimensions at ${width}×${height}`);
        assert.equal(await image.evaluate(node => getComputedStyle(node).objectFit), 'contain');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(Number((await f.store.get("SELECT COUNT(*) n FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET' AND ack_at IS NOT NULL", f.operation.operationId)).n), count);
    const photo = page.locator('.media-reference:visible').first();
    await photo.click();
    const preview = page.locator('#image-dialog');
    await preview.waitFor({ state: 'visible' });
    const beforeZoom = await preview.locator('img').getAttribute('src');
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await preview.locator('img').getAttribute('src'), beforeZoom);
    await page.keyboard.press('Escape');
    assert.equal(await preview.isVisible(), false);
    assert.equal(await photo.evaluate(node => node === document.activeElement), true);
    assert.equal(ackRequests.length, count, 'enlarging verified bytes does not request new acknowledgements');
    await page.route('**/approval', route => route.fulfill({ status: 500 }), { times: 1 });
    await page.locator('#approve').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Check the status before trying again.'));
    assert.equal(await page.locator('#result-dialog').evaluate(dialog => dialog.open), false);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).state, 'PENDING_APPROVAL');
    assert.equal(await page.locator('#approve').isDisabled(), true);
    await page.locator('#check-status').click();
    await page.locator('#approve:enabled').waitFor();
    await page.locator('#approve').click(); await page.locator('#decision').waitFor({ state: 'hidden' });
    await page.getByRole('alertdialog', { name: 'Approved', exact: true }).waitFor();
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).state, 'APPROVED');
    assert.equal((await f.commit()).replayed, false); assert.equal((await f.commit()).replayed, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
