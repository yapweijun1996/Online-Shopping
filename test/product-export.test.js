import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';

test('product CSV: one row per product with price, stock and status; search narrows it; formulas are neutralised; Staff are refused', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const make = (body) => f.request('POST', '/api/v1/seller/products', { description: 'Fictional, with "quotes"', category: 'EXAMPLES', priceMinor: 1999, active: true, ...body }, headers);
    assert.equal((await make({ sku: 'EXP-1', name: '=SUM(1,1)', stockQuantity: 7 })).response.status, 201);
    assert.equal((await make({ sku: 'EXP-2', name: 'Plain item', active: false })).response.status, 201);
    assert.equal((await f.request('GET', '/api/v1/seller/products/export.csv', null, { origin: f.origin })).response.status, 401);
    const all = await f.request('GET', '/api/v1/seller/products/export.csv', null, headers);
    assert.equal(all.response.status, 200);
    assert.match(all.response.headers.get('content-type'), /^text\/csv/);
    assert.match(all.response.headers.get('content-disposition'), /^attachment; filename="products-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(all.response.headers.get('cache-control'), 'no-store');
    const lines = all.data.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 4);   // header, the fixture's own product, and the two new ones
    assert.match(lines[0], /^SKU,Name,Description,Category,Variant group,Variant label,Currency,Price,Stock/);
    const formula = lines.find((line) => line.startsWith('EXP-1'));
    assert.ok(formula.includes(`"'=SUM(1,1)"`) && formula.includes('"Fictional, with ""quotes"""'));
    assert.ok(formula.includes(',MYR,19.99,7,yes,'));
    assert.ok(lines.find((line) => line.startsWith('EXP-2')).includes(',MYR,19.99,,no,'));   // blank stock = unlimited
    const narrowed = await f.request('GET', '/api/v1/seller/products/export.csv?search=plain', null, headers);
    assert.equal(narrowed.data.trim().split('\r\n').length, 2);
    // A Staff account cannot export the catalog.
    const temp = 'Temporary-Pass-2026!', own = 'My-Own-Password-2026!';
    await f.request('POST', '/api/v1/seller/accounts', { username: 'staff.x', role: 'STAFF', password: temp }, headers);
    const first = await f.login('staff.x', temp);
    await f.request('POST', '/api/v1/seller/account/password', { currentPassword: temp, newPassword: own }, first.headers);
    assert.equal((await f.request('GET', '/api/v1/seller/products/export.csv', null, (await f.login('staff.x', own)).headers)).response.status, 403);
  } finally { await f.close(); }
});
