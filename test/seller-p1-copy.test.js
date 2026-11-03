import test from 'node:test';
import assert from 'node:assert/strict';
import { messages, languages } from '../public/shared/i18n.js';
import '../public/seller/ai-studio-copy.js';
import '../public/seller/p1-copy.js';
import { readFileSync } from 'node:fs';
test('P1 copy has complete, placeholder-equivalent values for seven locales', () => {
  const keys = Object.keys(messages.en).filter(key => key.startsWith('p1') || key.startsWith('aist_'));
  for (const { code } of languages) for (const key of keys) {
    assert.ok(messages[code][key]?.trim(), `${code}.${key}`);
    assert.deepEqual((messages[code][key].match(/\{\w+\}/g) || []).sort(), (messages.en[key].match(/\{\w+\}/g) || []).sort(), `${code}.${key}`);
  }
});
test('Seller P1 copy is precached and Seller worker/app versions stay paired', () => {
  const read = f => readFileSync(new URL(`../public/seller/${f}`, import.meta.url), 'utf8');
  assert.match(read('sw.js'), /'\.\/p1-copy\.js'/);
  assert.equal(/APP_VERSION = '([^']+)'/.exec(read('version.js'))[1], /version: '([^']+)'/.exec(read('sw.js'))[1]);
});
