import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, lstat, realpath, readFile, access } from 'node:fs/promises';
import path from 'node:path';
const publicRoot = path.resolve('public');
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
test('platform QR policy controls preserve revision and CSRF and display authorization failures', { skip: !browserModule }, async t => {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    const file = path.join(publicRoot, new URL(request.url, 'http://local').pathname);
    try {
      const data = await readFile(file);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shop = { id: '12345678-1234-4234-8234-123456789abc', code: 'alpha', name: 'Synthetic shop', currency: 'MYR', status: 'ACTIVE', revision: 7, isDefault: false };
  let policy = { provisioned: true, tenantSlots: 1, occupiedTenantSlots: 0, binding: null }, failure = null;
  const writes = [];
  await page.route('**/api/v1/platform/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let body = url.pathname.endsWith('/session') ? { stage: 'FULL', csrfToken: 'synthetic-csrf', username: 'admin' } : url.pathname.endsWith('/shops') ? { items: [shop] } : url.pathname.endsWith('/qr') ? policy : shop;
    if (request.method() === 'POST') {
      writes.push({ body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'], origin: request.headers().origin, path: url.pathname });
      if (failure) return route.fulfill({ status: failure.status, json: { error: { code: failure.code, message: failure.code } } });
      policy = { ...policy, occupiedTenantSlots: 1, binding: { enabled: true, slot_id: 1, cleanup_pending: false } }; body = { revision: 8 }; shop.revision = 8;
    }
    await route.fulfill({ json: body });
  });
  await page.goto(`${origin}/platform/index.html`);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  for (const code of ['MFA_REQUIRED', 'CSRF_INVALID', 'STALE_REVISION']) {
    failure = { status: code === 'STALE_REVISION' ? 409 : 403, code };
    await page.getByRole('button', { name: 'Enable QR', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enable QR', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: code }).waitFor();
    assert.deepEqual(writes.at(-1).body, { expectedRevision: 7 }); assert.equal(writes.at(-1).csrf, 'synthetic-csrf');
    assert.equal(writes.at(-1).origin, origin);
  }
  failure = null;
  await page.getByRole('button', { name: 'Enable QR', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Enable QR', exact: true }).click();
  await page.getByRole('button', { name: 'Disable QR', exact: true }).waitFor();
  assert.match(await page.locator('#content').innerText(), /Tenant slots reserved: 1 \/ 1/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  shop.isDefault = true; await page.reload(); await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Disable QR', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Suspend shop', exact: true }).count(), 0);
  shop.isDefault = false;
  shop.qrStatus = { state: 'ERROR', heartbeatAt: '2026-10-21T00:00:00.000Z', hasError: true };
  for (const next of [
    { provisioned: false, tenantSlots: 1, occupiedTenantSlots: 0, binding: null },
    { provisioned: true, tenantSlots: 1, occupiedTenantSlots: 1, binding: { enabled: false, slot_id: 1, cleanup_pending: true } }
  ]) {
    policy = next; await page.reload(); await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const enable = page.getByRole('button', { name: 'Enable QR', exact: true }); await enable.waitFor();
    assert.equal(await enable.isDisabled(), true);
    assert.match(await page.locator('#content').innerText(), next.provisioned ? /Cleanup: Pending/ : /Worker not provisioned/);
    assert.match(await page.locator('#content').innerText(), /Worker state \(last reported\): ERROR/);
    assert.match(await page.locator('#content').innerText(), /Worker error: Reported/);
  }
});
test('platform symlinks and relative stylesheet assets resolve inside public', async () => {
  const visited = new Set();
  async function asset(file) {
    file = path.resolve(file);
    assert.ok(file.startsWith(publicRoot + path.sep), file);
    await access(file);
    const actual = await realpath(file);
    assert.ok(actual.startsWith(publicRoot + path.sep), actual);
    if (visited.has(file) || !/\.(css|html|js)$/.test(file)) return;
    visited.add(file);
    const text = await readFile(file, 'utf8');
    const references = file.endsWith('.css') ? [...text.matchAll(/(?:url\(\s*['"]?)([^'"\s)]+)/g)].map(m => m[1]) : file.endsWith('.html') ? [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]) : [...text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)].map(m => m[1]);
    for (const ref of references) {
      if (/^(?:https?:|data:|#)/.test(ref) || ref === './') continue;
      await asset(ref.startsWith('/') ? path.join(publicRoot, ref) : path.resolve(path.dirname(file), ref.split(/[?#]/)[0]));
    }
  }
  async function walk(dir) {
    for (const entry of await readdir(dir)) {
      const file = path.join(dir, entry), stat = await lstat(file);
      if (stat.isDirectory()) await walk(file);
      else await asset(file);
    }
  }
  await walk(path.join(publicRoot, 'platform'));
});
