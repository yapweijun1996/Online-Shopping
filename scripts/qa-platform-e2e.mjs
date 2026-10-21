import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { totpCode } from '../src/platform/totp.js';

const rows = [], suffix = randomBytes(6).toString('hex'), prefix = `qa_pe_${suffix}`;
const secret = () => randomBytes(24).toString('hex');
const quote = (name) => { if (!/^[a-z0-9_]+$/.test(name)) throw Error('Unsafe identifier'); return `"${name}"`; };
const base = new URL(process.env.SHOP_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/online_shopping_test');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw Error('Loopback PostgreSQL required');
const root = new URL('../', import.meta.url), databases = [], roles = [];
let child, directory, admin, platformName, failure = false, current = 'infrastructure';
const check = (ok) => { if (!ok) throw Error('Behavior assertion failed'); };
async function main() {
  admin = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 5000 }); await admin.connect();
  directory = await mkdtemp(new URL('../.qa-platform-', import.meta.url).pathname);
  const file = async (name, value) => { const path = `${directory}/${name}`; await writeFile(path, value + '\n', { mode: 0o600 }); return path; };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', SHOP_MODE: 'manual', PLATFORM_ENABLED: '1', PLATFORM_ADMIN_CLAIM_ENABLED: '1', ADMIN_USERNAME: 'rootowner' };
  for (const [kind, flags] of [['shop', 'NOCREATEDB NOCREATEROLE'], ['app', 'NOCREATEDB NOCREATEROLE'], ['provisioner', 'CREATEDB CREATEROLE']]) {
    const role = `${prefix}_${kind}`, password = secret();
    await admin.query(`CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER ${flags} NOREPLICATION PASSWORD '${password}'`); roles.push(role);
    if (kind === 'provisioner') await admin.query(`ALTER ROLE ${quote(role)} SET createrole_self_grant = 'set, inherit'`);
    else { const name = `${prefix}_${kind}`; await admin.query(`CREATE DATABASE ${quote(name)} OWNER ${quote(role)}`); databases.push(name); await admin.query(`REVOKE ALL ON DATABASE ${quote(name)} FROM PUBLIC`); }
    const stem = kind === 'shop' ? 'DATABASE' : kind === 'app' ? 'PLATFORM_DATABASE' : 'PLATFORM_PROVISIONER';
    env[`${stem}_USER`] = role; env[`${stem}_PASSWORD_FILE`] = await file(kind, password);
    if (kind !== 'provisioner') { env[`${stem}_NAME`] = role; env[`${stem}_HOST`] = base.hostname; env[`${stem}_PORT`] = base.port || '5432'; }
    if (kind === 'app') platformName = role;
  }
  env.ADMIN_PASSWORD_FILE = await file('owner', env.ownerPassword = secret());
  const ownerPassword = env.ownerPassword; delete env.ownerPassword;
  env.INTEGRATION_KEY_FILE = await file('keys', `primary=${randomBytes(32).toString('base64')}`);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  env.PORT = String(port); env.PUBLIC_ORIGIN = env.SELLER_ORIGIN = `http://127.0.0.1:${port}`; env.PLATFORM_ADMIN_HOST = `localhost:${port}`;
  let claim, emissions = 0, pending = '';
  child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (text) => { pending += text; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) { try { const event = JSON.parse(line); if (event.event === 'platform.claim.issued') { emissions++; claim = new URL(event.url).hash.slice(1); } } catch {} } });
  child.stderr.resume();
  const client = (host, origin, prefixPath = '') => {
    const cookies = new Map(); let csrf;
    return async (label, path, method = 'GET', body, expected = 200, extra = {}) => {
      current = label; const payload = body === undefined ? undefined : JSON.stringify(body), target = prefixPath + path;
      const result = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: target, method, headers: { host, origin, cookie: [...cookies].filter(([, c]) => target.startsWith(c.path)).map(([k, c]) => `${k}=${c.value}`).join('; '), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(payload ? { 'content-type': 'application/json' } : {}), ...extra } }, (res) => {
          let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; if (text.length > 2_000_000) req.destroy(); }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        }); req.setTimeout(60000, () => req.destroy()); req.on('error', reject); req.end(payload);
      });
      rows.push([label, result.status === expected ? 'PASS' : 'FAIL', `${result.status} (expected ${expected})`]); check(result.status === expected);
      for (const header of result.headers['set-cookie'] || []) { const [pair, ...attrs] = header.split(';'); const n = pair.indexOf('='); cookies.set(pair.slice(0, n), { value: pair.slice(n + 1), path: attrs.map(x => x.trim()).find(x => /^path=/i.test(x))?.slice(5) || '/' }); }
      let value; try { value = JSON.parse(result.text); } catch { value = result.text; }
      if (value.csrfToken) csrf = value.csrfToken;
      return value;
    };
  };
  for (let i = 0; !claim && i < 300; i++) { if (child.exitCode !== null) throw Error('Server exited'); await new Promise(r => setTimeout(r, 100)); }
  check(claim && emissions === 1); rows.push(['single startup claim emission', 'PASS', '1']);
  const shop = client(`127.0.0.1:${port}`, env.PUBLIC_ORIGIN), consoleApi = client(env.PLATFORM_ADMIN_HOST, `https://${env.PLATFORM_ADMIN_HOST}`);
  await shop('setup page open', '/setup/'); check((await shop('setup status open', '/api/v1/setup/status')).open);
  const password = secret(), credentials = { code: claim, email: 'owner@example.test', username: 'qaowner', password };
  check((await shop('claim restricted session', '/api/v1/setup/claim', 'POST', credentials)).stage === 'PASSWORD');
  await shop('setup page closed', '/setup/', 'GET', undefined, 404); await shop('setup status closed', '/api/v1/setup/status', 'GET', undefined, 404); await shop('second claim refused', '/api/v1/setup/claim', 'POST', credentials, 404);
  await consoleApi('console login challenge', '/api/v1/platform/csrf');
  check((await consoleApi('console password login', '/api/v1/platform/session', 'POST', { username: credentials.username, password })).stage === 'PASSWORD');
  await consoleApi('restricted shops denied', '/api/v1/platform/shops', 'GET', undefined, 403);
  const enrol = await consoleApi('TOTP enrol', '/api/v1/platform/totp/enrol', 'POST', {});
  const full = await consoleApi('TOTP confirmation', '/api/v1/platform/totp/confirm', 'POST', { code: totpCode(enrol.setupKey, Math.floor(Date.now() / 30000)) });
  check(full.stage === 'FULL' && full.recoveryCodes.length === 10 && new Set(full.recoveryCodes).size === 10);
  const initial = await consoleApi('list shops', '/api/v1/platform/shops'); check(initial.items.length === 1 && initial.items[0].isDefault);
  const code = `qa${suffix}`;
  const created = await consoleApi('create tenant', '/api/v1/platform/shops', 'POST', { code, name: 'QA fictional shop', currency: 'MYR', sellerUsername: 'tenantowner' }, 201);
  check(created.tenant.status === 'ACTIVE' && typeof created.sellerPassword === 'string');
  const tenant = client(`127.0.0.1:${port}`, env.PUBLIC_ORIGIN, `/${code}`);
  const sellerPath = '/api/v1/seller';
  await tenant('tenant temporary login', `${sellerPath}/session`, 'POST', { username: 'tenantowner', password: created.sellerPassword });
  await tenant('temporary catalog denied', `${sellerPath}/products`, 'GET', undefined, 403);
  const replacement = secret(); await tenant('change temporary password', `${sellerPath}/account/password`, 'POST', { currentPassword: created.sellerPassword, newPassword: replacement });
  await shop('default seller login', `${sellerPath}/session`, 'POST', { username: env.ADMIN_USERNAME, password: ownerPassword });
  await shop('default shop setup', `${sellerPath}/setup`, 'POST', { mode: 'production', shopName: 'QA default' });
  async function populate(call, name) {
    await call(`${name} category`, `${sellerPath}/categories`, 'POST', { code: 'QA', label: 'QA goods' }, 201);
    const product = await call(`${name} product`, `${sellerPath}/products`, 'POST', { sku: name, name: `${name} item`, description: 'Fictional fixture', category: 'QA', priceMinor: 900, currency: 'MYR', active: true }, 201);
    const receipt = await call(`${name} guest order`, '/api/v1/orders', 'POST', { buyer: { fullName: 'Example Buyer', whatsappPhone: '', email: 'buyer@example.test' }, whatsappOrderContactOptIn: false, locale: 'en', deliveries: [{ recipient: { fullName: 'Example Recipient', phone: '+60123456789' }, address: { line1: 'Example Street 1', postcode: '47810', country: 'MY' }, items: [{ productId: product.id, quantity: 1, expectedPriceMinor: 900, expectedCurrency: 'MYR' }] }] }, 201, { 'idempotency-key': `qa-${name}-${suffix}` });
    check(receipt.totalMinor === 900); return product;
  }
  const tp = await populate(tenant, 'tenant'), dp = await populate(shop, 'default');
  for (const [call, own, foreign, name] of [[tenant, tp, dp, 'tenant'], [shop, dp, tp, 'default']]) {
    const products = await call(`${name} isolated catalog`, `${sellerPath}/products`); check(products.items.some(p => p.id === own.id) && !products.items.some(p => p.id === foreign.id));
    await call(`${name} foreign product absent`, `/api/v1/products/${foreign.id}`, 'GET', undefined, 404);
    const orders = await call(`${name} isolated seller orders`, `${sellerPath}/orders`); check(orders.items.length === 1);
    const detail = await call(`${name} own order detail`, `${sellerPath}/orders/${orders.items[0].id}`); check(JSON.stringify(detail).includes(own.id) && !JSON.stringify(detail).includes(foreign.id));
  }
  const id = created.tenant.id;
  for (const [action, status] of [['suspend', 503], ['resume', 200]]) {
    const detail = await consoleApi(`${action} revision`, `/api/v1/platform/shops/${id}`);
    await consoleApi(action, `/api/v1/platform/shops/${id}/${action}`, 'POST', { expectedRevision: detail.revision });
    await tenant(`${action} tenant availability`, '/api/v1/products', 'GET', undefined, status);
  }
  const detail = await consoleApi('reset revision', `/api/v1/platform/shops/${id}`);
  const reset = await consoleApi('reset seller password', `/api/v1/platform/shops/${id}/reset-seller-password`, 'POST', { expectedRevision: detail.revision });
  check(typeof reset.sellerPassword === 'string' && reset.sellerPassword !== replacement);
  await tenant('reset invalidates session', `${sellerPath}/orders`, 'GET', undefined, 401);
  await tenant('old password denied', `${sellerPath}/session`, 'POST', { username: 'tenantowner', password: replacement }, 401);
  await tenant('reset password login', `${sellerPath}/session`, 'POST', { username: 'tenantowner', password: reset.sellerPassword });
  await tenant('reset forces password change', `${sellerPath}/orders`, 'GET', undefined, 403);
  await tenant('replace reset password', `${sellerPath}/account/password`, 'POST', { currentPassword: reset.sellerPassword, newPassword: secret() });
  await tenant('seller restored', `${sellerPath}/orders`); check(emissions === 1);
}
try { await main(); } catch { failure = true; rows.push([current, 'FAIL', 'redacted failure']); }
finally {
  current = 'cleanup';
  try {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); await exited; clearTimeout(timer); }
    if (admin) {
      if (platformName && databases.includes(platformName)) {
        const url = new URL(base); url.pathname = '/' + platformName;
        const client = new pg.Client({ connectionString: url.href }); await client.connect();
        try { const result = await client.query('SELECT database_name, database_role FROM tenant WHERE is_default = 0'); for (const row of result.rows) { if (!/^t_qa[0-9a-f]{12}_[0-9a-f]{8}$/.test(row.database_name) || !row.database_name.startsWith(`t_qa${suffix}_`)) throw Error('Cleanup scope'); databases.push(row.database_name); roles.push(row.database_role); } } catch (error) { if (error.code !== '42P01') throw error; } finally { await client.end(); }
      }
      for (const name of databases.reverse()) await admin.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`);
      for (const role of roles.reverse()) await admin.query(`DROP ROLE ${quote(role)}`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    rows.push(['cleanup', 'PASS', 'databases, roles, secrets, child removed']);
  } catch { failure = true; rows.push(['cleanup', 'FAIL', 'manual inspection required']); }
}
console.log('CHECK | RESULT | HTTP / EVIDENCE');
for (const row of rows) console.log(row.join(' | '));
process.exitCode = failure ? 1 : 0;
