import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/products-layout-browser';
for (const width of [390, 768, 1280, 1920]) for (const colorScheme of ['light', 'dark']) test(`Products status/filter/lifecycle browser: ${width}px ${colorScheme}`, { skip: !modulePath }, async t => {
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
  const cards = page.locator('#product-list > .product-card');
  const ready = () => page.waitForFunction(() => document.querySelector('#product-list')?.getAttribute('aria-busy') === 'false');
  const tab = status => page.locator(`[data-catalog-status=${status}]`);
  const loaded = async action => {
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/seller/products' && response.request().method() === 'GET'), action()]); await ready();
  };
  const downloadCsv = async () => { const waiting = page.waitForEvent('download'); await page.locator('#product-export').click(); const download = await waiting; assert.equal(await download.failure(), null); return readFileSync(await download.path(), 'utf8'); };
  const confirmToggle = async card => { await card.locator('.product-more-menu summary').click(); await card.locator('[data-action=toggle]').click(); await page.locator('dialog[open]').getByRole('button', { name: 'Deactivate', exact: true }).click(); };
  await page.goto(`${f.origin}/seller/#products`);
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter'); await ready().catch(error => { throw new Error(error.message + JSON.stringify(errors)); });
  if (width > 1024) await page.waitForFunction(() => document.querySelector('#main').getBoundingClientRect().left >= document.querySelector('#sidebar').getBoundingClientRect().right - 1);
  assert.equal(await tab('active').getAttribute('aria-pressed'), 'true'); assert.equal(await cards.count(), 3);
  assert.equal(await page.locator('[data-stat=active]').textContent(), '3'); assert.equal(await page.locator('[data-stat=inactive]').textContent(), '1'); assert.equal(await page.locator('[data-stat=total]').textContent(), '4');
  assert.equal(await page.locator('.product-stats, #product-include-inactive').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow');
  const geometry = await page.evaluate(() => {
    const rect = node => node.getBoundingClientRect();
    return [...document.querySelectorAll('.product-card-actions')].map(actions => {
      const edit = rect(actions.querySelector('button')), more = actions.querySelector('summary');
      return !more || edit.right <= rect(more).left + 1 || edit.bottom <= rect(more).top + 1;
    });
  }); assert.ok(geometry.every(Boolean), 'Edit and More actions never overlap');
  if (width >= 1280) assert.ok(await page.evaluate(() => {
    const filters = [...document.querySelectorAll('.product-list-filters select')].map(el => el.getBoundingClientRect().top);
    return Math.max(...filters) - Math.min(...filters) < 2;
  }), 'desktop filters stay together on one row');
  mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: `${artifacts}/products-${width}-${colorScheme}-active.png`, fullPage: true, animations: 'disabled' });
  await tab('all').focus(); await loaded(() => page.keyboard.press('Space')); assert.equal(await cards.count(), 4); assert.equal(writes.length, 0);
  await page.locator(`[data-product-id="${inactive.id}"] input[type=checkbox]`).check();
  await loaded(() => tab('inactive').click()); assert.equal(await cards.count(), 1); assert.equal(await page.locator('.product-bulk').isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.get('productStatus'), 'inactive');
  assert.match(await downloadCsv(), /HIDDEN,Hidden product/); assert.doesNotMatch(await downloadCsv(), /MIX-A|MIX-B/);
  await page.locator('#product-search').fill('Hidden'); await loaded(() => page.locator('#product-search').press('Enter'));
  await page.locator('#product-search').fill('Unsubmitted text'); assert.match(await downloadCsv(), /HIDDEN,Hidden product/);
  await loaded(() => page.locator('#product-filter-stock').selectOption('out-of-stock')); assert.equal(await cards.count(), 1, 'filter change does not submit draft search');
  await page.reload(); await ready(); assert.equal(await page.locator('#product-search').inputValue(), 'Hidden'); assert.equal(await tab('inactive').getAttribute('aria-pressed'), 'true');
  await loaded(() => page.locator('#product-clear-filters').click()); assert.equal(await cards.count(), 3);
  await loaded(() => tab('all').click()); await loaded(() => page.locator('#product-filter-category').selectOption('Other category')); assert.equal(await cards.count(), 1);
  await loaded(() => page.locator('#product-filter-stock').selectOption('in-stock')); assert.equal(await cards.count(), 0);
  assert.match(await page.locator('.product-export-scope').innerText(), /0 matching products/);
  await loaded(() => page.locator('#product-filter-stock').selectOption(''));
  await page.route('**/api/v1/seller/products?**', route => route.abort(), { times: 1 }); await tab('inactive').click(); await page.locator('.product-list-recovery button[data-i18n=retry]').waitFor(); await ready();
  assert.equal(await tab('all').getAttribute('aria-pressed'), 'true'); assert.equal(await cards.count(), 1); assert.match(await downloadCsv(), /OTHER,Other product/); assert.doesNotMatch(await downloadCsv(), /HIDDEN/);
  await loaded(() => page.locator('#product-clear-filters').click());
  const activeCard = page.locator(`[data-product-id="${f.product.id}"]`);
  // Cancel is read-only; successful confirmation is the only mutation trigger.
  await activeCard.locator('summary').click(); await activeCard.locator('[data-action=toggle]').click(); await page.locator('dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' }); assert.equal(writes.length, 0);
  await loaded(() => confirmToggle(activeCard)); assert.equal(await activeCard.count(), 0); assert.equal(await page.locator('[data-stat=active]').textContent(), '2');
  await loaded(() => page.locator('.product-filter-undo button').click()); assert.equal(await activeCard.count(), 1); assert.equal(await page.locator('[data-stat=active]').textContent(), '3');
  await loaded(() => tab('inactive').click()); const hiddenCard = page.locator(`[data-product-id="${inactive.id}"]`);
  await hiddenCard.locator('summary').click(); await loaded(() => hiddenCard.locator('[data-action=toggle]').click()); assert.equal(await cards.count(), 0);
  await loaded(() => page.locator('.product-filter-undo button').click()); assert.equal(await hiddenCard.count(), 1); assert.equal(await page.locator('[data-stat=inactive]').textContent(), '1');
  await page.screenshot({ path: `${artifacts}/products-${width}-${colorScheme}-inactive.png`, fullPage: true, animations: 'disabled' });
  await hiddenCard.locator('.product-image-entry').click(); await page.waitForFunction(() => document.querySelector('#product-editor-tab-images')?.getAttribute('aria-selected') === 'true');
  await page.locator('#product-back').click(); await ready(); assert.equal(await tab('inactive').getAttribute('aria-pressed'), 'true');
  if (width === 1280 && colorScheme === 'light') {
    for (let i = 0; i < 25; i++) await make({ sku: `PAGE-${i}`, name: `Page product ${String(i).padStart(2, '0')}` });
    await loaded(() => page.locator('#product-clear-filters').click()); assert.equal(await cards.count(), 24);
    await cards.first().locator('input[type=checkbox]').check(); await loaded(() => page.locator('#product-more').click()); assert.equal(await cards.count(), 28); assert.equal(await page.locator('.product-bulk').isVisible(), false, 'page changes clear selection');
    assert.equal(new Set(await cards.evaluateAll(elements => elements.map(element => element.dataset.productId))).size, 28);
    await page.reload(); await ready(); const csv = await downloadCsv(); assert.match(csv, /PAGE-24/); assert.equal(await cards.count(), 24, 'export spans pages without loading them');
    const selectAll = page.locator('.product-select-all input'); await selectAll.check(); assert.equal(await page.locator('.product-bulk').isVisible(), true); await cards.first().locator('input[type=checkbox]').uncheck(); assert.equal(await selectAll.evaluate(el => el.indeterminate), true);
    await page.locator('.product-bulk').getByRole('button', { name: 'Clear selection', exact: true }).click();
    await page.locator('#product-search').fill('SELLER-ITEM'); await loaded(() => page.locator('#product-search').press('Enter'));
    // Failed write keeps state. A saved write followed by failed refresh is reported separately.
    await page.route(`**/api/v1/seller/products/${f.product.id}`, route => route.request().method() === 'PATCH' ? route.abort() : route.continue(), { times: 1 });
    await confirmToggle(activeCard); await page.locator('#product-status').filter({ hasText: 'Could not save product' }).waitFor();
    assert.equal(Number((await f.app.database.get('SELECT active FROM product WHERE id = ?', f.product.id)).active), 1);
    assert.equal(await activeCard.count(), 1);
    await page.route('**/api/v1/seller/products?**', route => route.abort(), { times: 1 });
    await confirmToggle(activeCard); await page.locator('#product-status').filter({ hasText: 'Status saved, but the list could not refresh' }).waitFor();
    assert.equal(Number((await f.app.database.get('SELECT active FROM product WHERE id = ?', f.product.id)).active), 0);
    await loaded(() => page.locator('.product-list-recovery button[data-i18n=retry]').click());
    await loaded(() => page.locator('.product-filter-undo button').click()); assert.equal(await activeCard.count(), 1);
    await activeCard.locator('input[type=checkbox]').check();
    await page.locator('.product-bulk').getByRole('button', { name: 'Deactivate selected', exact: true }).click();
    await loaded(() => page.locator('dialog[open]').getByRole('button', { name: 'Deactivate', exact: true }).click());
    assert.equal(await activeCard.count(), 0); assert.match(await page.locator('.product-bulk').innerText(), /1 changed/);
    await loaded(() => tab('inactive').click()); await activeCard.locator('input[type=checkbox]').check();
    await loaded(() => page.locator('.product-bulk').getByRole('button', { name: 'Activate selected', exact: true }).click());
    assert.equal(Number((await f.app.database.get('SELECT active FROM product WHERE id = ?', f.product.id)).active), 1);

  }
  assert.deepEqual(errors, []);
});
