import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaEngineFixture } from './helpers/mcp-media-engine-fixture.js';
import { png, stubDecode } from './helpers/mcp-media-coordinator-fixture.js';
import { createCategory } from '../src/settings.js';
import { createProduct, getProduct, updateProduct, setProductThumbnail, addGalleryImage } from '../src/products.js';
import { createMediaNativeSession } from '../src/mcp/media-native.js';
import { catalogMediaUpdateAdapter, catalogMediaUpdateTool, parseCatalogMediaUpdateProposal, readCatalogMediaUpdateReview } from '../src/mcp/catalog-media-adapter.js';
import { persistMediaFrame } from '../src/mcp/media-frame-storage.js';
import { readCatalogMediaState } from '../src/mcp/catalog-media-state.js';
import { mediaManifestRows } from '../src/mcp/media-manifest.js';
import { canonicalOperationJson, operationPreviewHash } from '../src/mcp/operation-envelope.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { operationReceiptExpiry } from '../src/mcp/operation-maintenance.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { recordOperationCall } from '../src/mcp/audit.js';
import { rowsDigest } from '../src/sqlite-import.js';

const photo = label => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(label)]).toString('base64');
async function fixture(t, dialect) {
  const f = await mediaEngineFixture(t, dialect); await createCategory(f.store, { code: 'TEST', label: 'Synthetic' });
  let sequence = 0, phase = 'idle', calls = 0;
  const codec = { socketPath: '/synthetic/not-contacted.sock', token: 'A'.repeat(43), digest: 'd'.repeat(64) };
  const runtime = { codecDigest: codec.digest, nativeSession: options => createMediaNativeSession(codec, { ...options, decode: async packet => {
    assert.equal(phase, 'resolve'); assert.equal(f.depth(), 0); calls++; return stubDecode(packet);
  } }) };
  const adapter = catalogMediaUpdateAdapter(runtime);
  const make = (group, extra = {}) => createProduct(f.store, { sku: 'ADAPTER-' + ++sequence, name: 'Synthetic product', description: 'Synthetic',
    category: 'TEST', priceMinor: 500, currency: 'MYR', active: true, stockQuantity: 5,
    imageDataUrl: photo('main-' + sequence), ...(group ? { variantGroup: group, variantLabel: 'Label-' + sequence } : {}), ...extra });
  async function draft(args) {
    phase = 'capture';
    const captured = await f.options.tenantGuard.withActiveTenant(f.context.tenantId,
      () => f.store.transaction(() => adapter.media.capture(f.store, args, f.context)));
    phase = 'resolve';
    const methods = ['get', 'all', 'run', 'exec', 'transaction'], originals = new Map(methods.map(name => [name, f.store[name]]));
    for (const name of methods) f.store[name] = () => { throw new Error('Database access during resolve.'); };
    let resolved;
    try { resolved = await adapter.media.resolve(captured.resources, { signal: new AbortController().signal, deadline: performance.now() + 30000 }); }
    finally { for (const [name, method] of originals) f.store[name] = method; phase = 'preview'; }
    const value = await f.options.tenantGuard.withActiveTenant(f.context.tenantId,
      () => f.store.transaction(() => adapter.preview(f.store, args, resolved, f.context)));
    phase = 'idle'; return { captured, resolved, value };
  }
  return { ...f, adapter, runtime, make, draft, nativeCalls: () => calls };
}

// SYNTHETIC retained-frame fixture only. No approval row or HTTP permission is
// invented; these direct adapter tests are not human/native/C activation proof.
async function seedFrame(f, draft) {
  const id = randomUUID(), c = f.context, now = f.now, expires = new Date(Date.parse(now) + 600000).toISOString();
  const proposal = { ...draft.proposal, media: draft.mediaManifest.descriptor };
  const envelope = { version: 1, operationId: id, tenantId: c.tenantId, tenantRevision: c.tenantRevision, accountId: c.accountId,
    clientId: c.clientId, grantId: c.grantId, epochHash: c.epochHash, buildDigest: c.buildDigest, issuer: c.issuer, resource: c.resource,
    toolName: 'catalog.preview_update', resourceType: 'product', resourceId: draft.resourceId, expectedRevision: draft.expectedRevision,
    requiredScope: 'catalog.write', requiredCapability: 'catalog.write', risk: 'HIGH', createdAt: now, expiresAt: expires,
    idempotencyHash: mediaHash(id), correlationId: randomUUID(), proposal };
  await f.store.transaction(async () => {
    const columns = ['id', 'tenant_id', 'tenant_revision', 'account_id', 'client_id', 'grant_id', 'epoch_hash', 'build_digest', 'issuer', 'resource',
      'tool_name', 'required_scope', 'required_capability', 'risk', 'resource_type', 'resource_id', 'expected_revision', 'envelope_json',
      'preview_hash', 'request_hash', 'idempotency_hash', 'state', 'created_at', 'expires_at', 'receipt_expires_at', 'correlation_id'];
    const values = [id, c.tenantId, c.tenantRevision, c.accountId, c.clientId, c.grantId, c.epochHash, c.buildDigest, c.issuer, c.resource,
      envelope.toolName, envelope.requiredScope, envelope.requiredCapability, envelope.risk, envelope.resourceType, envelope.resourceId,
      envelope.expectedRevision, canonicalOperationJson(envelope), operationPreviewHash(envelope), mediaHash('request-' + id), envelope.idempotencyHash,
      'PREPARED', now, expires, operationReceiptExpiry(c.grantExpiresAt), envelope.correlationId];
    await f.store.run(`INSERT INTO mcp_v2_operation(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...values);
    const policy = mediaManifestRows(draft.mediaManifest, { operationId: id, toolName: envelope.toolName, createdAt: now, expiresAt: expires }).policy;
    const keys = ['operation_id', 'policy_id', 'required_scopes', 'descriptor_hash', 'manifest_root', 'graph_revision', 'codec_digest', 'page_count', 'asset_count', 'effect_count', 'created_at', 'expires_at'];
    await f.store.run(`INSERT INTO mcp_v2_operation_media_policy(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(key => policy[key]));
    await f.store.run("UPDATE mcp_v2_operation SET media_policy_id='catalog-media-v1' WHERE id=?", id);
    await persistMediaFrame(f.store, c, id, draft.mediaManifest);
  });
  return { id, envelope, proposal, applyContext: { accountId: c.accountId, clientId: c.clientId, grantId: c.grantId,
    operationId: id, correlationId: envelope.correlationId, mediaContext: c } };
}

async function commerceDigest(store) {
  const out = [];
  for (const table of ['product', 'listing', 'product_option', 'product_gallery_image', 'product_event', 'inventory_movement']) {
    out.push(rowsDigest(await store.all('SELECT * FROM ' + table + ' ORDER BY ' + (table === 'product_option' ? 'product_id,option_type_id' : 'id'))));
  }
  return out;
}
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  for (const mode of ['metadata', 'existing-target', 'private-leave', 'new-group']) test(`${dialect}: private adapter ${mode} uses real services and lock-free synthetic decode`, options, async t => {
    const f = await fixture(t, dialect), target = await f.make('TARGET');
    await setProductThumbnail(f.store, target.id, photo('target-thumb'));
    const source = await f.make('SOURCE');
    const args = { id: source.id, changes: mode === 'metadata' ? { sku: 'NORMALIZED', description: '  Reviewed description  ' } :
      { variantGroup: mode === 'existing-target' ? 'TARGET' : mode === 'new-group' ? 'NEW' : '', ...(mode === 'private-leave' ? {} : { variantLabel: 'Moved' }) } };
    const original = await commerceDigest(f.store), { captured, resolved, value } = await f.draft(args);
    assert.ok(f.nativeCalls() >= 1); assert.deepEqual(await commerceDigest(f.store), original);
    assert.equal(value.expectedRevision, captured.expectedRevision);
    const op = await seedFrame(f, value); parseCatalogMediaUpdateProposal(op.proposal);
    await f.adapter.media.persistResources(null, op.envelope, resolved, f.context);
    assert.deepEqual(await f.adapter.currentRevision(f.store, op.envelope), { exists: true, revision: value.expectedRevision });
    const result = await f.adapter.apply(f.store, op.proposal, op.applyContext);
    assert.equal(await f.adapter.validReceipt(result), true); assert.notEqual(result.revision, value.expectedRevision);
    const actual = await getProduct(f.store, source.id, true);
    assert.equal(result.productId, actual.id); assert.equal(result.listingId, actual.listingId);
    assert.equal(result.revision, (await readCatalogMediaState(f.store, { productId: source.id,
      changes: op.proposal.normalizedInput, plannedIdentity: null })).revision);
    if (mode === 'existing-target') assert.equal(actual.listingId, target.listingId);
    if (mode === 'private-leave' || mode === 'new-group') assert.equal(actual.listingId, op.proposal.plannedIdentity.newListingId);
    const history = await f.store.all('SELECT actor FROM product_event WHERE product_id=?', source.id);
    assert.equal(history.length, 1); assert.equal(history[0].actor, f.account.username);
    await assert.rejects(f.adapter.apply(f.store, op.proposal, op.applyContext), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?', source.id)).n, 1);
    await f.adapter.media.consumeResources(null, op.envelope, f.context);
    for (const table of ['mcp_v2_media_stage', 'mcp_v2_approval', 'mcp_v2_approval_challenge']) assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM ' + table)).n, 0);
  });
  test(`${dialect}: private factory stays unregistrable and readers reject missing or injected inputs`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('SOURCE');
    assert.throws(() => createOperationTools({ store: f.store, binding: f.binding, quickLogin: false, tenantGuard: f.options.tenantGuard,
      config: { mcpEnabled: true, production: false, shopMode: 'manual', mcpV2: { enabled: true, epoch: f.epoch, buildDigest: f.context.buildDigest },
        mcpMedia: { enabled: true } }, entries: [catalogMediaUpdateTool(f.runtime)] }), TypeError);
    for (const changes of [{ stockQuantity: 4 }, { imageDataUrl: null }, { approved: true }, { mediaPolicyId: 'catalog-media-v1' },
      { sku: 'BAD SKU' }, { name: 'x'.repeat(121) }, { category: 'MISSING' }]) {
      await assert.rejects(f.adapter.media.capture(f.store, { id: source.id, changes }, f.context), { code: 'CATALOG_UPDATE_INPUT' });
    }
    await assert.rejects(readCatalogMediaUpdateReview(f.store,
      { productId: randomUUID(), normalizedInput: { name: 'Missing' }, plannedIdentity: null }, f.runtime.codecDigest), { status: 400, code: 'NOT_FOUND' });
    assert.equal(f.nativeCalls(), 0);
    const { value } = await f.draft({ id: source.id, changes: { description: 'Reviewed' } });
    const proposal = { ...value.proposal, media: value.mediaManifest.descriptor };
    for (const patch of [{ approved: true }, { normalizedInput: { stockQuantity: 7 } }, { plannedIdentity: { productId: source.id } }]) {
      assert.throws(() => parseCatalogMediaUpdateProposal({ ...proposal, ...patch }));
    }
    assert.throws(() => parseCatalogMediaUpdateProposal({ ...proposal,
      catalogReview: { ...proposal.catalogReview, warnings: ['APPROVED'] } }), { code: 'CATALOG_UPDATE_INPUT' });
    const otherCodec = catalogMediaUpdateAdapter({ ...f.runtime, codecDigest: 'e'.repeat(64) });
    assert.deepEqual(await otherCodec.currentRevision(f.store, { resourceId: source.id, resourceType: 'product', proposal }), { exists: true, revision: null });
  });
  test(`${dialect}: portal staleness and cross-product source substitution deny before adapter writes`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('SOURCE'), args = { id: source.id, changes: { description: 'Reviewed' } };
    const { resolved, value } = await f.draft(args), bad = structuredClone(resolved), before = await commerceDigest(f.store);
    bad.sources[0].source_product_id = randomUUID();
    await assert.rejects(f.adapter.preview(f.store, args, bad, f.context), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    await assert.rejects(f.adapter.preview(f.store, args, resolved, { ...f.context, grantId: randomUUID() }), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    assert.deepEqual(await commerceDigest(f.store), before);
    const op = await seedFrame(f, value);
    await updateProduct(f.store, source.id, { name: 'Portal edit after native phase' });
    assert.notEqual((await f.adapter.currentRevision(f.store, op.envelope)).revision, value.expectedRevision);
    await assert.rejects(f.adapter.preview(f.store, args, resolved, f.context), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    const changed = await commerceDigest(f.store);
    await assert.rejects(f.adapter.apply(f.store, op.proposal, op.applyContext), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    assert.deepEqual(await commerceDigest(f.store), changed);
  });
  test(`${dialect}: unexpected after effects history typed audit and invalid receipts roll commerce back`, options, async t => {
    const f = await fixture(t, dialect), target = await f.make('TARGET'), source = await f.make('SOURCE');
    const { value } = await f.draft({ id: source.id, changes: { variantGroup: 'TARGET', variantLabel: 'Moved' } });
    const op = await seedFrame(f, value), baseline = await commerceDigest(f.store);
    for (const fault of ['after', 'history', 'audit', 'receipt']) {
      const run = f.store.run; let injected = false;
      f.store.run = async (sql, ...args) => {
        if (fault === 'history' && sql.startsWith('INSERT INTO product_event') || fault === 'audit' && sql.startsWith('INSERT INTO mcp_audit')) {
          injected = true; throw new Error('Synthetic ' + fault + ' failure');
        }
        const result = await run(sql, ...args);
        if (fault === 'after' && !injected && sql.startsWith('UPDATE product SET listing_id =')) {
          injected = true; await run('UPDATE product SET stock_quantity=stock_quantity+1 WHERE id=?', target.id);
        }
        return result;
      };
      try {
        await assert.rejects(f.store.transaction(async () => {
          const result = await f.adapter.apply(f.store, op.proposal, op.applyContext);
          if (fault === 'receipt') {
            injected = true;
            assert.equal(await f.adapter.validReceipt({ ...result, privateNote: 'Must never be persisted.' }), false);
            throw new Error('Synthetic receipt failure');
          }
          await recordOperationCall(f.store, await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?', op.id), 'catalog.commit_update', 'COMMITTED');
        }), fault === 'after' ? { code: 'CATALOG_DEPENDENCY_CHANGED' } : new RegExp('Synthetic ' + fault + ' failure'));
      } finally { f.store.run = run; }
      assert.equal(injected, true, fault); assert.deepEqual(await commerceDigest(f.store), baseline, fault);
      assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event='CALL'")).n, 0);
    }
  });
  test(`${dialect}: retained frame tampering prevents a business write`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('SOURCE');
    const { value } = await f.draft({ id: source.id, changes: { description: 'Reviewed' } }), op = await seedFrame(f, value);
    const before = await commerceDigest(f.store);
    await f.store.run("UPDATE mcp_v2_media_manifest_page SET page_json='{}' WHERE operation_id=?", op.id);
    await assert.rejects(f.adapter.apply(f.store, op.proposal, op.applyContext), { status: 503, code: 'MEDIA_FRAME_INTEGRITY' });
    assert.deepEqual(await commerceDigest(f.store), before);
  });
  test(`${dialect}: native failure and deadline cannot persist a proposal or change commerce`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('SOURCE'), args = { id: source.id, changes: { description: 'Reviewed' } };
    const captured = await f.options.tenantGuard.withActiveTenant(f.context.tenantId,
      () => f.store.transaction(() => f.adapter.media.capture(f.store, args, f.context)));
    const before = await commerceDigest(f.store);
    await assert.rejects(f.adapter.media.resolve(captured.resources,
      { signal: new AbortController().signal, deadline: performance.now() - 1 }), { status: 503, code: 'MEDIA_DEADLINE' });
    const bad = structuredClone(captured.resources); bad.old[0].bytes[0] ^= 1;
    await assert.rejects(f.adapter.media.resolve(bad,
      { signal: new AbortController().signal, deadline: performance.now() + 30000 }), { status: 503, code: 'MEDIA_CODEC_FAILED' });
    assert.deepEqual(await commerceDigest(f.store), before);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });
  test(`${dialect}: hidden unused assets bind the raw revision while native receives only used fixed references`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('SOURCE');
    await addGalleryImage(f.store, source.id, photo('visible-upload'));
    await addGalleryImage(f.store, source.id, photo('hidden-upload'));
    const uploads = await f.store.all('SELECT id FROM product_gallery_image WHERE product_id=? ORDER BY position', source.id);
    const visible = uploads.at(-2), hidden = uploads.at(-1);
    assert.ok(visible && hidden);
    await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?', JSON.stringify([visible.id]), source.id);
    const args = { id: source.id, changes: { description: 'Reviewed' } }, { captured, resolved, value } = await f.draft(args);
    const prepared = await readCatalogMediaUpdateReview(f.store, { productId: source.id,
      normalizedInput: value.proposal.normalizedInput, plannedIdentity: null }, f.runtime.codecDigest);
    assert.equal(prepared.state.mediaSnapshot.assets.length, 3);
    assert.equal(captured.resources.old.length, 2); assert.equal(resolved.sources.length, 2); assert.equal(f.nativeCalls(), 2);
    for (const item of captured.resources.old) assert.deepEqual(Object.keys(item.ref).sort(),
      ['source_kind', 'source_id', 'source_product_id', 'stage_id', 'byte_sha256', 'mime', 'byte_length'].sort());
    const at = (await f.store.get('SELECT updated_at FROM product WHERE id=?', source.id)).updated_at;
    await f.store.run('UPDATE product_gallery_image SET thumb_mime=?,thumb_data=? WHERE id=?', 'image/png', png, hidden.id);
    assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id=?', source.id)).updated_at, at);
    await assert.rejects(f.adapter.preview(f.store, args, resolved, f.context), { code: 'CATALOG_DEPENDENCY_CHANGED' });
  });
}
