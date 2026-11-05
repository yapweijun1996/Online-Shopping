import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { catalogCreateTool, catalogUpdateTool, catalogCreateRevision, catalogUpdateRevision } from '../src/mcp/catalog-tools.js';
import { createCategory, updateCategory, updateCompanySettings } from '../src/settings.js';
import { createProduct, getProduct, updateProduct } from '../src/products.js';
import { createOptionType, createOptionValue, updateOptionValue, updateOptionType } from '../src/options.js';
import { hash, secret, stamp } from '../src/mcp/credentials.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { reservedQuantity, RESERVATION_HOURS } from '../src/stock-reservation.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { createApi } from '../src/app.js';
import { catalogue, valid } from '../src/mcp/tools.js';
import { OPERATION_SCOPE_POLICIES, OPERATION_PREVIEW_RISKS } from '../src/mcp/operation-policy.js';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';

async function fixture(t, dialect) {
  const f = await reviewFixture(t, dialect, { operationTools: [catalogCreateTool(), catalogUpdateTool()] }); await f.seedGrant();
  const scopes = 'catalog.read orders.read analytics.read catalog.write';
  await f.store.run('UPDATE oauth_grant SET scopes = ? WHERE id = ?', scopes, f.grantId);
  const bearer = secret();
  await f.store.run(`INSERT INTO oauth_token(token_hash,kind,grant_id,resource,scopes,issued_at,expires_at,generation)
    VALUES (?, 'access', ?, ?, ?, ?, ?, 0)`, hash(bearer), f.grantId, f.binding.resource, scopes, stamp(), stamp(600000));
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic category' });
  await createCategory(f.store, { code: 'ALTERNATE', label: 'Alternate category' });
  let seq = 0;
  const rpc = (name, args) => f.call('/mcp', 'POST', { jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } },
    { authorization: 'Bearer ' + bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
  const draft = extra => ({ sku: 'SYN-01', name: 'Synthetic product', description: 'Synthetic description', category: 'SYNTHETIC', priceMinor: 1200, active: true, ...extra });
  const previewCreate = (input = draft(), key = `synthetic-catalog-create-${String(++seq).padStart(8, '0')}`) => rpc('catalog.preview_create', { input, idempotencyKey: key });
  const previewUpdate = (id, changes, key = `synthetic-catalog-update-${String(++seq).padStart(8, '0')}`) => rpc('catalog.preview_update', { input: { id, changes }, idempotencyKey: key });
  const approve = async op => {
    const path = '/api/v1/seller/mcp/operations/' + op.operationId;
    const review = await f.call(path, 'GET', undefined, f.headers); assert.equal(review.response.status, 200, JSON.stringify(review.data));
    return f.call(path + '/approval', 'POST', { operationId: op.operationId, previewHash: op.previewHash, challenge: review.data.challenge,
      decision: 'approve', password: reviewPassword }, f.headers);
  };
  const commit = (kind, op) => rpc(`catalog.commit_${kind}`, { operationId: op.operationId });
  return { ...f, bearer, rpc, draft, previewCreate, previewUpdate, approve, commit };
}
const dto = result => { assert.equal(result.response.status, 200, JSON.stringify(result.data)); assert.ok(result.data.result, JSON.stringify(result.data)); return result.data.result.structuredContent; };
const metadataSpy = store => {
  const old = { get: store.get, all: store.all, run: store.run, exec: store.exec }; let reads = 0;
  const check = sql => {
    if (/^\s*SELECT\b/i.test(sql)) {
      assert.doesNotMatch(sql, /\b(?:image_data|thumb_data|data)\b/i);
      assert.doesNotMatch(sql, /SELECT\s+\*\s+FROM\s+(?:product|product_gallery_image)\b/i); reads++;
    }
    assert.doesNotMatch(sql, /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:product|listing|product_option|product_gallery_image|general_code)\b/i);
  };
  for (const name of ['get', 'all', 'run', 'exec']) store[name] = (sql, ...args) => { check(sql); return old[name](sql, ...args); };
  return () => { Object.assign(store, old); assert.ok(reads > 0); };
};
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: actual create preview reads no bytes, normalizes, requires approval and writes once with history`, options, async t => {
    const f = await fixture(t, dialect), key = 'synthetic-create-idempotency-0001';
    const input = f.draft({ sku: '  syn-01  ', name: ' Synthetic product ', stockQuantity: 4 });
    const restore = metadataSpy(f.store); let prepared;
    try { prepared = await f.previewCreate(input, key); } finally { restore(); }
    const op = dto(prepared);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n, 0);
    const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', op.operationId), proposal = JSON.parse(row.envelope_json).proposal;
    assert.equal(row.resource_type, 'catalog'); assert.match(row.expected_revision, /^[0-9a-f]{64}$/);
    assert.equal(proposal.after.sku, 'SYN-01'); assert.equal(proposal.after.name, 'Synthetic product');
    assert.deepEqual(proposal.initialStock, { quantity: 4, unlimited: false });
    assert.equal(dto(await f.previewCreate(input, key)).operationId, op.operationId);
    assert.equal((await f.previewCreate(f.draft({ name: 'Different intent' }), key)).data.error.code, -32009);
    assert.equal((await f.commit('create', op)).response.status, 403);
    assert.equal((await f.approve(op)).response.status, 200);
    const done = await Promise.all([f.commit('create', op), f.commit('create', op)]);
    assert.deepEqual(done.map(value => dto(value).replayed).sort(), [false, true]);
    const receipt = dto(done[0]).result;
    assert.deepEqual(Object.keys(receipt).sort(), ['listingId', 'productId', 'revision']);
    assert.doesNotMatch(JSON.stringify(receipt), /Synthetic product|SYN-01|1200/);
    const product = await getProduct(f.store, receipt.productId, true);
    assert.equal(product.stockQuantity, 4); assert.equal(product.currency, 'MYR');
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM product_event WHERE product_id = ? AND action = 'CREATED'", receipt.productId)).n, 1);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n, 1);
  });

  test(`${dialect}: listing update reviews every affected sibling and preserves omitted price/stock/media`, options, async t => {
    const f = await fixture(t, dialect);
    const imageDataUrl = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');
    const a = await createProduct(f.store, f.draft({ sku: 'VAR-A', variantGroup: 'VAR', variantLabel: 'A', stockQuantity: 8, imageDataUrl }));
    const b = await createProduct(f.store, f.draft({ sku: 'VAR-B', variantGroup: 'VAR', variantLabel: 'B', priceMinor: 1900, stockQuantity: 3 }));
    const binarySnapshot = async () => [rowsDigest(await f.store.all('SELECT id, image_data, thumb_data FROM product ORDER BY id')),
      rowsDigest(await f.store.all('SELECT id, product_id, position, data, thumb_data FROM product_gallery_image ORDER BY id'))];
    const bytes = await binarySnapshot();
    const restore = metadataSpy(f.store); let prepared;
    try { prepared = await f.previewUpdate(a.id, { name: ' New listing title ', description: 'New listing text', category: 'ALTERNATE' }); } finally { restore(); }
    const op = dto(prepared), proposal = JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).envelope_json).proposal;
    assert.deepEqual(proposal.listingEffect.members.map(row => row.id).sort(), [a.id, b.id].sort());
    assert.equal(proposal.listingEffect.before.name, 'Synthetic product'); assert.equal(proposal.listingEffect.after.name, 'New listing title');
    assert.ok(!Object.hasOwn(proposal.normalizedInput, 'stockQuantity'));
    assert.equal((await f.approve(op)).response.status, 200);
    assert.equal(dto(await f.commit('update', op)).status, 'COMMITTED');
    for (const id of [a.id, b.id]) {
      const p = await getProduct(f.store, id, true); assert.equal(p.name, 'New listing title'); assert.equal(p.categoryCode, 'ALTERNATE');
    }
    const sibling = await getProduct(f.store, b.id, true); assert.equal(sibling.priceMinor, 1900); assert.equal(sibling.stockQuantity, 3);
    assert.ok((await f.store.get('SELECT COUNT(*) AS n FROM product_gallery_image')).n > 0);
    assert.deepEqual(await binarySnapshot(), bytes);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM product_event WHERE product_id = ? AND action = 'UPDATED'", a.id)).n, 1);
  });

  test(`${dialect}: unknown authority/media/stock inputs and all group/holder moves fail closed`, options, async t => {
    const f = await fixture(t, dialect), p = await createProduct(f.store, f.draft());
    const missing = await f.previewUpdate(randomUUID(), { name: 'Missing target' });
    assert.equal(missing.response.status, 200); assert.deepEqual(missing.data.error, { code: -32602, message: 'Invalid params' });
    for (const patch of [{ stockQuantity: 1 }, { stockQuantity: null }, { imageDataUrl: null }, { thumbDataUrl: 'x' }, { gallery: [] },
      { image_data: [1, 2, 3] }, { imageMime: 'image/png' }, { mime: 'image/webp' }, { thumb_mime: 'image/png' },
      { accountId: 'other' }, { tenantId: 'other' }, { expectedUpdatedAt: p.updatedAt }, {}]) {
      assert.equal((await f.previewUpdate(p.id, patch)).data.error.code, -32602);
    }
    for (const key of ['approved', 'scope', 'adapter', 'companyId']) assert.equal((await f.previewCreate(f.draft({ [key]: true }))).data.error.code, -32602);
    assert.equal((await f.previewUpdate(p.id, { variantGroup: 'OTHER', variantLabel: 'X' })).data.error.code, -32602);
    await createProduct(f.store, f.draft({ sku: 'GROUP-A', variantGroup: 'GROUP', variantLabel: 'A' }));
    assert.equal((await f.previewCreate(f.draft({ sku: 'GROUP-B', variantGroup: 'GROUP', variantLabel: 'B' }))).data.error.code, -32602);
    const b = await createProduct(f.store, f.draft({ sku: 'GROUP-B', variantGroup: 'GROUP', variantLabel: 'B' }));
    await f.store.run('UPDATE product SET created_at = ? WHERE variant_group = ?', '2026-01-01T00:00:00.000Z', 'GROUP');
    assert.equal((await f.previewUpdate(b.id, { sku: 'AAA' })).data.error.code, -32602);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });

  test(`${dialect}: listing review shows divergent historical copies without claiming unrelated fields will be overwritten`, options, async t => {
    const f = await fixture(t, dialect);
    const a = await createProduct(f.store, f.draft({ sku: 'LEGACY-A', variantGroup: 'LEGACY', variantLabel: 'A' }));
    const b = await createProduct(f.store, f.draft({ sku: 'LEGACY-B', variantGroup: 'LEGACY', variantLabel: 'B' }));
    // Synthetic state possible after the historical listing backfill, which only
    // associated product IDs and did not rewrite each variant's old text copies.
    await f.store.run('UPDATE product SET name = ?, description = ? WHERE id = ?', 'Legacy variant title', 'Legacy variant description', b.id);
    const op = dto(await f.previewUpdate(b.id, { name: 'Reviewed shared title' }));
    const proposal = JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).envelope_json).proposal;
    assert.equal(proposal.before.name, 'Legacy variant title'); assert.equal(proposal.after.description, 'Legacy variant description');
    assert.deepEqual(proposal.listingEffect.changedFields, ['name']);
    assert.equal(proposal.listingEffect.before.name, 'Synthetic product');
    assert.equal(proposal.listingEffect.after.description, 'Synthetic description');
    assert.deepEqual(proposal.listingEffect.memberOverrides, [{ id: b.id, before: { name: 'Legacy variant title', description: 'Legacy variant description', category: 'SYNTHETIC' }, after: { name: 'Reviewed shared title', description: 'Legacy variant description', category: 'SYNTHETIC' } }]);
    await f.approve(op); assert.equal(dto(await f.commit('update', op)).status, 'COMMITTED');
    assert.equal((await getProduct(f.store, a.id, true)).description, 'Synthetic description');
    assert.equal((await getProduct(f.store, b.id, true)).description, 'Legacy variant description');
    assert.equal((await getProduct(f.store, a.id, true)).name, 'Reviewed shared title');
  });
}

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: a first SKU in an empty structured group uses existing option derivation and explicit unlimited initial stock`, options, async t => {
    const f = await fixture(t, dialect), type = await createOptionType(f.store, { name: 'Synthetic Size' });
    const large = await createOptionValue(f.store, type.id, { label: 'Large' });
    const op = dto(await f.previewCreate(f.draft({ sku: 'NEW-SIZE', variantGroup: 'NEW-SIZE', options: [{ typeId: type.id, valueId: large.id }] })));
    const proposal = JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).envelope_json).proposal;
    assert.deepEqual(proposal.initialStock, { quantity: null, unlimited: true }); assert.equal(proposal.after.variantLabel, 'Large');
    await f.approve(op); const receipt = dto(await f.commit('create', op)).result;
    const product = await getProduct(f.store, receipt.productId, true);
    assert.equal(product.variantLabel, 'Large'); assert.equal(product.stockQuantity, null); assert.equal(product.options[0].value.id, large.id);
  });

  test(`${dialect}: legacy and derived option labels mirror case-insensitive uniqueness before approval`, options, async t => {
    const f = await fixture(t, dialect);
    const red = await createProduct(f.store, f.draft({ sku: 'LABEL-RED', variantGroup: 'LABELS', variantLabel: 'RED' }));
    await createProduct(f.store, f.draft({ sku: 'LABEL-BLUE', variantGroup: 'LABELS', variantLabel: 'BLUE' }));
    const collision = await f.previewUpdate(red.id, { variantLabel: 'blue' });
    assert.equal(collision.response.status, 200); assert.deepEqual(collision.data.error, { code: -32009, message: 'Operation conflict' });
    const type = await createOptionType(f.store, { name: 'Synthetic legacy color' });
    const redValue = await createOptionValue(f.store, type.id, { label: 'Red' });
    const blueValue = await createOptionValue(f.store, type.id, { label: 'blue' });
    await createProduct(f.store, f.draft({ sku: 'MIX-FREE', variantGroup: 'MIXED', variantLabel: 'BLUE' }));
    const picked = await createProduct(f.store, f.draft({ sku: 'MIX-OPTIONS', variantGroup: 'MIXED', options: [{ typeId: type.id, valueId: redValue.id }] }));
    const derived = await f.previewUpdate(picked.id, { options: [{ typeId: type.id, valueId: blueValue.id }] });
    assert.equal(derived.response.status, 200); assert.deepEqual(derived.data.error, { code: -32009, message: 'Operation conflict' });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
    const ownCase = dto(await f.previewUpdate(red.id, { variantLabel: 'red' })); await f.approve(ownCase);
    assert.equal(dto(await f.commit('update', ownCase)).status, 'COMMITTED');
    assert.equal((await getProduct(f.store, red.id, true)).variantLabel, 'red');
  });

  test(`${dialect}: omitted legacy member fields stay distinct and explicit parent-equal keys still show member changes`, options, async t => {
    const f = await fixture(t, dialect);
    const a = await createProduct(f.store, f.draft({ sku: 'DRIFT-A', variantGroup: 'DRIFT', variantLabel: 'A' }));
    const b = await createProduct(f.store, f.draft({ sku: 'DRIFT-B', variantGroup: 'DRIFT', variantLabel: 'B' }));
    const c = await createProduct(f.store, f.draft({ sku: 'DRIFT-C', variantGroup: 'DRIFT', variantLabel: 'C' }));
    await f.store.run('UPDATE product SET name = ? WHERE id = ?', 'Historical B', b.id);
    await f.store.run('UPDATE product SET name = ? WHERE id = ?', 'Historical C', c.id);
    const readProposal = async op => JSON.parse((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id = ?', op.operationId)).envelope_json).proposal;
    const description = dto(await f.previewUpdate(b.id, { description: 'New shared description' }));
    let proposal = await readProposal(description);
    assert.equal(proposal.listingEffect.before.name, 'Synthetic product'); assert.equal(proposal.listingEffect.after.name, 'Synthetic product');
    assert.deepEqual(proposal.listingEffect.changedFields, ['description']);
    assert.deepEqual(proposal.listingEffect.memberOverrides.map(row => [row.id, row.before.name, row.after.name]).sort(),
      [[b.id, 'Historical B', 'Historical B'], [c.id, 'Historical C', 'Historical C']].sort());
    await f.approve(description); assert.equal(dto(await f.commit('update', description)).status, 'COMMITTED');
    assert.equal((await getProduct(f.store, b.id, true)).name, 'Historical B'); assert.equal((await getProduct(f.store, c.id, true)).name, 'Historical C');
    const normalize = dto(await f.previewUpdate(b.id, { name: 'Synthetic product' })); proposal = await readProposal(normalize);
    assert.equal(proposal.listingEffect.before.name, proposal.listingEffect.after.name);
    assert.deepEqual(proposal.listingEffect.changedFields, ['name']);
    assert.deepEqual(proposal.listingEffect.memberOverrides.map(row => row.after.name), ['Synthetic product', 'Synthetic product']);
    await f.approve(normalize); assert.equal(dto(await f.commit('update', normalize)).status, 'COMMITTED');
    for (const id of [a.id, b.id, c.id]) assert.equal((await getProduct(f.store, id, true)).name, 'Synthetic product');
  });

  test(`${dialect}: human review resolves full option choices even when the derived label truncates all visible differences`, options, async t => {
    const f = await fixture(t, dialect);
    const primary = await createOptionType(f.store, { name: 'Primary trait', position: 0 });
    const secondary = await createOptionType(f.store, { name: 'Secondary trait', position: 1 });
    const long = await createOptionValue(f.store, primary.id, { label: 'A'.repeat(80) });
    const first = await createOptionValue(f.store, secondary.id, { label: 'First hidden choice' });
    const second = await createOptionValue(f.store, secondary.id, { label: 'Second hidden choice' });
    const target = await createProduct(f.store, f.draft({ sku: 'LONG-OPTIONS', variantGroup: 'LONG-OPTIONS', options: [
      { typeId: primary.id, valueId: long.id }, { typeId: secondary.id, valueId: first.id },
    ] }));
    const op = dto(await f.previewUpdate(target.id, { options: [{ typeId: primary.id, valueId: long.id }, { typeId: secondary.id, valueId: second.id }] }));
    const review = await f.call('/api/v1/seller/mcp/operations/' + op.operationId, 'GET', undefined, f.headers);
    assert.equal(review.response.status, 200);
    const proposal = review.data.proposal;
    assert.equal(proposal.before.variantLabel, 'A'.repeat(80)); assert.equal(proposal.after.variantLabel, 'A'.repeat(80));
    const before = proposal.optionReview.before.find(item => item.typeId === secondary.id), after = proposal.optionReview.after.find(item => item.typeId === secondary.id);
    assert.equal(before.typeName, 'Secondary trait'); assert.equal(after.typeName, 'Secondary trait');
    assert.equal(before.valueLabel, 'First hidden choice'); assert.equal(after.valueLabel, 'Second hidden choice');
    assert.equal(before.valueId, first.id); assert.equal(after.valueId, second.id);
    assert.ok(proposal.optionReview.after.some(item => item.valueLabel === 'A'.repeat(80)));
    await f.approve(op); assert.equal(dto(await f.commit('update', op)).status, 'COMMITTED');
    assert.ok((await getProduct(f.store, target.id, true)).options.some(item => item.value.id === second.id));
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n, 1);
  });

  test(`${dialect}: full option review supports existing 60-character codes and generated type suffixes`, options, async t => {
    const f = await fixture(t, dialect);
    await createOptionType(f.store, { name: 'A'.repeat(40) });
    const type = await createOptionType(f.store, { name: 'A'.repeat(40) + ' B' });
    assert.ok(type.code.length > 40);
    const first = await createOptionValue(f.store, type.id, { label: 'First synthetic value', code: 'x'.repeat(60) });
    const second = await createOptionValue(f.store, type.id, { label: 'Second synthetic value', code: 'y'.repeat(60) });
    const target = await createProduct(f.store, f.draft({ sku: 'LONG-CODES', variantGroup: 'LONG-CODES', options: [{ typeId: type.id, valueId: first.id }] }));
    const op = dto(await f.previewUpdate(target.id, { options: [{ typeId: type.id, valueId: second.id }] }));
    const review = await f.call('/api/v1/seller/mcp/operations/' + op.operationId, 'GET', undefined, f.headers);
    assert.equal(review.response.status, 200);
    assert.equal(review.data.proposal.optionReview.before[0].valueCode, 'x'.repeat(60));
    assert.equal(review.data.proposal.optionReview.after[0].valueCode, 'y'.repeat(60));
    assert.equal(review.data.proposal.optionReview.after[0].typeCode, type.code);
    await f.approve(op); assert.equal(dto(await f.commit('update', op)).status, 'COMMITTED');
  });

  test(`${dialect}: explicit empty registration exposes no staged catalog mutations and leaves the eight v1 definitions unchanged`, options, async t => {
    const f = await fixture(t, dialect), api = await createApi({ store: f.store, config: f.config, operationTools: [] });
    const call = (method, params) => api(new Request(f.binding.resource, { method: 'POST', headers: {
      authorization: 'Bearer ' + f.bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), { clientAddress: 'synthetic-default-registry' });
    const list = await call('tools/list', {});
    assert.deepEqual((await list.json()).result.tools, catalogue.map(({ scope: _scope, ...tool }) => tool));
    const denied = await call('tools/call', { name: 'catalog.preview_create', arguments: { input: f.draft(), idempotencyKey: 'synthetic-default-hidden-0001' } });
    assert.equal((await denied.json()).error.code, -32602);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });

  test(`${dialect}: oversized complete listing review fails before an operation is persisted`, options, async t => {
    const f = await fixture(t, dialect), base = await createProduct(f.store, f.draft({ sku: 'CAP-TARGET', variantGroup: 'CAP', variantLabel: '0', description: '界'.repeat(2000) }));
    await f.store.transaction(async () => {
      for (let i = 1; i < 300; i++) await f.store.run(`INSERT INTO product(id, sku, name, description, category, price_minor, currency, active, variant_group, variant_label, listing_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), 'CAP-' + String(i).padStart(3, '0') + 'X'.repeat(32), base.name, base.description,
      'SYNTHETIC', 1200, 'MYR', 1, 'CAP', String(i), base.listingId, base.createdAt, base.updatedAt);
    });
    const preview = await f.previewUpdate(base.id, { name: 'Must review every sibling' });
    assert.equal(preview.response.status, 503);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
    assert.equal((await f.store.get('SELECT name FROM product WHERE id = ?', base.id)).name, 'Synthetic product');
  });
}

test('catalog revision scans stop at explicit product and member caps', async () => {
  let productCalls = 0, returned = 0;
  const root = { get: async () => ({ default_currency: 'MYR' }), all: async (sql, ...args) => {
    assert.match(sql, /FROM product ORDER BY id|FROM product WHERE id > \? ORDER BY id/);
    assert.doesNotMatch(sql, /\b(?:image_data|thumb_data|data)\b|SELECT\s+\*/);
    productCalls++; const limit = args.at(-1); assert.ok(limit <= 200);
    return Array.from({ length: limit }, () => ({ id: String(++returned).padStart(8, '0') }));
  } };
  await assert.rejects(catalogCreateRevision(root), { status: 503, code: 'CATALOG_REVIEW_TOO_LARGE' });
  assert.equal(returned, 10001); assert.equal(productCalls, 51);
  let memberQueries = 0;
  const component = { get: async () => ({ id: 'target', listing_id: 'listing', variant_group: 'group' }), all: async (sql, ...args) => {
    memberQueries++; assert.match(sql, /FROM product WHERE listing_id/); assert.equal(args.at(-1), 301);
    return Array.from({ length: 301 }, (_, i) => ({ id: String(i) }));
  } };
  await assert.rejects(catalogUpdateRevision(component, 'target'), { status: 503, code: 'CATALOG_REVIEW_TOO_LARGE' });
  assert.equal(memberQueries, 1);
});

test('catalog root stops at its cumulative metadata-byte budget before scanning a text-heavy catalog', async () => {
  let returned = 0, calls = 0;
  const read = { get: async () => ({ default_currency: 'MYR' }), all: async (sql, ...args) => {
    assert.match(sql, /FROM product /); calls++;
    return Array.from({ length: args.at(-1) }, () => ({ id: String(++returned).padStart(8, '0'), description: 'x'.repeat(2000) }));
  } };
  await assert.rejects(catalogCreateRevision(read), { status: 503, code: 'CATALOG_REVIEW_TOO_LARGE' });
  assert.ok(returned < 10000); assert.ok(calls < 51);
});

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: sibling shared edits without a target timestamp change invalidate the full pending component`, options, async t => {
    const f = await fixture(t, dialect);
    const a = await createProduct(f.store, f.draft({ sku: 'SHARED-A', variantGroup: 'SHARED', variantLabel: 'A' }));
    const b = await createProduct(f.store, f.draft({ sku: 'SHARED-B', variantGroup: 'SHARED', variantLabel: 'B' }));
    const op = dto(await f.previewUpdate(a.id, { priceMinor: 1550 })); await f.approve(op);
    const timestamp = (await f.store.get('SELECT updated_at FROM product WHERE id = ?', a.id)).updated_at;
    assert.equal((await f.call('/api/v1/seller/products/' + b.id, 'PATCH', { name: 'Portal shared title' }, f.headers)).response.status, 200);
    assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id = ?', a.id)).updated_at, timestamp);
    assert.equal(dto(await f.commit('update', op)).error, 'STALE_REVISION');
    const after = await getProduct(f.store, a.id, true); assert.equal(after.priceMinor, 1200); assert.equal(after.name, 'Portal shared title');
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", op.operationId)).n, 0);
  });

  test(`${dialect}: structured option normalization is shared and dictionary edits fence timestamp-stable products`, options, async t => {
    const f = await fixture(t, dialect), type = await createOptionType(f.store, { name: 'Synthetic Color' });
    const red = await createOptionValue(f.store, type.id, { label: 'Red' }), blue = await createOptionValue(f.store, type.id, { label: 'Blue' }), green = await createOptionValue(f.store, type.id, { label: 'Green' });
    const a = await createProduct(f.store, f.draft({ sku: 'COLOR-A', variantGroup: 'COLOR', options: [{ typeId: type.id, valueId: red.id }] }));
    await createProduct(f.store, f.draft({ sku: 'COLOR-B', variantGroup: 'COLOR', options: [{ typeId: type.id, valueId: blue.id }] }));
    assert.equal((await f.previewUpdate(a.id, { options: [{ typeId: type.id, valueId: blue.id }] })).data.error.code, -32009);
    assert.equal((await f.previewUpdate(a.id, { variantLabel: 'Invented derived label' })).data.error.code, -32602);
    const first = dto(await f.previewUpdate(a.id, { options: [{ typeId: type.id, valueId: green.id }] })); await f.approve(first);
    const timestamp = (await f.store.get('SELECT updated_at FROM product WHERE id = ?', a.id)).updated_at;
    await updateOptionValue(f.store, type.id, red.id, { label: 'Renamed Red' });
    assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id = ?', a.id)).updated_at, timestamp);
    assert.equal(dto(await f.commit('update', first)).error, 'STALE_REVISION');
    const next = dto(await f.previewUpdate(a.id, { options: [{ typeId: type.id, valueId: green.id }] })); await f.approve(next);
    assert.equal(dto(await f.commit('update', next)).status, 'COMMITTED');
    const after = await getProduct(f.store, a.id, true); assert.equal(after.variantLabel, 'Green'); assert.equal(after.options[0].value.id, green.id);
    const current = dto(await f.previewUpdate(a.id, { priceMinor: 1300 })); await f.approve(current);
    await updateOptionType(f.store, type.id, { active: false });
    assert.equal(dto(await f.commit('update', current)).error, 'STALE_REVISION');
    assert.equal((await f.previewCreate(f.draft({ sku: 'NEW-OPTION', variantGroup: 'NEW-OPTION', options: [{ typeId: type.id, valueId: green.id }] }))).data.error.code, -32602);
  });

  test(`${dialect}: create root fences catalog/currency changes; update fences category and desired-SKU phantoms`, options, async t => {
    const f = await fixture(t, dialect);
    const currency = dto(await f.previewCreate()); await f.approve(currency);
    await updateCompanySettings(f.store, { defaultCurrency: 'SGD' });
    assert.equal(dto(await f.commit('create', currency)).error, 'STALE_REVISION');
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n, 0);
    const create = dto(await f.previewCreate(f.draft({ sku: 'ROOT' }))); await f.approve(create);
    const target = await createProduct(f.store, f.draft({ sku: 'TARGET' }));
    assert.equal(dto(await f.commit('create', create)).error, 'STALE_REVISION');
    const phantom = dto(await f.previewUpdate(target.id, { sku: 'FUTURE' })); await f.approve(phantom);
    await createProduct(f.store, f.draft({ sku: 'FUTURE' }));
    assert.equal(dto(await f.commit('update', phantom)).error, 'STALE_REVISION');
    const category = dto(await f.previewUpdate(target.id, { category: 'ALTERNATE' })); await f.approve(category);
    await updateCategory(f.store, 'ALTERNATE', { active: false });
    assert.equal(dto(await f.commit('update', category)).error, 'STALE_REVISION');
    assert.equal((await getProduct(f.store, target.id, true)).categoryCode, 'SYNTHETIC');
  });

  test(`${dialect}: portal import and concurrent portal edits cannot be overwritten by an approved patch`, options, async t => {
    const f = await fixture(t, dialect), target = await createProduct(f.store, f.draft({ stockQuantity: 8 }));
    const imported = dto(await f.previewUpdate(target.id, { name: 'Must not overwrite imported state' })); await f.approve(imported);
    const result = await f.call('/api/v1/seller/products/import', 'POST', { csv: 'SKU,Price\nSYN-01,22.00', commit: true }, f.headers);
    assert.equal(result.response.status, 200); assert.equal(dto(await f.commit('update', imported)).error, 'STALE_REVISION');
    const racing = dto(await f.previewUpdate(target.id, { name: 'MCP title' })); await f.approve(racing);
    const [portal, committed] = await Promise.all([f.call('/api/v1/seller/products/' + target.id, 'PATCH', { priceMinor: 2300 }, f.headers), f.commit('update', racing)]);
    assert.equal(portal.response.status, 200);
    const state = dto(committed); assert.ok(state.status === 'COMMITTED' || state.error === 'STALE_REVISION');
    const after = await getProduct(f.store, target.id, true); assert.equal(after.priceMinor, 2300); assert.equal(after.stockQuantity, 8);
    assert.equal(after.name, state.status === 'COMMITTED' ? 'MCP title' : 'Synthetic product');
  });

  test(`${dialect}: current scope/RBAC/tenant/consent/revocation and configured shop fence every operation`, options, async t => {
    const f = await fixture(t, dialect);
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog.preview_create', arguments: { input: f.draft(), idempotencyKey: 'synthetic-no-auth-0001' } } };
    for (const authorization of [undefined, 'Bearer invalid', 'Bearer ' + secret()]) {
      const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(authorization ? { authorization } : {}) };
      assert.equal((await f.call('/mcp', 'POST', body, headers)).response.status, 401);
    }
    await f.store.run("UPDATE seller_account SET role = 'MANAGER' WHERE id = ?", f.account.id);
    const manager = dto(await f.previewCreate(f.draft({ sku: 'MANAGER' }))); assert.equal(manager.status, 'PENDING_APPROVAL');
    await f.store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", f.account.id);
    assert.equal((await f.previewCreate()).response.status, 401);
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    await f.store.run("UPDATE oauth_token SET scopes = 'catalog.read' WHERE token_hash = ?", hash(f.bearer));
    assert.equal((await f.previewCreate()).response.status, 403);
    await f.store.run("UPDATE oauth_token SET scopes = 'catalog.write' WHERE token_hash = ?", hash(f.bearer));
    await f.store.run("UPDATE oauth_grant SET tenant_id = 'other-shop' WHERE id = ?", f.grantId);
    assert.equal((await f.previewCreate()).response.status, 401);
    await f.store.run('UPDATE oauth_grant SET tenant_id = ? WHERE id = ?', f.binding.tenantId, f.grantId);
    await f.store.run("UPDATE shop_setup SET mode = 'demo' WHERE id = 1");
    assert.equal((await f.previewCreate()).response.status, 403);
    await f.store.run("UPDATE shop_setup SET mode = 'production' WHERE id = 1");
    await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id = ?', f.grantId);
    assert.equal((await f.previewCreate()).response.status, 403);
    await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', stamp(), f.grantId);
    assert.equal((await f.previewCreate()).response.status, 401);
    await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', f.grantId);
    await f.store.run('UPDATE oauth_token SET revoked_at = ? WHERE token_hash = ?', stamp(), hash(f.bearer));
    assert.equal((await f.previewCreate()).response.status, 401);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n, 0);
  });

  test(`${dialect}: product/history/approval and operation audit roll back together on failures`, options, async t => {
    const f = await fixture(t, dialect), original = f.store.run;
    const create = dto(await f.previewCreate()); await f.approve(create);
    f.store.run = async (sql, ...args) => { if (sql.includes('INSERT INTO product_event')) throw new Error('Synthetic product history failure'); return original(sql, ...args); };
    let failed;
    try { failed = await f.commit('create', create); } finally { f.store.run = original; }
    assert.equal(failed.data.error.code, -32603);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM listing')).n, 0);
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', create.operationId)).consumed_at, null);
    const target = await createProduct(f.store, f.draft());
    const update = dto(await f.previewUpdate(target.id, { name: 'Synthetic must roll back' })); await f.approve(update);
    const before = await f.store.get('SELECT sku, name, updated_at FROM product WHERE id = ?', target.id);
    f.store.run = async (sql, ...args) => { if (sql.includes('INSERT INTO mcp_v2_event') && args.includes('COMMIT')) throw new Error('Synthetic operation audit failure'); return original(sql, ...args); };
    try { failed = await f.commit('update', update); } finally { f.store.run = original; }
    assert.equal(failed.data.error.code, -32603); assert.deepEqual(await f.store.get('SELECT sku, name, updated_at FROM product WHERE id = ?', target.id), before);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event')).n, 0);
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id = ?', update.operationId)).consumed_at, null);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", update.operationId)).n, 0);
  });

  test(`${dialect}: metadata edits preserve 48-hour holds, confirmed stock accounting and immutable order snapshots`, options, async t => {
    const f = await fixture(t, dialect), target = await createProduct(f.store, f.draft({ stockQuantity: 4 }));
    await createOrder(f.store, 'synthetic-catalog-hold-order-0001', { buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
      deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
        items: [{ productId: target.id, quantity: 2, expectedPriceMinor: 1200, expectedCurrency: 'MYR' }] }] });
    const order = await f.store.get('SELECT id FROM shop_order');
    const snapshot = await f.store.get('SELECT sku_snapshot, name_snapshot, price_minor, quantity, currency FROM order_item');
    assert.equal(RESERVATION_HOURS, 48); assert.equal(await reservedQuantity(f.store, target.id), 2);
    const metadata = dto(await f.previewUpdate(target.id, { name: 'New catalog title', priceMinor: 1500 })); await f.approve(metadata);
    assert.equal(dto(await f.commit('update', metadata)).status, 'COMMITTED');
    assert.equal((await getProduct(f.store, target.id, true)).stockQuantity, 4); assert.equal(await reservedQuantity(f.store, target.id), 2);
    await f.store.run('UPDATE shop_order SET submitted_at = ? WHERE id = ?', new Date(Date.now() - 49 * 3600000).toISOString(), order.id);
    assert.equal(await reservedQuantity(f.store, target.id), 0);
    const pending = dto(await f.previewUpdate(target.id, { priceMinor: 1600 })); await f.approve(pending);
    await decideSellerOrder(f.store, order.id, 'confirm', { expectedRevision: 1 }, 'synthetic_owner');
    assert.equal(dto(await f.commit('update', pending)).error, 'STALE_REVISION');
    assert.equal((await getProduct(f.store, target.id, true)).stockQuantity, 2);
    await decideSellerOrder(f.store, order.id, 'cancel', { expectedRevision: 2, reason: 'Synthetic cancellation' }, 'synthetic_owner');
    assert.equal((await getProduct(f.store, target.id, true)).stockQuantity, 4);
    assert.deepEqual(await f.store.get('SELECT sku_snapshot, name_snapshot, price_minor, quantity, currency FROM order_item'), snapshot);
  });
}


test('implemented catalog contracts and synthetic examples match actual RPC descriptors', async t => {
  const f = await fixture(t, 'sqlite');
  const response = await f.call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { authorization: 'Bearer ' + f.bearer, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
  assert.equal(response.response.status, 200);
  const bundle = JSON.parse(readFileSync(new URL('../docs/mcp-v2/03-CATALOG-SAFE-IMPLEMENTED.json', import.meta.url), 'utf8'));
  const tools = response.data.result.tools.filter(tool => /^catalog\.(?:preview|commit)_/.test(tool.name));
  assert.equal(tools.length, 4); assert.equal(Object.keys(bundle.$defs).length, 8);
  assert.deepEqual(Object.keys(bundle['x-syntheticExamples']).sort(), tools.map(tool => tool.name).sort());
  for (const tool of tools) {
    assert.deepEqual(tool.inputSchema, bundle.$defs[tool.name + '.input']);
    assert.deepEqual(tool.outputSchema, bundle.$defs[tool.name + '.output']);
    assert.deepEqual(bundle['x-toolPolicies'][tool.name], { ...OPERATION_SCOPE_POLICIES[tool.name],
      risk: OPERATION_PREVIEW_RISKS[tool.name.replace('commit_', 'preview_')] });
    const example = bundle['x-syntheticExamples'][tool.name];
    assert.equal(valid(example.input, tool.inputSchema), true, tool.name + ' input');
    assert.equal(valid(example.output, tool.outputSchema), true, tool.name + ' output');
    if (tool.name.includes('preview_')) assert.equal(Object.hasOwn(example.input.input, 'expectedRevision'), false);
  }
});
