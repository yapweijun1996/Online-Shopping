import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerFixture } from './helpers/seller-app.js';
import { applySellerDecision } from '../src/seller-orders.js';

// Uses the same opt-in installed Playwright module as the repository's UI QA scripts.
const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
test('shipping UI: confirmation-only action, filters, download, errors and mobile layout', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const submitted = await f.submit();
  const order = await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', submitted.data.orderNo);
  await applySellerDecision(f.app.database, order.id, 'confirm', { expectedRevision: 1 }, 'fixture');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => route.request().url().startsWith(f.origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(f.origin + '/seller/');
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password);
  await page.locator('#password').press('Enter');
  await page.getByRole('button', { name: 'Sales Order Confirmation', exact: true }).click();
  const button = page.getByRole('button', { name: 'Export shipping list', exact: true });
  await button.waitFor({ state: 'visible' });
  await page.locator('#order-search').fill(submitted.data.orderNo);
  const downloadEvent = page.waitForEvent('download');
  const requestEvent = page.waitForRequest((request) => request.url().includes('shipping-list.csv'));
  await button.click();
  const request = await requestEvent, download = await downloadEvent;
  assert.equal(new URL(request.url()).searchParams.get('search'), submitted.data.orderNo);
  assert.equal(new URL(request.url()).searchParams.get('status'), 'CONFIRMED');
  assert.match(download.suggestedFilename(), /^shipping-list-\d{4}-\d{2}-\d{2}\.csv$/);
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString('utf8'), /Example Recipient/);
  for (const [status, text] of [[413, 'More than 500 parcels match. Narrow the filters.'], [403, 'Shipping export is not available for this session.']]) {
    await page.route('**/shipping-list.csv?*', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: status === 413 ? 'TOO_MANY_ROWS' : 'FORBIDDEN' } }) }));
    await button.click(); await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await button.isEnabled(), true);
    await page.unroute('**/shipping-list.csv?*');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  const bounds = await button.boundingBox(); assert.ok(bounds.height >= 44); assert.ok(bounds.width <= 390);
  assert.equal(await button.getAttribute('aria-describedby'), 'shipping-export-help');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Sales Orders', exact: true }).click();
  assert.equal(await button.count(), 0);
  await f.app.database.run("UPDATE seller_account SET role = 'STAFF' WHERE username = ?", f.config.username);
  await page.reload();
  await page.getByRole('button', { name: 'Sales Order Confirmation', exact: true }).click();
  await button.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#order-export').isVisible(), false);
});
