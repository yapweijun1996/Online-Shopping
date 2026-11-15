import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const output = process.env.THEME_SHOTS || '/tmp/os-theme-shots';
const luminance = color => {
  const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722;
};
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + .05) / (low + .05); };

test('shared theme persists across Seller and Shop, follows System, and remains usable without storage', { skip: !modulePath, timeout: 120000 }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER_EXECUTABLE ? { executablePath: process.env.QA_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  mkdirSync(output, { recursive: true });
  const report = { browser: browser.version(), screenshots: [], contrast: [], errors: [] };
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
    t.after(() => context.close());
    await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
    const state = async (mode, resolved = mode) => {
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, resolved);
      assert.equal(await theme.inputValue(), mode);
      const chrome = await page.evaluate(() => ({ meta: document.querySelector('meta[name="theme-color"]').content, bar: getComputedStyle(document.querySelector('.topbar')).backgroundColor }));
      assert.equal(chrome.meta, resolved === 'dark' ? '#202d25' : '#ffffff');
      assert.equal(chrome.bar, resolved === 'dark' ? 'rgb(32, 45, 37)' : 'rgb(255, 255, 255)');
    };
    const capture = async (surface, mode) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${surface} ${width} ${mode} horizontal overflow`);
      assert.equal(await theme.isVisible(), true);
      const box = await theme.boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
      const colors = await page.evaluate(() => {
        const probe = document.createElement('span'); document.body.append(probe);
        const color = name => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
        const pairs = [['--ui-text', '--ui-surface'], ['--ui-muted', '--ui-surface'], ['--ui-secondary-text', '--ui-canvas'], ['--shop-error', '--ui-surface'], ['--shop-warning-text', '--shop-warning-background'], ['--ui-on-action', '--ui-action']];
        const result = pairs.map(([a, b]) => ({ foreground: a, background: b, colors: [color(a), color(b)] })); probe.remove(); return result;
      });
      for (const pair of colors) {
        const ratio = contrast(...pair.colors); assert.ok(ratio >= 4.5, `${surface} ${mode} ${pair.foreground} contrast ${ratio}`);
        report.contrast.push({ surface, mode, width, ...pair, ratio });
      }
      const path = `${output}/${surface}-${width}-${mode}.png`;
      await page.screenshot({ path, fullPage: true, animations: 'disabled' }); report.screenshots.push(path);
    };
    await page.goto(f.origin + '/seller/');
    await state('system', 'light');
    for (const mode of ['light', 'dark']) { await theme.selectOption(mode); await state(mode); await capture('seller-login', mode); }
    await page.reload(); await state('dark');
    // The persisted choice remains applied after navigation and an animation frame.
    assert.equal(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(document.documentElement.dataset.theme)))), 'dark');
    await page.fill('#username', f.config.username); await page.fill('#password', f.config.password); await page.click('#login-submit');
    await page.locator('.dashboard-home').waitFor();
    for (const mode of ['light', 'dark']) { await theme.selectOption(mode); await state(mode); await capture('seller-dashboard', mode); }
    const shop = await context.newPage(); await shop.goto(f.origin + '/shop/');
    await shop.locator('#shop-boot-loader').waitFor({ state: 'hidden' });
    assert.equal(await shop.getByRole('combobox', { name: 'Theme', exact: true }).inputValue(), 'dark');
    await shop.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
    await state('light'); // Cross-tab storage event synchronizes the seller.
    await shop.close();
    await page.goto(f.origin + '/shop/'); await page.locator('#shop-boot-loader').waitFor({ state: 'hidden' });
    for (const mode of ['light', 'dark']) { await theme.selectOption(mode); await state(mode); await capture('shop', mode); }
    await page.reload(); await state('dark');
    await page.emulateMedia({ colorScheme: 'light' }); await state('dark');
    await theme.selectOption('system'); await state('system', 'light');
    await page.emulateMedia({ colorScheme: 'dark' }); await state('system', 'dark');
    await page.reload(); await state('system', 'dark');
    for (const surface of ['seller', 'shop']) {
      await page.goto(`${f.origin}/${surface}/offline.html`); await state('system', 'dark');
      await theme.selectOption('light'); await state('light'); await theme.selectOption('system');
    }
    await context.close();
  }
  const blocked = await browser.newContext({ colorScheme: 'dark', serviceWorkers: 'block' }); t.after(() => blocked.close());
  await blocked.addInitScript(() => {
    for (const name of ['getItem', 'setItem']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function (key, ...args) { if (key === 'online-shopping-theme-v1') throw new DOMException('Blocked', 'SecurityError'); return original.call(this, key, ...args); };
    }
  });
  const page = await blocked.newPage(); await page.goto(f.origin + '/seller/');
  const select = page.getByRole('combobox', { name: 'Theme', exact: true });
  assert.equal(await select.inputValue(), 'system');
  await select.selectOption('light'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.reload(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.deepEqual(report.errors, []);
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
});
