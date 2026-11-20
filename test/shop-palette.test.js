import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paletteChoices } from '../public/shared/palette-registry.js';

const stylesheet = readFileSync(new URL('../public/shared/theme.css', import.meta.url), 'utf8');
const roles = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,6})\s*;/gi)].map(([, name, color]) => [name, color]));
const blocks = [...stylesheet.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
const base = roles(blocks.find(([, selector]) => selector.trim().startsWith(':root,'))[2]);
const paletteIds = ['evergreen-teal', 'warm-plum', 'ocean-blue', 'navy-orange', 'high-contrast', 'graphite', 'indigo', 'emerald', 'rose', 'copper'];
const palettes = paletteIds.map((id) => ({
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

test('the shared catalog lists the original six and four new unique palettes', () => {
  assert.deepEqual(paletteChoices.map(([id]) => id).sort(), [...paletteIds].sort());
});

test('all Shop light palettes keep readable text, actions, states, borders, and focus', () => {
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

async function loadPalette(t, surface) {
  const module = new URL(`../public/${surface}/palette.js`, import.meta.url);
  module.searchParams.set('test', t.name);
  await import(module.href);
}

function fixture(t, { values = new Map(), blocked = false, scope = '' } = {}) {
  const events = [];
  const document = { documentElement: { dataset: {} } };
  const window = { addEventListener(name, listener) { if (name === 'storage') events.push(listener); } };
  const localStorage = {
    getItem(key) { if (blocked) throw Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); },
  };
  const globals = { document, window, localStorage, shopStorageNamespace: scope };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  return { document, window, values, storage(event) { for (const listener of events) listener(event); } };
}

test('palette preference applies on import, persists, validates input, and syncs tabs', async t => {
  const key = 'online-shopping-shop-palette-v1';
  const f = fixture(t, { values: new Map([[key, 'warm-plum']]) });
  await loadPalette(t, 'shop');
  assert.equal(f.document.documentElement.dataset.shopPalette, 'warm-plum');
  assert.equal(f.window.shopPalette.choose('copper'), true);
  assert.equal(f.values.get(key), 'copper');
  assert.equal(f.window.shopPalette.choose('unknown'), false);
  assert.equal(f.window.shopPalette.current(), 'copper');
  f.storage({ key, newValue: 'evergreen-teal' });
  assert.equal(f.document.documentElement.dataset.shopPalette, 'evergreen-teal');
});

test('failed storage never reports a saved preference', async t => {
  const f = fixture(t, { blocked: true });
  await loadPalette(t, 'shop');
  assert.equal(f.document.documentElement.dataset.shopPalette, 'evergreen-teal');
  assert.equal(f.window.shopPalette.choose('rose'), false);
  assert.equal(f.document.documentElement.dataset.shopPalette, 'rose');
});

test('seller and customer preferences persist independently for the same ten palettes', async t => {
  const shop = 'online-shopping-shop-palette-v1';
  const seller = 'online-shopping-seller-palette-v1';
  const f = fixture(t, { values: new Map([[shop, 'warm-plum'], [seller, 'graphite']]) });
  await loadPalette(t, 'shop');
  await loadPalette(t, 'seller');
  assert.equal(f.window.sellerPalette.current(), 'graphite');
  assert.equal(f.window.shopPalette.current(), 'warm-plum');
  for (const id of paletteIds) assert.equal(f.window.sellerPalette.choose(id), true);
  assert.equal(f.values.get(shop), 'warm-plum');
  assert.equal(f.window.sellerPalette.choose('forged'), false);
  f.storage({ key: seller, newValue: 'high-contrast' });
  assert.equal(f.document.documentElement.dataset.sellerPalette, 'high-contrast');
  assert.equal(f.document.documentElement.dataset.shopPalette, 'warm-plum');
});

test('tenant palette preferences ignore default and other tenant storage', async t => {
  const key = 'online-shopping-shop-palette-v1';
  const scope = 't-0123456789ab';
  const scoped = `${key}:${scope}`;
  const other = `${key}:t-abcdef123456`;
  const f = fixture(t, { scope, values: new Map([[key, 'warm-plum'], [other, 'graphite'], [scoped, 'indigo']]) });
  await loadPalette(t, 'shop');
  assert.equal(f.window.shopPalette.current(), 'indigo');
  f.storage({ key, newValue: 'rose' });
  f.storage({ key: other, newValue: 'rose' });
  assert.equal(f.window.shopPalette.current(), 'indigo');
  assert.equal(f.window.shopPalette.choose('emerald'), true);
  assert.equal(f.values.get(key), 'warm-plum');
  assert.equal(f.values.get(other), 'graphite');
  assert.equal(f.values.get(scoped), 'emerald');
});
