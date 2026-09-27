import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileStore, normalizeProfile, profileForCountry } from '../public/shop/profile.js';
import { createCartSelection } from '../public/shop/cart-selection.js';
const memoryStorage = () => { const data = new Map(); return { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) }; };

test('profile starts empty, validates either contact, and survives reload only after save', () => {
  const storage = memoryStorage();
  const store = createProfileStore(storage);
  assert.equal(store.get(), null);
  assert.throws(() => store.save({ fullName: 'Customer' }), /profileContactRequired/);
  assert.equal(store.get(), null);
  const profile = store.save({ fullName: ' Customer ', email: 'customer@example.test', code: '+60' });
  assert.equal(profile.phone, '');
  assert.deepEqual(createProfileStore(storage).get(), profile);
  assert.equal(normalizeProfile({ fullName: 'Customer', code: '+60', phone: '0123456789' }).phone, '+60123456789');
  assert.throws(() => normalizeProfile({ fullName: 'Customer', email: 'bad' }), /profileEmailInvalid/);
  assert.throws(() => normalizeProfile({ fullName: 'Customer', phone: 'garbage' }), /profilePhoneInvalid/);
  assert.throws(() => createProfileStore().save(profile), /profileSaveFailed/);
  storage.setItem('online-shopping-profile-v1', '{broken');
  assert.equal(createProfileStore(storage).get(), null);
});

test('shop country gates a saved phone without changing the stored profile', () => {
  const storage = memoryStorage();
  const store = createProfileStore(storage);
  const singapore = store.save({ fullName: 'Customer', code: '+65', phone: '91234567' });
  assert.equal(profileForCountry(store.get(), 'MY'), null);
  assert.deepEqual(store.get(), singapore);
  assert.equal(profileForCountry(store.get(), 'SG').phone, '+6591234567');
  const emailOnly = store.save({ fullName: 'Customer', code: '+65', email: 'customer@example.test' });
  assert.deepEqual(profileForCountry(emailOnly, 'MY'), emailOnly);
  assert.equal(store.save({ fullName: 'Customer', code: '+60', phone: '601112345678' }).phone, '+601112345678');
});

test('older saved phone remains available for correction but cannot unlock checkout', () => {
  const storage = memoryStorage();
  storage.setItem('online-shopping-profile-v1', JSON.stringify({ fullName: 'Customer', code: '+60', phone: '+60111234567', email: '' }));
  const store = createProfileStore(storage);
  assert.equal(store.get().phone, '+60111234567');
  assert.equal(profileForCountry(store.get(), 'MY'), null);
  assert.equal(storage.getItem('online-shopping-profile-v1').includes('+60111234567'), true);
});

test('cart selection preserves deselected items across refresh and supports Buy now isolation', () => {
  const storage = memoryStorage();
  const lines = [{ productId: 'a' }, { productId: 'b' }];
  const selection = createCartSelection(storage);
  selection.sync(lines);
  selection.set('b', false);
  selection.sync(lines);
  assert.deepEqual(selection.items(lines), [lines[0]]);
  const reloaded = createCartSelection(storage);
  reloaded.sync(lines);
  assert.deepEqual(reloaded.items(lines), [lines[0]]);
  reloaded.only('b');
  assert.deepEqual(reloaded.items(lines), [lines[1]]);
  reloaded.sync([lines[0]]);
  assert.deepEqual(reloaded.items([lines[0]]), []);
});
