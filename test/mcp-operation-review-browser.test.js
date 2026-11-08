import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64);
const injection = '</pre><script>window.__injected = true</script>';

test('first-party review prototype renders all untrusted data as text and requires an explicit decision',
  { skip: !browserModule, timeout: 60000 }, async (t) => {
    const assets = Object.fromEntries(await Promise.all(['html', 'js', 'css'].map(async (extension) =>
      [extension, await readFile(new URL(`../src/mcp/operation-review.${extension}`, import.meta.url))])));
    const calls = [];
    const styles = {
      '/shop/tokens.css': await readFile(new URL('../public/shop/tokens.css', import.meta.url)),
      '/shared/appearance.css': await readFile(new URL('../public/shared/appearance.css', import.meta.url)),
    };
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname.replace(/^\/alpha(?=\/)/, '');
      if (path === '/oauth/operation') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(assets.html); return;
      }
      if (styles[path]) { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(styles[path]); return; }
      if (/^\/oauth\/operation-review\.(js|css)$/.test(path)) {
        const extension = path.endsWith('.js') ? 'js' : 'css';
        response.writeHead(200, { 'Content-Type': extension === 'js' ? 'text/javascript' : 'text/css' }); response.end(assets[extension]); return;
      }
      const send = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (path === '/api/v1/seller/session' && request.method === 'GET') { send({ csrfToken: 'synthetic-csrf' }); return; }
      if (path === `/api/v1/seller/mcp/operations/${id}` && request.method === 'GET') {
        send({ currencyAcknowledgementRequired: false, currencyWarning: null, operationId: id, shopName: 'Synthetic shop', accountName: 'synthetic_owner', clientName: injection, clientId: 'synthetic-client',
          toolName: 'catalog.preview_update', resourceType: 'product', resourceId: id, risk: 'MEDIUM', expiresAt: new Date(Date.now() + 600000).toISOString(),
          previewHash: digest, challenge: 'a'.repeat(43), proposal: { before: { name: 'Old synthetic', sku: 'OLD', priceMinor: 123, currency: 'USD', stockQuantity: 7, active: true, category: 'Old category', description: 'Old description', options: [] },
            after: { name: injection, sku: 'NEW', priceMinor: 456, stockQuantity: 0, active: false, category: 'New category', description: 'New description', options: [], bidi: 'A\u202eB', tail: 'Full proposal visible' } } }); return;
      }
      if (path === `/api/v1/seller/mcp/operations/${id}/approval` && request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        calls.push({ body, csrf: request.headers['x-csrf-token'], path: request.url });
        send({ operationId: id, status: body.decision === 'approve' ? 'APPROVED' : 'REJECTED' }); return;
      }
      response.writeHead(404); response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = await import(browserModule);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const backgrounds = new Map();
    const scenarios = [320, 360, 379, 380, 390, 768, 1440].flatMap(width => ['light', 'dark'].map(colorScheme => [width, width === 390 ? '/alpha' : '', colorScheme === 'dark' ? 'reject' : 'approve', colorScheme]));
    for (const [index, [width, base, decision, colorScheme]] of scenarios.entries()) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      t.after(() => context.close());
      const external = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${origin}${base}/oauth/operation?operationId=${id}`);
      await page.locator('#review').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => window.__injected), undefined);
      assert.equal(await page.locator('#proposal script').count(), 0);
      assert.equal(await page.locator('#client script').count(), 0);
      assert.equal(await page.locator('#client').textContent(), injection);
      assert.equal(await page.locator('#technical-details').getAttribute('open'), null);
      const summary = await page.locator('#summary-fields').textContent();
      for (const value of ['Old synthetic', 'OLD', '123', 'USD', '7', 'Old category', 'Old description', 'NEW', '456', 'New category', 'New description']) assert.ok(summary.includes(value), value);
      assert.match(summary, /minor units/i);
      assert.match(summary, /currency not provided/i);
      for (const label of ['Category', 'Description']) {
        const field = page.locator('.summary-grid > dt').filter({ hasText: new RegExp(`^${label}$`) });
        const labelBox = await field.boundingBox();
        if (width >= 390) assert.ok(labelBox.width >= 90, `${label} field width at ${width}px`);
        assert.equal(await field.evaluate(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return range.getClientRects().length;
        }), 1, `${label} stays readable without midword wrapping at ${width}px`);
        if (width < 380) {
          const beforeBox = await field.locator('xpath=following-sibling::dd[1]').boundingBox();
          const afterBox = await field.locator('xpath=following-sibling::dd[2]').boundingBox();
          assert.ok(beforeBox.y >= labelBox.y + labelBox.height, `${label} values below field label`);
          assert.equal(beforeBox.y, afterBox.y);
          assert.ok(Math.abs(labelBox.width - beforeBox.width - afterBox.width) < 1, `${label} spans both values`);
        }
      }
      await page.locator('#technical-details > summary').click();
      assert.equal(await page.locator('#proposal').isVisible(), true);
      const displayed = await page.locator('#proposal').textContent();
      assert.ok(displayed.includes(injection));
      assert.ok(displayed.includes('Full proposal visible'));
      assert.ok(displayed.includes('\\u202e'));
      assert.equal(calls.length, index); // no automatic approval
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if (colorScheme === 'light') backgrounds.set(width, background);
      else assert.notEqual(background, backgrounds.get(width));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /object-src 'none'/);
      assert.deepEqual(external, []);
      if (process.env.QA_APPROVAL_SCREENSHOT_DIR) {
        await mkdir(process.env.QA_APPROVAL_SCREENSHOT_DIR, { recursive: true });
        await page.locator('#technical-details > summary').click();
        await page.screenshot({ path: join(process.env.QA_APPROVAL_SCREENSHOT_DIR, `approval-${width}-${colorScheme}.png`), fullPage: true });
      }
      assert.equal(await page.locator('#seller-link').getAttribute('href'), `${base}/seller/`);
      await page.locator(`button[value="${decision}"]`).click();
      await page.locator('#decision').waitFor({ state: 'hidden' });
      const call = calls.at(-1);
      assert.equal(call.path, `${base}/api/v1/seller/mcp/operations/${id}/approval`);
      assert.equal(call.csrf, 'synthetic-csrf');
      assert.deepEqual(call.body, { operationId: id, previewHash: digest, challenge: 'a'.repeat(43), decision });
      assert.equal(await page.locator('#password').count(),0);
      await context.close();
    }
  });
