import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollChromeState } from '../public/shop/mobile-navigation.js';
test('browsing navigation hides after deliberate forward scroll and returns on reverse', () => {
  assert.deepEqual(scrollChromeState({ previous:100,current:135,hidden:false,anchor:100 }),{hidden:true,anchor:135});
  assert.deepEqual(scrollChromeState({ previous:135,current:118,hidden:true,anchor:135 }),{hidden:false,anchor:118});
  assert.equal(scrollChromeState({ previous:100,current:103,hidden:false,anchor:100 }).hidden,false);
  assert.equal(scrollChromeState({ previous:60,current:20,hidden:true,anchor:60 }).hidden,false);
});
