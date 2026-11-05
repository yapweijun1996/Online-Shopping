import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadThumbnail, assertUploadThumbnail } from '../src/mcp/media-upload-policy.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
test('canonical PNG thumbnail metadata binds exact actual bytes without retaining them', () => {
  const value = uploadThumbnail(png);
  assert.ok(Object.isFrozen(value)); assert.deepEqual(Object.keys(value), ['sha256','byteLength','mime']);
  assert.equal(value.byteLength, png.length); assert.equal(value.mime, 'image/png');
  assert.deepEqual(assertUploadThumbnail(value, Buffer.from(png)), value);
  for (const changed of [{ ...value, sha256: '0'.repeat(64) }, { ...value, byteLength: value.byteLength + 1 },
    { ...value, mime: 'image/jpeg' }, { ...value, approved: true }]) assert.throws(() => assertUploadThumbnail(changed, png), TypeError);
  assert.throws(() => assertUploadThumbnail(value, Buffer.concat([png, Buffer.from('other')])), TypeError);
  assert.throws(() => uploadThumbnail(Buffer.from('not a PNG')), TypeError);
});
