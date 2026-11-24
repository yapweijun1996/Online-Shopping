import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createProduct } from '../src/products.js';
import { sellerFixture } from './helpers/seller-app.js';
import { controlProductResponses, signInToProducts } from './helpers/seller-skeleton-browser.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const playwright = await import(modulePath || 'playwright').catch(error => {
  if (modulePath || error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("Cannot find package 'playwright'")) throw error;
  return null;
});

test('Seller Products skeleton uses the real layout without interactive markup', () => {
  const html = readFileSync(new URL('../public/seller/index.html', import.meta.url), 'utf8');
  const template = html.match(/<template id="product-skeleton-template">([\s\S]+?)<\/template>/)?.[1];
  assert.ok(template);
  for (const part of ['product-card', 'product-select', 'product-placeholder', 'product-row-identity',
    'product-card-identity', 'product-row-sku', 'product-card-price', 'product-row-stock',
    'product-status-chip', 'product-card-actions']) assert.match(template, new RegExp(`\\b${part}\\b`));
  assert.doesNotMatch(template, /<(?:input|button|a|summary|img)\b|\btabindex\b/);
});

test('Seller Products skeleton follows the current request through success, pagination, error and empty results', {
  skip: !playwright && 'Set QA_PLAYWRIGHT_MODULE to run with Chromium', timeout: 45000,
}, async t => {
  const fixture = await sellerFixture();
  t.after(() => fixture.close());
  for (let index = 1; index <= 24; index++) {
    await createProduct(fixture.app.database, {
      sku: `SK-${index}`, name: `Fictional item ${index}`, description: 'Fixture', category: 'EXAMPLES',
      priceMinor: 1250, currency: 'MYR', active: true, stockQuantity: 12,
    });
  }
  const browser = await playwright.chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'en', reducedMotion: 'no-preference', serviceWorkers: 'block',
  });
  const holdProducts = await controlProductResponses(context, fixture);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const list = page.locator('#product-list');
  const rows = list.locator('[data-product-id]');
  const skeleton = list.locator('.product-loading-rows');
  const status = page.locator('#product-status');
  const busy = () => page.locator('#product-list[aria-busy="true"] .product-skeleton').first().waitFor();
  const ready = async () => {
    await page.locator('#product-list[aria-busy="false"]').waitFor({ state: 'attached' });
    assert.equal(await skeleton.count(), 0);
    assert.notEqual(await status.textContent(), 'Loading…');
  };
  const search = async value => {
    await page.locator('#product-search').fill(value);
    await page.locator('#product-search').press('Enter');
  };

  const initial = holdProducts();
  await signInToProducts(page, fixture);
  await Promise.all([busy(), initial.requested]);
  assert.equal(await skeleton.getAttribute('aria-hidden'), 'true');
  assert.equal(await status.getAttribute('aria-live'), 'polite');
  assert.equal(await status.evaluate(node => node.classList.contains('sr-only')), true);
  assert.equal(await page.getByRole('status').filter({ hasText: /^Loading…$/ }).count(), 1);
  assert.equal(await rows.count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Select all loaded products' }).isDisabled(), true);
  const animation = () => skeleton.locator('.img-reveal').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).animationName))]);
  assert.deepEqual(await animation(), ['img-shimmer']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await animation(), ['none']);
  initial.release();
  await ready();
  assert.equal(await rows.count(), 24);

  const next = holdProducts(query => query.get('offset') === '24');
  await page.locator('#product-more').click();
  await Promise.all([busy(), next.requested]);
  assert.equal(await skeleton.locator('.product-skeleton').count(), 1);
  assert.equal(await rows.count(), 24);
  assert.equal(await rows.last().isVisible(), true);
  assert.equal(await page.locator('#product-more').isDisabled(), true);
  next.release();
  await ready();
  assert.equal(await rows.count(), 25);

  const failed = holdProducts(query => query.get('search') === 'failure');
  await search('failure');
  await Promise.all([busy(), failed.requested]);
  assert.equal(await rows.first().isVisible(), false);
  failed.fail();
  await ready();
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.equal(await rows.count(), 25);
  assert.equal(await rows.first().isVisible(), true);

  const older = holdProducts(query => query.get('search') === 'item');
  const latest = holdProducts(query => query.get('search') === 'no results');
  await search('item');
  await Promise.all([busy(), older.requested]);
  await search('no results');
  await Promise.all([busy(), latest.requested]);
  const response = page.waitForResponse(result => new URL(result.url()).searchParams.get('search') === 'item');
  older.release();
  await (await response).finished();
  // Let the resolved older fetch reach the view while the current response is still held.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await busy();
  assert.equal(await rows.first().isVisible(), false);
  latest.release();
  await ready();
  assert.equal(await rows.count(), 0);
  assert.equal(await status.textContent(), 'No products match this search.');
  assert.equal(await status.isVisible(), true);
  assert.deepEqual(errors, []);
});
