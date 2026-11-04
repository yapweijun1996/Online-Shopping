import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64);
const injection = '</pre><script>window.__injected = true</script>';

test('first-party review prototype renders all untrusted data as text and requires an explicit decision',
  { skip: !browserModule, timeout: 60000 }, async (t) => {
    const assets = Object.fromEntries(await Promise.all(['html', 'js', 'css'].map(async (extension) =>
      [extension, await readFile(new URL(`../src/mcp/operation-review.${extension}`, import.meta.url))])));
    const calls = [];
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname.replace(/^\/alpha(?=\/)/, '');
      if (path === '/oauth/operation') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(assets.html); return;
      }
      if (/^\/oauth\/operation-review\.(js|css)$/.test(path)) {
        const extension = path.endsWith('.js') ? 'js' : 'css';
        response.writeHead(200, { 'Content-Type': extension === 'js' ? 'text/javascript' : 'text/css' }); response.end(assets[extension]); return;
      }
      const send = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (path === '/api/v1/seller/session' && request.method === 'GET') { send({ csrfToken: 'synthetic-csrf' }); return; }
      if (path === `/api/v1/seller/mcp/operations/${id}` && request.method === 'GET') {
        send({ operationId: id, shopName: 'Synthetic shop', accountName: 'synthetic_owner', clientName: injection, clientId: 'synthetic-client',
          toolName: 'catalog.preview_update', resourceType: 'product', resourceId: id, risk: 'MEDIUM', expiresAt: '2026-11-04T00:10:00.000Z',
          previewHash: digest, proposal: { before: { name: 'Old synthetic' },
            after: { name: injection, bidi: 'A\u202eB', tail: 'Full proposal visible' } } }); return;
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
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const scenarios = [[1280, '', 'approve'], [390, '/alpha', 'reject'], [320, '', 'approve']];
    for (const [index, [width, base, decision]] of scenarios.entries()) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
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
      const displayed = await page.locator('#proposal').textContent();
      assert.ok(displayed.includes(injection));
      assert.ok(displayed.includes('Full proposal visible'));
      assert.ok(displayed.includes('\\u202e'));
      assert.equal(calls.length, index); // no automatic approval
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /object-src 'none'/);
      assert.deepEqual(external, []);
      assert.equal(await page.locator('#seller-link').getAttribute('href'), `${base}/seller/`);
      await page.locator('#password').fill('Synthetic-password-only');
      await page.locator(`button[value="${decision}"]`).click();
      await page.locator('#decision').waitFor({ state: 'hidden' });
      const call = calls.at(-1);
      assert.equal(call.path, `${base}/api/v1/seller/mcp/operations/${id}/approval`);
      assert.equal(call.csrf, 'synthetic-csrf');
      assert.deepEqual(call.body, { operationId: id, previewHash: digest, decision, password: 'Synthetic-password-only' });
      assert.equal(await page.locator('#password').inputValue(), '');
      await context.close();
    }
  });
