import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDecisionClearance, catalogReviewBrowserFixture, digest, injection, operationId as id } from './helpers/mcp-operation-review-browser-fixture.js';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
async function assertNamedTargets(scope) {
  const controls = scope.locator('a[href]:visible, button:visible, input:visible, summary:visible, pre[tabindex="0"]:visible');
  for (const control of await controls.all()) {
    const snapshot = await control.ariaSnapshot();
    // Playwright snapshots may represent a native summary by its accessible text.
    const name = /^- [\w]+ "[^"]+"/.test(snapshot) || /^- text: \S/.test(snapshot);
    assert.ok(name, `Control has an accessible name: ${snapshot}`);
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `44px target: ${snapshot}`);
  }
}

test('first-party review prototype renders all untrusted data as text and requires an explicit decision',
  { skip: !browserModule, timeout: 60000 }, async (t) => {
    const { calls, respond } = await catalogReviewBrowserFixture();
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await respond(new Request(`http://127.0.0.1${request.url}`, {
        method: request.method, headers: request.headers,
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
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
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme });
      t.after(() => context.close());
      const external = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${origin}${base}/oauth/operation?operationId=${id}`);
      await page.locator('#review').waitFor({ state: 'visible' });
      if (width === 390) await assertDecisionClearance(page, 'catalog');
      assert.equal(await page.evaluate(() => window.__injected), undefined);
      assert.equal(await page.locator('#proposal script').count(), 0);
      assert.equal(await page.locator('#client script').count(), 0);
      assert.equal(await page.locator('#client').textContent(), injection);
      assert.equal(await page.locator('#technical-details').getAttribute('open'), null);
      const summary = await page.locator('#summary-fields').textContent();
      for (const value of ['Old synthetic', 'OLD', '123', 'USD', '7', 'Old category', 'Old description', 'NEW', '456', 'New category', 'New description']) assert.ok(summary.includes(value), value);
      assert.match(summary, /minor units/i);
      assert.match(summary, /currency not provided/i);
      const description = page.locator('.summary-field').filter({ has: page.getByRole('heading', { name: 'Description Changed' }) });
      assert.equal(await description.locator('.changed-badge').textContent(), 'Changed');
      const before = description.locator('.comparison > div').first();
      const after = description.locator('.comparison > div').last();
      assert.equal(await before.locator('dt').textContent(), 'Before');
      assert.equal(await after.locator('dt').textContent(), 'After');
      const beforeBox = await before.boundingBox(), afterBox = await after.boundingBox();
      if (width < 640) assert.ok(afterBox.y >= beforeBox.y + beforeBox.height, `stacked comparison at ${width}px`);
      else assert.equal(afterBox.y, beforeBox.y);
      const unchanged = page.locator('.unchanged-fields');
      assert.equal(await unchanged.getAttribute('open'), null);
      assert.match(await unchanged.locator('summary').textContent(), /^Unchanged fields \(3\)$/);
      assert.equal(await unchanged.getByText('Options', { exact: true }).isVisible(), false);
      if (width === 390) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const bar = page.locator('#decision');
        assert.equal(await bar.evaluate(node => getComputedStyle(node).position), 'fixed');
        const box = await bar.boundingBox();
        assert.ok(box.y > 0 && box.y + box.height <= 844, 'decision bar fits in the initial viewport');
        assert.equal(await page.locator('#approve').evaluate(button => {
          const box = button.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
        }), true);
        await page.evaluate(() => window.scrollTo(0, 120));
        const scrolled = await bar.boundingBox();
        assert.ok(Math.abs(scrolled.y - box.y) < 1, 'decision bar stays anchored while scrolling');
        await assertNamedTargets(page);
        await unchanged.locator('summary').click();
        assert.equal(await unchanged.getByText('Options', { exact: true }).isVisible(), true);
        await unchanged.locator('summary').click();
      }
      await page.locator('#technical-details > summary').click();
      assert.equal(await page.locator('#proposal').isVisible(), true);
      if (width === 390) await assertNamedTargets(page);
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
      assert.equal(await page.locator('#approve').textContent(), 'Approve change');
      assert.equal(await page.locator('button[value="reject"]').textContent(), 'Reject');
      assert.ok((await page.locator('#approve').boundingBox()).height >= 48);
      assert.ok((await page.locator('button[value="reject"]').boundingBox()).height >= 48);
      await page.locator(`button[value="${decision}"]`).click();
      const approved = decision === 'approve';
      const dialog = page.getByRole('alertdialog', { name: approved ? 'Approved' : 'Rejected', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.evaluate(node => node.matches(':modal')), true);
      assert.equal(await dialog.locator('#result-description').textContent(), approved
        ? 'Nothing has changed yet. Go back to Claude and ask it to apply this change.'
        : 'No change was made.');
      assert.equal(await dialog.locator('svg').isVisible(), approved);
      assert.equal(await page.locator('#status').textContent(), approved
        ? 'Approved. The connected app must still commit this change.'
        : 'Rejected. The change was not applied.');
      assert.equal(await page.locator('#status').getAttribute('aria-live'), 'polite');
      assert.equal(await page.locator('#status').evaluate(node => getComputedStyle(node).clipPath), 'inset(50%)');
      const close = dialog.getByRole('button', { name: 'Close', exact: true });
      assert.ok((await close.boundingBox()).height >= 44);
      if (width === 390) await assertNamedTargets(dialog);
      assert.equal(await close.evaluate(node => node === document.activeElement), true);
      if (approved || width === 390) await close.click();
      else await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#status:focus').waitFor();
      assert.match(await page.getByRole('status').ariaSnapshot(), approved ? /Approved/ : /Rejected/);
      assert.equal(await page.locator('#decision').isVisible(), false);
      const call = calls.at(-1);
      assert.equal(call.path, `${base}/api/v1/seller/mcp/operations/${id}/approval`);
      assert.equal(call.csrf, 'synthetic-csrf');
      assert.deepEqual(call.body, { operationId: id, previewHash: digest, challenge: 'a'.repeat(43), decision });
      assert.equal(await page.locator('#decision input[type=password]').count(), 0);
      await context.close();
    }
  });
