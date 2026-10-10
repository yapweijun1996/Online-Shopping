import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCaddyFixture } from './qa-caddy-fixture.mjs';

if (!process.env.QA_PLAYWRIGHT_MODULE) throw new Error('Set QA_PLAYWRIGHT_MODULE to the isolated Playwright installation.');
const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));
const fixture = await startCaddyFixture('browser');
const report = { browser: 'installed Google Chrome', checks: [], pageErrors: [], installed: [] };
let context, cdp;
try {
  context = await chromium.launchPersistentContext(join(fixture.scratch, 'chrome-profile'), { channel: 'chrome', headless: false, ignoreHTTPSErrors: true,
    args: ['--host-resolver-rules=MAP *.gmb01.xyz 127.0.0.1', '--no-proxy-server', '--ignore-certificate-errors', `--ignore-certificate-errors-spki-list=${fixture.tlsSpki}`,
      `--unsafely-treat-insecure-origin-as-secure=${['shop', 'seller', 'admin'].map((host) => fixture.origin(`${host}.gmb01.xyz`)).join(',')}`], viewport: { width: 1280, height: 900 } });
  const pages = new Map();
  async function open(code, surface = 'shop') {
    const page = await context.newPage(); page.on('pageerror', (e) => report.pageErrors.push(e.message));
    await page.goto(`${fixture.origin(`${surface}.gmb01.xyz`)}/${code ? code + '/' : ''}${surface}/`);
    await page.waitForFunction(() => window.shopPalette || window.sellerPalette);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 30_000 });
    pages.set(`${code}:${surface}`, page); return page;
  }
  for (const code of ['', 'alpha', 'bravo']) {
    const page = await open(code);
    await page.getByText(`Fictional ${code || 'default'} item`, { exact: true }).first().waitFor();
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
    assert.equal(manifest.id, `/${code ? code + '/' : ''}shop/`); assert.equal(manifest.scope, manifest.id); assert.equal(manifest.start_url, manifest.id);
    report.checks.push(`${code || 'default'} catalog and manifest`);
  }
  async function state(page, marker) {
    return page.evaluate(async (marker) => {
      const { createCartStore } = await import('./cart.js'); const cart = await createCartStore();
      const { createProfileStore } = await import('./profile.js'); const profile = createProfileStore(localStorage);
      const { createAddressStore } = await import('./addresses.js'); const addresses = createAddressStore(localStorage);
      const { createContactHistory } = await import('./history.js'); const history = createContactHistory();
      const { createLocalOrderStore } = await import('./local-orders.js'); const orders = await createLocalOrderStore();
      if (marker) {
        await cart.set('same-fictional-product', marker.quantity);
        profile.save({ fullName: marker.name, code: '+65', phone: marker.phone, email: '' });
        addresses.save({ fullName: marker.name, phone: marker.phone, line1: marker.name + ' address', city: 'Singapore', region: 'Singapore', postcode: '123456', country: 'SG' });
        history.save({ buyerPhone: marker.phone, recipientPhones: [marker.phone], addresses: [] });
        await orders.save({ orderNo: 'OS-12345678', currency: 'MYR', totalMinor: marker.quantity * 1000, submittedAt: new Date().toISOString() });
        window.shopPalette.choose(marker.palette);
      }
      const result = { scope: globalThis.shopStorageNamespace, cart: cart.list(), profile: profile.get(), addresses: addresses.read().entries,
        history: history.snapshot(), orders: orders.list(), palette: window.shopPalette.current(), databases: (await indexedDB.databases()).map((d) => d.name), keys: Object.keys(localStorage) };
      cart.close(); orders.close(); return result;
    }, marker);
  }
  const markers = { alpha: { name: 'Fictional Alpha', phone: '+6581234567', quantity: 2, palette: 'warm-plum' }, bravo: { name: 'Fictional Bravo', phone: '+6582345678', quantity: 3, palette: 'ocean-blue' } };
  for (const code of ['alpha', 'bravo']) {
    const before = await state(pages.get(`${code}:shop`)); assert.equal(before.profile, null); assert.equal(before.cart.length, 0); assert.equal(before.orders.length, 0);
    await state(pages.get(`${code}:shop`), markers[code]);
  }
  for (const code of ['alpha', 'bravo']) {
    const current = await state(pages.get(`${code}:shop`)), marker = markers[code];
    assert.equal(current.cart[0].quantity, marker.quantity); assert.equal(current.profile.fullName, marker.name); assert.equal(current.addresses[0].fullName, marker.name);
    assert.deepEqual(current.history.buyerPhones, [marker.phone]); assert.equal(current.orders[0].totalMinor, marker.quantity * 1000); assert.equal(current.palette, marker.palette);
    assert.match(current.scope, /^t-[a-f0-9]{12}$/); report.checks.push(`${code} cart, profile, addresses, history, local orders and palette isolated`);
  }
  const legacy = await state(pages.get(':shop')); assert.equal(legacy.scope, ''); assert.equal(legacy.profile, null); assert.equal(legacy.cart.length, 0);
  assert(legacy.databases.includes('online-shopping-cart')); assert(!legacy.keys.includes('online-shopping-profile-v1')); report.checks.push('default keys preserved without migration');
  await context.grantPermissions(['notifications'], { origin: fixture.origin('seller.gmb01.xyz') });
  for (const code of ['alpha', 'bravo']) {
    const page = await open(code, 'seller');
    const preference = await page.evaluate(async (code) => {
      const { createOrderAlerts } = await import('./alerts.js'); const { storageKey } = await import('../shared/storage-scope.js');
      const button = document.createElement('button'), badge = document.createElement('span');
      createOrderAlerts({ button, badge, baseTitle: () => 'Fictional seller', onUnauthorized() {} });
      const before = localStorage.getItem(storageKey('online-shopping-seller-order-alerts'));
      if (code === 'alpha') { button.click(); await new Promise((r) => setTimeout(r, 50)); window.sellerPalette.choose('high-contrast'); }
      return { before, after: localStorage.getItem(storageKey('online-shopping-seller-order-alerts')), palette: window.sellerPalette.current() };
    }, code);
    assert.equal(preference.before, null); assert.equal(preference.after, code === 'alpha' ? '1' : null);
    assert.equal(preference.palette, code === 'alpha' ? 'high-contrast' : 'evergreen-teal');
  }
  report.checks.push('seller alert preferences and palette isolated');
  const alpha = pages.get('alpha:shop');
  const workerState = await alpha.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: new URL(r.scope).pathname, active: r.active?.state })), caches: await caches.keys() }));
  for (const scope of ['/shop/', '/alpha/shop/', '/bravo/shop/']) assert(workerState.registrations.some((r) => r.scope === scope && r.active === 'activated'));
  for (const prefix of ['os-shop-', 'tenant-alpha-shop-', 'tenant-bravo-shop-']) assert(workerState.caches.some((name) => name.startsWith(prefix)));
  report.checks.push('three active workers and independent caches coexist');
  cdp = await context.newCDPSession(alpha);
  assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
  for (const code of ['alpha', 'bravo']) {
    const manifestId = `${fixture.origin('shop.gmb01.xyz')}/${code}/shop/`;
    await cdp.send('PWA.install', { manifestId, installUrlOrBundleUrl: manifestId });
    await cdp.send('PWA.changeAppUserSettings', { manifestId, displayMode: 'standalone' });
    await cdp.send('PWA.getOsAppState', { manifestId }); report.installed.push(manifestId);
  }
  report.checks.push('both tenant PWAs installed in the disposable Chrome profile');
  await context.setOffline(true);
  for (const code of ['alpha', 'bravo']) {
    const launched = context.waitForEvent('page');
    await cdp.send('PWA.launch', { manifestId: `${fixture.origin('shop.gmb01.xyz')}/${code}/shop/` });
    const installedPage = await launched;
    installedPage.on('pageerror', (e) => report.pageErrors.push(e.message));
    await installedPage.waitForFunction(() => window.shopPalette && document.querySelector('h1')).catch(async (error) => {
      console.log(JSON.stringify({ installedLaunch: code, url: installedPage.url(), diagnostic: await installedPage.evaluate(async () => ({ title: document.title, heading: document.querySelector('h1')?.textContent,
        secure: isSecureContext, controller: navigator.serviceWorker?.controller?.scriptURL, registrations: (await navigator.serviceWorker?.getRegistrations() || []).map((r) => r.scope) })) }));
      throw error;
    });
    assert.equal(await installedPage.evaluate(() => matchMedia('(display-mode: standalone)').matches), true);
    assert.equal(await installedPage.evaluate(() => window.shopPalette.current()), markers[code].palette);
    await installedPage.close();
    const page = pages.get(`${code}:shop`); await page.goto(`${fixture.origin('shop.gmb01.xyz')}/${code}/shop/`);
    await page.waitForFunction(() => window.shopPalette && document.querySelector('h1'));
    assert.equal(await page.evaluate(() => window.shopPalette.current()), markers[code].palette);
    assert.equal(await page.evaluate(() => globalThis.shopStorageNamespace), (await stateBeforeOffline(code)));
    report.checks.push(`${code} offline shell starts with its own palette and scope`);
  }
  async function stateBeforeOffline(code) { return (await pages.get(':shop').evaluate((code) => localStorage.getItem(`scope-for:/${code}`), code)); }
  await context.setOffline(false);
  const online = await alpha.reload();
  assert.equal(online.status(), 200);
  await alpha.waitForFunction(() => document.querySelector('#profile-form') && window.shopPalette);
  await alpha.goto(`${fixture.origin('shop.gmb01.xyz')}/alpha/shop/#profile`);
  await alpha.locator('#profile-form [name="fullName"]').fill('Fictional unsaved update guard');
  const workerPath = join(fixture.publicDir, 'shop/sw.js'), versionPath = join(fixture.publicDir, 'shop/version.js');
  await writeFile(workerPath, (await readFile(workerPath, 'utf8')).replace("version: 'v144'", "version: 'v144-qa-next'"));
  await writeFile(versionPath, (await readFile(versionPath, 'utf8')).replace("'v144'", "'v144-qa-next'"));
  await alpha.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
  await alpha.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  await alpha.waitForFunction(() => !document.querySelector('.shop-update-settings .primary-button').hidden);
  assert.equal(await alpha.locator('#profile-form [name="fullName"]').inputValue(), 'Fictional unsaved update guard');
  // Returning the draft to its saved state allows the application's normal automatic activation.
  await alpha.locator('#profile-form [name="fullName"]').fill(markers.alpha.name);
  await alpha.evaluate(() => document.dispatchEvent(new Event('updateguardchange')));
  await alpha.waitForFunction(() => document.querySelector('.shop-update-settings')?.textContent.includes('v144-qa-next'), { timeout: 30_000 });
  await alpha.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration()).waiting);
  report.checks.push('update offered once, retained an unsaved draft, then activated without a reload loop');
  assert.equal((await fixture.request('shop.gmb01.xyz', '/api/v1/__qa/rename-alpha', { method: 'POST' })).status, 200);
  const redirected = alpha.waitForURL(`**/renamedalpha/shop/**`);
  await alpha.reload().catch((error) => { if (!error.message.includes('ERR_ABORTED')) throw error; });
  await redirected;
  await alpha.waitForFunction(() => document.querySelector('#profile-form') && window.shopPalette);
  const renamed = await state(alpha); assert.equal(renamed.profile.fullName, markers.alpha.name); assert.equal(renamed.cart[0].quantity, 2);
  assert.equal(renamed.palette, markers.alpha.palette);
  await alpha.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).active));
  report.checks.push('controlled installed app follows rename alias and retains stable tenant state');
  const unknown = await context.newPage(); await unknown.goto(`${fixture.origin('shop.gmb01.xyz')}/unknown/shop/`);
  assert.match(await unknown.locator('h1').textContent(), /not found/i); report.checks.push('unknown code shows a neutral unavailable page');
  assert.deepEqual(report.pageErrors, []);
  await writeFile('output/qa/multi-tenant/r2-tenant-browser.json', JSON.stringify(report, null, 2));
  console.log(`Chrome tenant browser: ${report.checks.length} checks passed; ${report.installed.length} PWAs installed.`);
} finally {
  if (cdp) for (const manifestId of report.installed) await cdp.send('PWA.uninstall', { manifestId }).catch(() => {});
  await context?.close(); await fixture.close();
}
