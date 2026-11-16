import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/shared/theme.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/shared/theme.css', import.meta.url), 'utf8');
const key = 'online-shopping-theme-v1';
function fixture({ saved = null, dark = false, blocked = false } = {}) {
  const handlers = {}, elements = [], meta = {}, root = { dataset: {} }, storage = new Map(saved === null ? [] : [[key, saved]]);
  const control = { append(element) { elements.push(element); }, innerHTML: '' };
  const localStorage = {
    getItem(name) { if (blocked) throw Error('Blocked'); return storage.get(name) ?? null; },
    setItem(name, value) { if (blocked) throw Error('Blocked'); storage.set(name, value); },
  };
  const system = { matches: dark, addEventListener(name, handler) { handlers.media = handler; } };
  const document = {
    documentElement: root,
    querySelector: () => meta,
    querySelectorAll: selector => selector.endsWith('select') ? elements : [control],
    addEventListener(name, handler) { handlers[name] = handler; },
    createElement() { return { append() {}, setAttribute(name, value) { this[name] = value; }, addEventListener(name, handler) { this[name] = handler; } }; },
  };
  runInNewContext(script, { document, localStorage, matchMedia: () => system, addEventListener(name, handler) { handlers[name] = handler; } });
  return { root, meta, storage, control, system, handlers, mount() { handlers.DOMContentLoaded(); return elements[0]; } };
}

test('theme resolves synchronously before controls mount and persists all three choices', () => {
  const f = fixture({ saved: 'dark' });
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.meta.content, '#202d25');
  const select = f.mount(); assert.equal(select.value, 'dark'); assert.equal(select['aria-label'], 'Theme');
  for (const mode of ['system', 'light', 'dark']) {
    select.value = mode; select.change();
    assert.equal(f.storage.get(key), mode);
    assert.equal(f.root.dataset.themePreference, mode);
    assert.equal(f.root.dataset.theme, mode === 'system' ? 'light' : mode);
  }
  assert.match(f.control.innerHTML, /<path d="M20\.9 13/);
  assert.match(f.control.innerHTML, /<path d="M20\.9 13/);
});

test('System tracks OS changes; explicit Light and Dark override OS changes', () => {
  const f = fixture(); const select = f.mount();
  f.system.matches = true; f.handlers.media(); assert.equal(f.root.dataset.theme, 'dark');
  select.value = 'light'; select.change(); f.handlers.media(); assert.equal(f.root.dataset.theme, 'light');
  select.value = 'dark'; select.change(); f.system.matches = false; f.handlers.media(); assert.equal(f.root.dataset.theme, 'dark');
});

test('invalid, cleared, or cross-tab preferences fall back to System and synchronize controls', () => {
  const f = fixture({ saved: 'invalid', dark: true }); const select = f.mount();
  assert.equal(select.value, 'system'); assert.equal(f.root.dataset.theme, 'dark');
  f.handlers.storage({ key, newValue: 'light' }); assert.equal(select.value, 'light'); assert.equal(f.meta.content, '#ffffff');
  f.handlers.storage({ key: 'unrelated', newValue: 'dark' }); assert.equal(select.value, 'light');
  f.handlers.storage({ key: null, newValue: null }); assert.equal(select.value, 'system'); assert.equal(f.root.dataset.theme, 'dark');
});

test('blocked storage keeps a usable session-only toggle', () => {
  const f = fixture({ blocked: true, dark: true }); const select = f.mount();
  assert.equal(f.root.dataset.theme, 'dark'); select.value = 'light'; select.change(); assert.equal(f.root.dataset.theme, 'light');
});

test('seller and shop main/offline shells resolve theme before styles, lock zoom, and cache shared files', () => {
  for (const surface of ['seller', 'shop']) {
    for (const page of ['index', 'offline']) {
      const html = readFileSync(new URL(`../public/${surface}/${page}.html`, import.meta.url), 'utf8');
      assert.ok(html.indexOf('<script src="../shared/theme.js"></script>') < html.indexOf('<link rel="stylesheet"'));
      assert.match(html, /maximum-scale=1, user-scalable=no/);
      assert.match(html, /data-theme-control/); assert.match(html, /name="theme-color"/);
    }
    const worker = readFileSync(new URL(`../public/${surface}/sw.js`, import.meta.url), 'utf8');
    for (const file of ['theme.css', 'theme.js']) assert.ok(worker.includes(`'../shared/${file}'`));
  }
});

test('forest dark tokens meet WCAG AA for primary, muted, status and action text', () => {
  const block = css.split(':root:root[data-theme="dark"] {')[1].split('}')[0];
  const tokens = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/g)].map(([, name, value]) => [name, value]));
  tokens['--ui-on-action'] = '#ffffff';
  const luminance = hex => hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const pairs = [['--ui-text', '--ui-surface'], ['--ui-muted', '--ui-surface'], ['--ui-secondary-text', '--ui-canvas'], ['--ui-primary', '--ui-surface'], ['--ui-action-text', '--ui-surface'], ['--shop-error', '--ui-surface'], ['--shop-success', '--shop-selected-surface'], ['--shop-warning-text', '--shop-warning-background'], ['--ui-on-action', '--ui-action']];
  for (const [foreground, background] of pairs) {
    const [high, low] = [tokens[foreground], tokens[background]].map(luminance).sort((a, b) => b - a);
    assert.ok((high + .05) / (low + .05) >= 4.5, `${foreground} on ${background}`);
  }
  assert.match(css, /:root:root\[data-theme="dark"\]/); // Outranks both seller and shop palette attributes.
});
