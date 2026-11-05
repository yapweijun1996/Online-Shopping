import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../../src/db.js';
import { openPostgresDatabase } from '../../src/postgres-db.js';
import { ensureAdmin } from '../../src/auth.js';
import { setupShop } from '../../src/shop-setup.js';
import { createApi } from '../../src/app.js';
import { hash, secret } from '../../src/mcp/credentials.js';
import { operationEpochHash } from '../../src/mcp/operation-epoch.js';
import { canonicalOperationJson, operationPreviewHash } from '../../src/mcp/operation-envelope.js';

export const sellerOrigin = 'https://seller.example.test';
export const reviewPassword = 'Synthetic-route-password-2026!';
export async function reviewFixture(t, dialect = 'sqlite', options = {}) {
  let store;
  if (dialect === 'postgres') {
    const base = process.env.SHOP_TEST_DATABASE_URL;
    if (!base || process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname)) throw new Error('Disposable PostgreSQL required.');
    const admin = new pg.Pool({ connectionString: base }), name = `shopping_test_review_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  } else { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  await ensureAdmin(store, 'synthetic_owner', reviewPassword);
  await setupShop(store, { mode: 'production', shopName: 'Synthetic review shop' });
  const epoch = secret(), buildDigest = 'e'.repeat(64), epochHash = operationEpochHash(epoch);
  const config = { sellerOrigin, publicOrigin: 'https://shop.example.test', mcpEnabled: true, production: false, shopMode: 'manual',
    mcpBrowserOrigins: ['https://ai.example.test'], mcpV2: { enabled: true, epoch, buildDigest }, ...options.config };
  const tenantId = options.tenantId || 'default', tenantRevision = options.tenantRevision ?? 0;
  const binding = { tenantId, issuer: config.sellerOrigin + (config.basePath || ''), resource: config.sellerOrigin + (config.basePath || '') + '/mcp' };
  const api = await createApi({ store, config, operationTools: options.operationTools || [], ...(options.registry ? { registry: options.registry(store, config) } : {}) });
  let seq = 0;
  async function call(path, method = 'GET', body, headers = {}, requestOrigin = config.sellerOrigin) {
    const request = new Request(requestOrigin + (config.basePath || '') + path, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const response = await api(request, { clientAddress: 'synthetic-ip-' + ++seq });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  }
  const signedIn = await call('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password: reviewPassword }, { origin: config.sellerOrigin });
  assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.data));
  const cookie = signedIn.response.headers.get('set-cookie').split(';')[0], csrf = signedIn.data.csrfToken;
  const headers = { cookie, origin: config.sellerOrigin, 'x-csrf-token': csrf };
  const account = await store.get('SELECT * FROM seller_account WHERE username_key = ?', 'synthetic_owner');
  const clientId = secret(), grantId = randomUUID(), now = new Date().toISOString(), later = new Date(Date.now() + 600000).toISOString();
  async function seedGrant() {
    await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'none', ?, ?)`, clientId, tenantId, binding.issuer, 'Synthetic client', JSON.stringify(['https://client.example.test/callback']), now, later);
    await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes, account_auth_version, created_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, account.id, clientId, tenantId, binding.issuer, binding.resource, account.oauth_auth_version, now, later);
    await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
      VALUES (?, ?, ?, ?, 'catalog.write', ?, ?, ?)`, grantId, tenantId, account.id, clientId, account.oauth_auth_version, epochHash, now);
  }
  async function operation(patch = {}) {
    const value = { version: 1, operationId: randomUUID(), tenantId, tenantRevision, accountId: account.id, clientId, grantId, epochHash, buildDigest,
      issuer: binding.issuer, resource: binding.resource, toolName: 'catalog.preview_update', resourceType: 'product', resourceId: randomUUID(),
      expectedRevision: 1, requiredScope: 'catalog.write', requiredCapability: 'catalog.write', risk: 'MEDIUM', createdAt: now, expiresAt: later,
      idempotencyHash: hash(secret()), correlationId: randomUUID(), proposal: { before: { name: 'Synthetic old' }, after: { name: 'Synthetic new' } }, ...patch };
    const previewHash = operationPreviewHash(value);
    const columns = ['id', 'tenant_id', 'tenant_revision', 'account_id', 'client_id', 'grant_id', 'epoch_hash', 'build_digest', 'issuer', 'resource', 'tool_name', 'resource_type', 'resource_id', 'expected_revision', 'required_scope', 'required_capability', 'risk', 'created_at', 'expires_at', 'idempotency_hash', 'correlation_id', 'envelope_json', 'preview_hash', 'request_hash', 'state', 'receipt_expires_at'];
    const values = [value.operationId, value.tenantId, value.tenantRevision, value.accountId, value.clientId, value.grantId, value.epochHash, value.buildDigest, value.issuer, value.resource, value.toolName, value.resourceType, value.resourceId, String(value.expectedRevision), value.requiredScope, value.requiredCapability, value.risk, value.createdAt, value.expiresAt, value.idempotencyHash, value.correlationId, canonicalOperationJson(value), previewHash, hash('synthetic-request'), 'PENDING_APPROVAL', new Date(Date.parse(later) + 90 * 86400000).toISOString()];
    await store.run(`INSERT INTO mcp_v2_operation(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values);
    const path = '/api/v1/seller/mcp/operations/' + value.operationId;
    return { value, path, previewHash, input: { operationId: value.operationId, previewHash, decision: 'approve', password: reviewPassword } };
  }
  async function reviewedOperation(patch) {
    const op = await operation(patch), review = await call(op.path, 'GET', undefined, headers);
    assert.equal(review.response.status, 200, JSON.stringify(review.data));
    return { ...op, review, input: { ...op.input, challenge: review.data.challenge } };
  }
  return { store, config, api, call, cookie, csrf, headers, account, grantId, clientId, seedGrant, operation, reviewedOperation, binding };
}
