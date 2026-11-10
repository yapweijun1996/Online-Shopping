import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sellerFixture } from './helpers/seller-app.js';
import { createAccount } from '../src/accounts.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const artifacts = process.env.QA_ARTIFACT_DIR || '/tmp/team-polish-browser';
for (const width of [390, 768, 1050, 1051, 1100, 1280, 1920]) test(`Team Chinese polish and true profile guidance: ${width}px`, { skip: !modulePath, timeout: 30000 }, async t => {
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
  assert.equal(await page.locator('.team-owner-guidance').isVisible(), false, 'owner help is local and collapsed');
  const ownerHelp = page.locator('.team-owner-help > summary'); await ownerHelp.focus(); await page.keyboard.press('Enter');
  const guidance = await page.locator('.team-owner-guidance').innerText(); assert.match(guidance, /账户 → 查看资料 → 修改密码/);
  assert.equal(await page.locator('.team-owner-guidance').isVisible(), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('.team-owner-guidance').isVisible(), false);
  assert.equal(await page.locator('.team-activity').isVisible(), true); assert.match(await page.locator('.team-activity-count').innerText(), /最近 0 条记录/);
  await page.locator('.team-activity > summary').click(); assert.equal(await page.locator('.team-activity-empty').innerText(), '暂无成员操作记录。'); await page.locator('.team-activity > summary').click(); assert.equal(await page.locator('#team-clear-filters').isVisible(), false);
  const geometry = await page.evaluate(() => {
    const search = document.querySelector('#team-search').getBoundingClientRect(), role = document.querySelector('#team-filter-role').getBoundingClientRect(), status = document.querySelector('#team-filter-status').getBoundingClientRect();
    return { search: { left: search.left, top: search.top, width: search.width }, role: { left: role.left, top: role.top, width: role.width }, status: { left: status.left, top: status.top, width: status.width }, label: parseFloat(getComputedStyle(document.querySelector('.team-filters label')).fontSize), owner: parseFloat(getComputedStyle(document.querySelector('.team-owner-protected')).fontSize) };
  });
  assert.ok(geometry.label >= 13 && geometry.owner >= 13);
  if (width >= 1280) { assert.ok(geometry.search.width >= 360 && geometry.search.width <= 480); assert.ok(geometry.role.width >= 150 && geometry.role.width <= 170); assert.ok(geometry.status.left - geometry.role.left - geometry.role.width <= 13); }
  if (width === 1050 || width === 1051 || width === 1100) assert.equal(geometry.role.top, geometry.status.top, 'compact filters do not strand Status on a second row');
  if (width === 390) { assert.ok(geometry.role.top > geometry.search.top); assert.equal(geometry.role.top, geometry.status.top); }
  const fluidGeometry = await page.evaluate(() => {
    const rect = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, centerY: (box.top + box.bottom) / 2 }; };
    const main = document.querySelector('#main'), styles = getComputedStyle(main);
    return { main: rect('#main'), leftGutter: parseFloat(styles.paddingLeft), rightGutter: parseFloat(styles.paddingRight), page: rect('.team-page'), title: rect('#page-title'), heading: rect('.page-heading'), filters: rect('.team-filters'), table: rect('.team-list-container'), result: rect('.team-result-count'), activity: rect('.team-activity'), action: rect('#team-add-person'), actionPosition: getComputedStyle(document.querySelector('#team-add-person')).position };
  });
  const left = fluidGeometry.main.left + fluidGeometry.leftGutter, right = fluidGeometry.main.right - fluidGeometry.rightGutter;
  for (const key of ['page', 'title', 'heading', 'filters', 'table', 'result', 'activity']) assert.ok(Math.abs(fluidGeometry[key].left - left) < 2, `${key} uses the main gutter, with no second auto margin`);
  assert.ok(Math.abs(fluidGeometry.page.right - right) < 2); assert.ok(Math.abs(fluidGeometry.heading.right - right) < 2);
  assert.equal(fluidGeometry.actionPosition, 'static'); assert.ok(Math.abs(fluidGeometry.action.centerY - fluidGeometry.title.centerY) < 2, 'title and Add align in normal flow');
  if (width === 1920) { assert.ok(fluidGeometry.page.width > 1500, 'regression: old main left484/width1200 is replaced by fluid main content'); assert.equal(fluidGeometry.leftGutter, 44); }
  assert.ok(await page.locator('#team-search').getAttribute('placeholder'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('one-owner');
  await page.locator('#team-search').fill('   '); assert.equal(await page.locator('.team-result-count').innerText(), '共 1 位成员'); assert.equal(await page.locator('#team-clear-filters').isVisible(), false);
  await page.locator('#team-search').fill('absent'); assert.equal(await page.locator('.team-result-count').innerText(), '找到 0 位成员，共 1 位'); await page.locator('#team-clear-filters').click();
  // The guidance names the existing intermediary profile screen; open and cancel only.
  await page.locator('#account-button').click(); await page.locator('#profile-button').click(); assert.equal(await page.locator('#profile-role').innerText(), '店主');
  await page.locator('#change-password').click(); await page.locator('.password-dialog').waitFor(); await page.locator('.password-dialog').getByRole('button', { name: '取消', exact: true }).click(); await page.locator('.password-dialog').waitFor({ state: 'detached' }); assert.equal(await page.locator('.password-dialog').count(), 0);
  await page.goto(`${f.origin}/seller/#products`); await page.locator('#product-list-view').waitFor(); assert.equal(await page.locator('.ui-page-heading').count(), 0, 'Team heading opt-in is removed on route disposal'); assert.equal(await page.locator('#team-add-person').count(), 0);
  await page.goto(`${f.origin}/seller/#team`); await ready(); assert.equal(await page.locator('#team-add-person').count(), 1);
  const longName = 'long.member.' + 'x'.repeat(48);
  await createAccount(f.app.database, { username: longName, role: 'MANAGER', password: 'Fictional-Polish-Pass-2026!' }, f.config.username);
  await createAccount(f.app.database, { username: 'fixture.staff', role: 'STAFF', password: 'Fictional-Polish-Pass-2026!' }, f.config.username);
  await page.reload(); await ready(); assert.equal(await rows.count(), 3); if (width === 1050 || width === 1051 || width === 1100) assert.ok(await rows.first().locator('td').first().evaluate(cell => cell.getBoundingClientRect().width >= 170), 'expanded-sidebar edge preserves a readable username column'); assert.equal(await page.locator('.team-result-count').innerText(), '共 3 位成员');
  const longCell = await rows.filter({ hasText: longName }).locator('td').first().boundingBox(); writeFileSync(`${artifacts}/geometry-${width}.json`, JSON.stringify({ ...fluidGeometry, longUsernameCell: longCell }, null, 2));
  await page.locator('#team-filter-role').selectOption('STAFF'); assert.equal(await page.locator('.team-result-count').innerText(), '找到 1 位成员，共 3 位'); assert.equal(await page.locator('.team-owner-guidance').isVisible(), false);
  await page.locator('#team-filter-status').selectOption('inactive'); assert.equal(await rows.count(), 0); await page.locator('#team-clear-filters').click();
  const summary = page.locator('.team-activity > summary'); assert.equal(await summary.locator('[data-i18n=teamActivity]').innerText(), '成员操作记录'); await summary.focus(); await page.keyboard.press('Enter');
  const response = await f.app.database.get('SELECT COUNT(*) AS n FROM account_event');
  assert.equal(await page.locator('.team-activity-table tbody tr').count(), Math.min(20, Number(response.n))); assert.match(await page.locator('.team-activity-count').innerText(), new RegExp(`最近 ${Math.min(20, Number(response.n))} 条记录`)); assert.match(await page.locator('.team-activity-latest').innerText(), /最新：/); const actualLatest = (await f.app.database.all('SELECT created_at FROM account_event ORDER BY created_at DESC')).map(event => event.created_at)[0]; assert.equal(await page.locator('.team-activity-latest').getAttribute('datetime'), actualLatest);
  assert.deepEqual(await page.locator('.team-activity-table th').allTextContents(), ['时间', '操作者', '成员', '操作']);
  assert.match(await page.locator('.team-activity-table').innerText(), /已添加/); assert.doesNotMatch(await page.locator('.team-activity-table').innerText(), /CREATED|password_hash|Fictional-Polish/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('members-activity');
  if (width === 1920) { await page.locator('#collapse-nav').click(); await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width <= 75); assert.ok(await page.evaluate(() => Math.abs(document.querySelector('.team-page').getBoundingClientRect().left - document.querySelector('#main').getBoundingClientRect().left - parseFloat(getComputedStyle(document.querySelector('#main')).paddingLeft)) < 2)); await shot('collapsed-nav'); await page.locator('#collapse-nav').click(); await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width >= 247); await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'CSS 125% zoom reflow remains within viewport'); await shot('css-zoom-125'); await page.evaluate(() => { document.documentElement.style.zoom = ''; }); }
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
