import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
import { createApp } from '../src/server.js';
import { createApi } from '../src/app.js';
import { serveStatic } from '../src/static.js';
import worker from '../src/worker.js';
import { shopObjectName } from '../src/shop-setup.js';
import { errorResponse } from '../src/http.js';

const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/pwa-lifecycle');mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const historicalHead = process.env.QA_PREDECESSOR_HEAD || 'fb3ee4074d07b630cb2862bdbf390e35224cd059',targetHead = head;
const gitBytes = (ref, path) => execFileSync('git', ['show', ref + ':' + path], { maxBuffer: 32 * 1024 * 1024 });
const oldApp = Object.fromEntries(['shop', 'seller'].map((surface) => [surface, /v\d+/.exec(gitBytes(historicalHead, `public/${surface}/version.js`).toString())[0]]));
const currentApp = Object.fromEntries(['shop', 'seller'].map((surface) => [surface, /v\d+/.exec(gitBytes(targetHead, 'public/' + surface + '/version.js').toString())[0]]));
const oldWorkers = Object.fromEntries(['shop', 'seller'].map((surface) => [surface, /version:\s*['"](v\d+)/.exec(gitBytes(historicalHead, 'public/' + surface + '/sw.js').toString())[1]]));
const focusFixed = gitBytes(historicalHead, 'public/shared/modal.js').toString().includes('export function containDialogFocus');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const path of execFileSync('git', ['ls-tree', '-r', '--name-only', targetHead, 'public', 'src'], { encoding: 'utf8' }).trim().split('\n')) assert.equal(digest(readFileSync(path)), digest(gitBytes(targetHead, path)), 'Application bytes differ from reviewed110: ' + path);
const assetBytes = new Map();
const config = { dbPath: ':memory:', shopMode: 'public-demo', demoRevision: 'pwa-qa',
  username: 'synthetic_pwa', password: randomUUID() + randomUUID(), production: false, publicOrigin: null };
const app = await createApp(config),api = await createApi({ store: app.database, config });
const phase = { sourceHead: historicalHead }; // Serve full committed public bytes, including app.js, not changed labels.
const requests = [],controls = { holdProduct: false, releaseProduct: null, holdOrder: false, releaseOrder: null },staticRequests = [];
const env = { SHOP_MODE: config.shopMode, SHOP_DEMO_REVISION: config.demoRevision,
  ASSETS: { async fetch(request) {
      const path = new URL(request.url).pathname,sourceHead = phase.sourceHead;
      const result = await serveStatic(request, path);
      if (result.status !== 200) return result;
      const file = 'public' + decodeURIComponent(path) + (path.endsWith('/') ? 'index.html' : '');
      const key = sourceHead + ':' + file;
      if (!assetBytes.has(key)) assetBytes.set(key, gitBytes(sourceHead, file));
      const bytes = assetBytes.get(key),headers = new Headers(result.headers);
      headers.set('content-length', String(bytes.length));staticRequests.push({ path, file, sourceHead, sha256: digest(bytes), bytes: bytes.length });
      return new Response(request.method === 'HEAD' ? null : bytes, { status: result.status, headers });
    } }, SHOP: { idFromName: (name) => name, get(id) {
      assert.equal(id, shopObjectName(config.shopMode, config.demoRevision));
      return { async fetch(request) {
          const path = new URL(request.url).pathname;
          const record = { method: request.method, path, bodyBytes: (await request.clone().arrayBuffer()).byteLength, workerForwarded: true };
          requests.push(record);
          if (controls.holdProduct && request.method === 'PATCH' && path.startsWith('/api/v1/seller/products/')) {
            record.heldForBusyGuard = true;
            await new Promise((resolve) => {controls.releaseProduct = resolve;});
            controls.holdProduct = false;controls.releaseProduct = null;
          }
          if (controls.holdOrder && request.method === 'POST' && path === '/api/v1/orders') {
            record.heldForBusyGuard = true;await new Promise((resolve) => {controls.releaseOrder = resolve;});
            controls.holdOrder = false;controls.releaseOrder = null;
          }
          const result = await api(request, { clientAddress: 'synthetic-loopback' });record.status = result.status;return result;
        } };
    } } };
app.server.removeAllListeners('request');
app.server.on('request', async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
    const request = new Request(new URL(incoming.url, 'http://' + incoming.headers.host), { method: incoming.method, headers,
      ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
    let result;try {result = await worker.fetch(request, env);} catch (error) {result = errorResponse(error);}
    const outputHeaders = Object.fromEntries([...result.headers].filter(([name]) => name !== 'set-cookie'));
    const cookies = result.headers.getSetCookie();if (cookies.length) outputHeaders['set-cookie'] = cookies;
    const bytes = result.body ? Buffer.from(await result.arrayBuffer()) : null;
    outgoing.writeHead(result.status, outputHeaders);outgoing.end(bytes);
  } catch (error) {outgoing.writeHead(500);outgoing.end('Synthetic PWA harness error');console.error(error);}
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const product = await app.database.get("SELECT id, name FROM product WHERE sku='DEMO-020'");
const productPath = '/api/v1/seller/products/' + product.id;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
const seller = await context.newPage(),customer = await context.newPage();
const report = { sourceHead: head, versions: { shop: `${currentApp.shop}`, seller: `${currentApp.seller}` }, gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), scope: 'Real native Chromium SW update with full genuine Git bytes, one worker, disposable in-memory SQLite; no production', dialogChecks: [],
  predecessor: { shop: oldApp.shop, seller: oldApp.seller, workers: { shop: `${oldWorkers.shop}`, seller: `${oldWorkers.seller}` }, sourceHead: historicalHead, source: 'Full historical Git public bytes for every asset' }, targetAssetSourceHead: targetHead, sellerHistory: 'Genuine committed predecessor to current85 worker; no asset version relabelling',
  browser: browser.version(), cases: [], pageErrors: [], consoleErrors: [], requestFailures: [], externalRequests: [], navigations: [], requests, staticRequests,
  sourceHashes: Object.fromEntries(['public/shared/sw-core.js', 'public/shared/pwa.js', 'public/shared/update-guard.js', 'public/shop/update-view.js', 'public/shop/sw.js', 'public/seller/sw.js', 'public/shop/version.js', 'public/seller/version.js'].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) };
let stage = 'setup';
for (const [name, page] of [['seller', seller], ['customer', customer]]) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.pageErrors.push({ name, stage, error: error.message }));
  page.on('console', (message) => {if (message.type() === 'error') report.consoleErrors.push({ name, stage, text: message.text() });});
  page.on('requestfailed', (request) => report.requestFailures.push({ name, stage, path: new URL(request.url()).pathname, failure: request.failure()?.errorText }));
  page.on('framenavigated', (frame) => {if (frame === page.mainFrame()) report.navigations.push({ name, stage, url: frame.url() });});
}
await context.route('https://**/*', (route) => {report.externalRequests.push(route.request().url());return route.abort();});
const checked = async (name, fn) => {stage = name;try {const result = await fn();report.cases.push({ name, status: 'PASS', ...(result ? { result } : {}) });console.log('PASS ' + name);}
  catch (error) {report.cases.push({ name, status: 'FAIL', error: error.message.replaceAll(config.password, '[REDACTED]') });throw error;}};
const swState = (page, scope) => page.evaluate(async (scope) => {
  const version = (worker) => worker ? new Promise((resolve) => {const channel = new MessageChannel();const timeout = setTimeout(() => resolve('TIMEOUT'), 3000);
    channel.port1.onmessage = (event) => {clearTimeout(timeout);channel.port1.close();resolve(event.data.version);};worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);}) : null;
  const registration = await navigator.serviceWorker.getRegistration(scope);
  return { scope: registration?.scope, controllerURL: navigator.serviceWorker.controller?.scriptURL || null,
    controller: await version(navigator.serviceWorker.controller), active: await version(registration?.active), waiting: await version(registration?.waiting),
    controllerState: navigator.serviceWorker.controller?.state || null, activeState: registration?.active?.state || null, waitingState: registration?.waiting?.state || null,
    caches: await caches.keys() };
}, scope);
const cartBytes = (page) => page.evaluate(async () => (await (await import('/shop/cart.js')).createCartStore()).list());
const galleryIDs = async () => JSON.parse((await app.database.get('SELECT gallery_layout_json FROM product WHERE id=?', product.id)).gallery_layout_json || 'null');
const openEditor = async () => {await seller.goto(origin + '/seller/#products/' + product.id);await seller.locator('.product-gallery-item').first().waitFor();};
const shopCheck = async () => {await customer.evaluate(() => {location.hash = '#settings';});await customer.locator('.shop-update-settings .outline-button').click();};
const sellerCheck = async () => {await seller.locator('#account-button').click();await seller.locator('#check-updates-button').click();await seller.locator('#account-button').click();};
let initialCart, savedGallery, savedSellerName;
const poll = async (fn) => {for (let n = 0; n < 150; n++) {if (fn()) return;await new Promise((r) => setTimeout(r, 20));}throw new Error('Synthetic held request not reached');};
const orders = async () => Object.fromEntries(await Promise.all(await Promise.all(await Promise.all(await Promise.all(['shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency', 'order_sequence'].map(async (table) => [table, await app.database.all('SELECT * FROM ' + table)]))))));
const cachedApp = async (page, name) => page.evaluate(async (name) => {
  const cache = await caches.open(name),response = await cache.match('/shop/app.js');
  return Array.from(new Uint8Array(await response.arrayBuffer()));
}, name);
const shopUpdate = () => customer.locator('.shop-update-settings .primary-button');
const addTwo = async () => {await customer.evaluate((id) => {location.hash = '#product/' + id;}, product.id);await customer.locator('#product-view').waitFor({ state: 'visible' });await customer.locator('.product-add').waitFor();await customer.locator('#detail-quantity').fill('2');await customer.locator('.product-add').click();await customer.waitForFunction(() => document.querySelector('#cart-count').textContent === '2');};

const modalAudit = async (page, label, opener) => {
  await page.bringToFront();const dialog = page.locator('.app-modal-confirm[open]');await dialog.waitFor();
  const name = await dialog.getAttribute('aria-label');assert.ok(name);const trace = [];
  if (focusFixed) {
    const count = await dialog.evaluate((node) => {const items = [...node.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter((x) => !x.matches(':disabled') && x.tabIndex >= 0 && x.getClientRects().length);items[0].focus();return items.length;});
    for (let n = 0; n < count + 1; n++) {await page.keyboard.press('Tab');trace.push(await dialog.evaluate((node) => ({ inside: node.contains(document.activeElement), documentHasFocus: document.hasFocus(), className: document.activeElement.className })));}
    await dialog.evaluate((node) => node.querySelector('button').focus());await page.keyboard.press('Shift+Tab');trace.push(await dialog.evaluate((node) => ({ inside: node.contains(document.activeElement), documentHasFocus: document.hasFocus(), className: document.activeElement.className })));
    assert.ok(trace.every((x) => x.inside && x.documentHasFocus));
  }
  await dialog.screenshot({ path: out + '/' + label + '-confirm.png' });report.dialogChecks.push({ label, accessibleName: name, sourceHead: historicalHead, focusContainment: focusFixed ? 'PASS' : 'Legacy source lacks current fix; not reclassified', trace });
  await page.keyboard.press('Escape');await page.locator('.app-modal-confirm').waitFor({ state: 'detached' });assert.equal(await opener.evaluate((x) => x === document.activeElement), true);
};
const holdNativeActivation = async (page) => page.evaluate(() => {
  window.qaActualControllerVersion = null;const observe = () => {const w = navigator.serviceWorker.controller;if (!w) return;const c = new MessageChannel();c.port1.onmessage = (e) => {window.qaActualControllerVersion = e.data.version;c.port1.close();};w.postMessage({ type: 'GET_VERSION' }, [c.port2]);};navigator.serviceWorker.addEventListener('controllerchange', observe);observe();
  const native = ServiceWorker.prototype.postMessage;window.qaNativePostMessage = native;
  ServiceWorker.prototype.postMessage = function (data, ...args) {if (data?.type === 'SKIP_WAITING') {window.qaHeldActivation = { worker: this, data, args };return;}return native.call(this, data, ...args);};
});
const releaseNativeActivation = async (page) => page.evaluate(() => {const p = window.qaHeldActivation;if (!p) throw new Error('No native activation held');ServiceWorker.prototype.postMessage = window.qaNativePostMessage;window.qaNativePostMessage.call(p.worker, p.data, ...p.args);delete window.qaHeldActivation;});

try {
  await checked('Genuine predecessor install claims separate scopes and caches exact old app bytes', async () => {
    await seller.goto(origin + '/seller/');await seller.locator('#username').fill(config.username);await seller.locator('#password').fill(config.password);
    await seller.locator('#login-form').evaluate((form) => form.requestSubmit());await seller.locator('#workspace').waitFor({ state: 'visible' });await openEditor();
    await customer.goto(origin + '/shop/#product/' + product.id);await customer.locator('.product-add').waitFor();
    for (const page of [seller, customer]) await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const shop = await swState(customer, '/shop/'),sell = await swState(seller, '/seller/');
    assert.equal(shop.controller, `${oldWorkers.shop}`);assert.equal(sell.controller, `${oldWorkers.seller}`);assert.equal(shop.scope, origin + '/shop/');assert.equal(sell.scope, origin + '/seller/');
    assert.ok(shop.caches.includes(`os-shop-${oldWorkers.shop}`));assert.ok(shop.caches.includes(`os-seller-${oldWorkers.seller}`));
    const appHash = digest(Buffer.from(await cachedApp(customer, `os-shop-${oldWorkers.shop}`)));assert.equal(appHash, digest(gitBytes(historicalHead, 'public/shop/app.js')));
    await customer.evaluate(async () => {await (await caches.open('qa-unrelated')).put('/qa-unrelated-marker', new Response('Fictional QA preference marker'));localStorage.setItem('qa-preserved-preference', 'fictional-keep');});
    report.initialWorkers = { shop, seller: sell, cachedAppSHA256: appHash };return { shop: `${oldWorkers.shop}`, seller: `${oldWorkers.seller}`, sourceHead: historicalHead, actualCachedAppSHA256: appHash };
  });
  await checked('Controlled predecessor launch uses genuine cached shell before drafts', async () => {
    const before = { shop: await swState(customer, '/shop/'), seller: await swState(seller, '/seller/') };
    await customer.reload();await customer.locator('.product-add').waitFor();await seller.reload();await seller.locator('.product-gallery-item').first().waitFor();
    assert.equal((await swState(customer, '/shop/')).controller, `${oldWorkers.shop}`);assert.equal((await swState(seller, '/seller/')).controller, `${oldWorkers.seller}`);
    report.controlledLaunch = { nativeReloadBeforeAnyDraft: true, sourceHead: historicalHead, appVersions: oldApp, workerVersions: before, known8abBootstrapMismatch: focusFixed };return report.controlledLaunch;
  });
  await checked('Native110/85 waiting labels preserve Customer cart/Profile and Seller gallery draft', async () => {
    await addTwo();initialCart = await cartBytes(customer);
    await customer.evaluate(() => {location.hash = '#profile';});await customer.locator('#profile-form [name=fullName]').fill('Fictional PWA buyer');await customer.locator('#profile-form [name=email]').fill('pwa-buyer@example.invalid');
    await seller.locator('[name=name]').fill('Fictional PWA saved draft');await seller.locator('[name=description]').fill('Fictional unsaved description');
    await seller.locator('.product-gallery-item').last().locator('[data-gallery-action=remove]').click();assert.equal(await seller.locator('.product-gallery-item').count(), 5);
    phase.sourceHead = targetHead;await shopCheck();await sellerCheck();
    await customer.waitForFunction((expectedVersions) => [...document.querySelectorAll('.shop-update-settings .primary-button')].some((x) => !x.hidden && x.textContent.includes(`${expectedVersions.v110}`)), { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });
    await seller.waitForFunction(expected => document.querySelector('#install-update-button')?.textContent.includes(expected), currentApp.seller);
    assert.equal((await swState(customer, '/shop/')).waiting, `${currentApp.shop}`);assert.equal((await swState(seller, '/seller/')).waiting, `${currentApp.seller}`);
    assert.match(await seller.locator('#install-update-button').innerText(), new RegExp(currentApp.seller));assert.match(await seller.locator('#seller-current-version').innerText(), new RegExp(oldApp.seller));
    assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional PWA saved draft');assert.equal(await seller.locator('.product-gallery-item').count(), 5);
    assert.deepEqual(await cartBytes(customer), initialCart);assert.equal((await app.database.get('SELECT name FROM product WHERE id=?', product.id)).name, product.name);
    await seller.screenshot({ path: out + '/seller-waiting85-draft.png', fullPage: true });await customer.screenshot({ path: out + '/customer109-waiting110.png', fullPage: true });
    return { loadedShop: oldApp.shop, waitingShop: `${currentApp.shop}`, loadedSeller: oldApp.seller, waitingSeller: `${currentApp.seller}`, cartQuantity: 2, sellerDraftImages: 5 };
  });
  await checked('Dirty Customer update cancellation leaves actual109 controller, Profile, cart and Seller draft unchanged', async () => {
    await shopUpdate().click();await modalAudit(customer, 'customer-real-update', shopUpdate());await shopUpdate().click();await customer.locator('.app-modal-confirm[open]').waitFor();await customer.locator('.app-modal-confirm .modal-secondary-button').click();await customer.locator('.app-modal-confirm').waitFor({ state: 'detached' });
    assert.equal((await swState(customer, '/shop/')).controller, `${oldWorkers.shop}`);await customer.evaluate(() => {location.hash = '#profile';});
    assert.equal(await customer.locator('#profile-form [name=fullName]').inputValue(), 'Fictional PWA buyer');assert.deepEqual(await cartBytes(customer), initialCart);
    assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional PWA saved draft');assert.equal(await seller.locator('.product-gallery-item').count(), 5);
  });
  await checked('Real busy Customer POST prevents110 activation, then completes one simulation order', async () => {
    await customer.locator('#profile-form [type=submit]').click();await customer.waitForFunction(() => Boolean(document.querySelector('#profile-status').textContent));
    await customer.evaluate(() => {location.hash = '#addresses';});await customer.locator('#add-address').click();const form = customer.locator('.address-form');
    await form.locator('[name=fullName]').fill('Fictional PWA recipient');await form.locator('[name=phone]').fill('123456789');await form.locator('[name=line1]').fill('Fictional PWA Street');await form.locator('[name=city]').fill('Kuala Lumpur');await form.locator('[name=postcode]').fill('50000');await form.locator('[name=city]').click();await form.locator('[type=submit]').click();await form.waitFor({ state: 'hidden' });
    await customer.evaluate(() => {location.hash = '#cart';});await customer.locator('#cart-list .cart-row').waitFor();await customer.locator('#checkout-button').click();await customer.locator('#checkout-view').waitFor({ state: 'visible' });await customer.waitForFunction(() => !document.querySelector('#submit-order').disabled);
    controls.holdOrder = true;const committed = customer.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');await customer.locator('#submit-order').click();await poll(() => controls.releaseOrder);
    await customer.evaluate(() => {location.hash = '#settings';});assert.equal(await shopUpdate().isDisabled(), true);assert.equal((await swState(customer, '/shop/')).controller, `${oldWorkers.shop}`);
    await customer.screenshot({ path: out + '/customer109-busy-blocks110.png', fullPage: true });controls.releaseOrder();assert.equal((await committed).status(), 201);await customer.locator('#receipt-view').waitFor({ state: 'visible' });
    assert.equal((await app.database.get('SELECT count(*) n FROM shop_order')).n, 1);assert.equal((await cartBytes(customer)).length, 0);await addTwo();assert.deepEqual(await cartBytes(customer), initialCart);
    return { heldRealOrderPOST: true, waitingShop: `${currentApp.shop}`, actualControllerWhileBusy: `${oldWorkers.shop}`, simulationOrders: 1, updateDisabled: true };
  });
  await checked('Native110 activation defers late Profile reload while Seller waiting85 busy save blocks update', async () => {
    await customer.evaluate(() => {location.hash = '#profile';});await customer.locator('#profile-form [name=fullName]').fill('Fictional before activation draft');await customer.evaluate(() => {location.hash = '#settings';});
    await customer.evaluate(() => {
      window.qaControllerVersions = [];const observeVersion = () => {const controller = navigator.serviceWorker.controller;if (!controller) return;const channel = new MessageChannel();channel.port1.onmessage = (event) => {window.qaActualControllerVersion = event.data.version;window.qaControllerVersions.push(event.data.version);channel.port1.close();};controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);};
      navigator.serviceWorker.addEventListener('controllerchange', observeVersion);observeVersion();const native = ServiceWorker.prototype.postMessage;window.qaNativePostMessage = native;
      ServiceWorker.prototype.postMessage = function (data, ...args) {if (data?.type === 'SKIP_WAITING') {window.qaHeldActivation = { worker: this, data, args };return;}return native.call(this, data, ...args);};
    });
    await shopUpdate().click();await customer.locator('.app-modal-confirm[open]').waitFor();await customer.locator('.app-modal-confirm .primary-button').click();await customer.waitForFunction(() => Boolean(window.qaHeldActivation));
    await customer.evaluate(() => {location.hash = '#profile';});await customer.locator('#profile-form [name=fullName]').fill('Fictional late PWA draft');
    controls.holdProduct = true;await seller.locator('#product-save').click();await poll(() => controls.releaseProduct);assert.equal(await seller.locator('#install-update-button').isDisabled(), true);
    const before = report.navigations.filter((x) => x.name === 'customer').length;
    await customer.evaluate(() => {const pending = window.qaHeldActivation;ServiceWorker.prototype.postMessage = window.qaNativePostMessage;window.qaNativePostMessage.call(pending.worker, pending.data, ...pending.args);delete window.qaHeldActivation;});
    await customer.waitForFunction((expectedVersions) => window.qaActualControllerVersion === `${expectedVersions.v110}`, { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });await customer.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await customer.waitForFunction(() => !document.querySelector('.shop-update-settings .primary-button').disabled);
    assert.equal(report.navigations.filter((x) => x.name === 'customer').length, before);assert.match(await customer.locator('.shop-update-settings').innerText(), new RegExp('Shop ' + oldApp.shop));assert.equal(await customer.locator('#profile-form [name=fullName]').inputValue(), 'Fictional late PWA draft');
    assert.equal((await swState(seller, '/seller/')).controller, `${oldWorkers.seller}`);assert.equal(await seller.locator('.product-gallery-item').count(), 5);
    controls.releaseProduct();await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');savedGallery = await galleryIDs();assert.equal(savedGallery.length, 5);
    await customer.screenshot({ path: out + '/customer-late-edit-reload-deferred.png', fullPage: true });
    report.shopActivationDeferred = await swState(customer, '/shop/');return { actualController: `${currentApp.shop}`, loadedUI: oldApp.shop, automaticReloads: 0, lateDraftPreserved: true, unchangedSellerBusySaveCompleted: true, instrumentation: 'Delay only outgoing SKIP_WAITING, then forward to native waiting worker' };
  });
  await checked('Customer clean reload loads exact110 bytes, preserves storage and independent Seller84 cache', async () => {
    await customer.locator('#profile-form [type=submit]').click();await customer.waitForFunction(() => Boolean(document.querySelector('#profile-status').textContent));await customer.evaluate(() => {location.hash = '#settings';window.qaBeforeReload = true;});await shopUpdate().click();
    await customer.waitForFunction((expectedVersions) => window.qaBeforeReload === undefined && document.querySelector('.shop-update-settings')?.textContent.includes(`Shop ${expectedVersions.v110}`), { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });const current = await swState(customer, '/shop/');
    assert.equal(current.controller, `${currentApp.shop}`);assert.equal(current.waiting, null);assert.ok(!current.caches.includes(`os-shop-${oldWorkers.shop}`));assert.ok(current.caches.includes(`os-shop-${currentApp.shop}`));assert.ok(current.caches.includes(`os-seller-${oldWorkers.seller}`));assert.ok(current.caches.includes('qa-unrelated'));
    assert.deepEqual(await cartBytes(customer), initialCart);assert.equal(await customer.evaluate(() => localStorage.getItem('qa-preserved-preference')), 'fictional-keep');assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional PWA saved draft');
    const appHash = digest(Buffer.from(await cachedApp(customer, `os-shop-${currentApp.shop}`)));assert.equal(appHash, digest(gitBytes(targetHead, 'public/shop/app.js')));report.shopActivated = { ...current, cachedAppSHA256: appHash };
    return { loadedShop: `${currentApp.shop}`, actualCachedAppSHA256: appHash, historicalSource: historicalHead, targetSource: targetHead, cartAndPreferencePreserved: true, sellerScopeUnchanged: true };
  });

  await checked('Seller dirty native85 update Escape and Cancel preserve draft, gallery and controller', async () => {
    await seller.locator('[name=name]').fill('Fictional accepted Seller draft');const before = await orders();const button = seller.locator('#install-update-button');
    await button.click();await modalAudit(seller, 'seller-real-update', button);assert.equal((await swState(seller, '/seller/')).controller, `${oldWorkers.seller}`);
    await button.click();await seller.locator('.app-modal-confirm[open]').waitFor();await seller.locator('.app-modal-confirm .modal-secondary-button').click();await seller.locator('.app-modal-confirm').waitFor({ state: 'detached' });
    assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional accepted Seller draft');assert.equal(await seller.locator('.product-gallery-item').count(), 5);assert.deepEqual(await orders(), before);return { actualOldUI: oldApp.seller, controller: `${oldWorkers.seller}`, waiting: `${currentApp.seller}`, businessWrites: 0 };
  });
  await checked('Native Seller85 activation defers reload after late edit and preserves other Seller tab', async () => {
    const peer = await context.newPage();await peer.goto(origin + '/seller/#products/' + product.id);await peer.locator('.product-gallery-item').first().waitFor();await peer.locator('[name=name]').fill('Fictional other-tab draft');
    const peerBefore = await peer.evaluate(() => location.href);await holdNativeActivation(seller);await seller.locator('#install-update-button').click();await seller.locator('.app-modal-confirm[open]').waitFor();await seller.locator('.app-modal-confirm .primary-button').click();await seller.waitForFunction(() => Boolean(window.qaHeldActivation));
    await seller.locator('[name=name]').fill('Fictional late Seller draft');const before = report.navigations.filter((x) => x.name === 'seller').length;await releaseNativeActivation(seller);
    await seller.waitForFunction((expectedVersions) => window.qaActualControllerVersion === `${expectedVersions.v85}`, { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });await seller.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');await seller.waitForFunction(() => !document.querySelector('#install-update-button').disabled);
    assert.equal(report.navigations.filter((x) => x.name === 'seller').length, before);assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional late Seller draft');assert.match(await seller.locator('#seller-current-version').innerText(), new RegExp(oldApp.seller));
    if (oldApp.seller !== `${currentApp.seller}`) await peer.waitForFunction(() => !document.querySelector('#seller-update-notice').hidden);await peer.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');assert.equal(await peer.evaluate(() => location.href), peerBefore);assert.equal(await peer.locator('[name=name]').inputValue(), 'Fictional other-tab draft');assert.equal((await swState(peer, '/seller/')).controller, `${currentApp.seller}`);
    await seller.screenshot({ path: out + '/seller-late-edit-reload-deferred.png', fullPage: true });await peer.screenshot({ path: out + '/seller-peer-draft-preserved.png', fullPage: true });report.sellerActivationDeferred = await swState(seller, '/seller/');await peer.close();return { nativeController: `${currentApp.seller}`, automaticReloads: 0, lateDraftAndOtherTabPreserved: true };
  });
  await checked('Seller explicit saved reload loads exact85 bytes without an update loop', async () => {
    await seller.locator('#product-save').click();await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');savedSellerName = 'Fictional late Seller draft';
    await seller.evaluate(() => window.qaBeforeReload = true);await seller.locator('#install-update-button').click();await seller.waitForFunction((expectedVersions) => window.qaBeforeReload === undefined && document.querySelector('#seller-current-version')?.textContent.includes(`${expectedVersions.v85}`), { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });await seller.locator('.product-gallery-item').first().waitFor();
    const state = await swState(seller, '/seller/');assert.equal(state.controller, `${currentApp.seller}`);assert.equal(state.waiting, null);assert.ok(!state.caches.includes(`os-seller-${oldWorkers.seller}`));assert.ok(state.caches.includes(`os-shop-${currentApp.shop}`));assert.ok(state.caches.includes(`os-seller-${currentApp.seller}`));assert.equal(await seller.locator('[name=name]').inputValue(), savedSellerName);assert.deepEqual(await galleryIDs(), savedGallery);report.sellerActivated = state;
    return { loadedSeller: `${currentApp.seller}`, controller: `${currentApp.seller}`, galleryPreserved: true, shopCachePreserved: true };
  });
  await checked('Latest110/85 manual update checks fail offline then automatically recover online', async () => {
    const before = await orders();await context.setOffline(true);await shopCheck();await sellerCheck();await customer.waitForFunction(() => document.querySelector('.shop-update-settings [role=status]').textContent.includes('Unable to update'));await seller.waitForFunction(() => document.querySelector('#check-updates-status').textContent.includes('Unable to update'));
    assert.equal(await shopUpdate().isVisible(), false);assert.equal(await seller.locator('#install-update-button').isVisible(), false);assert.deepEqual(await orders(), before);await customer.screenshot({ path: out + '/customer-offline-update-check.png', fullPage: true });await seller.screenshot({ path: out + '/seller-offline-update-check.png', fullPage: true });
    await context.setOffline(false);await customer.waitForFunction(() => document.querySelector('.shop-update-settings [role=status]').textContent.includes('up to date'));await seller.waitForFunction(() => document.querySelector('#check-updates-status').textContent.includes('up to date'));return { offlineFailureRetryable: true, onlineAutomaticRecovery: true, businessWrites: 0 };
  });
  await checked('Offline actual Seller save and Customer submit retain draft/cart and never report committed success', async () => {
    await customer.evaluate(() => {location.hash = '#cart';});await customer.locator('#cart-list .cart-row').waitFor();await customer.locator('#checkout-button').click();await customer.locator('#checkout-view').waitFor({ state: 'visible' });await customer.waitForFunction(() => !document.querySelector('#submit-order').disabled);
    await seller.locator('[name=name]').fill('Fictional offline retained draft');
    const domainBefore = await orders();const writeCount = requests.filter((x) => ['POST', 'PATCH'].includes(x.method)).length;
    await context.setOffline(true);assert.equal(await seller.evaluate(() => navigator.onLine), false);
    await seller.locator('#product-save').click();await seller.waitForFunction(() => Boolean(document.querySelector('#product-form-error').textContent));
    assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional offline retained draft');assert.equal(await seller.locator('.product-gallery-item').count(), 5);
    assert.equal((await app.database.get('SELECT name FROM product WHERE id=?', product.id)).name, savedSellerName);
    await customer.locator('#submit-order').click();await customer.waitForFunction(() => Boolean(document.querySelector('#checkout-error').textContent));
    assert.equal(await customer.locator('#receipt-view').isVisible(), false);assert.equal((await app.database.get('SELECT count(*) n FROM shop_order')).n, 1);assert.deepEqual(await orders(), domainBefore);
    assert.deepEqual(await cartBytes(customer), initialCart);assert.equal(requests.filter((x) => ['POST', 'PATCH'].includes(x.method)).length, writeCount);
    await seller.screenshot({ path: out + '/seller-offline-draft.png', fullPage: true });await customer.screenshot({ path: out + '/customer-offline-submit.png', fullPage: true });
    report.offlineFailures = { serverWritesAdded: 0, ordersBeforeAndAfter: 1, unchangedAllSixOrderTables: true, cartPreserved: true, sellerDraftPreserved: true, actualNetworkOffline: true };
  });
  await checked('Cached offline navigation/retry serves truthful fallback for both scopes without losing other page drafts', async () => {
    const probe = await context.newPage();probe.setDefaultTimeout(15000);
    for (const scope of ['shop', 'seller']) {
      const response = await probe.goto(origin + '/' + scope + '/');assert.equal(response.status(), 200);await probe.locator('#retry').waitFor();
      assert.match(await probe.locator('h1').innerText(), /offline/i);assert.match(await probe.locator('main').innerText(), /cannot be saved offline/i);
      await probe.locator('#retry').click();await probe.locator('#retry').waitFor();assert.match(await probe.locator('h1').innerText(), /offline/i);
      await probe.setViewportSize({ width: 390, height: 844 });await probe.screenshot({ path: out + '/' + scope + '-cached-offline.png', fullPage: true });
    }
    assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional offline retained draft');assert.deepEqual(await cartBytes(customer), initialCart);
    report.offlineFallbacks = { shop: 'cached200', seller: 'cached200', offlineRetry: 'truthful fallback', note: 'Other loaded page draft retained; manually reloading a dirty page is not a persisted draft feature.' };
    await context.setOffline(false);await probe.locator('#retry').click();await probe.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal((await swState(probe, '/seller/')).controller, `${currentApp.seller}`);await probe.close();
  });
  await checked('Reconnect recovers update checks and real API retries; second simulation order and saved draft', async () => {
    assert.equal(await seller.evaluate(() => navigator.onLine), true);
    await seller.locator('#product-save').click();await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');
    assert.equal((await app.database.get('SELECT name FROM product WHERE id=?', product.id)).name, 'Fictional offline retained draft');assert.deepEqual(await galleryIDs(), savedGallery);
    await customer.locator('#submit-order').click();await customer.locator('#receipt-view').waitFor({ state: 'visible' });
    assert.equal((await app.database.get('SELECT count(*) n FROM shop_order')).n, 2);assert.equal((await cartBytes(customer)).length, 0);
    await sellerCheck();await seller.waitForFunction(() => document.querySelector('#check-updates-status').textContent.includes('up to date'));
    await shopCheck();await customer.waitForFunction(() => document.querySelector('.shop-update-settings [role=status]').textContent.includes('up to date'));
    report.reconnect = { sellerSaved: true, twoSimulationOrders: true, cartClearedOnlyAfterCommittedReceipt: true, shop: await swState(customer, '/shop/'), seller: await swState(seller, '/seller/') };
  });
  await checked('Fresh current110/85 installation has matching labels/controllers and no spurious reload request', async () => {
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
    try {const cp = await fresh.newPage(),sp = await fresh.newPage();await cp.goto(origin + '/shop/#settings');await sp.goto(origin + '/seller/');for (const page of [cp, sp]) await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      const cs = await swState(cp, '/shop/'),ss = await swState(sp, '/seller/');assert.equal(cs.controller, `${currentApp.shop}`);assert.equal(ss.controller, `${currentApp.seller}`);assert.equal(cs.waiting, null);assert.equal(ss.waiting, null);
      await cp.waitForFunction((expectedVersions) => document.querySelector('.shop-update-settings')?.textContent.includes(`Shop ${expectedVersions.v110}`), { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });await sp.waitForFunction((expectedVersions) => document.querySelector('#seller-current-version')?.textContent.includes(`${expectedVersions.v85}`), { v110: currentApp.shop, v85: currentApp.seller, v109: oldWorkers.shop, v84: oldWorkers.seller });
      await cp.evaluate(async () => {await (await navigator.serviceWorker.getRegistration('/shop/')).update();});await sp.evaluate(async () => {await (await navigator.serviceWorker.getRegistration('/seller/')).update();});
      assert.equal(await cp.locator('.shop-update-settings .primary-button').evaluate((x) => x.hidden), true);assert.equal(await sp.locator('#seller-update-notice').evaluate((x) => x.hidden), true);
      report.freshInstall = { shop: cs, seller: ss, spuriousUpdate: false };await cp.screenshot({ path: out + '/fresh-shop110.png', fullPage: true });await sp.screenshot({ path: out + '/fresh-seller85.png', fullPage: true });return report.freshInstall;
    } finally {await fresh.close();}
  });
  await checked('Actual cache inspection excludes API/private responses and retains independent scopes/unrelated cache', async () => {
    const cacheContents = await customer.evaluate(async () => {
      const result = [];
      for (const name of await caches.keys()) {const cache = await caches.open(name);const records = [];
        for (const request of await cache.keys()) {const response = await cache.match(request);const type = response.headers.get('content-type') || '';
          const text = /text|javascript|json/.test(type) ? await response.text() : '';
          records.push({ path: new URL(request.url).pathname, containsSyntheticContact: text.includes('Fictional PWA buyer') || text.includes('pwa-buyer@example.invalid') || text.includes('Fictional PWA Street') });}
        result.push({ name, records });}
      return result;
    });
    for (const cache of cacheContents) for (const item of cache.records) {assert.ok(!item.path.startsWith('/api/'));assert.equal(item.containsSyntheticContact, false);}
    assert.deepEqual(cacheContents.map((x) => x.name).sort(), [`os-seller-${currentApp.seller}`, `os-shop-${currentApp.shop}`, 'qa-unrelated'].sort());
    const shop = cacheContents.find((x) => x.name === `os-shop-${currentApp.shop}`),sell = cacheContents.find((x) => x.name === `os-seller-${currentApp.seller}`);
    assert.ok(shop.records.some((x) => x.path === '/shop/offline.html'));assert.ok(sell.records.some((x) => x.path === '/seller/offline.html'));
    assert.ok(!shop.records.some((x) => x.path.startsWith('/seller/')));assert.ok(!sell.records.some((x) => x.path === '/shop/' || x.path === '/shop/index.html'));
    report.cacheContents = cacheContents;report.cachedByteProof = await customer.evaluate(async () => {const result = [];for (const name of await caches.keys()) {if (!name.startsWith('os-')) continue;const cache = await caches.open(name);for (const request of await cache.keys()) {const path = new URL(request.url).pathname,response = await cache.match(request),bytes = await response.arrayBuffer(),hash = await crypto.subtle.digest('SHA-256', bytes);result.push({ cache: name, path, sha256: [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join(''), bytes: bytes.byteLength });}}return result;});for (const item of report.cachedByteProof) {const file = 'public' + item.path + (item.path.endsWith('/') ? 'index.html' : '');assert.equal(item.sha256, digest(gitBytes(targetHead, file)), item.path);}assert.equal(report.pageErrors.length, 0);assert.equal(report.externalRequests.length, 0);
    await customer.screenshot({ path: out + '/customer-current110-reconnect.png', fullPage: true });await seller.screenshot({ path: out + '/seller-current85-reconnect.png', fullPage: true });
  });
} catch (error) {report.failureWorkers = { shop: await swState(customer, '/shop/').catch(() => null), seller: await swState(seller, '/seller/').catch(() => null) };process.exitCode = 1;console.error(error.stack?.replaceAll(config.password, '[REDACTED]'));} finally
{
  controls.releaseProduct?.();controls.releaseOrder?.();report.sourceHashesAfter = Object.fromEntries(Object.keys(report.sourceHashes).map((path) => [path, digest(readFileSync(path))]));assert.deepEqual(report.sourceHashesAfter, report.sourceHashes);report.applicationHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.runCompleted = !process.exitCode;report.boundaries = { actualHistory: historicalHead + ' to ' + targetHead, genuineStaticBytes: true, oldLoadedVersions: oldApp, oldWorkerVersions: { shop: `${oldWorkers.shop}`, seller: `${oldWorkers.seller}` }, newWorkerVersions: { shop: `${currentApp.shop}`, seller: `${currentApp.seller}` }, currentModalFocusSourceExercised: focusFixed, physicalIOS: 'UNVERIFIED', realEdge: 'UNVERIFIED', production: 'UNVERIFIED', sourceEdited: false };
  writeFileSync(out + '/pwa-results.json', JSON.stringify(report, null, 2));console.log(JSON.stringify({ head, cases: report.cases.map(({ name, status, error }) => ({ name, status, error })), pageErrors: report.pageErrors, externalRequests: report.externalRequests.length }));
  await context.close();await browser.close();await app.close();report.cleanup = { browserAndServerClosed: true, inMemoryDatabaseClosed: true };writeFileSync(out + '/pwa-results.json', JSON.stringify(report, null, 2));
}
