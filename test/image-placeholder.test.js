import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setProductMedia, revealImage } from '../public/shop/product-media.js';

function fakeImage() {
  const classes = new Set(), vars = new Map(), listeners = [];
  return { classes, vars, listeners, complete: false, naturalWidth: 0, removeAttribute() {}, src: '',
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
    style: { setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k) },
    addEventListener: (name, fn) => listeners.push([name, fn]) };
}
const media = { src: '/demo-assets/A/view-1-aaaaaaaaaaaa-640.jpg', thumbnail: '/demo-assets/A/view-1-aaaaaaaaaaaa-160.jpg', full: '/demo-assets/A/view-1-aaaaaaaaaaaa-1254.jpg', srcset: '', alt: 'x' };

test('main image uses the small thumbnail as a blurred placeholder and reveals on load', () => {
  const image = fakeImage();
  setProductMedia(image, media, 'main');
  assert.ok(image.classes.has('img-reveal') && image.classes.has('has-lqip') && !image.classes.has('is-loaded'));
  assert.equal(image.vars.get('--lqip'), `url("${media.thumbnail}")`);
  image.listeners.find(([name]) => name === 'load')[1]();
  assert.ok(image.classes.has('is-loaded'));
});

test('zoom image uses the cached medium size, and images without a distinct preview fall back to the shimmer', () => {
  const zoom = fakeImage(); setProductMedia(zoom, media, 'full');
  assert.equal(zoom.vars.get('--lqip'), `url("${media.src}")`);
  const hero = fakeImage(); setProductMedia(hero, { ...media, thumbnail: media.src }, 'main');
  assert.ok(!hero.classes.has('has-lqip') && !hero.vars.has('--lqip'));
  const unsafe = fakeImage(); revealImage(unsafe, '/x");background:red;("');
  assert.ok(!unsafe.classes.has('has-lqip'), 'unsafe preview URLs are ignored');
});

test('production Caddy serves hashed gallery images as immutable', () => {
  const caddy = readFileSync(new URL('../deploy/Caddyfile.production', import.meta.url), 'utf8');
  assert.match(caddy, /@gallery path_regexp[^\n]*view-\\d\+-\[a-f0-9\]\{12\}/);
  assert.match(caddy, /handle @gallery \{\s*header Cache-Control "public, max-age=31536000, immutable"/);
});
