import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
import { createAccount } from '../src/accounts.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/more-icon-browser';
for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) test(`Shared filled more icon and real menus: ${width}px ${colorScheme}`, { skip: !modulePath, timeout: 30000 }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  await createAccount(f.app.database, { username: 'icon.fixture', role: 'STAFF', password: 'Fictional-Icon-2026!' }, f.config.username);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(6000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${f.origin}/seller/#team`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter');
  await page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'false');
  if (colorScheme === 'dark') await page.evaluate(() => window.sellerPalette.choose('warm-plum'));
  const geometry = async trigger => {
    assert.ok(await trigger.getAttribute('aria-label'));
    const result = await trigger.evaluate(el => {
      const svg = el.querySelector('svg'), path = svg.querySelector('path'), box = svg.getBoundingClientRect(), target = el.getBoundingClientRect(), paint = path.getBBox();
      const filled = (x, y) => path.isPointInFill(new DOMPoint(x, y));
      return { width: box.width, height: box.height, targetWidth: target.width, targetHeight: target.height, dx: (box.left + box.right - target.left - target.right) / 2, dy: (box.top + box.bottom - target.top - target.bottom) / 2, filled: [5, 12, 19].every(x => filled(x, 12)) && !filled(8.5, 12) && !filled(12, 8), paintWidth: paint.width, paintHeight: paint.height, fill: getComputedStyle(svg).fill, color: getComputedStyle(el).color, stroke: getComputedStyle(svg).stroke, hidden: svg.getAttribute('aria-hidden'), focusable: svg.getAttribute('focusable') };
    });
    assert.equal(result.width, 24); assert.equal(result.height, 24); assert.ok(result.targetWidth >= 44 && result.targetHeight >= 44); assert.ok(Math.abs(result.dx) < 1 && Math.abs(result.dy) < 1); assert.ok(result.filled); assert.equal(result.paintWidth, 18); assert.equal(result.paintHeight, 4); assert.equal(result.fill, result.color); assert.equal(result.stroke, 'none'); assert.equal(result.hidden, 'true'); assert.equal(result.focusable, 'false');
  };
  mkdirSync(artifacts, { recursive: true });
  const shot = async name => { await page.evaluate(() => new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(resolve); })); await page.screenshot({ path: `${artifacts}/${name}-${width}-${colorScheme}.png`, fullPage: true, animations: 'disabled' }); };
  const member = page.locator('.team-table tbody tr').filter({ hasText: 'icon.fixture' }), menu = member.locator('.team-more'), trigger = menu.locator('summary');
  await geometry(trigger); await trigger.focus(); await page.keyboard.press('Enter'); assert.ok(await menu.evaluate(el => el.open)); await page.keyboard.press('Tab'); assert.equal(await menu.locator('[data-team-action=role]').evaluate(el => el === document.activeElement), true); await page.keyboard.press('Escape'); assert.equal(await menu.evaluate(el => el.open), false); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  await trigger.click(); await shot('team-more'); await menu.locator('[data-team-action=role]').click(); await page.locator('.app-modal-team-drawer').waitFor(); await page.keyboard.press('Escape'); await page.locator('.app-modal-team-drawer').waitFor({ state: 'detached' });
  await page.goto(`${f.origin}/seller/#products`); await page.waitForFunction(() => document.querySelector('#product-list')?.getAttribute('aria-busy') === 'false');
  const productMenu = page.locator('.product-more-menu').first(), productTrigger = productMenu.locator('summary'); await geometry(productTrigger); await productTrigger.focus(); await page.keyboard.press('Space'); assert.ok(await productMenu.evaluate(el => el.open)); await shot('products-more'); await page.keyboard.press('Escape'); assert.equal(await productMenu.evaluate(el => el.open), false); assert.equal(await productTrigger.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollX === 0), true); assert.deepEqual(errors, []);
});
