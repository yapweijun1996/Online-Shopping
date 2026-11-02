import test from 'node:test';
import assert from 'node:assert/strict';
import { openTrackingImport } from '../public/seller/tracking-import.js';
import { messages, languages } from '../public/shared/i18n.js';
import { mutationsBusy } from '../public/shared/update-guard.js';
import { readFile } from 'node:fs/promises';
import { parseTrackingFile, validMapping, mappedTrackingCsv } from '../public/seller/tracking-mapping.js';
import { parseCsv } from '../src/csv.js';
import { TRACKING_HEADER_ALIASES, trackingRows } from '../src/tracking-import.js';
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const answer = (count = 100) => ({ summary: { ship: count, unchanged: 0, errors: 0 }, planHash: 'hash', expectedRevisions: [{ orderNo: 'OS-1', revision: 2 }], reportCsv: 'safe report', rows: Array.from({ length: count }, (_, index) => ({ line: index + 2, orderNo: `OS-${index}`, carrier: 'Courier', trackingNo: `00${index}`, action: 'ship', changes: [], errors: [], warnings: [] })) });
async function fixture(t) {
  const old = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = (tag) => new Element(tag);
  globalThis.document = document; globalThis.window = new EventTarget(); Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  t.after(() => { for (const dialog of [...document.body.children]) if (dialog.open) dialog.dispose(); globalThis.document = old.document; globalThis.window = old.window; globalThis.fetch = old.fetch; Object.defineProperty(globalThis, 'navigator', old.navigator); });
  const dialog = openTrackingImport({ csrfToken: () => 'csrf', onUnauthorized() {}, onImported() {} });
  const find = (key) => dialog.descendants().find((node) => node.tagName === 'button' && node.textContent === messages.en[key]);
  const file = dialog.descendants().find((node) => node.tagName === 'input');
  const choose = async (text = 'Order number,Carrier,Tracking number\nOS-1,Courier,ABC') => { file.files = [new Blob([text])]; file.dispatchEvent(new Event('change')); await flush(); };
  return { dialog, file, find, choose };
}

test('100/500 row preview is paged, commit is bound to preview, completed import cannot repeat', async (t) => {
  const ui = await fixture(t), sent = [];
  globalThis.fetch = async (_path, options) => { const body = JSON.parse(options.body); sent.push(body); return { ok: true, status: 200, json: async () => body.commit ? { ...answer(500), applied: { shipped: 500, unchanged: 0 } } : answer(500) }; };
  await ui.choose();
  assert.equal(ui.dialog.descendants().filter((node) => node.tagName === 'tr').length, 51);
  assert.equal(ui.find('importConfirm').hidden, false);
  ui.find('trackingNext').dispatchEvent(new Event('click'));
  assert.equal(ui.dialog.descendants().find((node) => node.tagName === 'td').textContent, '52');
  ui.find('importConfirm').dispatchEvent(new Event('click')); await flush();
  assert.deepEqual(sent[1], { csv: 'Order number,Carrier,Tracking number\nOS-1,Courier,ABC', commit: true, planHash: 'hash', expectedRevisions: [{ orderNo: 'OS-1', revision: 2 }] });
  assert.equal(ui.find('importConfirm').hidden, true); assert.equal(mutationsBusy(), false);
});

test('preview displays source mappings and ignored headers as literal text', async (t) => {
  const ui = await fixture(t);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...answer(1), sourceHeaders: { orderNo: 'Order #', carrier: 'Courier', trackingNo: 'AWB' }, ignoredColumns: ['<img src=x>', 'Price'] }) });
  await ui.choose();
  const text = ui.dialog.descendants().map((node) => node.textContent);
  assert.ok(text.includes('Source column: Order number ← Order #'));
  assert.ok(text.includes('Source column: Courier ← Courier') || text.includes(`Source column: ${messages.en.carrier} ← Courier`));
  assert.ok(text.includes('Ignored columns: <img src=x>, Price'));
});

for (const failure of ['network loss', 'HTTP 500']) test(`${failure}: unknown commit retains file/update guard until successful repreview`, async (t) => {
  const ui = await fixture(t); let mode = 'preview';
  globalThis.fetch = async (_path, options) => {
    if (JSON.parse(options.body).commit) {
      mode = 'unknown';
      if (failure === 'network loss') throw new TypeError('lost response');
      return { ok: false, status: 500 };
    }
    return { ok: true, status: 200, json: async () => mode === 'unknown' ? { ...answer(), summary: { ship: 0, unchanged: 100, errors: 0 } } : answer() };
  };
  await ui.choose(); ui.find('importConfirm').dispatchEvent(new Event('click')); await flush();
  assert.equal(mutationsBusy(), true); assert.equal(ui.file.disabled, true); assert.equal(ui.find('close').disabled, true);
  assert.equal(ui.find('importConfirm').hidden, true);
  ui.find('trackingPreview').dispatchEvent(new Event('click')); await flush();
  assert.equal(mutationsBusy(), false); assert.equal(ui.file.disabled, false); assert.equal(ui.find('importConfirm').hidden, true);
});

test('file errors, conflicts, offline, changed file and expiry cannot commit a stale plan', async (t) => {
  const ui = await fixture(t); let count = 0, status = 200;
  globalThis.fetch = async () => { count++; return { ok: status === 200, status, json: async () => status === 409 ? { ...answer(), error: { message: 'Conflict' } } : answer() }; };
  await ui.choose(); navigator.onLine = false; window.dispatchEvent(new Event('offline'));
  assert.equal(ui.find('importConfirm').disabled, true);
  navigator.onLine = true; window.dispatchEvent(new Event('online'));
  status = 409; ui.find('importConfirm').dispatchEvent(new Event('click')); await flush(); assert.equal(ui.find('importConfirm').hidden, true);
  ui.file.files = [{ size: 1_500_001 }]; ui.file.dispatchEvent(new Event('change')); await flush(); assert.equal(ui.find('importConfirm').hidden, true); assert.equal(count, 2);
  status = 401; await ui.choose(); assert.equal(ui.dialog.open, false); assert.equal(mutationsBusy(), false);
});

test('invalid UTF-8 tracking bytes clear the plan and cannot preview or commit', async (t) => {
  const ui = await fixture(t);
  const sent = [];
  globalThis.fetch = async (_path, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => answer() }; };
  await ui.choose();
  const bytes = new Uint8Array([...new TextEncoder().encode('Order number,Carrier,Tracking number\nOS-1,Courier,ABC'), 0xff]);
  await ui.choose(bytes);
  assert.equal(ui.dialog.descendants().find((node) => node.attributes.role === 'status').textContent, messages.en.importBadFile);
  assert.equal(ui.find('trackingPreview').disabled, true);
  assert.equal(ui.find('importConfirm').hidden, true);
  ui.find('trackingPreview').dispatchEvent(new Event('click'));
  ui.find('importConfirm').dispatchEvent(new Event('click'));
  await flush();
  assert.equal(sent.length, 1);
});

test('tracking copy is present in all seven locales', () => {
  for (const { code } of languages) for (const key of ['trackingMappingIntro', 'trackingMappingNone', 'trackingDefaultCarrier', 'trackingMappingInvalid', 'trackingImport', 'trackingTemplate', 'trackingIntro', 'trackingShipCount', 'trackingReport', 'trackingPreview', 'trackingUnknown', 'trackingDone']) assert.equal(typeof messages[code][key], 'string');
});

test('every server preview action and row error has human copy in every locale', async () => {
  const source = await readFile(new URL('../src/tracking-import.js', import.meta.url), 'utf8');
  const actions = new Set([...source.matchAll(/action:\s*'([^']+)'|row\.action\s*=\s*'([^']+)'/g)].map(match => match[1] || match[2]));
  const errors = new Set([...source.matchAll(/fail\(row,\s*'[^']+',\s*'([^']+)'/g)].map(match => match[1]));
  assert.deepEqual([...actions].sort(), ['error', 'ship', 'unchanged']);
  for (const { code } of languages) for (const key of [
    ...[...actions].map(action => `importAction_${action}`),
    ...[...errors].map(error => `trackingError_${error}`), 'trackingDetails',
  ]) {
    assert.equal(typeof messages[code][key], 'string', `${code}: ${key}`);
    assert.ok(messages[code][key].trim() && messages[code][key] !== key, `${code}: ${key}`);
  }
});

test('unchanged preview shows human action and a scoped details column', async (t) => {
  const ui = await fixture(t);
  const plan = answer(1); plan.rows[0].action = 'unchanged';
  plan.summary = { ship: 0, unchanged: 1, errors: 0 };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plan });
  await ui.choose();
  assert.ok(ui.dialog.descendants().some(node => node.textContent === 'Unchanged · Courier · 000'));
  const headings = ui.dialog.descendants().filter(node => node.tagName === 'th');
  assert.equal(headings[2].textContent, 'Details');
  assert.equal(headings[2].scope, 'col');
});

test('recognised headers skip mapping; realistic courier export maps real columns before preview', async (t) => {
  assert.equal(parseTrackingFile('Order No,Courier,AWB\nOS-1,DHL,001').needsMapping, false);
  const ui = await fixture(t), sent = [];
  globalThis.fetch = async (_path, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => answer(1) }; };
  await ui.choose('Order Reference,Courier Name,AWB No,Recipient,Phone,Address,Postcode,Weight (kg),Service,Charge (RM),Date Shipped\r\nOS-1,DHL,001,Person,000,Street,00000,1,Express,5,2026-01-01');
  assert.equal(sent.length, 0);
  const selects = ui.dialog.descendants().filter((element) => element.tagName === 'select');
  assert.deepEqual(selects.map((element) => element.value), ['0', '1', '2', '10']);
  assert.equal(selects[0].focused, true);
  assert.equal(selects[0].children[1].textContent, 'Order Reference');
  selects[2].value = '0'; selects[2].dispatchEvent(new Event('change'));
  assert.equal(ui.find('trackingPreview').disabled, true);
  selects[2].value = '2'; selects[2].dispatchEvent(new Event('change'));
  assert.equal(ui.find('trackingPreview').disabled, false);
  ui.find('trackingPreview').dispatchEvent(new Event('click')); await flush();
  assert.equal(sent[0].csv, '\uFEFFOrder number,Carrier,Tracking number,Shipped date\r\nOS-1,DHL,001,2026-01-01\r\n');
});

test('mapping preserves CSV text, BOM, CRLF and server injection validation', () => {
  const file = parseTrackingFile('\uFEFFcustom,provider,label,extra\r\nOS-1,\"A,\"\"B\"\"\nC\",001,ignored\r\n');
  const csv = mappedTrackingCsv(file, [0, 1, 2, -1]);
  assert.deepEqual(parseCsv(csv, { strict: true }), [['Order number', 'Carrier', 'Tracking number', 'Shipped date'], ['OS-1', 'A,\"B\"\nC', '001', '']]);
  for (const value of ['=cmd', '+cmd', '-cmd', '@cmd']) {
    const input = parseTrackingFile(`custom,provider,label\n${value},DHL,${value}`);
    const output = mappedTrackingCsv(input, [0, 1, 2, -1]);
    assert.equal(parseCsv(output)[1][0], value);
    assert.equal(trackingRows(output)[0].errors.length, 2);
  }
  const rows = 'custom,provider,label\n' + Array.from({ length: 500 }, (_, index) => `OS-${index},DHL,T${index}`).join('\r\n');
  assert.equal(parseTrackingFile(mappedTrackingCsv(parseTrackingFile(rows), [0, 1, 2, -1])).rows.length, 500);
  assert.throws(() => parseTrackingFile(rows + '\r\nOS-501,DHL,T501'));
  assert.throws(() => mappedTrackingCsv(file, [0, 1, 0, -1]));
});

test('default carrier requires bounded text and remembered mapping uses exact headers', async (t) => {
  const ui = await fixture(t), sent = [];
  globalThis.fetch = async (_path, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => answer(1) }; };
  await ui.choose('Order ID,Tracking Code\nOS-1,001');
  assert.equal(ui.find('trackingPreview').disabled, true);
  const carrier = ui.dialog.descendants().find((element) => element.type === 'text');
  carrier.value = 'DHL'; carrier.dispatchEvent(new Event('input'));
  assert.equal(ui.find('trackingPreview').disabled, false);
  ui.find('trackingPreview').dispatchEvent(new Event('click')); await flush();
  assert.equal(trackingRows(sent[0].csv)[0].carrier, 'DHL');
  const file = parseTrackingFile('x,y,z\nOS-1,DHL,001');
  assert.equal(validMapping(file, [0, -1, 2, -1], 'x'.repeat(41)), false);
  mappedTrackingCsv(file, [0, 1, 2, -1]);
  assert.deepEqual(parseTrackingFile('x,y,z\nOS-2,DHL,002').selection, [0, 1, 2, -1]);
  assert.deepEqual(parseTrackingFile('z,y,x\n001,DHL,OS-1').selection, [-1, -1, -1, -1]);
  assert.equal(parseTrackingFile('Order No,Order Ref,Courier,AWB\nOS-1,OS-1,DHL,001').needsMapping, true);
  assert.equal(parseTrackingFile('Order No,Courier,AWB,Delivered On\nOS-1,DHL,001,2026-01-01').selection[3], -1);
});

test('client recognises every server alias with identical normalisation', () => {
  const fields = ['orderNo', 'carrier', 'trackingNo', 'shippedDate'];
  for (const [field, aliases] of Object.entries(TRACKING_HEADER_ALIASES)) for (const alias of aliases) {
    const headers = fields.map((key) => key === field ? ` \uFEFF${alias.toUpperCase().replaceAll(' ', '_')} ` : TRACKING_HEADER_ALIASES[key][0]);
    const parsed = parseTrackingFile(headers.join(',') + '\nOS-1,Courier,001,2026-01-01');
    assert.equal(parsed.needsMapping, false, alias);
    assert.deepEqual(parsed.selection, [0, 1, 2, 3], alias);
  }
});
