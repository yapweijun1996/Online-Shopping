import { chromium } from '/Users/yapweijun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const origin = 'https://online-shopping.onemap-token-proxy.workers.dev';
const out = 'output/qa/live';mkdirSync(out, { recursive: true });
const results = [],errors = [],responses = [],blockedWrites = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await context.route('**/*', (route) => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
    blockedWrites.push({ method: request.method(), path: new URL(request.url()).pathname });return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();page.setDefaultTimeout(12000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {if (response.status() >= 400) responses.push({ status: response.status(), path: new URL(response.url()).pathname });});
async function check(ids, label, action) {
  try {const evidence = await action();results.push({ ids, label, status: 'PASS', evidence });}
  catch (error) {results.push({ ids, label, status: 'FAIL', error: error.message });}
}
try {
  await page.goto(origin + '/shop/');await page.locator('.catalog-card').first().waitFor();
  await check([1, 2], 'Fresh public catalog and image data', async () => {
    const data = await page.evaluate(async () => (await fetch('/api/v1/products?limit=100')).json());
    assert.ok(data.items.length > 0);return { products: data.items.length, firstSku: data.items[0].sku, viewport: 390 };
  });
  await page.screenshot({ path: out + '/customer-catalog-390.png', fullPage: true });
  await check([88, 92], 'Public mobile layout and authored zoom policy', async () => {
    const data = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, viewport: document.querySelector('meta[name=viewport]').content }));
    assert.ok(data.scrollWidth <= data.width);assert.doesNotMatch(data.viewport, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:[,\s]|$)/i);return data;
  });
  await check([3, 5], 'Public search and empty recovery', async () => {
    const search = page.locator('#catalog-search');await search.fill('QA-NO-SUCH-PRODUCT');await search.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 0);
    await search.fill('');await search.press('Enter');await page.locator('.catalog-card').first().waitFor();return 'Empty then restored catalog';
  });
  await check([7, 8, 9], 'Public product primary/gallery', async () => {
    const product = await page.evaluate(async () => (await (await fetch('/api/v1/products?limit=1')).json()).items[0]);
    await page.goto(origin + '/shop/#product/' + product.id);await page.locator('.product-add').waitFor();
    const data = await page.evaluate(async (id) => {const value = await (await fetch('/api/v1/products/' + id)).json();
      const img = document.querySelector('.product-main-image');await img.decode();return { images: value.images?.length, primaryWidth: img.naturalWidth, controls: [...document.querySelectorAll('button')].map((x) => ({ text: x.textContent, aria: x.getAttribute('aria-label') })).filter((x) => /image|photo/i.test(x.text + ' ' + x.aria)) };}, product.id);
    assert.equal(data.images, 6);assert.ok(data.primaryWidth > 0);await page.screenshot({ path: out + '/customer-gallery-390.png', fullPage: true });return data;
  });
  await check([81, 82], 'Public current/target version UI', async () => {
    await page.goto(origin + '/shop/');
    const workers = await page.evaluate(async () => Object.fromEntries(await Promise.all(await Promise.all(['shop', 'seller'].map(async (surface) => [surface, { status: (await fetch('/' + surface + '/sw.js')).status, source: await (await fetch('/' + surface + '/sw.js')).text() }])))));
    const versions = Object.fromEntries(Object.entries(workers).map(([key, value]) => [key, value.source.match(/version:\s*'([^']+)'/)?.[1] ?? null]));
    writeFileSync(out + '/deployed-versions.json', JSON.stringify({ versions, workerStatuses: Object.fromEntries(Object.entries(workers).map(([key, value]) => [key, value.status])) }, null, 2));
    assert.equal((await page.locator('[data-current-version], .pwa-version').count()) > 0, true, 'No explicit loaded-version UI in deployed Customer build');return versions;
  });
  await page.goto(origin + '/seller/');await page.locator('#login-view').waitFor({ state: 'visible' });
  await page.screenshot({ path: out + '/seller-login-390.png', fullPage: true });
  await check([42, 45], 'Public unauthenticated access and password control', async () => {
    const response = await page.request.get(origin + '/api/v1/seller/orders');assert.equal(response.status(), 401);
    await page.locator('#password-toggle').click();assert.equal(await page.locator('#password').getAttribute('type'), 'text');
    await page.locator('#password-toggle').click();assert.equal(await page.locator('#password').getAttribute('type'), 'password');
    return { unauthorizedStatus: response.status(), noLoginAttempt: true };
  });
  for (const width of [320, 820, 1440]) {await page.setViewportSize({ width, height: 900 });
    await check([88], 'Public Seller login layout ' + width, async () => {assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));return { width };});}
  await check([93], 'Public page exceptions and blocked writes', async () => {assert.deepEqual(errors, []);assert.deepEqual(blockedWrites, []);return { errors, responses, blockedWrites };});
} finally {
  writeFileSync(out + '/browser-results.json', JSON.stringify({ observedAt: new Date().toISOString(), origin, readOnly: true, serviceWorkers: 'blocked for complete write interception', results, errors, responses, blockedWrites }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results: results.map((x) => ({ label: x.label, status: x.status, error: x.error })), errors, responses, blockedWrites }));
