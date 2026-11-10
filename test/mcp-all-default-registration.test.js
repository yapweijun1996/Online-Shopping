import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue } from '../src/mcp/tools.js';
import { V2_SCOPES } from '../src/mcp/credentials.js';
import { OPERATION_SCOPE_POLICIES, operationAuthorityPolicy } from '../src/mcp/operation-policy.js';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';

const run = promisify(execFile);
// The production constructor checks actual Linux UID/socket ownership. This
// fixture is unavailable on other hosts; it never substitutes a permission check.
const socketFixtureAvailable = process.platform === 'linux' && process.getuid() === 1000 && process.getgid() === 1000 &&
  spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
const legacyNames = ['catalog.list', 'catalog.get', 'catalog.categories', 'catalog.history', 'catalog.low_stock',
  'orders.list', 'orders.get', 'analytics.summary'];
const extensionNames = ['company.get', 'company.preview_update', 'company.commit_update',
  'catalog.preview_create', 'catalog.commit_create', 'catalog.preview_update', 'catalog.commit_update',
  'analytics.sales_trend', 'analytics.top_products', 'analytics.inventory_risk',
  'inventory.summary', 'inventory.movements', 'inventory.preview_adjustment', 'inventory.commit_adjustment',
  'orders.preview_decision', 'orders.commit_decision', 'operations.get', 'operations.cancel', 'operations.audit',
  'media.list', 'media.prepare_upload', 'media.commit_upload', 'media.upload_file', 'media.preview_layout', 'media.commit_layout'];
const allNames = [...legacyNames, ...extensionNames];
const legacy = catalogue.map(({ scope: _scope, ...tool }) => tool);
const allScopes = [...legacyCatalogScopes.split(' '), ...V2_SCOPES];
const id = '00000000-0000-4000-8000-000000000001';

async function defaultFixture(t, dialect) {
  const dir = await mkdtemp(join(tmpdir(), 'shopping-default-registry-'));
  const socketDir = join(dir, 'socket'), socketPath = join(socketDir, 'codec.sock'), tokenFile = join(dir, 'token');
  const server = createServer(socket => { connections++; socket.destroy(); });
  let connections = 0;
  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(connections, 0, 'Registration and authorization must not contact a codec.');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  await chmod(dir, 0o700);
  await mkdir(socketDir, { mode: 0o710 });
  await writeFile(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o640 });
  await chmod(tokenFile, 0o640);
  server.listen(socketPath); await once(server, 'listening');
  await chmod(socketPath, 0o660);
  // Only this test-owned socket changes owner. There is no decoder, native
  // attestation, Docker worker or permission/authentication injection.
  await run('sudo', ['-n', 'chown', '10001:1000', '--', socketPath]);
  return reviewFixture(t, dialect, {
    // The helper omits the createApi operationTools property for undefined:
    // every descriptor comes from the actual default constructor.
    operationTools: undefined,
    config: { mcpRedirectUris: ['https://client.example.com/catalog-callback'],
      mcpMedia: { enabled: true, socketPath, tokenFile, codecDigest: 'd'.repeat(64) } },
  });
}

async function listed(client) {
  const result = await client.rpc('tools/list', {});
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.ok(result.data.result?.tools, JSON.stringify(result.data));
  return result.data.result.tools;
}

async function contractUnion() {
  const files = ['COMPANY', 'CATALOG-SAFE', 'ANALYTICS', 'INVENTORY', 'ORDERS', 'OPERATIONS', 'MEDIA'];
  const bundles = await Promise.all(files.map(name => readFile(new URL(`../docs/mcp-v2/03-${name}-IMPLEMENTED.json`, import.meta.url), 'utf8').then(JSON.parse)));
  const union = new Map();
  for (const bundle of bundles) {
    const tools = bundle.tools ?? Object.keys(bundle['x-toolPolicies']).map(name => ({ name,
      inputSchema: bundle.$defs[name + '.input'], outputSchema: bundle.$defs[name + '.output'] }));
    for (const tool of tools) {
      assert.equal(union.has(tool.name), false, 'Duplicate contract: ' + tool.name);
      union.set(tool.name, tool);
    }
  }
  assert.deepEqual([...union.keys()].sort(), [...extensionNames].sort());
  return union;
}

// Current safe catalog descriptors have no media marker. Reserved dual-scope
// catalog-media policy is not activated or claimed as covered by this test.
function requiredScopes(name) {
  if (name.startsWith('operations.')) return [OPERATION_SCOPE_POLICIES[name].scope];
  return operationAuthorityPolicy(name).requiredScopes;
}
function expectedNames(scopes) {
  const granted = new Set(scopes);
  return [...catalogue.filter(tool => granted.has(tool.scope)).map(tool => tool.name),
    ...extensionNames.filter(name => requiredScopes(name).every(scope => granted.has(scope)))];
}
async function noBusinessEffects(f) {
  for (const table of ['mcp_v2_operation', 'mcp_v2_media_stage', 'product', 'product_event', 'inventory_movement']) {
    assert.equal(Number((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n), 0, table);
  }
}

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: !socketFixtureAvailable ? 'Requires the real Linux UID1000/private-socket ownership harness.' :
    dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL ? 'Disposable PostgreSQL not configured.' : false };

  test(`${dialect}: fresh full consent exposes the actual default 33 and exact seven-contract schema union`, options, async t => {
    const f = await defaultFixture(t, dialect);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n), 0);
    assert.deepEqual(catalogue.map(tool => tool.name), legacyNames);
    const client = await freshCatalogAccess(f, allScopes.join(' ')), tools = await listed(client), contracts = await contractUnion();
    assert.equal(tools.length, 33);
    assert.deepEqual(tools.map(tool => tool.name), allNames);
    assert.deepEqual(tools.slice(0, 8), legacy);
    for (const tool of tools.slice(8)) {
      const contract = contracts.get(tool.name);
      assert.deepEqual(tool.inputSchema, contract.inputSchema, tool.name + ' input');
      assert.deepEqual(tool.outputSchema, contract.outputSchema, tool.name + ' output');
      assert.equal(Object.hasOwn(tool, 'scope'), false);
      assert.equal(Object.hasOwn(tool, 'requiredScopes'), false);
    }
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n), 1);
    const consents = await f.store.all('SELECT scope FROM mcp_v2_scope_consent ORDER BY scope');
    assert.deepEqual(consents.map(row => row.scope), [...V2_SCOPES].sort());
    await noBusinessEffects(f);
  });

  test(`${dialect}: every omitted required scope filters default names with independently consented credentials`, options, async t => {
    const f = await defaultFixture(t, dialect);
    for (const omitted of allScopes) {
      const scopes = allScopes.filter(scope => scope !== omitted);
      const client = await freshCatalogAccess(f, scopes.join(' '));
      const tools = await listed(client);
      assert.deepEqual(tools.map(tool => tool.name), expectedNames(scopes), 'Missing ' + omitted);
      for (const tool of tools.filter(tool => extensionNames.includes(tool.name))) {
        assert.ok(requiredScopes(tool.name).every(scope => scopes.includes(scope)), tool.name);
      }
    }
    await noBusinessEffects(f);
  });

  test(`${dialect}: legacy consent remains exactly eight and catalog-only consent cannot enter media or reserved catalog arguments`, options, async t => {
    const f = await defaultFixture(t, dialect), old = await freshCatalogAccess(f, legacyCatalogScopes);
    assert.deepEqual(await listed(old), legacy);
    for (const name of ['company.commit_update', 'catalog.commit_create', 'catalog.commit_update', 'inventory.commit_adjustment',
      'orders.commit_decision', 'operations.cancel', 'media.commit_upload', 'media.commit_layout']) {
      const denied = await old.call(name, { operationId: id });
      assert.equal(denied.response.status, 403, name + ' ' + JSON.stringify(denied.data));
      assert.equal(denied.data.error, 'insufficient_scope', name);
    }
    const catalog = await freshCatalogAccess(f, legacyCatalogScopes + ' catalog.write');
    assert.deepEqual((await listed(catalog)).map(tool => tool.name), [...legacyNames,
      'catalog.preview_create', 'catalog.commit_create', 'catalog.preview_update', 'catalog.commit_update']);
    assert.equal((await catalog.call('media.list', { productId: id })).response.status, 403);
    for (const changes of [{ imageDataUrl: 'data:image/png;base64,iQ==' }, { mediaPolicyId: 'catalog-media-v1' }]) {
      const denied = await catalog.call('catalog.preview_update', { input: { id, changes }, idempotencyKey: 'synthetic-default-closed-0001' });
      assert.equal(denied.response.status, 200);
      assert.equal(denied.data.error.code, -32602);
    }
    await noBusinessEffects(f);
  });
}
