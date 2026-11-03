import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Seller sign-in footer: version and update state sit below a divider, apart from the sign-in action, and show one state at
// a time (idle, checking, up to date, update available, failed) driven by a real Service Worker.
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

function build(version) {
  const dir = mkdtempSync(path.join(tmpdir(), 'seller-footer-'));
  cpSync(new URL('../public/', import.meta.url), dir, { recursive: true, verbatimSymlinks: true });
  for (const [name, pattern, replacement] of [['seller/version.js', /APP_VERSION = '[^']+'/, `APP_VERSION = '${version}'`], ['seller/sw.js', /version: '[^']+'/, `version: '${version}'`]]) {
    writeFileSync(path.join(dir, name), readFileSync(path.join(dir, name), 'utf8').replace(pattern, replacement));
  }
  return dir;
}

test('seller sign-in footer separates system information and shows each update state', { skip: !browserModule, timeout: 120000 }, async (t) => {
  const builds = { a: build('v900'), b: build('v901') };
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
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
  await context.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/v1/shop')) return route.fulfill({ json: { name: 'Synthetic Shop', currency: 'MYR', storageScope: '' } });
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } } });
  });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/seller/`);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
  const footer = page.locator('#login-footer'), status = page.locator('#login-update-status');
  const check = page.locator('#login-check-updates'), install = page.locator('#login-install-update');
  await footer.waitFor();

  // Idle: compact version label, one quiet text action, no result text yet.
  assert.equal(await page.locator('#login-version').innerText(), 'Seller Studio · v900');
  assert.equal(await footer.getAttribute('data-state'), 'idle');
  assert.equal(await check.innerText(), 'Check for updates'); assert.equal(await status.isHidden(), true);
  // Grouping: the footer comes after the privacy note, below a divider, and is not styled like the sign-in action.
  const layout = await page.evaluate(() => {
    const footerNode = document.querySelector('#login-footer'), privacy = document.querySelector('.privacy-note'), submit = document.querySelector('#login-submit');
    const style = getComputedStyle(footerNode), action = getComputedStyle(document.querySelector('#login-check-updates'));
    return { border: style.borderTopWidth, gap: footerNode.getBoundingClientRect().top - privacy.getBoundingClientRect().bottom,
      footerFont: parseFloat(style.fontSize), privacyFont: parseFloat(getComputedStyle(privacy).fontSize),
      actionColor: action.color, submitBackground: getComputedStyle(submit).backgroundColor, actionBackground: action.backgroundColor };
  });
  assert.equal(layout.border, '1px'); assert.ok(layout.gap >= 16, `gap ${layout.gap}`);
  assert.ok(layout.footerFont >= 12 && layout.privacyFont >= 12, JSON.stringify(layout));
  assert.notEqual(layout.actionColor, layout.submitBackground, 'the check action does not use the primary action colour');
  assert.equal(layout.actionBackground, 'rgba(0, 0, 0, 0)');
  // Keyboard: reachable after the sign-in button with a visible focus ring.
  await page.waitForFunction(() => !document.querySelector('#login-check-updates').disabled);
  await page.locator('#login-submit').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'login-check-updates');
  assert.notEqual(await check.evaluate((node) => getComputedStyle(node).outlineStyle), 'none');

  // Up to date: the result replaces the action, with a check icon.
  await check.click();
  await page.waitForFunction(() => document.querySelector('#login-footer').dataset.state === 'current', null, { timeout: 20000 });
  assert.equal((await status.innerText()).trim(), 'Up to date'); assert.equal(await status.locator('svg').count(), 1);
  assert.equal(await check.isHidden(), true); assert.equal(await install.isHidden(), true);

  // Update available: one explicit "Update to" action, nothing reloads by itself.
  live = 'b';
  await page.evaluate(() => { window.__marker = 'same page'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#login-footer').dataset.state === 'ready', null, { timeout: 20000 });
  assert.equal(await install.innerText(), 'Update to v901'); assert.equal(await check.isHidden(), true);
  assert.equal(await page.evaluate(() => window.__marker), 'same page');

  // Failed: a short message and a Try again action (fresh page on the new version, checked while offline).
  await install.click();
  await page.waitForFunction(() => window.__marker === undefined, null, { timeout: 20000 });
  await page.locator('#login-footer').waitFor();
  assert.equal(await page.locator('#login-version').innerText(), 'Seller Studio · v901');
  await context.setOffline(true);
  await page.locator('#login-check-updates').click();
  await page.waitForFunction(() => document.querySelector('#login-footer').dataset.state === 'failed', null, { timeout: 20000 });
  assert.equal((await page.locator('#login-update-status').innerText()).trim(), 'Check failed');
  assert.equal(await page.locator('#login-check-updates').innerText(), 'Try again');
  await context.setOffline(false);

  // Phones: one column, the footer stays inside the screen.
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const box = await page.locator('#login-footer').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
  assert.deepEqual(pageErrors, []);
});

test('seller sign-out shows a neutral confirmation above the form, not an error, and not after a refresh', { skip: !browserModule, timeout: 60000 }, async (t) => {
  const dir = build('v900');
  const server = createServer((request, response) => {
    let pathname = new URL(request.url, 'http://local').pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(dir, pathname);
    if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  let signedIn = false;
  const session = { username: 'synthetic', role: 'owner', csrfToken: 'synthetic-csrf', capabilities: [], quickLogin: false, mustChangePassword: false };
  await context.route('**/api/**', (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname.endsWith('/v1/seller/session')) {
      if (method === 'DELETE') { signedIn = false; return route.fulfill({ json: { ok: true } }); }
      if (method === 'POST') { signedIn = true; return route.fulfill({ json: session }); }
      return signedIn ? route.fulfill({ json: session })
        : route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } } });
    }
    if (url.pathname.endsWith('/v1/shop')) return route.fulfill({ json: { name: 'Synthetic Shop', currency: 'MYR', storageScope: '' } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/seller/`);
  await page.locator('#username').fill('synthetic'); await page.locator('#password').fill('Synthetic-pass-1'); await page.locator('#login-submit').click();
  await page.locator('#workspace').waitFor();
  await page.evaluate(() => document.querySelector('#sign-out-button').click());
  const notice = page.locator('#login-notice');
  await notice.waitFor();
  assert.equal(await notice.getAttribute('role'), 'status');
  assert.match(await notice.innerText(), /Signed out successfully\s+Sign in to continue\./);
  assert.equal(await notice.locator('svg').count(), 1);
  // Not an error: nothing in the error slot beside the password, no red text.
  assert.equal((await page.locator('#login-message').innerText()).trim(), '');
  const colours = await page.evaluate(() => ({ notice: getComputedStyle(document.querySelector('#login-notice strong')).color, error: getComputedStyle(document.querySelector('#login-message')).color }));
  assert.notEqual(colours.notice, colours.error);
  // Placement: under the heading, above the first field.
  const [noticeBox, userBox] = [await notice.boundingBox(), await page.locator('#username').boundingBox()];
  assert.ok(noticeBox.y + noticeBox.height < userBox.y);
  // A failed sign-in replaces it with the error next to the button.
  await context.route('**/api/v1/seller/session', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 401, json: { error: { code: 'INVALID_CREDENTIALS', message: 'no' } } }) : route.fallback());
  await page.locator('#username').fill('synthetic'); await page.locator('#password').fill('Wrong-password-1');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => document.querySelector('#login-message').textContent.trim() !== '');
  assert.equal(await notice.isHidden(), true);
  // Service Workers blocked here: the footer shows the version only, never a check that cannot run.
  assert.equal(await page.locator('#login-footer').getAttribute('data-state'), 'unavailable');
  assert.equal(await page.locator('.login-footer-update').isHidden(), true);
  // Temporary: a refresh of the sign-in page does not show it again.
  await page.reload(); await page.locator('#login-form').waitFor();
  await page.waitForFunction(() => !document.querySelector('#login-message').classList.contains('is-info'));
  assert.equal(await notice.isHidden(), true);
});
