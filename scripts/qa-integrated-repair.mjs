import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { initializeShop } from '../src/shop-setup.js';
import { serveStatic } from '../src/static.js';

// Intercepted browser requests exercise the Fetch API directly. This does not
// replace HTTP-listener, Worker deployment, installed-PWA or physical-device QA.
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/repair/browser');
mkdirSync(out, { recursive: true });
const origin = 'https://synthetic-repair.invalid';
const sourceFiles = ['public/seller/app.js', 'public/seller/products.js', 'public/seller/settings.js',
'public/seller/integrations.js', 'public/seller/style.css', 'public/seller/commerce.css',
'public/seller/version.js', 'public/seller/sw.js', 'public/seller/index.html', 'public/seller/studio-copy.js',
'public/shared/i18n.js', 'src/app.js', 'src/db.js'];
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(sourceFiles.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  scope: 'One cached Chromium;390/1440;synthetic memory-only Fetch API and intercepted local assets;no network listener',
  cases: [], pageErrors: [], externalRequests: [] };
let browser;
try {
  const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  for (const width of [390, 1440]) {
    const store = await openDatabase(':memory:');
    const config = { username: 'synthetic_repair', password: randomUUID()+randomUUID(), shopMode: 'public-demo', publicOrigin: origin, production: false };
    await initializeShop(store, config);
    await ensureAdmin(store, config.username, config.password);
    const handle = await createApi({ store, config, serveStatic });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    try {
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin) {
          report.externalRequests.push(new URL(request.url()).origin);await route.abort();return;
        }
        const method = request.method(),body = request.postDataBuffer();
        const response = await handle(new Request(request.url(), { method, headers: await request.allHeaders(),
          ...(body && !['GET', 'HEAD'].includes(method) ? { body } : {}) }), { clientAddress: 'synthetic-browser' });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()) });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(8000);
      page.on('pageerror', (error) => report.pageErrors.push({ width, message: error.message }));
      const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.goto(origin + '/seller/');
      await page.locator('#login-view').waitFor({ state: 'visible' });
      await noOverflow();
      await page.screenshot({ path: resolve(out, `login-${width}.png`), fullPage: true });
      report.cases.push({ width, label: 'Owner-selected login loads with no document overflow', status: 'PASS' });

      // Exercise actual login so cookie and session hint are both established by the app.
      await page.locator('#login-form [name=username]').fill(config.username);
      await page.locator('#login-form [name=password]').fill(config.password);
      await page.locator('#login-form button[type=submit]').click();
      await page.locator('.dashboard-stats').waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-stat strong')].some((node) => node.textContent === '35'));
      assert.equal(await page.locator('#shop-context').isVisible(), true);
      await noOverflow();
      await page.goto(origin + '/seller/#products');
      await page.locator('.product-card').first().waitFor();
      await page.locator('.product-card-actions button').first().click();
      await page.locator('#product-form').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#product-gallery-list img').length === 6 &&
      [...document.querySelectorAll('#product-gallery-list img')].every((image) => image.complete && image.naturalWidth > 0));
      assert.equal(await page.locator('input[name="currency"]').getAttribute('readonly'), '');
      assert.equal(await page.locator('input[name="currency"]').inputValue(), 'MYR');
      const originalName = await page.locator('input[name="name"]').inputValue();
      await page.locator('input[name="name"]').fill(originalName + ' synthetic repair');
      await page.locator('#product-save').click();
      await page.locator('#product-form-success').filter({ hasText: /.+/ }).waitFor();
      await noOverflow();
      await page.screenshot({ path: resolve(out, `gallery-${width}.png`), fullPage: true });
      report.cases.push({ width, label: 'B grouped editor retains six decoded photos, inherited currency and metadata save', status: 'PASS' });

      await page.goto(origin + '/seller/#company');
      await page.waitForFunction(() => document.querySelectorAll('.integration-provider').length === 4);
      assert.equal(await page.locator('.integration-provider strong').count(), 4);
      const initial = await page.evaluate(() => localStorage.getItem('os-seller-palette'));
      await page.locator('.appearance-option button').first().click();
      await page.locator('.appearance-sample').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => localStorage.getItem('os-seller-palette')), initial);
      await page.locator('dialog[open] .modal-close').click();
      await page.locator('dialog[open]').waitFor({state:'detached'});
      assert.equal(await page.evaluate(() => localStorage.getItem('os-seller-palette')), initial);
      await noOverflow();
      await page.screenshot({ path: resolve(out, `settings-${width}.png`), fullPage: true });
      report.cases.push({ width, label: 'Four disabled provider cards and palette preview coexist without saving a preference', status: 'PASS' });
    } finally {await context.close();await store.close();}
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  report.status = 'PASS';
} catch (error) {
  report.status = !browser && /bootstrap_check_in|Permission denied|Operation not permitted/.test(error.message) ?
  'ENVIRONMENT_BLOCKED' : 'FAIL';
  report.error = String(error.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases, error: report.error }));
}
