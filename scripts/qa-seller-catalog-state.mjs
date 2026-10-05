import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { useWorkerIngress } from '../test/browser/worker-harness.mjs';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/seller-catalog-state');
mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const paths = ['public/seller/app.js', 'public/seller/products.js', 'public/seller/settings.js',
'public/shop/app.js', 'public/shop/product-detail.js', 'src/products.js', 'src/settings.js', 'src/app.js', 'src/worker.js'];
const hashes = () => Object.fromEntries(paths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const report = { sourceHead: head, sourceHashes: hashes(), gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  versions: Object.fromEntries(['shop', 'seller'].map((surface) => [surface, /v\d+/.exec(readFileSync(`public/${surface}/version.js`, 'utf8'))[0]])),
  scope: 'Criteria49/56 only;390/1280; actual UI and Worker/API; fictional disposable SQLite; one cached browser worker',
  categoryContract: 'docs/API.md: deactivation prevents new assignments, does not delete/hide already-assigned products',
  cases: [], stateEvidence: [], pageErrors: [], externalRequests: [], unexpectedDialogs: [] };
const browser = await chromium.launch({ headless: true });report.browser = browser.version();
let app, context, temp, width, stage;
const checked = async (id, label, fn) => {
  stage = `#${id} ${label}`;
  try {const evidence = await fn();report.cases.push({ id, label, width, status: 'PASS', evidence });console.log(`PASS #${id}/${width} ${label}`);}
  catch (error) {report.cases.push({ id, label, width, status: 'FAIL', error: error.message });throw error;}
};
try {
  for (width of [390, 1280]) {
    temp = mkdtempSync(join(tmpdir(), 'online-shopping-catalog-state-qa-'));
    const config = { dbPath: join(temp, 'fictional.db'), shopMode: 'manual', username: 'synthetic_catalog_state',
      password: randomUUID() + randomUUID(), production: false, publicOrigin: null };
    app = await createApp(config);const gateway = await useWorkerIngress(app, config);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const login = await fetch(origin + '/api/v1/seller/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: config.username, password: config.password }) });
    assert.equal(login.status, 200);const cookie = login.headers.get('set-cookie').split(';')[0],csrf = (await login.json()).csrfToken;
    const api = async (method, path, body) => {
      const response = await fetch(origin + path, { method, headers: { origin, cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await api('POST', '/api/v1/seller/categories', { code: 'BASE', label: 'Fictional Base' })).status, 201);
    const imageDataUrl = 'data:image/png;base64,' + readFileSync('public/shop/icons/icon-192.png').toString('base64');
    const create = async (tag, active, priceMinor) => {
      const r = await api('POST', '/api/v1/seller/products', { sku: `STATE-${width}-${tag}`, name: 'Fictional ' + tag,
        description: 'Synthetic catalog state fixture', category: 'BASE', priceMinor, active, imageDataUrl });
      assert.equal(r.status, 201);return r.data;
    };
    const alpha = await create('Alpha', true, 1200),beta = await create('Beta', false, 1300);
    const domain = async () => Object.fromEntries(await Promise.all(await Promise.all(['shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency', 'order_sequence'].map(async (table) => [table, await app.database.all('SELECT * FROM ' + table)]))));
    const initialDomain = await domain();
    const products = async () => (await app.database.all('SELECT id,sku,name,description,category,price_minor,currency,active,updated_at,image_mime,image_data FROM product ORDER BY id')).map((row) => {
      const { image_data, ...rest } = row;return { ...rest, imageSHA256: image_data ? createHash('sha256').update(image_data).digest('hex') : null };
    });
    const productRow = async (id) => (await products()).find((row) => row.id === id);
    const unchangedMetadata = (before, after) => {
      const stable = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !['active', 'updated_at'].includes(key)));
      assert.deepEqual(stable(after), stable(before));
    };
    const categories = async () => await app.database.all("SELECT code,label,active FROM general_code WHERE type='PRODUCT_CATEGORY' ORDER BY code");
    context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', (route) => {if (!route.request().url().startsWith(origin + '/')) {report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
    const attach = (page, name) => {
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => report.pageErrors.push({ width, stage, name, error: error.message }));
      page.on('dialog', async (dialog) => {report.unexpectedDialogs.push({ width, stage, name, type: dialog.type(), message: dialog.message() });await dialog.dismiss();});
    };
    const seller = await context.newPage(),customer = await context.newPage();attach(seller, 'seller');attach(customer, 'customer');
    await seller.goto(origin + '/seller/#products');await seller.locator('#username').fill(config.username);await seller.locator('#password').fill(config.password);
    await seller.locator('#login-form').evaluate((form) => form.requestSubmit());await seller.locator('#workspace').waitFor({ state: 'visible' });
    const card = (item, page = seller) => page.locator(`.product-card[data-product-id="${item.id}"]`);
    const listReady = async (page = seller) => {await page.locator('#product-list').waitFor({ state: 'visible' });await card(alpha, page).waitFor();await card(beta, page).waitFor();};
    const stateReady = async (item, active, page = seller) => {await page.waitForFunction(({ id, active }) => document.querySelector(`.product-card[data-product-id="${id}"] .product-status-chip`)?.textContent === (active ? 'Active' : 'Inactive'), { id: item.id, active });};
    const shot = (page, label) => page.screenshot({ path: out + `/${label}-${width}.png`, fullPage: true });
    const mutation = async (page, path, control) => {
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === path && ['POST', 'PATCH'].includes(r.request().method()));
      await control.click();const actual = await response;const body = await actual.json();assert.ok(actual.ok(), JSON.stringify({ status: actual.status(), body }));
      return { status: actual.status(), request: actual.request().postDataJSON(), body };
    };
    const toggle = async (item, active, page = seller) => {
      const result = await mutation(page, '/api/v1/seller/products/' + item.id, card(item, page).locator('[data-action=toggle]'));
      assert.deepEqual(result.request, { active });await stateReady(item, active, page);assert.equal((await productRow(item.id)).active, Number(active));
      return result;
    };
    const undo = async (item, active) => {
      const result = await mutation(seller, '/api/v1/seller/products/' + item.id, card(item).locator('[data-action=undo]'));
      assert.deepEqual(result.request, { active });await stateReady(item, active);assert.equal(await card(item).locator('[data-action=undo]').count(), 0);
      await seller.waitForFunction((id) => document.activeElement?.dataset.action === 'toggle' && document.activeElement.closest('.product-card')?.dataset.productId === id, item.id);
      return result;
    };
    const publicState = async (expected, label = 'Fictional Base') => {
      if (!customer.url().startsWith(origin + '/')) await customer.goto(origin + '/shop/#catalog');else
      {
        if (await customer.locator('#product-view').isVisible()) await customer.locator('.product-back').click();
        await customer.locator(width === 390 ? '#mobile-navigation a[href="#catalog"]' : '.shop-topbar .brand').click();
      }
      await customer.waitForFunction((n) => document.querySelector('#catalog-grid')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.catalog-card').length === n, expected.length);
      const ids = await customer.locator('.product-name-link').evaluateAll((links) => links.map((a) => a.dataset.productId));assert.deepEqual(ids.sort(), expected.map((p) => p.id).sort());
      const r = await api('GET', '/api/v1/products');assert.equal(r.status, 200);assert.deepEqual(r.data.items.map((p) => p.id).sort(), expected.map((p) => p.id).sort());
      assert.deepEqual(r.data.categories, expected.length ? [label] : []);return { ids, APIIDs: r.data.items.map((p) => p.id), categories: r.data.categories };
    };
    const sellerNav = async (view) => {
      if (width === 390) await seller.locator('#open-menu').click();
      await seller.locator(`.nav-item[data-view="${view}"]`).click();
      await seller.waitForFunction((view) => location.hash === '#' + view, view);
      if (view === 'products') await listReady();else await seller.locator('#category-create').waitFor();
    };
    const categoryForm = (code) => seller.locator('#category-list .settings-row').filter({ has: seller.locator('strong', { hasText: code }) });
    const createCategory = async (code, label) => {
      await seller.locator('#category-create [name=code]').fill(code);await seller.locator('#category-create [name=label]').fill(label);
      const result = await mutation(seller, '/api/v1/seller/categories', seller.locator('#category-create [type=submit]'));
      assert.equal(result.status, 201);await categoryForm(code).waitFor();return result;
    };
    const changeCategory = async (code, label, active) => {
      const row = categoryForm(code);await row.locator('input:not([type=checkbox])').fill(label);await row.locator('[type=checkbox]').setChecked(active);
      const result = await mutation(seller, '/api/v1/seller/categories/' + code, row.locator('[type=submit]'));
      await seller.waitForFunction(({ code, label, active }) => [...document.querySelectorAll('#category-list .settings-row')].some((row) => row.querySelector('strong').textContent === code && row.querySelector('input:not([type=checkbox])').value === label && row.querySelector('[type=checkbox]').checked === active && !row.querySelector('[type=submit]').disabled), { code, label, active });
      return result;
    };
    const openEditor = async (item) => {
      await card(item).locator('.product-card-actions button').first().click();
      await seller.locator('#product-form').waitFor({ state: 'visible' });
      await seller.waitForFunction((sku) => document.querySelector('#product-form [name=sku]').value === sku && !document.querySelector('#product-save').disabled, item.sku);
    };
    await listReady();

    await checked(49, 'Disable and Undo active product change only availability; public catalog/detail/image enforce latest state', async () => {
      const before = await productRow(alpha.id),other = await productRow(beta.id);const disabled = await toggle(alpha, false);
      assert.equal((await api('GET', '/api/v1/products/' + alpha.id)).status, 404);
      assert.equal((await fetch(origin + '/api/v1/products/' + alpha.id + '/image')).status, 404);
      const unavailable = await publicState([]);assert.equal(await card(alpha).locator('[data-action=undo]').count(), 1);await shot(seller, 'product-disabled-undo');
      const restored = await undo(alpha, true);unchangedMetadata(before, await productRow(alpha.id));assert.deepEqual(await productRow(beta.id), other);
      const available = await publicState([alpha]);assert.equal((await api('GET', '/api/v1/products/' + alpha.id)).status, 200);assert.equal((await fetch(origin + '/api/v1/products/' + alpha.id + '/image')).status, 200);
      assert.deepEqual(await domain(), initialDomain);await shot(customer, 'customer-product-restored');return { disabled, restored, unavailable, available, otherProductUnchanged: true, metadataAndImageUnchanged: true };
    });
    await checked(49, 'Enable and Undo inactive product restores prior inactive state and customer visibility', async () => {
      const before = await productRow(beta.id);const enabled = await toggle(beta, true);const visible = await publicState([alpha, beta]);
      assert.equal((await api('GET', '/api/v1/products/' + beta.id)).status, 200);await shot(seller, 'product-enabled-undo');
      const restored = await undo(beta, false);const hidden = await publicState([alpha]);assert.equal((await api('GET', '/api/v1/products/' + beta.id)).status, 404);
      unchangedMetadata(before, await productRow(beta.id));assert.deepEqual(await domain(), initialDomain);return { enabled, restored, visible, hidden, ownPriorStateRestored: true };
    });
    await checked(49, 'Availability persists Seller/Customer reload; Undo UI is current-page state only', async () => {
      await toggle(alpha, false);await seller.reload();await listReady();await stateReady(alpha, false);assert.equal(await card(alpha).locator('[data-action=undo]').count(), 0);await publicState([]);
      await toggle(alpha, true);await seller.reload();await listReady();await stateReady(alpha, true);await publicState([alpha]);
      await shot(seller, 'availability-persisted-reload');return { disabledReload: false, enabledReload: true, persistedInAPIAndSQLite: true, UndoAfterReload: 'Not persisted; observed existing page-local behavior' };
    });
    await checked(49, 'Undo rereads current availability and refuses to overwrite another Seller page change', async () => {
      await toggle(alpha, false);const otherPage = await context.newPage();attach(otherPage, 'second-seller');await otherPage.goto(origin + '/seller/#products');await listReady(otherPage);
      await toggle(alpha, true, otherPage);const start = gateway.records.length;
      await card(alpha).locator('[data-action=undo]').click();await stateReady(alpha, true);
      await seller.waitForFunction(() => document.querySelector('#product-status').textContent.includes('changed again'));
      const requests = gateway.records.slice(start);assert.equal(requests.filter((r) => r.method === 'PATCH').length, 0);
      assert.ok(requests.some((r) => r.method === 'GET' && r.path === '/api/v1/seller/products/' + alpha.id && r.status === 200));
      assert.equal(await card(alpha).locator('[data-action=undo]').count(), 0);assert.equal((await productRow(alpha.id)).active, 1);await publicState([alpha]);
      await shot(seller, 'undo-latest-state-refused');await otherPage.close();return { latestActive: true, staleUndoPATCHes: 0, latestGETObserved: true, noOverwrite: true, limit: 'Boolean precheck only; no atomic read/write or ABA-race certification' };
    });

    await sellerNav('categories');
    await checked(56, 'Category UI creates, edits display label and reloads immutable code with exact API/database state', async () => {
      const before = await products();const created = await createCategory('MANAGED', 'Fictional Managed');await createCategory('UNUSED', 'Fictional Unused');
      const edited = await changeCategory('MANAGED', 'Fictional Managed revised', true);const saved = await categories();
      await seller.reload();await seller.locator('#category-create').waitFor();await categoryForm('MANAGED').waitFor();
      assert.equal(await categoryForm('MANAGED').locator('strong').innerText(), 'MANAGED');assert.equal(await categoryForm('MANAGED').locator('input:not([type=checkbox])').inputValue(), 'Fictional Managed revised');
      assert.deepEqual(await categories(), saved);const apiCategories = await api('GET', '/api/v1/seller/categories');assert.equal(apiCategories.status, 200);assert.equal(apiCategories.data.items.find((c) => c.code === 'MANAGED').label, 'Fictional Managed revised');
      assert.deepEqual(await products(), before);assert.deepEqual(await domain(), initialDomain);await shot(seller, 'categories-create-edit-reload');return { created, edited, saved, codeImmutable: true, productsAndOrdersUnchanged: true };
    });
    await checked(56, 'Unused-category disable persists and excludes new-product options without affecting current products', async () => {
      const before = await products();await changeCategory('UNUSED', 'Fictional Unused', false);await seller.reload();await seller.locator('#category-create').waitFor();await categoryForm('UNUSED').waitFor();
      assert.equal(await categoryForm('UNUSED').locator('[type=checkbox]').isChecked(), false);assert.equal((await categories()).find((c) => c.code === 'UNUSED').active, 0);
      await sellerNav('products');await seller.locator('#product-new').click();await seller.locator('#product-form').waitFor({ state: 'visible' });
      await seller.waitForFunction(() => document.querySelector('#product-form [name=category]').options.length >= 2);
      const choices = await seller.locator('#product-form [name=category] option').evaluateAll((options) => options.map((o) => o.value));assert.ok(!choices.includes('UNUSED'));assert.ok(choices.includes('BASE') && choices.includes('MANAGED'));
      await seller.locator('#product-cancel').click();await listReady();await publicState([alpha]);assert.deepEqual(await products(), before);assert.deepEqual(await domain(), initialDomain);
      await shot(seller, 'unused-category-excluded');return { inactiveCode: 'UNUSED', newProductOptions: choices, currentProductsUnchanged: true, publicCatalogUnchanged: true };
    });
    await checked(56, 'Referenced-category deactivate preserves products/customer listing but rejects new assignments', async () => {
      await openEditor(alpha);await seller.locator('#product-form [name=category]').selectOption('MANAGED');
      await mutation(seller, '/api/v1/seller/products/' + alpha.id, seller.locator('#product-save'));
      await seller.waitForFunction(() => document.querySelector('#product-form-success').textContent === 'Product saved.');assert.equal((await productRow(alpha.id)).category, 'MANAGED');
      await sellerNav('categories');await changeCategory('MANAGED', 'Fictional Managed current', false);
      const before = await products();await seller.reload();await seller.locator('#category-create').waitFor();await categoryForm('MANAGED').waitFor();assert.equal(await categoryForm('MANAGED').locator('[type=checkbox]').isChecked(), false);
      const publicCatalog = await publicState([alpha], 'Fictional Managed current');const detail = await api('GET', '/api/v1/products/' + alpha.id);assert.equal(detail.status, 200);assert.equal(detail.data.category, 'Fictional Managed current');
      const oldLabel = await api('GET', '/api/v1/products?category=' + encodeURIComponent('Fictional Managed revised'));assert.deepEqual(oldLabel.data.items, []);
      const newLabel = await api('GET', '/api/v1/products?category=' + encodeURIComponent('Fictional Managed current'));assert.deepEqual(newLabel.data.items.map((p) => p.id), [alpha.id]);
      await shot(customer, 'customer-referenced-inactive-category');
      await customer.locator(`.product-name-link[data-product-id="${alpha.id}"]`).click();await customer.locator('#product-view').waitFor({ state: 'visible' });await customer.locator('.product-add').waitFor();
      assert.match(await customer.locator('#product-view').innerText(), /Fictional Managed current/);assert.equal(await customer.locator('.product-add').isDisabled(), false);assert.equal(await customer.locator('.product-buy').isDisabled(), false);
      await shot(customer, 'customer-detail-inactive-category');
      await sellerNav('products');await seller.locator('#product-new').click();await seller.locator('#product-form').waitFor({ state: 'visible' });
      await seller.waitForFunction(() => document.querySelector('#product-form [name=category]').options.length >= 2);
      const newChoices = await seller.locator('#product-form [name=category] option').evaluateAll((options) => options.map((o) => o.value));assert.ok(!newChoices.includes('MANAGED') && !newChoices.includes('UNUSED'));
      await seller.locator('#product-cancel').click();await listReady();await openEditor(alpha);assert.equal(await seller.locator('#product-form [name=category]').inputValue(), 'MANAGED');
      assert.equal(await seller.locator('#product-form [name=category] option[value=MANAGED]').count(), 1);await shot(seller, 'existing-product-keeps-inactive-category');await seller.locator('#product-cancel').click();await listReady();
      const createRejected = await api('POST', '/api/v1/seller/products', { sku: `INACTIVE-ASSIGN-${width}`, name: 'Fictional rejected assignment', description: 'Synthetic rejected assignment', category: 'MANAGED', priceMinor: 1400, active: false });
      const moveRejected = await api('PATCH', '/api/v1/seller/products/' + beta.id, { category: 'MANAGED' });
      assert.equal(createRejected.status, 400);assert.equal(createRejected.data.error.field, 'category');assert.equal(moveRejected.status, 400);assert.equal(moveRejected.data.error.field, 'category');
      assert.deepEqual(await products(), before);assert.deepEqual(await domain(), initialDomain);return { inactiveReferencedCode: 'MANAGED', publicCatalog, existingProductStillActive: true, newProductChoices: newChoices, currentEditorKeepsAssignedCode: true, createRejected, moveRejected, noCascadeOrOrderWrites: true, policySource: 'docs/API.md managed-category contract' };
    });
    await checked(56, 'Category reactivation/reload restores new assignments while preserving original product data', async () => {
      const before = await products();await sellerNav('categories');await changeCategory('MANAGED', 'Fictional Managed current', true);await seller.reload();await seller.locator('#category-create').waitFor();await categoryForm('MANAGED').waitFor();
      assert.equal(await categoryForm('MANAGED').locator('[type=checkbox]').isChecked(), true);await sellerNav('products');await seller.locator('#product-new').click();await seller.locator('#product-form').waitFor({ state: 'visible' });
      await seller.waitForFunction(() => document.querySelector('#product-form [name=category] option[value=MANAGED]'));
      await seller.locator('#product-cancel').click();await listReady();
      const allowed = await api('POST', '/api/v1/seller/products', { sku: `RESTORED-ASSIGN-${width}`, name: 'Fictional accepted assignment', description: 'Synthetic accepted assignment', category: 'MANAGED', priceMinor: 1400, active: false });assert.equal(allowed.status, 201);
      assert.deepEqual((await products()).filter((p) => p.id !== allowed.data.id), before);assert.deepEqual(await domain(), initialDomain);await publicState([alpha], 'Fictional Managed current');
      await shot(customer, 'customer-category-reactivated');return { reactivatedCode: 'MANAGED', createHTTP: 201, newProductActive: false, existingProductsUnchanged: true, publicCatalogStable: true };
    });
    report.stateEvidence.push({ width, finalProducts: await products(), finalCategories: await categories(), orderDomainBefore: initialDomain, orderDomainAfter: await domain(), workerRequests: gateway.records });
    await context.close();context = null;await app.close();app = null;rmSync(temp, { recursive: true, force: true });temp = null;
  }
  assert.equal(report.pageErrors.length, 0);assert.equal(report.externalRequests.length, 0);assert.equal(report.unexpectedDialogs.length, 0);assert.deepEqual(hashes(), report.sourceHashes);
} catch (error) {process.exitCode = 1;console.error(error.stack);} finally
{
  report.applicationHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();report.sourceHashesAfter = hashes();
  report.criterionStatus = [49, 56].map((id) => {const cases = report.cases.filter((c) => c.id === id);return { id, status: cases.length === 8 && cases.every((c) => c.status === 'PASS') ? 'PASS' : cases.some((c) => c.status === 'FAIL') ? 'FAIL' : 'UNVERIFIED' };});
  writeFileSync(out + '/results.json', JSON.stringify(report, null, 2));console.log(JSON.stringify({ head, criteria: report.criterionStatus, cases: report.cases.map(({ id, width, status, error }) => ({ id, width, status, error })) }));
  if (context) await context.close();await browser.close();if (app) await app.close();if (temp) rmSync(temp, { recursive: true, force: true });
}
