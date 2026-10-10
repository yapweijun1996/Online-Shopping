import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext as rawContext } from 'node:vm';
const runInNewContext = (source, context) => rawContext(source.replace(/^import .*\n/m, ''), { scopedKey: (key) => key, ...context });

const stylesheet = readFileSync(new URL('../public/shop/tokens.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/shop/palette.js', import.meta.url), 'utf8');
const roles = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,6})\s*;/gi)].map(([, name, color]) => [name, color]));
const blocks = [...stylesheet.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
const base = roles(blocks.find(([, selector]) => selector.trim().startsWith(':root,'))[2]);
const palettes = ['evergreen-teal', 'warm-plum', 'ocean-blue', 'navy-orange', 'high-contrast', 'graphite'].map((id) => ({
  id,
  colors: { ...base, ...roles(blocks.find(([, selector]) => selector.includes(`data-shop-palette="${id}"`))?.[2] || '') },
}));

function luminance(hex) {
  const expanded = hex.length === 4 ? `#${[...hex.slice(1)].map(value => value + value).join('')}` : hex;
  const channels = expanded.slice(1).match(/../g).map(value => Number.parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(colors, foreground, background) {
  const values = [luminance(colors[foreground] || foreground), luminance(colors[background] || background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('all Shop palettes keep readable text, actions, states, borders, and focus', () => {
  const pairs = [
    ['primary button text', '#ffffff', '--ui-primary', 4.5],
    ['accent button text', '#ffffff', '--shop-accent', 4.5],
    ['action button text', '#ffffff', '--ui-action', 4.5],
    ['action text on page', '--ui-action', '--ui-surface', 4.5],
    ['action hover text', '#ffffff', '--ui-primary-hover', 4.5],
    ['body text', '--ui-text', '--ui-surface', 4.5],
    ['body text on canvas', '--ui-text', '--ui-canvas', 4.5],
    ['muted text', '--ui-muted', '--ui-surface', 4.5],
    ['placeholder text', '--ui-muted', '--ui-hover-surface', 4.5],
    ['secondary text', '--ui-secondary-text', '--ui-surface', 4.5],
    ['price', '--shop-price', '--ui-surface', 4.5],
    ['price on selected surface', '--shop-price', '--shop-selected-surface', 4.5],
    ['selected navigation text', '--shop-selected-text', '--shop-accent-soft', 4.5],
    ['selected badge text', '--shop-selected-text', '--shop-selected-strong', 4.5],
    ['order total', '--shop-order-total', '--ui-surface', 4.5],
    ['warning text', '--shop-warning-text', '--shop-warning-background', 4.5],
    ['demo text', '--shop-demo-text', '--shop-demo-background', 4.5],
    ['error text', '--shop-error', '--ui-surface', 4.5],
    ['success text', '--shop-success', '--ui-surface', 4.5],
    ['control border', '--ui-control-border', '--ui-surface', 3],
    ['product control border', '--shop-control-border', '--ui-surface', 3],
    ['focus ring', '--ui-focus', '--ui-surface', 3],
  ];
  for (const { id, colors } of palettes) {
    if (id !== 'evergreen-teal') assert.ok(blocks.some(([, selector]) => selector.includes(`data-shop-palette="${id}"`)), `${id}: palette block is missing`);
    for (const [label, foreground, background, minimum] of pairs) {
      assert.ok(colors[foreground] || foreground.startsWith('#'), `${id}: missing ${foreground}`);
      assert.ok(colors[background] || background.startsWith('#'), `${id}: missing ${background}`);
      assert.ok(contrast(colors, foreground, background) >= minimum, `${id}: ${label} is below ${minimum}:1`);
    }
  }
  const invariant = ['--shop-price', '--shop-order-total', '--shop-error', '--shop-success', '--shop-warning-background', '--shop-warning-text'];
  for (const role of invariant) assert.equal(new Set(palettes.map(({ colors }) => colors[role])).size, 1, `${role} must remain invariant`);
});

test('palette preference applies early, persists, validates input, and syncs tabs', () => {
  const values = new Map([['online-shopping-shop-palette-v1', 'warm-plum']]);
  const events = new Map();
  const document = { documentElement: { dataset: {} } };
  const window = { addEventListener(name, listener) { events.set(name, listener); } };
  const localStorage = { getItem(key) { return values.get(key); }, setItem(key, value) { values.set(key, value); } };
  runInNewContext(script, { document, window, localStorage });
  assert.equal(document.documentElement.dataset.shopPalette, 'warm-plum');
  assert.equal(window.shopPalette.choose('ocean-blue'), true);
  assert.equal(values.get('online-shopping-shop-palette-v1'), 'ocean-blue');
  assert.equal(window.shopPalette.choose('unknown'), false);
  assert.equal(window.shopPalette.current(), 'ocean-blue');
  events.get('storage')({ key: 'online-shopping-shop-palette-v1', newValue: 'evergreen-teal' });
  assert.equal(document.documentElement.dataset.shopPalette, 'evergreen-teal');
});

test('failed storage never reports a saved preference', () => {
  const document = { documentElement: { dataset: {} } };
  const window = { addEventListener() {} };
  const localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  runInNewContext(script, { document, window, localStorage });
  assert.equal(document.documentElement.dataset.shopPalette, 'evergreen-teal');
  assert.equal(window.shopPalette.choose('warm-plum'), false);
  assert.equal(document.documentElement.dataset.shopPalette, 'warm-plum');
});

test('seller and customer preferences persist independently and share all five accessible palettes', () => {
  const values = new Map([['online-shopping-shop-palette-v1', 'warm-plum'], ['online-shopping-seller-palette-v1', 'graphite']]);
  const events = [], document = { documentElement: { dataset: {} } };
  const window = { addEventListener(name, fn) { events.push(fn); } };
  const localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  runInNewContext(script, { document, window, localStorage });
  runInNewContext(readFileSync(new URL('../public/seller/palette.js', import.meta.url), 'utf8'), { document, window, localStorage });
  assert.equal(window.sellerPalette.current(), 'graphite'); assert.equal(window.shopPalette.current(), 'warm-plum');
  for (const { id } of palettes) assert.equal(window.sellerPalette.choose(id), true);
  assert.equal(values.get('online-shopping-shop-palette-v1'), 'warm-plum');
  assert.equal(window.sellerPalette.choose('forged'), false);
  for (const fn of events) fn({ key: 'online-shopping-seller-palette-v1', newValue: 'high-contrast' });
  assert.equal(document.documentElement.dataset.sellerPalette, 'high-contrast');
  assert.equal(document.documentElement.dataset.shopPalette, 'warm-plum');
});
