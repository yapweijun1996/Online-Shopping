import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('SuperAdmin resets the seller account of the default and a tenant shop and gets a ready email for the seller', { skip: !browserModule }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try {
      const data = await readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shop = { id: '12345678-1234-4234-8234-123456789abc', code: 'default', name: 'Synthetic Mart', currency: 'MYR', status: 'ACTIVE', revision: 4, isDefault: true,
    sellerUsername: 'seller', sellerUrl: 'https://seller.example.test/seller/', shopUrl: 'https://shop.example.test/shop/' };
  const writes = [];
  await page.route('**/api/v1/platform/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') {
      writes.push({ path: url.pathname, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      shop.revision += 1;
      return route.fulfill({ json: { tenant: shop, sellerUsername: shop.sellerUsername, sellerPassword: 'Synthetic-temp-password_1' } });
    }
    const body = url.pathname.endsWith('/session') ? { stage: 'FULL', csrfToken: 'synthetic-csrf', username: 'admin' } : url.pathname.endsWith('/shops') ? { items: [shop] }
      : url.pathname.endsWith('/qr') ? { provisioned: true, tenantSlots: 1, occupiedTenantSlots: 0, binding: null } : shop;
    await route.fulfill({ json: body });
  });
  for (const isDefault of [true, false]) {
    shop.isDefault = isDefault; shop.code = isDefault ? 'default' : 'alpha';
    await page.goto(`${origin}/platform/index.html`);
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('button', { name: 'Reset seller password', exact: true }).waitFor();
    assert.match(await page.locator('#content').innerText(), /Seller\s+seller/);
    if (isDefault) assert.equal(await page.getByRole('button', { name: 'Suspend shop', exact: true }).count(), 0);
    // Cancelling the confirmation changes nothing.
    await page.getByRole('button', { name: 'Reset seller password', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: 'Reset seller password', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reset and show password', exact: true }).click();
    const secrets = page.locator('#secret-dialog'); await secrets.waitFor({ state: 'visible' });
    const text = await secrets.innerText();
    for (const expected of ['seller', 'Synthetic-temp-password_1', 'https://seller.example.test/seller/']) assert.ok(text.includes(expected), expected);
    const email = await page.locator('#seller-email-template').inputValue();
    assert.match(email, /^Subject: Your Synthetic Mart seller account/);
    for (const line of ['Username: seller', 'Temporary password: Synthetic-temp-password_1', 'Seller page: https://seller.example.test/seller/']) assert.ok(email.includes(line), line);
    assert.match(email, /choose a new password straight away/);
    assert.deepEqual(writes.at(-1).body, { expectedRevision: shop.revision - 1 }); assert.equal(writes.at(-1).csrf, 'synthetic-csrf');
    assert.match(writes.at(-1).path, /\/reset-seller-password$/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await secrets.getByRole('button', { name: 'Close' }).click().catch(() => page.keyboard.press('Escape'));
    await secrets.waitFor({ state: 'hidden' });
    // The one-time password does not stay in the page after the dialog closes.
    assert.equal(await page.evaluate(() => document.body.innerText.includes('Synthetic-temp-password_1') || [...document.querySelectorAll('textarea')].some(node => node.value.includes('Synthetic-temp-password_1'))), false);
    writes.length = 0;
  }
});
