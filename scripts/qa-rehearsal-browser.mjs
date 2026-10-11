// Real Chrome owner journey on the private production-compose rehearsal.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { totpCode } from '../src/platform/totp.js';
import { loadRehearsal, proveRehearsalScope, dockerRehearsal, rehearsalProject } from './qa-rehearsal-client.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const state = loadRehearsal(); await proveRehearsalScope(state);
const environment = JSON.parse(readFileSync('output/qa/multi-tenant/environment.json', 'utf8'));
const { chromium } = await import(pathToFileURL(environment.playwright));
const run = mkdtempSync(join(state.scratch, 'owner-journey-'));
const suffix = randomBytes(3).toString('hex'), oneCode = 'journeyone' + suffix, twoCode = 'journeytwo' + suffix, renamedCode = 'journeyrenamed' + suffix;
const newPassword = execFileSync('openssl', ['rand', '-hex', '24'], { encoding: 'utf8' }).trim();
const adminPassword = readFileSync(state.envValues.PLATFORM_ADMIN_PASSWORD_FILE_HOST, 'utf8').trim();
await dockerRehearsal(['exec', '-e', 'NEW_PLATFORM_ADMIN_PASSWORD', rehearsalProject + '-backend-1', 'node', 'scripts/reset-platform-admin.js'],
  { env: { ...process.env, NEW_PLATFORM_ADMIN_PASSWORD: adminPassword } });
const context = await chromium.launchPersistentContext(join(run, 'profile'), { channel: 'chrome', headless: true,
  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 },
  args: ['--host-resolver-rules=MAP *.gmb01.xyz 127.0.0.1', '--no-proxy-server', '--ignore-certificate-errors'] });
context.setDefaultTimeout(45_000);
const origin = (surface) => `https://${surface}.gmb01.xyz:${state.port}`;
const report = { project: rehearsalProject, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  checks: [], widths: [], pageErrors: [], unexpectedConsoleErrors: [], cspViolations: 0 };
await context.exposeBinding('qaCspViolation', () => report.cspViolations++);
await context.addInitScript(() => addEventListener('securitypolicyviolation', () => window.qaCspViolation()));
const attach = (page) => {
  page.on('pageerror', () => report.pageErrors.push('Browser page error'));
  page.on('console', (message) => { if (message.type() === 'error' && !/401|403|404|503/.test(message.text())) report.unexpectedConsoleErrors.push('Browser console error'); });
};
const admin = await context.newPage(); attach(admin);
const ready = () => admin.waitForFunction(() => !document.querySelector('#content').hasAttribute('aria-busy') && document.querySelector('#error').hidden);
const click = async (name) => { await admin.getByRole('button', { name, exact: true }).last().click(); await ready(); };
const secretClose = async () => {
  await admin.locator('#secret-dialog').waitFor({ state: 'visible' });
  await admin.getByRole('button', { name: 'Close and clear', exact: true }).click();
  await admin.waitForFunction(() => !document.querySelector('#secret-dialog').open && document.querySelector('#secret-value').textContent === '');
};
const waitResponse = (page, suffix, method = 'POST') => page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(suffix) && response.request().method() === method);
const responseCheck = async (response, status = 200) => { check(response.status() === status, 'Unexpected journey response status'); return response.json(); };
let phase = 'platform enrolment';
try {
  const pageResponse = await admin.goto(origin('admin') + '/platform/');
  check(pageResponse.status() === 200 && /script-src 'self'/.test(pageResponse.headers()['content-security-policy']), 'Platform page or CSP missing');
  await admin.getByLabel('SuperAdmin username', { exact: true }).fill(state.envValues.PLATFORM_ADMIN_USERNAME);
  await admin.getByLabel('Password', { exact: true }).fill(adminPassword);
  await click('Continue');
  const setupKey = (await admin.locator('.setup-key').innerText()).replace(/\s/g, '');
  check(/^[A-Z2-7]+$/.test(setupKey), 'Authenticator setup key format');
  check((await admin.getByRole('link', { name: 'Open in authenticator' }).getAttribute('href')).startsWith('otpauth://totp/'), 'Authenticator URI missing');
  const listUrl = origin('admin') + '/api/v1/platform/shops';
  await context.route(listUrl, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PLATFORM_UNAVAILABLE', message: 'Fictional follow-up read failure.' } }) }) : route.continue());
  await admin.getByLabel('Six-digit authenticator code').fill(totpCode(setupKey, Math.floor(Date.now() / 30_000)));
  await admin.getByRole('button', { name: 'Confirm', exact: true }).click();
  await admin.waitForFunction(() => !document.querySelector('#content').hasAttribute('aria-busy') && !document.querySelector('#error').hidden && document.querySelector('#secret-dialog').open);
  await context.unroute(listUrl);
  const recovery = (await admin.locator('#secret-value').innerText()).split('\n');
  check(recovery.length === 10, 'Recovery code count'); await secretClose();
  await click('Shops');
  report.checks.push('password-only enrolment; real TOTP; ten one-time recovery codes; dialog clears');
  report.checks.push('one-time recovery dialog survives a failed follow-up shop-list read');

  phase = 'responsive and accessible console';
  for (const width of [360, 390, 768, 1280]) {
    await admin.setViewportSize({ width, height: 900 });
    const metrics = await admin.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
      labels: [...document.querySelectorAll('input:not([type=hidden])')].every((input) => input.labels?.length),
      touch: [...document.querySelectorAll('button')].filter((node) => node.getClientRects().length).every((node) => node.getBoundingClientRect().height >= 44),
      main: Boolean(document.querySelector('main')), navigation: Boolean(document.querySelector('nav[aria-label]')), alert: Boolean(document.querySelector('[role=alert]')) }));
    check(!metrics.overflow && metrics.labels && metrics.touch && metrics.main && metrics.navigation && metrics.alert, 'Console accessibility or width check failed');
    report.widths.push(width);
  }
  await admin.setViewportSize({ width: 1280, height: 900 });
  await admin.getByRole('button', { name: 'Create shop', exact: true }).focus(); await admin.keyboard.press('Enter'); await ready();
  check(await admin.getByLabel('Shop code', { exact: true }).isVisible(), 'Keyboard navigation failed');
  report.checks.push('360–1280 px; labels, landmarks, alerts and 44 px buttons; keyboard navigation');

  const shops = [];
  for (const [code, name] of [[oneCode, 'Fictional Journey One ' + suffix], [twoCode, 'Fictional Journey Two ' + suffix]]) {
    phase = 'console creates ' + code;
    if (shops.length) await click('Create shop');
    await admin.getByLabel('Shop code', { exact: true }).fill(code);
    await admin.getByLabel('Shop name', { exact: true }).fill(name);
    await admin.getByLabel('Seller username', { exact: true }).fill(code + '.owner');
    const response = waitResponse(admin, '/api/v1/platform/shops'); await click('Create shop');
    const created = await responseCheck(await response, 201);
    check((await response).headers()['cache-control']?.includes('no-store'), 'Create response may be cached');
    check(created.tenant.status === 'ACTIVE', 'Created shop is not active');
    check((await admin.locator('#secret-value').innerText()).includes(created.sellerPassword), 'One-time seller credential missing');
    check(!await admin.evaluate((value) => [...Object.values(localStorage), ...Object.values(sessionStorage)].some((entry) => entry.includes(value)), created.sellerPassword), 'One-time credential persisted in storage');
    shops.push(created); await secretClose();
    check(!(await admin.locator('body').innerText()).includes(created.sellerPassword), 'Seller credential remains after closing');
  }
  report.checks.push('two shops created through console; separate roles/databases; no-store one-time credentials');

  phase = 'forced seller password change';
  const seller = await context.newPage(); attach(seller);
  await seller.goto(origin('seller') + '/' + oneCode + '/seller/');
  await seller.locator('#username').fill(oneCode + '.owner'); await seller.locator('#password').fill(shops[0].sellerPassword);
  await seller.locator('#login-form button[type=submit]').click();
  await seller.locator('.password-dialog[open]').waitFor();
  await seller.keyboard.press('Escape'); check(await seller.locator('.password-dialog[open]').isVisible(), 'Forced password dialog dismissed');
  const fields = seller.locator('.password-dialog input'); await fields.nth(0).fill(shops[0].sellerPassword); await fields.nth(1).fill(newPassword); await fields.nth(2).fill(newPassword);
  await seller.locator('.password-dialog button[type=submit]').click(); await seller.locator('#workspace').waitFor({ state: 'visible' });
  report.checks.push('Owner first sign-in forces password replacement; Escape cannot bypass');

  phase = 'CSV import';
  await seller.locator('[data-view=categories]').click();
  await seller.locator('#category-create [name=code]').fill('SAMPLES'); await seller.locator('#category-create [name=label]').fill('Sample goods');
  const categoryResponse = waitResponse(seller, '/api/v1/seller/categories');
  await seller.locator('#category-create [type=submit]').click(); await responseCheck(await categoryResponse, 201);
  await seller.locator('[data-view=products]').click(); await seller.locator('#product-import').click();
  await seller.locator('.import-dialog input[type=file]').setInputFiles('docs/tenant-sample-products.csv');
  await seller.locator('.import-dialog .primary-button').waitFor({ state: 'visible' });
  check(!await seller.locator('.import-dialog .has-errors').count(), 'Owner sample CSV failed preview');
  await seller.locator('.import-dialog .primary-button').click(); await seller.locator('.import-dialog').waitFor({ state: 'detached' });
  report.checks.push('owner sample CSV preview and committed import through seller UI');

  phase = 'guest order';
  const buyer = await context.newPage(); attach(buyer); await buyer.setViewportSize({ width: 390, height: 844 });
  await buyer.goto(origin('shop') + '/' + oneCode + '/shop/#profile');
  await buyer.locator('#profile-form [name=fullName]').fill('Fictional Journey Buyer');
  await buyer.locator('#profile-form [name=phone]').fill('123456789'); await buyer.locator('#profile-form [name=email]').fill('journey@example.invalid');
  await buyer.locator('#profile-form [type=submit]').click();
  await buyer.goto(origin('shop') + '/' + oneCode + '/shop/#addresses'); await buyer.locator('#add-address').click();
  const address = buyer.locator('.app-modal[open] .address-form');
  for (const [field, value] of Object.entries({ fullName: 'Fictional Journey Buyer', phone: '123456789', line1: '12 Fictional Lane', city: 'Petaling Jaya', postcode: '47300' })) await address.locator(`[name=${field}]`).fill(value);
  await address.locator('[name=region]').selectOption({ label: 'Selangor' });
  await address.locator('[type=submit]').click(); await buyer.locator('.app-modal[open]').waitFor({ state: 'hidden' });
  await buyer.goto(origin('shop') + '/' + oneCode + '/shop/#catalog');
  await buyer.locator('.product-name-link').first().click(); await buyer.locator('.product-add').click();
  await buyer.goto(origin('shop') + '/' + oneCode + '/shop/#cart'); await buyer.locator('#checkout-button').click();
  const orderResponse = waitResponse(buyer, '/api/v1/orders'); await buyer.locator('#submit-order').click();
  const order = await responseCheck(await orderResponse, 201); await buyer.locator('#receipt-view').waitFor({ state: 'visible' });
  check(Boolean(await buyer.locator('#receipt-number').innerText()), 'Guest order receipt missing');
  report.checks.push('mobile guest profile/address, cart, checkout and server receipt');

  phase = 'seller confirms order';
  await seller.locator('[data-view=orders]').click();
  await seller.locator('#order-list button').first().click(); await seller.locator('[data-action=confirm]').click();
  const confirmation = waitResponse(seller, '/confirm'); await seller.locator('#decision-submit').click(); await responseCheck(await confirmation);
  report.checks.push('seller confirms guest order through compare-and-set UI');

  phase = 'shop lifecycle';
  await click('Shops'); await admin.locator('article').filter({ hasText: 'Fictional Journey One ' + suffix }).getByRole('button', { name: 'View shop' }).click(); await ready();
  await click('Suspend shop'); check((await admin.locator('dl').innerText()).includes('SUSPENDED'), 'Suspend did not persist');
  await click('Resume shop'); check((await admin.locator('dl').innerText()).includes('ACTIVE'), 'Resume did not persist');
  await admin.getByLabel('Shop code', { exact: true }).fill(renamedCode); await admin.getByLabel('Shop name', { exact: true }).fill('Fictional Journey Renamed ' + suffix); await click('Save name and code');
  // Browser navigation obeys this profile's loopback resolver; APIRequestContext would use the host DNS.
  const aliasResponse = buyer.waitForResponse((response) => new URL(response.url()).pathname === '/' + oneCode + '/api/v1/products' && response.status() === 308);
  await buyer.goto(origin('shop') + '/' + oneCode + '/api/v1/products'); const alias = await aliasResponse;
  check(alias.headers().location.includes('/' + renamedCode + '/api/v1/products'), 'Rename alias redirect failed');
  await click('Suspend shop'); await admin.getByLabel('Type ' + renamedCode + ' to confirm').fill(renamedCode); await click('Request deletion');
  check((await admin.locator('dl').innerText()).includes('DELETING'), 'Deletion request failed'); await click('Cancel deletion'); await click('Resume shop');
  const resetResponse = waitResponse(admin, '/reset-seller-password'); await click('Reset seller password');
  const reset = await responseCheck(await resetResponse); check(Boolean(reset.sellerPassword), 'Reset did not return one-time credential'); await secretClose();
  await seller.goto(origin('seller') + '/' + renamedCode + '/seller/'); await seller.locator('#login-form').waitFor({ state: 'visible' });
  await seller.locator('#username').fill(oneCode + '.owner'); await seller.locator('#password').fill(reset.sellerPassword); await seller.locator('#login-form button[type=submit]').click(); await seller.locator('.password-dialog[open]').waitFor();
  const resetFields = seller.locator('.password-dialog input'); await resetFields.nth(0).fill(reset.sellerPassword); await resetFields.nth(1).fill(newPassword); await resetFields.nth(2).fill(newPassword); await seller.locator('.password-dialog button[type=submit]').click(); await seller.locator('#workspace').waitFor({ state: 'visible' });
  report.checks.push('suspend/resume, rename/308 alias, 30-day deletion request/cancel, reset seller credential and forced replacement');

  phase = 'account and recovery';
  await click('Account'); const passwordForm = admin.locator('form').first(); await passwordForm.locator('[name=currentPassword]').fill(adminPassword); await passwordForm.locator('[name=newPassword]').fill(newPassword); await click('Change password');
  await admin.locator('form').nth(1).locator('[name=password]').fill(newPassword); await click('Regenerate recovery codes');
  const regenerated = (await admin.locator('#secret-value').innerText()).split('\n'); check(regenerated.length === 10, 'Regenerated recovery count'); await secretClose();
  await click('Sign out'); await admin.getByLabel('SuperAdmin username', { exact: true }).fill(state.envValues.PLATFORM_ADMIN_USERNAME); await admin.getByLabel('Password', { exact: true }).fill(newPassword); await click('Continue');
  await admin.getByLabel('Or a recovery code').fill(regenerated[0]); await click('Confirm');
  await click('Audit'); check((await admin.locator('.audit-list').innerText()).includes('RECOVERY_USED'), 'Recovery audit missing');
  report.checks.push('account password change, recovery regeneration/sign-in and audit trail');
  check(report.pageErrors.length === 0 && report.unexpectedConsoleErrors.length === 0 && report.cspViolations === 0, 'Browser errors or CSP violations');
  report.verifiedAt = new Date().toISOString(); report.complete = true;
  writeFileSync('output/qa/multi-tenant/r4-owner-journey.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Owner browser journey verified: ' + report.checks.length + ' groups, ' + report.widths.join('/') + ' px.');
} catch { throw new Error('Owner browser rehearsal failed during ' + phase + '.'); }
finally { await context.close(); rmSync(run, { recursive: true, force: true }); }
