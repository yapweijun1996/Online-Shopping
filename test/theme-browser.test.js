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
      const icon = await page.locator('[data-theme-control] svg').evaluate(node => node.innerHTML);
      assert.match(icon, mode === 'system' ? /<rect/ : mode === 'light' ? /<circle/ : /<path/);
      assert.doesNotMatch(icon, mode === 'system' ? /<circle/ : mode === 'light' ? /<rect/ : /<rect|<circle/);
      const chrome = await page.evaluate(() => ({ meta: document.querySelector('meta[name="theme-color"]').content, bar: getComputedStyle(document.querySelector('.topbar')).backgroundColor }));
      const seller = new URL(page.url()).pathname.startsWith('/seller/');
      const darkMeta = seller ? '#1a1e25' : '#202d25';
      const darkBar = seller ? 'rgb(26, 30, 37)' : 'rgb(32, 45, 37)';
      assert.equal(chrome.meta, resolved === 'dark' ? darkMeta : '#ffffff');
      assert.equal(chrome.bar, resolved === 'dark' ? darkBar : 'rgb(255, 255, 255)');
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

const paletteIds = ['evergreen-teal', 'warm-plum', 'ocean-blue', 'navy-orange', 'high-contrast', 'graphite', 'indigo', 'emerald', 'rose', 'copper'];
const paletteRoles = ['--ui-surface', '--ui-text', '--ui-muted', '--ui-primary', '--ui-action', '--ui-on-action', '--ui-primary-hover',
  '--ui-control-border', '--ui-focus', '--shop-selected-surface', '--shop-selected-text', '--shop-price', '--shop-order-total',
  '--shop-error', '--shop-success', '--shop-warning-background', '--shop-warning-text'];
const statusRoles = ['--shop-price', '--shop-order-total', '--shop-error', '--shop-success', '--shop-warning-background', '--shop-warning-text'];

async function readPalette(scope) {
  return scope.evaluate((element, roles) => {
    const probe = document.createElement('span');
    element.append(probe);
    const colors = {};
    for (const role of roles) {
      if (!getComputedStyle(element).getPropertyValue(role).trim()) continue;
      probe.style.color = `var(${role})`;
      colors[role] = getComputedStyle(probe).color;
    }
    probe.remove();
    return colors;
  }, paletteRoles);
}

test('ten Shop and Seller palettes retain distinct accents and preview parity in both appearance modes', { skip: !modulePath, timeout: 180000 }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER_EXECUTABLE ? { executablePath: process.env.QA_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const fixture = await sellerFixture();
  t.after(() => fixture.close());
  const context = await browser.newContext({ viewport: { width: 768, height: 960 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  mkdirSync(output, { recursive: true });

  const pairs = [
    ['--ui-text', '--ui-surface', 4.5], ['--ui-muted', '--ui-surface', 4.5], ['--ui-primary', '--ui-surface', 4.5],
    ['--ui-on-action', '--ui-action', 4.5], ['--ui-on-action', '--ui-primary-hover', 4.5],
    ['--ui-control-border', '--ui-surface', 3], ['--ui-focus', '--ui-surface', 3],
    ['--shop-selected-text', '--shop-selected-surface', 4.5], ['--shop-price', '--ui-surface', 4.5],
    ['--shop-order-total', '--ui-surface', 4.5], ['--shop-error', '--ui-surface', 4.5], ['--shop-success', '--ui-surface', 4.5],
    ['--shop-warning-text', '--shop-warning-background', 4.5],
  ];

  for (const surface of ['shop', 'seller']) {
    const page = await context.newPage();
    const root = page.locator('html');
    const options = page.locator('.appearance-options');
    const topbar = page.locator('.topbar');
    const settingsPath = `/${surface}/#${surface === 'shop' ? 'settings' : 'company'}`;
    if (surface === 'seller') {
      await page.goto(fixture.origin + '/seller/');
      await page.fill('#username', fixture.config.username);
      await page.fill('#password', fixture.config.password);
      await page.click('#login-submit');
      await page.locator('.dashboard-home').waitFor();
    }
    await page.goto(fixture.origin + settingsPath);
    if (surface === 'seller') await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await options.waitFor();
    const actualIds = await options.locator('input[type="radio"]').evaluateAll(inputs => inputs.map(input => input.value));
    assert.deepEqual([...actualIds].sort(), [...paletteIds].sort(), surface);
    for (const mode of ['light', 'dark']) {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(mode);
      let baselineStatus;
      const accents = new Set();
      for (const id of paletteIds) {
        const label = `${surface}/${mode}/${id}`;
        const row = options.locator('.appearance-option').filter({ has: page.locator(`input[value="${id}"]`) });
        const trigger = row.locator('button');
        const paletteAttribute = `data-${surface}-palette`;
        const previous = await root.getAttribute(paletteAttribute);
        await trigger.click();
        const modal = page.locator('.app-modal[open]');
        const preview = modal.locator('.appearance-sample');
        assert.equal(await preview.getAttribute('data-palette'), id, label);
        assert.equal(await root.getAttribute(paletteAttribute), previous, label);
        const previewColors = await readPalette(preview);
        await modal.locator('.modal-content > .primary-button').click();
        assert.equal(await root.getAttribute(paletteAttribute), id, label);
        const colors = await readPalette(root);
        assert.deepEqual(colors, previewColors, `${label} preview and applied role values`);
        accents.add(colors['--ui-primary']);
        const actualStatus = statusRoles.map(role => colors[role]);
        baselineStatus ??= actualStatus;
        assert.deepEqual(actualStatus, baselineStatus, `${label} status colors`);
        for (const [foreground, background, minimum] of pairs) {
          assert.ok(colors[foreground] && colors[background], `${label} resolves ${foreground} and ${background}`);
          assert.ok(contrast(colors[foreground], colors[background]) >= minimum, `${label} ${foreground} vs ${background}`);
        }
        const barColor = await topbar.evaluate(element => getComputedStyle(element).backgroundColor);
        const darkBar = surface === 'seller' ? 'rgb(26, 30, 37)' : 'rgb(32, 45, 37)';
        assert.equal(barColor, mode === 'dark' ? darkBar : 'rgb(255, 255, 255)', label);
        assert.equal(barColor, colors['--ui-surface'], label);
      }
      assert.equal(accents.size, paletteIds.length, `${surface} ${mode} has a distinct accent for each palette`);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 960 });
        const viewportLabel = `${surface}/${mode}/${width}`;
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${viewportLabel} overflow`);
        if (surface === 'shop') {
          const placeholder = await page.locator('#catalog-search').evaluate(input => {
            const style = getComputedStyle(input, '::placeholder');
            return { color: style.color, opacity: style.opacity, background: getComputedStyle(input.form).backgroundColor };
          });
          assert.equal(placeholder.opacity, '1', viewportLabel);
          assert.ok(contrast(placeholder.color, placeholder.background) >= 4.5, `${viewportLabel} search placeholder contrast`);
        }
        if (width !== 320) await topbar.screenshot({ path: `${output}/palette-topbar-${surface}-${mode}-${width}.png`, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 768, height: 960 });
    }
    await page.close();
  }
});
