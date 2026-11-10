import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSignature } from '../public/shared/update-guard.js';

test('private draft values never enter the update signature, including Show password; revision still detects editing', () => {
  const input = { name: 'temporaryPassword', type: 'password', value: 'Fictional-Private-Value!', dataset: { privateDraft: 'true', privateDraftRevision: '1' } };
  const root = { querySelectorAll: () => [input] };
  const hidden = draftSignature(root); assert.equal(hidden.includes(input.value), false);
  input.type = 'text'; assert.equal(draftSignature(root), hidden, 'showing a private value does not expose it');
  input.value += 'Changed'; input.dataset.privateDraftRevision = '2';
  assert.notEqual(draftSignature(root), hidden); assert.equal(draftSignature(root).includes('Fictional'), false);
});

test('ordinary draft signatures retain existing value, checkbox and file change detection', () => {
  const input = { id: 'ordinaryPassword', type: 'password', value: 'Local-Fixture!', dataset: {} };
  const check = { id: 'check', type: 'checkbox', checked: false };
  const file = { id: 'file', type: 'file', value: '', files: [{ name: 'fictional.png', size: 12, lastModified: 1 }] };
  const root = { querySelectorAll: () => [input, check, file] };
  const first = draftSignature(root); input.value += 'Next'; assert.notEqual(draftSignature(root), first);
  const second = draftSignature(root); check.checked = true; assert.notEqual(draftSignature(root), second);
  const third = draftSignature(root); file.files[0].size++; assert.notEqual(draftSignature(root), third);
});
