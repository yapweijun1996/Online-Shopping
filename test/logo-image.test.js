import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planLogoSize, prepareLogo } from '../public/seller/logo-image.js';
import { readFileSync } from 'node:fs';

test('logo dimensions preserve aspect ratio without upscaling', () => {
  assert.deepEqual(planLogoSize(1200, 600), { width: 512, height: 256 });
  assert.deepEqual(planLogoSize(600, 1200), { width: 256, height: 512 });
  assert.deepEqual(planLogoSize(40, 20), { width: 40, height: 20 });
  assert.deepEqual(planLogoSize(512, 256), { width: 512, height: 256 });
});

function fixture(alpha, encode) {
  const calls = [];
  const bitmap = { width: 1000, height: 500, close() { calls.push('close'); } };
  const canvas = { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [0, 0, 0, alpha] }) }),
    toBlob(callback, type, quality) { calls.push([type, quality, this.width]); callback(encode(type, quality, this.width)); } };
  return { calls, env: { createImageBitmap: async () => bitmap, createCanvas: () => canvas } };
}
const file = { type: 'image/png', size: 100 };
const blob = (type, size) => ({ type, size });

test('transparent images stay PNG and shrink until they fit', async () => {
  const f = fixture(0, (type, quality, width) => blob(type, width > 409 ? 300 : 100));
  const result = await prepareLogo(file, { limit: 200, env: f.env });
  assert.equal(result.type, 'image/png'); assert.equal(result.width, 409);
  assert.deepEqual(f.calls, [['image/png', undefined, 512], ['image/png', undefined, 409], 'close']);
});

test('opaque images try WebP then JPEG quality steps', async () => {
  const f = fixture(255, (type, quality) => blob(type, type === 'image/jpeg' && quality <= 0.7 ? 100 : 300));
  const result = await prepareLogo(file, { limit: 200, env: f.env });
  assert.equal(result.type, 'image/jpeg');
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'image/jpeg' && call[1] === 0.7));
});

test('preparation failures have typed codes', async () => {
  await assert.rejects(prepareLogo({ type: 'image/gif', size: 1 }), { code: 'unsupported_type' });
  await assert.rejects(prepareLogo({ ...file, size: 8 * 1024 * 1024 + 1 }), { code: 'input_too_large' });
  await assert.rejects(prepareLogo(file, { env: { createImageBitmap: async () => { throw Error(); } } }), { code: 'decode_failure' });
  const f = fixture(0, type => blob(type, 300));
  await assert.rejects(prepareLogo(file, { limit: 200, env: f.env }), { code: 'cannot_compress' });
  assert.equal(f.calls.at(-2)[2], 128);
  assert.equal(f.calls.at(-1), 'close');
});

test('seller worker precaches logo preparation', () => {
  assert.match(readFileSync(new URL('../public/seller/sw.js', import.meta.url), 'utf8'), /'\.\/logo-image\.js'/);
});
