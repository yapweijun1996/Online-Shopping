import test from 'node:test';
import assert from 'node:assert/strict';
import { tableRows, safeLink } from '../public/platform/table.js';
const rows = [
  { id: 1, name: 'alpha', code: 'one', status: 'SUSPENDED', sellerUsername: 'owner', createdAt: '2026-01-01' },
  { id: 2, name: 'Alpha', code: 'two', status: 'ACTIVE', sellerUsername: 'seller', createdAt: '2026-03-01' },
  { id: 3, name: 'Beta', code: 'three', status: 'ACTIVE', sellerUsername: 'owner', createdAt: '2026-02-01' }
];
test('stable case-insensitive sorting, chronological default and status precedence', () => {
  assert.deepEqual(tableRows(rows).rows.map(r => r.id), [2,3,1]);
  assert.deepEqual(tableRows(rows, { sort:'name', direction:'ascending' }).rows.map(r => r.id), [1,2,3]);
  assert.deepEqual(tableRows(rows, { sort:'status', direction:'ascending' }).rows.map(r => r.id), [2,3,1]);
  assert.deepEqual(tableRows(rows, { sort:'name', direction:'' }).rows.map(r => r.id), [1,2,3]);
  assert.deepEqual(rows.map(r=>r.id), [1,2,3]);
});
test('combined search and status, pagination shrinking and empty bounds', () => {
  assert.deepEqual(tableRows(rows,{query:'OWNER',status:'ACTIVE'}).rows.map(r=>r.id),[3]);
  const last=tableRows(rows,{size:2,page:8}); assert.equal(last.page,2); assert.deepEqual(last.rows.map(r=>r.id),[1]); assert.equal(last.start,3); assert.equal(last.end,3);
  const empty=tableRows(rows,{query:'missing',page:8}); assert.equal(empty.page,1); assert.equal(empty.start,0); assert.equal(empty.end,0); assert.deepEqual(empty.rows,[]);
});
test('links reject schemes, credentials and unrelated hosts', () => {
  const base='https://admin.example.test/platform/';
  assert.equal(safeLink('https://seller.example.test/shop/',base),'https://seller.example.test/shop/');
  for (const value of ['javascript:alert(1)','data:text/html,x','https://example.test.evil/','https://user:pass@example.test/']) assert.equal(safeLink(value,base),null);
  assert.equal(safeLink('http://127.0.0.1:123/shop/','http://localhost:123/platform/'),'http://127.0.0.1:123/shop/');
});
