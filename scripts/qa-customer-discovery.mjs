import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
import { createApp } from '../src/server.js';
import { useWorkerIngress } from '../test/browser/worker-harness.mjs';

const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/customer-discovery-formal'); mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const paths = ['public/shop/app.js', 'public/shop/shop-route.js', 'public/shop/product-detail.js', 'public/shop/catalog-presentation.js', 'public/shop/index.html', 'public/shop/mobile-navigation.js', 'public/shop/cart.js', 'public/shop/version.js', 'public/shop/sw.js', 'src/products.js', 'src/app.js', 'src/worker.js'];
const hashes = () => Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
const report = { sourceHead: head, sourceHashes: hashes(), baselineSourceHead: '4e49f13dbf19a866750d8a61884662cfc23fb745', gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), versions: Object.fromEntries(['shop', 'seller'].map(surface => [surface, /v\d+/.exec(readFileSync(`public/${surface}/version.js`, 'utf8'))[0]])), coverage: 'Criteria2/3/4/6/7 plus catalog-only reset/append race subset94; no full criterion94 certification', cases: [], stateEvidence: [], pageErrors: [], externalRequests: [] };
const browser = await chromium.launch({ headless: true }); report.browser = browser.version();
let app, context, temp, width, stage, gateway;
const checked = async (id, label, fn) => { stage = `#${id} ${label}`; try { const evidence = await fn(); report.cases.push({ id, label, width, status: 'PASS', evidence }); console.log(`PASS #${id}/${width} ${label}`); } catch (error) { report.cases.push({ id, label, width, status: 'FAIL', error: error.message }); throw error; } };
try {
  temp = mkdtempSync(join(tmpdir(), 'online-shopping-discovery-qa-'));
  const config = { dbPath: join(temp, 'synthetic.db'), shopMode: 'manual', username: 'synthetic_discovery_qa', password: randomUUID() + randomUUID(), production: false, publicOrigin: null };
  app = createApp(config); gateway = useWorkerIngress(app, config); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const origin = 'http://127.0.0.1:' + app.server.address().port;
  const login = await fetch(origin + '/api/v1/seller/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: config.username, password: config.password }) }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  const api = async (method, path, body) => { const r = await fetch(origin + path, { method, headers: { origin, cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await r.json(); assert.ok(r.ok, JSON.stringify({ status: r.status, data })); return data; };
  for (const [code, label] of [['GARDEN', 'Fictional Garden'], ['OFFICE', 'Fictional Office'], ['INACTIVE', 'Fictional Inactive Only']]) await api('POST', '/api/v1/seller/categories', { code, label });
  const products = [];
  for (let n = 1; n <= 55; n++) { const tag = String(n).padStart(4, '0'); products.push(await api('POST', '/api/v1/seller/products', { sku: 'DISC-' + tag, name: `Fictional Market ${n % 5 === 0 ? 'Orchid' : 'Everyday'} item ${tag}`, description: 'Fictional fixture description-only-needle', category: n > 53 ? 'INACTIVE' : n <= 30 ? 'GARDEN' : 'OFFICE', priceMinor: 1000 + n, active: n <= 53 })); }
  const database = () => ({ products: app.database.all('SELECT id,sku,name,description,category,price_minor,currency,active,updated_at FROM product ORDER BY id'), domain: Object.fromEntries(['shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency', 'order_sequence'].map(t => [t, app.database.all('SELECT * FROM ' + t + ' ORDER BY rowid')])) }); const before = database();
  const expected = (search = '', category = '') => products.filter(p => p.active && (!search || p.name.toLowerCase().includes(search.trim().toLowerCase()) || p.sku.toLowerCase().includes(search.trim().toLowerCase())) && (!category || p.category === category)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  report.fixture = { active: 53, inactive: 2, categories: ['Fictional Garden', 'Fictional Office'], catalog: products.map(({ id, sku, name, category, active, priceMinor, updatedAt }) => ({ id, sku, name, category, active, priceMinor, updatedAt })), databaseBefore: before };
  for (width of [390, 1280]) {
    context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' }); const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', e => report.pageErrors.push({ width, stage, error: e.message }));
    await context.route('**/*', route => { if (!route.request().url().startsWith(origin + '/')) { report.externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
    const ids = () => page.locator('.catalog-card .product-name-link').evaluateAll(links => links.map(a => a.dataset.productId));
    const ready = count => page.waitForFunction(n => document.querySelector('#catalog-grid')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.catalog-card').length === n, count);
    const shot = name => page.screenshot({ path: out + `/${name}-${width}.png` });
    const keyboard = async selector => { await page.locator(selector).evaluate(b => b.focus({ preventScroll: true })); await page.keyboard.press('Enter'); };
    const more = async count => { await keyboard('#catalog-more'); await ready(count); };
    const filter = async (search = '', category = '') => { await page.evaluate(() => scrollTo(0, 0)); await page.locator('.category-option').filter({ has: page.locator('span:last-child', { hasText: category || 'All categories' }) }).filter({ hasText: category || 'All categories' }).first().click();
      await page.locator('#catalog-search').fill(search); await page.locator('#catalog-search').press('Enter'); await ready(Math.min(expected(search, category).length, 24));
      assert.equal(new URL(page.url()).searchParams.get('search') || '', search.trim()); assert.equal(new URL(page.url()).searchParams.get('category') || '', category); };
    await page.goto(origin + '/shop/#catalog'); await ready(24); const startRecord = gateway.records.length;
    await checked(2, 'Complete53active catalog pages24/24/5 with no duplicate/omission and no inactive products', async () => {
      assert.deepEqual(await ids(), expected().slice(0, 24).map(p => p.id)); await more(48); assert.deepEqual(await ids(), expected().slice(0, 48).map(p => p.id)); await more(53);
      const loaded = await ids(); assert.deepEqual(loaded, expected().map(p => p.id)); assert.equal(new Set(loaded).size, 53); assert.equal(await page.locator('#catalog-more').isVisible(), false); assert.match(await page.locator('#catalog-page-message').innerText(), /all products/i); assert.match(await page.locator('#catalog-count').innerText(), /53/);
      await page.locator('.catalog-card').last().scrollIntoViewIfNeeded(); await shot('catalog-pagination-end'); return { count: 53, stages: [24, 48, 53], exactOrderedIDs: loaded, inactiveExcluded: products.filter(p => !p.active).map(p => p.id), endNoticeVisible: true };
    });
    await checked(3, 'Existing case-insensitive name and SKU substring search; description-only term is not a match', async () => {
      const observations = [];
      for (const query of ['ORCHID', 'rchid', 'disc-0039', 'description-only-needle']) { await filter(query); const shown = await ids(); assert.deepEqual(shown, expected(query).map(p => p.id)); observations.push({ query, IDs: shown }); }
      assert.equal(await page.locator('#catalog-clear-filters').isVisible(), true); await shot('search-no-description-match'); await page.locator('#catalog-clear-filters').click(); await ready(24); assert.equal(await page.locator('#catalog-search').inputValue(), ''); return { observations, scope: 'Name/SKU substring only; no new search rules' };
    });
    await checked(4, 'Category-only filtering and search/category intersection use the same actual product IDs', async () => {
      assert.deepEqual(await page.locator('#catalog-category option').allTextContents(), ['All categories', 'Fictional Garden', 'Fictional Office']);
      await filter('', 'Fictional Garden'); assert.deepEqual(await ids(), expected('', 'Fictional Garden').slice(0, 24).map(p => p.id)); await more(30); assert.deepEqual(await ids(), expected('', 'Fictional Garden').map(p => p.id));
      const combinations = [];
      for (const category of ['Fictional Garden', 'Fictional Office']) { await filter('OrChId', category); assert.deepEqual(await ids(), expected('OrChId', category).map(p => p.id)); combinations.push({ category, query: 'OrChId', IDs: await ids() }); }
      await shot('category-search-intersection'); await filter('DISC-0039', 'Fictional Garden'); assert.deepEqual(await ids(), []); assert.equal(await page.locator('#catalog-clear-filters').isVisible(), true); await page.locator('#catalog-clear-filters').click(); await ready(24); return { gardenTotal: 30, combinations, mismatchedIntersectionEmpty: true, inactiveOnlyCategoryNotOffered: true };
    });
    await checked(6, 'Append503 retains exact loaded cards/offset; reset503 retains filters with truthful empty/error state and retry', async () => {
      const retained = await ids(); gateway.controls.failNextCatalog = true; await keyboard('#catalog-more'); await page.locator('#catalog-page-retry').waitFor({ state: 'visible' }); assert.deepEqual(await ids(), retained); assert.equal(await page.locator('#catalog-grid').getAttribute('aria-busy'), 'false'); await shot('append-failure-retained');
      const failure = gateway.records.findLast(r => r.syntheticFailure); assert.equal(new URLSearchParams(failure.query).get('offset'), '24'); await keyboard('#catalog-page-retry'); await ready(48); assert.deepEqual(await ids(), expected().slice(0, 48).map(p => p.id));
      await page.evaluate(() => scrollTo(0, 0)); gateway.controls.failNextCatalog = true; await page.locator('#catalog-search').fill('ORCHID'); await page.locator('#catalog-search').press('Enter'); await page.locator('#catalog-retry').waitFor({ state: 'visible' });
      assert.deepEqual(await ids(), []); assert.equal(await page.locator('#catalog-search').inputValue(), 'ORCHID'); assert.equal(await page.locator('#catalog-category').inputValue(), ''); assert.equal(new URL(page.url()).searchParams.get('search'), 'ORCHID'); assert.ok(await page.locator('#catalog-status').innerText()); await shot('reset-failure-filters-retained');
      await keyboard('#catalog-retry'); await ready(10); assert.deepEqual(await ids(), expected('ORCHID').map(p => p.id)); assert.equal(await page.locator('#catalog-retry').isVisible(), false); assert.equal(await page.locator('#catalog-status').innerText(), ''); assert.deepEqual(database(), before); return { appendHTTP: 503, appendOffset: 24, retainedIDs: retained, retryCount: 48, resetHTTP: 503, preservedSearch: 'ORCHID', resetShowsNoStaleCards: true, resetRetryExact10: true, databaseUnchanged: true };
    });
    await checked(7, 'Direct product URL and Back preserve catalog search/category, loaded pages, scroll and originating link focus', async () => {
      const direct = products[38]; const directPage = await context.newPage(); directPage.on('pageerror', e => report.pageErrors.push({ width, stage, error: e.message })); await directPage.goto(origin + '/shop/#product/' + direct.id); await directPage.waitForFunction(sku => document.querySelector('.product-key-details')?.textContent.includes(sku), direct.sku); assert.equal(await directPage.locator('#detail-title').innerText(), direct.name); await directPage.locator('.product-back').click(); await directPage.locator('#catalog-view').waitFor({ state: 'visible' }); assert.equal(new URL(directPage.url()).hash, '#catalog'); await directPage.screenshot({ path: out + `/direct-product-back-${width}.png` }); await directPage.close();
      await filter('Market', 'Fictional Garden'); await more(30); const loadedBefore = await ids(); const target = expected('Market', 'Fictional Garden').at(-3); const link = page.locator(`.product-name-link[data-product-id="${target.id}"]`); await link.scrollIntoViewIfNeeded(); await link.focus(); const scrollBefore = await page.evaluate(() => scrollY); const urlBefore = new URL(page.url());
      await link.click(); await page.waitForFunction(sku => document.querySelector('.product-key-details')?.textContent.includes(sku), target.sku); assert.equal(new URL(page.url()).hash, '#product/' + target.id); assert.equal(await page.locator('#detail-title').innerText(), target.name); await shot('catalog-page2-product-detail');
      await page.locator('.product-back').click(); await page.locator('#catalog-view').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('#catalog-grid').getAttribute('aria-busy') === 'false');
      const state = { loadedBefore, loadedAfter: await ids(), scrollBefore, scrollAfter: await page.evaluate(() => scrollY), focused: await page.evaluate(() => ({ id: document.activeElement?.dataset.productId, kind: document.activeElement?.dataset.catalogLink })), search: await page.locator('#catalog-search').inputValue(), category: await page.locator('#catalog-category').inputValue(), URL: page.url() };
      report.stateEvidence.push({ width, criterion: 7, state }); await shot('product-back-catalog-context');
      assert.deepEqual(state.loadedAfter, loadedBefore); assert.equal(state.search, 'Market'); assert.equal(state.category, 'Fictional Garden'); assert.equal(new URL(state.URL).search, urlBefore.search); assert.ok(Math.abs(state.scrollAfter - scrollBefore) <= 3); assert.deepEqual(state.focused, { id: target.id, kind: 'title' });
      await page.locator(`.product-name-link[data-product-id="${target.id}"]`).click(); await page.waitForFunction(sku => document.querySelector('.product-key-details')?.textContent.includes(sku), target.sku);
      await page.goBack(); await ready(30); assert.deepEqual(await ids(), loadedBefore); await page.goForward(); await page.waitForFunction(sku => document.querySelector('.product-key-details')?.textContent.includes(sku), target.sku); await page.goBack(); await ready(30); assert.deepEqual(await ids(), loadedBefore);
      await filter('ORCHID', 'Fictional Office'); await filter('DISC-0039', 'Fictional Office'); await page.goBack(); await ready(4); assert.equal(await page.locator('#catalog-search').inputValue(), 'ORCHID'); assert.equal(await page.locator('#catalog-category').inputValue(), 'Fictional Office'); assert.deepEqual(await ids(), expected('ORCHID', 'Fictional Office').map(p => p.id));
      assert.deepEqual(database(), before); return { browserBackForwardRetains30: true, changedFilterHistoryReloadsCorrect4: true, directProductID: direct.id, directBackCatalog: true, returningProductID: target.id, ...state };
    });

    const poll = async fn => { for (let n = 0; n < 150; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Synthetic delay not reached'); };
    const startSearch = async query => { await page.evaluate(() => scrollTo(0, 0)); await page.locator('#catalog-search').fill(query); await page.locator('#catalog-search').press('Enter'); };
    await checked(94, 'Delayed reset error A to B to history cannot override current filter/results/status', async () => {
      await filter('', ''); gateway.controls.holdNextCatalog = { search: 'ORCHID', offset: '0', failAfterRelease: true };
      await startSearch('ORCHID'); await poll(() => gateway.controls.held); await startSearch('DISC-0039'); await ready(1);
      await page.goBack(); await ready(10); assert.equal(await page.locator('#catalog-search').inputValue(), 'ORCHID');
      const delayed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/products' && r.status() === 503);
      gateway.controls.held.release(); await delayed;
      // The application rejects non-OK headers without consuming the body. Wait for its
      // stale-error handler, rather than Response.finished() on that unread response.
      await poll(() => !gateway.controls.held); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.deepEqual(await ids(), expected('ORCHID').map(p => p.id)); assert.equal(await page.locator('#catalog-status').innerText(), ''); assert.equal(await page.locator('#catalog-retry').isVisible(), false);
      await shot('delayed-reset-history-safe'); return { delayedPostWorkerHTTP: 503, A: 'ORCHID', B: 'DISC-0039', history: 'ORCHID', exact10IDs: await ids(), staleErrorDiscarded: true, criterionWideRaceAcceptance: 'UNVERIFIED' };
    });
    await checked(94, 'Delayed real append A to B to history cannot restore stale pages/offset/status', async () => {
      await filter('', ''); const initial = await ids(); gateway.controls.holdNextCatalog = { search: '', offset: '24' };
      await keyboard('#catalog-more'); await poll(() => gateway.controls.held); await startSearch('ORCHID'); await ready(10); await page.goBack(); await ready(24);
      const delayed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/products' && new URL(r.url()).searchParams.get('offset') === '24'); gateway.controls.held.release(); const reply = await delayed; if (reply.ok()) await reply.finished(); await poll(() => !gateway.controls.held); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.deepEqual(await ids(), initial); assert.equal(await page.locator('#catalog-status').innerText(), ''); assert.equal(await page.locator('#catalog-page-retry').isVisible(), false); await more(48); assert.deepEqual(await ids(), expected().slice(0, 48).map(p => p.id));
      await shot('delayed-append-history-safe'); return { delayedRealHTTP: 200, heldOffset: 24, historyResetCount: 24, freshAppendCount: 48, noDuplicateOrStaleOffset: true, criterionWideRaceAcceptance: 'UNVERIFIED' };
    });
    report.stateEvidence.push({ width, workerRequests: gateway.records.slice(startRecord) }); await context.close(); context = null;
  }
  report.databaseAfter = database(); assert.deepEqual(report.databaseAfter, before); report.workerRequests = gateway.records; assert.equal(report.pageErrors.length, 0); assert.equal(report.externalRequests.length, 0); assert.deepEqual(hashes(), report.sourceHashes);
} catch (e) { process.exitCode = 1; console.error(e.stack); }
finally {
  gateway?.controls.held?.release();
  report.applicationHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); report.sourceHashesAfter = hashes();
  report.criterionStatus = [2, 3, 4, 6, 7, 94].map(id => {
    const cases = report.cases.filter(x => x.id === id);
    const scopedStatus = cases.length === (id === 94 ? 4 : 2) && cases.every(x => x.status === 'PASS') ? 'PASS' : cases.some(x => x.status === 'FAIL') ? 'FAIL' : 'UNKNOWN';
    return { id, status: id === 94 && scopedStatus === 'PASS' ? 'UNVERIFIED' : scopedStatus, scopedStatus };
  });
  writeFileSync(out + '/results.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ head, criteria: report.criterionStatus, cases: report.cases.map(({ id, width, status, error }) => ({ id, width, status, error })) }));
  if (context) await context.close(); await browser.close(); if (app) await app.close(); if (temp) rmSync(temp, { recursive: true, force: true });
}
