import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/server.js';
import { listProducts, createProduct, addGalleryImage } from '../src/products.js';
import { chromium } from '/Users/yapweijun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { APP_VERSION as SHOP_VERSION } from '../public/shop/version.js';
import { APP_VERSION as SELLER_VERSION } from '../public/seller/version.js';

// One browser, fresh in-memory stores, fictional contacts and no provider calls.
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/followup/browser');mkdirSync(out, { recursive: true });
const config = { dbPath: ':memory:', shopMode: 'public-demo', demoRevision: 'qa-followup',
  username: 'synthetic_qa', password: 'SyntheticLocalOnly48125', production: false, publicOrigin: null };
const app = await createApp(config);
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const product = (await listProducts(app.database, new URLSearchParams('limit=100'))).items.find((x) => x.sku === 'DEMO-020');
const path = '/api/v1/seller/products/' + product.id;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const seller = await context.newPage(),customer = await context.newPage();
const report = { scope: 'Priority fixes only; synthetic in-memory SQLite and loopback origin', frozenBase: '46977c2670daad45369aefdd3aa68943e5ce595c', versions: { shop: SHOP_VERSION, seller: SELLER_VERSION },
  browser: browser.version(), cases: [], pageErrors: [], externalRequests: [], writes: [] };
const caseLimit = Number(process.env.QA_CASE_LIMIT || 100);
const checked = async (name, fn) => {if (report.cases.length >= caseLimit) throw new Error('CHECKPOINT_CASE_LIMIT');try {const detail = await fn();report.cases.push({ name, status: 'PASS', ...(detail ? { detail } : {}) });}
  catch (error) {report.cases.push({ name, status: 'FAIL', error: error.message });throw error;}};
for (const page of [seller, customer]) page.on('pageerror', (error) => report.pageErrors.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(),url = request.url();
  if (!url.startsWith(origin + '/') && !url.startsWith(pathToFileURL(out).href + '/')) {report.externalRequests.push(url);await route.abort();return;}
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) report.writes.push({ method: request.method(), path: new URL(url).pathname });
  await route.continue();
});
const files = Array.from({ length: 5 }, (_, n) => ({ name: `synthetic-${n}.png`, mimeType: 'image/png',
  buffer: Buffer.concat([readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)), Buffer.from(`fixture-${n}`)]) }));
const ids = async () => JSON.parse((await app.database.get('SELECT gallery_layout_json FROM product WHERE id = ?', product.id)).gallery_layout_json);
const formSave = async () => {
  const response = seller.waitForResponse((r) => r.url() === origin + path && r.request().method() === 'PATCH');
  await seller.locator('#product-save').click();assert.equal((await response).status(), 200);
  await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');
};
const openEditor = async () => {await seller.goto(origin + '/seller/#products/' + product.id);await seller.locator('#product-form').waitFor({ state: 'visible' });await seller.locator('.product-gallery-item').first().waitFor();};
const cleanText = (value) => value.replace(/DEMO[-_][A-Z0-9_-]+/gi, 'TECHNICAL_ID');
const noDemo = async (page) => assert.doesNotMatch(cleanText(await page.locator('body').innerText()), /demo|演示|示范|デモ|데모|สาธิต|เดโม/i);
try {
  await checked('Seller login and existing six-image gallery with read-only company currency', async () => {
    await seller.goto(origin + '/seller/');await seller.locator('#username').fill('synthetic_qa');await seller.locator('#password').fill('SyntheticLocalOnly48125');
    await seller.locator('#login-form').evaluate((form) => form.requestSubmit());await seller.locator('#workspace').waitFor({ state: 'visible' });
    await openEditor();assert.equal(await seller.locator('.product-gallery-item').count(), 6);
    assert.equal(await seller.locator('[name="currency"]').isEditable(), false);
    await seller.waitForFunction(() => {const img = document.querySelector('#product-image-preview');return img?.complete && img.naturalWidth > 0;});
    await noDemo(seller);await seller.screenshot({ path: out + '/seller-six-images-desktop.png', fullPage: true });
  });
  await checked('Add four images as a ten-image draft without writing; reject overflow and invalid file without losing draft', async () => {
    await seller.locator('[name="gallery"]').setInputFiles(files.slice(0, 4));
    await seller.waitForFunction(() => document.querySelectorAll('.product-gallery-item').length === 10);
    assert.equal((await app.database.get('SELECT count(*) n FROM product_gallery_image')).n, 0);
    await seller.locator('[name="gallery"]').setInputFiles([files[4]]);
    await seller.waitForFunction(() => document.querySelector('#product-form-error').textContent.includes('ten images'));
    assert.equal(await seller.locator('.product-gallery-item').count(), 10);
    await seller.locator('.product-gallery-item').last().locator('[data-gallery-action="remove"]').click();
    await seller.locator('[name="gallery"]').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic invalid upload') });
    await seller.waitForFunction(() => Boolean(document.querySelector('#product-form-error').textContent));
    assert.equal(await seller.locator('.product-gallery-item').count(), 9);
    await seller.locator('[name="gallery"]').setInputFiles([files[3]]);await seller.waitForFunction(() => document.querySelectorAll('.product-gallery-item').length === 10);
  });
  await checked('Reorder and set static primary; keyboard controls retain focus; repeated Save sends one atomic patch', async () => {
    const move = seller.locator('.product-gallery-item').last().locator('[data-gallery-action="earlier"]');await move.focus();await seller.keyboard.press('Enter');
    assert.equal(await seller.evaluate(() => document.activeElement?.closest('.product-gallery-item') !== null), true);
    await seller.locator('.product-gallery-item').nth(2).locator('[data-gallery-action="primary"]').click();
    const first = await seller.locator('.product-gallery-item').first().getAttribute('data-image-id');
    const response = seller.waitForResponse((r) => r.url() === origin + path && r.request().method() === 'PATCH');
    await seller.locator('#product-save').evaluate((button) => {button.click();button.click();});assert.equal((await response).status(), 200);
    await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');
    assert.equal((await ids()).length, 10);assert.equal((await ids())[0], first);
    assert.equal(report.writes.filter((x) => x.path === path && x.method === 'PATCH').length, 1);
    await openEditor();assert.equal(await seller.locator('.product-gallery-item').count(), 10);
    await seller.setViewportSize({ width: 390, height: 844 });await seller.waitForTimeout(250);await seller.screenshot({ path: out + '/seller-ten-images-mobile.png', fullPage: true });
  });
  await checked('Customer decodes all ten images and sees the saved primary and exact canonical identity order', async () => {
    await customer.setViewportSize({ width: 390, height: 844 });await customer.goto(origin + '/shop/#product/' + product.id);
    await customer.locator('.product-thumbnails .product-thumbnail').first().waitFor();assert.equal(await customer.locator('.product-thumbnails .product-thumbnail').count(), 10);
    await customer.waitForFunction(() => [...document.querySelectorAll('.product-thumbnails .product-thumbnail img')].every((img) => img.complete && img.naturalWidth > 0));
    const dto = await (await customer.request.get(origin + '/api/v1/products/' + product.id)).json();
    assert.deepEqual(dto.galleryItems.map((x) => x.id), await ids());assert.equal(dto.imageUrl, dto.images[0]);
    await noDemo(customer);await customer.screenshot({ path: out + '/customer-ten-images-mobile.png', fullPage: true });
  });
  await checked('Cancel an image removal preserves all saved images after reopen', async () => {
    const before = await ids();await seller.locator('.product-gallery-item').last().locator('[data-gallery-action="remove"]').click();
    seller.once('dialog', (dialog) => dialog.accept());await seller.locator('#product-cancel').click();
    await seller.locator('#product-list-view').waitFor({ state: 'visible' });await openEditor();assert.deepEqual(await ids(), before);
    assert.equal(await seller.locator('.product-gallery-item').count(), 10);
  });
  await checked('Save failure keeps the nine-image draft and server ten-image state; retry persists removal', async () => {
    await seller.locator('.product-gallery-item').last().locator('[data-gallery-action="remove"]').click();
    await seller.route(origin + path, async (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"UNAVAILABLE"}}' }) : route.continue());
    await seller.locator('#product-save').click();await seller.waitForFunction(() => Boolean(document.querySelector('#product-form-error').textContent));
    assert.equal(await seller.locator('.product-gallery-item').count(), 9);assert.equal((await ids()).length, 10);
    await seller.screenshot({ path: out + '/seller-save-failure-draft.png', fullPage: true });await seller.unroute(origin + path);
    await formSave();await openEditor();assert.equal((await ids()).length, 9);assert.equal(await seller.locator('.product-gallery-item').count(), 9);
  });
  await checked('Configured business phone saves through Seller UI and produces a safe wa.me link without opening it', async () => {
    await seller.goto(origin + '/seller/#company');await seller.locator('#company-form [name="sellerWhatsAppPhone"]').waitFor();
    await seller.waitForFunction(() => !document.querySelector('#company-form [type="submit"]').disabled);
    await seller.locator('[name="sellerWhatsAppPhone"]').fill('+60 12-345 6789');await seller.locator('#company-form [type="submit"]').click();
    await seller.waitForFunction(() => document.querySelector('.settings-status')?.dataset.statusKey === 'settingsSaved');
    assert.equal((await app.database.get('SELECT seller_whatsapp_phone p FROM company_setting')).p, '60123456789');
    // Switch this disposable fixture to a configured shop: previews never expose contacts.
    await app.database.run("UPDATE shop_setup SET mode = 'production' WHERE id = 1");
    config.shopMode = 'manual';
    await customer.reload();await customer.locator('a.product-chat').waitFor();
    assert.equal(await customer.locator('.product-chat').getAttribute('href'), 'https://wa.me/60123456789');
    const buttonDOM = await customer.locator('.product-chat').evaluate((element) => ({ tag: element.tagName, href: element.getAttribute('href'), aria: element.getAttribute('aria-label'), target: element.getAttribute('target'), rel: element.getAttribute('rel'), disabled: element.disabled === true }));
    let captured = null;await customer.locator('.product-chat').evaluate((element) => {window.qaChatClick = null;element.addEventListener('click', (event) => {event.preventDefault();event.stopImmediatePropagation();window.qaChatClick = element.href;}, { capture: true, once: true });});
    await customer.locator('.product-chat').click();captured = await customer.evaluate(() => window.qaChatClick);assert.equal(captured, 'https://wa.me/60123456789');
    report.chatConfigured = { buttonDOM, clickResult: captured, navigationPreventedBeforeDispatch: true };
    assert.equal(await customer.locator('.product-chat').getAttribute('target'), '_blank');assert.match(await customer.locator('.product-chat').getAttribute('rel'), /noopener/);
    await seller.screenshot({ path: out + '/seller-public-business-chat.png', fullPage: true });await customer.screenshot({ path: out + '/customer-chat-configured.png', fullPage: true });
  });
  await checked('Invalid contact keeps the previously saved number; clearing it disables Customer Chat', async () => {
    await seller.locator('[name="sellerWhatsAppPhone"]').fill('123');await seller.locator('#company-form [type="submit"]').click();
    await seller.waitForFunction(() => document.querySelector('.settings-status')?.dataset.statusKey === 'sellerWhatsAppInvalid');
    assert.equal((await app.database.get('SELECT seller_whatsapp_phone p FROM company_setting')).p, '60123456789');
    await seller.locator('[name="sellerWhatsAppPhone"]').fill('');await seller.locator('#company-form [type="submit"]').click();
    await seller.waitForFunction(() => document.querySelector('.settings-status')?.dataset.statusKey === 'settingsSaved');
    await customer.reload();await customer.locator('button.product-chat').waitFor();assert.equal(await customer.locator('.product-chat').getAttribute('href'), null);
    report.chatUnconfigured = await customer.locator('.product-chat').evaluate((element) => ({ tag: element.tagName, href: element.getAttribute('href'), aria: element.getAttribute('aria-label'), disabled: element.disabled === true }));
    const notice = await customer.locator('.product-chat').getAttribute('aria-label');
    await customer.locator('.product-chat').click();await customer.waitForFunction((text) => document.body.innerText.includes(text), notice);
    report.chatUnconfigured.clickNotice = notice;
    await customer.screenshot({ path: out + '/customer-chat-unconfigured.png', fullPage: true });
  });
  await checked('Seven actual locales and five settled Seller widths; Customer detail, gallery keyboard and public contact copy', async () => {
    report.viewportMatrix = [];
    for (const width of [320, 390, 430, 768, 1280]) {
      for (const page of [seller, customer]) {await page.setViewportSize({ width, height: 900 });await page.waitForTimeout(250);}
      for (const locale of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) {
        for (const page of [seller, customer]) {
          await page.evaluate(async (locale) => (await import('/shared/i18n.js')).setLocale(locale), locale);await noDemo(page);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, locale + '/' + width);
        }
        report.viewportMatrix.push({ width, locale, pages: ['Seller company', 'Customer product'], status: 'PASS' });
      }
    }
    for (const page of [seller, customer]) await page.evaluate(async () => (await import('/shared/i18n.js')).setLocale('en'));
    await openEditor();
    for (const width of [320, 390, 430, 768, 1280]) {
      await seller.setViewportSize({ width, height: 900 });await seller.waitForTimeout(250);
      for (const locale of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) {
        await seller.evaluate(async (locale) => (await import('/shared/i18n.js')).setLocale(locale), locale);await noDemo(seller);
        assert.equal(await seller.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, locale + '/' + width);
        const rect = await seller.locator('#product-form').boundingBox();assert.ok(rect.width >= (width <= 900 ? width - 80 : 700), 'settled editor width');
        report.viewportMatrix.push({ width, locale, pages: ['Seller gallery'], status: 'PASS' });
        if (width === 390 && ['en', 'zh-Hans'].includes(locale) || width === 320 && locale === 'ja') await seller.screenshot({ path: out + `/seller-gallery-${width}-${locale}.png`, fullPage: true });
      }
    }
    await seller.evaluate(async () => (await import('/shared/i18n.js')).setLocale('en'));
    const before = await ids();await seller.locator('.product-gallery-item').last().locator('[data-gallery-action="earlier"]').focus();await seller.keyboard.press('Enter');
    assert.equal(await seller.evaluate(() => document.activeElement?.closest('.product-gallery-item') !== null), true);
    seller.once('dialog', (dialog) => dialog.accept());await seller.locator('#product-cancel').click();await openEditor();assert.deepEqual(await ids(), before);
  });
  await checked('Actual document renderer: seven-locale summary and packing HTML, two A4 PDFs saved and retained for reopen validation', async () => {
    await seller.setViewportSize({ width: 1280, height: 900 });
    await seller.evaluate(async () => {
      const { createOrderDocuments } = await import('/seller/order-documents.js');window.qaDocs = createOrderDocuments();
      const deliveries = ['ALPHA', 'BETA'].map((tag) => ({ recipient: { fullName: tag + ' Fictional recipient', phone: '+60123456789' },
        address: { line1: tag + ' Fictional test address', postcode: '50000', country: 'MY' },
        items: [{ sku: 'SYNTHETIC-' + tag, name: tag + ' Fictional item', quantity: 2, priceMinor: 900, lineTotalMinor: 1800, currency: 'MYR' }] }));
      window.qaOrder = { orderNo: 'SYNTHETIC-PREVIEW-ONLY', status: 'CONFIRMED', revision: 1, currency: 'MYR', simulation: true,
        buyer: { fullName: 'Fictional Buyer', email: 'fictional@example.invalid' }, submittedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', totalMinor: 3600, deliveries };
    });
    for (const locale of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) {
      await seller.evaluate(async (locale) => (await import('/shared/i18n.js')).setLocale(locale), locale);
      for (const kind of ['summary', 'packing']) {
        await seller.evaluate((kind) => {document.querySelector('#order-document-dialog')?.close();qaDocs.open(qaOrder, kind, 'Preview General Store', null);}, kind);
        assert.equal(await seller.locator('.prowitem_processed').count(), 2);assert.doesNotMatch(await seller.locator('#order-document-dialog').innerText(), /demo|演示|デモ|데모/i);
        const rendered = await seller.locator('.order-document-pages').innerHTML();
        writeFileSync(out + `/document-${kind}-${locale}.fragment.html`, rendered);
        if (locale === 'en') {
          const css = ['public/shared/base.css', 'public/shop/tokens.css', 'public/seller/style.css', 'public/seller/order-print.css'].map((file) => readFileSync(file, 'utf8')).join('\n');
          writeFileSync(out + `/document-${kind}.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic ${kind}</title><style>${css}</style><body><main class="order-document-pages document-formatted" style="--document-scale:1">${rendered}</main></body></html>`);
          await seller.pdf({ path: out + `/document-${kind}.pdf`, format: 'A4', preferCSSPageSize: true, printBackground: true });
          await seller.screenshot({ path: out + `/document-${kind}-preview.png`, fullPage: true });
        }
      }
    }
    await seller.evaluate(() => document.querySelector('#order-document-dialog').close());
  });
  await checked('Saved self-contained HTML opens again with both destinations and retained no-payment/manual-packing notices', async () => {
    const page = await context.newPage();
    for (const kind of ['summary', 'packing']) {
      await page.goto(pathToFileURL(out + `/document-${kind}.html`).href);const text = await page.locator('body').innerText();
      assert.ok(text.includes('ALPHA') && text.includes('BETA'));assert.match(text, /No payment or shipment/);assert.doesNotMatch(text, /\bDEMO\b/);
      if (kind === 'packing') assert.match(text, /Manual packing checklist/);
    }
    await page.screenshot({ path: out + '/document-packing-html-reopened.png', fullPage: true });await page.close();
  });
  await checked('No page exceptions or external navigation/messages', async () => {assert.deepEqual(report.pageErrors, []);assert.deepEqual(report.externalRequests, []);});
} catch (error) {if (error.message === 'CHECKPOINT_CASE_LIMIT') report.remaining = 'Deferred at owner-requested checkpoint';else {process.exitCode = 1;console.error(error.stack);}} finally
{
  writeFileSync(out + '/browser-results.json', JSON.stringify(report, null, 2));console.log(JSON.stringify({ cases: report.cases, externalRequests: report.externalRequests.length, pageErrors: report.pageErrors }));
  await context.close();await browser.close();await app.close();
}
