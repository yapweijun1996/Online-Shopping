import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Seller and Shop with a real Service Worker: a new version shows the shared top bar Update button, nothing reloads by itself
// (no silent auto update), and one tap moves the page to the new version with one reload.
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
const productId = '00000000-0000-4000-8000-000000000001';
const product = { id: productId, name: 'Fixture product', description: 'Synthetic detail', category: 'Fixture', priceMinor: 1000, currency: 'MYR', stockQuantity: 3 };

function build(surface, version) {
  const dir = mkdtempSync(path.join(tmpdir(), `${surface}-update-`));
  cpSync(new URL('../public/', import.meta.url), dir, { recursive: true, verbatimSymlinks: true });
  for (const [name, pattern, replacement] of [[`${surface}/version.js`, /APP_VERSION = '[^']+'/, `APP_VERSION = '${version}'`], [`${surface}/sw.js`, /version: '[^']+'/, `version: '${version}'`]]) {
    writeFileSync(path.join(dir, name), readFileSync(path.join(dir, name), 'utf8').replace(pattern, replacement));
  }
  return dir;
}

async function assertShopUpdateLayout(page) {
  const updateButtons = page.getByRole('button', { name: /update now|new version ready/i });
  assert.match(await page.locator('.shop-update-status[role="status"]').textContent(), /new version ready/i);
  for (const width of [320, 360, 390, 440, 441, 719, 720, 760, 761, 900, 1100, 1101, 1440]) {
    await page.setViewportSize({ width, height: width <= 760 ? 844 : 900 });
    const brand = await page.locator('.shop-topbar .brand').boundingBox();
    assert.ok(brand, `brand visible at ${width}px`);
    const controls = ['.header-search', '.theme-control select', '#language .language-trigger', '#topbar-update', '#profile-menu-button'];
    if (width > 760) controls.push('.shop-nav a[href="#cart"]');
    for (const selector of controls) {
      const control = await page.locator(selector).boundingBox();
      assert.ok(control, `${selector} visible at ${width}px`);
      assert.ok(Math.abs(control.y + control.height / 2 - (brand.y + brand.height / 2)) <= 1, `${selector} shares the brand row at ${width}px`);
      assert.ok(control.x >= 0 && control.x + control.width <= width, `${selector} stays in the viewport at ${width}px`);
      assert.ok(control.width >= 44 && control.height >= 44, `${selector} has a 44px target at ${width}px`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`);
    assert.equal(await updateButtons.count(), 1, `one visible update button at ${width}px`);
    if (width <= 760) {
      const search = await page.locator('#catalog-search').boundingBox();
      assert.ok(search.width >= 44 && search.height >= 44, `search input has a 44px target at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#profile-menu-button').click();
  await page.locator('#profile-menu a[href="#settings"]').click();
  const settings = page.locator('.shop-update-settings');
  await settings.getByRole('button', { name: /update now/i }).waitFor();
  assert.match(await settings.getByRole('status').textContent(), /new version ready/i);

  await page.evaluate((id) => { location.hash = `#product/${id}`; }, productId);
  await page.getByRole('heading', { name: 'Fixture product' }).waitFor();
  await page.locator('.product-navigation #topbar-update').waitFor();
  assert.equal(await updateButtons.count(), 1, 'only the product header offers the update on phones');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.shop-topbar #topbar-update').waitFor();
  assert.equal(await updateButtons.count(), 1, 'only the storefront header offers the update on desktop product pages');
  await page.evaluate(() => { location.hash = '#catalog'; });
  await page.locator('#catalog-view').waitFor();
}

for (const surface of ['seller', 'shop']) {
  test(`${surface}: top bar Update button, no silent update, one tap to the new version`, { skip: !browserModule, timeout: 120000 }, async (t) => {
    const builds = { a: build(surface, 'v900'), b: build(surface, 'v901') };
    t.after(() => Object.values(builds).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    let live = 'a';
    const server = createServer((request, response) => {
      let pathname = new URL(request.url, 'http://local').pathname;
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.join(builds[live], pathname);
      if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); response.end(readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = await import(browserModule);
    const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/v1/shop')) return route.fulfill({ json: { shopName: 'Synthetic Shop', currency: 'MYR', storageScope: '' } });
      if (url.pathname.endsWith(`/v1/products/${productId}`)) return route.fulfill({ json: product });
      if (url.pathname.endsWith('/v1/products')) return route.fulfill({ json: { items: [], categories: [], nextOffset: null } });
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } } });
    });
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/${surface}/`);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
    const button = page.locator('#topbar-update');
    assert.equal(await button.isHidden(), true, 'no button while the page is current');
    assert.equal(await button.evaluate((node) => node.closest('.topbar') !== null), true, 'the button lives in the top bar');

    await page.evaluate(() => { window.__marker = 'same page'; });
    live = 'b';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await button.waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await button.getAttribute('data-state'), 'ready'); assert.match(await button.getAttribute('aria-label'), /v901/);
    const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
    if (surface === 'shop') await assertShopUpdateLayout(page);
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => window.__marker), 'same page', 'no silent update: the page is still the old one after 3 s');

    const navigations = []; page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await button.click();
    await page.waitForFunction(() => window.__marker === undefined, null, { timeout: 20000 });
    await page.waitForFunction((prefix) => caches.keys().then((keys) => keys.length === 1 && keys[0] === `${prefix}-v901`), `os-${surface}`, { timeout: 20000 });
    assert.equal(navigations.length, 1, 'exactly one reload');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    assert.equal(await page.locator('#topbar-update').isHidden(), true, 'button gone on the new version');
    // Phones: icon-only, still a 44 px target, inside the screen.
    await page.setViewportSize({ width: 390, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(pageErrors, []);
  });
}
