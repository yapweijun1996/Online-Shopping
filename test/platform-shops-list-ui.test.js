import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;

test('Shops list: header action, compact toolbar, single count, conditional footer, row actions menu, states, responsive and keyboard', { skip: !browserModule, timeout: 120000 }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try { const data = await readFile(file); response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); response.end(data); } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const base = { id: '12345678-1234-4234-8234-123456789abc', code: 'default', name: 'Pomelo Stem', currency: 'MYR', status: 'ACTIVE', isDefault: true, createdAt: '2026-11-02T03:00:00Z', shopUrl: `${origin}/shop/`, sellerUrl: `${origin}/seller/` };
  const many = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`, code: `shop${i}`, name: `Fictional shop ${i}`, isDefault: false, status: i % 5 ? 'ACTIVE' : 'SUSPENDED' }));
  let items = [base], failShops = 0;
  await page.route('**/api/v1/platform/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/shops') && failShops > 0) { failShops--; return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'The shop list could not be loaded.' } } }); }
    const body = url.pathname.endsWith('/session') ? { stage: 'FULL', csrfToken: 'synthetic-csrf', username: 'admin' } : url.pathname.endsWith('/shops') ? { items }
      : url.pathname.endsWith('/audit') ? { items: [{ id: '1', created_at: '2026-11-02T03:00:00.000Z', action: 'LOGIN', actor: 'admin', detail: null }], nextCursor: null } : {};
    await route.fulfill({ json: body });
  });
  const open = async () => { await page.goto(`${origin}/platform/index.html`); await page.locator('.shops-table, .empty-state, .panel[role=alert]').first().waitFor(); };
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  // ---- One shop: header action beside the title, useful lead, compact toolbar, one count, no footer.
  await open();
  const title = await page.locator('#page-title').boundingBox(), add = await page.locator('#page-actions').getByRole('button', { name: 'Add shop' }).boundingBox();
  assert.ok(add.x > title.x + title.width && add.y < title.y + title.height && add.y + add.height > title.y, 'Add shop sits on the title row, to the right');
  assert.ok(add.height >= 44);
  assert.equal(await page.locator('.page-lead').innerText(), '1 shop · 1 active');
  assert.ok((await page.locator('.search-field').boundingBox()).width <= 481, 'search is not stretched across the toolbar');
  assert.equal(await page.locator('.search-field svg').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Clear search' }).isHidden(), true, 'no clear button without a query');
  assert.equal(await page.locator('.filter-field > span').innerText(), 'Status'); assert.equal(await page.locator('.filter-field option:checked').innerText(), 'All statuses');
  assert.equal(await page.locator('.table-count').innerText(), '1 shop');
  assert.equal(await page.locator('.table-footer').isHidden(), true, 'one page: no pager, no rows-per-page, no range');
  assert.equal(await page.locator('.table-range').isHidden(), true, 'no visible "Showing" line on one page');
  assert.match(await page.locator('.shops-table p.sr-only[role=status]').innerText(), /Showing 1-1 of 1/, 'screen readers still hear the result count');
  const row = page.locator('.shops-table tbody tr').first();
  assert.match(await row.innerText(), /Pomelo Stem\s+Default shop[\s\S]*Code default[\s\S]*Active[\s\S]*MYR[\s\S]*02 Nov 2026/);

  // ---- Row actions: Manage stays one click away; the menu opens, moves with arrows, closes on Escape and outside clicks, copies with feedback.
  const toggle = row.getByRole('button', { name: 'More actions for Pomelo Stem' });
  assert.equal(await toggle.getAttribute('aria-haspopup'), 'menu');
  for (const target of [row.getByRole('button', { name: 'Manage', exact: true }), toggle]) { const box = await target.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44); }
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const menuItems = page.getByRole('menuitem');
  assert.deepEqual((await menuItems.allInnerTexts()).map(text => text.trim()), ['Open shop', 'Open seller', 'Copy shop link', 'Copy seller link']);
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Open shop');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Open seller');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Copy seller link', 'arrows wrap');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').isHidden(), true); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'More actions for Pomelo Stem', 'focus returns to the toggle');
  for (const item of await menuItems.all()) { /* hidden now */ assert.equal(await item.isHidden(), true); }
  await toggle.click(); await page.locator('.page-lead').click(); assert.equal(await page.getByRole('menu').isHidden(), true, 'a click elsewhere closes it');
  await toggle.click(); await page.getByRole('menuitem', { name: 'Copy shop link' }).click();
  await page.getByText('Shop link copied.').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}/shop/`);
  assert.equal(await page.getByRole('menu').isHidden(), true);
  assert.equal(await page.locator('.row-menu-list a').first().getAttribute('target'), '_blank', 'links open in a new tab');

  // ---- Search: clear appears with a query; no results offers a reset.
  await page.getByRole('searchbox', { name: 'Search shops' }).fill('zzz-not-a-shop');
  await page.getByText('No results.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Clear search' }).isVisible(), true);
  assert.equal(await page.locator('.table-count').innerText(), '0 of 1 shop');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.locator('.shops-table tbody tr').first().waitFor(); assert.equal(await page.getByRole('button', { name: 'Clear search' }).isHidden(), true);

  // ---- Keyboard: the toolbar comes first, then the rows; focus is visible.
  await page.getByRole('searchbox', { name: 'Search shops' }).focus();
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Status filter');
  await toggle.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  assert.equal(await toggle.evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'keyboard focus is visible');

  // ---- Many shops: footer with range, rows-per-page and pager; paging works.
  items = many; await open();
  assert.equal(await page.locator('.page-lead').innerText(), '30 shops · 24 active · 6 suspended');
  assert.equal(await page.locator('.table-footer').isVisible(), true);
  assert.equal(await page.locator('.table-range').innerText(), 'Showing 1–25 of 30');
  assert.equal(await page.getByRole('combobox', { name: 'Rows per page' }).isVisible(), true);
  await page.locator('.table-paging').getByRole('button', { name: 'Next' }).click();
  assert.equal(await page.locator('.table-range').innerText(), 'Showing 26–30 of 30');
  assert.equal(await page.locator('.shops-table tbody tr').count(), 5);

  // ---- Empty, error and long-content states.
  items = []; await open();
  await page.getByRole('heading', { name: 'No shops yet' }).waitFor();
  assert.equal(await page.locator('.empty-state').getByRole('button', { name: 'Add shop' }).count(), 1);
  items = [base]; failShops = 1; await open();
  await page.getByRole('alert').filter({ hasText: 'could not be loaded' }).waitFor();
  await page.getByRole('button', { name: 'Retry' }).click(); await page.locator('.shops-table').waitFor();
  items = [{ ...base, name: 'A very long fictional shop name that keeps going '.repeat(4).trim(), code: 'a'.repeat(30) }]; await open();
  assert.equal(await noOverflow(), true, 'long names wrap at 1280 px');

  // ---- Responsive (phone, tablet, 200% zoom on a 1280 px window): no horizontal scroll, actions reachable, sidebar out of the way.
  items = many;
  for (const [width, height] of [[320, 700], [390, 800], [430, 900], [768, 1000], [640, 450]]) {
    await page.setViewportSize({ width, height }); await open();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#main')).marginLeft === '0px' || innerWidth >= 1024);
    assert.equal(await noOverflow(), true, `no horizontal scroll at ${width}px`);
    if (width < 1024) assert.equal(await page.locator('#sidebar').isHidden(), true, `sidebar does not cover content at ${width}px`);
    const manage = await page.locator('.shops-table tbody tr').first().getByRole('button', { name: 'Manage', exact: true }).boundingBox(), more = await page.locator('.row-menu-toggle').first().boundingBox();
    assert.ok(manage.x >= 0 && more.x + more.width <= width + 1, `row actions inside the screen at ${width}px`);
    await page.locator('.row-menu-toggle').first().click();
    const menuBox = await page.getByRole('menu').boundingBox(); assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1, `menu inside the screen at ${width}px`);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- Activity uses the same table: labelled action filter, single count, no footer for one page.
  await open(); await page.locator('#navigation').getByRole('button', { name: 'Activity', exact: true }).click();
  await page.locator('.activity-table').waitFor();
  assert.equal(await page.locator('.activity-table .filter-field > span').innerText(), 'Action');
  assert.equal(await page.locator('.activity-table .table-count').innerText(), '1 event');
  assert.equal(await page.locator('.activity-table .table-footer').isHidden(), true);
});
