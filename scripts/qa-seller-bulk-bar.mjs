import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createProduct } from '../src/products.js';
import { createApp } from '../src/server.js';
import { createCategory } from '../src/settings.js';

const out = process.env.QA_OUTPUT_DIR || join(homedir(), 'workspace', 'shots', 'bulk');
const config = {
  dbPath: ':memory:', shopMode: 'manual', username: 'synthetic_seller_bulk',
  password: randomUUID() + randomUUID(), production: false, publicOrigin: null,
};
const products = [
  ['Canvas Pencil Case', 1290, 12],
  ['Desk Planner', 2450, 8],
  ['Dot Grid Notebook', 1890, 24],
  ['Felt Desk Mat', 3500, 5],
  ['Gel Pen Set', 990, 17],
  ['Weekly Notepad', 1490, 0],
];
const count = products.length;
const heading = '.product-list-heading';
const shell = '.product-list-shell';
const bulk = '.product-bulk';
const buttons = ['Activate selected', 'Deactivate selected', 'Clear selection'];

async function seed(database) {
  await createCategory(database, { code: 'STATIONERY', label: 'Stationery' });
  for (const [index, [name, priceMinor, stockQuantity]] of products.entries()) {
    await createProduct(database, {
      sku: `ST-${101 + index}`, name, priceMinor, stockQuantity, active: false,
      description: 'Fictional product for screenshot QA', category: 'STATIONERY', currency: 'MYR',
    });
  }
}

async function signIn(page, origin) {
  await page.goto(`${origin}/seller/#products`);
  await page.locator('#username').fill(config.username);
  await page.locator('#password').fill(config.password);
  const [response] = await Promise.all([
    page.waitForResponse((result) => result.url() === `${origin}/api/v1/seller/session` && result.request().method() === 'POST'),
    page.locator('#login-submit').click(),
  ]);
  assert.equal(response.status(), 200, 'fixture sign-in succeeds');
  await page.locator('#product-list[aria-busy="false"]').waitFor({ state: 'attached' });
}

async function assertSelectionLayout(page) {
  const bar = page.locator(bulk);
  assert.equal(await bar.locator('strong').innerText(), `${count} selected`);
  assert.equal(await page.locator('#product-list [data-action="select"]:checked').count(), count);
  const boxes = await Promise.all([
    bar, page.locator(shell), page.locator(heading),
    ...buttons.map((name) => bar.getByRole('button', { name, exact: true })),
  ].map((locator) => locator.boundingBox()));
  const [barBox, shellBox, headingBox] = boxes;
  assert.ok(boxes.every(Boolean), 'bar, table card, heading and three buttons are visible');
  assert.ok(barBox.y + barBox.height < shellBox.y && shellBox.y <= headingBox.y,
    'the bulk bar is separate from and above the table card and its heading');
  const { width, height } = page.viewportSize();
  for (const box of [barBox, headingBox, ...boxes.slice(3)]) {
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height,
      'the bar, three buttons and heading fit in the screenshot');
  }
}

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const app = await createApp(config);
let browser;
try {
  await seed(app.database);
  const listening = once(app.server, 'listening');
  app.server.listen(0, '127.0.0.1');
  await listening;
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true });
  mkdirSync(out, { recursive: true });

  // Desktop light runs last: the message shot changes the fixture's product states.
  for (const [width, theme] of [[390, 'light'], [390, 'dark'], [1280, 'dark'], [1280, 'light']]) {
    const mobile = width === 390;
    const context = await browser.newContext({
      viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile,
      colorScheme: theme, locale: 'en', reducedMotion: 'reduce', serviceWorkers: 'block',
    });
    try {
      await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await signIn(page, origin);
      const inactive = page.locator('[data-catalog-status="inactive"]');
      await inactive.click();
      const selectAll = page.locator(heading).getByRole('checkbox', { name: 'Select all loaded products' });
      await selectAll.check();
      assert.equal(await inactive.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      await assertSelectionLayout(page);

      const base = join(out, `bulk-${mobile ? 'mobile' : 'desktop'}-${width}-${theme}`);
      await page.screenshot({ path: `${base}.png`, animations: 'disabled' });
      console.log(`PASS ${width}px ${theme}: ${base}.png`);

      if (!mobile && theme === 'light') {
        const bar = page.locator(bulk);
        const [response] = await Promise.all([
          page.waitForResponse((result) => result.url() === `${origin}/api/v1/seller/products/bulk` && result.request().method() === 'POST'),
          bar.getByRole('button', { name: 'Activate selected', exact: true }).click(),
        ]);
        assert.equal(response.status(), 200, 'bulk activation succeeds');
        assert.equal((await response.json()).changed, count);
        await bar.getByRole('status').filter({ hasText: `Done. ${count} changed.` }).waitFor();
        await page.locator(shell).waitFor({ state: 'hidden' });
        await page.screenshot({ path: `${base}-message.png`, animations: 'disabled' });
        console.log(`PASS activation status: ${base}-message.png`);
      }
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    if (app.server.listening) await app.close();
    else await app.database.close();
  }
}
