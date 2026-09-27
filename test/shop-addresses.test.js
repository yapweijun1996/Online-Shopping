import assert from 'node:assert/strict';
import test from 'node:test';
import { createAddressStore, validateAddressEntry } from '../public/shop/addresses.js';
const input = { fullName: 'QA Recipient', phone: '0123456789', code: '+60', line1: 'Test Street', city: 'Johor Bahru', region: 'Johor', postcode: '81100', country: 'my' };
function fixture() {
  const map = new Map();
  const storage = { getItem: key => map.get(key), setItem: (key,value) => map.set(key,value) };
  let next = 0;
  return { storage, store: createAddressStore(storage, () => `address-${++next}`) };
}
test('address book starts empty; stable IDs, editing and defaults survive reload', () => {
  const {store, storage} = fixture();
  assert.deepEqual(store.read().entries, []);
  const first = store.save(input), second = store.save({...input, fullName:'Second'});
  assert.equal(store.read().defaultId, first.id);
  store.setDefault(second.id);
  store.save({...input, line1:'Updated'}, first.id);
  const reloaded = createAddressStore(storage);
  assert.equal(reloaded.read().defaultId, second.id);
  assert.equal(reloaded.read().entries[0].line1, 'Updated');
  assert.equal(reloaded.read().entries[0].id, first.id);
  reloaded.remove(second.id);
  assert.equal(reloaded.read().defaultId,first.id);
  reloaded.remove(first.id);
  assert.equal(reloaded.read().defaultId,null);
  assert.throws(() => store.save(input,first.id),/addressMissing/);
});
test('failed persistence never mutates stored addresses or claims success', () => {
  const {store, storage} = fixture();
  const original = store.save(input);
  storage.setItem = () => { throw Error('QuotaExceeded'); };
  assert.throws(() => store.save({...input, fullName:'Unsaved'},original.id),/addressStorageFailed/);
  assert.throws(() => store.remove(original.id),/addressStorageFailed/);
  assert.equal(store.read().entries[0].fullName,input.fullName);
  assert.throws(() => createAddressStore().save(input),/addressStorageFailed/);
});
test('address validation rejects missing recipients, invalid phones and incomplete addresses', () => {
  assert.equal(validateAddressEntry(input).phone,'+60123456789');
  assert.equal(validateAddressEntry(input).country,'MY');
  for (const patch of [{fullName:''},{phone:'invalid'},{line1:''},{city:''},{region:''},{postcode:''},{postcode:'00000'},{postcode:'1234'},{region:'Selangor'},{country:'Malaysia'},{line1:'bad\naddress'}]) {
    assert.throws(() => validateAddressEntry({...input,...patch}));
  }
});
test('Malaysia postcode data determines the state while city remains free text', () => {
  assert.equal(validateAddressEntry({ ...input, phone: '+60 12-345 6789', city: 'Masai' }).phone, '+60123456789');
  assert.equal(validateAddressEntry({ ...input, phone: '60123456789' }).phone, '+60123456789');
  assert.equal(validateAddressEntry({ ...input, phone: '01112345678' }).phone, '+601112345678');
  assert.throws(() => validateAddressEntry({ ...input, phone: '0111234567' }), /profilePhoneInvalid/);
  assert.throws(() => validateAddressEntry({ ...input, country: 'SG' }), /profilePhoneInvalid/);
  assert.equal(validateAddressEntry({ ...input, country: 'SG', phone: '91234567', region: 'Singapore', postcode: '123456' }).code, '+65');
});
test('existing incomplete addresses remain in storage for repair', () => {
  const { store, storage } = fixture();
  storage.setItem('online-shopping-addresses-v1', JSON.stringify({ version: 1, entries: [{ ...input, id: 'legacy', phone: '+60111234567', city: '', region: '', postcode: '00000' }], defaultId: 'legacy' }));
  assert.equal(store.read().entries[0].id, 'legacy');
  assert.throws(() => validateAddressEntry(store.read().entries[0]));
  store.save(input, 'legacy');
  assert.equal(store.read().entries[0].postcode, '81100');
});
test('malformed or unsupported saved data is not silently overwritten', () => {
  const {store,storage} = fixture();
  storage.setItem('online-shopping-addresses-v1',JSON.stringify({version:2,entries:[]}));
  assert.throws(() => store.save(input),/addressStorageFailed/);
  assert.equal(JSON.parse(storage.getItem('online-shopping-addresses-v1')).version,2);
});

test('checkout sends one address and selected snapshot; demo contains no entered contact data', async () => {
  const { checkoutPayload } = await import('../public/shop/checkout-payload.js');
  const profile = {fullName:'Private Buyer',phone:'+60123456789',email:'private@example.test'};
  const address = validateAddressEntry(input);
  const items = [{productId:'chosen',quantity:2,product:{priceMinor:1250,currency:'MYR'}}];
  const args = {profile,address,items,locale:'en',consent:true,demo:false};
  const live = checkoutPayload(args);
  assert.equal(live.deliveries.length,1);
  assert.deepEqual(live.deliveries[0].items,[{productId:'chosen',quantity:2,expectedPriceMinor:1250,expectedCurrency:'MYR'}]);
  assert.equal(live.deliveries[0].recipient.fullName,address.fullName);
  const anonymous = checkoutPayload({...args,demo:true});
  const serialized = JSON.stringify(anonymous);
  for (const privateValue of [profile.fullName,profile.phone,profile.email,address.fullName,address.line1]) assert.ok(!serialized.includes(privateValue));
  assert.equal(anonymous.whatsappOrderContactOptIn,false);
  assert.throws(() => checkoutPayload({...args,address:null}),/addressRequired/);
  assert.throws(() => checkoutPayload({...args,items:[...items,{productId:'other',quantity:1,product:{priceMinor:100,currency:'SGD'}}]}),/mixedCurrencies/);
});
