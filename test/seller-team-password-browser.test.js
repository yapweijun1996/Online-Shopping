import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/team-password-browser';
for (const width of [390, 768, 1280, 1920]) test(`Team secure password and real saved email handoff: ${width}px`, { skip: !modulePath, timeout: 60000 }, async t => {
  const { chromium } = await import(modulePath); const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close()); await f.app.database.run("UPDATE shop_setup SET mode = 'production', shop_name = 'Fictional Team Store' WHERE id = 1");
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
  const drawer = page.locator('.app-modal-team-drawer'), password = drawer.locator('[name=password]'), panel = drawer.locator('.team-handoff'), email = drawer.locator('.team-email-text');
  const ready = () => page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'false');
  const signature = () => page.evaluate(async () => (await import('/shared/update-guard.js')).draftSignature());
  const generate = () => drawer.locator('.team-password-tools button').click();
  const done = async () => { await drawer.locator('#team-handoff-done').click(); await drawer.waitFor({ state: 'detached' }); };
  const clipboard = async denied => page.evaluate(deny => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { if (deny) throw new Error('denied'); window.__testClipboard = value; } } }); }, denied);
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollX === 0), 'drawer/focus/copy never shifts or overflows the shell');
  mkdirSync(artifacts, { recursive: true });
  const shot = async label => { await page.evaluate(() => new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)); })); await page.screenshot({ path: `${artifacts}/${label}-${width}.png`, fullPage: true, animations: 'disabled' }); };
  await page.goto(`${f.origin}/seller/#team`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter'); await ready(); await page.locator('#shop-context').filter({ hasText: 'Fictional Team Store' }).waitFor();
  await page.locator('#team-add-person').click(); await drawer.locator('[name=username]').fill(`member.${width}`);
  const firstSignature = await signature(); await generate(); const generated = await password.inputValue(); assert.ok(generated.length === 24); assert.ok(await signature() !== firstSignature); assert.ok(!(await signature()).includes(generated));
  await noOverflow(); await drawer.getByRole('button', { name: 'Show password', exact: true }).click(); assert.ok(!(await signature()).includes(generated)); await noOverflow(); await drawer.getByRole('button', { name: 'Hide password', exact: true }).click();
  // RNG failure preserves a good manual/generated input; it cannot silently downgrade to a weak source.
  await page.evaluate(() => { window.__realRandom = crypto.getRandomValues; crypto.getRandomValues = () => { throw new Error('synthetic unavailable'); }; }); await generate(); assert.ok(await password.inputValue() === generated); await drawer.locator('.team-copy-status').filter({ hasText: 'unavailable' }).waitFor(); await page.evaluate(() => { crypto.getRandomValues = window.__realRandom; delete window.__realRandom; });
  await clipboard(true); await drawer.getByRole('button', { name: 'Copy password', exact: true }).click(); const manual = drawer.locator('.team-manual-copy'); await manual.waitFor(); assert.ok(await manual.inputValue() === generated); assert.ok(await manual.evaluate(el => document.activeElement === el && el.selectionEnd === el.value.length && el.selectionStart === 0)); assert.ok(!(await signature()).includes(generated));
  await clipboard(false); await drawer.getByRole('button', { name: 'Copy password', exact: true }).click(); await drawer.locator('.team-copy-status').filter({ hasText: 'Save the account change' }).waitFor(); assert.equal(await panel.count(), 0, 'copy before save cannot claim creation');
  await shot('password-controls-masked');
  const savedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/seller/accounts');
  await drawer.locator('button[type=submit]').click(); const actual = await savedResponse; assert.equal(actual.status(), 201); const saved = await actual.json(); await panel.waitFor(); await ready();
  assert.equal(await drawer.locator('.team-editor').count(), 0, 'successful handoff cannot submit or generate twice');
  const content = await email.inputValue(); assert.ok(content.includes(saved.username) && content.includes(generated) && content.includes('Fictional Team Store') && content.includes(`${f.origin}/seller/`) && content.includes('first sign-in'));
  assert.ok(!(await signature()).includes(generated)); assert.ok(await email.getAttribute('data-private-draft') === 'true');
  await noOverflow(); await shot('saved-handoff-collapsed');
  await clipboard(true); await drawer.locator('#team-copy-saved-password').click(); assert.ok(await manual.inputValue() === generated); assert.ok(await manual.evaluate(el => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length));
  await clipboard(false); await drawer.locator('#team-copy-saved-password').click(); assert.ok(await page.evaluate(() => window.__testClipboard) === generated); assert.equal(await manual.isVisible(), false); assert.equal(await drawer.locator('.team-copy-status').innerText(), 'Password copied.');
  await clipboard(true); await drawer.locator('#team-copy-email').click(); await drawer.locator('.team-copy-status').filter({ hasText: 'Could not copy' }).waitFor(); assert.ok(await email.evaluate(el => document.activeElement === el && el.selectionEnd === el.value.length && el.selectionStart === 0));
  await clipboard(false); await drawer.locator('#team-copy-email').click(); await drawer.locator('.team-copy-status').filter({ hasText: 'Email text copied' }).waitFor(); assert.ok(await page.evaluate(() => window.__testClipboard) === content);
  const accountRow = await f.app.database.get('SELECT password_hash, must_change_password FROM seller_account WHERE id = ?', saved.id); assert.ok(!accountRow.password_hash.includes(generated)); assert.equal(Number(accountRow.must_change_password), 1);
  assert.ok(!(JSON.stringify(await f.app.database.all('SELECT action, detail FROM account_event'))).includes(generated));
  await done(); assert.ok(await page.evaluate(secret => !document.body.innerText.includes(secret) && !location.href.includes(secret) && !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), generated));
  const staff = await f.login(saved.username, generated); assert.equal(staff.session.mustChangePassword, true); assert.equal((await f.request('GET', '/api/v1/seller/orders', null, staff.headers)).response.status, 403);
  assert.equal((await f.request('POST', '/api/v1/seller/account/password', { currentPassword: generated, newPassword: 'Own-Fictional-Password-2026!' }, staff.headers)).response.status, 200); assert.equal((await f.request('GET', '/api/v1/seller/orders', null, staff.headers)).response.status, 200);
  // Reset uses the same real saved response and one-time handoff; copying is not an email send.
  const memberRow = page.locator('.team-table tbody tr').filter({ hasText: saved.username }); await memberRow.locator('.team-more summary').click(); await memberRow.locator('[data-team-action=reset]').click(); await generate(); const resetPassword = await password.inputValue();
  await drawer.locator('button[type=submit]').click(); await panel.waitFor(); await ready(); assert.ok((await email.inputValue()).includes(resetPassword)); await done();
  const resetSession = await f.login(saved.username, resetPassword); assert.equal(resetSession.session.mustChangePassword, true);
  if (width === 1280) {
    await f.app.database.run("UPDATE shop_setup SET shop_name = 'Renamed Team Store' WHERE id = 1"); await page.goto(`${f.origin}/seller/#dashboard`); await page.locator('#shop-context').filter({ hasText: 'Renamed Team Store' }).waitFor(); await page.goto(`${f.origin}/seller/#team`); await ready();
    const owner = await f.login(); await f.request('PATCH', `/api/v1/seller/accounts/${saved.id}`, { active: false }, owner.headers);
    for (const code of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) {
      await page.locator('.language-trigger').click(); await page.locator(`.language-options button[lang="${code}"]`).click(); await memberRow.locator('.team-more summary').click(); await memberRow.locator('[data-team-action=reset]').click(); await generate();
      await drawer.locator('button[type=submit]').click(); await panel.waitFor(); const rendered = await email.inputValue(); assert.ok(rendered.includes('Renamed Team Store'), 'handoff uses refreshed actual header name, not stale bootstrap'); assert.ok(!/teamPW_|\{password\}/.test(rendered));
      const inactiveNote = await page.evaluate(async () => (await import('/shared/i18n.js')).t('teamPW_inactiveNote')); assert.ok(rendered.includes(inactiveNote)); await done();
    }
  }
  assert.deepEqual(errors, []);
});

test('Team credential failures, copy fences, held refresh and disposal clear one-time state', { skip: !modulePath, timeout: 60000 }, async t => {
  const { chromium } = await import(modulePath); const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close()); const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); const page = await context.newPage(); page.setDefaultTimeout(8000);
  const drawer = page.locator('.app-modal-team-drawer'), password = drawer.locator('[name=password]'), panel = drawer.locator('.team-handoff');
  const ready = () => page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'false');
  const open = async username => { await page.locator('#team-add-person').click(); await drawer.locator('[name=username]').fill(username); await password.fill('Fictional-Transfer-2026!'); };
  const submit = () => drawer.locator('button[type=submit]').click();
  await page.goto(`${f.origin}/seller/#team`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter'); await ready();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: value => new Promise(resolve => { window.__releaseClipboard = resolve; }) } }));
  await open('copy.fixture'); await drawer.getByRole('button', { name: 'Copy password', exact: true }).click();
  // Simulated autofill/input while copying changes the revision; old success must not label the new password copied.
  await page.evaluate(() => { const field = document.querySelector('#team-person-password'); field.value = 'Changed-Fictional-Transfer-2026!'; field.dispatchEvent(new Event('input', { bubbles: true })); window.__releaseClipboard(); });
  await page.waitForFunction(() => !document.querySelector('.team-copy-password').disabled); assert.ok(!(await drawer.locator('.team-copy-status').innerText()).includes('copied'));
  await drawer.getByRole('button', { name: 'Copy password', exact: true }).click();
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.locator('.app-modal-confirm').getByRole('button', { name: 'Cancel edit', exact: true }).click(); await drawer.waitFor({ state: 'detached' });
  await open('replacement.fixture'); await page.evaluate(() => window.__releaseClipboard()); assert.equal(await drawer.locator('.team-copy-status').innerText(), '', 'late clipboard response cannot restore a closed draft');
  const owner = await f.login(); const existing = await f.request('POST', '/api/v1/seller/accounts', { username: 'existing.fixture', role: 'STAFF', password: 'Existing-Fictional-2026!' }, owner.headers); assert.equal(existing.response.status, 201);
  await drawer.locator('[name=username]').fill('existing.fixture'); await submit(); await drawer.locator('[role=alert]').filter({ hasText: 'already used' }).waitFor(); assert.equal(await panel.count(), 0);
  await drawer.locator('[name=username]').fill('saved.fixture');
  const failWrite = async route => { if (route.request().method() === 'POST') await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }); else await route.continue(); };
  await page.route('**/api/v1/seller/accounts', failWrite); await submit(); await drawer.locator('[role=alert]').filter({ hasText: 'Could not save' }).waitFor(); assert.equal(await panel.count(), 0); assert.ok(await password.inputValue() === 'Fictional-Transfer-2026!'); await page.unroute('**/api/v1/seller/accounts', failWrite);
  let releaseRead; const readGate = new Promise(resolve => { releaseRead = resolve; });
  const holdRead = async route => { if (route.request().method() === 'GET') await readGate; await route.continue(); }; await page.route('**/api/v1/seller/accounts', holdRead);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/seller/accounts'); await submit(); assert.equal((await saved).status(), 201); await panel.waitFor(); assert.equal(await drawer.locator('#team-handoff-done').isEnabled(), true, 'handoff does not hold busy awaiting Done or list refresh');
  await page.evaluate(() => { window.__detachedEmail = document.querySelector('.team-email-text'); }); await drawer.locator('#team-handoff-done').click(); await drawer.waitFor({ state: 'detached' }); assert.ok(await page.evaluate(() => window.__detachedEmail.value === ''));
  // A prior held refresh completing must not unlock a later pending write.
  await open('second.fixture'); let releaseWrite; const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const holdWrite = async route => { if (route.request().method() === 'POST') await writeGate; await route.fallback(); }; await page.route('**/api/v1/seller/accounts', holdWrite);
  await submit(); await page.waitForFunction(() => document.querySelector('.team-editor')?.getAttribute('aria-busy') === 'true'); releaseRead(); await ready(); assert.equal(await password.isDisabled(), true); releaseWrite(); await panel.waitFor(); await ready();
  await page.unroute('**/api/v1/seller/accounts', holdWrite); await page.unroute('**/api/v1/seller/accounts', holdRead);
  await page.evaluate(() => { window.__detachedEmail = document.querySelector('.team-email-text'); }); await page.goto(`${f.origin}/seller/#products`); await page.locator('#product-list-view').waitFor(); assert.equal(await drawer.count(), 0); assert.ok(await page.evaluate(() => window.__detachedEmail.value === ''));
  await page.goto(`${f.origin}/seller/#team`); await ready(); await open('refresh.fixture');
  const failRead = async route => { if (route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }); else await route.continue(); }; await page.route('**/api/v1/seller/accounts', failRead);
  await submit(); await panel.waitFor(); await page.locator('#team-retry').waitFor(); assert.ok((await page.locator('#team-feedback').innerText()).includes('added')); assert.equal(await drawer.locator('.team-editor-error').count(), 0, 'successful save is not mislabeled as failed on refresh error');
  await drawer.locator('#team-handoff-done').click(); await drawer.waitFor({ state: 'detached' }); await page.unroute('**/api/v1/seller/accounts', failRead); await page.locator('#team-retry').click(); await ready();
  await open('logout.fixture'); await submit(); await panel.waitFor(); await ready(); await page.evaluate(() => { window.__detachedEmail = document.querySelector('.team-email-text'); });
  // Exercise the existing session-ending handler while a native modal owns focus.
  await page.evaluate(() => document.querySelector('#sign-out-button').click()); await page.locator('#login-form').waitFor(); assert.equal(await drawer.count(), 0); assert.ok(await page.evaluate(() => window.__detachedEmail.value === ''));
  assert.ok(await page.evaluate(() => !document.body.innerText.includes('Fictional-Transfer-2026!') && !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('Fictional-Transfer-2026!')));
});
