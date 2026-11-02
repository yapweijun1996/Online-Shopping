import test from 'node:test';
import assert from 'node:assert/strict';
import { messages } from '../public/shared/i18n.js';
const { mountWhatsAppConnection } = await import('../public/seller/whatsapp-connection.js');

// Minimal DOM double: exercise requests and lifecycle without a browser or network.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.value = ''; this.textContent = ''; }
  get isConnected() { return this.connected || Boolean(this.parent?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, handler) { this.events[name] = handler; }
  querySelectorAll(selector) { return this.descendants().filter(node => selector === '[data-i18n]' ? 'i18n' in node.dataset : 'i18nAria' in node.dataset); }
  descendants() { return this.children.flatMap(node => [node, ...node.descendants()]); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(fn) {
  const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const root = new Element('main'); root.connected = true;
  globalThis.document = { createElement: tag => new Element(tag) };
  try { await fn(root); }
  finally { globalThis.document = originalDocument; globalThis.fetch = originalFetch; }
}
const available = { available: true, webhookUrl: 'https://fictional.example/webhook', connections: [] };
const response = data => ({ ok: true, status: 200, json: async () => data });

test('failed, unavailable, unauthorized and stale loads remain hidden', async () => {
  await fixture(async root => {
    for (const result of [response({ available: false }), { ok: false, status: 503 }, { ok: false, status: 401 }, new Error('offline')]) {
      let unauthorized = 0;
      globalThis.fetch = async (path, options) => {
        assert.equal(path, '/api/v1/seller/integrations/whatsapp'); assert.equal(options.cache, 'no-store');
        if (result instanceof Error) throw result; return result;
      };
      mountWhatsAppConnection(root, { csrfToken: () => 'fictional-csrf', onUnauthorized: () => unauthorized++, request() {} });
      await flush();
      assert.equal(root.children.at(-1).hidden, true);
      assert.equal(root.children.at(-1).children.length, 0);
      assert.equal(unauthorized, result.status === 401 ? 1 : 0);
    }
    for (const detach of [false, true]) {
      let resolve, identity = 'first';
      globalThis.fetch = () => new Promise(done => { resolve = done; });
      mountWhatsAppConnection(root, { csrfToken: () => identity, onUnauthorized() { assert.fail('stale unauthorized'); }, request() {} });
      const section = root.children.at(-1);
      if (detach) section.parent = null; else identity = 'second';
      resolve(response(available)); await flush();
      assert.equal(section.hidden, true);
    }
  });
});

test('connect sends exactly four fields, clears passwords and preserves the other environment draft', async () => {
  await fixture(async root => {
    globalThis.fetch = async () => response(available);
    let resolve, sent;
    const card = mountWhatsAppConnection(root, { csrfToken: () => 'fictional-csrf', onUnauthorized() {}, request(method, path, body) {
      sent = { method, path, body }; return new Promise(done => { resolve = done; });
    } });
    await flush();
    const forms = root.descendants().filter(node => node.tagName === 'form');
    const inputs = forms[0].descendants().filter(node => node.tagName === 'input');
    const other = forms[1].descendants().find(node => node.name === 'accessToken'); other.value = 'fictional-draft';
    const values = ['fictional-access', 'fictional-app-secret', '12345', '67890'];
    inputs.forEach((input, index) => { input.value = values[index]; assert.equal(input.autocomplete, 'off'); });
    const submit = forms[0].descendants().find(node => node.type === 'submit');
    forms[0].events.submit({ preventDefault() {} });
    assert.equal(submit.disabled, true);
    assert.deepEqual(sent, { method: 'PUT', path: '/api/v1/seller/integrations/whatsapp/SANDBOX', body: { accessToken: values[0], appSecret: values[1], phoneNumberId: values[2], businessAccountId: values[3] } });
    card.refreshLocale(); assert.equal(other.value, 'fictional-draft');
    resolve({ environment: 'SANDBOX', status: 'CONNECTED', secretHint: '••••cess', publicConfig: { phoneNumberId: '12345', businessAccountId: '67890', verifyToken: 'fictional-verification', displayPhoneNumber: '+1 202 555 0100', verifiedName: 'Fictional Shop' }, lastCheckedAt: '2026-10-08T00:00:00Z' });
    await flush();
    assert.equal(inputs[0].value, ''); assert.equal(inputs[1].value, '');
    assert.equal(other.value, 'fictional-draft'); assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, messages.en.waUpdate);
    assert.ok(root.descendants().some(node => node.textContent === 'Fictional Shop'));
  });
});

test('provider and field errors use only localized messages and re-enable submit', async () => {
  await fixture(async root => {
    globalThis.fetch = async () => response(available);
    let code = 'INVALID_INPUT';
    mountWhatsAppConnection(root, { csrfToken: () => 'fictional-csrf', onUnauthorized() {}, request: async () => { throw Object.assign(new Error('untrusted server text'), { code, field: 'phoneNumberId' }); } });
    await flush();
    const form = root.descendants().find(node => node.tagName === 'form');
    const field = form.descendants().find(node => node.name === 'phoneNumberId');
    for (const [error, key] of [['INVALID_INPUT', 'waInvalid'], ['CONNECTION_REJECTED', 'waRejected'], ['PROVIDER_UNAVAILABLE', 'waProviderUnavailable'], ['RATE_LIMITED', 'waRateLimited'], ['INTEGRATIONS_UNAVAILABLE', 'waUnavailable'], ['FORBIDDEN', 'waForbidden'], ['UNKNOWN', 'waFailed']]) {
      code = error; form.events.submit({ preventDefault() {} }); await flush();
      const line = form.descendants().find(node => node.attributes.role === 'status');
      assert.equal(line.textContent, messages.en[key]);
      assert.equal(line.attributes['aria-live'], 'polite');
      assert.equal(form.descendants().find(node => node.type === 'submit').disabled, false);
      if (error === 'INVALID_INPUT') { assert.equal(field.attributes['aria-invalid'], 'true'); assert.equal(field.focused, true); }
    }
  });
});

test('copy falls back to selecting the read-only input and supports clipboard success', async () => {
  await fixture(async root => {
    globalThis.fetch = async () => response(available);
    mountWhatsAppConnection(root, { csrfToken: () => 'fictional-csrf', onUnauthorized() {}, request() {} });
    await flush();
    const copy = root.descendants().find(node => node.dataset.i18nAria === 'waCallback');
    const input = copy.parent.descendants().find(node => node.tagName === 'input');
    assert.equal(input.readOnly, true);
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      await copy.events.click();
      assert.equal(input.selected, true); assert.equal(input.focused, true);
      assert.ok(root.descendants().some(node => node.textContent === messages.en.waSelectCopy));
      let copied;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
      await copy.events.click();
      assert.equal(copied, available.webhookUrl);
      assert.ok(root.descendants().some(node => node.textContent === messages.en.waCopied));
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous); else delete navigator.clipboard;
    }
  });
});

test('stale mutation results clear passwords but cannot render into a new session', async () => {
  await fixture(async root => {
    globalThis.fetch = async () => response(available);
    let identity = 'first', resolve;
    mountWhatsAppConnection(root, { csrfToken: () => identity, onUnauthorized() {}, request: () => new Promise(done => { resolve = done; }) });
    await flush();
    const form = root.descendants().find(node => node.tagName === 'form');
    const fields = form.descendants().filter(node => node.tagName === 'input');
    fields[0].value = 'fictional-access'; fields[1].value = 'fictional-app-secret';
    form.events.submit({ preventDefault() {} });
    identity = 'second';
    resolve({ status: 'CONNECTED', publicConfig: { verifiedName: 'Stale Fictional Shop' } }); await flush();
    assert.equal(fields[0].value, ''); assert.equal(fields[1].value, '');
    assert.ok(!root.descendants().some(node => node.textContent === 'Stale Fictional Shop'));
    assert.equal(form.descendants().find(node => node.type === 'submit').textContent, messages.en.waConnect);
  });
});

test('readiness renders safe check badges and matrix without credentials or a write request', async () => {
  await fixture(async root => {
    let reads = 0;
    globalThis.fetch = async path => {
      if (++reads === 1) return response({ ...available, connections: [{ environment: 'SANDBOX', status: 'CONNECTED', publicConfig: {} }] });
      assert.equal(path, '/api/v1/seller/integrations/whatsapp/SANDBOX/readiness');
      return response({ checkedAt: '2026-10-21T00:00:00Z', checks: [
        { id: 'phoneOwnership', status: 'PASS' }, { id: 'appSubscription', status: 'FAIL' }, { id: 'appSecret', status: 'UNKNOWN' },
      ], templates: [{ name: '<script>fixture</script>', language: 'en', status: 'MISSING' }] });
    };
    mountWhatsAppConnection(root, { csrfToken: () => 'fixture', onUnauthorized() {}, request() { assert.fail('readiness must not mutate'); } });
    await flush();
    const button = root.descendants().find(node => node.dataset.i18n === 'waReadiness');
    assert.equal(button.hidden, false);
    await button.events.click();
    for (const text of ['PASS', 'FAIL', 'UNKNOWN', '<script>fixture</script>', 'MISSING'])
      assert.ok(root.descendants().some(node => node.textContent === text));
    assert.ok(root.descendants().some(node => node.tagName === 'details'));
    assert.equal(button.disabled, false);
  });
});
