import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const root = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

test('Seller shell keeps its compact brand while the interface accent changes', { skip: !browserModule }, async (t) => {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' });
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/v1/shop')) return route.fulfill({ json: { name: 'Test shop', currency: 'MYR', storageScope: '' } });
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/seller/`);
  await page.locator('#login-form').waitFor();
  const palettes = ['evergreen-teal', 'ocean-blue', 'warm-plum', 'navy-orange', 'high-contrast', 'graphite', 'indigo', 'emerald', 'rose', 'copper'];
  for (const mode of ['light', 'dark']) {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(mode);
    const accents = new Set();
    for (const palette of palettes) {
      const state = await page.evaluate(id => {
        const stored = window.sellerPalette.choose(id);
        const { documentElement: root } = document;
        const primary = getComputedStyle(root).getPropertyValue('--ui-primary').trim();
        const logos = [...document.querySelectorAll('.topbar .seller-brand-logo, .studio-login-brand .seller-brand-logo, .sidebar .seller-brand-logo')];
        return {
          stored, primary, applied: root.dataset.sellerPalette,
          tabIcon: document.querySelector('link[rel="icon"]').getAttribute('href'),
          logos: logos.map(logo => ({ src: logo.getAttribute('src'), loaded: logo.naturalWidth > 0 })),
        };
      }, palette);
      const label = `${mode}/${palette}`;
      assert.equal(state.stored, true, label);
      assert.equal(state.applied, palette, label);
      assert.match(state.primary, /^#[0-9a-f]{6}$/i, label);
      assert.equal(state.tabIcon, '/shared/brand/pomelo-compact.svg', label);
      assert.equal(state.logos.length, 4, label);
      for (const logo of state.logos) assert.deepEqual(logo, { src: '/shared/brand/pomelo-compact.svg', loaded: true }, label);
      accents.add(state.primary);
    }
    assert.equal(accents.size, palettes.length, mode);
  }
});
