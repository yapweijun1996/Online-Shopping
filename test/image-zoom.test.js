import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedZoom, zoomAt } from '../public/shop/image-zoom.js';

test('image zoom limits scale and pan, resets translation at fitted size', () => {
  assert.deepEqual(boundedZoom(0, 999, -999, 320, 500), { scale: 1, x: 0, y: -0 });
  assert.deepEqual(boundedZoom(10, 999, -999, 320, 500), { scale: 4, x: 480, y: -750 });
  assert.deepEqual(boundedZoom(2, 25, -30, 320, 500), { scale: 2, x: 25, y: -30 });
  assert.equal(boundedZoom(NaN, 0, 0, 320, 500).scale, 1);
});

test('cursor-centered zoom retains the same image point and uses the bounded scale ratio', () => {
  const start = { scale: 1, x: 0, y: 0 };
  const next = zoomAt(start, 2, 80, -60, 400, 400);
  assert.deepEqual(next, { scale: 2, x: -80, y: 60 });
  assert.equal((80 - next.x) / next.scale, (80 - start.x) / start.scale);
  assert.equal((-60 - next.y) / next.scale, (-60 - start.y) / start.scale);
  const bounded = zoomAt({ scale: 2, x: -80, y: 60 }, 20, 80, -60, 400, 400);
  assert.deepEqual(bounded, { scale: 4, x: -240, y: 180 });
  const fit = zoomAt(bounded, .1, 80, -60, 400, 400);
  assert.equal(fit.scale, 1); assert.equal(Math.abs(fit.x) + Math.abs(fit.y), 0);
});

test('moving the pinch midpoint pans the anchored image independently of scale', () => {
  const next = zoomAt({ scale: 2, x: 10, y: -20 }, 3, 40, 50, 400, 400, 400, 400, 30, -15);
  assert.deepEqual(next, { scale: 3, x: 25, y: -70 });
});

test('landscape and portrait pan bounds use fitted pixels instead of letterboxing', () => {
  const landscape = boundedZoom(2, 999, -999, 400, 600, 400, 200);
  assert.equal(landscape.x, 200); assert.equal(Math.abs(landscape.y), 0);
  const portrait = boundedZoom(3, -999, 999, 600, 400, 200, 400);
  assert.equal(Math.abs(portrait.x), 0); assert.equal(portrait.y, 400);
});
