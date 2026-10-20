import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { docker } from './qa-caddy-fixture.mjs';

const command = promisify(execFile);
const image = 'caddy:2.10.2-alpine';
const tag = `qa-gcp-${randomBytes(5).toString('hex')}`;
const scratch = await mkdtemp(join(tmpdir(), tag));
const names = [tag + '-frontend', tag + '-backend'];
const listener = createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const results = [];
async function request(host, path, { method = 'GET', headers = {} } = {}) {
  const { stdout } = await command('curl', ['-sS', '--noproxy', '*', '--path-as-is', '--max-time', '10', '-X', method,
    '-H', `Host: ${host}.qa.test`, ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
    '-D', '-', `http://127.0.0.1:${port}${path}`]);
  const split = stdout.indexOf('\r\n\r\n');
  const head = stdout.slice(0, split).split('\r\n');
  return { status: Number(head[0].split(' ')[1]), headers: Object.fromEntries(head.slice(1).map(line => {
    const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
  })), text: stdout.slice(split + 4) };
}
async function group(name, run) {
  try { const count = await run(); results.push({ name, status: 'PASS', detail: `${count} checks` }); }
  catch (error) { results.push({ name, status: 'FAIL', detail: error.message }); process.exitCode = 1; }
}
let count = 0;
async function check(host, path, status, options = {}, validate = () => {}) {
  const result = await request(host, path, options);
  assert.equal(result.status, status, `${host} ${path}: ${result.text.slice(0, 100)}`);
  validate(result); count++;
}
const redirect = location => r => assert.equal(r.headers.location, location);
const echo = (host, path, method = 'GET', ip = '') => r => {
  const value = JSON.parse(r.text), [pathname, query = ''] = path.split('?');
  assert.deepEqual(value, { method, path: pathname, query, host: `${host}.qa.test`, ip });
};
async function measured(run) { const before = count; await run(); return count - before; }
try {
  await cp(resolve('public'), join(scratch, 'public'), { recursive: true });
  await writeFile(join(scratch, 'backend.Caddyfile'), `{
 admin off
 auto_https off
}
:3000 {
 route {
  @gate path /alpha/api/v1/tenant-access
  respond @gate "" 200
  header Content-Type application/json
  respond \`{"method":"{http.request.method}","path":"{http.request.uri.path}","query":"{http.request.uri.query}","host":"{http.request.host}","ip":"{http.request.header.X-Real-IP}"}\` 200
 }
}
`);
  await docker(['network', 'create', tag]);
  await docker(['run', '-d', '--pull=never', '--name', names[1], '--network', tag, '--network-alias', 'backend',
    '-v', `${join(scratch, 'backend.Caddyfile')}:/etc/caddy/Caddyfile:ro`, image]);
  await docker(['run', '-d', '--pull=never', '--name', names[0], '--network', tag, '-p', `127.0.0.1:${port}:80`,
    '-e', 'SHOP_HOST=shop.qa.test', '-e', 'SELLER_HOST=seller.qa.test',
    '-v', `${resolve('deploy/gcp/Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${join(scratch, 'public')}:/srv/public:ro`, image]);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await request('shop', '/health')).status === 200) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) {
    for (const name of names) { const logs = await docker(['logs', name]); console.error(logs.stdout + logs.stderr); }
    throw new Error('Real Caddy did not become ready');
  }
  await group('Shop static / isolation', () => measured(async () => {
    await check('shop', '/', 302, {}, redirect('/shop/'));
    await check('shop', '/shop/', 200);
    const file = (await readdir('public/demo-assets/DEMO-001')).find(name => name.endsWith('.jpg'));
    assert.ok(file, 'Existing demo JPEG required');
    await check('shop', `/demo-assets/DEMO-001/${file}`, 200);
    for (const path of ['/seller/', '/platform/', '/api/v1/platform/x', '/api/v1/seller/session', '/demo', '/demo/x', '/api/v1/demo/x']) await check('shop', path, 404);
  }));
  await group('Setup host / method / query', () => measured(async () => {
    for (const [path, method] of [['/setup/', 'GET'], ['/api/v1/setup/status', 'GET'], ['/api/v1/setup/claim', 'POST']]) {
      await check('shop', path, 200, { method }, echo('shop', path, method));
      await check('seller', path, 404, { method });
    }
  }));
  await group('Seller static / isolation', () => measured(async () => {
    for (const path of ['/seller/', '/platform/']) await check('seller', path, 200);
    await check('seller', '/api/v1/platform/session', 200, {}, echo('seller', '/api/v1/platform/session'));
    for (const path of ['/shop/', '/p/00000000-0000-4000-8000-000000000000', '/api/v1/orders', '/s/home', '/demo-assets', '/demo-assets/DEMO-001/x']) await check('seller', path, 404);
  }));
  await group('Unknown host / raw path guards', () => measured(async () => {
    await check('unknown', '/', 404);
    for (const host of ['shop', 'seller']) for (const path of ['/%2e%2e/shop/', '/alpha%2Fshop/', '//alpha/shop/', '/alpha\\shop/']) await check(host, path, 404);
  }));
  await group('Tenant prefix / webhooks / IP', () => measured(async () => {
    for (const host of ['shop', 'seller']) {
      await check(host, '/alpha/', 302, {}, redirect(`/alpha/${host}/`));
      await check(host, `/alpha/${host}/`, 200);
      const path = '/alpha/api/v1/fixture?x=1';
      await check(host, path, 200, { method: 'POST', headers: { 'X-Real-IP': '192.0.2.42', 'X-Forwarded-For': '198.51.100.9', 'CF-Connecting-IP': '203.0.113.9' } }, echo(host, path, 'POST', '192.0.2.42'));
      for (const prefix of ['', '/alpha']) for (const method of ['GET', 'POST']) {
        const webhook = `${prefix}/api/v1/webhooks/whatsapp?hub.challenge=fictional`;
        await check(host, webhook, 200, { method }, echo(host, webhook, method));
      }
    }
  }));
  await group('All crawler host boundaries', () => measured(async () => {
    for (const agent of ['facebookexternalhit', 'facebot', 'whatsapp', 'twitterbot', 'telegrambot', 'slackbot', 'discordbot', 'googlebot', 'bingbot']) {
      const options = { headers: { 'User-Agent': agent } };
      for (const path of ['/', '/shop/', '/alpha/', '/alpha/shop/']) await check('shop', path, 200, options, echo('shop', path.startsWith('/alpha') ? '/alpha/s/home' : '/s/home'));
      for (const prefix of ['', '/alpha']) await check('seller', `${prefix}/`, 302, options, redirect(`${prefix}/seller/`));
    }
  }));
} catch (error) { results.push({ name: 'Fixture startup', status: 'FAIL', detail: error.message }); process.exitCode = 1; }
finally {
  for (const name of names) await docker(['rm', '-f', name]).catch(() => {});
  await docker(['network', 'rm', tag]).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
console.log('Real GCP Caddy: caddy:2.10.2-alpine (orbstack)');
for (const row of results) console.log(`${row.status.padEnd(4)} | ${row.name} | ${row.detail}`);
console.log(`${count} assertions passed; ${results.filter(r => r.status === 'FAIL').length} groups failed.`);
