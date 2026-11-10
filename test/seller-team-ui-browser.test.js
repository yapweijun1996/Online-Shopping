import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
import { createAccount } from '../src/accounts.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/team-layout-browser';
for (const width of [390, 768, 1280, 1920]) for (const colorScheme of ['light', 'dark']) test(`Team list and drawer: ${width}px OS ${colorScheme} preference`, { skip: !modulePath, timeout: 90000 }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
  const drawer = page.locator('.app-modal-team-drawer'); const rows = page.locator('.team-table tbody tr');
  const ready = () => page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'false');
  const shot = label => page.screenshot({ path: `${artifacts}/${label}-${width}-${colorScheme}.png`, fullPage: true, animations: 'disabled' });
  const openAdd = async () => { await page.locator('#team-add-person').click(); await drawer.waitFor(); };
  const fillAdd = async username => { await drawer.locator('[name=username]').fill(username); await drawer.locator('[name=password]').fill('Fictional-Temp-2026!'); };
  const submit = () => drawer.locator('button[type=submit]').click();
  const openAction = async (username, action) => { const row = rows.filter({ has: page.locator('strong', { hasText: username }) }); await row.locator('summary').click(); await row.locator(`[data-team-action=${action}]`).click(); };
  const confirm = async label => page.locator('.app-modal-confirm').getByRole('button', { name: label, exact: true }).click();
  mkdirSync(artifacts, { recursive: true });
  await page.goto(`${f.origin}/seller/#team`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter'); await ready();
  assert.equal(await rows.count(), 1); assert.equal(await rows.locator('.team-more').count(), 0); assert.match(await rows.innerText(), /Protected Owner account/);
  assert.equal(await page.locator('.team-add').count(), 0, 'no permanent create form');
  if (width > 1024) await page.waitForFunction(() => document.querySelector('#main').getBoundingClientRect().left >= document.querySelector('#sidebar').getBoundingClientRect().right - 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot('one-owner');
  await page.locator('#team-search').fill('no-match'); assert.equal(await rows.count(), 0); assert.match(await page.locator('.team-empty').innerText(), /No members match/); await page.locator('#team-clear-filters').click();
  await openAdd(); assert.equal(await drawer.locator('select option[value=OWNER]').count(), 0); assert.equal(await drawer.locator('[name=username]').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' }); assert.equal(await page.locator('#team-add-person').evaluate(el => el === document.activeElement), true);
  await openAdd(); await fillAdd('fixture.staff');
  const signatureBefore = await page.evaluate(async () => (await import('/shared/update-guard.js')).draftSignature());
  assert.equal(signatureBefore.includes('Fictional-Temp-2026!'), false);
  await drawer.getByRole('button', { name: 'Show password', exact: true }).click(); assert.equal(await drawer.locator('[name=password]').getAttribute('type'), 'text');
  assert.equal((await page.evaluate(async () => (await import('/shared/update-guard.js')).draftSignature())).includes('Fictional-Temp-2026!'), false);
  await drawer.getByRole('button', { name: 'Hide password', exact: true }).click();
  await drawer.locator('[name=password]').fill('short'); assert.notEqual(await page.evaluate(async () => (await import('/shared/update-guard.js')).draftSignature()), signatureBefore); await submit(); assert.match(await drawer.locator('[role=alert]').innerText(), /12–256/); assert.equal(await drawer.locator('[name=password]').getAttribute('aria-invalid'), 'true');
  await drawer.locator('[name=password]').fill('Fictional-Temp-2026!'); await shot('add-drawer'); await submit(); await drawer.waitFor({ state: 'detached' }); await ready(); assert.equal(await rows.count(), 2);
  assert.match(await page.locator('#team-feedback').innerText(), /fixture.staff added/); assert.match(await rows.filter({ hasText: 'fixture.staff' }).innerText(), /Never signed in/);
  const longName = 'long.member.' + 'x'.repeat(48);
  await createAccount(f.app.database, { username: longName, role: 'MANAGER', password: 'Fictional-Temp-2026!' }, f.config.username);
  await page.reload(); await ready(); assert.equal(await rows.count(), 3); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('many-members');
  await page.locator('#team-filter-role').selectOption('MANAGER'); assert.equal(await rows.count(), 1); await page.locator('#team-filter-status').selectOption('inactive'); assert.equal(await rows.count(), 0); await page.locator('#team-clear-filters').click();
  // Shared draft guard and focus trapping are real browser behavior, not injected form state.
  await openAdd(); await drawer.locator('[name=username]').fill('draft.user'); await page.keyboard.press('Escape');
  await confirm('Cancel'); assert.equal(await drawer.isVisible(), true); assert.equal(await drawer.locator('[name=username]').inputValue(), 'draft.user');
  await drawer.locator('button[type=submit]').focus(); await page.keyboard.press('Tab'); assert.equal(await drawer.locator('.modal-close').evaluate(el => el === document.activeElement), true);
  await drawer.locator('.modal-close').click(); await confirm('Cancel edit'); await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.app-modal-team-drawer').count(), 0, 'closed drawers are removed, no duplicate forms');
  if (width === 1280 && colorScheme === 'light') {
    // Failure preserves the entered draft, and duplicate usernames remain server-owned errors.
    await openAdd(); await fillAdd('fixture.staff'); await submit(); await drawer.locator('[role=alert]').filter({ hasText: 'already used' }).waitFor(); assert.equal(await drawer.locator('[name=username]').inputValue(), 'fixture.staff');
    await drawer.locator('[name=username]').fill('fixture.extra'); await page.route('**/api/v1/seller/accounts', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }) : route.continue(), { times: 1 });
    await submit(); await drawer.locator('[role=alert]').filter({ hasText: 'Could not save' }).waitFor(); assert.equal(await drawer.locator('[name=username]').inputValue(), 'fixture.extra');
    // Pending form is disabled and one submit yields one write.
    let release, writes = 0; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/v1/seller/accounts', async route => { if (route.request().method() === 'POST') { writes++; await held; } await route.continue(); }, { times: 1 });
    await submit(); await page.waitForFunction(() => document.querySelector('.team-editor')?.getAttribute('aria-busy') === 'true'); assert.equal(await drawer.locator('[name=username]').isDisabled(), true); assert.equal(await drawer.locator('.modal-close').isDisabled(), true); release(); await drawer.waitFor({ state: 'detached' }); await ready(); assert.equal(writes, 1);
    await openAction('fixture.staff', 'role'); assert.equal(await drawer.locator('[name=role]').evaluate(el => el === document.activeElement), true); assert.match(await drawer.locator('.team-impact').innerText(), /not all ended/); await drawer.locator('[name=role]').selectOption('MANAGER'); await submit(); await drawer.waitFor({ state: 'detached' }); await ready(); assert.match(await rows.filter({ hasText: 'fixture.staff' }).innerText(), /Manager/);
    await openAction('fixture.staff', 'reset'); assert.match(await drawer.locator('.team-impact').innerText(), /sessions/); await drawer.locator('[name=password]').fill('New-Fictional-Pass-2026!'); await submit(); await drawer.waitFor({ state: 'detached' }); await ready(); assert.match(await page.locator('#team-feedback').innerText(), /Temporary password set/);
    await openAction('fixture.staff', 'active'); assert.match(await page.locator('.app-modal-confirm').innerText(), /sessions end/); await confirm('Cancel'); assert.match(await rows.filter({ hasText: 'fixture.staff' }).innerText(), /Active/);
    await openAction('fixture.staff', 'active'); await confirm('Deactivate'); await ready(); await page.waitForFunction(() => document.querySelector('#team-feedback')?.textContent.includes('updated'));
    await page.locator('#team-filter-status').selectOption('inactive'); assert.equal(await rows.count(), 1);
    await openAction('fixture.staff', 'active'); assert.match(await page.locator('.app-modal-confirm').innerText(), /will not be restored/); await confirm('Activate'); await page.waitForFunction(() => document.querySelector('#team-feedback')?.textContent.includes('filters hide')); await ready(); assert.equal(await rows.count(), 0);
    await openAdd(); await fillAdd('filtered.new'); await submit(); await drawer.waitFor({ state: 'detached' }); await ready(); assert.match(await page.locator('#team-feedback').innerText(), /filters hide/);
    await page.locator('#team-clear-filters').click(); const before = await rows.count();
    // Successful save plus failed read retains old rows and separately labels them stale.
    await openAction('fixture.staff', 'role'); await drawer.locator('[name=role]').selectOption('STAFF');
    await page.route('**/api/v1/seller/accounts', route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }), { times: 1 });
    await submit(); await drawer.waitFor({ state: 'detached' }); await page.locator('#team-retry').waitFor(); assert.equal(await rows.count(), before); assert.match(await page.locator('.team-recovery').innerText(), /out of date/); assert.match(await page.locator('#team-feedback').innerText(), /updated/);
    await page.locator('#team-retry').click(); await ready(); assert.match(await rows.filter({ hasText: 'fixture.staff' }).innerText(), /Staff/);
    // Actual URL navigation disposes pending Team-owned confirmations without leaving a top layer.
    await openAction('fixture.staff', 'active'); await page.locator('.app-modal-confirm').waitFor(); await page.goto(`${f.origin}/seller/#products`); await page.locator('#product-list-view').waitFor(); assert.equal(await page.locator('.app-modal-confirm').count(), 0);
    await page.goto(`${f.origin}/seller/#team`); await ready(); await openAdd(); await drawer.locator('[name=username]').fill('route.draft'); await page.keyboard.press('Escape'); await page.locator('.app-modal-confirm').waitFor();
    page.once('dialog', dialog => dialog.accept()); await page.goto(`${f.origin}/seller/#products`); await page.locator('#product-list-view').waitFor(); assert.equal(await page.locator('.app-modal-confirm, .app-modal-team-drawer').count(), 0);
    await page.goto(`${f.origin}/seller/#team`); await ready();
    for (const code of ['ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko', 'en']) {
      await page.locator('.language-trigger').click(); await page.locator(`.language-options button[lang="${code}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.lang), code); assert.doesNotMatch(await page.locator('.team-page').innerText(), /teamUI_/);
      await openAdd(); assert.doesNotMatch(await drawer.innerText(), /teamUI_/); if (code === 'zh-Hans') await shot('localized-drawer'); await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
    }
    await page.locator('#collapse-nav').click(); await page.locator('.nav-item[data-view=team]').focus(); await page.locator('.sidebar-tooltip').waitFor(); assert.match(await page.locator('.sidebar-tooltip').innerText(), /Team/);
    await page.locator('#collapse-nav').focus(); assert.match(await page.locator('.sidebar-tooltip').innerText(), /Expand/); await page.locator('#collapse-nav').click();


  }
  assert.deepEqual(errors, []);
});

test('Team initial loading/error, session disposal, and abortable shared confirmations', { skip: !modulePath, timeout: 30000 }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/seller/accounts', async route => { await held; await route.continue(); }, { times: 1 });
  await page.goto(`${f.origin}/seller/#team`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter');
  await page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('.team-empty').isVisible(), false); assert.equal(await page.locator('.team-activity').isVisible(), false); assert.equal(await page.locator('#team-clear-filters').isVisible(), false); assert.equal(await page.locator('#team-add-person').isDisabled(), true);
  release(); await page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'false');
  await page.route('**/api/v1/seller/accounts', route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }), { times: 1 }); await page.reload(); await page.locator('#team-retry').waitFor();
  assert.equal(await page.locator('.team-empty').isVisible(), false); assert.equal(await page.locator('.team-activity').isVisible(), false); await page.locator('#team-retry').click(); await page.locator('.team-table tbody tr').waitFor();
  const cancelled = await page.evaluate(async () => { const { confirmModal } = await import('/shared/modal.js'); const controller = new AbortController(); const waiting = confirmModal('Fictional owned confirmation', { signal: controller.signal }); controller.abort(); return waiting; });
  assert.equal(cancelled, false); assert.equal(await page.locator('.app-modal-confirm').count(), 0);
  await page.locator('#team-add-person').click(); const drawer = page.locator('.app-modal-team-drawer'); await drawer.locator('[name=username]').fill('session.fixture'); await drawer.locator('[name=password]').fill('Fictional-Temp-2026!');
  await page.route('**/api/v1/seller/accounts', route => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } }), { times: 1 }); await drawer.locator('button[type=submit]').click(); await page.locator('#login-form').waitFor();
  assert.equal(await page.locator('.app-modal-team-drawer, .app-modal-confirm').count(), 0, 'session failure cannot leave a credential drawer over login');
});
