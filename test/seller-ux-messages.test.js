import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { languages, messages } from '../public/shared/i18n.js';
import '../public/seller/ops-copy.js';
import '../public/seller/sender-copy.js';

test('the export-done notice does not claim a CSV file when an Excel file was downloaded', () => {
  for (const { code } of languages) assert.doesNotMatch(messages[code].exportDone, /CSV/i, `${code}.exportDone names a file type`);
});

test('an invalid sender / pickup address gets its own message instead of the product error', () => {
  for (const { code } of languages) {
    assert.ok(messages[code].senderInvalid?.trim(), `${code}.senderInvalid is missing`);
    assert.notEqual(messages[code].senderInvalid, messages[code].productError);
  }
  const source = readFileSync(new URL('../public/seller/settings.js', import.meta.url), 'utf8');
  assert.match(source, /error\.field\?\.startsWith\('sender'\) \? 'senderInvalid'/);
});
