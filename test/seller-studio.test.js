import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { studioCopy, snapshotCount } from '../public/seller/studio-copy.js';
import { languages, messages } from '../public/shared/i18n.js';

test('Seller studio copy covers seven languages and bounded dashboard counts never imply a global total', () => {
  const keys = Object.keys(studioCopy.en).sort();
  for (const { code } of languages) {
    assert.deepEqual(Object.keys(studioCopy[code]).sort(), keys);
    for (const key of keys) assert.equal(messages[code][key], studioCopy[code][key]);
  }
  assert.equal(snapshotCount({ items: [], nextOffset: null }), '0');
  assert.equal(snapshotCount({ items: Array(35), nextOffset: null }), '35');
  assert.equal(snapshotCount({ items: Array(100), nextOffset: null }), '100');
  assert.equal(snapshotCount({ items: Array(100), nextOffset: 100 }), '100+');
  assert.throws(() => snapshotCount({}), /invalid count page/);
});

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + .05) / (dark + .05);
}

test('warm Seller default keeps contrast and semantic price/error colors; new assets are in the offline shell', () => {
  const css = readFileSync(new URL('../public/seller/commerce.css', import.meta.url), 'utf8');
  const block = css.slice(0, css.indexOf('}') + 1);
  const tokens = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/gi)].map(([, name, value]) => [name, value]));
  assert.ok(contrast('#ffffff', tokens['--ui-primary']) >= 4.5);
  assert.ok(contrast(tokens['--ui-muted'], tokens['--ui-canvas']) >= 4.5);
  assert.ok(contrast(tokens['--ui-secondary-text'], '#ffffff') >= 4.5);
  assert.ok(contrast(tokens['--ui-control-border'], '#ffffff') >= 3);
  assert.ok(contrast(tokens['--shop-selected-text'], tokens['--shop-accent-soft']) >= 4.5);
  assert.ok(contrast(tokens['--ui-focus'], '#ffffff') >= 3);
  for (const role of ['--shop-price', '--shop-order-total', '--shop-error', '--shop-success', '--shop-warning-text']) assert.equal(tokens[role], undefined);
  const sw = readFileSync(new URL('../public/seller/sw.js', import.meta.url), 'utf8');
  for (const asset of ['/seller/commerce.css', '/seller/studio-copy.js', '/seller/assets/studio-leaf.svg']) assert.ok(sw.includes(`'${asset}'`));
  assert.ok(!sw.includes('/api/'));
});
