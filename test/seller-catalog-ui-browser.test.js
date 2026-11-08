import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/products-active-first-browser';
for (const width of [390, 768, 1440]) for (const colorScheme of ['light', 'dark']) test(`Active-first Products real browser: ${width}px ${colorScheme}`, { skip: !modulePath }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  await createCategory(f.app.database, { code: 'OTHER', label: 'Other category' });
  const make = extra => createProduct(f.app.database, { description: 'Fictional item', category: 'EXAMPLES', priceMinor: 500, active: true, ...extra });
  const inactive = await make({ sku: 'HIDDEN', name: 'Hidden product', active: false, stockQuantity: 0 });
  await make({ sku: 'MIX-A', name: 'Mixed product', variantGroup: 'MIX', variantLabel: 'A', stockQuantity: 2 });
  await make({ sku: 'MIX-B', name: 'Mixed product', variantGroup: 'MIX', variantLabel: 'B', active: false, stockQuantity: 0 });
  await make({ sku: 'OTHER', name: 'Other product', category: 'OTHER', stockQuantity: 0 });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, serviceWorkers: 'block', acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/products')) writes.push(request.method()); });
  await page.goto(`${f.origin}/seller/#products`);
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter');
  const toggle = page.getByRole('switch', { name: 'Show inactive products' });
  const cards = page.locator('#product-list > .product-card');
  await page.waitForFunction(() => document.querySelector('#product-list')?.getAttribute('aria-busy') === 'false');
  // Login starts the existing .18s sidebar/main transition. Wait for the final
  // app-shell geometry before judging or capturing desktop layout.
  if (width > 1024) await page.waitForFunction(() => {
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    const main = document.querySelector('#main').getBoundingClientRect();
    return main.left >= sidebar.right - 1;
  });
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await cards.count(), 3);
  assert.equal(await page.locator('[data-stat=active]').textContent(), '3');
  assert.equal(await page.locator('[data-stat=inactive]').textContent(), '1');
  assert.equal(await page.locator('[data-stat=total]').textContent(), '4');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow');
  if (width > 1024) {
    const geometry = await page.evaluate(() => {
      const right = document.querySelector('#sidebar').getBoundingClientRect().right;
      return { right, main: document.querySelector('#main').getBoundingClientRect().left,
        search: document.querySelector('#product-search').getBoundingClientRect().left,
        toggle: document.querySelector('.product-toggle-track').getBoundingClientRect().left };
    });
    for (const key of ['main', 'search', 'toggle']) assert.ok(geometry[key] >= geometry.right - 1, `${key} is clear of the expanded sidebar: ${JSON.stringify(geometry)}`);
  }
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/products-${width}-${colorScheme}-active.png`, fullPage: true, animations: 'disabled' });
  const loaded = async action => {
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/seller/products' && response.request().method() === 'GET', { timeout: 4000 }).catch(error => { throw new Error(error.message + JSON.stringify(errors)); }), action()]);
    await page.waitForFunction(() => document.querySelector('#product-list')?.getAttribute('aria-busy') === 'false');
  };
  await toggle.focus();
  await loaded(() => page.keyboard.press('Space'));
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await cards.count(), 4);
  assert.equal(writes.length, 0, 'visibility, statistics and search are read-only');
  await page.screenshot({ path: `${artifacts}/products-${width}-${colorScheme}-all.png`, fullPage: true, animations: 'disabled' });
  await page.locator(`[data-product-id="${inactive.id}"] input[type=checkbox]`).check();
  await loaded(() => page.locator('.product-toggle-track').click());
  assert.equal(await page.locator('.product-bulk').isVisible(), false, 'visibility changes clear bulk selection');
  await page.locator('#product-search').fill('Hidden');
  await loaded(() => page.locator('#product-search').press('Enter'));
  assert.equal(await cards.count(), 0);
  await loaded(() => page.locator('.product-toggle-track').click());
  assert.equal(await cards.count(), 1);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#product-export').click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  assert.match(readFileSync(await download.path(), 'utf8'), /HIDDEN,Hidden product/);
  await page.locator('#product-search').fill('Unsubmitted text');
  const unchangedDownloadPromise = page.waitForEvent('download'); await page.locator('#product-export').click();
  assert.match(readFileSync(await (await unchangedDownloadPromise).path(), 'utf8'), /HIDDEN,Hidden product/, 'CSV uses applied search, not an unsubmitted draft');
  await page.locator('#product-search').fill('');
  await loaded(() => page.locator('#product-search').press('Enter'));
  await loaded(() => page.locator('#product-filter-category').selectOption('Other category'));
  assert.equal(await cards.count(), 1);
  await loaded(() => page.locator('#product-filter-stock').selectOption('in-stock'));
  assert.equal(await cards.count(), 0);
  await loaded(() => page.locator('#product-filter-stock').selectOption(''));
  await loaded(() => page.locator('#product-filter-category').selectOption(''));
  await loaded(() => page.locator('#product-filter-sort').selectOption('name'));
  assert.equal(await cards.first().locator('h3').textContent(), 'Example item');
  // A failed filter request must restore both the accepted records and the switch.
  await page.route('**/api/v1/seller/products?**', route => route.abort(), { times: 1 });
  await page.locator('.product-toggle-track').click();
  await page.getByText('Connection failed. Try again.', { exact: true }).waitFor().catch(async () => {
    await page.waitForFunction(() => document.querySelector('#product-list')?.getAttribute('aria-busy') === 'false');
  });
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await cards.count(), 4);
  await loaded(() => page.locator('.product-toggle-track').click());
  const activeCard = page.locator(`[data-product-id="${f.product.id}"]`);
  await activeCard.locator('[data-action=toggle]').click();
  await page.locator('.product-filter-undo button').waitFor();
  assert.equal(await activeCard.count(), 0, 'deactivation removes the row from Active while Undo remains reachable');
  assert.equal(await page.locator('[data-stat=active]').textContent(), '2');
  await page.locator('.product-filter-undo button').click();
  await activeCard.waitFor();
  assert.equal(await page.locator('[data-stat=active]').textContent(), '3');
  if (width === 1440 && colorScheme === 'light') {
    for (let i = 0; i < 25; i++) await make({ sku: `PAGE-${i}`, name: `Page product ${String(i).padStart(2, '0')}` });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#product-list')?.getAttribute('aria-busy') === 'false');
    assert.equal(await cards.count(), 24);
    await loaded(() => page.locator('#product-more').click());
    assert.equal(await cards.count(), 28);
    assert.equal(await page.locator('#product-more').isVisible(), false);
    assert.equal(new Set(await cards.evaluateAll(elements => elements.map(element => element.dataset.productId))).size, 28);
  }
  assert.deepEqual(errors, []);
});
