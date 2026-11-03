import { icon } from './shared/icons.js';
import { initPwaShell, markReady, mountAppSection } from './pwa-shell.js';
import { draftSignature } from './shared/update-guard.js';
import { tableRows, safeLink } from './table.js';
import { mountAppearance, paletteChoices } from './shared/appearance.js';
import { containDialogFocus, confirmModal } from './shared/modal.js';
import { sellerEmailTemplate } from './email-template.js';
const paletteListeners = new Set();
window.sellerPalette = {
  choose(id) { if (!paletteChoices.some(([key]) => key === id)) return false; document.documentElement.dataset.sellerPalette = id; for (const listener of paletteListeners) listener(id); return false; },
  subscribe(listener) { paletteListeners.add(listener); listener(document.documentElement.dataset.sellerPalette || 'evergreen-teal'); return () => paletteListeners.delete(listener); }
};
function drawer(open) {
  document.querySelector('#sidebar').hidden = session?.stage !== 'FULL' || (!open && !matchMedia('(min-width:1024px)').matches); document.querySelector('#drawer-backdrop').hidden = !open;
  document.querySelector('#sidebar').classList.toggle('drawer-open', open);
  document.querySelector('#open-menu').setAttribute('aria-expanded', String(open));
  if (open) document.querySelector('#close-menu').focus(); else document.querySelector('#open-menu').focus();
}
document.querySelector('#open-menu').addEventListener('click', () => drawer(true));
document.querySelector('#close-menu').addEventListener('click', () => drawer(false));
document.querySelector('#drawer-backdrop').addEventListener('click', () => drawer(false));
document.querySelector('#collapse-nav').addEventListener('click', event => {
  const collapsed = document.querySelector('#sidebar').classList.toggle('collapsed');
  document.body.classList.toggle('seller-nav-collapsed', collapsed);
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  event.currentTarget.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
});
matchMedia('(min-width:1024px)').addEventListener('change', () => {
  document.querySelector('#sidebar').hidden = session?.stage !== 'FULL' || !matchMedia('(min-width:1024px)').matches;
  document.querySelector('#sidebar').classList.remove('drawer-open');
  document.querySelector('#drawer-backdrop').hidden = true;
});
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const sidebar = document.querySelector('#sidebar');
  if (event.key === 'Tab' && sidebar.classList.contains('drawer-open')) {
    const controls = [...sidebar.querySelectorAll('button')].filter(node => !node.disabled);
    const first = controls.find(node => node.getClientRects().length), last = controls.findLast(node => node.getClientRects().length);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (event.key === 'Escape') { if (!sidebar.hidden) drawer(false); document.querySelector('#account-menu').hidden = true; document.querySelector('#account-button').setAttribute('aria-expanded', 'false'); }
});
document.querySelector('#account-button').addEventListener('click', event => { const menu = document.querySelector('#account-menu'); menu.hidden = !menu.hidden; event.currentTarget.setAttribute('aria-expanded', String(!menu.hidden)); });
document.addEventListener('click', event => {
  if (event.target.closest('#account-button')) return;
  document.querySelector('#account-menu').hidden = true;
  document.querySelector('#account-button').setAttribute('aria-expanded', 'false');
});
const content = document.querySelector('#content'), navigation = document.querySelector('#navigation');
const errorBox = document.querySelector('#error'), notice = document.querySelector('#notice');
const dialog = document.querySelector('#secret-dialog'), secretValue = document.querySelector('#secret-value');
containDialogFocus(dialog);
let csrf = null, session = null, busy = false, fieldId = 0, returnFocus = null;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (label, action) => { const node = element('button', label, 'secondary-button'); node.type = 'button'; node.addEventListener('click', () => run(action)); return node; };
// Sign-in fields use the shared icon set (public/shared/icons.js), the same one the Shop and Seller consoles draw from.
function field(form, name, title, { type = 'text', value = '', required = true, autocomplete = 'off', maxLength = 80, icon: leading } = {}) {
  const label = element('label', title), input = element('input'); input.id = `platform-field-${++fieldId}`; label.htmlFor = input.id;
  Object.assign(input, { name, type, value, required, autocomplete, maxLength });
  if (type !== 'password' && !leading) { label.append(input); form.append(label); return input; }
  // Sign-in style field: leading icon inside the box, and for passwords the eye button. The button sits beside the label
  // text, not inside it, so it never becomes part of the field's accessible name.
  const group = element('div', undefined, 'field-group'), wrap = element('div', undefined, 'login-input-wrap');
  wrap.append(icon(leading || 'lock'), input);
  if (type === 'password') {
    const toggle = element('button', undefined, 'password-toggle'); toggle.type = 'button'; toggle.append(icon('eyeOff'));
    toggle.setAttribute('aria-label', 'Show password'); toggle.title = 'Show password'; toggle.setAttribute('aria-controls', input.id); toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.setAttribute('aria-pressed', String(input.type === 'text')); toggle.replaceChildren(icon(input.type === 'text' ? 'eye' : 'eyeOff')); });
    wrap.append(toggle);
  }
  group.append(label, wrap); form.append(group);
  return input;
}
function screen(title) {
  for (const canvas of content.querySelectorAll('canvas')) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); canvas.width = 0; }
  for (const node of content.querySelectorAll('[data-secret]')) node.replaceChildren();
  document.body.classList.toggle('auth', session?.stage !== 'FULL');
  document.body.classList.remove('saving-recovery');
  content.replaceChildren(); document.querySelector('#page-actions').replaceChildren(); document.querySelector('.page-heading .eyebrow').textContent = 'SuperAdmin portal'; document.querySelector('#page-title').textContent = title; notice.textContent = ''; errorBox.hidden = true; errorBox.textContent = '';
  const current = ({ 'Add shop': 'Add shop', 'Audit trail': 'Activity', Account: 'Account' })[title] || 'Shops';
  for (const node of navigation.querySelectorAll('button')) {
    if (node.textContent === current) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    node.classList.toggle('active', node.textContent === current);
  }
  document.querySelector('#main').focus();
}
let flash = null;
function form(action, { parent = content, key } = {}) {
  const node = element('form'), status = element('p', undefined, 'form-status'), problem = element('p', undefined, 'form-error');
  status.setAttribute('role', 'status'); status.tabIndex = -1; problem.setAttribute('role', 'alert'); problem.tabIndex = -1; problem.hidden = true;
  if (key && flash?.key === key) { status.textContent = flash.text; node.dataset.saved = 'true'; flash = null; }
  node.feedback = { status, problem };
  node.addEventListener('submit', (event) => {
    event.preventDefault(); if (!node.reportValidity()) return;
    problem.hidden = true; status.textContent = '';
    run(() => action(Object.fromEntries(new FormData(node)), node), { onError: (error) => { problem.textContent = error.message; problem.hidden = false; problem.focus(); } });
  });
  parent.append(node); return node;
}
// A save button that stays off until a field differs from what the shop has now.
function submit(node, text, { needsChange = false } = {}) {
  const value = element('button', text, 'primary-button'); value.type = 'submit'; node.append(value);
  if (document.body.classList.contains('auth')) value.append(icon('right'));
  if (needsChange) {
    const inputs = [...node.querySelectorAll('input')], initial = inputs.map((input) => input.value.trim());
    const update = () => { const same = inputs.every((input, index) => input.value.trim() === initial[index]); value.dataset.unavailable = String(same); value.disabled = same; };
    node.addEventListener('input', update); update();
  }
  if (node.feedback) { node.append(node.feedback.status, node.feedback.problem); if (node.dataset.saved) node.feedback.status.focus(); }
}
// One task per card: heading, what it does to the seller, then the controls.
let taskHost = null;
function taskCard(title, description, group = 'seller', parent = null) {
  const card = element('section', undefined, 'edit-card'), help = element('p', description, 'edit-help'); help.id = `edit-help-${++fieldId}`;
  card.append(element('h3', title), help); (parent || taskHost?.[group] || content).append(card); return { card, helpId: help.id };
}
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`../api/v1/platform${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    headers: { ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error?.message || 'Request failed.'); error.status = response.status; error.code = value.error?.code; throw error; }
  return value;
}
async function run(action, { onError } = {}) {
  if (busy) return; busy = true; errorBox.hidden = true; content.setAttribute('aria-busy', 'true');
  for (const node of document.querySelectorAll('button')) node.disabled = true;
  try { await action(); }
  catch (error) {
    if (error.status === 401 && session?.stage === 'FULL') { csrf = null; session = null; await signIn(); }
    if (onError && error.status !== 401 && error.name !== 'TimeoutError') onError(error);
    else { errorBox.textContent = error.name === 'TimeoutError' ? 'The request timed out. Refresh the shop list before retrying a change.' : error.message; errorBox.hidden = false; errorBox.focus(); }
  } finally { busy = false; content.removeAttribute('aria-busy'); for (const node of document.querySelectorAll('button')) node.disabled = node.dataset.unavailable === 'true' || (node.dataset.requiresSaved === 'true' && !content.querySelector('.check-label input')?.checked); }
}
async function copy(value, message = 'Copied. Keep these details private.') {
  const feedback = dialog.open ? document.querySelector('#secret-notice') : notice;
  try { await navigator.clipboard.writeText(value); feedback.textContent = message; }
  catch { feedback.textContent = 'Clipboard unavailable. Select and copy the details manually.'; }
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([value], { type: 'text/plain' }));
  const link = element('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function steps(active) {
  const list = element('ol', undefined, 'steps'); list.setAttribute('aria-label', 'Account setup');
  ['Account created', 'Set up authenticator', 'Save recovery codes'].forEach((text, index) => {
    const item = element('li', `${index + 1} · ${text}`); if (index + 1 === active) item.setAttribute('aria-current', 'step'); list.append(item);
  }); content.prepend(list);
}
function recovery(codes) {
  screen('Save your recovery codes'); steps(3);
  document.body.classList.add('auth', 'saving-recovery'); nav();
  content.append(element('p', 'Shown once. Each code lets you sign in once if you lose your authenticator. Store them somewhere private, separate from your phone.', 'callout'));
  const grid = element('div', undefined, 'recovery-grid'); grid.dataset.secret = '';
  for (const code of codes) grid.append(element('code', code));
  const tools = element('div', undefined, 'actions');
  tools.append(button('Copy all', () => copy(grid.textContent ? [...grid.children].map(n => n.textContent).join('\n') : '')),
    button('Download .txt', () => download([...grid.children].map(n => n.textContent).join('\n'), 'shop-platform-recovery-codes.txt')));
  const label = element('label', undefined, 'check-label'), check = element('input'); check.type = 'checkbox'; label.append(check, document.createTextNode('I have saved these recovery codes'));
  const next = button('Continue to shops', async () => { if (!check.checked) throw new Error('Save your recovery codes and tick the checkbox first.'); grid.replaceChildren(); document.body.classList.remove('saving-recovery'); nav(); await listShops(); });
  next.dataset.requiresSaved = 'true';
  next.classList.add('primary-button');
  next.disabled = true; check.addEventListener('change', () => { next.disabled = !check.checked; });
  content.append(grid, tools, label, next); navigation.hidden = true;
}
function showSecrets(title, value, email) {
  returnFocus = document.activeElement; document.querySelector('#secret-title').textContent = title; secretValue.replaceChildren();
  const entries = typeof value === 'string' ? [['Credentials', value]] : Object.entries(value);
  for (const [label, text] of entries) {
    const dd = element('dd'); dd.append(label.endsWith('URL') ? externalLink(text) : element('code', text), button(`Copy ${label}`, () => copy(text)));
    secretValue.append(element('dt', label), dd);
  }
  document.querySelector('#secret-notice').textContent = '';
  const tools = [button('Copy all details', () => copy(entries.map(([key, text]) => `${key}: ${text}`).join('\n')))];
  if (email) {
    // A ready-to-send message for the seller; it holds the one-time password, so it is cleared with the dialog.
    const template = sellerEmailTemplate(email), label = element('label', 'Email to the seller'), area = element('textarea');
    area.readOnly = true; area.rows = 12; area.value = template.text; area.id = 'seller-email-template'; label.htmlFor = area.id; label.append(area);
    tools.push(label, button('Copy email', () => copy(template.text)), button('Copy subject', () => copy(template.subject)), button('Copy message only', () => copy(template.body)));
  }
  document.querySelector('#secret-tools').replaceChildren(...tools);
  dialog.showModal();
}
function clearSecrets() { secretValue.replaceChildren(); document.querySelector('#secret-tools').replaceChildren(); }
dialog.querySelector('form[method=dialog]').addEventListener('submit', clearSecrets);
dialog.addEventListener('cancel', clearSecrets);
dialog.addEventListener('close', () => {
  clearSecrets();
  const target = returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : document.querySelector('#main');
  target.focus(); returnFocus = null;
});
function nav() {
  const full = session?.stage === 'FULL' && !document.body.classList.contains('saving-recovery'); navigation.hidden = !full;
  document.querySelector('.account-wrap').hidden = !full;
  document.body.classList.toggle('seller-signed-in', full);
  document.querySelector('#sidebar').hidden = !full || !matchMedia('(min-width:1024px)').matches;
  document.querySelector('#sidebar').classList.remove('drawer-open');
  document.querySelector('#drawer-backdrop').hidden = true;
  document.querySelector('#account-menu').hidden = true;
  document.querySelector('#account-button').setAttribute('aria-expanded', 'false');
  const identity = document.querySelector('#identity'); identity.hidden = !full; identity.textContent = 'SuperAdmin';
  navigation.replaceChildren(button('Shops', listShops), button('Add shop', createShop), button('Activity', audit), button('Account', account));
  const icons = ['M4 21V7l8-4 8 4v14M2 21h20M9 21v-6h6v6', 'M12 4v16M4 12h16', 'M12 8v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4', 'M5 21v-2a7 7 0 0 1 14 0v2M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0'];
  for (const [index, node] of [...navigation.children].entries()) {
    node.className = 'nav-item';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', icons[index]); svg.append(path);
    const label = element('span', node.textContent); node.replaceChildren(svg, label); node.setAttribute('aria-label', label.textContent); node.title = label.textContent;
    node.addEventListener('click', () => { if (!matchMedia('(min-width:1024px)').matches) drawer(false); });
  }
  navigation.prepend(element('div', 'Platform', 'nav-group'));
  navigation.insertBefore(element('div', 'Security', 'nav-group'), navigation.lastElementChild);
  document.querySelector('#account-menu').replaceChildren(button('Account', account), button('Sign out', async () => { await api('/session', { method: 'DELETE' }); session = null; csrf = null; await signIn(); }));
  document.querySelector('#account-menu').prepend(element('p', session?.username || 'SuperAdmin'));
}
async function signIn() {
  session = null; nav(); screen('Sign in');
  content.append(element('p', 'Welcome back. Manage your shops securely from one place.'));
  const challenge = await api('/csrf'); csrf = challenge.csrfToken;
  const node = form(async (data) => {
    const result = await api('/session', { method: 'POST', body: data }); node.reset(); session = { ...result, username: data.username }; csrf = result.csrfToken; await authenticator();
  });
  field(node, 'username', 'SuperAdmin username', { autocomplete: 'username', maxLength: 64, icon: 'user' });
  field(node, 'password', 'Password', { type: 'password', autocomplete: 'current-password', maxLength: 256 }); submit(node, 'Continue');
}
async function authenticator() {
  screen(session.totpEnabled ? 'Confirm authenticator' : 'Set up authenticator'); nav();
  if (!session.totpEnabled) {
    const setup = await api('/totp/enrol', { method: 'POST', body: {} });
    steps(2);
    content.append(element('p', 'Scan this QR code with your authenticator app, then enter the code it shows.'));
    const qr = window.qrcode(0, 'M'); qr.addData(setup.uri, 'Byte'); qr.make();
    const canvas = element('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Scan to add Shop platform to your authenticator');
    const size = qr.getModuleCount(), scale = 5; canvas.width = canvas.height = (size + 8) * scale;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000';
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) context.fillRect((col + 4) * scale, (row + 4) * scale, scale, scale);
    const panel = element('div', undefined, 'enrol-panel'); panel.append(canvas);
    const manual = element('details'), summary = element('summary', "Can't scan? Enter this key manually"); manual.append(summary);
    manual.append(element('p', `In your authenticator, add an account manually. Name: ${setup.account}. Issuer: ${setup.issuer}. Choose Time-based, 6 digits, 30 s.`));
    const key = element('code', setup.setupKey.match(/.{1,4}/g).join(' '), 'setup-key'); key.dataset.secret = '';
    manual.append(key, button('Copy setup key', () => copy(key.textContent.replaceAll(' ', '')))); panel.append(manual); content.append(panel);
  }
  const node = form(async (data) => {
    const body = { ...data, trustedDevice: trust.checked };
    if (trust.checked) body.trustedDeviceDuration = duration.value; else delete body.trustedDeviceDuration;
    const result = await api('/totp/confirm', { method: 'POST', body }); node.reset(); csrf = result.csrfToken; session = { ...result, username: session.username, totpEnabled: true }; nav();
    // Recovery codes have only one response; preserve them before the next read can fail.
    if (result.recoveryCodes) { recovery(result.recoveryCodes); return; }
    await listShops();
  });
  const input = field(node, 'code', 'Six-digit authenticator code', { autocomplete: 'one-time-code', maxLength: 6, required: !session.totpEnabled, icon: 'key' }); input.inputMode = 'numeric'; input.pattern = '[0-9]{6}';
  if (session.totpEnabled) field(node, 'recoveryCode', 'Or a recovery code', { required: false, maxLength: 11, icon: 'key' });
  const trustLabel = element('label', undefined, 'check-label trusted-device-choice'), trust = element('input');
  trust.type = 'checkbox'; trust.name = 'trustedDevice'; trust.checked = false;
  trustLabel.append(trust, document.createTextNode('Trust this device and keep me signed in')); node.append(trustLabel);
  const durationLabel = element('label', 'Keep me signed in for'), duration = element('select');
  duration.id = `platform-field-${++fieldId}`; duration.name = 'trustedDeviceDuration'; durationLabel.htmlFor = duration.id;
  for (const [value, title] of [['1d', '1 day'], ['1w', '1 week'], ['1m', '1 month (30 days)'], ['1y', '1 year (365 days)']]) {
    const option = element('option', title); option.value = value; duration.append(option);
  }
  duration.value = '1w'; duration.disabled = true;
  trust.addEventListener('change', () => { duration.disabled = !trust.checked; });
  const help = element('p', 'Only use this on a personal device. Sign out to end this device’s session. A longer period increases the risk if your device is lost.', 'field-hint');
  help.id = 'platform-trusted-device-help'; trust.setAttribute('aria-describedby', help.id); duration.setAttribute('aria-describedby', help.id);
  const durationGroup = element('div', undefined, 'field-group trusted-device-duration');
  durationGroup.append(durationLabel, duration); node.append(durationGroup, help);
  submit(node, 'Confirm');
}
function externalLink(value, label) {
  const href = safeLink(value);
  if (!href) return element('span', value || 'Unavailable');
  const link = element('a', label || value); Object.assign(link, { href, target: '_blank', rel: 'noopener noreferrer', title: 'Opens in a new tab' });
  link.setAttribute('aria-label', `${label || value} · Opens in a new tab`); return link;
}
const tableSizes = { shops: 25, activity: 25 };
function dataTable(items, columns, { activity = false, title = '' } = {}) {
  const kind = activity ? 'activity' : 'shops';
  const state = { query: '', status: '', sort: activity ? 'created_at' : 'createdAt', direction: 'descending', page: 1, size: tableSizes[kind] };
  const panel = element('section', undefined, activity ? 'panel activity-table' : 'panel shops-table'), tools = element('div', undefined, 'table-tools');
  const search = element('input'); search.type = 'search'; search.placeholder = activity ? 'Search activity' : 'Search name or code'; search.setAttribute('aria-label', activity ? 'Search activity' : 'Search shops');
  const searchField = element('div', undefined, 'search-field'); searchField.append(icon('search'), search);
  const filter = element('select'); filter.setAttribute('aria-label', activity ? 'Action filter' : 'Status filter');
  for (const value of ['', ...(activity ? [...new Set(items.map(row => row.action))] : ['ACTIVE', 'SUSPENDED', 'PROVISIONING', 'FAILED'])]) { const option = element('option', value ? (activity ? value : statusLabel(value)) : (activity ? 'All actions' : 'All statuses')); option.value = value; filter.append(option); }
  const filterField = element('label', undefined, 'filter-field'); filterField.append(element('span', activity ? 'Action' : 'Status'), filter);
  const size = element('select'); size.setAttribute('aria-label', 'Rows per page');
  for (const count of [10, 25, 50, 100]) { const option = element('option', String(count)); option.value = count; option.selected = count === state.size; size.append(option); }
  const rowsField = element('label', undefined, 'rows-field'); rowsField.append(element('span', 'Rows per page'), size);
  const heading = element('div', undefined, 'table-header'), count = element('p', undefined, 'table-count');
  heading.append(element('h2', title || (activity ? 'All events' : 'All shops')), count);
  const output = element('div', undefined, 'table-output'), paging = element('div', undefined, 'table-paging'), live = element('p', undefined, 'sr-only'); live.setAttribute('role', 'status');
  const footer = element('div', undefined, 'table-footer'), range = element('p', undefined, 'table-range');
  const clear = button('Clear search', () => { search.value = ''; state.query = ''; state.page = 1; draw(); search.focus(); }); clear.hidden = true;
  tools.append(searchField, clear, filterField);
  const mobileSort = element('div', undefined, 'mobile-sort');
  const sortSelect = element('select'); sortSelect.setAttribute('aria-label', 'Sort by');
  for (const column of columns.filter(column => column.key)) {
    const option = element('option', column.label); option.value = column.key; sortSelect.append(option);
  }
  const direction = button('Descending', () => {
    state.direction = state.direction === 'ascending' ? 'descending' : 'ascending';
    state.page = 1; draw();
  });
  direction.setAttribute('aria-label', 'Sort direction');
  sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; state.direction = 'ascending'; state.page = 1; draw(); });
  mobileSort.append(element('span', 'Sort by'), sortSelect, direction);
  tools.append(mobileSort); footer.append(range, rowsField, paging); panel.append(tools, heading, output, footer, live); content.append(panel);
  let timer;
  search.addEventListener('input', () => { clear.hidden = !search.value; clearTimeout(timer); timer = setTimeout(() => { state.query = search.value; state.page = 1; draw(); }, 180); });
  filter.addEventListener('change', () => { state.status = filter.value; state.page = 1; draw(); });
  size.addEventListener('change', () => { state.size = tableSizes[kind] = Number(size.value); state.page = 1; draw(); });
  function draw(focusKey) {
    const source = activity && state.status ? items.filter(row => row.action === state.status) : items;
    const result = tableRows(source, { ...state, status: activity ? '' : state.status }); state.page = result.page;
    const noun = (n) => `${n} ${activity ? (n === 1 ? 'event' : 'events') : (n === 1 ? 'shop' : 'shops')}`;
    count.textContent = result.total === items.length ? noun(items.length) : `${result.total} of ${noun(items.length)}`;
    clear.hidden = !search.value;
    sortSelect.value = state.sort;
    direction.textContent = state.direction === 'ascending' ? 'Ascending' : state.direction === 'descending' ? 'Descending' : 'Unsorted';
    if (state.direction) direction.append(icon(state.direction === 'ascending' ? 'up' : 'down'));
    const table = element('table', undefined, 'data-table'), caption = element('caption', activity ? 'Platform activity' : 'Shops'); caption.className = 'sr-only'; table.append(caption);
    const head = element('thead'), header = element('tr'), body = element('tbody');
    for (const column of columns) {
      const th = element('th'); th.scope = 'col';
      if (column.key) {
        th.setAttribute('aria-sort', state.sort === column.key && state.direction ? state.direction : 'none');
        const control = button(column.label, () => {
          state.direction = state.sort !== column.key ? 'ascending' : state.direction === 'ascending' ? 'descending' : state.direction === 'descending' ? '' : 'ascending';
          state.sort = column.key; state.page = 1; draw(column.key);
        }); control.dataset.sort = column.key; th.append(control);
        if (state.sort === column.key && state.direction) control.append(icon(state.direction === 'ascending' ? 'up' : 'down'));
      } else th.textContent = column.label;
      header.append(th);
    }
    head.append(header); table.append(head, body);
    for (const row of result.rows) {
      const tr = element('tr');
      for (const column of columns) { const td = element('td'); td.dataset.label = column.label; td.dataset.column = column.key || column.label.toLowerCase(); const value = column.render ? column.render(row) : element('span', String(row[column.key] ?? '—')); td.append(value); tr.append(td); }
      body.append(tr);
    }
    output.replaceChildren(table);
    if (!result.total) output.append(element('p', 'No results.'), button('Reset filters', () => { search.value = ''; filter.value = ''; state.query = state.status = ''; state.page = 1; draw(); }));
    live.textContent = `Showing ${result.start}-${result.end} of ${result.total}`;
    // One page: no pager, no range line; rows-per-page only when there are more rows than the smallest page.
    range.textContent = result.pages > 1 ? `Showing ${result.start}–${result.end} of ${result.total}` : '';
    rowsField.hidden = items.length <= 10; paging.hidden = result.pages <= 1; range.hidden = result.pages <= 1;
    footer.hidden = rowsField.hidden && paging.hidden;
    paging.replaceChildren();
    const pageButton = (label, page, disabled = false) => { const control = button(label, () => { state.page = page; draw(); paging.querySelector(`[data-page="${label}"]`)?.focus(); }); control.disabled = disabled; control.dataset.unavailable = String(disabled); control.dataset.page = label; paging.append(control); return control; };
    pageButton('Previous', state.page - 1, state.page === 1);
    let previous = 0;
    for (let page = 1; page <= result.pages; page++) if (page === 1 || page === result.pages || Math.abs(page - state.page) <= 1) {
      if (previous && page - previous > 1) paging.append(icon('more'));
      const control = pageButton(String(page), page); if (page === state.page) control.setAttribute('aria-current', 'page'); previous = page;
    }
    pageButton('Next', state.page + 1, state.page === result.pages);
    if (focusKey) output.querySelector(`[data-sort=\"${focusKey}\"]`)?.focus();
  }
  draw();
}
function loadingRows(label) {
  const panel = element('section', undefined, 'skeleton panel');
  const status = element('p', label); status.setAttribute('role', 'status'); panel.append(status);
  const rows = element('div'); rows.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 5; index++) rows.append(element('div', '\u00a0', 'skeleton-row'));
  panel.append(rows); return panel;
}
const statusLabel = (status) => ({ ACTIVE: 'Active', SUSPENDED: 'Suspended', PROVISIONING: 'Setting up', FAILED: 'Failed', DELETING: 'Deleting' })[status] || status;
const day = (iso) => iso ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—';
// "More actions" for one shop row: open and copy its links. A small menu: Escape or a click elsewhere closes it, arrows move between items.
function rowMenu(shop) {
  const wrap = element('div', undefined, 'row-menu'), toggle = element('button', undefined, 'row-menu-toggle'), menu = element('div', undefined, 'row-menu-list');
  toggle.type = 'button'; toggle.append(icon('more')); toggle.setAttribute('aria-label', `More actions for ${shop.name}`); toggle.title = 'More actions';
  menu.id = `row-menu-${++fieldId}`; menu.setAttribute('role', 'menu'); menu.hidden = true;
  toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', menu.id);
  const close = (focus) => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (focus) toggle.focus(); };
  const items = [];
  for (const [label, url] of [['Open shop', shop.shopUrl], ['Open seller', shop.sellerUrl]]) if (url && safeLink(url)) {
    const link = externalLink(url, label); link.setAttribute('role', 'menuitem'); link.append(icon('external')); link.addEventListener('click', () => close(false)); items.push(link);
  }
  for (const [label, url, done] of [['Copy shop link', shop.shopUrl, 'Shop link copied.'], ['Copy seller link', shop.sellerUrl, 'Seller link copied.']]) if (url) {
    const item = element('button', label); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.prepend(icon('copy'));
    item.addEventListener('click', async () => { await copy(url, done); close(true); }); items.push(item);
  }
  menu.append(...items);
  toggle.addEventListener('click', () => {
    const opening = menu.hidden;
    for (const other of document.querySelectorAll('.row-menu-list:not([hidden])')) other.closest('.row-menu').querySelector('.row-menu-toggle').click();
    if (opening) { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); items[0]?.focus(); }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = items.indexOf(document.activeElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    if (event.key === 'Tab') close(false);
  });
  wrap.append(toggle, menu); return wrap;
}
document.addEventListener('click', (event) => { for (const menu of document.querySelectorAll('.row-menu-list:not([hidden])')) if (!menu.closest('.row-menu').contains(event.target)) { menu.hidden = true; menu.closest('.row-menu').querySelector('.row-menu-toggle').setAttribute('aria-expanded', 'false'); } });
async function listShops() {
  screen('Shops');
  const lead = element('p', 'Manage your shops and seller access.', 'page-lead'); content.append(lead);
  const add = button('Add shop', createShop); add.className = 'primary-button'; add.prepend(icon('plus')); document.querySelector('#page-actions').append(add);
  const loading = loadingRows('Loading shops…'); content.append(loading);
  try {
    const result = await api('/shops'); loading.remove();
    const active = result.items.filter(shop => shop.status === 'ACTIVE').length, suspended = result.items.filter(shop => shop.status === 'SUSPENDED').length;
    lead.textContent = `${result.items.length} ${result.items.length === 1 ? 'shop' : 'shops'} · ${active} active${suspended ? ` · ${suspended} suspended` : ''}`;
    if (!result.items.length) {
      const empty = element('section', undefined, 'panel empty-state'); empty.append(element('h2', 'No shops yet'), element('p', 'Create the first shop. You choose its code and Owner username, and get a one-time password to send to the seller.'));
      const first = button('Add shop', createShop); first.className = 'primary-button'; empty.append(first); content.append(empty); return;
    }
    dataTable(result.items, [
      { key: 'name', label: 'Shop', render: shop => {
        const cell = element('div', undefined, 'shop-cell'), line = element('div', undefined, 'shop-line'), name = element('span', shop.name, 'shop-name'); name.title = shop.name; line.append(name);
        if (shop.isDefault) line.append(element('span', 'Default shop', 'chip'));
        const meta = element('span', `Code ${shop.code}`, 'shop-meta'); meta.append(element('span', ` · ${shop.currency} · ${day(shop.createdAt)}`, 'mobile-meta'));
        cell.append(line, meta); return cell;
      } },
      { key: 'status', label: 'Status', render: shop => element('span', statusLabel(shop.status), `chip status-${shop.status.toLowerCase()}`) },
      { key: 'currency', label: 'Currency' }, { key: 'createdAt', label: 'Created', render: shop => element('time', day(shop.createdAt)) },
      { label: 'Actions', render: shop => { const group = element('div', undefined, 'row-actions'); group.append(button('Manage', () => detail(shop.id)), rowMenu(shop)); return group; } }
    ]);
  } catch (error) { if (error.status === 401) throw error; loading.className = 'panel'; loading.setAttribute('role', 'alert'); loading.replaceChildren(element('p', error.message), button('Retry', listShops)); }
}
async function mutateShop(shop, action, body = {}) {
  const result = await api(`/shops/${shop.id}/${action}`, { method: 'POST', body: { expectedRevision: shop.revision, ...body } });
  // Preserve one-time credentials before any subsequent query can fail.
  if (result.sellerPassword) showSecrets('Seller password reset', { 'Seller URL': shop.sellerUrl, Username: result.sellerUsername, 'Temporary password': result.sellerPassword },
    { shopName: shop.name, sellerUrl: shop.sellerUrl, username: result.sellerUsername, password: result.sellerPassword });
  return result;
}
async function createShop() {
  screen('Add shop'); content.append(element('p', 'Give your shop a home. We will create a separate workspace and a temporary password for its seller. Up to 20 shops per host.'));
  const node = form(async (data) => {
    const result = await api('/shops', { method: 'POST', body: data }); node.reset();
    showSecrets('Save the new shop details', { 'Buyer URL': result.shopUrl, 'Seller URL': result.sellerUrl, Username: result.tenant.sellerUsername, 'First password': result.sellerPassword },
      { shopName: result.tenant.name, sellerUrl: result.sellerUrl, username: result.tenant.sellerUsername, password: result.sellerPassword });
    await detail(result.tenant.id);
  });
  const code = field(node, 'code', 'Shop code', { maxLength: 30 }); code.pattern = '[a-z0-9]{3,30}';
  const hint = element('p', '3–30 lowercase letters and numbers. This becomes part of the shop address.', 'field-hint'); hint.id = 'code-hint'; code.setAttribute('aria-describedby', hint.id); code.after(hint);
  code.addEventListener('input', () => { hint.textContent = code.validity.patternMismatch ? 'Use 3–30 lowercase letters and numbers only.' : 'Format looks good. Availability is checked when you create the shop.'; });
  field(node, 'name', 'Shop name');
  const label = element('label', 'Currency'), select = element('select'); select.name = 'currency'; select.id = 'platform-currency'; label.htmlFor = select.id;
  for (const currency of ['MYR', 'SGD']) { const option = element('option', currency); option.value = currency; select.append(option); } label.append(select); node.append(label);
  field(node, 'sellerUsername', 'Seller username', { maxLength: 64 }); submit(node, 'Create shop');
}
// Render, then drop the groups that ended up with no cards for this shop's status.
async function detail(id) {
  await renderDetail(id);
  for (const grid of Object.values(taskHost || {})) if (!grid.children.length) grid.parentElement.remove();
}
async function renderDetail(id) {
  const shop = await api(`/shops/${id}`); screen(shop.name);
  // Breadcrumb in the eyebrow slot: where am I, and the way back.
  const crumbs = element('nav', undefined, 'breadcrumb'), trail = element('ol'), back = button('Shops', listShops); back.className = 'text-button breadcrumb-link';
  for (const part of [element('span', 'Platform'), back, element('span', shop.name)]) { const item = element('li'); item.append(part); trail.append(item); }
  trail.lastChild.setAttribute('aria-current', 'page');
  crumbs.setAttribute('aria-label', 'Breadcrumb'); crumbs.append(trail); document.querySelector('.page-heading .eyebrow').replaceChildren(crumbs);
  // Header: what state is it in, and the next things an administrator does.
  const head = element('div', undefined, 'detail-head'), state = element('div', undefined, 'detail-state'), tools = element('div', undefined, 'detail-tools');
  state.append(element('span', shop.status, `chip status-${shop.status.toLowerCase()}`), element('span', `Shop code: ${shop.code}`, 'detail-code'));
  if (shop.isDefault) state.append(element('span', 'default shop', 'chip'));
  head.append(state, tools); content.append(head);
  const statusNote = ({ ACTIVE: 'Live and serving buyers.', SUSPENDED: 'Suspended: the shop answers “unavailable” and sends no WhatsApp messages. Data is kept.',
    DELETING: `Scheduled for deletion${shop.deleteAfter ? ` after ${new Date(shop.deleteAfter).toLocaleDateString()}` : ''}. Cancel it before then to keep the shop.`,
    PROVISIONING: 'Being set up. This takes a moment.', FAILED: 'Setup failed.' })[shop.status];
  if (statusNote) content.append(element('p', statusNote, 'detail-note'));
  const kpis = element('dl', undefined, 'kpis');
  for (const [title, value] of [['Products', shop.productCount ?? 'Unavailable'], ['Orders', shop.orderCount ?? 'Unavailable'], ['Currency', shop.currency]]) {
    const tile = element('div', undefined, 'kpi'), dd = element('dd', String(value)); tile.append(element('dt', title), dd); kpis.append(tile);
  }
  content.append(kpis);
  const overview = element('div', undefined, 'detail-info'), info = element('section'), storeLinks = element('section');
  info.append(element('h2', 'Shop information', 'group-title')); storeLinks.append(element('h2', 'Store links', 'group-title'));
  const rows = element('dl', undefined, 'info-rows');
  for (const [title, value] of [['Seller', shop.sellerUsername || 'Managed on host'], ['Deletion date', shop.deleteAfter ? new Date(shop.deleteAfter).toLocaleDateString() : 'Not scheduled']]) {
    const row = element('div', undefined, 'info-row'); row.append(element('dt', title), element('dd', value)); rows.append(row);
  }
  info.append(rows);
  const links = element('div', undefined, 'url-rows');
  for (const [label, value] of [['Buyer storefront', shop.shopUrl], ['Seller portal', shop.sellerUrl]]) if (value) {
    const row = element('div', undefined, 'url-row'), copyButton = button('', () => copy(value));
    copyButton.className = 'icon-button'; copyButton.setAttribute('aria-label', `Copy ${label} URL`); copyButton.title = `Copy ${label} URL`; copyButton.append(icon('copy'));
    row.append(element('span', label, 'url-label'), externalLink(value), copyButton); links.append(row);
  }
  storeLinks.append(links); overview.append(info, storeLinks); content.append(overview);
  // Open links and the edit shortcut sit in the header; they are shown only for links on this platform's own domain.
  for (const [label, value] of [['Open shop', shop.shopUrl], ['Open seller', shop.sellerUrl]]) if (value && safeLink(value)) {
    const link = externalLink(value, label); link.className = 'link-button'; tools.append(link);
  }
  // Groups keep security, settings, integrations and destructive actions apart; empty groups are removed at the end.
  const groups = {}, sections = element('div', undefined, 'detail-groups'); content.append(sections);
  for (const [key, title] of [['seller', 'Seller account & security'], ['shop', 'Shop settings'], ['integrations', 'Integrations'], ['danger', 'Danger zone']]) {
    const section = element('section', undefined, `detail-group group-${key}`), grid = element('div', undefined, 'group-grid');
    section.append(element('h2', title, 'group-title'), grid); sections.append(section); groups[key] = grid;
  }
  taskHost = groups;
  const edit = button('Edit shop', async () => { const target = content.querySelector('.group-shop input'); target?.scrollIntoView({ block: 'center' }); target?.focus(); });
  edit.className = 'link-button'; edit.prepend(icon('edit')); if (['ACTIVE', 'SUSPENDED'].includes(shop.status)) tools.prepend(edit);
  const qrPanel = element('section', undefined, 'panel'); qrPanel.setAttribute('aria-label', 'WhatsApp QR policy'); groups.integrations.append(qrPanel);
  try {
    const policy = await api(`/shops/${id}/qr`);
    qrPanel.append(element('h3', 'WhatsApp QR'));
    if (!policy) {
      // Platform-level state, not a shop problem: the title row says what it is, the body says whose task it is and what to do,
      // and the diagnostics stay folded (and copyable) so the two are not read twice.
      qrPanel.replaceChildren(); qrPanel.classList.add('qr-unavailable');
      const header = element('div', undefined, 'qr-header'), title = element('h3', 'WhatsApp QR'); title.prepend(icon('chat'));
      header.append(title, element('span', 'Setup required', 'chip status-setup')); qrPanel.append(header);
      qrPanel.append(element('p', 'Lets the shop’s Owner link a WhatsApp device from the seller console.', 'qr-purpose'));
      const status = element('div', undefined, 'qr-status'), heading = element('h4', 'Platform setup pending'); heading.prepend(icon('info'));
      status.append(heading, element('p', 'WhatsApp QR is unavailable until the platform database is upgraded. This is a platform task: nothing is wrong with this shop and the seller does not need to do anything.'),
        element('p', 'Host operator: run the platform upgrade for WhatsApp QR, then reload this page.', 'qr-next'));
      qrPanel.append(status);
      const diagnostics = `WhatsApp QR unavailable\nShop: ${shop.code} (${shop.status})\nPolicy endpoint: returned no policy\nMissing: platform schema 3 (migration 003-whatsapp-qr.sql, explicit opt-in)\nReference: docs/WHATSAPP_QR_TENANTS_DESIGN.md\nChecked: ${new Date().toISOString()}`;
      const more = element('details', undefined, 'qr-details'), summary = element('summary'), label = element('span', 'Technical details'); label.prepend(icon('sliders'));
      summary.append(label, icon('chevronDown')); more.append(summary, element('pre', diagnostics));
      const copyDiagnostics = button('Copy technical details', () => copy(diagnostics)); copyDiagnostics.className = 'link-button'; copyDiagnostics.prepend(icon('copy')); more.append(copyDiagnostics);
      qrPanel.append(more);
    }
    else {
      const binding = policy.binding, enabled = Boolean(binding?.enabled);
      const status = element('p', `${shop.isDefault ? 'Default slot 0 (host managed)' : policy.provisioned ? 'Worker provisioned' : 'Worker not provisioned'} · ${enabled ? 'Enabled' : 'Disabled'} · Tenant slots reserved: ${policy.occupiedTenantSlots} / ${policy.tenantSlots} · Slot: ${binding?.slot_id ?? 'None'} · Cleanup: ${binding?.cleanup_pending ? 'Pending' : 'None'}`);
      status.setAttribute('role', 'status'); qrPanel.append(status);
      const telemetry = shop.qrStatus;
      qrPanel.append(element('p', `Worker state (last reported): ${telemetry?.state ?? 'Unavailable'} · Heartbeat: ${telemetry?.heartbeatAt ?? 'Unavailable'} · Worker error: ${telemetry ? telemetry.hasError ? 'Reported' : 'None' : 'Unavailable'}`));
      qrPanel.append(element('p', 'No QR codes, credentials, phone numbers or chats are accessible here.'));
      qrPanel.append(element('p', 'Disabling fences new work; an already claimed send may complete. Unlink the device in official WhatsApp. A host operator must restart a revoked worker before reactivation.'));
      const control = button(enabled ? 'Disable QR' : 'Enable QR', async () => {
        if (!await confirmModal('This changes the shop’s linked-device policy. The Owner must acknowledge the risks and pair in the seller console.', { title: enabled ? 'Disable WhatsApp QR?' : 'Enable WhatsApp QR?', confirmLabel: enabled ? 'Disable QR' : 'Enable QR' })) return;
        await mutateShop(shop, `qr/${enabled ? 'disable' : 'enable'}`);
        await detail(id);
      });
      control.dataset.unavailable = String(!enabled && (shop.status !== 'ACTIVE' || Boolean(binding?.cleanup_pending) || !shop.isDefault && !policy.provisioned));
      control.disabled = control.dataset.unavailable === 'true'; qrPanel.append(control);
    }
  } catch (error) { qrPanel.append(element('p', error.message)); }
  const action = async (name, body = {}, done) => {
    const result = await mutateShop(shop, name, body);
    if (done) flash = done;
    await detail(id); return result;
  };
  const describe = (input, helpId) => input.setAttribute('aria-describedby', helpId);
  const resetCard = () => {
    const { card } = taskCard('Reset seller password', 'Resetting creates a temporary password and signs the Owner out of all sessions and connector sign-ins. The temporary password is shown once.');
    const reset = button('Reset seller password', async () => {
      if (!await confirmModal(`A new temporary password is created for ${shop.sellerUsername}. Their open sessions and connector sign-ins end, and they must choose a new password at the next sign-in. The password is shown once.`,
        { title: 'Reset seller password?', confirmLabel: 'Reset and show password' })) return;
      await action('reset-seller-password');
    });
    reset.classList.add('danger-button'); card.append(reset);
  };
  const usernameCard = () => {
    const { card, helpId } = taskCard('Change seller username', 'Changing the username signs the Owner out of all sessions and connector sign-ins. Their password stays the same.');
    const node = form(async (body) => {
      if (!await confirmModal(`Change the Owner username from ${shop.sellerUsername} to ${body.username}? Their open sessions and connector sign-ins end.`, { title: 'Change seller username?', confirmLabel: 'Change username' })) return;
      await action('change-seller-username', body, { key: 'username', text: 'Seller username updated. The Owner must sign in with the new username.' });
    }, { parent: card, key: 'username' });
    describe(field(node, 'username', 'New seller username', { value: shop.sellerUsername || '', maxLength: 64, autocomplete: 'off' }), helpId); submit(node, 'Save username', { needsChange: true });
  };
  const canReset = shop.status === 'ACTIVE' && shop.sellerUsername && shop.canResetSeller !== false;
  if (shop.isDefault) {
    // The default shop is otherwise managed on the host; only its Owner account and its name are edited from here.
    if (canReset) { resetCard(); usernameCard(); }
    if (shop.status === 'ACTIVE') {
      const { card, helpId } = taskCard('Shop name', 'Changing the name does not change the shop code or its buyer and seller links.', 'shop');
      const node = form(async (body) => action('rename', body, { key: 'name', text: 'Shop name updated.' }), { parent: card, key: 'name' });
      describe(field(node, 'name', 'Shop name', { value: shop.name }), helpId); submit(node, 'Save name', { needsChange: true });
    }
    return;
  }
  const actions = element('div', undefined, 'actions');
  if (shop.status === 'ACTIVE') actions.append(button('Suspend shop', () => action('suspend')));
  if (shop.status === 'SUSPENDED') actions.append(button('Resume shop', () => action('resume')));
  if (shop.status === 'DELETING') actions.append(button('Cancel deletion', () => action('cancel-deletion')));
  for (const control of actions.querySelectorAll('button')) control.classList.add('link-button');
  if (actions.children.length) tools.append(actions);
  if (['ACTIVE', 'SUSPENDED'].includes(shop.status)) {
    resetCard();
    if (shop.sellerUsername) usernameCard();
    const { card, helpId } = taskCard('Rename shop', 'The name is shown to buyers. Changing the code changes this shop’s links.', 'shop');
    const node = form(async (body) => action('rename', body, { key: 'name', text: 'Shop name and code updated.' }), { parent: card, key: 'name' });
    describe(field(node, 'code', 'Shop code', { value: shop.code, maxLength: 30 }), helpId); field(node, 'name', 'Shop name', { value: shop.name }); submit(node, 'Save name and code', { needsChange: true });
  }
  if (shop.status === 'SUSPENDED') {
    const { card, helpId } = taskCard('Request deletion', 'Data is retained for 30 days. A host operator must take a verified final backup before purging.', 'danger');
    const node = form(async (body) => action('request-deletion', body), { parent: card });
    describe(field(node, 'code', `Type ${shop.code} to confirm`, { maxLength: 30 }), helpId); submit(node, 'Request deletion'); node.querySelector('button[type=submit]').classList.add('danger-button');
  }
  if (shop.status === 'FAILED') content.append(element('p', 'Provisioning failed. Retry Create shop with this code to recover the unfinished setup.'));
}
async function audit(cursor = null) {
  screen('Audit trail'); const loading = loadingRows('Loading activity…'); content.append(loading);
  try {
    const result = await api(`/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); loading.remove();
    dataTable(result.items, [
      { key: 'created_at', label: 'Time', render: row => element('time', new Date(row.created_at).toLocaleString()) },
      { key: 'action', label: 'Action', render: row => element('span', row.action.toLowerCase().replaceAll('_', ' ')) },
      { key: 'actor', label: 'Actor' }, { key: 'detail', label: 'Detail', render: row => { const text = element('span'); for (const part of String(row.detail || '').split(/(https?:\/\/[^\s\"<>]+)/g)) text.append(/^https?:\/\//.test(part) ? externalLink(part) : document.createTextNode(part)); return text; } }
    ], { activity: true });
    if (result.nextCursor) content.append(button('Older events', () => audit(result.nextCursor)));
  } catch (error) { if (error.status === 401) throw error; loading.className = 'panel'; loading.setAttribute('role', 'alert'); loading.replaceChildren(element('p', error.message), button('Retry', () => audit(cursor))); }
}
async function account() {
  screen('Account');
  const layout = element('div', undefined, 'account-layout'), main = element('div', undefined, 'account-main'), side = element('div', undefined, 'account-side');
  layout.append(main, side); content.append(layout);
  const intro = element('section'); intro.append(element('h2', 'Security', 'group-title'), element('p', 'Manage your password and account recovery.', 'edit-help')); main.append(intro);
  const username = session.username || 'SuperAdmin';
  const describe = (input, helpId) => input.setAttribute('aria-describedby', helpId);

  // Change password: the server rules (12 to 256 characters, no username, not one repeated character, not the old password) are shown and checked first.
  const change = taskCard('Change password', 'Changing it signs out every other session, including trusted devices.', 'seller', main);
  const rules = element('ul', undefined, 'requirements');
  for (const rule of ['12 to 256 characters', 'Does not contain your username', 'Not one repeated character', 'Different from the current password']) rules.append(element('li', rule));
  rules.id = `rules-${++fieldId}`; change.card.append(rules);
  const passwordForm = form(async (data, node) => {
    const next = data.newPassword;
    if (next.length < 12 || next.length > 256) throw new Error('Use 12 to 256 characters for the new password.');
    if (next.toLowerCase().includes(username.toLowerCase())) throw new Error('The new password must not contain your username.');
    if (/^(.)\1+$/.test(next)) throw new Error('Choose a less repetitive password.');
    if (next === data.currentPassword) throw new Error('Choose a password different from the current one.');
    if (next !== data.confirmPassword) throw new Error('The two new passwords do not match.');
    await api('/account/password', { method: 'POST', body: { currentPassword: data.currentPassword, newPassword: next } });
    node.reset(); node.feedback.status.textContent = 'Password changed. Every other session was signed out.';
  }, { parent: change.card });
  field(passwordForm, 'currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 });
  describe(field(passwordForm, 'newPassword', 'New password', { type: 'password', autocomplete: 'new-password', maxLength: 256 }), rules.id);
  field(passwordForm, 'confirmPassword', 'Confirm new password', { type: 'password', autocomplete: 'new-password', maxLength: 256 });
  submit(passwordForm, 'Change password');

  // Recovery codes: regenerating is destructive, so it asks first and says what happens.
  const codes = taskCard('Recovery codes', 'Regenerating invalidates every previous recovery code at once. You must save the new codes before you continue.', 'seller', main);
  const recoveryForm = form(async (data, node) => {
    if (!await confirmModal('Every previous recovery code stops working immediately. Have your password manager or a safe place ready: the new codes are shown once.', { title: 'Regenerate recovery codes?', confirmLabel: 'Regenerate codes' })) return;
    const result = await api('/account/recovery-codes', { method: 'POST', body: data }); node.reset(); recovery(result.recoveryCodes);
  }, { parent: codes.card });
  field(recoveryForm, 'password', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 }); submit(recoveryForm, 'Regenerate recovery codes');

  // Side column: who is signed in, appearance, app version.
  const who = taskCard('Signed in', 'The SuperAdmin account for this browser.', 'seller', side);
  who.card.append(element('p', username, 'account-name'));
  const appearance = element('section'); side.append(appearance); mountAppearance(appearance, 'seller');
  mountAppSection(side);
}
// Update guard: unsaved edits or a request in flight defer the reload; nothing is applied without "Update now".
const unsavedEdits = () => [...content.querySelectorAll('form input, form select, form textarea')].some((input) => input.type === 'password' ? input.value !== '' : input.type === 'checkbox' ? input.checked !== input.defaultChecked : input.value !== input.defaultValue);
// One-time secrets (recovery codes, new seller credentials) exist only on screen; reloading would destroy them.
const oneTimeSecretsShown = () => document.body.classList.contains('saving-recovery') || document.querySelector('#secret-dialog')?.open === true;
initPwaShell({ guard: () => ({ dirty: unsavedEdits() || oneTimeSecretsShown(), busy, signature: draftSignature(content) }), confirmUpdate: (text) => confirmModal(text, { title: 'Update now?', confirmLabel: 'Update' }) });
await run(async () => {
  try { session = await api('/session'); csrf = session.csrfToken; nav(); if (session.stage === 'FULL') await listShops(); else await authenticator(); }
  catch (error) { if (error.status === 401) await signIn(); else throw error; }
});
markReady();
addEventListener('pagehide', () => {
  for (const canvas of content.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
  for (const node of content.querySelectorAll('[data-secret]')) node.replaceChildren();
  secretValue.textContent = ''; document.querySelector('#secret-tools').replaceChildren();
  for (const input of document.querySelectorAll('input')) input.value = '';
});
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
