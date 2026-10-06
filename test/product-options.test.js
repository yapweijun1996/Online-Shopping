import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { setupShop } from '../src/shop-setup.js';
import { createApi } from '../src/app.js';
import { createSession } from '../src/auth.js';
import { createCategory } from '../src/settings.js';
import { createProduct, updateProduct, getProduct } from '../src/products.js';
import { createOptionType, createOptionValue, updateOptionType, updateOptionValue, listOptionTypes, migrateLegacyVariants } from '../src/options.js';
import { OPTION_LIMITS } from '../src/option-limits.js';

async function fixture(t) {
  const store = await openDatabase(':memory:'); t.after(async () => await store.close());
  await setupShop(store, { mode: 'production', shopName: 'Synthetic shop' });
  await createCategory(store, { code: 'PHONE', label: 'Phones' });
  return store;
}
const base = (sku, extra = {}) => ({ sku, name: `Phone ${sku}`, description: 'Synthetic phone', category: 'PHONE', priceMinor: 199900, currency: 'MYR', active: true, ...extra });

async function library(store) {
  const color = await createOptionType(store, { name: 'Colour', display: 'swatch', translations: { 'zh-Hans': '颜色' } });
  const storage = await createOptionType(store, { name: 'Storage' });
  const burgundy = await createOptionValue(store, color.id, { label: 'Burgundy', swatchColor: '#7a1f3d' });
  const glacier = await createOptionValue(store, color.id, { label: 'Glacier', swatchColor: '#B7C7DD' });
  const s256 = await createOptionValue(store, storage.id, { label: '256GB' });
  const s512 = await createOptionValue(store, storage.id, { label: '512GB' });
  return { color, storage, burgundy, glacier, s256, s512 };
}

test('option types and values are tenant-defined, validated and never predefined', async t => {
  const store = await fixture(t);
  assert.deepEqual(await listOptionTypes(store), [], 'no option is predefined');
  const type = await createOptionType(store, { name: '材质', display: 'dropdown' });
  assert.equal(type.code.startsWith('type-'), true, 'a name without latin letters still gets a stable code');
  const color = await createOptionType(store, { name: 'Colour', translations: { ms: 'Warna', 'zh-Hans': '颜色' } });
  assert.equal(color.code, 'colour'); assert.equal(color.display, 'button'); assert.deepEqual(color.translations, { ms: 'Warna', 'zh-Hans': '颜色' });
  await assert.rejects(() => createOptionType(store, { name: 'colour' }), /already exists/);
  await assert.rejects(() => createOptionType(store, { name: 'Size', display: 'carousel' }), /Choose button/);
  await assert.rejects(() => createOptionType(store, { name: 'Size', translations: { 'not a locale': 'x' } }), /valid language codes/);
  await assert.rejects(() => createOptionType(store, { name: 'Size', unknown: 1 }), /supported option fields/);
  const red = await createOptionValue(store, color.id, { label: 'Red', swatchColor: '#FF0000' });
  assert.equal(red.swatchColor, '#ff0000'); assert.equal(red.code, 'red');
  await assert.rejects(() => createOptionValue(store, color.id, { label: 'red' }), /already exists/);
  await assert.rejects(() => createOptionValue(store, color.id, { label: 'Blue', swatchColor: 'blue' }), /colour such as/);
  const renamed = await updateOptionType(store, color.id, { name: 'Color', active: false });
  assert.equal(renamed.name, 'Color'); assert.equal(renamed.active, false);
  assert.equal((await updateOptionValue(store, color.id, red.id, { swatchColor: null, position: 3 })).swatchColor, null);
});

test('products pick one value per type; the group must use the same types and unique combinations', async t => {
  const store = await fixture(t);
  const o = await library(store);
  const a = await createProduct(store, base('PH-1', { variantGroup: 'phone-x', stockQuantity: 5,
    options: [{ typeId: o.color.id, valueId: o.burgundy.id }, { typeId: o.storage.id, valueId: o.s256.id }] }));
  assert.equal(a.variantLabel, 'Burgundy / 256GB', 'the display label is derived from the chosen values');
  assert.deepEqual(a.options.map(item => [item.type.name, item.value.label]), [['Colour', 'Burgundy'], ['Storage', '256GB']]);
  const b = await createProduct(store, base('PH-2', { variantGroup: 'phone-x', priceMinor: 229900,
    options: [{ typeId: o.color.id, valueId: o.burgundy.id }, { typeId: o.storage.id, valueId: o.s512.id }] }));
  await createProduct(store, base('PH-3', { variantGroup: 'phone-x', stockQuantity: 0,
    options: [{ typeId: o.color.id, valueId: o.glacier.id }, { typeId: o.storage.id, valueId: o.s256.id }] }));
  // duplicate combination, a different set of types, a missing group and a repeated type are all refused
  await assert.rejects(() => createProduct(store, base('PH-4', { variantGroup: 'phone-x', options: [{ typeId: o.color.id, valueId: o.burgundy.id }, { typeId: o.storage.id, valueId: o.s256.id }] })), /already exists/);
  await assert.rejects(() => createProduct(store, base('PH-5', { variantGroup: 'phone-x', options: [{ typeId: o.color.id, valueId: o.glacier.id }] })), /same option types/);
  await assert.rejects(() => createProduct(store, base('PH-6', { options: [{ typeId: o.color.id, valueId: o.glacier.id }] })), /variant group/);
  await assert.rejects(() => createProduct(store, base('PH-7', { variantGroup: 'phone-y', options: [{ typeId: o.color.id, valueId: o.glacier.id }, { typeId: o.color.id, valueId: o.burgundy.id }] })), /only once/);
  await assert.rejects(() => createProduct(store, base('PH-8', { variantGroup: 'phone-y', options: [{ typeId: o.color.id, valueId: o.s256.id }] })), /existing option value/);
  // a group described by options cannot take a plain label variant
  await assert.rejects(() => createProduct(store, base('PH-9', { variantGroup: 'phone-x', variantLabel: 'Plain' })), /described by option types/);
  const detail = await getProduct(store, b.id);
  assert.deepEqual(detail.variants.map(variant => variant.label).sort(), ['Burgundy / 256GB', 'Burgundy / 512GB', 'Glacier / 256GB']);
  assert.deepEqual(detail.optionTypes.map(axis => [axis.name, axis.values.map(value => value.label)]), [['Colour', ['Burgundy', 'Glacier']], ['Storage', ['256GB', '512GB']]]);
  assert.deepEqual(detail.variants.find(variant => variant.sku === 'PH-3').inStock, false);
  // moving a product out of the group clears its options; renaming a value refreshes the labels
  await updateOptionValue(store, o.color.id, o.burgundy.id, { label: 'Wine' });
  assert.equal((await getProduct(store, a.id, true)).variantLabel, 'Wine / 256GB');
  const moved = await updateProduct(store, b.id, { variantGroup: null });
  assert.deepEqual(moved.options, []);
  await assert.rejects(() => updateProduct(store, a.id, { options: [] }), /described by option types/, 'a member of an option group cannot drop its options');
});

test('inactive values cannot be assigned, and limits are enforced', async t => {
  const store = await fixture(t);
  const o = await library(store);
  await updateOptionValue(store, o.color.id, o.glacier.id, { active: false });
  await assert.rejects(() => createProduct(store, base('PH-1', { variantGroup: 'g', options: [{ typeId: o.color.id, valueId: o.glacier.id }] })), /inactive/);
  const many = await createOptionType(store, { name: 'Many' });
  for (let n = 0; n < OPTION_LIMITS.valuesPerType; n++) await createOptionValue(store, many.id, { label: `V${n}` });
  await assert.rejects(() => createOptionValue(store, many.id, { label: 'One too many' }), /at most/);
});

test('single-label variants from the previous schema become one tenant option type', async t => {
  const store = await fixture(t);
  await createProduct(store, base('OLD-1', { variantGroup: 'bowl', variantLabel: 'Small' }));
  await createProduct(store, base('OLD-2', { variantGroup: 'bowl', variantLabel: 'Large' }));
  await createProduct(store, base('OLD-3', { variantGroup: 'mug', variantLabel: 'small' }));
  assert.equal(await migrateLegacyVariants(store), 3);
  assert.equal(await migrateLegacyVariants(store), 0, 'running again changes nothing');
  const [type] = await listOptionTypes(store);
  assert.equal(type.name, 'Option'); assert.deepEqual(type.values.map(value => value.label).sort(), ['Large', 'Small']);
  // the converted group now uses options, so a new member must choose one
  const small = type.values.find(value => value.label === 'Small');
  await assert.rejects(() => createProduct(store, base('OLD-4', { variantGroup: 'bowl', options: [{ typeId: type.id, valueId: small.id }] })), /already exists/);
  const medium = await createOptionValue(store, type.id, { label: 'Medium' });
  const added = await createProduct(store, base('OLD-5', { variantGroup: 'bowl', options: [{ typeId: type.id, valueId: medium.id }] }));
  assert.equal(added.variantLabel, 'Medium');
});

test('seller API manages the library with CSRF and the product API accepts options', async t => {
  const store = await fixture(t);
  const config = { shopMode: 'manual', production: false, publicOrigin: 'http://fixture.test' };
  const api = await createApi({ store, config }), session = await createSession(store);
  const call = async (path, method = 'GET', body, auth = true) => {
    const response = await api(new Request('http://fixture.test' + path, {
      method, headers: { ...(auth ? { cookie: 'seller_session=' + session.token, 'x-csrf-token': session.csrfToken } : {}),
        ...(method === 'GET' ? {} : { origin: 'http://fixture.test', 'content-type': 'application/json' }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { clientAddress: 'synthetic-client' });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call('/api/v1/seller/option-types', 'GET', undefined, false)).status, 401);
  const type = await call('/api/v1/seller/option-types', 'POST', { name: 'Size' });
  assert.equal(type.status, 201);
  const value = await call(`/api/v1/seller/option-types/${type.data.id}/values`, 'POST', { label: 'Large' });
  assert.equal(value.status, 201);
  const noCsrf = await api(new Request('http://fixture.test/api/v1/seller/option-types', { method: 'POST', headers: { cookie: 'seller_session=' + session.token, origin: 'http://fixture.test', 'content-type': 'application/json' }, body: '{"name":"X"}' }), { clientAddress: 'c' });
  assert.equal(noCsrf.status, 403);
  const product = await call('/api/v1/seller/products', 'POST', base('API-1', { variantGroup: 'tee', options: [{ typeId: type.data.id, valueId: value.data.id }] }));
  assert.equal(product.status, 201);
  assert.equal(product.data.variantLabel, 'Large');
  const publicDetail = await call(`/api/v1/products/${product.data.id}`, 'GET', undefined, false);
  assert.deepEqual(publicDetail.data.options.map(item => item.value.label), ['Large']);
  assert.equal((await call(`/api/v1/seller/option-types/${type.data.id}`, 'PATCH', { active: false })).data.active, false);
  assert.equal((await call('/api/v1/seller/option-types')).data.items.length, 1);
  assert.deepEqual((await call('/api/v1/seller/option-types')).data.limits, OPTION_LIMITS);
});
