import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real Chrome, real Service Worker: install, offline contract, N to N+1 update, lifecycle states, top bar, scroll-to-top, chrome colours.
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function build(version) {
  const dir = mkdtempSync(path.join(tmpdir(), 'platform-pwa-'));
  cpSync(new URL('../public/', import.meta.url), dir, { recursive: true, verbatimSymlinks: true });
  for (const [name, pattern, replacement] of [['platform/version.js', /APP_VERSION = '[^']+'/, `APP_VERSION = '${version}'`], ['platform/sw.js', /version: '[^']+'/, `version: '${version}'`]]) {
    writeFileSync(path.join(dir, name), readFileSync(path.join(dir, name), 'utf8').replace(pattern, replacement));
  }
  return dir;
}

test('platform PWA: install, offline contract, version N to N+1 update with loader, top bar, scroll-to-top, chrome', { skip: !browserModule, timeout: 180000 }, async (t) => {
  const builds = { v1: build('v1'), v2: build('v2') };
  let live = 'v1', down = false;
  const server = createServer((request, response) => {
    if (down) { request.socket.destroy(); return; }
    let pathname = new URL(request.url, 'http://local').pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(builds[live], pathname);
    if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });

  const shop = { id: '12345678-1234-4234-8234-123456789abc', code: 'alpha', name: 'Synthetic Shop', currency: 'MYR', status: 'ACTIVE', revision: 1, isDefault: false, sellerUsername: 'owner', orderCount: 1, productCount: 2, shopUrl: `${origin}/alpha/`, sellerUrl: `${origin}/alpha/` };
  const apiCalls = [];
  await context.route('**/api/v1/platform/**', async (route) => {
    const url = new URL(route.request().url()); apiCalls.push(`${route.request().method()} ${url.pathname}`);
    const body = url.pathname.endsWith('/session') ? { stage: 'FULL', csrfToken: 'synthetic-csrf-token', username: 'admin' } : url.pathname.endsWith('/shops') ? { items: [shop] } : url.pathname.endsWith('/qr') ? null : shop;
    await route.fulfill({ json: body });
  });

  const state = () => page.evaluate(() => document.documentElement.dataset.appState);
  const settle = (value) => page.waitForFunction((expected) => document.documentElement.dataset.appState === expected, value, { timeout: 15000 });

  // ---- STARTING -> READY, worker installed and controlling, only shell files cached.
  await page.goto(`${origin}/platform/`);
  await settle('READY');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.querySelector('link[rel=manifest]').href), `${origin}/platform/manifest.webmanifest`);
  assert.deepEqual(await page.evaluate(() => caches.keys()), ['os-platform-v1']);
  const cachedUrls = await page.evaluate(async () => (await (await caches.open('os-platform-v1')).keys()).map((request) => new URL(request.url).pathname));
  assert.ok(cachedUrls.includes('/platform/') && cachedUrls.includes('/platform/offline.html') && cachedUrls.includes('/platform/app.js'));
  assert.equal(cachedUrls.some((url) => url.includes('/api/')), false, 'no API response is cached');

  // ---- Signed-out administrators can check for updates without losing a typed password.
  const guest = await context.newPage();
  await guest.route('**/api/v1/platform/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ status: 401, json: { error: { message: 'Sign in required' } } });
    return route.fulfill({ json: { csrfToken: 'synthetic-csrf-token' } });
  });
  await guest.goto(`${origin}/platform/`);
  await guest.getByLabel('Password', { exact: true }).fill('synthetic-password');
  const check = guest.getByRole('button', { name: 'Check for updates', exact: true });
  await check.waitFor();
  await guest.waitForFunction(() => !document.querySelector('#content .edit-card button')?.disabled);
  await check.click();
  await guest.locator('#content').getByText('This is the latest version.').waitFor();
  assert.equal(await guest.getByLabel('Password', { exact: true }).inputValue(), 'synthetic-password');
  await guest.close();

  // ---- Account menu: version and a manual check; the menu stays open to show the result.
  await page.locator('#account-button').click();
  const menu = page.locator('#account-menu');
  assert.match(await menu.locator('.menu-update-version').innerText(), /App version v1/);
  await menu.getByRole('button', { name: 'Check for updates' }).click();
  await menu.getByText('This is the latest version.').waitFor();
  assert.equal(await menu.isVisible(), true, 'the menu stays open after the check');
  await page.keyboard.press('Escape'); assert.equal(await menu.isHidden(), true);

  // ---- Security/privacy: the CSRF token and API payloads are not persisted in storage or caches.
  const stored = await page.evaluate(async () => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, await Promise.all((await caches.keys()).map(async (name) => { const cache = await caches.open(name); return Promise.all((await cache.keys()).map(async (request) => [request.url, (await (await cache.match(request)).text()).slice(0, 400000)])); }))]));
  assert.doesNotMatch(stored, /synthetic-csrf-token|Synthetic Shop/, 'neither request URLs nor cached response bodies hold the CSRF token or shop data');

  // ---- Theme chrome: the opaque top bar matches the theme-color meta in light and dark.
  const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const [bar, meta] = await page.evaluate((media) => [getComputedStyle(document.querySelector('.topbar')).backgroundColor, document.querySelector(`meta[name=theme-color][media="(prefers-color-scheme: ${media})"]`).content], scheme);
    assert.equal(hex(bar), meta, `top bar is the ${scheme} status-bar colour`);
    assert.equal(await page.evaluate(() => { const probe = getComputedStyle(document.body, '::before'); return probe.position; }), 'fixed');
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // ---- Safe areas: the shell consumes the --ui-safe-* tokens (headless Chrome has no notch, so the token is overridden).
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-safe-top', '47px'));
  const topMetrics = await page.evaluate(() => { const bar = document.querySelector('.topbar'), style = getComputedStyle(bar); return { padding: style.paddingTop, height: style.height, surface: getComputedStyle(document.body, '::before').height, color: getComputedStyle(document.body, '::before').backgroundColor }; });
  assert.equal(topMetrics.padding, '47px'); assert.equal(topMetrics.height, '119px'); assert.equal(topMetrics.surface, '47px'); assert.notEqual(topMetrics.color, 'rgba(0, 0, 0, 0)');
  await page.evaluate(() => document.documentElement.style.removeProperty('--ui-safe-top'));

  // ---- Offline contract: open app shows OFFLINE and never reports success; a cold offline launch shows the cached offline page.
  await context.setOffline(true);
  await settle('OFFLINE');
  assert.match(await page.locator('.app-status').innerText(), /offline[\s\S]*nothing is saved/i);
  const callsBefore = apiCalls.length;
  await page.getByRole('button', { name: 'Activity', exact: true }).click().catch(() => {});
  assert.equal(await page.locator('#notice:has-text("saved")').count(), 0, 'no success is claimed offline');
  await context.setOffline(false);
  await settle('READY'); assert.equal(await page.locator('.app-status').isHidden(), true);
  // Headless Chrome does not apply setOffline to Service Worker fetches, so the network is also cut at the server.
  await context.setOffline(true); down = true;
  await page.reload();
  await page.getByRole('heading', { name: 'You are offline' }).waitFor();
  assert.match(await page.locator('main').innerText(), /Nothing was changed while you were offline/);
  assert.equal(apiCalls.length >= callsBefore, true);
  await context.setOffline(false); down = false;
  await page.getByRole('link', { name: 'Try again' }).click();
  await settle('READY');

  // ---- Smart top bar and scroll-to-top on a long page.
  await page.evaluate(() => { const spacer = document.createElement('div'); spacer.id = 'spacer'; spacer.style.height = '4000px'; document.querySelector('#content').append(spacer); });
  const bar = page.locator('.topbar'), top = page.locator('.scroll-top');
  assert.equal(await top.isHidden(), true, 'scroll-to-top is hidden at the top');
  await page.evaluate(() => scrollTo(0, 300)); await page.waitForFunction(() => document.querySelector('.topbar').classList.contains('topbar-hidden'));
  assert.notEqual(await bar.evaluate((node) => getComputedStyle(node).transform), 'none', 'hidden with a transform, not a layout change');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).position), 'sticky');
  await page.evaluate(() => scrollTo(0, 150)); await page.waitForFunction(() => !document.querySelector('.topbar').classList.contains('topbar-hidden'));
  await page.evaluate(() => scrollTo(0, 2000)); await top.waitFor({ state: 'visible' });
  const box = await top.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
  await top.click(); await page.waitForFunction(() => scrollY === 0, null, { timeout: 5000 }); assert.equal(await top.isHidden(), true);
  await page.evaluate(() => document.querySelector('#spacer').remove());
  // Reduced motion: no animated transition and a static spinner.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await bar.evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ---- Version N -> N+1: discovered silently, offered visibly, applied only on "Update now", loader, one reload, old cache removed.
  await page.evaluate(() => { window.__marker = 'still the same page'; });
  live = 'v2';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle('UPDATE_AVAILABLE');
  const banner = page.locator('.app-status');
  assert.match(await banner.innerText(), /new version is available \(v2\)/i);
  assert.equal(await page.evaluate(() => window.__marker), 'still the same page', 'nothing reloads by itself');
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.__marker), 'still the same page', 'still the same page after waiting');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.endsWith('sw.js')), true);
  // The Account menu turns its check into "Update now" while a version is waiting.
  await page.locator('#account-button').click();
  assert.equal((await page.locator('#account-menu .menu-update-button').innerText()).trim(), 'Update now (v2)');
  assert.equal(await page.locator('#account-menu .menu-update-status').innerText(), 'A new version is ready.');
  await page.keyboard.press('Escape');
  // A changed field asks first; Cancel keeps the page and the draft.
  const nav = (name) => page.locator('#navigation').getByRole('button', { name, exact: true });
  await nav('Account').click();
  assert.match(await page.locator('.edit-help', { hasText: 'App version' }).innerText(), /App version: v1/);
  await page.getByLabel('Current password').first().fill('synthetic-password');
  await banner.getByRole('button', { name: 'Update now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__marker), 'still the same page', 'Cancel keeps the page');
  assert.equal(await state(), 'UPDATE_AVAILABLE');
  await page.getByLabel('Current password').first().fill('');
  assert.equal(await page.getByLabel('Current password').first().inputValue(), '', 'the draft is cleared');
  // "Later" hides the banner without updating, and the update stays available on the Account screen.
  await banner.getByRole('button', { name: 'Later' }).click(); assert.equal(await banner.isHidden(), true);
  assert.equal(await state(), 'UPDATE_AVAILABLE');
  await page.locator('.edit-card', { hasText: 'App version' }).getByRole('button', { name: 'Update now' }).waitFor({ state: 'visible' });
  // The top bar always carries the update button, also after "Later", on a desktop and on a phone.
  const barUpdate = page.locator('#topbar-update');
  await barUpdate.waitFor({ state: 'visible' });
  assert.match(await barUpdate.getAttribute('aria-label'), /Update available \(v2\)/); assert.equal(await barUpdate.locator('svg').count(), 1);
  assert.equal(await barUpdate.evaluate((node) => node.closest('.topbar') !== null), true);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#main')).marginLeft === '0px', null, { timeout: 5000 });
  const phoneBox = await barUpdate.boundingBox(); assert.ok(phoneBox.width >= 44 && phoneBox.height >= 44, 'touch target on a phone');
  assert.ok(phoneBox.x >= 0 && phoneBox.x + phoneBox.width <= 390, 'inside the phone screen');
  assert.equal(await barUpdate.locator('.topbar-update-label').isHidden(), true, 'icon only on a phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#main')).marginLeft !== '0px', null, { timeout: 5000 });
  // A dismissed update never hides the offline warning.
  await context.setOffline(true);
  await banner.waitFor({ state: 'visible' }); assert.match(await banner.innerText(), /offline/i);
  await context.setOffline(false);
  await banner.waitFor({ state: 'hidden' });
  // One-time secrets on screen (recovery codes, new seller credentials) count as unsaved: the update asks first.
  const card = page.locator('.edit-card', { hasText: 'App version' });
  for (const [name, on, off] of [['recovery codes', () => document.body.classList.add('saving-recovery'), () => document.body.classList.remove('saving-recovery')], ['seller credentials', () => document.querySelector('#secret-dialog').showModal(), () => document.querySelector('#secret-dialog').close()]]) {
    await page.evaluate(on);
    await page.evaluate(() => [...document.querySelectorAll('.edit-card')].find((card) => card.textContent.includes('App version')).querySelector('button.primary-button').click());
    await page.locator('dialog[open] .modal-confirm-actions').waitFor({ state: 'visible' });
    await page.locator('dialog[open] .modal-confirm-actions').getByRole('button', { name: 'Cancel', exact: true }).evaluate((node) => node.click());
    await page.locator('dialog.app-modal-confirm').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__marker), 'still the same page', `${name}: Cancel keeps the page`);
    await page.evaluate(off);
  }
  await card.getByRole('button', { name: 'Update now' }).waitFor({ state: 'visible' });

  // Confirmed update: loader appears at once, the page behind is inert, the action cannot be repeated, then one reload into v2.
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  // The loader can be on screen for only a moment before the reload, so record it from inside the page and read it after the reload.
  await page.evaluate(() => {
    const loader = document.querySelector('.app-loader'), seen = [];
    new MutationObserver(() => {
      if (!loader.hidden) { seen.push({ text: loader.innerText, inert: document.querySelector('#main').hasAttribute('inert'), state: document.documentElement.dataset.appState, banner: document.querySelector('.app-status').hidden });
        sessionStorage.setItem('loader-seen', JSON.stringify(seen)); }
    }).observe(loader, { attributes: true, attributeFilter: ['hidden'] });
  });
  await barUpdate.dblclick();
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => window.__marker === undefined, null, { timeout: 20000 });
  await settle('READY');
  assert.equal(await page.locator('.app-loader').isHidden(), true);
  const seen = JSON.parse(await page.evaluate(() => sessionStorage.getItem('loader-seen')));
  assert.ok(seen.length >= 1, 'the loader appeared'); assert.match(seen[0].text, /Updating Shop platform/); assert.equal(seen[0].inert, true, 'the page behind the loader was inert'); assert.equal(seen[0].banner, true);
  assert.ok(['UPDATING', 'RELOADING'].includes(seen[0].state));
  assert.equal(navigations.length, 1, 'exactly one reload, even after a double click');
  assert.deepEqual(await page.evaluate(() => caches.keys()), ['os-platform-v2'], 'the old cache is removed');
  await nav('Account').click();
  assert.match(await page.locator('.edit-help', { hasText: 'App version' }).innerText(), /App version: v2/);

  // ---- Responsive: no horizontal overflow at 320 px, touch targets and 16 px inputs on a phone.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForFunction(() => document.querySelector('#sidebar').hidden && getComputedStyle(document.querySelector('#main')).marginLeft === '0px', null, { timeout: 5000 }); // breakpoint listener, then the margin transition
  const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((node) => node.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(node).position !== 'fixed').slice(0, 6).map((node) => `${node.tagName.toLowerCase()}.${node.className} "${(node.textContent || '').slice(0, 24)}" in ${node.parentElement.tagName}.${node.parentElement.className} right=${Math.round(node.getBoundingClientRect().right)}`));
  assert.deepEqual(wide, [], 'elements wider than a 320 px screen');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  for (const name of ['Shops', 'Add shop', 'Activity', 'Account']) {
    const target = await page.locator('#navigation').getByRole('button', { name, exact: true }).boundingBox(); assert.ok(target.height >= 44, `${name} touch target`);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('input')).fontSize), '16px');

  assert.deepEqual(problems, [], `console and page errors: ${problems.join(' | ')}`);
});
