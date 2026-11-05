import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { createOptionType, createOptionValue } from '../src/options.js';
import { getProduct, updateProduct, applyPlannedProductUpdate } from '../src/products.js';
import { trackUpdate } from '../src/product-history.js';
import { prepareCatalogMediaUpdate, readCatalogMediaUpdateState } from '../src/mcp/catalog-media-update-state.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { readMediaUnionSnapshot } from '../src/mcp/media-resources.js';
import { readCatalogMediaBeforeGraph } from '../src/mcp/catalog-media-projection.js';
const photo = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');
async function fixture(t, dialect) {
  const f = await inventoryFixture(t, dialect); let sequence = 0;
  return { ...f, make: (group, extra = {}) => f.product({ sku: 'UPD-' + ++sequence,
    stockQuantity: 5, imageDataUrl: photo, ...(group ? { variantGroup: group, variantLabel: 'Label-' + sequence } : {}), ...extra }) };
}
function metadataReader(store) {
  const calls = [], invoke = (method, sql, args) => {
    assert.match(sql, /^SELECT\b/); assert.doesNotMatch(sql, /;|\b(?:image_data|thumb_data)\b/);
    calls.push(sql); return store[method](sql, ...args);
  };
  return { calls, read: { dialect: store.dialect, get: (sql, ...args) => invoke('get', sql, args), all: (sql, ...args) => invoke('all', sql, args) } };
}
async function digests(store) {
  return Promise.all(['product', 'listing', 'product_option', 'product_gallery_image', 'product_event', 'inventory_movement'].map(async table =>
    rowsDigest(await store.all('SELECT * FROM ' + table + ' ORDER BY ' + (table === 'product_option' ? 'product_id,option_type_id' : 'id')))));
}
async function planned(store, product, changes) {
  const intent = { productId: product.id, changes }, prepare = await prepareCatalogMediaUpdate(store, intent);
  const plannedIdentity = prepare.needsPlannedIdentity ? { productId: product.id, previousListingId: product.listingId,
    targetCode: prepare.targetPlan.code, newListingId: randomUUID() } : null;
  return readCatalogMediaUpdateState(store, { ...intent, plannedIdentity });
}
async function apply(store, state) {
  await trackUpdate(store, state.productId, 'synthetic_owner', () => state.plannedIdentity ?
    applyPlannedProductUpdate(store, { id: state.productId, changes: state.normalizedPatch }, state.plannedIdentity) :
    updateProduct(store, state.productId, state.normalizedPatch));
  for (const effect of state.catalog.products) {
    const actual = await getProduct(store, effect.productId, true), expected = effect.after;
    for (const key of ['id', 'listingId', 'sku', 'name', 'description', 'categoryCode', 'priceMinor', 'currency', 'active',
      'stockQuantity', 'variantGroup', 'variantLabel', 'createdAt']) assert.deepEqual(actual[key], expected[key], key);
    const pairs = actual.options.map(option => ({ typeId: option.type.id, valueId: option.value.id }))
      .sort((a, b) => a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0);
    assert.deepEqual(pairs, expected.options.map(({ typeId, valueId }) => ({ typeId, valueId })));
  }
  for (const effect of state.catalog.listings) {
    const actual = await store.get('SELECT id,code,name,description,category AS category_code FROM listing WHERE id=?', effect.listingId);
    assert.deepEqual(actual ? { id: actual.id, code: actual.code, name: actual.name, description: actual.description, categoryCode: actual.category_code } : null, effect.after);
  }
  const source = await store.get('SELECT id FROM listing WHERE id=?', state.state.metadata.selector.sourceListingId);
  const snapshot = await readMediaUnionSnapshot(store, state.productId, source ? { targetListingId: source.id } : {});
  const expected = structuredClone(state.projection.after), bind = id => id ?? state.plannedIdentity.newListingId;
  expected.products.forEach(row => { row.listingId = bind(row.listingId); });
  expected.listings.forEach(row => { row.listingId = bind(row.listingId); });
  expected.listings.sort((a, b) => a.listingId < b.listingId ? -1 : 1);
  const actualGraph = structuredClone(snapshot.before);
  actualGraph.listings.sort((a, b) => a.listingId < b.listingId ? -1 : 1);
  assert.deepEqual(actualGraph, expected);
  const aliases = new Map();
  for (const effect of state.projection.physicalEffects.filter(row => row.kind === 'COPY_MAIN')) {
    const gallery = snapshot.galleries.find(row => row.productId === effect.productId && row.position === effect.position);
    assert.ok(gallery);
    const actual = snapshot.sources.find(row => row.source_kind === 'GALLERY' && row.source_id === gallery.galleryId);
    for (const key of ['mime', 'byte_length', 'byte_sha256']) assert.deepEqual(actual[key], effect.source[key]);
    assert.deepEqual(actual.thumbnail, effect.thumbnail); aliases.set(effect.ref, gallery.galleryId);
  }
  const views = structuredClone(state.projection.afterViews);
  for (const view of views) for (const item of view.visible) item.id = aliases.get(item.id) ?? item.id;
  assert.deepEqual((await readCatalogMediaBeforeGraph(store, snapshot)).beforeViews, views);
  for (const before of state.state.mediaSnapshot.sources) {
    const actual = snapshot.sources.find(row => row.source_kind === before.source_kind && row.source_id === before.source_id && row.source_product_id === before.source_product_id);
    for (const key of ['mime', 'byte_length', 'byte_sha256', 'thumbnail']) assert.deepEqual(actual[key], before[key]);
  }
  assert.equal(snapshot.graphReadBytes.oldBytes, state.projection.graphReadBytes.afterOldBytes);
}
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  for (const mode of ['metadata', 'existing-target', 'private-leave', 'new-group']) test(`${dialect}: UPDATE state matches actual service for ${mode}`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('SOURCE'), sibling = await f.make('SOURCE'); await f.make('TARGET');
    const changes = mode === 'metadata' ? { sku: 'HOLDER-Z', description: '  Normalized description  ' } :
      { variantGroup: mode === 'existing-target' ? 'target' : mode === 'new-group' ? 'new-group' : '',
        ...(mode === 'private-leave' ? {} : { variantLabel: 'Moved' }), name: 'Submitted shared name' };
    const before = await digests(f.store), g = metadataReader(f.store);
    const prepared = await prepareCatalogMediaUpdate(g.read, { productId: source.id, changes });
    assert.ok(g.calls.some(sql => sql.includes('COUNT(*)')));
    assert.equal(prepared.needsPlannedIdentity, ['private-leave', 'new-group'].includes(mode));
    assert.deepEqual(await digests(f.store), before);
    const state = await planned(f.store, source, changes); assert.deepEqual(await digests(f.store), before);
    assert.ok(state.catalog.products.some(row => row.productId === sibling.id));
    assert.equal(state.beforeGraph.beforeViews.length, state.catalog.products.length);
    if (mode === 'existing-target') assert.equal(state.review.products.find(row => row.productId === source.id).after.name, 'Synthetic stock item');
    if (mode === 'private-leave') assert.equal(state.normalizedPatch.variantLabel, null);
    await apply(f.store, state);
  });
  test(`${dialect}: complete shared PATCH effects preserve omitted member drift`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('GROUP'), sibling = await f.make('GROUP');
    await f.store.run('UPDATE listing SET name=? WHERE id=?', 'Listing authority', source.listingId);
    await f.store.run('UPDATE product SET name=? WHERE id=?', 'Target drift', source.id);
    await f.store.run('UPDATE product SET name=? WHERE id=?', 'Sibling drift', sibling.id);
    let state = await planned(f.store, source, { description: 'Changed shared description' });
    assert.equal(state.review.products.length, 2);
    assert.equal(state.review.products.find(row => row.productId === sibling.id).after.name, 'Sibling drift');
    assert.equal(state.catalog.listings[0].after.name, 'Listing authority'); await apply(f.store, state);
    state = await planned(f.store, source, { name: 'Listing authority' });
    assert.equal(state.review.products.length, 2); await apply(f.store, state);
  });
  test(`${dialect}: options KEEP clear and replacement labels match post-row behavior`, options, async t => {
    const f = await fixture(t, dialect), type = await createOptionType(f.store, { name: 'Colour' });
    const red = await createOptionValue(f.store, type.id, { label: 'Red' }), blue = await createOptionValue(f.store, type.id, { label: 'Blue' });
    const choose = value => [{ typeId: type.id, valueId: value.id }], source = await f.make('GROUP', { options: choose(red) });
    await f.store.run('UPDATE product SET variant_label=? WHERE id=?', 'Manual drift', source.id);
    let state = await planned(f.store, source, { description: 'Keep choices' });
    assert.equal(state.review.products[0].after.variantLabel, 'Manual drift'); await apply(f.store, state);
    state = await planned(f.store, source, { options: choose(blue) });
    assert.equal(state.review.products[0].after.options[0].valueLabel, 'Blue'); await apply(f.store, state);
    state = await planned(f.store, source, { options: [] }); assert.equal(state.review.products[0].after.options.length, 0); await apply(f.store, state);
    await f.make('TARGET', { variantLabel: 'Blue' });
    await assert.rejects(planned(f.store, source, { variantGroup: 'TARGET', options: choose(red) }), { code: 'DUPLICATE_VARIANT' });
  });
  test(`${dialect}: occupied private identity rejects before BLOB reads and last source deletion is explicit`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('LAST'), target = await f.make('TARGET'), changes = { variantGroup: '' };
    for (const plannedIdentity of [null, { productId: source.id, previousListingId: source.listingId, targetCode: null, newListingId: target.listingId }]) {
      await assert.rejects(readCatalogMediaUpdateState(metadataReader(f.store).read, { productId: source.id, changes, plannedIdentity }), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    }
    const state = await planned(f.store, source, changes);
    assert.equal(state.catalog.listings.find(row => row.listingId === source.listingId).after, null);
    await apply(f.store, state); assert.equal(await f.store.get('SELECT id FROM listing WHERE id=?', source.listingId), undefined);
  });
  test(`${dialect}: closed stock/media authority fields budgets and history failure reject atomically`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('GROUP');
    for (const changes of [{ stockQuantity: 4 }, { gallery: [] }, { mediaPolicyId: 'catalog-media-v1' }, { password: 'untrusted' }]) {
      await assert.rejects(prepareCatalogMediaUpdate(f.store, { productId: source.id, changes }), { code: 'CATALOG_UPDATE_INPUT' });
    }
    await f.store.run('UPDATE product SET description=? WHERE id=?', 'x'.repeat(70000), source.id);
    const g = metadataReader(f.store);
    await assert.rejects(prepareCatalogMediaUpdate(g.read, { productId: source.id, changes: { sku: 'CHANGED' } }), { status: 503 });
    assert.equal(g.calls.some(sql => /^SELECT id, sku, name, description/.test(sql)), false);
    await f.store.run('UPDATE product SET description=? WHERE id=?', 'Restored description', source.id);
    const state = await planned(f.store, source, { variantGroup: 'NEW', variantLabel: 'Moved' }), before = await digests(f.store), run = f.store.run;
    f.store.run = async (sql, ...args) => { if (sql.startsWith('INSERT INTO product_event')) throw new Error('Synthetic history failure'); return run(sql, ...args); };
    try { await assert.rejects(apply(f.store, state), /Synthetic history failure/); } finally { f.store.run = run; }
    assert.deepEqual(await digests(f.store), before);
  });
  test(`${dialect}: derived Unicode and inactive current choices retain exact stored semantics`, options, async t => {
    const f = await fixture(t, dialect), a = await createOptionType(f.store, { name: 'First', position: 1 }), b = await createOptionType(f.store, { name: 'Second', position: 2 });
    const first = await createOptionValue(f.store, a.id, { label: 'A'.repeat(76) }), second = await createOptionValue(f.store, b.id, { label: '😀B' });
    const choices = [{ typeId: a.id, valueId: first.id }, { typeId: b.id, valueId: second.id }], source = await f.make('GROUP', { options: choices });
    await f.store.run('UPDATE option_value SET active=0 WHERE id=?', second.id);
    const state = await planned(f.store, source, { options: [...choices].reverse() });
    assert.equal(state.review.products[0].after.variantLabel, 'A'.repeat(76) + ' / �');
    assert.equal(state.review.products[0].after.options.find(row => row.valueId === second.id).valueActive, false);
    await apply(f.store, state);
  });
  test(`${dialect}: thumbnail-only changes invalidate revision and currency/category validators stay authoritative`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('GROUP'), changes = { description: 'Reviewed description' };
    const first = await planned(f.store, source, changes), updated = (await f.store.get('SELECT updated_at FROM product WHERE id=?', source.id)).updated_at;
    await f.store.run('UPDATE product SET thumb_mime=?,thumb_data=? WHERE id=?', 'image/png', Buffer.from(photo.split(',')[1], 'base64'), source.id);
    assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id=?', source.id)).updated_at, updated);
    assert.notEqual((await planned(f.store, source, changes)).baseRevision, first.baseRevision);
    await f.store.run("UPDATE company_setting SET default_currency='SGD' WHERE id=1");
    await assert.rejects(planned(f.store, source, { priceMinor: 700 }), { code: 'COMPANY_CURRENCY_CONFLICT' });
    await assert.rejects(planned(f.store, source, { category: 'MISSING' }), { field: 'category' });
  });
  test(`${dialect}: changed-only review retains complete affected metadata and fails size gates before BLOBs`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('LARGE', { description: 'D'.repeat(2000) });
    for (let n = 0; n < 16; n++) await f.make('LARGE', { description: 'D'.repeat(2000) });
    const single = await prepareCatalogMediaUpdate(metadataReader(f.store).read, { productId: source.id, changes: { sku: 'REVIEWED' } });
    assert.equal(single.catalog.products.length, 17); assert.equal(single.review.products.length, 1);
    await assert.rejects(prepareCatalogMediaUpdate(metadataReader(f.store).read,
      { productId: source.id, changes: { description: 'E'.repeat(2000) } }), { code: 'CATALOG_REVIEW_TOO_LARGE' });
    await f.store.run('UPDATE company_setting SET availability_text=? WHERE id=1', 'S'.repeat(1000));
    const g = metadataReader(f.store);
    await prepareCatalogMediaUpdate(g.read, { productId: source.id, changes: { sku: 'REVIEWED' } });
    const preflight = g.calls.findIndex(sql => sql.includes(' AS bytes FROM company_setting'));
    assert.ok(preflight >= 0 && preflight < g.calls.findIndex(sql => sql.startsWith('SELECT default_currency, seller_whatsapp_phone')));
  });
  test(`${dialect}: real intervening portal edit makes recapture fail without hiding the committed edit`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('GROUP'), read = metadataReader(f.store).read, get = read.get;
    let changed = false;
    read.get = async (sql, ...args) => {
      const result = await get(sql, ...args);
      if (!changed && sql === 'SELECT id FROM product WHERE id = ?') {
        changed = true; await updateProduct(f.store, source.id, { name: 'Intervening portal change' });
      }
      return result;
    };
    await assert.rejects(readCatalogMediaUpdateState(read,
      { productId: source.id, changes: { description: 'Proposed' }, plannedIdentity: null }), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    assert.equal(changed, true); assert.equal((await getProduct(f.store, source.id, true)).name, 'Intervening portal change');
  });
  test(`${dialect}: outside-listing SKU phantom between validation and recapture denies`, options, async t => {
    const f = await fixture(t, dialect), source = await f.make('GROUP'), read = metadataReader(f.store).read, get = read.get;
    let inserted = false;
    read.get = async (sql, ...args) => {
      const result = await get(sql, ...args);
      if (!inserted && sql === 'SELECT id FROM product WHERE id = ?') { inserted = true; await f.make('OUTSIDE', { sku: 'DESIRED' }); }
      return result;
    };
    await assert.rejects(readCatalogMediaUpdateState(read,
      { productId: source.id, changes: { sku: 'DESIRED' }, plannedIdentity: null }), { code: 'CATALOG_DEPENDENCY_CHANGED' });
    assert.equal(inserted, true); assert.equal((await getProduct(f.store, source.id, true)).sku, source.sku);
  });
}
