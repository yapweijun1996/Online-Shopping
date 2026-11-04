import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;

test('both login shells share one layout source and cache it', () => {
  const shared = path.resolve('public/shared/login-shell.css');
  assert.equal(realpathSync('public/platform/shared/login-shell.css'), shared);
  const styles = readFileSync('public/seller/style.css', 'utf8');
  assert.match(styles, /@import url\('\.\.\/shared\/login-shell\.css'\)/);
  for (const file of ['public/seller/style.css', 'public/seller/commerce.css', 'public/platform/style.css']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /^\s*\.login-layout\s*\{/m, `${file} must not own a second login shell`);
  }
  assert.match(readFileSync('public/seller/sw.js', 'utf8'), /'\.\.\/shared\/login-shell\.css'/);
  assert.match(readFileSync('public/platform/sw.js', 'utf8'), /'\.\/shared\/login-shell\.css'/);
});

test('platform sign-in uses a responsive seller-style layout without changing the authenticator flow', { skip: !browserModule }, async t => {
  const root = path.resolve('public');
  const server = createServer(async (req, res) => {
    try {
      const file = path.join(root, new URL(req.url, 'http://local').pathname);
      const content = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webp') ? 'image/webp' : 'text/html');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requests = [];
  let failCsrf = true, failLogin = true;
  await page.route('**/api/v1/platform/**', route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname });
    if (url.pathname.endsWith('/session') && request.method() === 'GET') return route.fulfill({ status: 401, json: { error: { message: 'Sign in required' } } });
    if (url.pathname.endsWith('/csrf') && failCsrf) return route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } });
    if (url.pathname.endsWith('/session') && failLogin) return route.fulfill({ status: 401, json: { error: { message: 'Unsafe detail' } } });
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: { csrfToken: 'synthetic', stage: 'TOTP', totpEnabled: true } });
    return route.fulfill({ json: { csrfToken: 'synthetic' } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/platform/index.html`);
  await page.getByRole('alert').filter({ hasText: 'Unable to prepare sign-in' }).waitFor();
  failCsrf = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByLabel('SuperAdmin username').waitFor();
  assert.ok(await page.getByRole('button', { name: 'Check for updates' }).count());
  const intro = page.locator('.platform-login-intro'), form = page.locator('#content form');
  assert.equal(await intro.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
  let a = await intro.boundingBox(), b = await form.boundingBox();
  assert.ok(a.x + a.width <= b.x, 'desktop intro sits beside the sign-in form');
  const seller = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await seller.route('**/api/v1/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/seller/session')) return route.fulfill({ status: 401, json: { error: { message: 'Sign in required' } } });
    return route.fulfill({ json: { mode: 'demo', shopName: 'Example', currency: 'MYR' } });
  });
  await seller.goto(`http://127.0.0.1:${server.address().port}/seller/index.html`);
  await seller.locator('#login-view:not([hidden]) #username').waitFor();
  const metrics = async (tab, selectors) => tab.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
    const node = document.querySelector(selector), rect = node.getBoundingClientRect(), css = getComputedStyle(node);
    return [key, { width: rect.width, height: rect.height, fontSize: css.fontSize, fontWeight: css.fontWeight, color: css.color }];
  })), selectors);
  const sellerMetrics = await metrics(seller, { intro: '.login-intro', title: '.login-intro h1', input: '#login-form .login-input-wrap', button: '#login-submit' });
  const platformMetrics = await metrics(page, { intro: '.platform-login-intro', title: '.platform-login-title', input: '#content .login-input-wrap', button: '#content form button[type=submit]' });
  assert.ok(Math.abs(sellerMetrics.intro.width - platformMetrics.intro.width) < 2, 'two pages use the same desktop column proportions');
  assert.equal(platformMetrics.title.fontSize, sellerMetrics.title.fontSize);
  assert.equal(platformMetrics.title.fontWeight, sellerMetrics.title.fontWeight);
  assert.equal(platformMetrics.title.color, sellerMetrics.title.color);
  assert.ok(Math.abs(sellerMetrics.input.width - platformMetrics.input.width) < 2, 'form fields use the same width');
  assert.equal(platformMetrics.button.height, sellerMetrics.button.height);
  assert.equal(await page.locator('#content .login-footer-action').count(), 2);
  for (const width of [1920, 1440, 1024, 768, 390, 320]) {
    if (width === 768) { await seller.setViewportSize({ width, height: 900 }); assert.ok((await seller.locator('#login-view').boundingBox()).width > 700, 'tablet shell preserves the existing Seller width'); }
    for (const tab of [seller, page]) await tab.setViewportSize({ width, height: 900 });
    for (const [tab, shellSelector, introSelector, areaSelector] of [
      [seller, '#login-view', '.login-intro', '#login-view .login-area'],
      [page, '.platform-login-shell', '.platform-login-intro', '.platform-login-panel']
    ]) {
      const geometry = await tab.evaluate(([shellSelector, introSelector, areaSelector]) => {
        const shell = document.querySelector(shellSelector), intro = document.querySelector(introSelector), area = document.querySelector(areaSelector);
        const card = shell.getBoundingClientRect(), image = intro.getBoundingClientRect(), panel = area.getBoundingClientRect(), css = getComputedStyle(shell);
        return { card: { top: card.top, bottom: card.bottom }, image: { top: image.top, bottom: image.bottom, right: image.right }, panel: { top: panel.top, bottom: panel.bottom, left: panel.left }, borderTop: parseFloat(css.borderTopWidth), borderBottom: parseFloat(css.borderBottomWidth), overflow: document.documentElement.scrollWidth > innerWidth };
      }, [shellSelector, introSelector, areaSelector]);
      assert.equal(geometry.overflow, false, `no overflow at ${width}px`);
      assert.ok(Math.abs(geometry.image.top - geometry.card.top - geometry.borderTop) < 1.1, `image meets card top at ${width}px`);
      assert.ok(Math.abs(geometry.panel.bottom - geometry.card.bottom + geometry.borderBottom) < 1.1, `panel meets card bottom at ${width}px`);
      if (width > 760) {
        assert.ok(Math.abs(geometry.image.bottom - geometry.card.bottom + geometry.borderBottom) < 1.1, `image meets card bottom at ${width}px`);
        assert.ok(Math.abs(geometry.image.right - geometry.panel.left) < 1.1, `columns meet at ${width}px`);
      } else assert.ok(Math.abs(geometry.image.bottom - geometry.panel.top) < 1.1, `stacked sections meet at ${width}px`);
    }
  }
  await seller.setViewportSize({ width: 320, height: 900 });
  for (const locale of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) {
    await seller.evaluate(async locale => { const { setLocale } = await import('/shared/i18n.js'); setLocale(locale); }, locale);
    assert.equal(await seller.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Seller ${locale} has no horizontal overflow`);
  }
  await seller.close();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-safe-bottom', '34px'));
  const darkGeometry = await page.evaluate(() => {
    const card = document.querySelector('.platform-login-shell').getBoundingClientRect();
    const image = document.querySelector('.platform-login-intro').getBoundingClientRect();
    return { gap: card.bottom - image.bottom, mainPadding: getComputedStyle(document.querySelector('#main')).paddingBottom };
  });
  assert.ok(darkGeometry.gap <= 1.1, 'safe-area padding must remain outside the dark-mode card');
  assert.ok(parseFloat(darkGeometry.mainPadding) >= 34);
  await page.evaluate(() => document.documentElement.style.removeProperty('--ui-safe-bottom'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 320, height: 568 });
  const actionBox = await page.getByRole('button', { name: 'Continue', exact: true }).boundingBox();
  assert.ok(actionBox.y + actionBox.height <= 568, 'primary action is visible on a short phone screen: ' + JSON.stringify(actionBox));
  await page.getByLabel('SuperAdmin username').fill('synthetic-admin');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'sign-in details could not be verified' }).waitFor();
  assert.doesNotMatch(await page.locator('#error').innerText(), /Unsafe detail/);
  failLogin = false; await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Six-digit authenticator code').waitFor();
  assert.equal(await intro.isVisible(), false, 'intro only appears on the sign-in screen');
  assert.ok(requests.some(item => item.path.endsWith('/session') && item.method === 'POST'));
});
