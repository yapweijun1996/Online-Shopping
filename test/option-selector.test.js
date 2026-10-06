import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentPicks, targetFor } from '../public/shop/option-selector.js';

const color = { id: 'c', name: 'Colour' }, storage = { id: 's', name: 'Storage' };
const opt = (type, id) => ({ type, value: { id } });
// Burgundy: 256 and 512 (512 out of stock); Glacier: 256 only; Black: 1TB only.
const variants = [
  { id: 'p1', inStock: true, options: [opt(color, 'burgundy'), opt(storage, '256')] },
  { id: 'p2', inStock: false, options: [opt(color, 'burgundy'), opt(storage, '512')] },
  { id: 'p3', inStock: true, options: [opt(color, 'glacier'), opt(storage, '256')] },
  { id: 'p4', inStock: true, options: [opt(color, 'black'), opt(storage, '1tb')] },
];
const product = { id: 'p1', options: variants[0].options, variants };

test('current picks come from the product on screen', () => {
  assert.deepEqual([...currentPicks(product)], [['c', 'burgundy'], ['s', '256']]);
  assert.deepEqual([...currentPicks({})], []);
});

test('choosing a value opens the exact combination when it exists', () => {
  assert.deepEqual(targetFor(product, 's', '512'), { variant: variants[1], exact: true });
  assert.deepEqual(targetFor(product, 'c', 'glacier'), { variant: variants[2], exact: true });
});

test('a value with no exact combination opens the nearest one and is reported as not exact', () => {
  const nearest = targetFor(product, 's', '1tb');
  assert.equal(nearest.variant.id, 'p4'); assert.equal(nearest.exact, false);
  const black = targetFor(product, 'c', 'black');
  assert.equal(black.variant.id, 'p4'); assert.equal(black.exact, false);
});

test('ties prefer the combination that keeps more choices, then one that is in stock', () => {
  const sameColor = { ...product, options: variants[1].options, id: 'p2' };  // Burgundy / 512 (out of stock)
  assert.equal(targetFor(sameColor, 's', '256').variant.id, 'p1');
  const crowded = { id: 'x', options: [opt(color, 'a'), opt(storage, 'x')], variants: [
    { id: 'v1', inStock: false, options: [opt(color, 'b'), opt(storage, 'y')] },
    { id: 'v2', inStock: true, options: [opt(color, 'c'), opt(storage, 'y')] }] };
  assert.equal(targetFor(crowded, 's', 'y').variant.id, 'v2', 'in stock wins when neither keeps a choice');
  assert.equal(targetFor(product, 'c', 'unknown'), null);
});

test('product page uses the selector when option types exist and keeps the old chooser otherwise', () => {
  const detail = readFileSync(new URL('../public/shop/product-detail.js', import.meta.url), 'utf8');
  assert.match(detail, /product\.variants\?\.length > 1 && product\.optionTypes\?\.length/);
  assert.match(detail, /else if \(product\.variants\?\.length > 1\)/);
  const worker = readFileSync(new URL('../public/shop/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /\/shop\/option-selector\.js/);
});

test('option choices are links marked aria-current, not radios, and explain when they change other choices', () => {
  const source = readFileSync(new URL('../public/shop/option-selector.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setAttribute\('role', 'radio'\)|aria-checked|radiogroup/);
  assert.match(source, /setAttribute\('aria-current', 'true'\)/);
  assert.match(source, /setAttribute\('role', 'group'\)/);
  assert.match(source, /optionChangesOthers/);
});

