import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';
import { parseCsv } from '../src/product-import.js';

const HEADER = 'SKU,Name,Description,Category,Variant group,Variant label,Currency,Price,Stock (blank = unlimited),Active,Updated (UTC)';

const api = (f, headers) => ({
  preview: (csv) => f.request('POST', '/api/v1/seller/products/import', { csv, commit: false }, headers),
  commit: (csv) => f.request('POST', '/api/v1/seller/products/import', { csv, commit: true }, headers),
  exported: async (query = '') => (await f.request('GET', `/api/v1/seller/products/export.csv${query}`, null, headers)).data,
  state: async () => (await f.app.database.all('SELECT sku, name, price_minor, stock_quantity, active FROM product ORDER BY sku')).map((row) => ({ ...row })),
});

test('the CSV reader handles quotes, commas, line breaks, CRLF and a byte-order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nline2"\r\n'), [['a', 'b'], ['x, y', 'say "hi"\nline2']]);
  assert.deepEqual(parseCsv('a,b\n\n1,\n'), [['a', 'b'], ['1', '']]);
  assert.throws(() => parseCsv('a,"open'), /unclosed quote/);
});

test('an exported file imports back as "unchanged", and nothing is written', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { preview, commit, exported, state } = api(f, headers);
    await f.request('POST', '/api/v1/seller/products', { sku: 'RT-1', name: '=Danger, "name"', description: 'Line one', category: 'EXAMPLES', priceMinor: 1999, stockQuantity: 3, active: true }, headers);
    await f.request('POST', '/api/v1/seller/products', { sku: 'RT-2', name: 'Unlimited', description: 'Plain', category: 'EXAMPLES', priceMinor: 500, active: false }, headers);
    const before = await state();
    const csv = await exported();
    const plan = await preview(csv);
    assert.equal(plan.response.status, 200, JSON.stringify(plan.data));
    assert.deepEqual(plan.data.summary, { create: 0, update: 0, unchanged: 3, errors: 0 });
    const done = await commit(csv);
    assert.equal(done.response.status, 200);
    assert.deepEqual(await state(), before);
    assert.equal((await f.app.database.get('SELECT COUNT(*) AS n FROM product_event WHERE action = ?', 'UPDATED')).n, 0);
  } finally { await f.close(); }
});

test('preview reports creates, updates and errors without writing; commit applies them and records history', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { preview, commit, state } = api(f, headers);
    await f.request('POST', '/api/v1/seller/products', { sku: 'UP-1', name: 'Old name', description: 'Desc', category: 'EXAMPLES', priceMinor: 1000, stockQuantity: 5, active: true }, headers);
    const before = await state();
    const csv = [HEADER,
      'up-1,New name,,,,,MYR,12.50,,no,',                      // update: name, price, stock to unlimited, active off
      'NEW-1,Brand new,A fine item,Examples,,,,7,2,yes,',    // create (category by label, currency blank)
      'NEW-2,Second,Another,EXAMPLES,,,,0.99,,,'].join('\r\n');
    const plan = await preview(csv);
    assert.deepEqual(plan.data.summary, { create: 2, update: 1, unchanged: 0, errors: 0 });
    assert.deepEqual(plan.data.rows.find((row) => row.sku === 'UP-1').changes.map((c) => c.field).sort(), ['active', 'name', 'priceMinor', 'stockQuantity']);
    assert.deepEqual(await state(), before, 'a preview writes nothing');
    const done = await commit(csv);
    assert.equal(done.response.status, 200);
    const after = Object.fromEntries((await state()).map((row) => [row.sku, row]));
    assert.deepEqual([after['UP-1'].name, after['UP-1'].price_minor, after['UP-1'].stock_quantity, after['UP-1'].active], ['New name', 1250, null, 0]);
    assert.deepEqual([after['NEW-1'].price_minor, after['NEW-1'].stock_quantity, after['NEW-1'].active], [700, 2, 1]);
    assert.deepEqual([after['NEW-2'].price_minor, after['NEW-2'].stock_quantity, after['NEW-2'].active], [99, null, 1]);   // blank active = yes on create
    const id = (await f.app.database.get("SELECT id FROM product WHERE sku = 'UP-1'")).id;
    const history = await f.request('GET', `/api/v1/seller/products/${id}/history`, null, headers);
    assert.equal(history.data.items[0].action, 'UPDATED');
    assert.equal(history.data.items[0].actor, 'review_owner');
  } finally { await f.close(); }
});

test('any row with an error stops the whole import', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { preview, commit, state } = api(f, headers);
    await f.request('POST', '/api/v1/seller/products', { sku: 'ER-1', name: 'Keep me', description: 'Desc', category: 'EXAMPLES', priceMinor: 1000, active: true }, headers);
    const before = await state();
    const csv = [HEADER,
      'ER-1,Changed,,,,,,15.00,,,',                                   // fine
      'NEW-A,No category,Desc,Nowhere,,,,5,,,',                      // unknown category
      'NEW-B,Bad price,Desc,EXAMPLES,,,,12.345,,,',                  // three decimals
      'NEW-C,Wrong currency,Desc,EXAMPLES,,,SGD,5,,,',               // currency mismatch
      'NEW-D,Variant,Desc,EXAMPLES,GRP,Red,,5,,,',                   // variants cannot be imported
      'NEW-E,,,,,,,,,,',                                             // missing everything
      'NEW-F,Bad stock,Desc,EXAMPLES,,,,5,abc,,',
      'ER-1,Again,,,,,,,,,',                                         // duplicate SKU in the file
      ',Missing sku,,,,,,,,,',
      'BAD SKU!,X,Desc,EXAMPLES,,,,5,,,'].join('\n');
    const plan = await preview(csv);
    assert.equal(plan.data.summary.errors, 9);
    const codes = Object.fromEntries(plan.data.rows.map((row) => [row.sku || `line${row.line}`, row.errors.map((e) => e.code)]));
    assert.deepEqual(codes['NEW-A'], ['CATEGORY_UNKNOWN']);
    assert.deepEqual(codes['NEW-B'], ['INVALID']);
    assert.deepEqual(codes['NEW-C'], ['CURRENCY_MISMATCH']);
    assert.deepEqual(codes['NEW-D'], ['VARIANT_NOT_IMPORTABLE']);
    assert.deepEqual(codes['NEW-E'], ['REQUIRED']);
    assert.deepEqual(codes['NEW-F'], ['INVALID']);
    assert.deepEqual(codes['line10'], ['REQUIRED']);
    assert.ok(Object.values(codes).flat().includes('DUPLICATE_IN_FILE'));
    const refused = await commit(csv);
    assert.equal(refused.response.status, 409);
    assert.equal(refused.data.error.code, 'IMPORT_HAS_ERRORS');
    assert.deepEqual(await state(), before, 'the good row was not applied either');
  } finally { await f.close(); }
});

test('files are bounded and must have a SKU column; Staff cannot import', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { preview } = api(f, headers);
    assert.equal((await preview('Name,Price\nX,5')).response.status, 400);
    assert.equal((await preview('SKU\n')).response.status, 400);
    assert.equal((await preview('')).response.status, 400);
    assert.equal((await preview('SKU,SKU\nA,B')).response.status, 400);
    assert.equal((await preview(`SKU\n${Array.from({ length: 2001 }, (_, n) => `S${n}`).join('\n')}`)).response.status, 400);
    assert.equal((await f.request('POST', '/api/v1/seller/products/import', { csv: 'SKU\nA', commit: 'yes' }, headers)).response.status, 400);
    assert.equal((await f.request('POST', '/api/v1/seller/products/import', { csv: 'SKU\nA', commit: false }, { origin: f.origin })).response.status, 401);
    const temp = 'Temporary-Pass-2026!', own = 'My-Own-Password-2026!';
    await f.request('POST', '/api/v1/seller/accounts', { username: 'staff.i', role: 'STAFF', password: temp }, headers);
    const first = await f.login('staff.i', temp);
    await f.request('POST', '/api/v1/seller/account/password', { currentPassword: temp, newPassword: own }, first.headers);
    assert.equal((await f.request('POST', '/api/v1/seller/products/import', { csv: 'SKU\nA', commit: false }, (await f.login('staff.i', own)).headers)).response.status, 403);
  } finally { await f.close(); }
});

test('variants: shared fields must agree across a listing, and variant columns cannot be changed', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { preview, commit, state } = api(f, headers);
    const make = (sku, label) => f.request('POST', '/api/v1/seller/products', { sku, name: 'Shirt', description: 'Cotton', category: 'EXAMPLES', priceMinor: 2000, active: true, variantGroup: 'SHIRT', variantLabel: label }, headers);
    assert.equal((await make('SH-R', 'Red')).response.status, 201);
    assert.equal((await make('SH-B', 'Blue')).response.status, 201);
    const before = await state();
    const conflict = await preview([HEADER, 'SH-R,Tee A,,,SHIRT,Red,,,,,', 'SH-B,Tee B,,,SHIRT,Blue,,,,,'].join('\n'));
    assert.ok(conflict.data.rows.some((row) => row.errors.some((e) => e.code === 'SHARED_CONFLICT')));
    const relabel = await preview([HEADER, 'SH-R,,,,SHIRT,Green,,,,,'].join('\n'));
    assert.equal(relabel.data.rows[0].errors[0].code, 'VARIANT_NOT_IMPORTABLE');
    // The same new name on both variants, and a price change on one, is fine.
    const ok = await commit([HEADER, 'SH-R,Tee,,,SHIRT,Red,,25.00,,,', 'SH-B,Tee,,,SHIRT,Blue,,,,,'].join('\n'));
    assert.equal(ok.response.status, 200, JSON.stringify(ok.data));
    const after = Object.fromEntries((await state()).map((row) => [row.sku, row]));
    assert.deepEqual([after['SH-R'].name, after['SH-B'].name, after['SH-R'].price_minor, after['SH-B'].price_minor], ['Tee', 'Tee', 2500, 2000]);
    assert.notDeepEqual(await state(), before);
  } finally { await f.close(); }
});
