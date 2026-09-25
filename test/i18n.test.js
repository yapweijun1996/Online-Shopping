import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languages, messages } from '../public/shared/i18n.js';

test('all current shell strings exist in the required seven language resources', () => {
  assert.deepEqual(languages.map(({ code }) => code), ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']);
  const englishKeys = Object.keys(messages.en).sort();
  for (const { code } of languages) {
    assert.deepEqual(Object.keys(messages[code]).sort(), englishKeys, `missing translation in ${code}`);
    for (const key of englishKeys) assert.ok(messages[code][key].trim(), `${code}.${key} is empty`);
  }
});
