import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messages, languages } from '../public/shared/i18n.js';
import { mountMessages, mountOrderMessages, startMessageBadge } from '../public/seller/messages.js';

const source = readFileSync(new URL('../public/seller/messages.js', import.meta.url), 'utf8');
const keys = [...source.match(/const keys = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
const file = name => readFileSync(new URL(`../public/seller/${name}`, import.meta.url), 'utf8');

test('Messages imports without a DOM and registers every key in seven real translations', () => {
  assert.equal(languages.length, 7);
  assert.ok(keys.length > 0);
  const used = [...source.matchAll(/'((?:msg)[A-Z][A-Za-z]+)'/g)].map(match => match[1]);
  for (const key of used) assert.ok(keys.includes(key), key);
  for (const { code } of languages) for (const key of keys) {
    assert.equal(typeof messages[code][key], 'string', `${code}: ${key}`);
    assert.ok(messages[code][key].trim(), `${code}: ${key}`);
    if (code !== 'en') assert.notEqual(messages[code][key], messages.en[key], `${code}: ${key}`);
    assert.doesNotMatch(messages[code][key], /demo/i);
  }
});

test('Messages uses safe text nodes, no storage and only documented mutation payloads', () => {
  assert.doesNotMatch(source, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/);
  assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b|lastError/);
  const mutations = [...source.matchAll(/request\('POST', ([^\n]+)\n/g)].map(match => match[1]);
  assert.equal(mutations.length, 2);
  assert.match(mutations[0], /messages\/replies\/\$\{encodeURIComponent\(item.id\)\}\/read`, \{\}, csrfToken/);
  assert.match(mutations[1], /messages\/outbox\/\$\{encodeURIComponent\(item.id\)\}\/resolve`, \{ resolution \}, csrfToken/);
  assert.doesNotMatch(source, /request\('(PUT|PATCH|DELETE)'/);
  assert.match(source, /resolve\(item, 'SENT'/);
  assert.match(source, /resolve\(item, 'RESEND'/);
  assert.match(source, /confirmModal\(/);
  assert.match(messages.en.msgResendConfirm, /twice/);
  assert.match(source, /body.textContent = item.body/);
});

test('seller v133 precaches Messages and hides the navigation entry by default', () => {
  assert.match(file('sw.js'), /'\/seller\/messages\.js'/);
  const workerVersion = file('sw.js').match(/version: '(v\d+)'/)[1];
  assert.equal(workerVersion, file('version.js').match(/APP_VERSION = '(v\d+)'/)[1]);
  assert.equal(workerVersion, 'v133');
  assert.match(file('index.html'), /<button\b[^>]*data-view="messages"[^>]*\bhidden[\s>]/);
  assert.match(file('app.js'), /messages: 'msgHeading'/);
  assert.match(file('orders.js'), /mountOrderMessages\(detailContent/);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.textContent = ''; this.hidden = false; this.classList = { add() {}, remove() {} }; }
  get parentElement() { return this.parentNode; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  querySelector(selector) { return selector === '[aria-pressed="true"]' ? null : this.descendants().find(node => ['button', 'input'].includes(node.tagName)); }
  get isConnected() { return this.connected || Boolean(this.parentNode?.isConnected); }
  append(...nodes) { nodes.forEach(node => { node.parentNode = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  descendants() { return this.children.flatMap(node => [node, ...node.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(node => selector === 'button' ? node.tagName === 'button' : selector === '[data-i18n]' ? 'i18n' in node.dataset : 'i18nAria' in node.dataset); }
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));
const reply = { id: 'fictional-reply', orderId: 'fictional-order', orderNo: 'ORDER-001', kind: 'TEXT', body: '<script>fictional</script>\nSecond line', receivedAt: '2026-10-08T00:00:00Z', read: false };
async function fixture(fn) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, matchMedia: globalThis.matchMedia };
  const listeners = new Map(), timers = new Map(); let next = 0;
  const root = new Element('main'); root.connected = true;
  globalThis.document = {
    hidden: false, body: root, createElement: tag => new Element(tag),
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  globalThis.setTimeout = (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.matchMedia = () => ({ matches: true });
  try { await fn(root, timers, listeners); } finally { Object.assign(globalThis, previous); }
}
const findKey = (root, key) => root.descendants().find(node => node.dataset.i18n === key);

test('badge gates availability, polls only visible sessions, caps count and removes listeners', async () => {
  await fixture(async (root, timers, listeners) => {
    const calls = []; let token = 'first';
    const navItem = new Element('button'), badge = new Element('span'); root.append(navItem, badge);
    globalThis.fetch = async (path, options) => { calls.push(path); assert.equal(options.cache, 'no-store'); return response(path.endsWith('whatsapp') ? { available: true } : { unreadReplies: 99, reconcile: 2, failed: 1 }); };
    const handle = startMessageBadge({ badge, navItem, csrfToken: () => token, onUnauthorized() { assert.fail('unexpected 401'); } });
    assert.equal(navItem.hidden, true); await flush();
    assert.deepEqual(calls, ['/api/v1/seller/integrations/whatsapp', '/api/v1/seller/messages/summary']);
    assert.equal(navItem.hidden, false); assert.equal(badge.textContent, '99+'); assert.match(badge.attributes['aria-label'], /102/);
    assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 60000);
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); await flush();
    assert.equal(timers.size, 0); assert.equal(calls.length, 2);
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flush(); assert.equal(calls.length, 3);
    token = 'second'; await handle.refresh(); assert.equal(calls.length, 3); assert.equal(timers.size, 0); assert.equal(navItem.hidden, true);
    assert.equal(listeners.get('visibilitychange').size, 0); assert.equal(listeners.get('sellermessageschange').size, 0);
    handle.dispose();
  });
});

test('unavailable connections never read summaries; current 401 signs out; disposed responses stay hidden', async () => {
  await fixture(async root => {
    for (const status of [200, 401, 503]) {
      const calls = []; let unauthorized = 0;
      globalThis.fetch = async path => { calls.push(path); return response({ available: false }, status); };
      const navItem = new Element('button'), badge = new Element('span'); root.append(navItem, badge);
      const handle = startMessageBadge({ badge, navItem, csrfToken: () => 'fictional-csrf', onUnauthorized: () => unauthorized++ });
      await flush(); assert.equal(navItem.hidden, true); assert.equal(calls.length, 1); assert.equal(unauthorized, status === 401 ? 1 : 0); handle.dispose();
    }
    let complete;
    globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
    const navItem = new Element('button'), badge = new Element('span');
    const handle = startMessageBadge({ badge, navItem, csrfToken: () => 'fictional-csrf', onUnauthorized() {} });
    handle.dispose(); complete(response({ available: true })); await flush(); assert.equal(navItem.hidden, true);
  });
});

test('Replies paginate, preserve plain text, mark read with CSRF and refresh the badge', async () => {
  await fixture(async root => {
    const calls = []; let read = false, changes = 0;
    document.addEventListener('sellermessageschange', () => changes++);
    globalThis.fetch = async (path, options) => {
      calls.push({ path, options });
      if (options.method === 'POST') { read = true; return response({ ...reply, read }); }
      assert.equal(options.cache, 'no-store');
      if (path.includes('/outbox')) return response({ items: [], nextOffset: null });
      const offset = new URL(path, 'https://fictional.example').searchParams.get('offset');
      return response({ items: [{ ...reply, id: offset === '30' ? 'second-reply' : reply.id, read }], nextOffset: offset === '0' ? 30 : null });
    };
    const page = mountMessages(root, { csrfToken: () => 'fictional-csrf', onUnauthorized() {} });
    assert.ok(findKey(root, 'msgLoading')); await flush();
    assert.equal(findKey(root, 'msgEmptyAttention').textContent, messages.en.msgEmptyAttention);
    assert.ok(root.descendants().some(node => node.textContent === reply.body));
    await findKey(root, 'msgMore').events.click(); await flush();
    assert.equal(root.descendants().filter(node => node.dataset.i18n === 'msgRead').length, 2);
    const control = findKey(root, 'msgRead'); await control.events.click({ currentTarget: control }); await flush();
    const mutation = calls.find(call => call.options.method === 'POST');
    assert.equal(mutation.options.body, '{}'); assert.equal(mutation.options.headers['X-CSRF-Token'], 'fictional-csrf'); assert.equal(changes, 1);
    assert.equal(findKey(root, 'msgRead'), undefined);
    const toggle = root.descendants().find(node => node.tagName === 'input'); toggle.checked = true; toggle.events.change(); await flush();
    assert.ok(calls.some(call => call.path.includes('unread=1')));
    page.refreshLocale(); page.dispose();
  });
});

test('each list handles errors separately and stale filters, sessions and disposal cannot render', async () => {
  await fixture(async root => {
    const pending = [];
    globalThis.fetch = path => path.includes('outbox') ? Promise.resolve(response({}, 500)) : new Promise(resolve => pending.push(resolve));
    let token = 'first';
    const page = mountMessages(root, { csrfToken: () => token, onUnauthorized() { assert.fail('stale 401'); } });
    await flush(); assert.ok(findKey(root, 'msgError'));
    const toggle = root.descendants().find(node => node.tagName === 'input'); toggle.checked = true; toggle.events.change();
    pending[1](response({ items: [{ ...reply, kind: 'OTHER', orderId: null }], nextOffset: null })); await flush();
    pending[0](response({ items: [reply], nextOffset: 30 })); await flush();
    assert.ok(findKey(root, 'msgOpenWhatsApp')); assert.ok(findKey(root, 'msgNoOrder'));
    toggle.events.change(); token = 'second'; pending[2](response({}, 401)); await flush();
    assert.ok(findKey(root, 'msgLoading'));
    page.dispose();
  });
});

test('order Messages is invisible for empty responses, renders status and text, and discards stale results', async () => {
  await fixture(async root => {
    globalThis.fetch = async () => response({ messages: [], replies: [] });
    const empty = mountOrderMessages(root, { orderId: 'fictional-order', csrfToken: () => 'first', onUnauthorized() {} });
    await flush(); assert.equal(root.children[0].hidden, true); assert.equal(root.children[0].children.length, 0); empty.dispose();
    globalThis.fetch = async () => response({ messages: [{ ...reply, kind: 'ORDER_SHIPPED', status: 'ACCEPTED', createdAt: reply.receivedAt }], replies: [reply] });
    const populated = mountOrderMessages(root, { orderId: 'fictional-order', csrfToken: () => 'first', onUnauthorized() {} });
    await flush(); assert.ok(findKey(root, 'msgShipped')); assert.ok(findKey(root, 'msgAccepted')); assert.ok(findKey(root, 'msgRead')); populated.dispose();
    let complete; globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
    const stale = mountOrderMessages(root, { orderId: 'fictional-order', csrfToken: () => 'first', onUnauthorized() { assert.fail('disposed 401'); } });
    stale.dispose(); complete(response({}, 401)); await flush(); assert.equal(root.children.length, 0);
  });
});

test('attention actions confirm before POST, lock across locale refresh, and reload conflicts with fixed copy', async () => {
  await fixture(async root => {
    const attention = { ...reply, kind: 'ORDER_CONFIRMED', status: 'RECONCILE', createdAt: reply.receivedAt, lastError: 'INTERNAL-SECRET' };
    const calls = []; let conflict = false, changes = 0;
    document.addEventListener('sellermessageschange', () => changes++);
    globalThis.fetch = async (path, options) => {
      calls.push({ path, options });
      if (options.method === 'POST') return conflict ? response({ error: { code: 'NOT_RESOLVABLE', message: 'INTERNAL-SECRET' } }, 409) : response({ ...attention, status: 'ACCEPTED' });
      return response({ items: path.includes('outbox') ? [attention] : [], nextOffset: null });
    };
    const page = mountMessages(root, { csrfToken: () => 'fictional-csrf', onUnauthorized() {} }); await flush();
    for (const [key, resolution, accepted] of [['msgResend', 'RESEND', false], ['msgSentAction', 'SENT', true], ['msgResend', 'RESEND', true]]) {
      conflict = resolution === 'RESEND' && accepted;
      const control = findKey(root, key), before = calls.filter(call => call.options.method === 'POST').length;
      const done = control.events.click({ currentTarget: control });
      assert.equal(calls.filter(call => call.options.method === 'POST').length, before);
      const dialog = root.children.find(node => node.tagName === 'dialog'); assert.equal(dialog.open, true);
      assert.ok(dialog.descendants().some(node => node.textContent === messages.en[resolution === 'RESEND' ? 'msgResendConfirm' : 'msgSentConfirm']));
      page.refreshLocale(); assert.equal(findKey(root, key).disabled, true);
      const choice = dialog.descendants().find(node => node.className === (accepted ? 'primary-button' : 'modal-secondary-button'));
      choice.events.click(); await done; await flush();
      assert.equal(calls.filter(call => call.options.method === 'POST').length, before + Number(accepted));
      if (accepted) {
        const mutation = calls.filter(call => call.options.method === 'POST').at(-1);
        assert.deepEqual(JSON.parse(mutation.options.body), { resolution });
        assert.equal(mutation.options.headers['X-CSRF-Token'], 'fictional-csrf');
      }
      if (conflict) assert.equal(findKey(root, 'msgChanged').textContent, messages.en.msgChanged);
    }
    assert.equal(changes, 2);
    assert.ok(!root.descendants().some(node => node.textContent.includes('INTERNAL-SECRET')));
    page.dispose();
  });
});
