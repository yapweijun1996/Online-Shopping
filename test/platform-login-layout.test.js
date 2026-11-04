import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;

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
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    a = await intro.boundingBox(); b = await form.boundingBox();
    assert.ok(a.y + a.height <= b.y, `intro stacks above form at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
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
