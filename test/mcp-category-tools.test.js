import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { valid } from '../src/mcp/tools.js';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { freshCatalogAccess } from './helpers/mcp-catalog-default-grant.js';

const previewName = 'catalog.preview_create_category', commitName = 'catalog.commit_create_category';
const duplicate = { code: -32009, message: 'Category code or label already exists.' };
const category = { code: 'TOYS', label: 'Toys', active: true };
const product = { sku: 'TOY-01', name: 'Fictional toy', description: 'Synthetic category test', category: 'TOYS', priceMinor: 1500, active: true };
const dto = response => {
  assert.equal(response.response.status, 200);
  assert.ok(response.data.result, JSON.stringify(response.data));
  return response.data.result.structuredContent;
};

async function fixture(t, dialect) {
  const f = await reviewFixture(t, dialect, { operationTools: undefined, config: { mcpRedirectUris: ['https://client.example.com/catalog-callback'] } });
  const client = await freshCatalogAccess(f, 'catalog.read catalog.write operations.read operations.cancel');
  let sequence = 0;
  const preview = (input = category, idempotencyKey = 'synthetic-category-' + ++sequence) => client.call(previewName, { input, idempotencyKey });
  const commit = operationId => client.call(commitName, { operationId });
  const approve = async op => {
    const path = '/api/v1/seller/mcp/operations/' + op.operationId;
    const review = await f.call(path, 'GET', undefined, client.headers);
    assert.equal(review.response.status, 200, JSON.stringify(review.data));
    const input = { operationId: op.operationId, previewHash: op.previewHash, challenge: review.data.challenge, decision: 'approve' };
    const response = await f.call(path + '/approval', 'POST', input, client.headers);
    assert.equal(response.response.status, 200, JSON.stringify(response.data));
    return review.data;
  };
  const categories = async () => dto(await client.call('catalog.categories', {})).items;
  return { ...f, client, preview, commit, approve, categories };
}

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: default category tools require approval, commit once, and make the code assignable`, options, async t => {
    const f = await fixture(t, dialect);
    const tools = dtoList(await f.client.rpc('tools/list', {}));
    const bundle = JSON.parse(await readFile(new URL('../docs/mcp-v2/03-CATEGORY-IMPLEMENTED.json', import.meta.url), 'utf8'));
    for (const name of [previewName, commitName]) {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema, bundle.$defs[`${name}.input`]);
      assert.deepEqual(tool.outputSchema, bundle.$defs[`${name}.output`]);
    }
    const baseline = await f.categories(), key = 'synthetic-category-idem';
    const input = { ...category, code: ' TOYS ', label: ' Toys ' };
    const op = dto(await f.preview(input, key)), retry = dto(await f.preview(input, key));
    assert.equal(op.status, 'PENDING_APPROVAL');
    assert.deepEqual(retry, { ...op, replayed: true });
    assert.equal(valid(op, tools.find(tool => tool.name === previewName).outputSchema), true);
    assert.equal((await f.preview({ ...input, label: 'Other label' }, key)).data.error.code, -32009);
    assert.deepEqual(await f.categories(), baseline);
    assert.equal((await f.commit(op.operationId)).response.status, 403);
    assert.deepEqual(await f.categories(), baseline);
    assert.deepEqual((await f.approve(op)).proposal, { before: null, after: category });
    assert.deepEqual(await f.categories(), baseline);
    const done = (await Promise.all([f.commit(op.operationId), f.commit(op.operationId)])).map(dto).sort((a, b) => a.replayed - b.replayed);
    assert.deepEqual(done, [false, true].map(replayed => ({ operationId: op.operationId, status: 'COMMITTED', result: { code: 'TOYS', active: true }, replayed })));
    assert.equal(valid(done[0], tools.find(tool => tool.name === commitName).outputSchema), true);
    assert.equal((await f.categories()).filter(item => item.code === 'TOYS').length, 1);
    const stored = dto(await f.client.call('operations.get', { operationId: op.operationId }));
    assert.equal(stored.resourceType, 'category'); assert.equal(stored.resourceId, 'TOYS');
    const audit = dto(await f.client.call('operations.audit', { operationId: op.operationId }));
    const commits = audit.items.filter(item => item.toolName === commitName).map(item => item.outcome);
    assert.deepEqual(commits.sort(), ['COMMITTED', 'REPLAY']);
    assert.equal(audit.items.filter(item => item.source === 'LIFECYCLE' && item.event === 'COMMIT').length, 1);
    assert.equal(dto(await f.client.call('catalog.preview_create', { input: product, idempotencyKey: 'synthetic-category-product' })).status, 'PENDING_APPROVAL');
  });

  test(`${dialect}: invalid, unconsented and duplicate category creates leave the dictionary untouched`, options, async t => {
    const f = await fixture(t, dialect);
    const old = await freshCatalogAccess(f, 'catalog.read');
    assert.ok(!dtoList(await old.rpc('tools/list', {})).some(tool => [previewName, commitName].includes(tool.name)));
    assert.equal((await old.call(previewName, { input: category, idempotencyKey: 'synthetic-category-denied' })).response.status, 403);
    const response = await f.call('/api/v1/seller/categories', 'POST', { ...category, active: false }, f.headers);
    assert.equal(response.response.status, 201);
    const before = await f.categories();
    for (const input of [{ ...category, label: 'Different' }, { ...category, code: 'OTHER' }]) {
      assert.deepEqual((await f.preview(input)).data.error, duplicate);
    }
    for (const input of [{ ...category, code: 'Toys' }, { ...category, code: 'X'.repeat(81) }, { ...category, label: ' ' },
      { ...category, label: 'L'.repeat(81) }, { ...category, label: '\uD800' }, { ...category, active: 'true' }, { ...category, approved: true }, { code: 'CODE' }]) {
      assert.equal((await f.preview(input)).data.error.code, -32602);
    }
    assert.deepEqual(await f.categories(), before);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });

  test(`${dialect}: category availability is rechecked and product preview distinguishes missing from inactive`, options, async t => {
    const f = await fixture(t, dialect);
    const base = await f.call('/api/v1/seller/categories', 'POST', { code: 'BASE', label: 'Base' }, f.headers);
    assert.equal(base.response.status, 201);
    const previewProduct = key => f.client.call('catalog.preview_create', { input: product, idempotencyKey: key });
    const missing = (await previewProduct('synthetic-missing-category')).data.error;
    assert.equal(missing.code, -32602);
    assert.match(missing.message, /does not exist.*Valid active category codes: \["BASE"\].*catalog\.categories/);
    const op = dto(await f.preview({ ...category, active: false }));
    await f.approve(op);
    assert.deepEqual(dto(await f.commit(op.operationId)).result, { code: 'TOYS', active: false });
    const inactive = (await previewProduct('synthetic-inactive-category')).data.error;
    assert.equal(inactive.code, -32602);
    assert.match(inactive.message, /is inactive.*Valid active category codes: \["BASE"\]/);

    const race = dto(await f.preview({ code: 'GAMES', label: 'Games' }));
    const review = await f.approve(race);
    assert.deepEqual(review.proposal.after, { code: 'GAMES', label: 'Games', active: true });
    assert.equal((await f.call('/api/v1/seller/categories', 'POST', { code: 'BOARD_GAMES', label: 'Games' }, f.headers)).response.status, 201);
    assert.deepEqual((await f.commit(race.operationId)).data.error, duplicate);
    assert.equal(dto(await f.client.call('operations.get', { operationId: race.operationId })).status, 'CONFLICT');
    assert.ok(!(await f.categories()).some(item => item.code === 'GAMES'));
  });
}

function dtoList(response) {
  assert.equal(response.response.status, 200);
  assert.ok(response.data.result?.tools, JSON.stringify(response.data));
  return response.data.result.tools;
}
