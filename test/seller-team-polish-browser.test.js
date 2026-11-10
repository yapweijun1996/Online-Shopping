import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
import { createAccount } from '../src/accounts.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/team-polish-browser';
for (const width of [390, 768, 1280, 1920]) test(`Team Chinese polish and true profile guidance: ${width}px`, { skip: !modulePath, timeout: 30000 }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], writes = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && /\/seller\/(?:accounts|account\/password)/.test(new URL(request.url()).pathname)) writes.push(request.method()); });
  const ready = () => page.waitForFunction(() => document.querySelector('.team-page')?.getAttribute('aria-busy') === 'false');
  const chinese = async () => { await page.locator('.language-trigger').click(); await page.locator('.language-options button[lang="zh-Hans"]').click(); };
  const rows = page.locator('.team-table tbody tr');
  mkdirSync(artifacts, { recursive: true }); const shot = async label => { await page.evaluate(() => new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)); })); return page.screenshot({ path: `${artifacts}/${label}-${width}-zh.png`, fullPage: true, animations: 'disabled' }); };
  await page.goto(`${f.origin}/seller/#team`); await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter'); await ready(); await chinese();
  if (width > 1024) await page.waitForFunction(() => document.querySelector('#main').getBoundingClientRect().left >= document.querySelector('#sidebar').getBoundingClientRect().right - 1);
  assert.equal(await page.locator('#team-add-person').innerText(), '添加成员'); assert.equal(await page.locator('.team-result-count').innerText(), '共 1 位成员');
  assert.equal(await rows.locator('.team-role').innerText(), '店主'); assert.equal(await page.locator('.team-owner-protected').innerText(), '店主账号不可在此修改');
  const guidance = await page.locator('.team-owner-guidance').innerText(); assert.match(guidance, /账户 → 查看资料 → 修改密码/);
  assert.equal(await page.locator('.team-activity').isVisible(), false); assert.equal(await page.locator('#team-clear-filters').isVisible(), false);
  const geometry = await page.evaluate(() => {
    const search = document.querySelector('#team-search').getBoundingClientRect(), role = document.querySelector('#team-filter-role').getBoundingClientRect(), status = document.querySelector('#team-filter-status').getBoundingClientRect();
    return { search: { left: search.left, top: search.top, width: search.width }, role: { left: role.left, top: role.top, width: role.width }, status: { left: status.left, top: status.top, width: status.width }, label: parseFloat(getComputedStyle(document.querySelector('.team-filters label')).fontSize), owner: parseFloat(getComputedStyle(document.querySelector('.team-owner-protected')).fontSize) };
  });
  assert.ok(geometry.label >= 13 && geometry.owner >= 13);
  if (width >= 1280) { assert.ok(geometry.search.width >= 360 && geometry.search.width <= 480); assert.ok(geometry.role.width >= 150 && geometry.role.width <= 170); assert.ok(geometry.status.left - geometry.role.left - geometry.role.width <= 13); }
  if (width === 390) { assert.ok(geometry.role.top > geometry.search.top); assert.equal(geometry.role.top, geometry.status.top); }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('one-owner');
  await page.locator('#team-search').fill('   '); assert.equal(await page.locator('.team-result-count').innerText(), '共 1 位成员'); assert.equal(await page.locator('#team-clear-filters').isVisible(), false);
  await page.locator('#team-search').fill('absent'); assert.equal(await page.locator('.team-result-count').innerText(), '找到 0 位成员，共 1 位'); await page.locator('#team-clear-filters').click();
  // The guidance names the existing intermediary profile screen; open and cancel only.
  await page.locator('#account-button').click(); await page.locator('#profile-button').click(); assert.equal(await page.locator('#profile-role').innerText(), '店主');
  await page.locator('#change-password').click(); await page.locator('.password-dialog').waitFor(); await page.locator('.password-dialog').getByRole('button', { name: '取消', exact: true }).click(); await page.locator('.password-dialog').waitFor({ state: 'detached' }); assert.equal(await page.locator('.password-dialog').count(), 0);
  const longName = 'long.member.' + 'x'.repeat(48);
  await createAccount(f.app.database, { username: longName, role: 'MANAGER', password: 'Fictional-Polish-Pass-2026!' }, f.config.username);
  await createAccount(f.app.database, { username: 'fixture.staff', role: 'STAFF', password: 'Fictional-Polish-Pass-2026!' }, f.config.username);
  await page.reload(); await ready(); assert.equal(await rows.count(), 3); assert.equal(await page.locator('.team-result-count').innerText(), '共 3 位成员');
  await page.locator('#team-filter-role').selectOption('STAFF'); assert.equal(await page.locator('.team-result-count').innerText(), '找到 1 位成员，共 3 位'); assert.equal(await page.locator('.team-owner-guidance').isVisible(), false);
  await page.locator('#team-filter-status').selectOption('inactive'); assert.equal(await rows.count(), 0); await page.locator('#team-clear-filters').click();
  const summary = page.locator('.team-activity > summary'); assert.equal(await summary.innerText(), '成员操作记录'); await summary.focus(); await page.keyboard.press('Enter');
  const response = await f.app.database.get('SELECT COUNT(*) AS n FROM account_event');
  assert.equal(await page.locator('.team-activity-table tbody tr').count(), Math.min(20, Number(response.n)));
  assert.deepEqual(await page.locator('.team-activity-table th').allTextContents(), ['时间', '操作者', '成员', '操作']);
  assert.match(await page.locator('.team-activity-table').innerText(), /已添加/); assert.doesNotMatch(await page.locator('.team-activity-table').innerText(), /CREATED|password_hash|Fictional-Polish/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('members-activity');
  if (width === 1920) { await page.locator('#collapse-nav').click(); await shot('collapsed-nav'); await page.locator('#collapse-nav').click(); }
  // Future/unknown actions use readable copy, never an internal enum or raw detail.
  if (width === 1280) {
    const listing = await f.request('GET', '/api/v1/seller/accounts', null, (await f.login()).headers);
    const payload = { ...listing.data, events: [{ ...listing.data.events[0], action: 'FUTURE_INTERNAL_ENUM', detail: 'private-detail-not-for-render' }] };
    await page.route('**/api/v1/seller/accounts', route => route.fulfill({ json: payload }), { times: 1 }); await page.reload(); await ready(); await page.locator('.team-activity > summary').click();
    assert.match(await page.locator('.team-activity-table tbody').innerText(), /账号已更新/); assert.doesNotMatch(await page.locator('.team-activity-table tbody').innerText(), /FUTURE_INTERNAL_ENUM|private-detail-not-for-render/);
    for (const code of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) { await page.locator('.language-trigger').click(); await page.locator(`.language-options button[lang="${code}"]`).click(); assert.doesNotMatch(await page.locator('.team-page').innerText(), /teamUI_|eventFUTURE/); }
  }
  assert.equal(writes.length, 0, 'polish/profile/activity checks never write accounts or passwords'); assert.deepEqual(errors, []);
});
