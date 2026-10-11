import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startCaddyFixture } from './qa-caddy-fixture.mjs';

const fixture = await startCaddyFixture('matrix');
const checks = [];
try {
  async function check(host, path, status, options = {}, validate) {
    const result = await fixture.request(`${host}.gmb01.xyz`, path, options);
    assert.equal(result.status, status, `${host} ${path}: ${result.text.slice(0, 120)}`);
    if (validate) validate(result);
    checks.push({ host, path, status });
  }
  const target = (path, method = 'GET', body = '') => (r) => {
    const echoed = JSON.parse(r.text); assert.equal(echoed.path, path.split('?')[0]);
    assert.equal(echoed.query, path.includes('?') ? '?' + path.split('?')[1] : '');
    assert.equal(echoed.method, method); assert.equal(echoed.body, body);
  };
  const redirect = (path) => (r) => assert.equal(r.headers.location, path);
  for (const host of ['shop', 'seller']) {
    const surface = host;
    await check(host, '/', 302, {}, redirect(`/${surface}/`));
    await check(host, `/${surface}/`, 200, {}, (r) => assert.match(r.text, /<!doctype html>/i));
    for (const path of ['/health', '/ready', '/api/v1/shop', `/${surface}/manifest.webmanifest`]) await check(host, path, 200);
    for (const path of ['/platform/', '/platform/app.js', '/api/v1/platform/session', '/demo/', '/api/v1/demo/session']) await check(host, path, 404);
    await check(host, '/alpha/', 302, {}, redirect(`/alpha/${surface}/`));
    await check(host, `/alpha/${surface}/`, 200, {}, (r) => assert.match(r.text, /<!doctype html>/i));
    for (const asset of [`/alpha/${surface}/app.js`, '/alpha/shared/base-path.js']) await check(host, asset, 200);
    const api = '/alpha/api/v1/shop?q=synthetic';
    await check(host, api, 200, {}, target(api));
    await check(host, '/alpha/api/v1/fixture?x=1', 200, { method: 'POST', body: '{"fictional":true}', headers: { 'Content-Type': 'application/json' } }, target('/alpha/api/v1/fixture?x=1', 'POST', '{"fictional":true}'));
    await check(host, `/alpha/${surface}/manifest.webmanifest`, 200, {}, target(`/alpha/${surface}/manifest.webmanifest`));
    for (const code of ['unknown', 'provisioning', 'failed']) await check(host, `/${code}/${surface}/`, 404);
    for (const code of ['suspended', 'deleting']) await check(host, `/${code}/${surface}/`, 503);
    await check(host, `/oldalpha/${surface}/?x=1`, 308, {}, redirect(`/alpha/${surface}/?x=1`));
    for (const path of ['/ABCD/shop/', '/ab/shop/', '/' + 'a'.repeat(31) + '/shop/', '/alpha./shop/', '/%61lpha/shop/', '/alpha%2fshop/', '/%2e%2e/shop/', '//alpha/shop/', '/admin/shop/', '/platform/shop/']) await check(host, path, 404);
    for (const path of ['/alpha/platform/', '/alpha/api/v1/platform/session', '/alpha/demo/', '/alpha/api/v1/demo/session']) await check(host, path, 404);
  }
  for (const path of ['/seller/', '/api/v1/seller/session', '/alpha/seller/', '/alpha/api/v1/seller/session']) await check('shop', path, 404);
  for (const path of ['/shop/', '/api/v1/orders', '/p/id', '/s/home', '/alpha/shop/', '/alpha/api/v1/orders', '/alpha/p/id', '/alpha/s/home']) await check('seller', path, 404);
  await check('seller', '/alpha/shop/tokens.css', 200);
  await check('shop', '/alpha/p/id?enter=1', 200, {}, target('/alpha/p/id?enter=1'));
  await check('shop', '/alpha/s/home', 200, {}, target('/alpha/s/home'));
  await check('shop', '/p/id', 200, {}, target('/p/id'));
  for (const path of ['/', '/shop/', '/alpha/', '/alpha/shop/']) await check('shop', path, 200, { headers: { 'User-Agent': 'WhatsApp' } }, target(path.startsWith('/alpha') ? '/alpha/s/home' : '/s/home'));
  await check('admin', '/', 302, {}, redirect('/platform/'));
  for (const path of ['/platform/', '/platform/app.js', '/platform/style.css', '/api/v1/platform/session', '/health', '/ready']) await check('admin', path, 200);
  for (const path of ['/shop/', '/seller/', '/shared/base.css', '/api/v1/shop', '/alpha/shop/']) await check('admin', path, 404);
  await mkdir('output/qa/multi-tenant', { recursive: true });
  await writeFile('output/qa/multi-tenant/r2-caddy-routing.json', JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(`Real Caddy routing: ${checks.length} checks passed.`);
} finally { await fixture.close(); }
