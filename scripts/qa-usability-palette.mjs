import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { useWorkerIngress } from '../test/browser/worker-harness.mjs';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/usability-palette');mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const widths = [320, 390, 820, 1440],palettes = ['evergreen-teal', 'warm-plum', 'ocean-blue', 'navy-orange', 'high-contrast', 'graphite'];
const paths = ['public/shop/app.js', 'public/shop/index.html', 'public/shop/style.css', 'public/shop/tokens.css',
'public/seller/app.js', 'public/seller/style.css', 'public/seller/settings.js', 'public/shared/appearance.js',
'public/shared/appearance.css', 'public/shared/modal.js', 'public/shop/palette.js', 'public/seller/palette.js',
'public/shop/product-detail.js', 'public/seller/orders.js', 'public/seller/order-documents.js', 'public/shop/version.js', 'public/seller/version.js'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const luminance = (color) => {
  const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
};
const contrast = (foreground, background) => {const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);return (values[0] + .05) / (values[1] + .05);};
const report = { sourceHead: head, gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), sourceHashes: hashes(),
  versions: Object.fromEntries(['shop', 'seller'].map((surface) => [surface, /v\d+/.exec(readFileSync(`public/${surface}/version.js`, 'utf8'))[0]])),
  definitions: { 88: 'Critical routes at320/390/820/1440px', 90: 'Keyboard focus, dialogs and Escape', 91: 'Accessible palette preview and persistence' },
  scope: 'Current single-company Seller/Customer UI; fictional disposable SQLite and browser state; real Worker/API; one cached browser worker; no PDF/print/provider calls',
  cases: [], routeInventory: [], dialogInventory: [], stateEvidence: [], pageErrors: [], externalRequests: [], unexpectedDialogs: [], cleanup: [] };
const secrets = new Set();
const redact = (error) => {let text = String(error?.stack || error);for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');return text;};
const browser = await chromium.launch({ headless: true });report.browser = browser.version();
let app, context, temp, width, stage;
const checked = async (id, label, fn) => {
  stage = `#${id} ${label}`;
  try {const evidence = await fn();report.cases.push({ id, label, width, status: 'PASS', evidence });console.log(`PASS #${id}/${width} ${label}`);}
  catch (error) {report.cases.push({ id, label, width, status: 'FAIL', error: redact(error) });throw error;}
};
const cleanFixture = () => {if (temp) {const folder = temp;rmSync(folder, { recursive: true, force: true });report.cleanup.push({ width, temporaryFixtureRemoved: !existsSync(folder) });temp = null;}};
try {
  for (width of widths) {
    temp = mkdtempSync(join(tmpdir(), 'online-shopping-usability-qa-'));
    const config = { dbPath: join(temp, 'fictional.db'), shopMode: 'manual', username: 'synthetic_usability_qa',
      password: randomUUID() + randomUUID(), production: false, publicOrigin: null };secrets.add(config.password);
    app = await createApp(config);const gateway = await useWorkerIngress(app, config);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));const origin = 'http://127.0.0.1:' + app.server.address().port;
    const login = await fetch(origin + '/api/v1/seller/session', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: config.username, password: config.password }) });
    assert.equal(login.status, 200);const cookie = login.headers.get('set-cookie').split(';')[0],csrf = (await login.json()).csrfToken;
    secrets.add(cookie);secrets.add(cookie.split('=')[1]);secrets.add(csrf);
    const api = async (method, path, body, sellerAuth = true) => {
      const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(8000), headers: { origin,
          ...(sellerAuth ? { cookie, 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(response.ok, `Fixture ${method} ${path} status${response.status}`);return response.json();
    };
    await api('POST', '/api/v1/seller/categories', { code: 'GEOMETRY', label: 'Fictional Geometry' });
    const imageDataUrl = 'data:image/png;base64,' + readFileSync('public/shop/icons/icon-192.png').toString('base64');
    const create = (tag) => api('POST', '/api/v1/seller/products', { sku: `GEOMETRY-${width}-${tag}`, name: 'Fictional Geometry ' + tag,
      description: 'Synthetic local geometry and keyboard fixture. No real goods or recipients.', category: 'GEOMETRY', priceMinor: tag === 'Small' ? 1290 : 1990,
      active: true, imageDataUrl, variantGroup: 'GEOMETRY-GROUP', variantLabel: tag });
    let alpha = await create('Small');const beta = await create('Large');
    alpha = await api('PATCH', '/api/v1/seller/products/' + alpha.id, { gallery: [{ id: 'main' }, ...Array.from({ length: 5 }, (_, index) => ({
        imageDataUrl: 'data:image/png;base64,' + Buffer.concat([readFileSync('public/shop/icons/icon-192.png'), Buffer.from(`geometry-fixture-${index}`)]).toString('base64')
      }))], expectedUpdatedAt: alpha.updatedAt });
    assert.equal(alpha.images.length, 6);
    context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', (route) => {if (!route.request().url().startsWith(origin + '/')) {report.externalRequests.push(redact(route.request().url()));return route.abort();}return route.continue();});
    let expectedNative = null;
    const attach = (page) => {
      page.setDefaultTimeout(12000);page.on('pageerror', (error) => report.pageErrors.push({ width, stage, error: redact(error) }));
      page.on('dialog', async (dialog) => {const expected = expectedNative === 'dismiss';expectedNative = null;
        if (!expected) report.unexpectedDialogs.push({ width, stage, type: dialog.type(), message: redact(dialog.message()) });await dialog.dismiss();});
    };
    const seller = await context.newPage(),shop = await context.newPage();attach(seller);attach(shop);
    const shot = async (page, label, modal = false) => {
      if (page === seller && (await seller.locator('#password').count()) && (await seller.locator('#password').inputValue())) throw new Error('Screenshot blocked: fixture authentication input not cleared');
      const target = modal ? page.locator('dialog[open]') : page;
      await target.screenshot({ path: out + `/${label}-${width}.png`, ...(modal ? {} : { fullPage: true }) });
    };
    const layout = async (page, label, selectors) => {
      const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, route: location.hash }));
      assert.ok(geometry.documentWidth <= width + 1, `${label}: document overflow ${geometry.documentWidth}/${width}`);
      const controls = [];
      for (const selector of selectors) {
        const control = page.locator(selector).first();await control.waitFor({ state: 'visible' });await control.scrollIntoViewIfNeeded();const rect = await control.boundingBox();
        assert.ok(rect && rect.width > 0 && rect.x >= -1 && rect.x + rect.width <= width + 1, `${label}: clipped ${selector} ${JSON.stringify(rect)}`);
        controls.push({ selector, x: rect.x, width: rect.width });
      }
      await shot(page, 'route-' + label);report.routeInventory.push({ width, label, route: geometry.route });return { ...geometry, controls };
    };
    const routeCase = (page, label, selectors) => checked(88, label, () => layout(page, label, selectors));
    const shopReady = async (name) => {await shop.locator(`#${name}-view`).waitFor({ state: 'visible' });};
    const home = async () => {
      if (await shop.locator('.product-back').isVisible()) await shop.locator('.product-back').click();
      await shop.locator(width <= 760 ? '#mobile-navigation a[href="#catalog"]' : '.shop-topbar .brand').click();await shopReady('catalog');
      await shop.waitForFunction(() => document.querySelector('#catalog-grid').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.catalog-card').length === 2);
    };
    const account = async (name) => {
      if (await shop.locator('.account-sidebar').isVisible()) await shop.locator(`.account-sidebar a[href="#${name}"]`).click();else
      {if (await shop.locator('.product-back').isVisible()) await shop.locator('.product-back').click();
        if (width <= 760) {await shop.locator('#mobile-navigation a[href="#profile"]').click();await shopReady('profile');if (name !== 'profile') await shop.locator(`.account-sidebar a[href="#${name}"]`).click();} else
        {await shop.locator('#profile-menu-button').click();await shop.locator(`#profile-menu a[href="#${name}"]`).click();}}
      await shopReady(name);
    };
    const detail = async () => {await home();await shop.locator(`.product-name-link[data-product-id="${alpha.id}"]`).click();await shopReady('product');await shop.locator('.product-add').waitFor();};
    const cart = async () => {await shop.locator((await shop.locator('.product-nav-cart').isVisible()) ? '.product-nav-cart' : width <= 760 ? '#mobile-navigation a[href="#cart"]' : '.shop-nav a[href="#cart"]').click();await shopReady('cart');};
    const sellerNav = async (view) => {if (await seller.locator('#open-menu').isVisible()) await seller.locator('#open-menu').click();await seller.locator(`.nav-item[data-view="${view}"]`).click();
      await seller.waitForFunction((view) => location.hash === '#' + view || view === 'dashboard' && location.hash === '', view);};
    const businessTables = (await app.database.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('admin','session','rate_limit_attempt') ORDER BY name")).map((row) => row.name);
    const business = async () => Object.fromEntries(await Promise.all(await Promise.all(businessTables.map(async (table) => [table, sha(JSON.stringify(await app.database.all('SELECT * FROM ' + table + ' ORDER BY rowid')))]))));
    const browserState = () => shop.evaluate(async () => {
      const { createLocalOrderStore } = await import('/shop/local-orders.js');
      const orders = await createLocalOrderStore(indexedDB);
      return { local: Object.keys(localStorage).filter((key) => !key.includes('palette') && !key.includes('seller-session-hint')).sort().map((key) => [key, localStorage.getItem(key)]),
        session: Object.keys(sessionStorage).sort().map((key) => [key, sessionStorage.getItem(key)]), orders: orders.list() };
    }).then((value) => sha(JSON.stringify(value)));

    await seller.goto(origin + '/seller/');await seller.locator('#login-view').waitFor({ state: 'visible' });
    await routeCase(seller, 'seller-login', ['#username', '#password', '#login-submit']);
    await seller.evaluate(({ username, password }) => {document.querySelector('#username').value = username;document.querySelector('#password').value = password;}, { username: config.username, password: config.password });
    await seller.locator('#login-submit').click();await seller.locator('#workspace').waitFor({ state: 'visible' });
    await seller.locator('.dashboard-home .settings-card').waitFor();await routeCase(seller, 'seller-dashboard-setup', ['.dashboard-home .settings-card', '.dashboard-home button']);
    await seller.locator('.dashboard-home button').click();await seller.locator('#shop-setup-form').waitFor();
    await seller.waitForFunction(() => !document.querySelector('#shop-setup-form [type=submit]').disabled);
    await seller.locator('#shop-setup-form [name=mode]').selectOption('production');await seller.locator('#shop-setup-form [name=shopName]').fill('Fictional Geometry Store');
    const setupResponse = seller.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/seller/setup' && r.request().method() === 'POST');
    await seller.locator('#shop-setup-form [type=submit]').click();assert.equal((await setupResponse).status(), 200);
    await seller.waitForFunction(() => document.querySelector('#shop-setup-form').hidden);
    await shop.goto(origin + '/shop/#profile');await shopReady('profile');
    await shop.locator('#profile-form [name=fullName]').fill('Fictional Geometry Buyer');await shop.locator('#profile-form [name=email]').fill('geometry@example.invalid');
    await shop.locator('#profile-form [type=submit]').click();await shop.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('Profile saved.'));
    await account('addresses');await shop.locator('#add-address').click();
    const addressForm = shop.locator('.app-modal[open] .address-form');
    for (const [name, value] of Object.entries({ fullName: 'Fictional Geometry Recipient', phone: '+60123456789', line1: '41 Fictional QA Road', line2: 'Synthetic fixture only', city: 'Kuala Lumpur', postcode: '50000' })) await addressForm.locator(`[name=${name}]`).fill(value);
    await addressForm.locator('[name=region]').selectOption('W.P. Kuala Lumpur');await addressForm.locator('[type=submit]').click();await shop.locator('.app-modal[open]').waitFor({ state: 'hidden' });
    await detail();await shop.locator('.product-add').click();await cart();await shop.locator('#checkout-button').click();await shopReady('checkout');
    await shop.waitForFunction(() => !document.querySelector('#submit-order').disabled);
    const orderResponse = shop.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
    await shop.locator('#submit-order').click();const submitted = await orderResponse;assert.equal(submitted.status(), 201);
    const payload = submitted.request().postDataJSON(),receipt = await submitted.json();secrets.add(receipt.statusAccessKey);await shopReady('receipt');
    // A second fictional order supplies the existing confirmed packing-sheet UI.
    const secondResponse = await fetch(origin + '/api/v1/orders', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { origin, 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(payload) });
    assert.equal(secondResponse.status, 201);const confirmedReceipt = await secondResponse.json();secrets.add(confirmedReceipt.statusAccessKey);
    const pendingId = (await app.database.get('SELECT id FROM shop_order WHERE order_no=?', receipt.orderNo)).id;
    const confirmedId = (await app.database.get('SELECT id FROM shop_order WHERE order_no=?', confirmedReceipt.orderNo)).id;
    await api('POST', '/api/v1/seller/orders/' + confirmedId + '/confirm', { expectedRevision: 1 });const baseline = await business();

    await routeCase(shop, 'customer-receipt', ['#receipt-title', '#receipt-number', '#receipt-view a[href="#orders"]']);
    await home();await routeCase(shop, 'customer-catalog', ['#catalog-grid', '.catalog-card']);
    await detail();await routeCase(shop, 'customer-product', ['.product-image-button', '.product-add', '.product-buy']);
    await cart();await shop.locator('#cart-empty').waitFor({ state: 'visible' });await routeCase(shop, 'customer-cart-empty', ['#cart-empty', '.empty-browse']);
    await account('profile');await routeCase(shop, 'customer-profile', ['#profile-form', '#profile-form [type=submit]']);
    await account('addresses');await routeCase(shop, 'customer-addresses', ['#add-address', '.address-card']);
    await account('orders');await shop.locator('.order-list-link').waitFor();await routeCase(shop, 'customer-orders', ['#local-orders-list', '.order-list-link']);
    await shop.locator('.order-list-link').click();await shop.locator('.order-detail').waitFor();await routeCase(shop, 'customer-order-detail', ['.order-detail', '.order-detail-total']);
    await account('settings');await routeCase(shop, 'customer-settings', ['.appearance-options', '.appearance-option']);
    await detail();await shop.locator('.product-add').click();await cart();await shop.locator('#cart-list .cart-row').waitFor();await routeCase(shop, 'customer-cart-populated', ['#cart-list .cart-row', '#checkout-button']);
    await shop.locator('#checkout-button').click();await shopReady('checkout');await shop.waitForFunction(() => !document.querySelector('#submit-order').disabled);
    await routeCase(shop, 'customer-checkout', ['#change-address', '.assignment-row', '#submit-order']);

    await sellerNav('dashboard');await seller.locator('.dashboard-grid').waitFor();await routeCase(seller, 'seller-dashboard', ['#workspace-content', '#page-title']);
    await sellerNav('products');await seller.locator('.product-card').first().waitFor();await routeCase(seller, 'seller-products', ['#product-search-form', '#product-new', '.product-card']);
    await seller.locator('#product-new').click();await seller.locator('#product-form').waitFor({ state: 'visible' });await routeCase(seller, 'seller-product-new', ['#product-form', '#product-save']);
    await seller.locator('#product-cancel').click();await seller.locator(`.product-card[data-product-id="${alpha.id}"] .product-card-actions button`).first().click();
    await seller.waitForFunction(() => document.querySelectorAll('.product-gallery-item').length === 6 && !document.querySelector('#product-save').disabled);
    await routeCase(seller, 'seller-product-edit', ['#product-form', '.product-gallery-item', '#product-save']);
    await sellerNav('categories');await seller.locator('#category-create').waitFor();await routeCase(seller, 'seller-categories', ['#category-create', '.settings-row']);
    await sellerNav('company');await seller.locator('.appearance-option').first().waitFor();await routeCase(seller, 'seller-company', ['#company-form', '.setup-status', '.appearance-options']);
    const orderCard = (id) => seller.locator('.order-card').filter({ hasText: id === pendingId ? receipt.orderNo : confirmedReceipt.orderNo });
    const orderDetail = async (id) => {await orderCard(id).click();await seller.waitForFunction((number) => document.querySelector('.order-number')?.textContent === number, id === pendingId ? receipt.orderNo : confirmedReceipt.orderNo);};
    await sellerNav('orders');await orderCard(pendingId).waitFor();await routeCase(seller, 'seller-orders', ['#order-filter', '.order-card']);
    await orderDetail(pendingId);await routeCase(seller, 'seller-order-detail', ['#order-detail-content', '.order-document-actions']);
    if (await seller.locator('#order-back').isVisible()) await seller.locator('#order-back').click();
    await orderDetail(confirmedId);await routeCase(seller, 'seller-confirmed-detail', ['#order-detail-content', '.order-document-actions']);
    await sellerNav('review');await orderCard(pendingId).waitFor();await routeCase(seller, 'seller-review', ['#order-filter', '.order-card']);
    await orderDetail(pendingId);await routeCase(seller, 'seller-review-detail', ['.order-review-actions', '#order-detail-content']);
    assert.deepEqual(await business(), baseline);

    const dialogCase = async (page, label, trigger, selector, returnSelector = null, afterClose = null) => checked(90, label, async () => {
      const before = await business();await page.bringToFront();await trigger.focus();await trigger.evaluate((element) => {window.__qaFocusOrigin = element;});await page.keyboard.press('Enter');
      const dialog = page.locator(selector);await dialog.waitFor({ state: 'visible' });
      const name = await dialog.evaluate((element) => element.getAttribute('aria-label') || document.getElementById(element.getAttribute('aria-labelledby'))?.textContent || '');assert.ok(name.trim(), label + ' accessible name');
      const focusables = await dialog.locator('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]').evaluateAll((elements) => elements.filter((element) => element.getClientRects().length && element.tabIndex >= 0).length);
      const focusTrace = [];
      for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < focusables + 2; i++) {
        await page.keyboard.press(key);const state = await dialog.evaluate((element) => ({ inside: element.contains(document.activeElement), tag: document.activeElement.tagName, id: document.activeElement.id,
          className: document.activeElement.className, documentHasFocus: document.hasFocus(), dialogOpen: element.open }));
        focusTrace.push({ key, step: i, ...state });
        if (!state.inside) report.focusFailure = { width, label, focusables, trace: focusTrace };
        assert.ok(state.inside, label + ' focus escaped');
      }
      const focusStyle = await page.evaluate(() => {const style = getComputedStyle(document.activeElement);return { outline: style.outline, boxShadow: style.boxShadow };});
      if ([320, 1440].includes(width)) await shot(page, 'dialog-' + label, true);
      await dialog.evaluate((element) => {window.__qaDialogClosed = false;element.addEventListener('close', () => {window.__qaDialogClosed = true;}, { once: true });});
      await page.keyboard.press('Escape');await dialog.waitFor({ state: 'hidden' });await page.waitForFunction(() => window.__qaDialogClosed === true);
      await page.waitForFunction((returnSelector) => returnSelector ? document.activeElement === document.querySelector(returnSelector) : document.activeElement === window.__qaFocusOrigin, returnSelector);
      const extra = afterClose ? await afterClose() : {};assert.deepEqual(await business(), before);report.dialogInventory.push({ width, label, accessibleName: name, focusables });return { accessibleName: name, focusables, focusTrace, forwardReverseContainment: true, EscapeCloses: true, focusRestored: true, focusStyle, businessWrites: 0, ...extra };
    });
    await shop.locator('#change-address').focus();await dialogCase(shop, 'customer-address-chooser', shop.locator('#change-address'), '.app-modal[open]');
    await account('addresses');await dialogCase(shop, 'customer-address-add', shop.locator('#add-address'), '.app-modal[open]');
    await dialogCase(shop, 'customer-address-edit', shop.locator('.address-actions button').first(), '.app-modal[open]');
    await checked(90, 'customer-native-delete-cancel', async () => {
      const before = await browserState(),beforeBusiness = await business();expectedNative = 'dismiss';const event = shop.waitForEvent('dialog');
      await shop.locator('.address-actions button').nth(1).focus();await shop.keyboard.press('Enter');assert.equal((await event).type(), 'confirm');
      assert.equal(await browserState(), before);assert.deepEqual(await business(), beforeBusiness);return { cancellation: 'Playwright dismiss API; native OS keyboard Escape not exercised', browserAddressStateUnchanged: true, businessWrites: 0 };
    });
    await detail();await dialogCase(shop, 'customer-image-viewer', shop.locator('.product-image-button'), '.image-viewer[open]');
    if (await shop.locator('.variant-chooser-trigger').isVisible()) await dialogCase(shop, 'customer-variant-chooser', shop.locator('.variant-chooser-trigger'), '.variant-dialog[open]');
    await home();
    if (width <= 760) {
      await dialogCase(shop, 'customer-mobile-category', shop.locator('#mobile-category'), '.app-modal[open]');
      await dialogCase(shop, 'customer-mobile-language', shop.locator('#mobile-language'), '.app-modal[open]');
    } else {
      await dialogCase(shop, 'customer-header-language', shop.locator('#language .language-trigger'), '.app-modal[open]');
    }
    const popupCase = (page, label, trigger, popup) => checked(90, label, async () => {
      const before = await business();await trigger.focus();await page.keyboard.press('Enter');await popup.waitFor({ state: 'visible' });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');await page.keyboard.press('Tab');
      assert.ok(await popup.evaluate((element) => element.contains(document.activeElement)), label + ' keyboard item unreachable');
      await page.keyboard.press('Escape');await popup.waitFor({ state: 'hidden' });assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);assert.deepEqual(await business(), before);
      return { keyboardOpenAndFirstItem: true, EscapeCloses: true, openerFocused: true, nonModalPopup: true, businessWrites: 0 };
    });
    if (await shop.locator('#profile-menu-button').isVisible()) await popupCase(shop, 'customer-account-popup', shop.locator('#profile-menu-button'), shop.locator('#profile-menu'));
    await popupCase(seller, 'seller-account-popup', seller.locator('#account-button'), seller.locator('#account-menu'));
    await popupCase(seller, 'seller-language-popup', seller.locator('#language .language-trigger'), seller.locator('#language .language-options'));
    if (await seller.locator('#open-menu').isVisible()) await checked(90, 'seller-navigation-drawer', async () => {
      const before = await business();await seller.locator('#open-menu').focus();await seller.keyboard.press('Enter');
      await seller.waitForFunction(() => document.querySelector('#sidebar').classList.contains('drawer-open'));
      const buttons = await seller.locator('#sidebar button:visible').count();
      for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < buttons + 2; i++) {await seller.keyboard.press(key);assert.ok(await seller.evaluate(() => document.querySelector('#sidebar').contains(document.activeElement)));}
      await seller.keyboard.press('Escape');await seller.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('drawer-open') && document.activeElement.id === 'open-menu');
      assert.deepEqual(await business(), before);return { forwardReverseFocusContained: true, EscapeCloses: true, openerFocused: true, businessWrites: 0 };
    });
    await seller.locator('#account-button').click();await dialogCase(seller, 'seller-profile', seller.locator('#profile-button'), '#profile-dialog[open]', '#account-button');
    await dialogCase(seller, 'seller-confirm-decision', seller.locator('.order-review-actions [data-action=confirm]'), '#decision-dialog[open]');
    await dialogCase(seller, 'seller-reject-decision', seller.locator('.order-review-actions [data-action=reject]'), '#decision-dialog[open]');
    await checked(90, 'seller-disabled-decision-action-focus', async () => {
      const before = await business();const writes = gateway.records.filter((record) => !['GET', 'HEAD'].includes(record.method)).length;
      await seller.bringToFront();
      await seller.locator('.order-review-actions [data-action=confirm]').focus();await seller.keyboard.press('Enter');await seller.locator('#decision-dialog[open]').waitFor();
      await seller.locator('#decision-submit').evaluate((element) => {element.disabled = true;});await seller.locator('#decision-cancel').focus();
      for (const key of ['Tab', 'Shift+Tab']) for (let count = 0; count < 3; count++) {await seller.keyboard.press(key);assert.equal(await seller.evaluate(() => document.activeElement.id), 'decision-cancel');}
      await seller.locator('#decision-submit').evaluate((element) => {element.disabled = false;});
      await seller.locator('#decision-dialog').evaluate((element) => {window.__qaDecisionClosed = false;element.addEventListener('close', () => {window.__qaDecisionClosed = true;}, { once: true });});
      await seller.keyboard.press('Escape');await seller.locator('#decision-dialog[open]').waitFor({ state: 'hidden' });await seller.waitForFunction(() => window.__qaDecisionClosed === true);
      assert.deepEqual(await business(), before);assert.equal(gateway.records.filter((record) => !['GET', 'HEAD'].includes(record.method)).length, writes);
      return { fixture: 'Existing dialog with temporarily disabled action; no request or new policy', disabledAndHiddenFieldsSkipped: true, forwardReverseFocusContained: true, businessWrites: 0 };
    });
    await sellerNav('orders');await orderCard(confirmedId).waitFor();await orderDetail(confirmedId);
    await dialogCase(seller, 'seller-order-summary', seller.locator('.order-document-actions button').nth(0), '#order-document-dialog[open]');
    await dialogCase(seller, 'seller-packing-preview', seller.locator('.order-document-actions button').nth(1), '#order-document-dialog[open]');
    await shop.evaluate(async () => {
      const button = document.createElement('button');button.id = 'qa-confirm-trigger';button.textContent = 'Synthetic component fixture';document.body.append(button);
      const { confirmModal } = await import('/shared/modal.js');button.addEventListener('click', () => {window.__qaConfirmed = null;confirmModal('Fictional local confirmation only').then((value) => {window.__qaConfirmed = value;});});
    });
    await dialogCase(shop, 'shared-confirm-cancel-Escape', shop.locator('#qa-confirm-trigger'), '.app-modal-confirm[open]', null, async () => {
      await shop.waitForFunction(() => window.__qaConfirmed === false);await shop.locator('#qa-confirm-trigger').evaluate((element) => element.remove());
      return { invocation: 'Isolated actual shared component; no PWA waiting-worker/update lifecycle activated', cancelledResult: false };
    });
    const paletteState = (page, surface) => page.evaluate((surface) => ({ current: document.documentElement.dataset[surface + 'Palette'], stored: localStorage.getItem(`online-shopping-${surface}-palette-v1`),
      selected: document.querySelector(`input[name="${surface}-palette"]:checked`)?.value,
      semantic: Object.fromEntries(['--shop-price', '--shop-order-total', '--shop-error', '--shop-success', '--shop-warning-background', '--shop-warning-text'].map((key) => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])) }), surface);
    await account('settings');await sellerNav('company');await seller.locator('.appearance-options').waitFor();
    const preservedBrowser = await browserState();const surfaces = [['shop', shop], ['seller', seller]];
    for (const [surface, page] of surfaces) {
      const initialSemantic = (await paletteState(page, surface)).semantic;
      for (const id of palettes) await checked(91, surface + '-' + id + '-preview-apply-reload', async () => {
        const before = await paletteState(page, surface),otherKey = surface === 'shop' ? 'seller' : 'shop';const otherStored = await page.evaluate((key) => localStorage.getItem(`online-shopping-${key}-palette-v1`), otherKey);
        const row = page.locator('.appearance-option').filter({ has: page.locator(`input[value="${id}"]`) });const preview = row.locator('button');
        await preview.focus();await page.keyboard.press('Enter');const modal = page.locator('.app-modal[open]');await modal.waitFor();
        assert.equal(await modal.locator('.appearance-sample').getAttribute('data-palette'), id);assert.deepEqual(await paletteState(page, surface), before);
        const sampled = await modal.locator('.appearance-sample').evaluate((sample) => {
          const background = (element) => {for (let current = element; current; current = current.parentElement) {const value = getComputedStyle(current).backgroundColor;if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value;}return 'rgb(255, 255, 255)';};
          return ['h3', 'p', '.primary-button', 'input', '.appearance-warning', '.appearance-error'].map((selector) => {
            const element = sample.querySelector(selector),style = getComputedStyle(element);return { selector, foreground: style.color, background: background(element) };
          });
        });
        const computedContrast = sampled.map((pair) => ({ ...pair, ratio: contrast(pair.foreground, pair.background), minimum: 4.5 }));
        for (const pair of computedContrast) assert.ok(pair.ratio >= pair.minimum, `${surface}/${id}/${pair.selector} contrast${pair.ratio}`);
        await shot(page, `palette-${surface}-${id}`, true);await page.keyboard.press('Escape');await modal.waitFor({ state: 'hidden' });assert.equal(await preview.evaluate((element) => element === document.activeElement), true);
        assert.deepEqual(await paletteState(page, surface), before);
        await page.keyboard.press('Enter');await page.locator('.app-modal[open]').waitFor();await page.locator('.app-modal[open] .modal-content > .primary-button').focus();await page.keyboard.press('Enter');await page.locator('.app-modal[open]').waitFor({ state: 'hidden' });
        const applied = await paletteState(page, surface);assert.equal(applied.current, id);assert.equal(applied.stored, id);assert.equal(applied.selected, id);assert.deepEqual(applied.semantic, initialSemantic);
        assert.equal(await page.evaluate((key) => localStorage.getItem(`online-shopping-${key}-palette-v1`), otherKey), otherStored);
        assert.equal(await page.locator('.appearance-options + [role=status]').getAttribute('data-i18n'), 'paletteSaved');
        await page.reload();await page.locator('.appearance-options').waitFor();const reloaded = await paletteState(page, surface);assert.deepEqual(reloaded, applied);
        assert.deepEqual(await business(), baseline);assert.equal(await browserState(), preservedBrowser);return { previewChangesPreference: false, EscapeRestoresFocus: true, computedContrast, applied, reloadPersists: true, otherSurfacePreferenceUnchanged: true, cartProfileAddressesOrdersUnchanged: true, businessWrites: 0 };
      });
      await checked(91, surface + '-keyboard-radio-cross-tab-storage-failure', async () => {
        const otherPage = await context.newPage();attach(otherPage);await otherPage.goto(origin + (surface === 'shop' ? '/shop/#settings' : '/seller/#company'));await otherPage.locator('.appearance-options').waitFor();
        const radio = page.locator(`input[name="${surface}-palette"][value="warm-plum"]`);await radio.focus();await page.keyboard.press('Space');
        await otherPage.waitForFunction((surface) => document.documentElement.dataset[surface + 'Palette'] === 'warm-plum' && document.querySelector(`input[name="${surface}-palette"]:checked`)?.value === 'warm-plum', surface);
        await otherPage.addInitScript(() => {const original = Storage.prototype.setItem;Storage.prototype.setItem = function (key, value) {if (key.endsWith('-palette-v1')) throw new DOMException('Synthetic storage unavailable', 'QuotaExceededError');return original.call(this, key, value);};});
        await otherPage.reload();await otherPage.locator('.appearance-options').waitFor();const before = await paletteState(otherPage, surface);
        await otherPage.locator(`input[name="${surface}-palette"][value="high-contrast"]`).focus();await otherPage.keyboard.press('Space');
        const failed = await paletteState(otherPage, surface);assert.equal(failed.current, 'high-contrast');assert.equal(failed.stored, before.stored);
        assert.equal(await otherPage.locator('.appearance-options + [role=status]').getAttribute('data-i18n'), 'paletteSessionOnly');await shot(otherPage, `palette-${surface}-storage-session-only`);
        await otherPage.reload();await otherPage.locator('.appearance-options').waitFor();assert.equal((await paletteState(otherPage, surface)).current, before.stored);await otherPage.close();
        assert.deepEqual(await business(), baseline);assert.equal(await browserState(), preservedBrowser);return { keyboardRadioSpace: true, actualOtherTabSync: true, blockedStorageDoesNotClaimSaved: true, temporaryChoiceLostOnReload: true, businessWrites: 0 };
      });
    }
    await dialogCase(shop, 'customer-palette-preview-focus', shop.locator('.appearance-option button').last(), '.app-modal[open]');
    await dialogCase(seller, 'seller-palette-preview-focus', seller.locator('.appearance-option button').last(), '.app-modal[open]');
    report.stateEvidence.push({ width, businessBefore: baseline, businessAfter: await business(), browserStateBeforePalettes: preservedBrowser, browserStateAfterPalettes: await browserState(), workerRequests: gateway.records });
    await context.close();context = null;await app.close();app = null;cleanFixture();
  }
  const expectedPerWidth = { 320: { 88: 24, 90: 20, 91: 12 }, 390: { 88: 24, 90: 20, 91: 12 }, 820: { 88: 24, 90: 19, 91: 12 }, 1440: { 88: 24, 90: 18, 91: 12 } };
  report.expectedPerWidth = expectedPerWidth;
  for (const [viewport, expected] of Object.entries(expectedPerWidth)) for (const [id, count] of Object.entries(expected))
  assert.equal(report.cases.filter((row) => row.width === Number(viewport) && row.id === Number(id) && row.status === 'PASS').length, count, `Expected complete#${id}/${viewport} matrix`);
  assert.equal(report.pageErrors.length, 0);assert.equal(report.externalRequests.length, 0);assert.equal(report.unexpectedDialogs.length, 0);assert.deepEqual(hashes(), report.sourceHashes);
} catch (error) {
  process.exitCode = 1;console.error(redact(error));
  if (context) for (const [index, page] of context.pages().entries()) {
    try {if ((await page.locator('#password').count()) && (await page.locator('#password').inputValue())) continue;
      await page.screenshot({ path: out + `/failure-page${index}-${width}.png`, fullPage: true, timeout: 5000 });} catch {/* Diagnostic capture must not mask the original failure. */}
  }
} finally
{
  if (context) await context.close();await browser.close();if (app) await app.close();cleanFixture();
  report.applicationHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();report.sourceHashesAfter = hashes();
  report.runCompleted = !process.exitCode && report.cleanup.length === 4 && report.cleanup.every((item) => item.temporaryFixtureRemoved);
  report.criterionStatus = [88, 90, 91].map((id) => ({ id, status: report.runCompleted && report.cases.filter((row) => row.id === id).every((row) => row.status === 'PASS') ? 'PASS' : report.cases.some((row) => row.id === id && row.status === 'FAIL') ? 'FAIL' : 'UNVERIFIED', cases: report.cases.filter((row) => row.id === id).length }));
  report.limits = ['Local single-company routes and DOM keyboard/dialog checks only; no complete accessibility certification', 'Native browser delete confirmation uses dismiss API; native OS keyboard Escape untested',
  'Shared update confirmation is an isolated component fixture; no waiting-worker/PWA lifecycle recertification', 'English only; criterion89 seven-locales/long-controls not recertified',
  'No real devices/Edge, screen reader, browser zoom/criterion92, admin prototype, offline/error route matrix, real auth challenge or provider flow tested', 'CI unchanged; independent command only'];
  writeFileSync(out + '/results.json', JSON.stringify(report, null, 2));console.log(JSON.stringify({ head, runCompleted: report.runCompleted, criteria: report.criterionStatus, cleanup: report.cleanup }));
}
