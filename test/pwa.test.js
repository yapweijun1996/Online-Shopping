import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('shop and seller manifests have separate scopes and real icon sizes', () => {
  const ids = new Set();
  for (const surface of ['shop', 'seller']) {
    const manifest = JSON.parse(readFileSync(new URL(`../public/${surface}/manifest.webmanifest`, import.meta.url), 'utf8'));
    assert.equal(manifest.id, `/${surface}/`);
    assert.equal(manifest.scope, `/${surface}/`);
    assert.equal(manifest.start_url, `/${surface}/`);
    assert.equal(manifest.display, 'standalone');
    assert.equal(ids.has(manifest.id), false);
    ids.add(manifest.id);
    assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
    for (const icon of manifest.icons) {
      const png = readFileSync(new URL(`../public${icon.src}`, import.meta.url));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const size = Number.parseInt(icon.sizes, 10);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
});

test('shop theme color matches its brand token and is cached offline', () => {
  const tokens = readFileSync(new URL('../public/shop/tokens.css', import.meta.url), 'utf8');
  const style = readFileSync(new URL('../public/shop/style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/shop/index.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../public/shop/manifest.webmanifest', import.meta.url), 'utf8'));
  const worker = readFileSync(new URL('../public/shop/sw.js', import.meta.url), 'utf8');
  const brand = tokens.match(/--ui-primary:\s*(#[0-9a-f]{6})\s*;/i)?.[1];
  assert.ok(brand, 'shop brand token is defined');
  assert.equal(html.match(/<meta name="theme-color" content="(#[0-9a-f]{6})">/i)?.[1], brand);
  assert.equal(manifest.theme_color, brand);
  assert.match(style, /@import url\('\/shop\/tokens\.css'\)/);
  assert.match(worker, /'\/shop\/tokens\.css'/);
});

import vm from 'node:vm';

test('worker reports its own version and activates early only on explicit request', async () => {
  const handlers = new Map();
  let skips = 0;
  const context = {
    self: {
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: async () => { skips += 1; },
    },
  };
  vm.runInNewContext(readFileSync(new URL('../public/shared/sw-core.js', import.meta.url), 'utf8'), context);
  context.self.setupOfflineWorker({ cachePrefix: 'test', version: 'v123', assets: [], scopePath: '/shop/' });
  assert.equal(skips, 0);
  let reply;
  handlers.get('message')({ data: { type: 'GET_VERSION' }, ports: [{ postMessage: (data) => { reply = data; } }] });
  assert.equal(reply.version, 'v123');
  assert.equal(skips, 0);
  handlers.get('message')({ data: { type: 'UNKNOWN' } });
  assert.equal(skips, 0);
  let activation;
  handlers.get('message')({ data: { type: 'SKIP_WAITING' }, waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.equal(skips, 1);
});

test('every relative shop module dependency is present in the offline shell allowlist', () => {
  const worker = readFileSync(new URL('../public/shop/sw.js', import.meta.url), 'utf8');
  const assets = [...worker.matchAll(/'(\/[^']+)'/g)].map(match => match[1]);
  for (const asset of assets.filter(path => path.endsWith('.js'))) {
    const source = readFileSync(new URL(`../public${asset}`, import.meta.url), 'utf8');
    for (const [, dependency] of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
      const path = new URL(dependency, `https://example.test${asset}`).pathname;
      assert.ok(assets.includes(path), `${asset} depends on uncached ${path}`);
    }
  }
});

test('out-of-scope recovery shows waiting version and returns only after confirmed activation', async () => {
  const nodes = [];
  const workerHandlers = new Map();
  let confirmed = false;
  let skips = 0;
  let returned = null;
  const waiting = {
    state: 'installed',
    addEventListener(type, handler) { workerHandlers.set(type, handler); },
    postMessage(message, ports) {
      if (message.type === 'GET_VERSION') ports[0].reply({ version: 'v41' });
      if (message.type === 'SKIP_WAITING') skips++;
    },
  };
  const registration = { waiting, active: null, installing: null, addEventListener() {} };
  const context = {
    t: key => key,
    navigator: { serviceWorker: { register: async () => registration, controller: null, addEventListener() {} } },
    document: {
      createElement() {
        const node = { handlers: {}, setAttribute() {}, append() {}, addEventListener(type, fn) { this.handlers[type] = fn; } };
        nodes.push(node); return node;
      },
      body: { append() {} }, addEventListener() {},
    },
    window: { confirm: () => confirmed, addEventListener() {} },
    location: { assign: url => { returned = url; }, reload() { throw Error('Recovery must return to shop'); } },
    MessageChannel: class {
      constructor() { this.port1 = { close() {} }; this.port2 = { reply: data => this.port1.onmessage({ data }) }; }
    },
    setTimeout: () => 1, clearTimeout() {},
  };
  const source = readFileSync(new URL('../public/shared/pwa.js', import.meta.url), 'utf8')
    .replace("import { t } from './i18n.js';", '').replace('export async function', 'async function');
  vm.runInNewContext(source, context);
  await context.registerWorker('/shop/sw.js', '/shop/', { returnUrl: '/shop/' });
  const update = nodes[4];
  assert.equal(update.hidden, false);
  assert.match(update.textContent, /v41/);
  update.handlers.click();
  assert.equal(skips, 0);
  confirmed = true;
  update.handlers.click();
  assert.equal(skips, 1);
  assert.equal(returned, null);
  waiting.state = 'activated';
  workerHandlers.get('statechange')();
  assert.equal(returned, '/shop/');
});

test('activation removes only superseded shell caches and preserves other storage', async () => {
  const handlers = new Map();
  const deleted = [];
  let claimed = false;
  const context = {
    self: { addEventListener: (name, handler) => handlers.set(name, handler), clients: { claim: async () => { claimed = true; } } },
    caches: { keys: async () => ['os-shop-v36', 'os-shop-v41', 'os-seller-v45', 'unrelated'], delete: async name => deleted.push(name) },
  };
  vm.runInNewContext(readFileSync(new URL('../public/shared/sw-core.js', import.meta.url), 'utf8'), context);
  context.self.setupOfflineWorker({ cachePrefix: 'os-shop', version: 'v41', assets: [], scopePath: '/shop/' });
  let done;
  handlers.get('activate')({ waitUntil: value => { done = value; } });
  await done;
  assert.deepEqual(deleted, ['os-shop-v36']);
  assert.equal(claimed, true);
});

test('shop update state supports clean one-click, dirty cancellation, busy guard and external activation', async () => {
  let state, commands, busy = false, dirty = false, accept = false, confirmations = 0, skips = 0, reloads = 0;
  const handlers = new Map();
  const worker = version => ({ state: 'installed', addEventListener() {}, postMessage(message, ports) {
    if (message.type === 'GET_VERSION') ports[0].reply({ version });
    if (message.type === 'SKIP_WAITING') skips++;
  } });
  const registration = { waiting: worker('v42'), active: worker('v41'), installing: null, addEventListener() {}, async update() {} };
  const serviceWorker = { controller: registration.active, register: async () => registration, addEventListener: (name, fn) => handlers.set(name, fn) };
  const context = {
    t: key => key, navigator: { onLine: true, serviceWorker },
    document: { createElement: () => ({ disabled: false, setAttribute() {}, append() {}, addEventListener() {} }), body: { append() { throw Error('Shop must not mount legacy footer'); } }, addEventListener() {} },
    window: { addEventListener() {}, confirm() { throw Error('Shop must use its custom confirmation'); } },
    location: { reload() { reloads++; } },
    MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { reply: data => this.port1.onmessage({ data }) }; } },
    setTimeout: () => 1, clearTimeout() {},
  };
  const source = readFileSync(new URL('../public/shared/pwa.js', import.meta.url), 'utf8').replace("import { t } from './i18n.js';", '').replace('export async function', 'async function');
  vm.runInNewContext(source, context);
  await context.registerWorker('/shop/sw.js', '/shop/', {
    guard: () => ({ busy, dirty }), confirmUpdate: async () => { confirmations++; return accept; },
    onState(next, actions) { state = next; commands = actions; },
  });
  assert.equal(state.current, 'v41'); assert.equal(state.available, 'v42'); assert.equal(state.ready, true);
  busy = true; await commands.update(); assert.equal(skips, 0); assert.equal(confirmations, 0);
  busy = false; dirty = true; await commands.update(); assert.equal(skips, 0); assert.equal(confirmations, 1);
  registration.waiting = null; serviceWorker.controller = worker('v42');
  await handlers.get('controllerchange')();
  assert.equal(reloads, 0); assert.equal(state.ready, true); assert.equal(state.available, 'v42');
  await commands.update(); assert.equal(reloads, 0);
  dirty = false; await commands.update(); assert.equal(reloads, 1); assert.equal(confirmations, 2);
});

test('superseded worker redundancy does not cancel installation; activation reloads once', async () => {
  let actions, state, stateChange, oldStateChange, controllerChange, reloads = 0, skips = 0;
  const waiting = { state: 'installed', addEventListener(name, handler) { if (name === 'statechange') stateChange = handler; },
    postMessage(message, ports) {
      if (message.type === 'GET_VERSION') ports[0].reply({ version: 'v65' });
      if (message.type === 'SKIP_WAITING') skips++;
    } };
  const active = { state: 'activated', addEventListener(name, handler) { if (name === 'statechange') oldStateChange = handler; }, postMessage(message, ports) {
    if (message.type === 'GET_VERSION') ports[0].reply({ version: 'v64' });
  } };
  const registration = { waiting, active, installing: active, addEventListener() {}, async update() {} };
  const context = {
    t: key => key,
    navigator: { onLine: true, serviceWorker: { controller: active, register: async () => registration,
      addEventListener(name, handler) { if (name === 'controllerchange') controllerChange = handler; } } },
    document: { createElement: () => ({ disabled: false, setAttribute() {}, append() {}, addEventListener() {} }), body: { append() {} }, addEventListener() {} },
    window: { addEventListener() {}, confirm: () => true },
    location: { reload() { reloads++; } },
    MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { reply: data => this.port1.onmessage({ data }) }; } },
    setTimeout: () => 1, clearTimeout() {},
  };
  const source = readFileSync(new URL('../public/shared/pwa.js', import.meta.url), 'utf8').replace("import { t } from './i18n.js';", '').replace('export async function', 'async function');
  vm.runInNewContext(source, context);
  await context.registerWorker('/seller/sw.js', '/seller/', { onState(nextState, nextActions) { state = nextState; actions = nextActions; } });
  await actions.update();
  assert.equal(skips, 1);
  active.state = 'redundant';
  oldStateChange();
  assert.equal(state.applying, true);
  assert.equal(state.statusKey, 'appUpdating');
  waiting.state = 'activated';
  stateChange();
  assert.equal(reloads, 1);
  await controllerChange();
  assert.equal(reloads, 1);
});

async function updateHarness() {
  let state, commands, checks = 0, reloads = 0;
  const events = new Map(), timers = new Map();
  let nextTimer = 0;
  const worker = { state: 'activated', addEventListener() {}, postMessage(message, ports) { if (message.type === 'GET_VERSION') ports[0].reply({ version: 'v42' }); } };
  const registration = { active: worker, waiting: null, installing: null, addEventListener() {}, update: async () => { checks++; } };
  const navigator = { onLine: false, serviceWorker: { controller: worker, register: async () => registration, addEventListener() {} } };
  const context = {
    t: key => key, navigator,
    document: { createElement: () => ({ disabled: false, setAttribute() {}, append() {}, addEventListener() {} }), body: { append() {} }, addEventListener() {} },
    window: { addEventListener: (name, fn) => events.set(name, fn) }, location: { reload: () => { reloads++; } },
    MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { reply: data => this.port1.onmessage({ data }) }; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  const source = readFileSync(new URL('../public/shared/pwa.js', import.meta.url), 'utf8').replace("import { t } from './i18n.js';", '').replace('export async function', 'async function');
  vm.runInNewContext(source, context);
  await context.registerWorker('/shop/sw.js', '/shop/', { guard: () => ({ dirty: false, busy: false }), confirmUpdate: async () => true, onState(next, actions) { state = next; commands = actions; } });
  return { get state() { return state; }, get checks() { return checks; }, get reloads() { return reloads; }, commands, navigator, registration, events, timers, worker };
}

test('offline update checks remain retryable and online recovery clears failure', async () => {
  const h = await updateHarness();
  await h.commands.check();
  assert.equal(h.state.statusKey, 'updateFailed'); assert.equal(h.state.checking, false); assert.equal(h.checks, 0);
  h.navigator.onLine = true;
  await h.events.get('online')();
  assert.equal(h.state.statusKey, 'appUpToDate'); assert.equal(h.state.ready, false); assert.equal(h.reloads, 0);
});

test('failed network check allows retry and concurrent checks share the active attempt', async () => {
  const h = await updateHarness(); h.navigator.onLine = true;
  h.registration.update = async () => { throw Error('network unavailable'); };
  await h.commands.check(); assert.equal(h.state.statusKey, 'updateFailed'); assert.equal(h.state.checking, false);
  let finish, calls = 0;
  h.registration.update = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = h.commands.check(); await h.commands.check();
  assert.equal(calls, 1); finish(); await first;
  assert.equal(h.state.statusKey, 'appUpToDate'); assert.equal(h.state.checking, false);
});

test('activation message failure leaves page intact and retry succeeds', async () => {
  const h = await updateHarness(); h.navigator.onLine = true;
  let fail = true, skips = 0;
  h.registration.waiting = { ...h.worker, postMessage(message, ports) {
    if (message.type === 'GET_VERSION') ports[0].reply({ version: 'v43' });
    else { if (fail) throw Error('worker disconnected'); skips++; }
  } };
  await h.commands.check(); await h.commands.update();
  assert.equal(h.state.statusKey, 'updateFailed'); assert.equal(h.state.applying, false); assert.equal(h.state.ready, true); assert.equal(h.reloads, 0);
  fail = false; await h.commands.update(); assert.equal(skips, 1); assert.equal(h.state.applying, true);
  [...h.timers.values()].find(timer => timer.ms === 15000).fn();
  assert.equal(h.state.applying, false); assert.equal(h.state.statusKey, 'updateFailed');
  await h.commands.update(); assert.equal(skips, 2);
});
