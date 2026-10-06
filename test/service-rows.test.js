import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messages } from '../public/shared/i18n.js';

test('product page shows availability, shipping and returns only when the seller wrote them', () => {
  const detail = readFileSync(new URL('../public/shop/product-detail.js', import.meta.url), 'utf8');
  assert.match(detail, /\.filter\(\(\[, text\]\) => text\)/, 'sections without seller text are dropped');
  assert.match(detail, /if \(serviceRows\.length\) summary\.append\(serviceDetails\)/, 'no empty container is rendered');
  assert.doesNotMatch(detail, /Unconfirmed/, 'the built-in placeholder wording is gone');
});

test('the placeholder strings are removed from every language and the seller help says empty hides the section', () => {
  for (const [code, strings] of Object.entries(messages)) {
    for (const key of ['availabilityUnconfirmed', 'shippingUnconfirmed', 'returnsUnconfirmed']) assert.equal(key in strings, false, `${code}.${key}`);
  }
  assert.match(messages.en.storefrontTextsHelp, /empty to hide that section/);
  for (const code of Object.keys(messages)) assert.ok(messages[code].storefrontTextsHelp.trim(), code);
});
