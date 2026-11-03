import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

// Product editor layout: a plain page title (no focus ring), stock with pricing, variant group and option label side by
// side with their explanation below, change history after the cards, and Save / Cancel always in reach.
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const publicRoot = path.resolve('public');

test('seller product editor groups related fields and keeps Save in reach at every width', { skip: !browserModule, timeout: 120000 }, async (t) => {
  const server = createServer((request, response) => {
    let pathname = new URL(request.url, 'http://local').pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(publicRoot, pathname);
    if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const session = { username: 'synthetic', role: 'owner', csrfToken: 'synthetic-csrf', capabilities: ['catalog.write'], quickLogin: false, mustChangePassword: false };
  for (const [width, height] of [[1440, 900], [1000, 800], [390, 844], [320, 700]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/v1/seller/session')) return route.fulfill({ json: session });
      if (pathname.endsWith('/v1/shop')) return route.fulfill({ json: { name: 'Synthetic Shop', currency: 'MYR', storageScope: '' } });
      if (pathname.endsWith('/categories')) return route.fulfill({ json: { items: [{ code: 'PET', name: 'Pet Care', active: true }] } });
      if (pathname.endsWith('/company-settings')) return route.fulfill({ json: { defaultCurrency: 'MYR' } });
      return route.fulfill({ json: { items: [], nextOffset: null } });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/seller/`);
    await page.locator('#username').fill('synthetic'); await page.locator('#password').fill('Synthetic-pass-1'); await page.locator('#login-submit').click();
    await page.locator('#workspace').waitFor();
    await page.evaluate(() => document.querySelector('[data-view=products]').click());
    await page.locator('#product-new').click();
    await page.locator('#product-editor-view').waitFor();
    const at = `${width}px`;
    const result = await page.evaluate(() => {
      const box = (node) => node.getBoundingClientRect();
      const title = document.querySelector('#page-title'); title.focus();
      const group = document.querySelector('[name=variantGroup]'), label = document.querySelector('[name=variantLabel]'), help = document.querySelector('#product-variant-help');
      const cancel = getComputedStyle(document.querySelector('#product-cancel'));
      return {
        titleOutline: getComputedStyle(title).outlineStyle,
        stockInPricing: document.querySelector('.product-pricing-card [name=stockQuantity]') !== null,
        variantSection: group.closest('.product-variant-config') === label.closest('.product-variant-config') && group.closest('.product-variant-config') !== null,
        sameRow: Math.abs(box(group).top - box(label).top) < 2, helpBelow: box(help).top >= Math.max(box(group).bottom, box(label).bottom),
        helpLeft: Math.abs(box(help).left - box(group).left) < 2,
        describedBy: [group, label].every((node) => node.getAttribute('aria-describedby') === 'product-variant-help'),
        historyAfterCards: Boolean(document.querySelector('.product-editor-layout').compareDocumentPosition(document.querySelector('#product-history')) & Node.DOCUMENT_POSITION_FOLLOWING),
        helpFont: parseFloat(getComputedStyle(document.querySelector('#product-stock-help')).fontSize),
        cancelBorder: cancel.borderTopWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(result.titleOutline, 'none', at);
    assert.equal(result.stockInPricing, true, at); assert.equal(result.variantSection, true, at);
    assert.equal(result.sameRow, width > 560, `${at} group and label share a row only where there is room`);
    assert.equal(result.helpBelow, true, at); assert.equal(result.helpLeft, true, at); assert.equal(result.describedBy, true, at);
    assert.equal(result.historyAfterCards, true, at);
    assert.ok(result.helpFont >= 13, at); assert.equal(result.cancelBorder, '1px', at); assert.equal(result.overflow, false, at);
    // Save stays visible at the bottom of the screen while the top of the form is shown.
    await page.evaluate(() => scrollTo(0, 0));
    const save = await page.locator('#product-save').boundingBox();
    assert.ok(save.y >= 0 && save.y + save.height <= height + 1, `${at} save ${JSON.stringify(save)}`);
    // ...and does not hide the last field at the end of the form.
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const bar = await page.locator('.product-editor-actions').boundingBox();
    const last = await page.locator('.product-image-column').boundingBox();
    assert.ok(last.y + last.height <= bar.y + 1, `${at} last card ends above the action bar`);
    assert.deepEqual(errors, [], at);
    await context.close();
  }
});
