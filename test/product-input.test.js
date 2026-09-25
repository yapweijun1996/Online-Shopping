import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateProductInput } from '../src/product-input.js';
import { FieldError } from '../src/validation.js';

const draft = {
  sku: ' item-1 ', name: ' Example item ', description: ' Example description ',
  category: 'Example category', priceMinor: 900, currency: 'MYR', active: false,
};

test('product input requires a supplied shop currency policy and normalizes bounded fields', () => {
  assert.throws(() => validateProductInput(draft), /currency policy/);
  assert.deepEqual(validateProductInput(draft, ['MYR']), {
    sku: 'ITEM-1', name: 'Example item', description: 'Example description',
    category: 'Example category', priceMinor: 900, currency: 'MYR', active: false,
  });
  assert.deepEqual(validateProductInput({ active: true }, ['MYR'], { partial: true }), { active: true });
});

test('product input rejects unknown fields, invalid values, and empty patches', () => {
  for (const [input, field] of [
    [{ ...draft, imageUrl: 'https://example.test/image.png' }, 'imageUrl'],
    [{ ...draft, priceMinor: -1 }, 'priceMinor'],
    [{ ...draft, priceMinor: 1.5 }, 'priceMinor'],
    [{ ...draft, currency: 'SGD' }, 'currency'],
    [{ ...draft, name: 'Bad\nname' }, 'name'],
    [{ ...draft, sku: 'bad sku' }, 'sku'],
    [{ ...draft, active: 'true' }, 'active'],
  ]) {
    assert.throws(() => validateProductInput(input, ['MYR']), (error) => error instanceof FieldError && error.field === field);
  }
  assert.throws(() => validateProductInput({}, ['MYR'], { partial: true }), FieldError);
});

test('base64 product images are bounded and checked against their declared format', () => {
  const bytes = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
  const imageDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
  const product = validateProductInput({ imageDataUrl }, ['MYR'], { partial: true });
  assert.equal(product.image.mime, 'image/png');
  assert.deepEqual(product.image.data, bytes);
  assert.deepEqual(validateProductInput({ imageDataUrl: null }, ['MYR'], { partial: true }), { image: null });
  assert.throws(() => validateProductInput({ imageDataUrl: imageDataUrl.replace('image/png', 'image/jpeg') }, ['MYR'], { partial: true }),
    (error) => error instanceof FieldError && error.field === 'imageDataUrl');
  assert.throws(() => validateProductInput({ imageDataUrl: `data:image/png;base64,${Buffer.alloc(513 * 1024).toString('base64')}` }, ['MYR'], { partial: true }),
    (error) => error instanceof FieldError && error.field === 'imageDataUrl');
});
