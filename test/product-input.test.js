import assert from 'node:assert/strict';
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
