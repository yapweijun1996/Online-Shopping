import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { issueAdminClaim } from '../src/platform/admin-claim.js';
import { createSetupRoutes } from '../src/platform/setup-routes.js';
import { createApi } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { serveStatic } from '../src/static.js';

const paths = ['/setup/', '/setup/setup.js', '/setup/setup.css', '/api/v1/setup/status'];
test('setup exact paths share eligibility and cannot bypass static gating', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  const config = { publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { claimEnabled: true, adminHost: 'admin.example.test' } };
  const handler = await createApi({ store, config, serveStatic, setupHandler: createSetupRoutes({ ...f, config }) });
  const get = (path, host = 'shop.example.test') => handler(new Request(`https://${host}${path}`));
  const missing = await (await get('/unknown')).text();
  const issue = () => issueAdminClaim(f.platform, config, new Date(Date.now() + 1).toISOString(), () => false);
  await issue();
  for (const path of paths) {
    const response = await get(path); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    if (path.startsWith('/setup/')) assert.match(response.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
  }
  for (const path of ['/setup', '/setup/index.html', '/setup/setup.js?x=1', '/%73etup/setup.js', '/setup/extra']) assert.equal(await (await get(path)).text(), missing);
  for (const host of ['seller.example.test', 'admin.example.test']) for (const path of paths) assert.equal(await (await get(path, host)).text(), missing);
  const closed = async () => {
    for (const path of paths) {
      const response = await get(path); assert.equal(response.status, 404); assert.equal(await response.text(), missing);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    }
  };
  config.platform.claimEnabled = false; await closed(); config.platform.claimEnabled = true;
  await f.platform.run("UPDATE platform_admin_claim SET issued_at='2000-01-01T00:00:00.000Z', expires_at='2000-01-01T00:30:00.000Z'"); await closed();
  await issue(); await f.platform.run("UPDATE platform_admin_claim SET closed_at=issued_at, token_hash=NULL"); await closed();
  await f.platform.run("INSERT INTO platform_admin(id,username,username_key,password_hash,created_at,updated_at) VALUES ('owner','owner','owner','unused','now','now')"); await closed();
  for (const path of ['/setup/', '/setup/setup.js', '/%73etup/setup.css']) await assert.rejects(serveStatic(new Request('https://shop.example.test' + path), path), { status: 404 });
});

test('setup loader clears fragment before requests, submits once, hides secrets and follows configured console', async () => {
  const source = await readFile(new URL('../public/setup/setup.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/setup/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|innerHTML/);
  assert.doesNotMatch(html, /<style\b|\sstyle=|<script(?![^>]*\bsrc=)/);
  const run = async ({ open = true, ok = true } = {}) => {
    const events = [], nodes = Object.fromEntries(['status', 'error', 'continue'].map((name) => [name, { hidden: true, focus() { events.push('focus:' + name); } }]));
    const button = {}, elements = Object.fromEntries(['email', 'username', 'password', 'confirm'].map((name) => [name, { value: name === 'confirm' ? 'password' : name, focus() {} }]));
    let submit, resolveClaim;
    const form = { elements, hidden: true, querySelector: () => button, addEventListener: (_, fn) => { submit = fn; }, reportValidity: () => true, setAttribute() {}, removeAttribute() {}, reset() { for (const field of Object.values(elements)) field.value = ''; } };
    const requests = [], location = { hash: '#' + 'A'.repeat(43), pathname: '/setup/', search: '', replace(url) { events.push(url); } };
    const context = vm.createContext({ URL, location, history: { replaceState() { events.push('clear'); location.hash = ''; } }, document: { querySelector: (selector) => selector === '#claim' ? form : nodes[selector.slice(1)] }, fetch: async (path, options) => {
      events.push(path); requests.push({ path, options });
      if (path.endsWith('/status')) return { ok: open, json: async () => ({ open }) };
      return new Promise((resolve) => { resolveClaim = () => resolve({ ok, json: async () => ({ nextUrl: 'https://configured.example.test/platform/' }) }); });
    } });
    await vm.runInContext(`(async () => { ${source}\n})()`, context);
    assert.equal(events[0], 'clear'); assert.equal(location.hash, '');
    if (!open) { assert.equal(form.hidden, true); assert.equal(nodes.status.textContent, 'This page is not available'); return; }
    assert.equal(form.hidden, false);
    const pending = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
    assert.equal(button.disabled, true); assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[1].options.body), { code: 'A'.repeat(43), email: 'email', username: 'username', password: 'password' });
    resolveClaim(); await pending; assert.equal(button.disabled, false);
    if (ok) { assert.equal(form.hidden, true); assert.equal(elements.password.value, ''); assert.equal(events.at(-1), 'https://configured.example.test/platform/'); }
    else { assert.equal(nodes.error.hidden, false); assert.equal(events.at(-1), 'focus:error'); }
  };
  await run(); await run({ open: false }); await run({ ok: false });
});
