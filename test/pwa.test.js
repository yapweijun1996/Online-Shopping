import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('shop and seller manifests have separate scopes and real icon sizes', () => {
  const ids = new Set();
  for (const surface of ['shop', 'seller']) {
    const manifest = JSON.parse(readFileSync(new URL(`../public/${surface}/manifest.webmanifest`, import.meta.url), 'utf8'));
    assert.equal(manifest.id, `/${surface}/`);
    assert.equal(manifest.scope, `/${surface}/`);
    assert.equal(manifest.start_url, `/${surface}/`);
    assert.equal(manifest.display, 'standalone');
    assert.equal(ids.has(manifest.id), false);
    ids.add(manifest.id);
    assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
    for (const icon of manifest.icons) {
      const png = readFileSync(new URL(`../public${icon.src}`, import.meta.url));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const size = Number.parseInt(icon.sizes, 10);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
});
