import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerFixture } from './helpers/seller-app.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
for (const width of [375, 1280]) {
  test(`AI Studio replaces the previous page and survives return/re-entry at ${width}px`, { skip: !modulePath }, async t => {
    const { chromium } = await import(modulePath);
    const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
    const f = await sellerFixture(); t.after(() => f.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const external = [], pageErrors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== f.origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname.endsWith('/api/v1/seller/ai-studio')) return route.fulfill({ json: {
        available: true, configured: false, usedToday: 0, dailyCallCap: 20, keyRevision: 0, settingRevision: 1,
      } });
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    page.on('pageerror', error => pageErrors.push(error.message));
    const navigate = async view => {
      if (width < 1024) await page.locator('#open-menu').click();
      await page.locator(`.nav-item[data-view=${view}]`).click();
      await settle();
    };
    const studioOnly = async () => {
      await page.locator('.ai-studio').waitFor();
      assert.equal(await page.locator('#page-title').innerText(), 'AI Studio');
      assert.equal(await page.locator('#workspace-content .dashboard-home').count(), 0, 'the previous Dashboard must be removed');
      assert.equal(await page.locator('#workspace-content > .ai-studio').count(), 1);
      assert.equal(await page.locator('#workspace-content').evaluate(root => root.children.length), 1);
      assert.equal(await page.locator('.nav-item[data-view=aistudio]').getAttribute('aria-current'), 'page');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    };
    await page.goto(`${f.origin}/seller/`);
    await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password);
    await page.locator('#login-submit').click(); await page.locator('.dashboard-home').waitFor();
    await settle();
    for (let visit = 0; visit < 2; visit += 1) {
      await navigate('aistudio'); await studioOnly();
      await navigate('dashboard'); await page.locator('.dashboard-home').waitFor();
      assert.equal(await page.locator('#workspace-content .ai-studio').count(), 0);
      assert.equal(await page.locator('#workspace-content .dashboard-home').count(), 1);
    }
    // A direct authenticated deep link and a reload must also contain only one page.
    await page.goto(`${f.origin}/seller/#aistudio`); await settle(); await studioOnly();
    await page.reload(); await settle(); await studioOnly();
    assert.deepEqual(pageErrors, []); assert.deepEqual(external, [], 'no provider or external requests');
  });
}
