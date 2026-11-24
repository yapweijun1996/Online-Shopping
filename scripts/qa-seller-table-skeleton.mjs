import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProduct } from '../src/products.js';
import { sellerFixture } from '../test/helpers/seller-app.js';
import { controlProductResponses, signInToProducts } from '../test/helpers/seller-skeleton-browser.js';

const out = process.env.QA_OUTPUT_DIR || './shots';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const fixture = await sellerFixture();
let browser;
try {
  for (const [sku, name] of [['QA-001', 'Desk Planner'], ['QA-002', 'Gel Pen Set']]) {
    await createProduct(fixture.app.database, {
      sku, name, description: 'Fictional stationery for screenshot QA', category: 'EXAMPLES',
      priceMinor: 1250, currency: 'MYR', active: true, stockQuantity: 12,
    });
  }
  browser = await chromium.launch({ headless: true });
  mkdirSync(out, { recursive: true });
  for (const width of [1280, 390]) {
    const mobile = width === 390;
    const context = await browser.newContext({
      viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile,
      colorScheme: 'light', locale: 'en', reducedMotion: 'no-preference', serviceWorkers: 'block',
    });
    try {
      const holdProducts = await controlProductResponses(context, fixture);
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const response = holdProducts();
      await signInToProducts(page, fixture);
      const skeleton = page.locator('#product-list[aria-busy="true"] .product-skeleton');
      await Promise.all([skeleton.first().waitFor(), response.requested]);
      if (!mobile) await page.waitForFunction(() => document.querySelector('#main').getBoundingClientRect().left >= document.querySelector('#sidebar').getBoundingClientRect().right - 1);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await skeleton.count(), 3);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow while loading');
      assert.ok(await skeleton.evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth)), 'skeleton columns fit inside their rows');
      const pendingBox = await skeleton.first().boundingBox();
      assert.ok(pendingBox && pendingBox.x >= 0 && pendingBox.x + pendingBox.width <= width, 'the first row fits the viewport');
      const path = join(out, `seller-table-skeleton-${mobile ? 'mobile' : 'desktop'}-${width}.png`);
      await page.screenshot({ path, fullPage: mobile });

      response.release();
      const products = page.locator('#product-list[aria-busy="false"] [data-product-id]');
      await products.first().waitFor();
      assert.equal(await products.count(), 3);
      assert.equal(await page.locator('.product-skeleton').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow after loading');
      const loadedBox = await products.first().boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(pendingBox[key] - loadedBox[key]) <= 1, `${width}px row ${key}: pending ${pendingBox[key]}, loaded ${loadedBox[key]}`);
      }
      assert.deepEqual(pageErrors, []);
      console.log(`PASS ${width}px: ${path}`);
    } finally {
      await context.close();
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await fixture.close();
  }
}
