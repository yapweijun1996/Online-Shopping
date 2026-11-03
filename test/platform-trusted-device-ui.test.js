import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;

test('SuperAdmin trusted-device choice defaults to one week and sends only an explicit opt-in', { skip: !browserModule }, async t => {
  const publicRoot = path.resolve('public');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try {
      const data = await readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html'); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  let submitted = null;
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/platform/**', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/totp/confirm')) {
      submitted = { body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] };
      return route.fulfill({ json: { stage: 'FULL', csrfToken: 'synthetic-confirmed-csrf' } });
    }
    return route.fulfill({ json: url.pathname.endsWith('/session')
      ? { stage: 'PASSWORD', totpEnabled: true, username: 'synthetic-admin', csrfToken: 'synthetic-csrf' }
      : { items: [] } });
  });
  const url = `http://127.0.0.1:${server.address().port}/platform/index.html`;
  const trust = page.getByRole('checkbox', { name: 'Trust this device and keep me signed in' });
  const duration = page.getByLabel('Keep me signed in for', { exact: true });
  for (const [choice, width] of [['1d', 1280], ['1w', 375], ['1m', 1280], ['1y', 375], [null, 1280]]) {
    submitted = null; await page.setViewportSize({ width, height: 900 }); await page.goto(url);
    await trust.waitFor({ timeout: 2000 });
    assert.equal(await trust.isChecked(), false);
    assert.equal(await duration.inputValue(), '1w'); assert.equal(await duration.isDisabled(), true);
    assert.deepEqual(await duration.locator('option').allTextContents(), ['1 day', '1 week', '1 month (30 days)', '1 year (365 days)']);
    await trust.check(); assert.equal(await duration.isEnabled(), true);
    if (choice) await duration.selectOption(choice); else { await trust.uncheck(); assert.equal(await duration.isDisabled(), true); }
    assert.match(await page.getByText('Only use this on a personal device.', { exact: false }).innerText(), /Sign out/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel('Six-digit authenticator code', { exact: true }).fill('123456');
    if (process.env.QA_TRUSTED_DEVICE_SCREENSHOTS && (choice === '1d' || choice === '1w')) {
      await mkdir('.local/trusted-device', { recursive: true });
      await page.screenshot({ path: `.local/trusted-device/trusted-${width}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('heading', { name: 'Shops', exact: true }).waitFor();
    assert.equal(submitted.csrf, 'synthetic-csrf'); assert.equal(submitted.body.code, '123456');
    assert.equal(submitted.body.trustedDevice, Boolean(choice));
    if (choice) assert.equal(submitted.body.trustedDeviceDuration, choice);
    else assert.equal(Object.hasOwn(submitted.body, 'trustedDeviceDuration'), false);
  }
  assert.deepEqual(errors, []);
});
