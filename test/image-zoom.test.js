import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedZoom } from '../public/shop/image-zoom.js';

test('image zoom limits scale and pan, resets translation at fitted size', () => {
  assert.deepEqual(boundedZoom(0, 999, -999, 320, 500), { scale: 1, x: 0, y: -0 });
  assert.deepEqual(boundedZoom(10, 999, -999, 320, 500), { scale: 4, x: 480, y: -750 });
  assert.deepEqual(boundedZoom(2, 25, -30, 320, 500), { scale: 2, x: 25, y: -30 });
  assert.equal(boundedZoom(NaN, 0, 0, 320, 500).scale, 1);
});
