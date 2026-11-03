import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('Account: grouped security page, checked password change, confirmed recovery regeneration, two columns on wide screens, no overflow on phones', { skip: !browserModule }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try { const data = await readFile(file); response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); response.end(data); } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const origin = `http://127.0.0.1:${server.address().port}`, writes = [];
  await page.route('**/api/v1/platform/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') {
      writes.push({ path: url.pathname.split('/').slice(-2).join('/'), body: request.postDataJSON() });
      return route.fulfill({ json: url.pathname.endsWith('/recovery-codes') ? { recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] } : { changed: true } });
    }
    await route.fulfill({ json: url.pathname.endsWith('/session') ? { stage: 'FULL', csrfToken: 'synthetic-csrf', username: 'admin' } : url.pathname.endsWith('/shops') ? { items: [] } : {} });
  });
  await page.goto(`${origin}/platform/index.html`);
  await page.locator('#navigation').getByRole('button', { name: 'Account', exact: true }).click();

  // Structure: one Security group, both cards, the real password rules, who is signed in.
  await page.getByRole('heading', { name: 'Security', exact: true }).waitFor();
  assert.deepEqual(await page.locator('.account-main .edit-card h3').allInnerTexts(), ['Change password', 'Recovery codes']);
  assert.match(await page.locator('.requirements').innerText(), /12 to 256 characters[\s\S]*username[\s\S]*repeated[\s\S]*Different from the current/);
  assert.equal(await page.locator('.account-side .account-name').innerText(), 'admin');
  assert.equal(await page.getByLabel('Confirm new password').count(), 1);
  // Wide screen: content column capped, details in a second column beside it.
  const main = await page.locator('.account-main').boundingBox(), side = await page.locator('.account-side').boundingBox();
  assert.ok(side.x > main.x + main.width - 1 && Math.abs(side.y - main.y) < 40, 'details sit beside the main column');
  assert.ok((await page.locator('.account-layout').boundingBox()).width <= 1121);
  // Password eye buttons are real touch targets with a larger icon.
  const eye = await page.locator('.password-toggle').first().boundingBox(); assert.ok(eye.width >= 44 && eye.height >= 44);
  assert.equal(await page.locator('.password-toggle svg').first().evaluate(node => Math.round(node.getBoundingClientRect().width)), 22);

  // Password change: client checks come first and send nothing; the confirm field is never sent to the server.
  const fill = async (current, next, confirm) => { await page.getByLabel('Current password').first().fill(current); await page.getByLabel('New password', { exact: true }).fill(next); await page.getByLabel('Confirm new password').fill(confirm); await page.getByRole('button', { name: 'Change password', exact: true }).click(); };
  const problem = page.locator('.account-main .form-error:not([hidden])').first();
  for (const [current, next, confirm, expected] of [['old-password-123', 'short', 'short', /12 to 256/], ['old-password-123', 'my-admin-secret-1', 'my-admin-secret-1', /username/], ['old-password-123', 'aaaaaaaaaaaaaa', 'aaaaaaaaaaaaaa', /repetitive/], ['old-password-123', 'old-password-123', 'old-password-123', /different/], ['old-password-123', 'a-fresh-password-9', 'a-fresh-password-8', /do not match/]]) {
    await fill(current, next, confirm); await problem.waitFor(); assert.match(await problem.innerText(), expected);
    assert.equal(await page.getByLabel('New password', { exact: true }).inputValue(), next, 'what was typed is kept');
  }
  assert.equal(writes.length, 0, 'nothing is sent while the input is invalid');
  await fill('old-password-123', 'a-fresh-password-9', 'a-fresh-password-9');
  await page.getByText('Every other session was signed out.').waitFor();
  assert.deepEqual(writes.at(-1), { path: 'account/password', body: { currentPassword: 'old-password-123', newPassword: 'a-fresh-password-9' } });

  // Recovery codes: a confirmation names the consequence; Cancel sends nothing; Confirm sends and shows the one-time codes.
  await page.getByLabel('Current password').last().fill('a-fresh-password-9');
  await page.getByRole('button', { name: 'Regenerate recovery codes', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  assert.match(await dialog.innerText(), /Every previous recovery code stops working immediately/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(writes.filter(write => write.path === 'account/recovery-codes').length, 0);
  await page.getByRole('button', { name: 'Regenerate recovery codes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Regenerate codes', exact: true }).click();
  await page.locator('[data-secret]').first().waitFor();
  assert.deepEqual(writes.at(-1), { path: 'account/recovery-codes', body: { password: 'a-fresh-password-9' } });
  assert.match(await page.locator('#content').innerText(), /AAAAA-BBBBB/);

  // Phones: no horizontal overflow at 320, 390 and 430 px.
  for (const width of [320, 390, 430]) {
    await page.goto(`${origin}/platform/index.html`);
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole('button', { name: 'Open navigation' }).click(); await page.locator('#navigation').getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('heading', { name: 'Security', exact: true }).waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#main')).marginLeft === '0px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal scroll at ${width}px`);
    const columns = await page.evaluate(() => [document.querySelector('.account-main').getBoundingClientRect().top < document.querySelector('.account-side').getBoundingClientRect().top]);
    assert.deepEqual(columns, [true], 'one column on a phone, security first');
  }
});
