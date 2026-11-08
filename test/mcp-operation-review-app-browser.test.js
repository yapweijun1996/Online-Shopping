import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('real HTTPS app and seller session review and reject a complete proposal in Chromium',
  { skip: !browserModule, timeout: 60000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'shopping-review-browser-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    let api;
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const target = `https://127.0.0.1:${server.address().port}${request.url}`;
      const result = await api(new Request(target, { method: request.method, headers: request.headers,
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: Buffer.concat(chunks) } : {}) }), { clientAddress: 'synthetic-browser' });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const origin = `https://127.0.0.1:${server.address().port}`;
    const f = await reviewFixture(t, 'sqlite', { config: { sellerOrigin: origin } }); api = f.api; await f.seedGrant();
    const injection = '</pre><script>window.__injected=true</script>';
    const op = await f.operation({ proposal: { before: { name: 'Synthetic old' }, after: { name: injection, bidi: 'A\u202eB', tail: 'Full proposal visible' } } });
    const { chromium } = await import(browserModule);
    const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 900 } }); t.after(() => context.close());
    const login = await context.request.post(origin + '/api/v1/seller/session', {
      headers: { Origin: origin }, data: { username: 'synthetic_owner', password: reviewPassword },
    });
    assert.equal(login.status(), 200);
    assert.match(login.headers()['set-cookie'], /Path=\/api\/v1\/seller/);
    const external = [], errors = [];
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort()));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/oauth/operation?operationId=' + op.value.operationId);
    await page.locator('#review').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(await page.locator('#proposal script').count(), 0);
    assert.match(await page.locator('#proposal').textContent(), /Full proposal visible/);
    assert.ok((await page.locator('#proposal').textContent()).includes(injection));
    assert.ok((await page.locator('#proposal').textContent()).includes('\\u202e'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.value.operationId)).state, 'PENDING_APPROVAL');
    await page.locator('button[value="reject"]').click();
    await page.locator('#decision').waitFor({ state: 'hidden' });
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.value.operationId)).state, 'REJECTED');
    assert.equal(await page.locator('#password').count(),0);
    await f.store.run("UPDATE oauth_grant SET scopes = 'catalog.write company.write' WHERE id = ?", f.grantId);
    await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
      SELECT grant_id, tenant_id, account_id, client_id, 'company.write', account_auth_version, epoch_hash, consented_at
      FROM mcp_v2_scope_consent WHERE grant_id = ? AND scope = 'catalog.write'`, f.grantId);
    const company = await f.operation({ toolName: 'company.preview_update', requiredScope: 'company.write', requiredCapability: 'settings.write',
      resourceType: 'company', resourceId: null, risk: 'HIGH',
      proposal: { before: { defaultCurrency: 'MYR' }, after: { defaultCurrency: 'SGD' }, currencyChanged: false } });
    await page.goto(origin + '/oauth/operation?operationId=' + company.value.operationId);
    await page.locator('#currency-warning').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#currency-ack').isChecked(), false);
    assert.match(await page.locator('#currency-warning-text').textContent(), /not converted/);
    await page.locator('button[value="approve"]').click();
    assert.match(await page.locator('#status').textContent(), /check the acknowledgment/);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', company.value.operationId)).state, 'PENDING_APPROVAL');
    await page.locator('#currency-ack').check();
    await page.locator('button[value="approve"]').click();
    await page.locator('#decision').waitFor({ state: 'hidden' });
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', company.value.operationId)).state, 'APPROVED');
    assert.equal((await f.store.get("SELECT outcome FROM mcp_v2_event WHERE operation_id = ? AND event = 'APPROVE'", company.value.operationId)).outcome, 'CURRENCY_CHANGE_ACKNOWLEDGED');
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
  });
