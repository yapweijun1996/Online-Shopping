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

const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/pwa-seller-followup');mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const historicalHead = process.env.QA_PREDECESSOR_HEAD || 'ca882f11d4fa0a58188b7637c936b0361b153723',targetHead = process.env.QA_APPLICATION_TARGET_HEAD || head;
const gitBytes = (ref, path) => execFileSync('git', ['show', ref + ':' + path], { maxBuffer: 32 * 1024 * 1024 });
const oldApp = Object.fromEntries(['shop', 'seller'].map((surface) => [surface, /v\d+/.exec(gitBytes(historicalHead, `public/${surface}/version.js`).toString())[0]]));
const newSeller = /v\d+/.exec(gitBytes(targetHead, 'public/seller/version.js').toString())[0];
assert.equal(oldApp.shop, 'v110');assert.ok(['v85', 'v86', 'v87', 'v88'].includes(oldApp.seller));assert.ok(['v86', 'v87', 'v88', 'v89'].includes(newSeller));
for (const surface of ['shop', 'seller']) assert.equal(/version:\s*'(v\d+)'/.exec(gitBytes(historicalHead, `public/${surface}/sw.js`).toString())[1], oldApp[surface]);
const focusFixed = gitBytes(historicalHead, 'public/shared/modal.js').toString().includes('export function containDialogFocus');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const path of execFileSync('git', ['ls-tree', '-r', '--name-only', targetHead, 'public', 'src'], { encoding: 'utf8' }).trim().split('\n')) assert.equal(digest(readFileSync(path)), digest(gitBytes(targetHead, path)), 'Application bytes differ from reviewed target: ' + path);
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
const report = { sourceHead: head, versions: { shop: 'v110', seller: newSeller }, gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), scope: 'Real native Chromium SW update with full genuine Git bytes, one worker, disposable in-memory SQLite; no production', dialogChecks: [],
  predecessor: { shop: oldApp.shop, seller: oldApp.seller, workers: { shop: 'v110', seller: oldApp.seller }, sourceHead: historicalHead, source: 'Full historical Git public bytes for every asset' }, targetAssetSourceHead: targetHead, sellerHistory: 'Genuine committed predecessor to current Seller worker; no asset version relabelling',
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
const orders = async () => Object.fromEntries(await Promise.all(await Promise.all(['shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency', 'order_sequence'].map(async (table) => [table, await app.database.all('SELECT * FROM ' + table)]))));
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

const money = async () => await app.database.all('SELECT id,price_minor,currency FROM product ORDER BY id');
const baselineMoney = await money(),baselineOrders = await orders();
const productRow = async () => await app.database.get('SELECT * FROM product WHERE id=?', product.id);
const sellerSave = async (name) => {await seller.locator('[name=name]').fill(name);await seller.locator('#product-save').click();await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');assert.equal((await productRow()).name, name);};
let peer;
try {
  await checked('Genuine predecessor controlled install has matching labels, native workers and separate Shop110/Seller predecessor scopes', async () => {
    await seller.goto(origin + '/seller/');await seller.locator('#username').fill(config.username);await seller.locator('#password').fill(config.password);await seller.locator('#login-form').evaluate((f) => f.requestSubmit());await seller.locator('#workspace').waitFor({ state: 'visible' });await openEditor();
    await customer.goto(origin + '/shop/#product/' + product.id);await customer.locator('.product-add').waitFor();for (const p of [seller, customer]) await p.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await customer.reload();await customer.locator('.product-add').waitFor();await seller.reload();await seller.locator('.product-gallery-item').first().waitFor();
    const c = await swState(customer, '/shop/'),s = await swState(seller, '/seller/');assert.equal(c.controller, 'v110');assert.equal(s.controller, oldApp.seller);assert.equal(c.scope, origin + '/shop/');assert.equal(s.scope, origin + '/seller/');assert.equal(s.waiting, null);assert.match(await seller.locator('#seller-current-version').innerText(), new RegExp(oldApp.seller));report.initialWorkers = { shop: c, seller: s };return report.initialWorkers;
  });
  await checked('Normal predecessor gallery Save commits exactly the initiating product; Customer cart/Profile/preferences persist', async () => {
    await addTwo();initialCart = await cartBytes(customer);await customer.evaluate(() => location.hash = '#profile');await customer.locator('#profile-form [name=fullName]').fill('Fictional PWA buyer');await customer.locator('#profile-form [name=email]').fill('pwa-buyer@example.invalid');await customer.locator('#profile-form [type=submit]').click();await customer.waitForFunction(() => Boolean(document.querySelector('#profile-status').textContent));
    await customer.evaluate(async () => {await (await caches.open('qa-unrelated')).put('/qa-unrelated-marker', new Response('Fictional QA marker'));localStorage.setItem('qa-preserved-preference', 'fictional-keep');});
    await seller.locator('.product-gallery-item').last().locator('[data-gallery-action=remove]').click();await sellerSave('Fictional normal85 saved');savedGallery = await galleryIDs();assert.equal(savedGallery.length, 5);savedSellerName = (await productRow()).name;return { savedImages: 5, cartQuantity: 2, normalSaveCommitted: true };
  });
  await checked('Genuine target waiting label preserves predecessor draft; unchanged Shop110 advertises no update', async () => {
    await seller.locator('[name=name]').fill('Fictional waiting draft');phase.sourceHead = targetHead;await sellerCheck();await shopCheck();
    await seller.waitForFunction((v) => document.querySelector('#install-update-button')?.textContent.includes(v), newSeller);const s = await swState(seller, '/seller/'),c = await swState(customer, '/shop/');assert.equal(s.waiting, newSeller);assert.equal(s.controller, oldApp.seller);assert.equal(c.waiting, null);assert.equal(c.controller, 'v110');assert.equal(await shopUpdate().isVisible(), false);assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional waiting draft');assert.deepEqual(await cartBytes(customer), initialCart);assert.equal((await productRow()).name, savedSellerName);await seller.screenshot({ path: out + '/seller-predecessor-waiting-draft.png', fullPage: true });return { loaded: oldApp.seller, waiting: newSeller, shopUpdate: false };
  });
  await checked('Dirty predecessor update Escape/Cancel and keyboard focus keep draft without activation or writes', async () => {
    const before = await productRow(),b = seller.locator('#install-update-button');await b.click();await modalAudit(seller, 'seller-predecessor-update', b);await b.click();await seller.locator('.app-modal-confirm[open]').waitFor();await seller.locator('.app-modal-confirm .modal-secondary-button').click();await seller.locator('.app-modal-confirm').waitFor({ state: 'detached' });assert.equal((await swState(seller, '/seller/')).controller, oldApp.seller);assert.deepEqual(await productRow(), before);assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional waiting draft');return { writes: 0, controller: oldApp.seller, focusRestored: true };
  });
  await checked('Held real predecessor PATCH blocks update activation and finishes its normal Save', async () => {
    controls.holdProduct = true;await seller.locator('#product-save').click();await poll(() => controls.releaseProduct);assert.equal(await seller.locator('#install-update-button').isDisabled(), true);assert.equal((await swState(seller, '/seller/')).controller, oldApp.seller);controls.releaseProduct();await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');assert.equal((await productRow()).name, 'Fictional waiting draft');savedSellerName = (await productRow()).name;assert.deepEqual(await galleryIDs(), savedGallery);return { actualPATCH200: true, updateBlockedWhileBusy: true };
  });
  await checked('Native target activation defers reload after late edit and preserves dirty peer tab', async () => {
    peer = await context.newPage();await peer.goto(origin + '/seller/#products/' + product.id);await peer.locator('.product-gallery-item').first().waitFor();await peer.locator('[name=name]').fill('Fictional peer draft');const href = await peer.evaluate(() => location.href);
    await seller.locator('[name=name]').fill('Fictional accepted draft');await holdNativeActivation(seller);await seller.locator('#install-update-button').click();await seller.locator('.app-modal-confirm[open]').waitFor();await seller.locator('.app-modal-confirm .primary-button').click();await seller.waitForFunction(() => Boolean(window.qaHeldActivation));await seller.locator('[name=name]').fill('Fictional late Seller draft');const nav = report.navigations.filter((x) => x.name === 'seller').length;await releaseNativeActivation(seller);
    await seller.waitForFunction((v) => window.qaActualControllerVersion === v, newSeller);await seller.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');await seller.waitForFunction(() => !document.querySelector('#install-update-button').disabled);await peer.waitForFunction(() => !document.querySelector('#seller-update-notice').hidden);
    assert.equal(report.navigations.filter((x) => x.name === 'seller').length, nav);assert.match(await seller.locator('#seller-current-version').innerText(), new RegExp(oldApp.seller));assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional late Seller draft');assert.equal(await peer.evaluate(() => location.href), href);assert.equal(await peer.locator('[name=name]').inputValue(), 'Fictional peer draft');assert.match(await peer.locator('#seller-current-version').innerText(), new RegExp(oldApp.seller));assert.equal((await swState(peer, '/seller/')).controller, newSeller);await seller.screenshot({ path: out + '/seller-predecessor-late-edit-deferred.png', fullPage: true });await peer.screenshot({ path: out + '/seller-predecessor-peer-preserved.png', fullPage: true });return { nativeController: newSeller, loadedUI: oldApp.seller, automaticReloads: 0, peerDraftPreserved: true };
  });
  await checked('Post-activation dirty Cancel then normal Save and explicit reload load exact target without a loop', async () => {
    await seller.locator('#install-update-button').click();await seller.locator('.app-modal-confirm .modal-secondary-button').click();await seller.locator('.app-modal-confirm').waitFor({ state: 'detached' });assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional late Seller draft');await sellerSave('Fictional late Seller draft');savedSellerName = (await productRow()).name;
    await seller.evaluate(() => window.qaBeforeReload = true);await seller.locator('#install-update-button').click();await seller.waitForFunction((v) => window.qaBeforeReload === undefined && document.querySelector('#seller-current-version')?.textContent.includes(v), newSeller);await seller.locator('.product-gallery-item').first().waitFor();const s = await swState(seller, '/seller/');assert.equal(s.controller, newSeller);assert.equal(s.waiting, null);assert.ok(!s.caches.includes('os-seller-' + oldApp.seller));assert.ok(s.caches.includes('os-shop-v110'));assert.ok(s.caches.includes('qa-unrelated'));assert.equal(await seller.locator('[name=name]').inputValue(), savedSellerName);assert.deepEqual(await galleryIDs(), savedGallery);assert.deepEqual(await cartBytes(customer), initialCart);assert.equal(await customer.evaluate(() => localStorage.getItem('qa-preserved-preference')), 'fictional-keep');return { explicitReload: true, targetLoaded: newSeller, galleryAndStoragePreserved: true };
  });
  await checked('Target same-page normal product Save retains images, controls and success', async () => {await sellerSave('Fictional current target saved');savedSellerName = (await productRow()).name;assert.deepEqual(await galleryIDs(), savedGallery);assert.equal(await seller.locator('#product-save').isDisabled(), false);assert.equal(await seller.locator('.product-gallery-item').count(), 5);await seller.screenshot({ path: out + '/seller-target-normal-save.png', fullPage: true });return { target: newSeller, actualPATCH200: true };});
  await checked('Offline manual update check and Save retain draft with no committed write', async () => {
    await seller.locator('[name=name]').fill('Fictional offline draft');const row = await productRow(),writes = requests.filter((x) => ['POST', 'PATCH'].includes(x.method)).length;await context.setOffline(true);await sellerCheck();await seller.waitForFunction(() => document.querySelector('#check-updates-status').textContent.includes('Unable to update'));await seller.locator('#product-save').click();await seller.waitForFunction(() => Boolean(document.querySelector('#product-form-error').textContent));assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional offline draft');assert.deepEqual(await productRow(), row);assert.equal(requests.filter((x) => ['POST', 'PATCH'].includes(x.method)).length, writes);assert.equal(await peer.locator('[name=name]').inputValue(), 'Fictional peer draft');await seller.screenshot({ path: out + '/seller-target-offline-draft.png', fullPage: true });return { actualOffline: true, serverWrites: 0, draftPreserved: true };
  });
  await checked('Cached offline fallback Retry is truthful; online check and real Save recover', async () => {
    const probe = await context.newPage();const r = await probe.goto(origin + '/seller/');assert.equal(r.status(), 200);await probe.locator('#retry').waitFor();assert.match(await probe.locator('main').innerText(), /cannot be saved offline/i);await probe.locator('#retry').click();await probe.locator('#retry').waitFor();await probe.setViewportSize({ width: 390, height: 844 });await probe.screenshot({ path: out + '/seller-target-offline-fallback.png', fullPage: true });assert.equal(await seller.locator('[name=name]').inputValue(), 'Fictional offline draft');await context.setOffline(false);await seller.waitForFunction(() => document.querySelector('#check-updates-status').textContent.includes('up to date'));await probe.locator('#retry').click();await probe.locator('#workspace').waitFor({ state: 'visible' });await probe.close();await sellerSave('Fictional offline draft');assert.deepEqual(await galleryIDs(), savedGallery);assert.deepEqual(await cartBytes(customer), initialCart);await customer.evaluate(() => location.hash = '#profile');assert.equal(await customer.locator('#profile-form [name=fullName]').inputValue(), 'Fictional PWA buyer');return { onlineAutomaticCheckRecovery: true, actualSaveRetry200: true, cartAndProfilePreserved: true };
  });
  await checked('All native110/target cache bytes equal committed Git; no API/private data or cross-scope deletion', async () => {
    report.cachedByteProof = await customer.evaluate(async () => {const result = [];for (const name of await caches.keys()) {if (!name.startsWith('os-')) continue;const c = await caches.open(name);for (const req of await c.keys()) {const r = await c.match(req),bytes = await r.arrayBuffer(),hash = await crypto.subtle.digest('SHA-256', bytes);result.push({ cache: name, path: new URL(req.url).pathname, sha256: [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join(''), bytes: bytes.byteLength });}}return result;});
    for (const x of report.cachedByteProof) {assert.ok(!x.path.startsWith('/api/'));const f = 'public' + x.path + (x.path.endsWith('/') ? 'index.html' : '');assert.equal(x.sha256, digest(gitBytes(targetHead, f)), x.path);}assert.deepEqual((await swState(seller, '/seller/')).caches.sort(), ['os-shop-v110', 'os-seller-' + newSeller, 'qa-unrelated'].sort());assert.equal(report.pageErrors.length, 0);assert.equal(report.externalRequests.length, 0);assert.deepEqual(await money(), baselineMoney);assert.deepEqual(await orders(), baselineOrders);await seller.screenshot({ path: out + '/seller-target-recovered.png', fullPage: true });return { cacheEntries: report.cachedByteProof.length, exactGitBytes: true, moneyAndOrdersUnchanged: true };
  });
} catch (error) {process.exitCode = 1;console.error(error.stack?.replaceAll(config.password, '[REDACTED]'));report.failureWorkers = { seller: await swState(seller, '/seller/').catch(() => null), shop: await swState(customer, '/shop/').catch(() => null) };} finally
{
  controls.releaseProduct?.();controls.releaseOrder?.();report.sourceHashesAfter = Object.fromEntries(Object.keys(report.sourceHashes).map((p) => [p, digest(readFileSync(p))]));assert.deepEqual(report.sourceHashesAfter, report.sourceHashes);report.runCompleted = !process.exitCode;report.completedAt = new Date().toISOString();report.boundaries = { genuineHistoricalHead: historicalHead, applicationTargetHead: targetHead, harnessHead: head, production: 'UNVERIFIED', physicalDevices: 'UNVERIFIED', unchangedShopUpdateNotInvented: true };await context.close();await browser.close();await app.close();report.cleanup = { browserAndServerClosed: true, inMemoryDatabaseClosed: true };writeFileSync(out + '/pwa-results.json', JSON.stringify(report, null, 2));console.log(JSON.stringify({ head, targetHead, cases: report.cases.map(({ name, status, error }) => ({ name, status, error })), pageErrors: report.pageErrors, cleanup: report.cleanup }));
}
