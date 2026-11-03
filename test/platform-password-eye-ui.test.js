import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('platform password fields use an SVG eye button that toggles visibility without renaming the field', { skip: !browserModule }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try {
      const data = await readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await page.route('**/api/v1/platform/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } } });
    return route.fulfill({ json: { csrfToken: 'synthetic-csrf' } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/platform/index.html`);
  const input = page.getByLabel('Password', { exact: true }), eye = page.getByRole('button', { name: 'Show password', exact: true });
  await eye.waitFor();
  // An icon, not words: one SVG, no visible text, and the field keeps its own name.
  assert.equal(await eye.locator('svg').count(), 1); assert.equal((await eye.innerText()).trim(), '');
  assert.equal(await input.getAttribute('type'), 'password'); assert.equal(await eye.getAttribute('aria-pressed'), 'false');
  assert.equal(await input.evaluate(node => node.labels[0].textContent), 'Password');
  assert.ok((await eye.boundingBox()).width >= 44 && (await eye.boundingBox()).height >= 44);
  const shape = () => eye.locator('svg path').first().getAttribute('d');
  const hiddenShape = await shape(); assert.match(hiddenShape, /M3 3l18 18$/);
  // Same component as the Seller sign-in: icon inside the box on both fields, an arrow on the button.
  assert.equal(await page.locator('.login-input-wrap > svg').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).locator('svg').count(), 1);
  assert.equal(await page.locator('.login-input-wrap input').first().evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
  await input.fill('Synthetic-password-1');
  await eye.click();
  assert.equal(await input.getAttribute('type'), 'text'); assert.equal(await eye.getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(await shape(), /M3 3l18 18$/);
  assert.equal(await input.inputValue(), 'Synthetic-password-1');
  await eye.press('Enter'); assert.equal(await input.getAttribute('type'), 'password'); assert.equal(await shape(), hiddenShape);
  await eye.focus(); await page.keyboard.press('Space'); assert.equal(await input.getAttribute('type'), 'text');
  // The eye sits inside the input's right edge and nothing overflows on a phone.
  const box = await page.locator('.login-input-wrap').nth(1).boundingBox(), eyeBox = await eye.boundingBox();
  assert.ok(eyeBox.x >= box.x && eyeBox.x + eyeBox.width <= box.x + box.width + 1 && eyeBox.y >= box.y - 1 && eyeBox.y + eyeBox.height <= box.y + box.height + 1);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
