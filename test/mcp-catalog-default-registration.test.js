import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { createCategory } from '../src/settings.js';
import { hash } from '../src/mcp/credentials.js';
import { catalogue } from '../src/mcp/tools.js';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';

const names = ['catalog.preview_create', 'catalog.commit_create', 'catalog.preview_update', 'catalog.commit_update'];
const draft = { sku: 'SYNTHETIC-DEFAULT', name: 'Synthetic default product', description: 'Synthetic default description', category: 'SYNTHETIC', priceMinor: 1200, active: true, stockQuantity: 4 };
const dto = result => { assert.equal(result.response.status, 200, JSON.stringify(result.data)); assert.ok(result.data.result, JSON.stringify(result.data)); return result.data.result.structuredContent; };
for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: default catalog registration requires fresh consent and actual first-party approval`,
  { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async t => {
    const f = await reviewFixture(t, dialect, { operationTools: undefined, config: { mcpRedirectUris: ['https://client.example.com/catalog-callback'] } });
    await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic category' });
    const old = await freshCatalogAccess(f, legacyCatalogScopes);
    assert.deepEqual((await old.rpc('tools/list', {})).data.result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
    assert.equal((await old.call('catalog.preview_create', { input: draft, idempotencyKey: 'synthetic-old-denied-0001' })).response.status, 403);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n), 0);
    const current = await freshCatalogAccess(f);
    const evidence = await f.store.all('SELECT scope, grant_id, consented_at FROM mcp_v2_scope_consent');
    assert.equal(evidence.length, 1); assert.equal(evidence[0].scope, 'catalog.write');
    const issued = await f.store.get('SELECT grant_id, issued_at FROM oauth_token WHERE token_hash = ?', hash(current.bearer));
    assert.equal(evidence[0].grant_id, issued.grant_id); assert.ok(evidence[0].consented_at <= issued.issued_at);
    const listed = (await current.rpc('tools/list', {})).data.result.tools;
    assert.equal(listed.length, 12); assert.deepEqual(listed.slice(0, 8), catalogue.map(({ scope: _scope, ...tool }) => tool));
    assert.deepEqual(listed.slice(8).map(tool => tool.name), names);
    assert.equal((await old.rpc('tools/list', {})).data.result.tools.length, 8);
    const op = dto(await current.call('catalog.preview_create', { input: draft, idempotencyKey: 'synthetic-default-create-0001' }));
    assert.equal((await current.call('catalog.commit_create', { operationId: op.operationId })).response.status, 403);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product')).n), 0);
    const path = '/api/v1/seller/mcp/operations/' + op.operationId;
    await f.store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", f.account.id);
    assert.equal((await current.call('catalog.preview_create', { input: draft, idempotencyKey: 'synthetic-default-staff-0001' })).response.status, 401);
    assert.equal((await f.call(path, 'GET', undefined, current.headers)).response.status, 403);
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    const review = await f.call(path, 'GET', undefined, current.headers); assert.equal(review.response.status, 200);
    assert.equal((await f.call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash, challenge: review.data.challenge,
      decision: 'approve', password: reviewPassword }, current.headers)).response.status, 200);
    const done = dto(await current.call('catalog.commit_create', { operationId: op.operationId }));
    assert.equal(done.status, 'COMMITTED'); assert.equal(dto(await current.call('catalog.commit_create', { operationId: op.operationId })).replayed, true);
    const update = dto(await current.call('catalog.preview_update', { input: { id: done.result.productId, changes: { priceMinor: 1400 } }, idempotencyKey: 'synthetic-default-update-0001' }));
    assert.equal(update.status, 'PENDING_APPROVAL');
    const updatePath = '/api/v1/seller/mcp/operations/' + update.operationId;
    const updateReview = await f.call(updatePath, 'GET', undefined, current.headers); assert.equal(updateReview.response.status, 200);
    assert.equal((await f.call(updatePath + '/approval', 'POST', { operationId: update.operationId, previewHash: update.previewHash,
      challenge: updateReview.data.challenge, decision: 'approve', password: reviewPassword }, current.headers)).response.status, 200);
    assert.equal(dto(await current.call('catalog.commit_update', { operationId: update.operationId })).status, 'COMMITTED');
    assert.equal(dto(await current.call('catalog.commit_update', { operationId: update.operationId })).replayed, true);
    assert.equal((await f.store.get('SELECT price_minor FROM product WHERE id = ?', done.result.productId)).price_minor, 1400);
    const all = await freshCatalogAccess(f, legacyCatalogScopes + ' company.read company.write catalog.write');
    const allListed = (await all.rpc('tools/list', {})).data.result.tools;
    assert.equal(allListed.length, 15);
    assert.deepEqual(allListed.slice(8).map(tool => tool.name), ['company.get', 'company.preview_update', 'company.commit_update', ...names]);
    assert.equal((await current.rpc('tools/list', {})).data.result.tools.length, 12);

    assert.equal((await current.call('catalog.preview_update', { input: { id: done.result.productId, changes: { stockQuantity: 1 } }, idempotencyKey: 'synthetic-default-stock-0001' })).data.error.code, -32602);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id = ?', done.result.productId)).stock_quantity, 4);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n), 1);
  });

test('catalog built-ins stay absent for explicit empty registration, disabled v2 and production', async t => {
  for (const options of [{ operationTools: [] }, { operationTools: undefined, config: { mcpV2: { enabled: false } } },
    { operationTools: undefined, config: { production: true } }]) {
    const f = await reviewFixture(t, 'sqlite', { ...options, config: { mcpRedirectUris: ['https://client.example.com/catalog-callback'], ...options.config } });
    const client = await freshCatalogAccess(f, legacyCatalogScopes);
    assert.equal((await client.rpc('tools/list', {})).data.result.tools.length, 8);
    assert.equal((await client.call('catalog.preview_create', { input: draft, idempotencyKey: 'synthetic-disabled-default-0001' })).data.error.code, -32602);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    await assert.rejects(createApi({ store: f.store, config: f.config, operationTools: null }), TypeError);
  }
});
