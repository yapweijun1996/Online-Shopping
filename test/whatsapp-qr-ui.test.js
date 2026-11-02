import test from 'node:test';
import assert from 'node:assert/strict';
import { mountWhatsAppQr } from '../public/seller/whatsapp-qr.js';
import { mountWhatsAppChats } from '../public/seller/whatsapp-chats.js';
import { messages, languages } from '../public/shared/i18n.js';
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.classes = new Set(); this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x) }; }
  get isConnected() { return this.connected || Boolean(this.parent?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(k,v) { this.attributes[k] = v; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k,v) { this.events[k] = v; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(n => selector === 'button' ? n.tagName === 'button' : selector === '[data-i18n]' ? Boolean(n.dataset.i18n) : Boolean(n.dataset.i18nAria)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  contains(el) { return this.descendants().includes(el); }
  focus() { document.activeElement = this; }
  getContext() { return { fillRect() {}, fillStyle: '' }; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const key = (root, name) => root.descendants().find(n => n.dataset.i18n === `qr_${name}`);
const response = (data, status = 200, retry = '7') => ({ ok: status < 400, status, headers: { get: () => retry }, json: async () => data });
const initial = { available: true, desired: 'OFF', state: 'IDLE', acknowledged: false };
async function fixture(fn) {
  const previous = Object.fromEntries(['document','window','fetch','setInterval','clearInterval'].map(k => [k, globalThis[k]]));
  const timers = new Map(), listeners = new Map(); let next = 0;
  const root = new Element('main'); root.connected = true;
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), addEventListener(k,v) { listeners.set(k,v); }, removeEventListener(k) { listeners.delete(k); }, dispatchEvent() {} };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.setInterval = fn => { timers.set(++next, fn); return next; }; globalThis.clearInterval = id => timers.delete(id);
  try { await fn(root, timers, listeners); } finally { Object.assign(globalThis, previous); }
}
const options = { csrfToken: () => 'fictional-token', onUnauthorized() { assert.fail('unauthorized'); } };
test('QR copy exists in all seller languages', () => {
  for (const { code } of languages) for (const name of Object.keys(messages.en).filter(k => k.startsWith('qr_'))) assert.equal(typeof messages[code][name], 'string', `${code}/${name}`);
});
for (const phase of ['PAIRING', 'CONNECTING', 'RECONNECTING']) test(`Owner cancels ${phase} and restarts timed-out pairing`, async () => fixture(async root => {
  let state = { ...initial, acknowledged: true, desired: 'PAIR', state: phase };
  const actions = [];
  globalThis.fetch = async (path, init) => {
    if (init.method === 'POST') { actions.push(path.split('/').at(-1)); state = { ...state, desired: 'OFF', state: 'IDLE' }; return response({ ok: true }); }
    return response({ ...state });
  };
  const card = mountWhatsAppQr(root, options); await flush();
  assert.equal(key(root, 'cancel').textContent, 'Cancel');
  await key(root, 'cancel').events.click(); await flush();
  assert.deepEqual(actions, ['disconnect']);
  card.dispose();
  state.lastError = 'PAIRING_TIMEOUT';
  const expired = mountWhatsAppQr(root, options); await flush();
  assert.equal(key(root, 'pairingTimeout').textContent, 'The code expired because it was not scanned in 2 minutes.');
  assert.equal(key(root, 'expired').textContent, 'Get a new code');
  await key(root, 'expired').events.click(); await flush();
  assert.deepEqual(actions, ['disconnect', 'pair']);
  expired.dispose();
}));
test('QR card explains missing provisioning; staff can see risk and status but cannot acknowledge or pair', async () => fixture(async root => {
  globalThis.fetch = async () => response({}, 404);
  const hidden = mountWhatsAppQr(root, options); await flush(); assert.equal(root.children[0].hidden, false); assert.ok(key(root, 'notProvisioned')); hidden.dispose();
  globalThis.fetch = async () => response(initial);
  const staff = mountWhatsAppQr(root, { ...options, role: 'STAFF' }); await flush();
  assert.ok(key(root, 'risk')); assert.ok(key(root, 'idle')); assert.equal(key(root, 'ack'), undefined); assert.equal(key(root, 'pair'), undefined); staff.dispose();
}));
test('Owner acknowledges, pairs, renders QR locally, expires, connects and disconnects with CSRF', async () => fixture(async (root, timers, listeners) => {
  let state = { ...initial }, qrText, mutations = [];
  globalThis.fetch = async (path, init) => {
    if (init.method === 'POST') {
      assert.equal(init.headers['X-CSRF-Token'], 'fictional-token'); mutations.push(path.split('/').at(-1));
      if (path.endsWith('acknowledge')) { assert.deepEqual(JSON.parse(init.body), { noticeVersion: 1 }); state.acknowledged = true; }
      if (path.endsWith('/pair')) state = { ...state, state: 'PAIRING', desired: 'PAIR', qr: 'fictional-qr-text', qrExpiresAt: new Date(Date.now() + 60000).toISOString() };
      if (path.endsWith('/disconnect')) state.desired = 'OFF';
      return response({ ok: true });
    }
    assert.equal(init.cache, 'no-store'); return response({ ...state });
  };
  const card = mountWhatsAppQr(root, { ...options, confirm: async () => true, encoder: () => ({ addData(value) { qrText = value; }, make() {}, getModuleCount: () => 21, isDark: () => false }) });
  await flush(); await key(root, 'ack').events.click(); await flush(); assert.ok(key(root, 'pair'));
  await key(root, 'pair').events.click(); await flush(); assert.equal(qrText, 'fictional-qr-text');
  const canvas = root.descendants().find(n => n.tagName === 'canvas'); assert.equal(canvas.attributes['aria-label'], 'WhatsApp link QR code'); assert.ok(root.descendants().some(n => /Expires in 60 s/.test(n.textContent)));
  state.qrExpiresAt = new Date(Date.now() - 1000).toISOString(); listeners.get('visibilitychange')(); await flush(); assert.ok(key(root, 'expired')); assert.equal(canvas.width, 0);
  state = { ...state, state: 'CONNECTED', desired: 'RUN', phoneMasked: '+•••0100', qr: null };
  listeners.get('visibilitychange')(); await flush(); assert.ok(key(root, 'connected')); assert.ok(root.descendants().some(n => n.textContent === '+•••0100'));
  await key(root, 'disconnect').events.click(); await flush(); assert.ok(key(root, 'idle')); assert.deepEqual(mutations, ['acknowledge','pair','disconnect']);
  document.hidden = true; const calls = mutations.length; for (const tick of timers.values()) tick(); assert.equal(mutations.length, calls);
  card.dispose(); assert.equal(timers.size, 0);
}));
const hostile = '<img onerror=alert(1)>';
const thread = { id: 'thread-1', displayName: hostile, peerMasked: '•••0100', lastMessageText: hostile, unreadCount: 2, canReply: true, lastMessageAt: new Date().toISOString(), replyWindowEndsAt: new Date(Date.now() + 60000).toISOString() };
const incoming = { id: 'msg-1', text: hostile, direction: 'IN', createdAt: new Date().toISOString() };
async function chatsFixture(run, aiSettings = { available: false }) {
  return fixture(async (root, timers, listeners) => {
    const cloud = new Element('div'); root.append(cloud);
    let state = { ...initial, state: 'CONNECTED', desired: 'RUN' }, rows = [{ ...thread }], replyMode = 'network'; const attempts = [];
    globalThis.fetch = async (path, init) => {
      if (path.endsWith('/ai-settings')) return response(aiSettings);
      if (path.endsWith('/suggestions')) { attempts.push(init); return replyMode === '429' ? response({ error: { code: 'RATE_LIMITED' } }, 429) : response({ reply: 'A draft for review', handoff: false, orderDraft: null }); }
      if (path.includes('whatsapp-qr')) return response(state);
      if (path.includes('/replies')) { attempts.push(init); if (replyMode === 'network') throw new TypeError('offline'); if (replyMode === '429') return response({ error: { code: 'RATE_LIMITED' } }, 429); return response({ ...incoming, id: 'out-1', text: JSON.parse(init.body).text, direction: 'OUT', status: 'QUEUED' }, 201); }
      if (path.includes('/messages')) return response([incoming, { ...incoming, id: 'removed', text: null, direction: 'OUT', status: 'RECONCILE' }]);
      if (path.includes('/orders')) return response({ suggested: [{ id: 'order-1', orderNo: 'ORDER-001' }] });
      if (path.includes('/read')) return response({ unreadCount: 0 });
      return response(rows);
    };
    const page = mountWhatsAppChats(root, cloud, options); await flush();
    await key(root, 'chats').events.click(); await flush();
    await root.descendants().find(n => n.className === 'qr-thread').events.click(); await flush();
    try { await run({ root, cloud, page, attempts, timers, listeners, setMode: value => { replyMode = value; }, setState: value => { state = value; }, setRows: value => { rows = value; } }); } finally { page.dispose(); }
  });
}
test('Chats safely render hostile names, previews, bubbles, removed text and suggested order navigation', async () => chatsFixture(async ({ root, cloud }) => {
  assert.equal(cloud.hidden, true); assert.ok(root.descendants().some(n => n.tagName === 'strong' && n.textContent === hostile)); assert.ok(root.descendants().some(n => n.tagName === 'p' && n.textContent === hostile));
  assert.equal(root.descendants().some(n => n.tagName === 'img'), false); assert.ok(root.descendants().some(n => n.textContent === 'Message removed after 30 days')); assert.ok(key(root, 'RECONCILE'));
  assert.equal(root.descendants().find(n => n.tagName === 'a').href, '#orders/order-1');
  key(root, 'back').events.click(); assert.equal(root.descendants().find(n => n.className === 'qr-conversation').hidden, true);
}));
test('Composer reuses an unknown-outcome key, generates a new intent after success, and reports 429 seconds', async () => chatsFixture(async ({ root, attempts, setMode }) => {
  const input = root.descendants().find(n => n.tagName === 'textarea'), form = root.descendants().find(n => n.tagName === 'form');
  input.value = 'Fictional reply'; input.events.input(); form.events.submit({ preventDefault() {} }); await flush();
  assert.equal(attempts.length, 1); const first = attempts[0].headers['Idempotency-Key'];
  setMode('success'); form.events.submit({ preventDefault() {} }); await flush(); assert.equal(attempts[1].headers['Idempotency-Key'], first); assert.equal(input.value, '');
  input.value = 'Fictional reply'; input.events.input(); setMode('429'); input.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} }); await flush();
  assert.notEqual(attempts[2].headers['Idempotency-Key'], first); assert.ok(root.descendants().some(n => n.textContent === 'Too many replies, try again in 7 s')); assert.equal(key(root, 'send').disabled, true);
}));
test('Composer retains the reply key and thread after a lost response and background policy outage', async () => chatsFixture(async ({ root, attempts, listeners, setMode }) => {
  const input = root.descendants().find(n => n.tagName === 'textarea'), form = root.descendants().find(n => n.tagName === 'form');
  const workingFetch = globalThis.fetch, paths = [];
  globalThis.fetch = (path, init) => { if (path.includes('/replies')) paths.push(path); return workingFetch(path, init); };
  const recoveredFetch = globalThis.fetch;
  input.value = 'Fictional reply'; input.events.input(); form.events.submit({ preventDefault() {} }); await flush();
  assert.equal(attempts.length, 1);
  const originalKey = attempts[0].headers['Idempotency-Key'];
  globalThis.fetch = async () => response({ error: { code: 'UNAVAILABLE' } }, 503);
  listeners.get('visibilitychange')(); await flush();
  assert.equal(input.value, ''); assert.equal(input.disabled, true);
  form.events.submit({ preventDefault() {} }); await flush(); assert.equal(attempts.length, 1);
  globalThis.fetch = recoveredFetch; setMode('success');
  listeners.get('visibilitychange')(); await flush();
  assert.equal(input.disabled, false); assert.equal(attempts.length, 1);
  input.value = 'Fictional reply'; input.events.input(); form.events.submit({ preventDefault() {} }); await flush();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].headers['Idempotency-Key'], originalKey);
  assert.equal(paths[1], paths[0]); assert.ok(paths[0].endsWith('/chats/thread-1/replies'));
  assert.deepEqual(JSON.parse(attempts[1].body), { text: 'Fictional reply' });
  assert.equal(input.value, '');
}));
test('Composer closes when disconnected or the chat is erased; hidden pages do not poll', async () => chatsFixture(async ({ root, setState, setRows, listeners, timers }) => {
  setState({ ...initial }); listeners.get('visibilitychange')(); await flush();
  assert.ok(root.descendants().some(n => n.textContent === 'WhatsApp is not linked')); assert.equal(key(root, 'send').disabled, true);
  setState({ ...initial, state: 'CONNECTED', desired: 'RUN' }); setRows([{ ...thread, canReply: false }]); listeners.get('visibilitychange')(); await flush();
  assert.ok(root.descendants().some(n => n.textContent === 'Replies are unavailable for this contact'));
  document.hidden = true; globalThis.fetch = () => { assert.fail('hidden polling'); }; for (const tick of timers.values()) tick();
}));
test('Chats look like WhatsApp Web: avatar, You: preview, search, day separators, phone-sent label and no reply window', async () => fixture(async root => {
  const cloud = new Element('div'); root.append(cloud);
  const day = n => new Date(Date.now() - n * 86400000).toISOString();
  const rows = [
    { ...thread, id: 't1', displayName: 'Ali Shop', lastMessageText: 'See you', lastMessageDirection: 'OUT', unreadCount: 0, lastMessageAt: day(0), lastInboundAt: day(40), replyWindowEndsAt: day(39) },
    { ...thread, id: 't2', displayName: '  Siti', peerMasked: '+••••8780', lastMessageText: 'Hello', lastMessageDirection: 'IN', unreadCount: 3, lastMessageAt: day(2) }
  ];
  const stored = [{ id: 'a', text: 'old in', direction: 'IN', createdAt: day(2) }, { id: 'b', text: 'phone out', direction: 'OUT', status: 'SENT', actor: 'phone:device', createdAt: day(2) }, { id: 'c', text: 'panel out', direction: 'OUT', status: 'SENT', actor: 'owner', createdAt: day(0) }];
  globalThis.fetch = async path => path.includes('whatsapp-qr') ? response({ ...initial, state: 'CONNECTED', desired: 'RUN' }) : path.includes('/messages') ? response(stored) : path.includes('/orders') ? response({ suggested: [] }) : path.includes('/read') ? response({ unreadCount: 0 }) : response(rows);
  const page = mountWhatsAppChats(root, cloud, options); await flush();
  try {
    await key(root, 'chats').events.click(); await flush();
    const text = () => root.descendants().filter(n => n.className === 'qr-thread').map(n => n.descendants().map(d => d.textContent).join('|'));
    assert.deepEqual(root.descendants().filter(n => n.className === 'qr-avatar').map(n => n.textContent), ['A', 'S']);
    assert.ok(text()[0].includes('You: See you')); assert.ok(!text()[1].includes('You:'));
    const search = root.descendants().find(n => n.className === 'qr-search'); assert.ok(search);
    search.value = 'siti'; search.events.input(); assert.equal(root.descendants().filter(n => n.className === 'qr-thread').length, 1);
    search.value = ''; search.events.input();
    await root.descendants().find(n => n.className === 'qr-thread').events.click(); await flush();
    // A chat whose last customer message is 40 days old can still be answered.
    assert.equal(key(root, 'send').disabled, true); const input = root.descendants().find(n => n.tagName === 'textarea'); input.value = 'Hi'; input.events.input();
    assert.equal(key(root, 'send').disabled, false); assert.equal(input.disabled, false);
    assert.equal(root.descendants().filter(n => n.className === 'qr-day').length, 2);
    assert.ok(root.descendants().some(n => n.className === 'qr-from-phone' && n.textContent === 'Sent from your phone'));
    assert.equal(root.descendants().filter(n => n.className === 'status-badge' && n.textContent === 'Sent').length, 1);
  } finally { page.dispose(); }
}));
test('Inbox pagination preserves earlier messages and uses the same-thread cursor; locale refresh keeps the draft', async () => fixture(async root => {
  const cloud = new Element('div'); root.append(cloud);
  const calls = [];
  const latest = Array.from({ length: 100 }, (_, i) => ({ ...incoming, id: `m${String(i).padStart(3,'0')}`, text: `Message ${i}` }));
  globalThis.fetch = async (path, init) => {
    calls.push(path);
    if (path.includes('whatsapp-qr')) return response({ ...initial, state: 'CONNECTED', desired: 'RUN' });
    if (path.includes('/messages')) return response(path.includes('before=') ? [{ ...incoming, id: 'earlier', text: 'Earlier message', createdAt: '2020-01-01T00:00:00Z' }] : latest);
    if (path.includes('/orders')) return response({ suggested: [] });
    if (init.method === 'POST') return response({ unreadCount: 0 });
    return response(path.includes('offset=50') ? [{ ...thread, id: 'page2', displayName: 'Last thread' }] : Array.from({ length: 50 }, (_, i) => ({ ...thread, id: `t${i}` })));
  };
  const page = mountWhatsAppChats(root, cloud, options); await flush();
  key(root, 'chats').events.click(); await flush();
  await key(root, 'more').events.click(); await flush();
  assert.ok(root.descendants().some(n => n.textContent === 'Last thread'));
  assert.equal(key(root, 'more').hidden, true);
  await root.descendants().find(n => n.className === 'qr-thread').events.click(); await flush();
  await key(root, 'earlier').events.click(); await flush();
  assert.ok(calls.some(path => path.includes('/t0/messages?limit=100&before=m000')));
  assert.ok(root.descendants().some(n => n.textContent === 'Earlier message'));
  assert.ok(root.descendants().some(n => n.textContent === 'Message 99'));
  assert.equal(key(root, 'earlier').hidden, true);
  const input = root.descendants().find(n => n.tagName === 'textarea'); input.value = 'Unsent draft';
  page.refreshLocale(); assert.equal(input.isConnected, true); assert.equal(input.value, 'Unsent draft'); assert.equal(page.hasUnsavedChanges(), true);
  page.dispose();
}));
test('Pairing polls at two seconds, connected status at fifteen only on screen, and disposal stops requests', async () => fixture(async (root, timers) => {
  const realNow = Date.now, originalObserver = globalThis.IntersectionObserver; let time = realNow(), calls = 0, observe;
  Date.now = () => time;
  globalThis.IntersectionObserver = class { constructor(fn) { observe = fn; } observe() {} disconnect() {} };
  let status = { ...initial, acknowledged: true, desired: 'PAIR', state: 'CONNECTING' };
  globalThis.fetch = async () => { calls++; return response({ ...status }); };
  const card = mountWhatsAppQr(root, options);
  const tick = async ms => { time += ms; for (const fn of timers.values()) fn(); await flush(); };
  try {
    await flush(); await tick(1000); assert.equal(calls, 1);
    await tick(1000); assert.equal(calls, 2);
    status = { ...status, desired: 'RUN', state: 'CONNECTED' }; await tick(2000); assert.equal(calls, 3);
    await tick(14000); assert.equal(calls, 3); await tick(1000); assert.equal(calls, 4);
    observe([{ isIntersecting: false }]); await tick(15000); assert.equal(calls, 4);
    observe([{ isIntersecting: true }]); document.hidden = true; await tick(15000); assert.equal(calls, 4);
    document.hidden = false; await tick(1000); assert.equal(calls, 5);
    card.dispose(); await tick(15000); assert.equal(calls, 5);
  } finally { card.dispose(); Date.now = realNow; globalThis.IntersectionObserver = originalObserver; }
}));
test('Link again keeps polling through the old worker error until the new generation starts', async () => fixture(async (root, timers) => {
  const realNow = Date.now; let time = realNow(), calls = 0;
  Date.now = () => time;
  let status = { ...initial, generation: 1, acknowledged: true, state: 'ERROR', lastError: 'RECONNECT_LIMIT' };
  globalThis.fetch = async (path, init) => {
    if (init.method === 'POST') { status = { ...status, generation: 2, desired: 'PAIR' }; return response({ ok: true }); }
    calls++; return response({ ...status });
  };
  const card = mountWhatsAppQr(root, options);
  try {
    await flush(); assert.ok(key(root, 'reconnectError'));
    await key(root, 'again').events.click(); await flush(); assert.ok(key(root, 'connecting'));
    status = { ...status, state: 'CONNECTING' }; time += 2000; for (const tick of timers.values()) tick(); await flush();
    assert.equal(calls, 3); assert.ok(key(root, 'connecting'));
    status = { ...status, state: 'CONNECTED', desired: 'RUN' }; time += 2000; for (const tick of timers.values()) tick(); await flush();
    assert.ok(key(root, 'connected'));
  } finally { card.dispose(); Date.now = realNow; }
}));
for (const [status, code, copy] of [[403, 'QR_REVOKED', 'revoked'], [409, 'QR_CAPACITY', 'capacity'], [404, 'QR_WORKER_NOT_PROVISIONED', 'notProvisioned'], [503, 'UNAVAILABLE', 'unavailable']]) {
  test(`QR clears visible code after ${code}`, async () => fixture(async (root, timers, listeners) => {
    let denied = false;
    globalThis.fetch = async () => denied ? response({ error: { code } }, status) : response({ ...initial, acknowledged: true, desired: 'PAIR', state: 'PAIRING', qr: 'synthetic', qrExpiresAt: new Date(Date.now() + 60000).toISOString() });
    const card = mountWhatsAppQr(root, { ...options, encoder: () => ({ addData() {}, make() {}, getModuleCount: () => 1, isDark: () => false }) });
    await flush(); const canvas = root.descendants().find(n => n.tagName === 'canvas'); assert.ok(canvas);
    denied = true; listeners.get('visibilitychange')(); await flush();
    assert.equal(canvas.width, 0); assert.ok(key(root, copy)); assert.equal(key(root, 'pair'), undefined); card.dispose();
  }));
}
for (const [status, code] of [[403, 'QR_REVOKED'], [409, 'QR_CAPACITY'], [404, 'QR_WORKER_NOT_PROVISIONED'], [503, 'UNAVAILABLE']]) {
  test(`Composer clears draft and refuses send after ${code}`, async () => chatsFixture(async ({ root, listeners, attempts }) => {
    const input = root.descendants().find(n => n.tagName === 'textarea');
    input.value = 'Private draft'; input.events.input(); assert.equal(key(root, 'send').disabled, false);
    globalThis.fetch = async () => response({ error: { code } }, status);
    listeners.get('visibilitychange')(); await flush();
    assert.equal(input.value, ''); assert.equal(input.disabled, true); assert.equal(key(root, 'send').disabled, true);
    root.descendants().find(n => n.tagName === 'form').events.submit({ preventDefault() {} }); await flush();
    assert.equal(attempts.length, 0);
  }));
}
for (const [status, code, copy] of [[403, 'QR_REVOKED', 'revoked'], [409, 'QR_CAPACITY', 'capacity'], [404, 'QR_WORKER_NOT_PROVISIONED', 'notProvisioned'], [503, 'UNAVAILABLE', 'unavailable']]) {
  test(`Chats explain initial ${code} without exposing a composer`, async () => fixture(async root => {
    const cloud = new Element('section'); root.append(cloud);
    globalThis.fetch = async () => response({ error: { code } }, status);
    const page = mountWhatsAppChats(root, cloud, options); await flush();
    assert.ok(root.descendants().some(n => n.textContent === messages.en[`qr_${copy}`]));
    assert.equal(root.descendants().find(n => n.className === 'qr-conversation').hidden, true);
    assert.equal(root.descendants().find(n => n.className === 'qr-inbox').hidden, false);
    page.dispose();
  }));
}
test('Inbox AI uses CSRF, shows Retry-After seconds and hides for suppressed or disconnected threads', async () => chatsFixture(async ({ root, attempts, setMode, setRows, setState, listeners }) => {
  const suggest = root.descendants().find(n => n.dataset.i18n === 'ai_suggest');
  const composer = root.descendants().find(n => n.tagName === 'textarea');
  assert.equal(suggest.hidden, false);
  setMode('429'); await suggest.events.click();
  assert.ok(root.descendants().some(n => n.textContent === 'Too many requests. Try again in 7 seconds.'));
  assert.equal(suggest.disabled, false);
  setMode('ok'); await suggest.events.click();
  assert.equal(composer.value, 'A draft for review');
  assert.equal(attempts[1].headers['X-CSRF-Token'], 'fictional-token');
  assert.equal(attempts[1].headers['Idempotency-Key'], undefined);
  assert.deepEqual(JSON.parse(attempts[1].body), {});
  setRows([{ ...thread, suppressed: true }]); listeners.get('visibilitychange')(); await flush();
  assert.equal(suggest.hidden, true);
  setRows([{ ...thread, suppressed: false }]); setState({ ...initial }); listeners.get('visibilitychange')(); await flush();
  assert.equal(suggest.hidden, true);
}, { available: true, enabled: true }));
