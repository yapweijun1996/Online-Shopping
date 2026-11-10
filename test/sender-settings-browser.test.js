import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/sender-settings-browser';
const initial = { senderName: 'Fictional Sender', senderPhone: '+60321234567', senderAddressLine1: '100 Fictional Road', senderAddressLine2: '', senderCity: 'Kuala Lumpur', senderState: 'WP', senderPostcode: '01000', senderCountry: 'ZZ' };
async function fixture(t, width = 1280, colorScheme = 'light') {
  const { chromium } = await import(modulePath); const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close()); const owner = await f.login(); assert.equal((await f.request('PATCH', '/api/v1/seller/company-settings', initial, owner.headers)).response.status, 200);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' }); await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(), calls = [], errors = []; page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  const fault = { readStatus: null, readMalformed: false, writeStatus: null, malformed: false, readGate: null, writeGate: null };
  await page.route('**/api/v1/seller/company-settings', async route => {
    const request = route.request(); calls.push({ method: request.method(), body: request.postDataJSON() });
    if (request.method() === 'GET') { if (fault.readMalformed) { await route.fulfill({ json: {} }); return; } if (fault.readGate) await fault.readGate; if (fault.readStatus) { await route.fulfill({ status: fault.readStatus, json: { error: { code: fault.readStatus === 403 ? 'FORBIDDEN' : 'UNAVAILABLE' } } }); return; } }
    else { if (fault.writeGate) await fault.writeGate; if (fault.malformed) { await route.fulfill({ json: {} }); return; } if (fault.writeStatus) { await route.fulfill({ status: fault.writeStatus, json: { error: { code: fault.writeStatus === 403 ? 'FORBIDDEN' : 'UNAVAILABLE' } } }); return; } }
    await route.continue();
  });
  const form = page.locator('#company-form'), shipping = page.locator('#company-group-shipping'), save = form.locator('[type=submit]');
  const ready = () => page.waitForFunction(() => document.querySelector('#company-form')?.getAttribute('aria-busy') === 'false');
  const tab = id => page.locator(`#company-tab-${id}`).click();
  const field = name => page.locator(`#company-form [name=${name}]`);
  const writes = () => calls.filter(call => call.method === 'PATCH');
  const server = async () => (await f.request('GET', '/api/v1/seller/company-settings', null, owner.headers)).data;
  async function login() { await page.goto(`${f.origin}/seller/#company`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter'); await tab('shipping'); await ready(); }
  mkdirSync(artifacts, { recursive: true }); const shot = async label => { await page.evaluate(() => new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(resolve); })); await page.screenshot({ path: `${artifacts}/${label}-${width}-${colorScheme}.png`, fullPage: true, animations: 'disabled' }); };
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollX === 0), true);
  return { f, owner, page, form, shipping, save, fault, errors, tab, field, ready, writes, server, login, shot, noOverflow };
}
for (const width of [390, 768, 1280, 1920]) for (const scheme of ['light', 'dark']) test(`Shipping optional fields and real scoped saves: ${width}px ${scheme}`, { skip: !modulePath, timeout: 30000 }, async t => {
  const q = await fixture(t, width, scheme); await q.login();
  assert.equal(await q.shipping.locator('fieldset').count(), 2); assert.equal(await q.shipping.locator('[required]').count(), 0); assert.equal(await q.save.innerText(), 'Save sender details'); assert.equal(await q.save.isDisabled(), true);
  assert.equal(await q.field('senderCountry').inputValue(), 'ZZ'); assert.equal(await q.field('senderCountry').locator('option:checked').innerText(), 'ZZ'); assert.equal(await q.field('senderPhone').inputValue(), '+60321234567'); assert.equal(await q.field('senderPhone').getAttribute('maxlength'), '32'); assert.equal(await q.field('senderPhone').getAttribute('autocomplete'), 'section-sender tel');
  await q.field('senderName').focus(); await q.page.keyboard.press('Tab'); assert.equal(await q.field('senderPhone').evaluate(el => el === document.activeElement), true);
  const nameBox = await q.field('senderName').boundingBox(), phoneBox = await q.field('senderPhone').boundingBox(), lineBox = await q.field('senderAddressLine1').boundingBox(), cityBox = await q.field('senderCity').boundingBox(), stateBox = await q.field('senderState').boundingBox();
  if (width > 600) { assert.ok(Math.abs(nameBox.y - phoneBox.y) < 1); assert.ok(Math.abs(cityBox.y - stateBox.y) < 1); assert.ok(lineBox.width > cityBox.width * 1.8); } else { assert.ok(phoneBox.y > nameBox.y + nameBox.height); assert.ok(stateBox.y > cityBox.y + cityBox.height); }
  await q.form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); assert.equal(q.writes().length, 0);
  await q.field('senderName').fill('Changed draft'); assert.equal(await q.save.isEnabled(), true); await q.field('senderName').fill(initial.senderName); assert.equal(await q.save.isDisabled(), true, 'reverting is not dirty');
  if (scheme === 'dark') await q.page.evaluate(() => window.sellerPalette.choose('warm-plum')); await q.shot('shipping-en');
  if ([390, 1920].includes(width) && scheme === 'light') { await q.page.evaluate(async () => (await import('/shared/i18n.js')).setLocale('zh-Hans')); assert.ok((await q.field('senderCountry').locator('option[value=MY]').innerText()).includes('马来西亚')); await q.shot('shipping-zh'); await q.page.evaluate(async () => (await import('/shared/i18n.js')).setLocale('en')); }
  await q.field('senderName').fill('  Updated Fictional Sender  '); await q.field('senderPhone').fill('+60 3-2123 4567');
  await q.tab('general'); await q.field('mobileHideBarsOnScroll').check(); await q.tab('storefront'); await q.field('availabilityText').fill('Unsaved storefront copy'); await q.tab('shipping'); await q.save.click(); await q.ready();
  assert.deepEqual(Object.keys(q.writes()[0].body), Object.keys(initial)); assert.equal(await q.field('senderName').inputValue(), 'Updated Fictional Sender'); assert.equal(await q.field('senderPhone').inputValue(), '+60321234567'); assert.equal(await q.save.isDisabled(), true); assert.ok((await q.page.locator('.settings-status').innerText()).includes('saved'));
  const afterShipping = await q.server(); assert.equal(afterShipping.mobileHideBarsOnScroll, false); assert.equal(afterShipping.availabilityText, null);
  await q.tab('general'); assert.equal(await q.field('mobileHideBarsOnScroll').isChecked(), true); assert.equal(await q.save.isEnabled(), true); await q.save.click(); await q.ready(); assert.deepEqual(Object.keys(q.writes()[1].body), ['defaultCurrency', 'sellerWhatsAppPhone', 'mobileHideBarsOnScroll']);
  await q.tab('shipping'); await q.field('senderCity').fill('Uncommitted city'); await q.tab('storefront'); assert.equal(await q.field('availabilityText').inputValue(), 'Unsaved storefront copy'); await q.save.click(); await q.ready(); assert.deepEqual(Object.keys(q.writes()[2].body), ['availabilityText', 'shippingText', 'returnsText']); assert.equal((await q.server()).senderCity, initial.senderCity);
  await q.tab('shipping'); assert.equal(await q.field('senderCity').inputValue(), 'Uncommitted city'); assert.equal(await q.save.isEnabled(), true); await q.field('senderCity').fill(initial.senderCity); assert.equal(await q.save.isDisabled(), true);
  // Arbitrary accepted codes remain possible without a list of unassigned options; switching to a named choice disables stale custom input.
  await q.field('senderCountry').selectOption('__other__'); await q.field('senderCountryOther').fill('aa'); await q.field('senderCountry').selectOption('MY'); assert.equal(await q.field('senderCountryOther').isDisabled(), true); await q.save.click(); await q.ready(); assert.equal((await q.server()).senderCountry, 'MY');
  await q.field('senderCountry').selectOption('__other__'); await q.field('senderCountryOther').fill('AA'); await q.save.click(); await q.ready(); assert.equal((await q.server()).senderCountry, 'AA'); assert.equal(await q.field('senderCountry').inputValue(), 'AA');
  await q.noOverflow(); await q.page.reload(); await q.tab('shipping'); await q.ready(); assert.equal(await q.field('senderCountry').inputValue(), 'AA'); assert.equal(await q.save.isDisabled(), true);
  if (width === 1280 && scheme === 'light') { for (const locale of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) { await q.page.evaluate(async value => (await import('/shared/i18n.js')).setLocale(value), locale); assert.ok(!(await q.shipping.innerText()).includes('senderPhoneHelp')); assert.equal(await q.field('senderCountry').inputValue(), 'AA'); await q.noOverflow(); } await q.page.evaluate(async () => (await import('/shared/i18n.js')).setLocale('en'));
    for (const name of Object.keys(initial)) { if (name === 'senderCountry') await q.field(name).selectOption(''); else await q.field(name).fill(''); } await q.save.click(); await q.ready(); assert.ok(Object.keys(initial).every(name => (q.writes().at(-1).body[name]) === ''), 'optional fields may all be cleared'); const cleared = await q.server(); assert.ok(Object.keys(initial).every(name => cleared[name] === null)); }
  assert.deepEqual(q.errors, []);
});

test('Shipping load/validation failures, exact pending group and late results preserve drafts', { skip: !modulePath, timeout: 40000 }, async t => {
  const q = await fixture(t); q.fault.readStatus = 503; await q.login(); assert.equal(await q.save.isDisabled(), true); assert.equal(await q.field('senderName').isDisabled(), true); assert.equal(await q.page.locator('#company-retry').isVisible(), true); await q.form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); assert.equal(q.writes().length, 0);
  q.fault.readStatus = null; q.fault.readMalformed = true; await q.page.locator('#company-retry').click(); await q.ready(); assert.equal(await q.field('senderName').isDisabled(), true, 'malformed initial data cannot enable blank writes'); q.fault.readMalformed = false; await q.page.locator('#company-retry').click(); await q.ready(); assert.equal(await q.field('senderName').inputValue(), initial.senderName);
  await q.field('senderPhone').fill('invalid'); await q.save.click(); await q.ready(); assert.equal(await q.field('senderPhone').getAttribute('aria-invalid'), 'true'); assert.equal(await q.field('senderPhone').evaluate(el => el === document.activeElement), true); assert.ok((await q.field('senderPhone').getAttribute('aria-describedby')).includes('company-error-senderPhone')); assert.equal(await q.field('senderPhone').inputValue(), 'invalid'); await q.field('senderPhone').fill(initial.senderPhone); assert.equal(await q.field('senderPhone').getAttribute('aria-invalid'), null); assert.equal(await q.save.isDisabled(), true);
  await q.field('senderCity').fill('Pending city'); let releaseWrite; q.fault.writeGate = new Promise(resolve => { releaseWrite = resolve; }); await q.save.click(); await q.page.waitForFunction(() => document.querySelector('#company-form')?.getAttribute('aria-busy') === 'true'); await q.form.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(await q.field('senderCity').isDisabled(), true); await q.tab('storefront'); assert.equal(await q.field('availabilityText').isEnabled(), true); await q.field('availabilityText').fill('Sibling changed while Shipping saves'); assert.equal(await q.save.isDisabled(), true); releaseWrite(); await q.ready(); q.fault.writeGate = null; assert.equal(q.writes().length, 2); assert.equal(await q.field('availabilityText').inputValue(), 'Sibling changed while Shipping saves'); assert.equal(await q.save.isEnabled(), true); assert.equal((await q.server()).availabilityText, null);
  await q.tab('shipping'); await q.field('senderCity').fill('Keep this draft'); q.fault.malformed = true; await q.save.click(); await q.ready(); assert.equal(await q.field('senderCity').inputValue(), 'Keep this draft'); assert.ok((await q.page.locator('.settings-status').innerText()).includes('Could not confirm')); assert.equal(await q.save.isEnabled(), true); q.fault.malformed = false;
  q.fault.writeStatus = 403; await q.save.click(); await q.ready(); assert.ok((await q.page.locator('.settings-status').innerText()).includes('permission')); assert.equal(await q.save.isDisabled(), true); q.fault.writeStatus = null; await q.page.locator('#company-retry').click(); await q.ready(); assert.equal(await q.field('senderCity').inputValue(), 'Keep this draft'); assert.equal(await q.save.isEnabled(), true);
  let finish; q.fault.writeGate = new Promise(resolve => { finish = resolve; }); await q.save.click(); q.page.once('dialog', dialog => dialog.accept()); await q.page.goto(`${q.f.origin}/seller/#products`); await q.page.locator('#product-list').waitFor(); finish(); q.fault.writeGate = null; await q.page.waitForTimeout(30); assert.equal(await q.form.count(), 0, 'late canonical response cannot remount a disposed settings page');
  assert.deepEqual(q.errors, []);
});

test('Company unauthorized save uses existing login cleanup and cannot restore old controls', { skip: !modulePath, timeout: 20000 }, async t => {
  const q = await fixture(t); await q.login(); await q.field('senderCity').fill('A draft'); q.fault.writeStatus = 401; await q.save.click(); await q.page.locator('#login-form').waitFor(); assert.equal(await q.form.count(), 0); assert.deepEqual(q.errors, []);
});

test('Shared settings module preserves Categories mount, edit/save and locale status refresh', { skip: !modulePath, timeout: 20000 }, async t => {
  const q = await fixture(t); await q.login(); await q.page.goto(`${q.f.origin}/seller/#categories`); await q.page.locator('#category-create').waitFor();
  const row = q.page.locator('#category-list .settings-row').filter({ hasText: 'EXAMPLES' }); await row.waitFor(); await row.locator('input:not([type=checkbox])').fill('Updated fictional category');
  await row.locator('button[type=submit]').click(); await q.page.getByText('Category saved.', { exact: true }).waitFor(); assert.ok((await row.innerText()).includes('EXAMPLES'));
  const categories = await q.f.request('GET', '/api/v1/seller/categories', null, q.owner.headers); assert.ok(categories.data.items.some(item => item.code === 'EXAMPLES' && item.label === 'Updated fictional category'));
  await q.page.evaluate(async () => (await import('/shared/i18n.js')).setLocale('zh-Hans')); assert.ok(!(await q.page.locator('.settings-status').innerText()).includes('Category saved')); assert.deepEqual(q.errors, []);
});

test('Invalid custom Shipping country drafts do not gate scoped General or Storefront saves', { skip: !modulePath, timeout: 25000 }, async t => {
  const q = await fixture(t); await q.login(); assert.equal(await q.form.evaluate(form => form.noValidate), true);
  for (const draft of ['z', 'aa']) {
    await q.tab('shipping'); await q.field('senderCountry').selectOption('__other__'); await q.field('senderCountryOther').fill(draft);
    await q.tab('general'); await q.field('mobileHideBarsOnScroll').setChecked(!(await q.field('mobileHideBarsOnScroll').isChecked())); await q.save.click(); await q.ready(); assert.deepEqual(Object.keys(q.writes().at(-1).body), ['defaultCurrency', 'sellerWhatsAppPhone', 'mobileHideBarsOnScroll']);
    await q.tab('storefront'); await q.field('availabilityText').fill(`Sibling copy ${draft}`); await q.save.click(); await q.ready(); assert.deepEqual(Object.keys(q.writes().at(-1).body), ['availabilityText', 'shippingText', 'returnsText']);
    await q.tab('shipping'); assert.equal(await q.field('senderCountryOther').inputValue(), draft); assert.equal(await q.save.isEnabled(), true); assert.equal((await q.server()).senderCountry, 'ZZ');
  }
  await q.save.click(); await q.ready(); assert.equal(await q.field('senderCountryOther').getAttribute('aria-invalid'), 'true'); assert.equal(await q.field('senderCountryOther').evaluate(el => el === document.activeElement), true); assert.equal(await q.field('senderCountryOther').inputValue(), 'aa'); assert.equal((await q.server()).senderCountry, 'ZZ'); assert.deepEqual(q.errors, []);
});
