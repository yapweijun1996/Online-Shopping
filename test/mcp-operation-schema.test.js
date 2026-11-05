import { setupShop } from '../src/shop-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { ensureAdmin } from '../src/auth.js';
import { hash, secret, SCOPES } from '../src/mcp/credentials.js';
import { verifyOperationAuthority } from '../src/mcp/operation-authorization.js';
import { OPERATION_SCOPES, OPERATION_SCOPE_POLICIES } from '../src/mcp/operation-policy.js';
import { catalogue } from '../src/mcp/tools.js';
import proposedContracts from '../docs/mcp-v2/03-TOOL-CONTRACTS.proposed.json' with { type: 'json' };

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) {
  throw new Error('Disposable PostgreSQL test database required.');
}
const start = '2026-11-04T00:00:00.000Z', end = '2026-11-04T00:10:00.000Z';
const digest = 'a'.repeat(64);

async function fixture(t, engine) {
  if (engine === 'sqlite') {
    const store = await openDatabase(':memory:');
    t.after(() => store.close());
    return store;
  }
  const pool = new pg.Pool({ connectionString: base });
  const name = `shopping_test_mcp_v2_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => {
    await store.close();
    await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await pool.end();
  });
  return store;
}

async function insertOperation(store, { id = randomUUID(), tenant = 'synthetic', account = 'account',
  client = 'client', idem = digest, scope = 'catalog.write', state = 'PREPARED',
  envelope = '{}', hash = digest } = {}) {
  await store.run(`INSERT INTO mcp_v2_operation
    (id, tenant_id, tenant_revision, account_id, client_id, grant_id, epoch_hash, build_digest, issuer, resource, tool_name, required_scope,
     required_capability, risk, resource_type, envelope_json, preview_hash, request_hash,
     idempotency_hash, state, created_at, expires_at, receipt_expires_at, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, tenant, 1, account, client, 'grant', digest, digest, 'https://seller.example.test', 'https://seller.example.test/mcp',
  'catalog.preview_update', scope, 'catalog.write', 'MEDIUM', 'product', envelope,
  hash, digest, idem, state, start, end, '2027-03-01T00:00:00.000Z', randomUUID());
  return id;
}

for (const engine of ['sqlite', 'postgres']) {
  test(`${engine}: durable operation tables enforce bounded integrity`, { skip: engine === 'postgres' && !base }, async (t) => {
    const store = await fixture(t, engine);
    const hasTable = async () => engine === 'sqlite'
      ? Boolean(await store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_v2_operation'"))
      : Boolean((await store.get("SELECT to_regclass('public.mcp_v2_operation') AS name")).name);
    // Schema30 creates durable storage without activating v2 tools.
    assert.equal(await hasTable(), true);
    await store.transaction(() => store.exec(operationSchema(engine)));
    assert.equal(await hasTable(), true);
    const id = await insertOperation(store);
    await store.transaction(() => store.exec(operationSchema(engine)));
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 1);
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n, 0);

    await assert.rejects(insertOperation(store, { idem: 'b'.repeat(64), state: 'APPROVED_BY_MODEL' }));
    await assert.rejects(insertOperation(store, { idem: 'b'.repeat(64), scope: 'catalog.read' }));
    await assert.rejects(insertOperation(store, { idem: 'b'.repeat(64), hash: 'z'.repeat(64) }));
    await assert.rejects(insertOperation(store, { idem: 'b'.repeat(64), envelope: '[]' }));
    await assert.rejects(insertOperation(store)); // same tenant/account/client/idempotency key
    await insertOperation(store, { account: 'other-account' }); // binding is part of uniqueness

    await assert.rejects(store.run('UPDATE mcp_v2_operation SET envelope_json = NULL WHERE id = ?', id));
    await assert.rejects(store.run('UPDATE mcp_v2_operation SET receipt_expires_at = expires_at WHERE id = ?', id));
    await assert.rejects(store.run('UPDATE mcp_v2_operation SET redacted_at = ?, envelope_json = NULL WHERE id = ?', end, id));
    const receipt = await insertOperation(store, { idem: 'e'.repeat(64), state: 'COMMITTED' });
    await assert.rejects(store.run('UPDATE mcp_v2_operation SET redacted_at = ?, envelope_json = NULL WHERE id = ?', start, receipt));
    await store.run('UPDATE mcp_v2_operation SET redacted_at = ?, envelope_json = NULL, result_json = ? WHERE id = ?', end, '{"receipt":"synthetic-safe-receipt"}', receipt);
    assert.equal((await store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id = ?', receipt)).envelope_json, null);
    await assert.rejects(store.run('UPDATE mcp_v2_operation SET redacted_at = NULL WHERE id = ?', receipt));

    const challenge = randomUUID();
    await store.run(`INSERT INTO mcp_v2_approval_challenge(id, operation_id, nonce_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`, challenge, id, digest, start, end);
    // SQL CHECK must reject partially bound challenges even with SQL NULL semantics.
    await assert.rejects(store.run('UPDATE mcp_v2_approval_challenge SET account_id = ? WHERE id = ?', 'account', challenge));
    await assert.rejects(store.run(`INSERT INTO mcp_v2_approval_challenge(id, operation_id, nonce_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`, randomUUID(), randomUUID(), 'c'.repeat(64), start, end));
    await assert.rejects(store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 'nonexistent', 'synthetic', 'account', 'client', 'catalog.write', 0, digest, start));

    const doomed = randomUUID();
    await assert.rejects(store.transaction(async () => {
      await insertOperation(store, { id: doomed, idem: 'c'.repeat(64) });
      await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, tool_name, operation_id, event, outcome, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), start, 'synthetic', 'catalog.preview_update', doomed, 'PREPARE', 'OK', randomUUID());
      throw new Error('Synthetic failure.');
    }), /Synthetic failure/);
    assert.equal(await store.get('SELECT id FROM mcp_v2_operation WHERE id = ?', doomed), undefined);
    assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_event')).n), 0);
  });

  test(`${engine}: v2 authority requires explicit consent, live binding and current role`, { skip: engine === 'postgres' && !base }, async (t) => {
    const store = await fixture(t, engine);
    await store.transaction(() => store.exec(operationSchema(engine)));
    await ensureAdmin(store, 'synthetic_owner', 'Synthetic-owner-password-2026!');
    await setupShop(store, { mode: 'production', shopName: 'Synthetic v2 shop' });
    const account = await store.get('SELECT * FROM seller_account WHERE username_key = ?', 'synthetic_owner');
    const now = new Date().toISOString(), expiry = new Date(Date.now() + 600000).toISOString();
    const binding = { tenantId: 'synthetic', issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp' };
    const clientId = secret(), grantId = randomUUID(), bearer = secret();
    await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, clientId, binding.tenantId, binding.issuer, 'Synthetic client',
    JSON.stringify(['https://client.example.test/callback']), 'none', now, expiry);
    const granted = 'catalog.read catalog.write company.write';
    await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes,
      account_auth_version, created_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    grantId, account.id, clientId, binding.tenantId, binding.issuer, binding.resource, granted, account.oauth_auth_version, now, expiry);
    await store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
      VALUES (?, 'access', ?, ?, ?, ?, ?, 0)`, hash(bearer), grantId, binding.resource, granted, now, expiry);
    const verify = (toolName = 'catalog.commit_update', extra = {}) =>
      store.transaction(() => verifyOperationAuthority(store, { bearer, binding, toolName, epochHash: digest, ...extra }));
    const denied = (promise) => assert.rejects(promise, { status: 403, code: 'FORBIDDEN' });

    // Even a historical/incorrect raw scope string cannot acquire v2 authority
    // without a separate explicit-consent record.
    await denied(verify());
    await denied(verify('catalog.list'));
    await denied(verify('catalog.commit_update', { bearer: 'invalid' }));
    await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId, 'catalog.write', account.oauth_auth_version, digest, now);
    assert.deepEqual(await verify(), { tenantId: binding.tenantId, accountId: account.id, clientId, grantId,
      accountAuthVersion: account.oauth_auth_version, grantExpiresAt: expiry, tokenIssuedAt: now,
      scope: 'catalog.write', requiredScopes: ['catalog.write'] });
    await denied(verify('catalog.commit_update', { epochHash: 'b'.repeat(64) }));
    await denied(verify('catalog.commit_update', { binding: { ...binding, tenantId: 'another-tenant' } }));
    await denied(verify('catalog.commit_update', { binding: { ...binding, resource: binding.resource + '/other' } }));
    await store.run('UPDATE oauth_token SET scopes = ? WHERE token_hash = ?', 'catalog.read', hash(bearer));
    await denied(verify());
    await store.run('UPDATE oauth_token SET scopes = ? WHERE token_hash = ?', granted, hash(bearer));
    await store.run('UPDATE mcp_v2_scope_consent SET client_id = ? WHERE grant_id = ?', 'another-client', grantId);
    await denied(verify());
    await store.run('UPDATE mcp_v2_scope_consent SET client_id = ? WHERE grant_id = ?', clientId, grantId);
    await store.run('UPDATE mcp_v2_scope_consent SET consented_at = ? WHERE grant_id = ?', expiry, grantId);
    await denied(verify()); // an already issued token does not gain a newly consented scope
    await store.run('UPDATE mcp_v2_scope_consent SET consented_at = ? WHERE grant_id = ?', now, grantId);

    await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId, 'company.write', account.oauth_auth_version, digest, now);
    await store.run('UPDATE seller_account SET role = ? WHERE id = ?', 'MANAGER', account.id);
    await denied(verify('company.commit_update')); // company settings are OWNER-only
    assert.equal((await verify()).scope, 'catalog.write');
    await store.run('UPDATE seller_account SET role = ? WHERE id = ?', 'STAFF', account.id);
    await denied(verify());
    await store.run('UPDATE seller_account SET role = ?, active = 0 WHERE id = ?', 'OWNER', account.id);
    await denied(verify());
    await store.run('UPDATE seller_account SET active = 1, must_change_password = 1 WHERE id = ?', account.id);
    await denied(verify());
    await store.run('UPDATE seller_account SET must_change_password = 0 WHERE id = ?', account.id);
    await store.run('UPDATE seller_account SET active = 1, oauth_auth_version = oauth_auth_version + 1 WHERE id = ?', account.id);
    await denied(verify());
    await store.run('UPDATE seller_account SET oauth_auth_version = ? WHERE id = ?', account.oauth_auth_version, account.id);
    await store.run('UPDATE oauth_token SET revoked_at = ? WHERE token_hash = ?', now, hash(bearer));
    await denied(verify());
    await store.run('UPDATE oauth_token SET revoked_at = NULL WHERE token_hash = ?', hash(bearer));
    await store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', now, grantId);
    await denied(verify());
  });
}

test('operation DDL rejects an unsupported dialect', () => {
  assert.throws(() => operationSchema('unknown'), TypeError);
});

test('draft policy matches proposed contracts and does not change the active read registry', () => {
  for (const [tool, policy] of Object.entries(OPERATION_SCOPE_POLICIES)) {
    assert.deepEqual(proposedContracts['x-toolPolicies'][tool], policy, tool);
    assert.ok(OPERATION_SCOPES.includes(policy.scope));
  }
  for (const name of ['operations.get', 'operations.cancel', 'operations.audit']) {
    assert.equal(Object.hasOwn(OPERATION_SCOPE_POLICIES, name), true); // every call additionally requires its verified target policy
  }
  assert.ok(OPERATION_SCOPES.every((scope) => !SCOPES.includes(scope)));
  assert.deepEqual(catalogue.map((tool) => tool.name).sort(), [
    'analytics.summary', 'catalog.categories', 'catalog.get', 'catalog.history', 'catalog.list',
    'catalog.low_stock', 'orders.get', 'orders.list',
  ]);
});
