import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerFixture } from './helpers/seller-app.js';

// Uses the same opt-in installed Playwright module as the repository's UI QA scripts.
const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
test('Company settings is split into tabs: one group per tab, keyboard navigation, remembered tab, errors jump to their tab', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => route.request().url().startsWith(f.origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(f.origin + '/seller/');
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password);
  await page.locator('#password').press('Enter');
  await page.getByRole('button', { name: 'Company settings', exact: true }).click();
  const tablist = page.getByRole('tablist', { name: 'Company settings sections' });
  await tablist.waitFor();
  assert.deepEqual(await tablist.getByRole('tab').allInnerTexts(), ['General', 'Product page', 'Shipping', 'WhatsApp', 'Appearance']);
  const visible = (selector) => page.locator(selector).isVisible();
  // General is the first tab; the other form groups are not shown.
  assert.equal(await visible('#company-group-general'), true);
  assert.equal(await visible('#company-group-storefront'), false);
  assert.equal(await visible('#company-group-shipping'), false);
  // Keyboard: ArrowRight moves focus and selection; End goes to the last tab.
  await page.getByRole('tab', { name: 'General' }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Product page' }).getAttribute('aria-selected'), 'true');
  assert.equal(await visible('#company-group-storefront'), true); assert.equal(await visible('#company-group-general'), false);
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected'), 'true');
  assert.equal(await visible('#company-form'), false);
  await page.getByRole('tab', { name: 'WhatsApp' }).click();
  assert.equal(await visible('#company-form'), false);
  // Shipping holds the sender address; an invalid sender phone is reported there even when saved from another tab.
  await page.getByRole('tab', { name: 'Shipping' }).click();
  await page.locator('[name=senderPhone]').fill('+60312345678');
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Check the sender / pickup address.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Shipping' }).getAttribute('aria-selected'), 'true');
  assert.equal(await visible('[name=senderPhone]'), true);
  // The selected tab survives a reload of the page.
  await page.reload(); await tablist.waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Shipping' }).getAttribute('aria-selected'), 'true');
  // Phone width: no horizontal page overflow, the tab strip scrolls.
  await page.setViewportSize({ width: 375, height: 812 }); await page.reload(); await tablist.waitFor();
  const overflow = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, [...document.querySelectorAll('body *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1 && !n.closest('.company-tabs')).slice(0, 5).map(n => n.tagName + '.' + n.className)]);
  assert.ok(overflow[0] <= overflow[1], JSON.stringify(overflow));
});
