import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { catalogCreateRuntimeFixture } from './helpers/mcp-catalog-create-runtime-fixture.js';
import { catalogMediaCreateTool } from '../src/mcp/catalog-media-create-adapter.js';
import { operationControlTools } from '../src/mcp/operation-control-contracts.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';
import { createApi } from '../src/app.js';
import { serveStatic } from '../src/static.js';
import { createAccount } from '../src/accounts.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const dto = response => response.data.result?.structuredContent;
for (const dialect of ['sqlite', 'postgres']) for (const base of ['', '/alpha']) {
  test(`${dialect}: ${base || 'default'} real HTTPS sign-in returns to the exact attributed CREATE review and requires page/password approval`,
    { skip: !modulePath || (dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL), timeout: 60000 }, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'shopping-review-entry-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
      let api;
      const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const result = await api(new Request(`https://127.0.0.1:${server.address().port}${request.url}`, {
          method: request.method, headers: request.headers,
          ...(!['GET', 'HEAD'].includes(request.method) ? { body: Buffer.concat(chunks) } : {}),
        }), { clientAddress: 'synthetic-review-entry-browser' });
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => { server.closeAllConnections(); server.close(); });
      const origin = `https://127.0.0.1:${server.address().port}`;
      const f = await catalogCreateRuntimeFixture(t, dialect, { config: { sellerOrigin: origin, publicOrigin: origin, basePath: base,
        ...(base ? { storageScope: 't-123456abcdef', tenantName: 'Synthetic prefixed shop' } : {}) } });
      api = await createApi({ store: f.store, config: f.config, serveStatic,
        operationTools: [catalogMediaCreateTool(f.runtime), ...operationControlTools()] });
      const { chromium } = await import(modulePath);
      const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
      // Genuine OAuth handlers over HTTPS, isolated from the seller's new browser context.
      const authorizationContext = await browser.newContext({ ignoreHTTPSErrors: true }); t.after(() => authorizationContext.close());
      const call = async (path, method = 'GET', body, headers = {}) => {
        const result = await authorizationContext.request.fetch(origin + base + path, { method,
          headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { data: typeof body === 'string' ? body : JSON.stringify(body) }) });
        const raw = await result.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
        return { response: { status: result.status(), headers: new Headers(result.headers()) }, data };
      };
      const client = await freshCatalogAccess(f, legacyCatalogScopes + ' catalog.write media.write operations.read operations.cancel', call);
      const prepared = await client.call('catalog.preview_create', { input: { sku: 'REVIEW-ENTRY-NEW', name: 'Synthetic empty-image creation',
        description: 'Fictional review entry acceptance', category: 'SYNTHETIC', currency: 'MYR', priceMinor: 1250, active: true, stockQuantity: 3 },
        idempotencyKey: 'synthetic-review-entry-create' });
      const op = dto(prepared); assert.ok(op?.operationId, JSON.stringify(prepared.data));
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 0);
      assert.equal(f.decodes(), 0); // Empty BEFORE / zero assets cannot invoke a decoder.
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?', op.operationId)).n), 0);
      const context = await browser.newContext({ ignoreHTTPSErrors: true,
        viewport: { width: base ? 1280 : 390, height: 900 }, colorScheme: base ? 'light' : 'dark', serviceWorkers: 'block' });
      t.after(() => context.close());
      const page = await context.newPage(), external = [], errors = [];
      const styles = new Map([
        [base + '/shop/tokens.css', await readFile(new URL('../public/shop/tokens.css', import.meta.url), 'utf8')],
      ]);
      const styleResponses = [];
      page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (styles.has(path)) styleResponses.push({ path, status: response.status() });
      });
      for (const [path, bytes] of styles) {
        const response = await context.request.get(origin + path);
        assert.equal(response.status(), 200, path);
        assert.match(response.headers()['content-type'], /^text\/css\b/, path);
        assert.equal(await response.text(), bytes, path);
      }
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
      await page.goto(op.reviewUrl + '&utm_source=chatgpt.com');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Sign in to Seller Studio'));
      for (const path of styles.keys()) {
        assert.ok(styleResponses.some(response => response.path === path && response.status === 200), path);
        assert.equal(await page.evaluate(href => [...document.styleSheets].some(sheet =>
          sheet.href === href && sheet.cssRules.length > 0), origin + path), true, path);
      }
      assert.equal(await page.locator('#review').isVisible(), false);
      assert.equal(await page.locator('#seller-link').getAttribute('href'), `${base}/seller/?reviewOperation=${op.operationId}`);
      await page.locator('#seller-link').click();
      await page.locator('#login-form').waitFor({ state: 'visible' });
      await page.locator('#username').fill('synthetic_owner'); await page.locator('#password').fill('wrong-synthetic-password');
      await page.locator('#login-submit').click();
      await page.waitForFunction(() => !document.querySelector('#login-submit').disabled);
      assert.equal(new URL(page.url()).pathname, `${base}/seller/`);
      await page.locator('#password').fill(reviewPassword); await page.locator('#login-submit').click();
      await page.waitForURL(op.reviewUrl);
      await page.locator('#review').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#approve').disabled);
      assert.equal(await page.locator('#media-ack').isChecked(), false);
      assert.equal((await client.call('catalog.commit_create', { operationId: op.operationId })).response.status, 403);
      // Both canonical and attributed authenticated links load the same operation.
      await page.goto(op.reviewUrl + '&utm_source=chatgpt.com');
      await page.locator('#review').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#approve').disabled);
      assert.equal(await page.locator('#tool').textContent(), 'catalog.preview_create');
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', op.operationId)).state, 'PENDING_APPROVAL');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const evidenceDir = process.env.QA_REVIEW_EVIDENCE_DIR;
      if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await page.screenshot({ path: join(evidenceDir, `${dialect}-${base ? 'desktop-light' : 'mobile-dark'}-review.png`), fullPage: true }); }
      await page.locator('#password').fill(reviewPassword); await page.locator('#approve').click();
      assert.match(await page.locator('#status').textContent(), /check the image acknowledgment/);
      await page.locator('#media-ack').check();
      const approvalRequest = page.waitForRequest(request => request.method() === 'POST' &&
        request.url() === origin + base + '/api/v1/seller/mcp/operations/' + op.operationId + '/approval');
      await page.locator('#approve').click();
      const approvedRequest = await approvalRequest;
      await page.locator('#decision').waitFor({ state: 'hidden' });
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', op.operationId)).state, 'APPROVED');
      assert.equal(await page.locator('#password').inputValue(), '');
      // Replay the exact fictional browser request with the same session and CSRF.
      // Its password-bearing body remains in memory and is never logged or persisted.
      const duplicateApproval = await context.request.post(approvedRequest.url(), {
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': approvedRequest.headers()['x-csrf-token'] },
        data: approvedRequest.postData(),
      });
      assert.equal(duplicateApproval.status(), 403);
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', op.operationId)).state, 'APPROVED');
      const committed = dto(await client.call('catalog.commit_create', { operationId: op.operationId }));
      assert.equal(committed?.status, 'COMMITTED');
      const created = await f.store.get('SELECT sku,active,price_minor,stock_quantity FROM product WHERE id=?', committed.result.productId);
      assert.deepEqual({ ...created }, { sku: 'REVIEW-ENTRY-NEW', active: 1, price_minor: 1250, stock_quantity: 3 });
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 1);
      const catalogGet = await client.call('catalog.get', { id: committed.result.productId });
      assert.equal(catalogGet.response.status, 200);
      const readback = dto(catalogGet)?.product;
      assert.deepEqual({ id: readback?.id, sku: readback?.sku, active: readback?.active,
        priceMinor: readback?.priceMinor, stockQuantity: readback?.stockQuantity }, {
        id: committed.result.productId, sku: 'REVIEW-ENTRY-NEW', active: true, priceMinor: 1250, stockQuantity: 3,
      });
      const catalogList = await client.call('catalog.list', { limit: 50, offset: 0 });
      assert.equal(catalogList.response.status, 200);
      assert.deepEqual(dto(catalogList)?.items.map(product => product.id), [committed.result.productId]);
      assert.equal(dto(catalogList).nextOffset, null);
      assert.equal(dto(catalogList).paginationCapped, false);
      assert.equal(dto(await client.call('catalog.commit_create', { operationId: op.operationId })).replayed, true);
      const cancelled = dto(await client.call('catalog.preview_create', { input: { sku: 'CANCELLED-ENTRY', name: 'Fictional cancelled creation',
        description: 'Synthetic recovery case', category: 'SYNTHETIC', priceMinor: 999, active: true }, idempotencyKey: 'synthetic-entry-cancelled-preview' }));
      assert.ok(cancelled?.operationId);
      assert.equal(dto(await client.call('operations.cancel', { operationId: cancelled.operationId })).status, 'CANCELLED');
      // Unavailable/unknown/terminal references reveal no proposal and give one recovery action.
      for (const id of [op.operationId, cancelled.operationId, '00000000-0000-4000-8000-000000000000']) {
        await page.goto(origin + base + '/oauth/operation?operationId=' + id + '&utm_source=chatgpt.com');
        await page.waitForFunction(() => document.querySelector('#status').textContent.includes('prepare a new preview'));
        assert.equal(await page.locator('#review').isVisible(), false);
        assert.equal(await page.locator('#proposal').textContent(), '');
      }
      const otherPending = dto(await client.call('catalog.preview_create', { input: { sku: 'OTHER-ACCOUNT-ENTRY', name: 'Private owner proposal',
        description: 'Private fictional proposal marker', category: 'SYNTHETIC', priceMinor: 1000, active: true }, idempotencyKey: 'synthetic-entry-other-account' }));
      await createAccount(f.store, { username: 'other_manager', role: 'MANAGER', password: 'Temporary-fixture-2026!' }, 'synthetic_owner');
      const otherContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
      const otherPage = await otherContext.newPage(); otherPage.setDefaultTimeout(8000);
      await otherPage.goto(origin + base + '/seller/?reviewOperation=' + otherPending.operationId);
      await otherPage.locator('#username').fill('other_manager'); await otherPage.locator('#password').fill('Temporary-fixture-2026!');
      await otherPage.locator('#login-submit').click();
      await otherPage.locator('.password-dialog').waitFor({ state: 'visible' });
      const managerFields = otherPage.locator('.password-dialog input');
      await managerFields.nth(0).fill('Temporary-fixture-2026!'); await managerFields.nth(1).fill('Manager-secret-2026!'); await managerFields.nth(2).fill('Manager-secret-2026!');
      await otherPage.locator('.password-dialog button[type=submit]').click(); await otherPage.waitForURL(otherPending.reviewUrl);
      await otherPage.waitForFunction(() => document.querySelector('#status').textContent.includes('prepare a new preview'));
      assert.equal(await otherPage.locator('#review').isVisible(), false);
      assert.equal(await otherPage.locator('#proposal').textContent(), '');
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', otherPending.operationId)).state, 'PENDING_APPROVAL');
      await otherContext.close();
      // Advance only the isolated Node fixture clock, leaving the signed envelope
      // and all approval hashes intact. Actual operation controls perform expiry.
      const expiring = dto(await client.call('catalog.preview_create', { input: { sku: 'EXPIRING-ENTRY', name: 'Fictional expiring proposal',
        description: 'Synthetic clock expiry case', category: 'SYNTHETIC', priceMinor: 1001, active: true }, idempotencyKey: 'synthetic-entry-expiring' }));
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      try {
        t.mock.timers.setTime(Date.parse(expiring.expiresAt) + 1);
        await client.call('operations.get', { operationId: expiring.operationId });
        assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', expiring.operationId)).state, 'EXPIRED');
        await page.goto(expiring.reviewUrl + '&utm_source=chatgpt.com');
        await page.waitForFunction(() => document.querySelector('#status').textContent.includes('prepare a new preview'));
        assert.equal(await page.locator('#review').isVisible(), false);
        assert.equal(await page.locator('#proposal').textContent(), '');
      } finally { t.mock.timers.reset(); }
      // A caller cannot turn the continuation into an arbitrary/cross-tenant redirect.
      for (const query of ['reviewOperation=' + op.operationId + '&returnTo=https://evil.example/',
        'reviewOperation=https://evil.example/', 'reviewOperation=' + op.operationId + '&reviewOperation=' + op.operationId,
        'reviewOperation=' + op.operationId + '#unexpected']) {
        await page.goto(origin + base + '/seller/?' + query);
        await page.locator('#workspace').waitFor({ state: 'visible' });
        assert.equal(new URL(page.url()).pathname, base + '/seller/');
      }
      await page.goto(op.reviewUrl + '&utm_source=chatgpt.com');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('prepare a new preview'));
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `${dialect}-${base ? 'desktop-light' : 'mobile-dark'}-unavailable.png`), fullPage: true });
      // Simulate session expiry in the fictional store; no cookie/state injection
      // grants access. The user must sign in again through the real UI.
      await f.store.run('UPDATE session SET expires_at=?', new Date(Date.now() - 10000).toISOString());
      await page.goto(op.reviewUrl);
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Sign in to Seller Studio'));
      assert.equal(await page.locator('#review').isVisible(), false);
      assert.equal(await page.locator('#proposal').textContent(), '');
      // A temporary-password requirement must finish before continuation.
      await f.store.run('UPDATE seller_account SET must_change_password=1 WHERE id=?', f.account.id);
      await page.locator('#seller-link').click(); await page.locator('#login-form').waitFor({ state: 'visible' });
      await page.locator('#username').fill('synthetic_owner'); await page.locator('#password').fill(reviewPassword);
      await page.locator('#login-submit').click(); await page.locator('.password-dialog').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).pathname, base + '/seller/');
      const fields = page.locator('.password-dialog input'), nextPassword = 'New-fixture-password-2026!';
      await fields.nth(0).fill(reviewPassword); await fields.nth(1).fill(nextPassword); await fields.nth(2).fill(nextPassword);
      await page.locator('.password-dialog button[type=submit]').click();
      await page.waitForURL(op.reviewUrl);
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('prepare a new preview'));
      assert.equal(await page.locator('#review').isVisible(), false);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 1);
      // A sample/quick-login runtime cannot turn this continuation into review access.
      api = await createApi({ store: f.store, config: { ...f.config, sellerQuickLogin: true,
        mcpEnabled: false, mcpV2: { enabled: false }, mcpMedia: { enabled: false }, mcpCatalogMediaCreate: { enabled: false } },
        serveStatic, operationTools: [] });
      await page.goto(origin + base + '/seller/?reviewOperation=' + otherPending.operationId);
      await page.locator('#workspace').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).pathname, base + '/seller/');
      assert.equal(await page.locator('#change-password').isVisible(), false);
      assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(f.decodes(), 0);
    });
}
