import assert from 'node:assert/strict';
import test from 'node:test';
import { createContactHistory } from '../public/shop/history.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

const address = { line1: 'Example Street', line2: '', city: '', region: '', postcode: '47810', country: 'MY' };

test('explicitly saved phone and address suggestions survive reload and clear completely', () => {
  const storage = memoryStorage();
  const time = () => 2_000_000_000_000;
  const history = createContactHistory(storage, time);
  assert.deepEqual(history.snapshot(), { buyerPhones: [], recipientPhones: [], addresses: [] });
  assert.equal(history.save({ buyerPhone: '+60123456789', recipientPhones: ['+6581234567'], addresses: [address] }), true);
  history.save({ buyerPhone: '+60123456789', recipientPhones: ['+6581234567'], addresses: [address] });
  const reloaded = createContactHistory(storage, time);
  assert.deepEqual(reloaded.snapshot(), {
    buyerPhones: ['+60123456789'], recipientPhones: ['+6581234567'], addresses: [address],
  });
  assert.equal(reloaded.clear(), true);
  assert.deepEqual(createContactHistory(storage, time).snapshot(), { buyerPhones: [], recipientPhones: [], addresses: [] });
});

test('expired and malformed history is ignored without exposing unrelated local storage', () => {
  const storage = memoryStorage();
  const now = 2_000_000_000_000;
  const history = createContactHistory(storage, () => now);
  history.save({ buyerPhone: '+60123456789', recipientPhones: [], addresses: [] });
  assert.deepEqual(createContactHistory(storage, () => now + 91 * 24 * 60 * 60 * 1000).snapshot().buyerPhones, []);
  assert.equal(storage.getItem('online-shopping-contact-history-v1'), null);
  storage.setItem('online-shopping-contact-history-v1', '{bad');
  const malformed = createContactHistory(storage, () => now);
  assert.deepEqual(malformed.snapshot().buyerPhones, []);
  assert.equal(malformed.persistent, true);
  assert.equal(storage.getItem('online-shopping-contact-history-v1'), null);
});

test('storage failure keeps current-tab suggestions and reports non-persistence', () => {
  const storage = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
    removeItem() { throw new Error('storage denied'); },
  };
  const history = createContactHistory(storage);
  assert.equal(history.persistent, false);
  assert.equal(history.save({ buyerPhone: '+6581234567', recipientPhones: [], addresses: [address] }), false);
  assert.deepEqual(history.snapshot().buyerPhones, ['+6581234567']);
  assert.equal(history.clear(), false);
  assert.deepEqual(history.snapshot().addresses, []);
});
