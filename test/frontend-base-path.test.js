import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basePath, apiUrl } from '../public/shared/base-path.js';
import { storageKey, resolveStorageScope } from '../public/shared/storage-scope.js';
import { productShareURL } from '../public/shop/product-share.js';
import { safeOrderImage } from '../public/shop/local-orders.js';
import { thumbUrl } from '../public/shared/image-thumb.js';

const root = new URL('../', import.meta.url);
function* files(path = 'public') {
  for (const entry of readdirSync(new URL(path + '/', root), { withFileTypes: true })) {
    if (entry.isDirectory()) yield* files(`${path}/${entry.name}`);
    else if (/\.(js|html|css|webmanifest)$/.test(entry.name)) yield `${path}/${entry.name}`;
  }
}
test('frontend absolute paths stay within the documented exact-count allow-list', () => {
  const allow = JSON.parse(readFileSync(new URL('./frontend-base-path.allowlist.json', import.meta.url)));
  const seen = new Set();
  for (const file of files()) {
    const lines = readFileSync(new URL(file, root), 'utf8').split('\n').filter((line) => !line.trim().startsWith('//') && /(?<![.\w])\/(?:api|shop|seller|shared)\//.test(line));
    if (lines.length) { assert.equal(lines.length, allow[file]?.lines, `${file}: ${lines.join('\n')}`); assert.ok(allow[file].reason); seen.add(file); }
  }
  assert.deepEqual([...seen].sort(), Object.keys(allow).sort());
});
test('page base preserves legacy URLs and prefixes API, image and share URLs', () => {
  for (const surface of ['shop', 'seller']) {
    assert.equal(basePath(`/${surface}/`), ''); assert.equal(apiUrl('v1/shop', `/${surface}/`), '/api/v1/shop');
    assert.equal(basePath(`/abc123/${surface}/`), '/abc123'); assert.equal(apiUrl('v1/products?limit=2', `/abc123/${surface}/`), '/abc123/api/v1/products?limit=2');
  }
  assert.equal(basePath('/ABC/shop/'), ''); assert.equal(basePath('/aa/shop/'), '');
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(productShareURL(id, 'https://shop.example.test/abc123/shop/#catalog'), `https://shop.example.test/abc123/p/${id}`);
  const image = `/abc123/api/v1/products/${id}/image?v=1`;
  assert.equal(safeOrderImage(image), image); assert.equal(thumbUrl(image), image + '&size=thumb');
  assert.equal(safeOrderImage('https://other.test' + image), null);
});
test('network-first storage bootstrap preserves default keys, caches tenant scope and refuses rejected shops', async () => {
  const saved = new Map(), storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const fetcher = (scope) => async () => new Response(JSON.stringify(scope ? { storageScope: scope } : {}));
  try {
    await resolveStorageScope({ pathname: '/shop/', storage, fetcher: fetcher() }); assert.equal(storageKey('cart'), 'cart');
    await resolveStorageScope({ pathname: '/alpha/shop/', storage, fetcher: fetcher('t-aaaaaaaaaaaa') }); assert.equal(storageKey('cart'), 'cart:t-aaaaaaaaaaaa');
    await resolveStorageScope({ pathname: '/bravo/seller/', storage, fetcher: fetcher('t-bbbbbbbbbbbb') }); assert.equal(storageKey('cart'), 'cart:t-bbbbbbbbbbbb');
    await resolveStorageScope({ pathname: '/alpha/shop/', storage, fetcher: async () => { throw new TypeError('Offline'); } }); assert.equal(storageKey('cart'), 'cart:t-aaaaaaaaaaaa');
    assert.equal(saved.get('scope-for:/alpha'), 't-aaaaaaaaaaaa');
    await assert.rejects(resolveStorageScope({ pathname: '/alpha/shop/', storage, fetcher: async () => new Response('', { status: 404 }) }), /not found/);
    await assert.rejects(resolveStorageScope({ pathname: '/charlie/shop/', storage, fetcher: fetcher() }), /scope/);
    await assert.rejects(resolveStorageScope({ pathname: '/charlie/shop/', storage, fetcher: async () => { throw new TypeError('Offline'); } }), /Offline/);
  } finally { delete globalThis.shopStorageNamespace; delete globalThis.shopBootstrapInfo; }
});
