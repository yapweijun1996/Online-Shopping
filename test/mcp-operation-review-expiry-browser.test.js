import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildMediaManifest, mediaAssetKey } from '../src/mcp/media-manifest.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { directWireInput, wireId } from './helpers/mcp-catalog-wire-fixture.js';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const operationId = wireId(1), now = Date.parse('2030-04-05T06:07:08.000Z');
const operationPath = `/api/v1/seller/mcp/operations/${operationId}`;
const expiredMessage = 'Proposal expired. Ask the connected app for a new preview.';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Synthetic transport exercises browser state, not server expiry/authorization enforcement.
test('review expiry disables decisions despite pending media and late errors',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const assets = Object.fromEntries(await Promise.all(['html', 'js', 'css'].map(async extension =>
      [extension, await readFile(new URL(`../src/mcp/operation-review.${extension}`, import.meta.url))])));
    const tokens = await readFile(new URL('../public/shop/tokens.css', import.meta.url));
    const appearance = await readFile(new URL('../public/shared/appearance.css', import.meta.url));
    const png = await readFile(new URL('../public/shop/icons/icon-192.png', import.meta.url));
    const input = directWireInput(), assetKey = mediaAssetKey('image/png', mediaHash(png));
    Object.assign(input.assets[0], { byte_sha256: mediaHash(png), byte_length: png.length });
    input.graphBytes.oldBytes = png.length;
    input.effects[0].before.mainAssetKey = input.effects[0].after.mainAssetKey = assetKey;
    input.effects[1].before.galleryAssetKeys = input.effects[1].after.galleryAssetKeys = [assetKey];
    const manifest = buildMediaManifest(input);
    const items = [...manifest.pages.map(page => ({ kind: 'PAGE', itemKey: String(page.page_index), hash: page.page_hash, pageIndex: page.page_index, assetKey: null })),
      ...manifest.assets.map(asset => ({ kind: 'ASSET', itemKey: asset.asset_key, hash: asset.byte_sha256, pageIndex: null, assetKey: asset.asset_key }))];
    let scenario;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      const send = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (path === '/oauth/operation') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(assets.html); return; }
      if (path === '/shop/tokens.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(tokens); return; }
      if (path === '/shared/appearance.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(appearance); return; }
      if (/^\/oauth\/operation-review\.(js|css)$/.test(path)) {
        const extension = path.endsWith('.js') ? 'js' : 'css';
        response.writeHead(200, { 'Content-Type': extension === 'js' ? 'text/javascript' : 'text/css' }); response.end(assets[extension]); return;
      }
      if (path === '/api/v1/seller/session') { send({ csrfToken: 'synthetic-csrf' }); return; }
      if (path === operationPath && request.method === 'GET') {
        send({ operationId, shopName: 'Synthetic expiry shop', accountName: 'synthetic_owner', clientName: 'Synthetic client', clientId: 'synthetic-client',
          toolName: scenario.media ? input.toolName : 'catalog.preview_update', resourceType: 'product', resourceId: operationId, risk: 'HIGH',
          expiresAt: new Date(scenario.expiresAt).toISOString(), previewHash: 'a'.repeat(64), challenge: 'A'.repeat(43),
          currencyAcknowledgementRequired: false, currencyWarning: null,
          proposal: { before: { name: 'Before', active: true }, after: { name: 'After', active: false } },
          ...(scenario.media ? { mediaReview: { descriptor: manifest.descriptor, items, labels: [{ productId: operationId, sku: 'SYNTHETIC', name: 'Synthetic image' }] } } : {}) });
        return;
      }
      if (request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (path === operationPath + '/media/delivery') {
          const item = items.find(item => item.kind === body.kind && item.itemKey === body.itemKey);
          response.writeHead(200, { 'Content-Type': body.kind === 'PAGE' ? 'application/json' : 'image/png', 'X-Media-Nonce': 'B'.repeat(43),
            'X-Media-Sha256': item.hash, 'X-Media-Manifest': manifest.descriptor.manifestRoot, 'X-Media-Item': `${body.kind}:${body.itemKey}` });
          response.end(body.kind === 'PAGE' ? manifest.pages[Number(body.itemKey)].page_json : png); return;
        }
        if (path === operationPath + '/media/ack') { send({ operationId, kind: body.kind, itemKey: body.itemKey, acknowledged: true }); return; }
        if (path === operationPath + '/approval') { send({ operationId, status: body.decision === 'approve' ? 'APPROVED' : 'REJECTED' }); return; }
      }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = await import(browserModule), browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const approvalRequests = new WeakMap();

    async function open(options) {
      scenario = { expiresAt: now + 60000, media: false, ...options };
      const context = await browser.newContext({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' });
      t.after(() => context.close());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const attempts = []; approvalRequests.set(page, attempts);
      page.on('request', request => { if (new URL(request.url()).pathname === operationPath + '/approval') attempts.push(request); });
      assert.ok(page.clock, 'Expiry regressions require Playwright clock support (v1.45+)');
      await page.clock.install({ time: new Date(now - 1000) });
      await page.clock.pauseAt(new Date(now));
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      // Observe completion of the actual image loader, including its success/error continuation.
      await page.route(origin + operationPath, async route => {
        await page.evaluate(() => {
          const original = showMediaImage;
          showMediaImage = async (...args) => {
            try { return await original(...args); } finally { window.__imageLoadsCompleted = (window.__imageLoadsCompleted || 0) + 1; }
          };
          const acknowledge = acknowledgeMedia;
          acknowledgeMedia = async (...args) => {
            const asset = args[0].kind === 'ASSET';
            if (asset) window.__ackPending = true;
            try { return await acknowledge(...args); } finally { if (asset) window.__ackPending = false; }
          };
        });
        await route.continue();
      });
      return { context, page, errors, navigate: () => page.goto(`${origin}/oauth/operation?operationId=${operationId}`) };
    }
    async function assertDisabled(page) {
      assert.equal(await page.locator('#pending-state').textContent(), expiredMessage);
      assert.equal(await page.locator('#status').textContent(), expiredMessage);
      for (const selector of ['#approve', 'button[value="reject"]', '#password', '#media-ack', '#currency-ack', '#media-image-ack', '#media-image-retry']) {
        assert.equal(await page.locator(selector).isDisabled(), true, selector);
      }
    }
    async function scriptedDecisions(page) {
      const count = approvalRequests.get(page).length;
      await page.evaluate(() => {
        for (const decision of ['approve', 'reject']) {
          document.querySelector('#password').value = 'Synthetic-password-only';
          document.querySelector('#media-ack').checked = true;
          document.querySelector('#decision').dispatchEvent(new SubmitEvent('submit', {
            bubbles: true, cancelable: true, submitter: document.querySelector(`button[value="${decision}"]`),
          }));
        }
      });
      await page.evaluate(() => {});
      assert.equal(approvalRequests.get(page).length, count);
    }

    await t.test('already expired: readable local expiry, UTC title, disabled controls and scripted submit blocked', async () => {
      const { page, context, errors, navigate } = await open({ expiresAt: now - 1 });
      await navigate(); await page.locator('#review').waitFor({ state: 'visible' });
      await assertDisabled(page);
      const expiry = new Date(now - 1).toISOString();
      assert.equal(await page.locator('#expires').getAttribute('title'), `${expiry} (UTC)`);
      assert.equal(await page.locator('#expires').textContent(), await page.evaluate(value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }), expiry));
      assert.match(await page.locator('#expires').textContent(), /14:07:07/);
      assert.match(await page.locator('#summary-fields').textContent(), /Availability[\s\S]*Listed[\s\S]*Not listed/);
      await scriptedDecisions(page); assert.deepEqual(errors, []); await context.close();
    });

    await t.test('submit checks current time even when the expiry timer has not fired', async () => {
      const { page, context, errors, navigate } = await open();
      await navigate(); await page.locator('#review').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#approve').isDisabled(), false);
      await page.clock.setSystemTime(new Date(now + 60001));
      assert.equal(await page.locator('#approve').isDisabled(), false, 'setSystemTime does not run the pending timer');
      await scriptedDecisions(page); await assertDisabled(page);
      assert.deepEqual(errors, []); await context.close();
    });

    for (const outcome of ['success', 'error']) await t.test(`expiry while exact image delivery is pending: late ${outcome} stays disabled`, async () => {
      const { page, context, errors, navigate } = await open({ media: true });
      const pending = deferred(), release = deferred();
      await page.route('**/media/delivery', async route => {
        if (route.request().postDataJSON().kind !== 'ASSET') { await route.continue(); return; }
        pending.resolve(); await release.promise;
        if (outcome === 'success') await route.continue();
        else await route.fulfill({ status: 500, body: 'Synthetic delivery failure' });
      });
      await navigate(); await pending.promise;
      await page.clock.runFor(60001); await assertDisabled(page);
      release.resolve(); await page.waitForFunction(() => window.__imageLoadsCompleted === 1, null, { polling: 10 });
      await assertDisabled(page); await scriptedDecisions(page);
      assert.deepEqual(errors, []); await context.close();
    });

    for (const outcome of ['success', 'error']) await t.test(`expiry while image acknowledgment is pending: late ${outcome} cannot enable approval`, async () => {
      const { page, context, errors, navigate } = await open({ media: true });
      const pending = deferred(), release = deferred();
      await page.route('**/media/ack', async route => {
        if (route.request().postDataJSON().kind !== 'ASSET') { await route.continue(); return; }
        pending.resolve(); await release.promise;
        if (outcome === 'success') await route.continue();
        else await route.fulfill({ status: 500, body: 'Synthetic acknowledgment failure' });
      });
      await navigate(); await page.waitForFunction(() => !document.querySelector('#media-image-ack').disabled, null, { polling: 10 });
      await page.locator('#media-image-ack').click(); await pending.promise;
      await page.clock.runFor(60001); await assertDisabled(page);
      release.resolve();
      await page.waitForFunction(() => window.__ackPending === false, null, { polling: 10 });
      await assertDisabled(page); await scriptedDecisions(page);
      assert.deepEqual(errors, []); await context.close();
    });

    await t.test('failed decision response after expiry cannot restore decision controls', async () => {
      const { page, context, errors, navigate } = await open();
      const pending = deferred(), release = deferred();
      await page.route('**/approval', async route => {
        pending.resolve(); await release.promise;
        await route.fulfill({ status: 500, body: 'Synthetic decision failure' });
      });
      await navigate(); await page.locator('#review').waitFor({ state: 'visible' });
      await page.locator('#password').fill('Synthetic-password-only'); await page.locator('#approve').click(); await pending.promise;
      await page.clock.runFor(60001); await assertDisabled(page);
      await page.evaluate(() => { document.querySelector('#password').value = 'Awaiting decision completion'; });
      release.resolve(); await page.waitForFunction(() => document.querySelector('#password').value === '', null, { polling: 10 });
      await assertDisabled(page); await scriptedDecisions(page);
      assert.deepEqual(errors, []); await context.close();
    });

    await t.test('long expiry timers rearm rather than expire at the signed 32-bit timeout limit', async () => {
      const limit = 2147483647, { page, context, errors, navigate } = await open({ expiresAt: now + limit + 60000 });
      await navigate(); await page.locator('#review').waitFor({ state: 'visible' });
      await page.clock.fastForward(limit);
      assert.equal(await page.locator('#approve').isDisabled(), false);
      assert.match(await page.locator('#pending-state').textContent(), /Pending your decision/);
      await page.clock.runFor(60001); await assertDisabled(page); await scriptedDecisions(page);
      assert.deepEqual(errors, []); await context.close();
    });
  });
