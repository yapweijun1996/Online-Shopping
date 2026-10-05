import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { useWorkerIngress } from '../test/browser/worker-harness.mjs';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/seller-session-ui');
mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const paths = ['public/seller/index.html', 'public/seller/app.js', 'public/seller/products.js',
  'public/seller/settings.js', 'public/shared/i18n.js', 'src/auth.js', 'src/app.js', 'src/worker.js', 'src/db.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(paths.map(path => [path, hash(readFileSync(path))]));
const report = { sourceHead: head, sourceHashes: hashes(), gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  versions: Object.fromEntries(['shop', 'seller'].map(surface => [surface, /v\d+/.exec(readFileSync(`public/${surface}/version.js`, 'utf8'))[0]])), scope: 'Criteria41/44/45 only;390/1280; actual UI, Worker/API, disposable fictional SQLite; one cached Chromium worker',
  artifactPolicy: 'No credentials, cookies, session identifiers, password hashes or CSRF values serialized. Visibility sample is deliberately invalid and non-sensitive.',
  cases: [], stateEvidence: [], cleanup: [], pageErrors: [], externalRequests: [], unexpectedDialogs: [] };
const secrets = new Set();
const redact = error => { let value = String(error?.stack || error); for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[REDACTED]'); return value; };
const browser = await chromium.launch({ headless: true }); report.browser = browser.version();
let app, context, temp, width, stage;
const checked = async (id, label, fn) => {
  stage = `#${id} ${label}`;
  try { const evidence = await fn(); report.cases.push({ id, label, width, status: 'PASS', evidence }); console.log(`PASS #${id}/${width} ${label}`); }
  catch (error) { report.cases.push({ id, label, width, status: 'FAIL', error: redact(error) }); throw error; }
};
const bounded = async (label, operation) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 8000); })]); }
  finally { clearTimeout(timer); }
};
const removeFixture = () => { if (temp) { const fixture = temp; rmSync(fixture, { recursive: true, force: true }); report.cleanup.push({ width, temporaryFixtureRemoved: !existsSync(fixture) }); temp = null; } };
try {
  for (width of [390, 1280]) {
    temp = mkdtempSync(join(tmpdir(), 'online-shopping-session-ui-qa-'));
    const config = { dbPath: join(temp, 'fictional.db'), shopMode: 'manual', username: 'synthetic_session_ui',
      password: randomUUID() + randomUUID(), production: false, publicOrigin: null };
    secrets.add(config.password);
    app = createApp(config); const gateway = useWorkerIngress(app, config);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const bootstrap = await fetch(origin + '/api/v1/seller/session', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: config.username, password: config.password }) });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0], csrf = (await bootstrap.json()).csrfToken;
    secrets.add(cookie); secrets.add(cookie.split('=')[1]); secrets.add(csrf);
    const fixtureAPI = async (method, path, body) => fetch(origin + path, { method, signal: AbortSignal.timeout(8000), headers: { origin, cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await fixtureAPI('POST', '/api/v1/seller/categories', { code: 'BASE', label: 'Fictional Base' })).status, 201);
    const created = await fixtureAPI('POST', '/api/v1/seller/products', { sku: `SESSION-${width}`, name: 'Fictional Session Product', description: 'Synthetic access fixture', category: 'BASE', priceMinor: 1200, active: true });
    assert.equal(created.status, 201); const product = await created.json();
    assert.equal((await fixtureAPI('DELETE', '/api/v1/seller/session')).status, 200);
    const tableNames = app.database.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('admin','session','rate_limit_attempt') ORDER BY name").map(row => row.name);
    const business = () => Object.fromEntries(tableNames.map(table => {
      assert.match(table, /^[a-z_]+$/);
      const rows = app.database.all('SELECT * FROM ' + table + ' ORDER BY rowid');
      return [table, { rows: rows.length, sha256: hash(JSON.stringify(rows)) }];
    }));
    const initialBusiness = business();
    const authCounts = () => ({ active: app.database.get('SELECT COUNT(*) AS n FROM session WHERE expires_at > ?', new Date().toISOString()).n,
      expired: app.database.get('SELECT COUNT(*) AS n FROM session WHERE expires_at <= ?', new Date().toISOString()).n });
    const expireFixtureSession = () => {
      assert.equal(authCounts().active, 1);
      for (const row of app.database.all('SELECT csrf_token FROM session')) secrets.add(row.csrf_token);
      app.database.run('UPDATE session SET expires_at = ?', '2000-01-01T00:00:00.000Z');
      assert.deepEqual(authCounts(), { active: 0, expired: 1 });
    };
    context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', route => { if (!route.request().url().startsWith(origin + '/')) { report.externalRequests.push(redact(route.request().url())); return route.abort(); } return route.continue(); });
    const seller = await context.newPage(); seller.setDefaultTimeout(12000);
    seller.on('pageerror', error => report.pageErrors.push({ width, stage, error: redact(error) }));
    seller.on('dialog', async dialog => { report.unexpectedDialogs.push({ width, stage, type: dialog.type(), message: redact(dialog.message()) }); await dialog.dismiss(); });
    const focusIs = async id => assert.equal(await seller.evaluate(() => document.activeElement?.id), id);
    const hint = () => seller.evaluate(() => localStorage.getItem('online-shopping-seller-session-hint') === '1');
    const sample = 'Fictional visibility sample';
    const shot = async label => {
      const safe = await seller.locator('#password').evaluate((input, allowed) => input.value === '' || input.value === allowed, sample);
      if (!safe) throw new Error('Screenshot blocked: fixture authentication input not cleared');
      await seller.screenshot({ path: out + `/${label}-${width}.png`, fullPage: true });
    };
    const loginReady = async () => { await seller.locator('#login-view').waitFor({ state: 'visible' }); assert.equal(await seller.locator('#workspace').isVisible(), false); };
    const editorReady = async () => {
      await seller.locator('#workspace').waitFor({ state: 'visible' }); await seller.locator('#product-form').waitFor({ state: 'visible' });
      await seller.waitForFunction(sku => document.querySelector('#product-form [name=sku]')?.value === sku && !document.querySelector('#product-save').disabled, product.sku);
      if (await seller.locator('#password').inputValue()) throw new Error('Fixture authentication input was not cleared on login');
    };
    const keyboardLogin = async valid => {
      // Assign ephemeral fixture credentials inside the page, without a fill/trace containing them.
      await seller.evaluate(({ username, password }) => {
        const user = document.querySelector('#username'), pass = document.querySelector('#password');
        user.value = username; pass.value = password;
        for (const input of [user, pass]) input.dispatchEvent(new Event('input', { bubbles: true }));
        user.focus();
      }, { username: config.username, password: valid ? config.password : sample });
      await focusIs('username'); await seller.keyboard.press('Tab'); await focusIs('password');
      const response = seller.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/seller/session' && r.request().method() === 'POST');
      await seller.keyboard.press('Enter'); const result = await response;
      assert.equal(result.status(), valid ? 200 : 401);
      if (valid) await editorReady(); else { await loginReady(); await seller.waitForFunction(() => document.querySelector('#login-message').textContent.includes('Sign in failed') && !document.querySelector('#login-submit').disabled); }
      return { method: 'POST', status: result.status(), submit: 'Native Enter key from password input' };
    };
    const unauthorizedMatrix = async () => {
      const probes = [
        ['GET', '/api/v1/seller/session'], ['GET', '/api/v1/seller/products/' + product.id],
        ['POST', '/api/v1/seller/products', { sku: 'DENIED', name: 'Fictional denied create' }],
        ['PATCH', '/api/v1/seller/products/' + product.id, { name: 'Fictional denied edit' }],
        ['POST', '/api/v1/seller/categories', { code: 'DENIED', label: 'Fictional denied category' }],
        ['PATCH', '/api/v1/seller/categories/BASE', { label: 'Fictional denied category edit' }],
        ['PATCH', '/api/v1/seller/company-settings', { currency: 'SGD' }],
        ['POST', '/api/v1/seller/setup', { name: 'Fictional denied shop' }],
        ['POST', '/api/v1/seller/orders/' + randomUUID() + '/confirm', { revision: 1 }],
        ['DELETE', '/api/v1/seller/session'],
      ];
      const before = business();
      const results = await seller.evaluate(async probes => {
        const results = [];
        for (const [method, path, body] of probes) {
          const response = await fetch(path, { method, signal: AbortSignal.timeout(8000), headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
          results.push({ method, path, status: response.status, code: (await response.json()).error?.code });
        }
        return results;
      }, probes);
      for (const result of results) { assert.equal(result.status, 401); assert.equal(result.code, 'UNAUTHORIZED'); }
      assert.deepEqual(business(), before); return { requests: results, businessTablesUnchanged: true, businessWrites: 0 };
    };
    await seller.goto(origin + '/seller/#products/' + product.id); await loginReady();
    await checked(45, 'Keyboard order, visibility toggle semantics and non-sensitive sample never submit', async () => {
      const start = gateway.records.length; await seller.locator('#username').focus(); await seller.keyboard.press('Tab'); await focusIs('password');
      await seller.keyboard.type(sample); await seller.keyboard.press('Tab'); await focusIs('password-toggle');
      assert.equal(await seller.locator('#password').getAttribute('type'), 'password');
      assert.equal(await seller.locator('#password-toggle').getAttribute('aria-label'), 'Show password');
      await seller.keyboard.press('Space'); assert.equal(await seller.locator('#password').getAttribute('type'), 'text');
      assert.equal(await seller.locator('#password-toggle').getAttribute('aria-pressed'), 'true'); assert.equal(await seller.locator('#password-toggle').getAttribute('aria-label'), 'Hide password');
      assert.equal(await seller.locator('#password').inputValue(), sample); await shot('visibility-synthetic-sample');
      await seller.keyboard.press('Enter'); assert.equal(await seller.locator('#password').getAttribute('type'), 'password');
      assert.equal(await seller.locator('#password-toggle').getAttribute('aria-pressed'), 'false'); assert.equal(await seller.locator('#password-toggle').getAttribute('aria-label'), 'Show password');
      await seller.keyboard.press('Tab'); await focusIs('login-submit'); await seller.keyboard.press('Shift+Tab'); await focusIs('password-toggle'); await seller.keyboard.press('Shift+Tab'); await focusIs('password');
      assert.equal(gateway.records.slice(start).filter(r => r.method === 'POST').length, 0); assert.deepEqual(business(), initialBusiness); await shot('visibility-hidden-keyboard');
      return { focusOrder: ['username', 'password', 'password-toggle', 'login-submit'], reverseOrderVerified: true, SpaceShows: true, EnterHides: true, accessiblePressedAndLabel: true, togglePOSTs: 0, sampleIsNotAuthenticationCredential: true };
    });
    await checked(45, 'Incorrect synthetic keyboard login restores actionable form without business writes', async () => {
      const response = await keyboardLogin(false); assert.equal(await seller.locator('#login-message').getAttribute('role'), 'alert'); assert.deepEqual(authCounts(), { active: 0, expired: 0 });
      assert.deepEqual(business(), initialBusiness); await shot('keyboard-invalid-login'); return { response, formEnabled: true, alertVisible: true, sessionCreated: false, businessWrites: 0 };
    });
    await checked(41, 'Native Enter login and authenticated editor reload preserve saved data', async () => {
      const response = await keyboardLogin(true); assert.equal(await hint(), true); assert.deepEqual(authCounts(), { active: 1, expired: 0 });
      const start = gateway.records.length; await seller.reload(); await editorReady();
      assert.ok(gateway.records.slice(start).some(r => r.method === 'GET' && r.path === '/api/v1/seller/session' && r.status === 200));
      assert.equal(await seller.locator('#product-form [name=name]').inputValue(), product.name); assert.deepEqual(business(), initialBusiness); await shot('login-reload-editor');
      return { response, reloadSessionGET: 200, savedProductLoaded: true, businessWrites: 0 };
    });
    await checked(41, 'Keyboard logout revokes session; reload remains signed out and protected mutations write nothing', async () => {
      await seller.locator('#account-button').focus(); await seller.keyboard.press('Enter');
      assert.equal(await seller.locator('#account-button').getAttribute('aria-expanded'), 'true');
      const updateDisabled = await seller.locator('#check-updates-button').isDisabled();
      const menuFocus = [...(updateDisabled ? [] : ['check-updates-button']), 'profile-button', 'sign-out-button'];
      for (const id of menuFocus) { await seller.keyboard.press('Tab'); await focusIs(id); }
      const response = seller.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/seller/session' && r.request().method() === 'DELETE');
      await seller.keyboard.press('Enter'); assert.equal((await response).status(), 200); await loginReady(); await focusIs('username');
      assert.equal(await hint(), false); assert.deepEqual(authCounts(), { active: 0, expired: 0 });
      assert.equal(await seller.locator('#password').getAttribute('type'), 'password');
      await seller.reload(); await loginReady(); assert.equal(await hint(), false); const denied = await unauthorizedMatrix();
      assert.deepEqual(business(), initialBusiness); await shot('logout-reload-signed-out'); return { logoutDELETE: 200, menuFocus, disabledUpdateSkipped: updateDisabled, revokedSessions: true, usernameFocused: true, signedOutReload: true, denied };
    });
    await checked(41, 'Keyboard re-login after logout restores editor through fresh server session', async () => {
      const response = await keyboardLogin(true); assert.deepEqual(authCounts(), { active: 1, expired: 0 }); assert.equal(await hint(), true);
      assert.equal(await seller.locator('#product-form [name=name]').inputValue(), product.name); assert.deepEqual(business(), initialBusiness); await shot('logout-reauth-editor');
      return { response, oneFreshSession: true, savedProductLoaded: true, businessWrites: 0 };
    });
    await checked(44, 'Expired fixture session rejects real dirty editor Save and returns accessible login with zero business writes', async () => {
      console.log(`STEP #44/${width} preparing dirty editor`);
      await seller.locator('#product-form [name=name]').fill('Fictional rejected expired draft'); const before = business(); expireFixtureSession();
      console.log(`STEP #44/${width} expired fixture session; submitting actual Save`);
      const response = seller.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/seller/products/' + product.id && r.request().method() === 'PATCH');
      await bounded('expired Save click', seller.locator('#product-save').click()); console.log(`STEP #44/${width} Save click completed`);
      const rejected = await bounded('expired Save response', response); assert.equal(rejected.status(), 401);
      console.log(`STEP #44/${width} Save response status401 received`);
      // The UI handles401 without reading its body. Assert actual Worker/API status;
      // Playwright body capture did not complete for this discarded response.
      assert.ok(gateway.records.some(r => r.method === 'PATCH' && r.path === '/api/v1/seller/products/' + product.id && r.status === 401));
      console.log(`STEP #44/${width} actual Save returned401; checking login recovery`);
      await loginReady(); await focusIs('username'); assert.equal(await hint(), false); assert.equal(await seller.locator('#workspace-content').innerText(), '');
      assert.equal(await seller.locator('#login-submit').isDisabled(), false); assert.match(await seller.locator('#login-message').innerText(), /Sign in failed/);
      assert.deepEqual(business(), before); console.log(`STEP #44/${width} checking protected-request matrix`);
      const denied = await unauthorizedMatrix(); assert.deepEqual(business(), before); await shot('expired-save-login-recovery');
      return { fixtureExpiry: authCounts(), actualSavePATCH: 401, rejectedDraftPersisted: false, editorCleared: true, usernameFocused: true, loginEnabled: true, denied, before, after: business(), businessWrites: 0 };
    });
    await checked(44, 'Re-auth loads saved baseline; a new explicit authorized Save succeeds without replaying rejected draft', async () => {
      const start = gateway.records.length; const response = await keyboardLogin(true);
      assert.equal(await seller.locator('#product-form [name=name]').inputValue(), product.name); assert.deepEqual(business(), initialBusiness);
      assert.equal(gateway.records.slice(start).filter(r => ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path !== '/api/v1/seller/session').length, 0);
      await seller.locator('#product-form [name=name]').fill('Fictional explicit authorized edit');
      const saved = seller.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/seller/products/' + product.id && r.request().method() === 'PATCH');
      await seller.locator('#product-save').click(); assert.equal((await saved).status(), 200);
      await seller.waitForFunction(() => document.querySelector('#product-form-success')?.textContent === 'Product saved.');
      assert.equal(app.database.get('SELECT name FROM product WHERE id = ?', product.id).name, 'Fictional explicit authorized edit');
      for (const table of tableNames.filter(name => name !== 'product')) assert.deepEqual(business()[table], initialBusiness[table]);
      await seller.reload(); await editorReady(); assert.equal(await seller.locator('#product-form [name=name]').inputValue(), 'Fictional explicit authorized edit'); await shot('expired-reauth-explicit-save');
      return { response, rejectedDraftAutoReplayRequests: 0, rejectedDraftCleared: 'Observed existing showLogin behavior; no new draft policy', explicitNewPATCH: 200, persistedNewName: true, allOtherBusinessTablesUnchanged: true };
    });
    await checked(44, 'Expired-session reload fails closed; keyboard re-auth recovers saved editor without writes', async () => {
      const before = business(); expireFixtureSession(); const start = gateway.records.length; await seller.reload(); await loginReady();
      assert.ok(gateway.records.slice(start).some(r => r.method === 'GET' && r.path === '/api/v1/seller/session' && r.status === 401));
      assert.equal(await hint(), false); assert.deepEqual(business(), before); await shot('expired-reload-signed-out');
      const response = await keyboardLogin(true); assert.equal(await seller.locator('#product-form [name=name]').inputValue(), 'Fictional explicit authorized edit'); assert.deepEqual(business(), before); await shot('expired-reload-reauth');
      return { startupSessionGET: 401, hintCleared: true, response, savedDataRecovered: true, businessWrites: 0 };
    });
    report.stateEvidence.push({ width, tablesCompared: tableNames, initialBusiness, finalBusiness: business(), authCounts: authCounts(), workerRequests: gateway.records });
    await context.close(); context = null; await app.close(); app = null; removeFixture();
  }
  assert.equal(report.pageErrors.length, 0); assert.equal(report.externalRequests.length, 0); assert.equal(report.unexpectedDialogs.length, 0); assert.deepEqual(hashes(), report.sourceHashes);
} catch (error) { process.exitCode = 1; console.error(redact(error)); }
finally {
  if (context) await context.close(); await browser.close(); if (app) await app.close(); removeFixture();
  report.applicationHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); report.sourceHashesAfter = hashes();
  report.runCompleted = !process.exitCode && report.cases.length === 16 && report.cleanup.length === 2 && report.cleanup.every(item => item.temporaryFixtureRemoved);
  report.criterionStatus = [[41, 6], [44, 6], [45, 4]].map(([id, expected]) => { const cases = report.cases.filter(c => c.id === id); return { id, expectedCases: expected, status: cases.length === expected && cases.every(c => c.status === 'PASS') ? 'PASS' : cases.some(c => c.status === 'FAIL') ? 'FAIL' : 'UNVERIFIED' }; });
  writeFileSync(out + '/results.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ head, criteria: report.criterionStatus, cases: report.cases.map(({ id, width, status }) => ({ id, width, status })), cleanup: report.cleanup }));
}
