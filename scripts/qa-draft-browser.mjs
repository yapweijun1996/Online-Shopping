import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '/Users/yapweijun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const source = resolve(process.env.QA_SOURCE_ROOT || '.');
const { createApp } = await import(pathToFileURL(source + '/src/server.js'));
const { createProduct, addGalleryImage } = await import(pathToFileURL(source + '/src/products.js'));
const out = resolve(process.env.QA_DRAFT_OUT || 'output/qa/followup/draft-green');mkdirSync(out, { recursive: true });
const app = await createApp({ dbPath: ':memory:', shopMode: 'public-demo', demoRevision: 'qa-draft', username: 'draft_qa', password: 'SyntheticDraftOnly48125', production: false });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const png = readFileSync(source + '/public/shop/icons/icon-192.png');
const image = (n) => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(String(n))]).toString('base64');
const fixture = async (sku) => await createProduct(app.database, { sku, name: 'Fictional draft fixture', description: 'Synthetic original description', category: 'TRAVEL', priceMinor: 900, active: true, imageDataUrl: image(0) });
const draft = await fixture('QA-DRAFT'),race = await fixture('QA-RACE');addGalleryImage(app.database, draft.id, image(1));
const browser = await chromium.launch({ headless: true });const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();const report = { source, cases: [], pageErrors: [], externalRequests: [], evidence: {} };
page.on('pageerror', (error) => report.pageErrors.push(error.message));
await context.route('**/*', (route) => {if (!route.request().url().startsWith(origin + '/')) {report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
const checked = async (name, fn) => {try {await fn();report.cases.push({ name, status: 'PASS' });} catch (error) {report.cases.push({ name, status: 'FAIL', error: error.message });}};
const open = async (id) => {await page.goto(origin + '/seller/#products/' + id);await page.locator('#product-form').waitFor({ state: 'visible' });await page.waitForFunction(() => !document.querySelector('#product-form').hidden);};
const signature = () => page.evaluate(() => {const f = document.querySelector('#product-form');return { name: f.elements.name.value, description: f.elements.description.value, price: f.elements.price.value, active: f.elements.active.checked,
    gallery: [...document.querySelectorAll('.product-gallery-item')].map((x) => x.dataset.imageId), imageStatus: document.querySelector('#product-image-status').textContent };});
const stay = async () => {
  let dialogs = 0;const handler = (dialog) => {dialogs++;dialog.dismiss();};page.on('dialog', handler);
  await page.locator('#product-back').click();await page.waitForTimeout(120);page.off('dialog', handler);assert.equal(dialogs, 1, 'dirty draft must prompt before navigation');
};
try {
  await page.goto(origin + '/seller/');await page.locator('#username').fill('draft_qa');await page.locator('#password').fill('SyntheticDraftOnly48125');await page.locator('#login-form').evaluate((f) => f.requestSubmit());await page.locator('#workspace').waitFor({ state: 'visible' });
  await checked('400 image rejection preserves full metadata/gallery draft, dirty guard and intended fields on retry', async () => {
    await open(draft.id);await page.locator('.product-gallery-item').last().locator('[data-gallery-action="remove"]').click();await page.locator('#product-remove-image').click();
    await page.locator('[name="name"]').fill('Fictional intended name');await page.locator('[name="description"]').fill('Fictional intended description');await page.locator('[name="price"]').fill('45.67');await page.locator('[name="active"]').uncheck();
    const before = await signature(),url = origin + '/api/v1/seller/products/' + draft.id;
    await page.route(url, (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":{"code":"VALIDATION_ERROR","field":"imageDataUrl"}}' }) : route.continue());
    await page.locator('#product-save').click();await page.waitForFunction(() => Boolean(document.querySelector('#product-form-error').textContent));await page.waitForTimeout(100);
    const after = await signature();report.evidence.rejected400 = { before, after };assert.deepEqual(after, before);await stay();
    await page.screenshot({ path: out + '/validation-draft-retained.png', fullPage: true });await page.unroute(url);
    await page.locator('#product-save').click();await page.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');
    const row = await app.database.get('SELECT name, description, price_minor, active, image_data, gallery_layout_json FROM product WHERE id = ?', draft.id);
    assert.equal(row.name, before.name);assert.equal(row.description, before.description);assert.equal(row.price_minor, 4567);assert.equal(row.active, 0);assert.equal(row.image_data, null);assert.equal(row.gallery_layout_json, '[]');
    report.evidence.retry = { name: row.name, description: row.description, priceMinor: row.price_minor, active: Boolean(row.active), gallery: [] };
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await checked('409 actual stale revision keeps metadata draft and Stay/Discard guards without mutating server values', async () => {
    await open(draft.id);await page.locator('[name="name"]').fill('Fictional conflict draft');await page.locator('[name="price"]').fill('50.00');await page.locator('[name="active"]').check();
    const before = await signature();const row = await app.database.get('SELECT updated_at, price_minor, active FROM product WHERE id = ?', draft.id);
    await app.database.run('UPDATE product SET updated_at = ? WHERE id = ?', new Date(Date.parse(row.updated_at) + 1000).toISOString(), draft.id);
    const response = page.waitForResponse((r) => r.url().endsWith('/products/' + draft.id) && r.request().method() === 'PATCH');await page.locator('#product-save').click();assert.equal((await response).status(), 409);
    await page.waitForFunction(() => document.querySelector('#product-form-error')?.textContent.includes('product changed'));
    const after = await signature();assert.deepEqual(after, before);await stay();
    assert.equal((await app.database.get('SELECT price_minor FROM product WHERE id = ?', draft.id)).price_minor, row.price_minor);
    report.evidence.rejected409 = { before, after, serverPriceMinor: row.price_minor, serverActive: Boolean(row.active) };
    page.once('dialog', (dialog) => dialog.accept());await page.locator('#product-cancel').click();await page.locator('#product-list-view').waitFor({ state: 'visible' });
  });
  await checked('successful Save cannot classify later typed edits as clean after a delayed detail GET; retry persists every newer field', async () => {
    await open(race.id);await page.locator('[name="name"]').fill('Confirmed first edit');
    const url = origin + '/api/v1/seller/products/' + race.id;let release,heldGetCount = 0;
    await page.route(url, async (route) => {if (route.request().method() === 'GET') {heldGetCount++;await new Promise((resolve) => {release = resolve;});await route.continue();} else await route.continue();});
    const response = page.waitForResponse((r) => r.url() === url && r.request().method() === 'PATCH');await page.locator('#product-save').click();assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#product-form').hidden && document.querySelector('[name="name"]').value === 'Confirmed first edit');
    await page.locator('[name="name"]').fill('Typed after Save');await page.locator('[name="description"]').fill('Newer draft description');await page.locator('[name="price"]').fill('98.76');await page.locator('[name="active"]').uncheck();
    const before = await signature();await page.waitForTimeout(100);release?.();
    // The fixed editor completes without a detail GET. Typing then clears its
    // earlier success message, so only a genuinely held legacy GET owns a later
    // success signal. The draft and navigation postconditions are identical.
    if (heldGetCount) await page.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');else
    await page.waitForTimeout(100);
    const after = await signature();report.evidence.postSaveRace = { before, after, heldGetCount };assert.deepEqual(after, before);await stay();await page.unroute(url);
    await page.locator('#product-save').click();await page.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');
    const row = await app.database.get('SELECT name, description, price_minor, active FROM product WHERE id = ?', race.id);
    assert.equal(row.name, 'Typed after Save');assert.equal(row.description, 'Newer draft description');assert.equal(row.price_minor, 9876);assert.equal(row.active, 0);
    report.evidence.postSaveRetry = { ...row };
  });
} finally {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  writeFileSync(out + '/results.json', JSON.stringify(report, null, 2));console.log(JSON.stringify(report));
  if (report.cases.some((x) => x.status === 'FAIL') || report.externalRequests.length || report.pageErrors.length) process.exitCode = 1;
  await context.close();await browser.close();await app.close();
}
