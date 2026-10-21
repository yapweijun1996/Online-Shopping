import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workload, storage } from '../offline.mjs';
import { proto } from '@whiskeysockets/baileys';

test('synthetic auth survives binary storage and produces a local QR PNG', async () => {
  const { store, creds, qr, png, appKey } = await workload(2);
  const definedCreds = Object.fromEntries(Object.entries(creds).filter(([, value]) => value !== undefined));
  assert.deepEqual(store.get('creds'), definedCreds);
  assert.equal(qr.split(',')[1], creds.noiseKey.public.toString('base64'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(proto.Message.AppStateSyncKeyData.fromObject(store.get('app-state-sync-key')), appKey);
  assert.equal(store.get('session:0').binary.length, 16384);
  store.delete('session:0');
  assert.equal(store.get('session:0'), null);
});

test('chunk tampering, swapping, truncation and wrong keys fail closed', () => {
  for (const mutate of [
    r => { r.chunks[0].body[0] ^= 1; },
    r => { [r.chunks[0], r.chunks[1]] = [r.chunks[1], r.chunks[0]]; },
    r => { r.chunks.pop(); }
  ]) {
    const store = storage();
    store.put('binary', { data: Buffer.alloc(16384, 42) });
    mutate(store.records.get('binary'));
    assert.throws(() => store.get('binary'));
  }
  const original = storage();
  original.put('key', { value: Buffer.from([0, 255]) });
  const wrong = storage();
  wrong.records.set('key', original.records.get('key'));
  assert.throws(() => wrong.get('key'));
});
