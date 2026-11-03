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

test('seller product editor: unsaved changes, invalid price and stock, double Save, and a failed save keep the draft', { skip: !browserModule, timeout: 60000 }, async (t) => {
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const session = { username: 'synthetic', role: 'owner', csrfToken: 'synthetic-csrf', capabilities: ['catalog.write'], quickLogin: false, mustChangePassword: false };
  let posts = 0, failNext = false;
  await context.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname, method = route.request().method();
    if (pathname.endsWith('/v1/seller/session')) return route.fulfill({ json: session });
    if (pathname.endsWith('/v1/shop')) return route.fulfill({ json: { name: 'Synthetic Shop', currency: 'MYR', storageScope: '' } });
    if (pathname.endsWith('/categories')) return route.fulfill({ json: { items: [{ code: 'PET', name: 'Pet Care', active: true }] } });
    if (pathname.endsWith('/company-settings')) return route.fulfill({ json: { defaultCurrency: 'MYR' } });
    if (pathname.endsWith('/v1/seller/products') && method === 'POST') {
      posts++;
      if (failNext) return route.abort('failed');
      await new Promise((resolve) => setTimeout(resolve, 400));
      return route.fulfill({ status: 409, json: { error: { code: 'DUPLICATE_SKU', field: 'sku', message: 'duplicate' } } });
    }
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
  const form = page.locator('#product-form'), message = page.locator('#product-form-error');
  // Price shows its currency, blank stock says Unlimited, the shop switch explains itself.
  assert.equal((await page.locator('.input-prefix').innerText()).trim(), 'MYR');
  assert.equal(await form.locator('[name=stockQuantity]').getAttribute('placeholder'), 'Unlimited');
  assert.equal(await form.locator('[name=active]').getAttribute('aria-describedby'), 'product-active-help');
  assert.match(await page.locator('#product-active-help').innerText(), /hidden from the shop/);
  assert.equal(await form.locator('[name=currency]').getAttribute('readonly'), '');

  await form.locator('[name=name]').fill('Synthetic bowl'); await form.locator('[name=sku]').fill('SYN-001');
  await form.locator('[name=description]').fill('Synthetic description.'); await form.locator('[name=category]').selectOption('PET');
  // Leaving with unsaved changes asks first; staying keeps the draft.
  let dialogMessage = '';
  page.once('dialog', (dialog) => { dialogMessage = dialog.message(); dialog.dismiss(); });
  await page.locator('#product-back').click();
  assert.match(dialogMessage, /unsaved|changes/i);
  assert.equal(await page.locator('#product-editor-view').isVisible(), true);
  assert.equal(await form.locator('[name=name]').inputValue(), 'Synthetic bowl');

  // Invalid price and stock: nothing is sent, a specific message, the field is marked and focused.
  for (const [field, value, text] of [['price', 'abc', /price above 0/], ['price', '-5', /price above 0/], ['price', '0', /price above 0/]]) {
    await form.locator(`[name=${field}]`).fill(value);
    await page.locator('#product-save').click();
    await page.waitForFunction(() => document.querySelector('#product-form-error').textContent.trim() !== '');
    assert.match(await message.innerText(), text, `${field}=${value}`);
    assert.equal(await page.evaluate(() => document.activeElement.name), field);
    assert.equal(await form.locator(`[name=${field}]`).getAttribute('aria-invalid'), 'true');
  }
  await form.locator('[name=price]').fill('17.90');
  assert.equal(await form.locator('[name=price]').getAttribute('aria-invalid'), null, 'typing clears the error mark');
  for (const value of ['-1', '2.5', '9999999']) {
    await form.locator('[name=stockQuantity]').fill(value);
    await page.locator('#product-save').click();
    await page.waitForFunction(() => /whole number/.test(document.querySelector('#product-form-error').textContent));
    assert.equal(await page.evaluate(() => document.activeElement.name), 'stockQuantity', `stock=${value}`);
  }
  await form.locator('[name=stockQuantity]').fill('');
  assert.equal(posts, 0, 'invalid input never reaches the server');

  // Double Save sends one request; a duplicate SKU points at the SKU field.
  await page.locator('#product-save').dblclick();
  await page.waitForFunction(() => /SKU/i.test(document.querySelector('#product-form-error').textContent));
  assert.equal(posts, 1);
  assert.equal(await page.evaluate(() => document.activeElement.name), 'sku');

  // A failed request keeps every entered value.
  failNext = true;
  await page.evaluate(() => { document.querySelector('#product-form-error').textContent = ''; });
  await page.locator('#product-save').click();
  await page.waitForFunction(() => document.querySelector('#product-form-error').textContent.trim() !== '');
  assert.equal(posts, 2);
  assert.deepEqual(await form.evaluate((node) => ['name', 'sku', 'description', 'price', 'category'].map((name) => node.elements[name].value)),
    ['Synthetic bowl', 'SYN-001', 'Synthetic description.', '17.90', 'PET']);
  assert.equal(await page.locator('#product-save').isEnabled(), true);
  assert.deepEqual(errors, []);
});
