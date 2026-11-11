import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const root = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

test('seller logo follows the active palette on login and sidebar', { skip: !browserModule }, async (t) => {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(root)) return response.writeHead(404).end();
    try { response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/v1/shop')) return route.fulfill({ json: { name: 'Test shop', currency: 'MYR', storageScope: '' } });
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/seller/`);
  await page.locator('#login-form').waitFor();
  for (const palette of ['evergreen-teal', 'ocean-blue', 'warm-plum', 'navy-orange', 'high-contrast', 'graphite']) {
    await page.evaluate(id => window.sellerPalette.choose(id), palette);
    const state = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ui-primary)'; document.body.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      const logos = [...document.querySelectorAll('.topbar .seller-brand-logo, .studio-login-brand .seller-brand-logo, .sidebar .seller-brand-logo')];
      return { expected, logos: logos.map(logo => ({ color: getComputedStyle(logo).color, stroke: getComputedStyle(logo).stroke, ref: logo.querySelector('use').getAttribute('href') })) };
    });
    assert.equal(state.logos.length, 4);
    for (const logo of state.logos) assert.deepEqual(logo, { color: state.expected, stroke: 'none', ref: '/favicon.svg#mark' }, palette);
  }
});
