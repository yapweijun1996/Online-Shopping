import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('SuperAdmin can edit the default shop name and the seller username of every shop, with confirmation and the current revision', { skip: !browserModule }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try {
      const data = await readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shop = { id: '12345678-1234-4234-8234-123456789abc', code: 'default', name: 'Synthetic Mart', currency: 'MYR', status: 'ACTIVE', revision: 4, isDefault: true,
    sellerUsername: 'owner', orderCount: 3, productCount: 12, sellerUrl: 'http://127.0.0.1:9/seller/', shopUrl: 'http://127.0.0.1:9/shop/' };
  const writes = []; let failNext = null;
  await page.route('**/api/v1/platform/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      if (failNext) { const code = failNext; failNext = null; return route.fulfill({ status: 409, json: { error: { code, message: 'This username is already used.' } } }); }
      writes.push({ path: url.pathname, body, csrf: request.headers()['x-csrf-token'] });
      if (body.name) shop.name = body.name; if (body.username) shop.sellerUsername = body.username;
      shop.revision += 1; return route.fulfill({ json: { tenant: shop } });
    }
    const body = url.pathname.endsWith('/session') ? { stage: 'FULL', csrfToken: 'synthetic-csrf', username: 'admin' } : url.pathname.endsWith('/shops') ? { items: [shop] }
      : url.pathname.endsWith('/qr') ? null : shop;
    await route.fulfill({ json: body });
  });
  for (const isDefault of [true, false]) {
    shop.isDefault = isDefault; shop.code = isDefault ? 'default' : 'alpha'; shop.sellerUsername = 'owner'; shop.name = 'Synthetic Mart'; shop.revision = 4; writes.length = 0;
    await page.goto(`${origin}/platform/index.html`);
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('button', { name: 'Save username', exact: true }).waitFor();
    // Overview first: breadcrumb, state, KPI tiles, links with icon-only copy buttons; then grouped cards in a fixed order.
    assert.match(await page.locator('.breadcrumb').innerText(), /Platform\s*\/?\s*Shops\s*\/?\s*Synthetic Mart/);
    assert.equal(await page.locator('.breadcrumb [aria-current=page]').count(), 1);
    assert.equal(await page.locator('.detail-state .chip').first().innerText(), 'ACTIVE'); assert.match(await page.locator('.detail-code').innerText(), /Shop code: (default|alpha)/);
    assert.equal(await page.getByRole('link', { name: /^Open shop/ }).count(), 1); assert.equal(await page.getByRole('link', { name: /^Open seller/ }).count(), 1);
    assert.equal(await page.locator('.kpi').count(), 3); assert.match(await page.locator('.kpis').innerText(), /Orders\s+3/); assert.match(await page.locator('.kpis').innerText(), /Products\s+12/);
    assert.match(await page.locator('.detail-info').innerText(), /Deletion date\s+Not scheduled/);
    const copy = page.getByRole('button', { name: 'Copy Buyer storefront URL', exact: true }); assert.equal((await copy.innerText()).trim(), ''); assert.equal(await copy.locator('svg').count(), 1);
    assert.deepEqual(await page.locator('.group-title').allInnerTexts(), ['Shop information', 'Store links', 'Seller account & security', 'Shop settings', 'Integrations']);
    const security = (await page.locator('.group-seller').boundingBox()).y, settings = (await page.locator('.group-shop').boundingBox()).y, integrations = (await page.locator('.group-integrations').boundingBox()).y;
    assert.ok(security < settings && settings <= integrations, 'security first; settings and integrations may sit side by side on wide screens');
    // The QR policy is unavailable here: state beside the title, whose task it is, what to do; diagnostics folded, copyable, keyboard operable.
    const unavailable = page.locator('.qr-unavailable');
    assert.equal(await unavailable.locator('.chip').innerText(), 'Setup required');
    assert.equal(await unavailable.locator('.qr-header h3').innerText(), 'WhatsApp QR');
    assert.equal(await unavailable.locator('h4').innerText(), 'Platform setup pending');
    assert.match(await unavailable.locator('.qr-status').innerText(), /nothing is wrong with this shop[\s\S]*Host operator: run the platform upgrade/);
    assert.equal(await unavailable.locator('details').evaluate(node => node.open), false);
    assert.equal(await unavailable.locator('svg').evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-hidden') === 'true')), true);
    await unavailable.locator('summary').click();
    assert.equal(await unavailable.locator('details').evaluate(node => node.open), true);
    assert.equal(await unavailable.locator('summary').evaluate(node => getComputedStyle(node).outlineStyle), 'none', 'no focus box after a mouse click');
    assert.match(await unavailable.locator('pre').innerText(), /Missing: platform schema 3/);
    assert.equal(await unavailable.getByRole('button', { name: 'Copy technical details', exact: true }).count(), 1);
    await unavailable.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await unavailable.locator('details').evaluate(node => node.open), false, 'Enter closes the accordion');
    await page.keyboard.press('Space');
    assert.equal(await unavailable.locator('details').evaluate(node => node.open), true, 'Space opens it again');
    // Narrow phone: nothing overflows at 320 px.
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    // The header Edit shop shortcut lands on the name field.
    await page.getByRole('button', { name: 'Edit shop', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.group-shop') !== null), true);
    // The default shop shows no code field: its code is fixed. Other shops can still change code and name.
    assert.equal(await page.getByLabel('Shop code').count(), isDefault ? 0 : 1);
    await page.getByLabel('Shop name').fill('Fictional Renamed');
    // The page reloads the shop after a save; wait for that so the next field is not replaced mid-edit.
    const reloaded = () => page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/shops/${shop.id}`));
    await Promise.all([reloaded(), page.getByRole('button', { name: isDefault ? 'Save name' : 'Save name and code', exact: true }).click()]);
    await page.getByLabel('Shop name').waitFor();
    assert.equal(writes.at(-1).path.split('/').at(-1), 'rename'); assert.equal(writes.at(-1).body.name, 'Fictional Renamed');
    assert.equal(writes.at(-1).body.expectedRevision, 4); assert.equal(writes.at(-1).csrf, 'synthetic-csrf');
    if (isDefault) assert.equal('code' in writes.at(-1).body, false);
    // The save button is off until a field changes, and the save is confirmed next to the form.
    assert.equal(await page.getByRole('button', { name: 'Save username', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: isDefault ? 'Save name' : 'Save name and code', exact: true }).isDisabled(), true);
    assert.match(await page.getByRole('status').filter({ hasText: /^Shop name/ }).innerText(), isDefault ? /Shop name updated\./ : /Shop name and code updated\./);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'status');
    // Consequence text is tied to the field and the destructive action looks different.
    assert.match(await page.getByLabel('New seller username').evaluate((node) => document.getElementById(node.getAttribute('aria-describedby')).textContent), /connector sign-ins/);
    assert.match(await page.getByRole('button', { name: 'Reset seller password', exact: true }).getAttribute('class'), /danger-button/);
    // A refused save shows the error beside the form and keeps what was typed.
    await page.getByLabel('New seller username').fill('taken.name'); failNext = 'USERNAME_TAKEN';
    await page.getByRole('button', { name: 'Save username', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Change username', exact: true }).click();
    const problem = page.locator('.form-error:not([hidden])'); await problem.waitFor();
    assert.match(await problem.innerText(), /already used/); assert.equal(await page.getByLabel('New seller username').inputValue(), 'taken.name');
    assert.equal(await page.locator('#error').isHidden(), true);
    await page.getByLabel('New seller username').fill('owner');
    assert.equal(await page.getByRole('button', { name: 'Save username', exact: true }).isDisabled(), true);
    // Cancelling the confirmation sends nothing.
    const before = writes.length;
    await page.getByLabel('New seller username').fill('new.owner');
    await page.getByRole('button', { name: 'Save username', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(writes.length, before);
    await page.getByRole('button', { name: 'Save username', exact: true }).click();
    await Promise.all([reloaded(), page.getByRole('dialog').getByRole('button', { name: 'Change username', exact: true }).click()]);
    assert.equal(writes.at(-1).path.split('/').at(-1), 'change-seller-username'); assert.equal(writes.at(-1).body.username, 'new.owner');
    assert.equal(writes.at(-1).body.expectedRevision, 5);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});
