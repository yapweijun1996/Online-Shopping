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
function field(form, name, title, { type = 'text', value = '', required = true, autocomplete = 'off', maxLength = 80 } = {}) {
  const label = element('label', title), input = element('input'); input.id = `platform-field-${++fieldId}`; label.htmlFor = input.id;
  Object.assign(input, { name, type, value, required, autocomplete, maxLength }); label.append(input); form.append(label);
  if (type === 'password') {
    const toggle = button('Show password', () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? 'Show password' : 'Hide password'; toggle.setAttribute('aria-pressed', String(input.type === 'text')); });
    toggle.setAttribute('aria-controls', input.id); toggle.setAttribute('aria-pressed', 'false'); label.after(toggle);
    toggle.className = 'text-button password-visibility';
  }
  return input;
}
function screen(title) {
  for (const canvas of content.querySelectorAll('canvas')) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); canvas.width = 0; }
  for (const node of content.querySelectorAll('[data-secret]')) node.replaceChildren();
  document.body.classList.toggle('auth', session?.stage !== 'FULL');
  document.body.classList.remove('saving-recovery');
  content.replaceChildren(); document.querySelector('#page-title').textContent = title; notice.textContent = ''; errorBox.hidden = true; errorBox.textContent = '';
  const current = ({ 'Add shop': 'Add shop', 'Audit trail': 'Activity', Account: 'Account' })[title] || 'Shops';
  for (const node of navigation.querySelectorAll('button')) {
    if (node.textContent === current) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    node.classList.toggle('active', node.textContent === current);
  }
  document.querySelector('#main').focus();
}
function form(action) {
  const node = element('form'); node.addEventListener('submit', (event) => { event.preventDefault(); if (node.reportValidity()) run(() => action(Object.fromEntries(new FormData(node)), node)); });
  content.append(node); return node;
}
function submit(node, text) { const value = element('button', text, 'primary-button'); value.type = 'submit'; node.append(value); }
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`../api/v1/platform${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    headers: { ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error?.message || 'Request failed.'); error.status = response.status; error.code = value.error?.code; throw error; }
  return value;
}
async function run(action) {
  if (busy) return; busy = true; errorBox.hidden = true; content.setAttribute('aria-busy', 'true');
  for (const node of document.querySelectorAll('button')) node.disabled = true;
  try { await action(); }
  catch (error) {
    if (error.status === 401 && session?.stage === 'FULL') { csrf = null; session = null; await signIn(); }
    errorBox.textContent = error.name === 'TimeoutError' ? 'The request timed out. Refresh the shop list before retrying a change.' : error.message;
    errorBox.hidden = false; errorBox.focus();
  } finally { busy = false; content.removeAttribute('aria-busy'); for (const node of document.querySelectorAll('button')) node.disabled = node.dataset.unavailable === 'true' || (node.dataset.requiresSaved === 'true' && !content.querySelector('.check-label input')?.checked); }
}
async function copy(value) {
  const feedback = dialog.open ? document.querySelector('#secret-notice') : notice;
  try { await navigator.clipboard.writeText(value); feedback.textContent = 'Copied. Keep these details private.'; }
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
  field(node, 'username', 'SuperAdmin username', { autocomplete: 'username', maxLength: 64 });
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
    const result = await api('/totp/confirm', { method: 'POST', body: data }); node.reset(); csrf = result.csrfToken; session = { ...result, username: session.username, totpEnabled: true }; nav();
    // Recovery codes have only one response; preserve them before the next read can fail.
    if (result.recoveryCodes) { recovery(result.recoveryCodes); return; }
    await listShops();
  });
  const input = field(node, 'code', 'Six-digit authenticator code', { autocomplete: 'one-time-code', maxLength: 6, required: !session.totpEnabled }); input.inputMode = 'numeric'; input.pattern = '[0-9]{6}';
  if (session.totpEnabled) field(node, 'recoveryCode', 'Or a recovery code', { required: false, maxLength: 11 });
  submit(node, 'Confirm');
}
function externalLink(value, label) {
  const href = safeLink(value);
  if (!href) return element('span', value || 'Unavailable');
  const link = element('a', label || value); Object.assign(link, { href, target: '_blank', rel: 'noopener noreferrer', title: 'Opens in a new tab' });
  link.setAttribute('aria-label', `${label || value} · Opens in a new tab`); return link;
}
const tableSizes = { shops: 25, activity: 25 };
function dataTable(items, columns, { activity = false } = {}) {
  const kind = activity ? 'activity' : 'shops';
  const state = { query: '', status: '', sort: activity ? 'created_at' : 'createdAt', direction: 'descending', page: 1, size: tableSizes[kind] };
  const panel = element('section', undefined, activity ? 'panel activity-table' : 'panel shops-table'), tools = element('div', undefined, 'table-tools');
  const search = element('input'); search.type = 'search'; search.placeholder = activity ? 'Search activity' : 'Search shops'; search.setAttribute('aria-label', search.placeholder);
  const filter = element('select'); filter.setAttribute('aria-label', activity ? 'Action filter' : 'Status filter');
  for (const value of ['', ...(activity ? [...new Set(items.map(row => row.action))] : ['ACTIVE', 'SUSPENDED', 'PROVISIONING', 'FAILED'])]) { const option = element('option', value || 'All'); option.value = value; filter.append(option); }
  const size = element('select'); size.setAttribute('aria-label', 'Rows per page');
  for (const count of [10, 25, 50, 100]) { const option = element('option', String(count)); option.value = count; option.selected = count === state.size; size.append(option); }
  const count = element('p'), output = element('div', undefined, 'table-output'), paging = element('div', undefined, 'table-paging'), live = element('p'); live.setAttribute('role', 'status');
  tools.append(search, button('Clear search', () => { search.value = ''; state.query = ''; state.page = 1; draw(); search.focus(); }), filter, element('span', 'Rows per page'), size);
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
  tools.append(mobileSort); panel.append(tools, count, output, live, paging); content.append(panel);
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.query = search.value; state.page = 1; draw(); }, 180); });
  filter.addEventListener('change', () => { state.status = filter.value; state.page = 1; draw(); });
  size.addEventListener('change', () => { state.size = tableSizes[kind] = Number(size.value); state.page = 1; draw(); });
  function draw(focusKey) {
    const source = activity && state.status ? items.filter(row => row.action === state.status) : items;
    const result = tableRows(source, { ...state, status: activity ? '' : state.status }); state.page = result.page;
    count.textContent = `${result.total} of ${items.length} ${activity ? 'events' : 'shops'}`;
    sortSelect.value = state.sort;
    direction.textContent = state.direction === 'ascending' ? 'Ascending ↑' : state.direction === 'descending' ? 'Descending ↓' : 'Unsorted';
    const table = element('table', undefined, 'data-table'), caption = element('caption', activity ? 'Platform activity' : 'Shops'); caption.className = 'sr-only'; table.append(caption);
    const head = element('thead'), header = element('tr'), body = element('tbody');
    for (const column of columns) {
      const th = element('th'); th.scope = 'col';
      if (column.key) {
        th.setAttribute('aria-sort', state.sort === column.key && state.direction ? state.direction : 'none');
        const control = button(`${column.label}${state.sort === column.key && state.direction ? state.direction === 'ascending' ? ' ↑' : ' ↓' : ''}`, () => {
          state.direction = state.sort !== column.key ? 'ascending' : state.direction === 'ascending' ? 'descending' : state.direction === 'descending' ? '' : 'ascending';
          state.sort = column.key; state.page = 1; draw(column.key);
        }); control.dataset.sort = column.key; th.append(control);
      } else th.textContent = column.label;
      header.append(th);
    }
    head.append(header); table.append(head, body);
    for (const row of result.rows) {
      const tr = element('tr');
      for (const column of columns) { const td = element('td'); td.dataset.label = column.label; const value = column.render ? column.render(row) : element('span', String(row[column.key] ?? '—')); td.append(value); tr.append(td); }
      body.append(tr);
    }
    output.replaceChildren(table);
    if (!result.total) output.append(element('p', 'No results.'), button('Reset filters', () => { search.value = ''; filter.value = ''; state.query = state.status = ''; state.page = 1; draw(); }));
    live.textContent = `Showing ${result.start}-${result.end} of ${result.total}`;
    paging.replaceChildren();
    const pageButton = (label, page, disabled = false) => { const control = button(label, () => { state.page = page; draw(); paging.querySelector(`[data-page="${label}"]`)?.focus(); }); control.disabled = disabled; control.dataset.unavailable = String(disabled); control.dataset.page = label; paging.append(control); return control; };
    pageButton('Previous', state.page - 1, state.page === 1);
    let previous = 0;
    for (let page = 1; page <= result.pages; page++) if (page === 1 || page === result.pages || Math.abs(page - state.page) <= 1) {
      if (previous && page - previous > 1) paging.append(element('span', '…'));
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
async function listShops() {
  screen('Shops'); content.append(element('p', 'Your shops, at a glance.'), button('Add shop', createShop));
  const loading = loadingRows('Loading shops…'); content.append(loading);
  try {
    const result = await api('/shops'); loading.remove();
    const urlCell = (shop, key, label) => { const row = element('div', undefined, 'table-links'); row.append(externalLink(shop[key], `Open ${label}`), button(`Copy ${label} URL`, () => copy(shop[key]))); return row; };
    dataTable(result.items, [
      { key: 'name', label: 'Name', render: shop => { const name = element('span', shop.name, 'shop-name'); name.title = shop.name; if (shop.isDefault) name.append(element('small', ' default', 'chip')); return name; } },
      { key: 'code', label: 'Code' }, { key: 'status', label: 'Status', render: shop => element('span', shop.status, `chip status-${shop.status.toLowerCase()}`) },
      { key: 'currency', label: 'Currency' }, { key: 'createdAt', label: 'Created', render: shop => element('time', shop.createdAt ? new Date(shop.createdAt).toLocaleDateString() : '—') },
      { label: 'Shop', render: shop => urlCell(shop, 'shopUrl', 'shop') }, { label: 'Seller', render: shop => urlCell(shop, 'sellerUrl', 'seller') },
      { label: 'Actions', render: shop => button('Manage', () => detail(shop.id)) }
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
async function detail(id) {
  const shop = await api(`/shops/${id}`); screen(shop.name); const data = element('dl');
  for (const [title, value] of [['Code', shop.code], ['Status', shop.status], ['Currency', shop.currency], ['Seller', shop.sellerUsername || 'Managed on host'], ['Orders', shop.orderCount ?? 'Unavailable'], ['Products', shop.productCount ?? 'Unavailable'], ['Deletion date', shop.deleteAfter || 'None']]) {
    const dd = element('dd'); dd.append(title === 'Code' && shop.shopUrl ? externalLink(shop.shopUrl, String(value)) : document.createTextNode(String(value))); data.append(element('dt', title), dd);
  }
  for (const [label, value] of [['Buyer URL', shop.shopUrl], ['Seller URL', shop.sellerUrl]]) if (value) { const dd = element('dd'); dd.append(externalLink(value), button(`Copy ${label}`, () => copy(value))); data.append(element('dt', label), dd); }
  content.append(data);
  const qrPanel = element('section', undefined, 'panel'); qrPanel.setAttribute('aria-label', 'WhatsApp QR policy'); content.append(qrPanel);
  try {
    const policy = await api(`/shops/${id}/qr`);
    qrPanel.append(element('h3', 'WhatsApp QR'));
    if (!policy) qrPanel.append(element('p', 'Unavailable: ask the host operator to upgrade the platform QR schema.'));
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
  const action = async (name, body = {}) => {
    const result = await mutateShop(shop, name, body);
    await detail(id); return result;
  };
  const resetSeller = button('Reset seller password', async () => {
    if (!await confirmModal(`A new temporary password is created for ${shop.sellerUsername}. Their open sessions and connector sign-ins end, and they must choose a new password at the next sign-in. The password is shown once.`,
      { title: 'Reset seller password?', confirmLabel: 'Reset and show password' })) return;
    await action('reset-seller-password');
  });
  if (shop.isDefault) {
    // The default shop is otherwise managed on the host; only its Owner account can be reset from here.
    if (shop.status === 'ACTIVE' && shop.sellerUsername && shop.canResetSeller !== false) content.append(element('h3', 'Seller account'), element('p', `The Owner account is ${shop.sellerUsername}. After a reset you get the sign-in details and an email you can send to the seller.`), resetSeller);
    return;
  }
  const actions = element('div', undefined, 'actions');
  if (shop.status === 'ACTIVE') actions.append(button('Suspend shop', () => action('suspend')));
  if (shop.status === 'SUSPENDED') actions.append(button('Resume shop', () => action('resume')));
  if (shop.status === 'DELETING') actions.append(button('Cancel deletion', () => action('cancel-deletion')));
  if (['ACTIVE', 'SUSPENDED'].includes(shop.status)) {
    actions.append(resetSeller);
    content.append(actions, element('h3', 'Rename shop'));
    const node = form(async (body) => action('rename', body)); field(node, 'code', 'Shop code', { value: shop.code, maxLength: 30 }); field(node, 'name', 'Shop name', { value: shop.name }); submit(node, 'Save name and code');
  } else content.append(actions);
  if (shop.status === 'SUSPENDED') {
    content.append(element('h3', 'Request deletion'), element('p', 'Data is retained for 30 days. A host operator must take a verified final backup before purging.'));
    const node = form(async (body) => action('request-deletion', body)); field(node, 'code', `Type ${shop.code} to confirm`, { maxLength: 30 }); submit(node, 'Request deletion');
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
  screen('Account'); content.append(element('p', `Signed in as ${session.username || 'SuperAdmin'}.`), element('h3', 'Change password'));
  const passwordForm = form(async (data, node) => { await api('/account/password', { method: 'POST', body: data }); node.reset(); notice.textContent = 'Password changed. Other sessions ended.'; });
  field(passwordForm, 'currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 });
  field(passwordForm, 'newPassword', 'New password', { type: 'password', autocomplete: 'new-password', maxLength: 256 }); submit(passwordForm, 'Change password');
  content.append(element('h3', 'Recovery codes'), element('p', 'Regenerating invalidates every previous recovery code.'));
  const recoveryForm = form(async (data, node) => { const result = await api('/account/recovery-codes', { method: 'POST', body: data }); node.reset(); recovery(result.recoveryCodes); });
  field(recoveryForm, 'password', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 }); submit(recoveryForm, 'Regenerate recovery codes');
  const appearance = element('section'); content.append(appearance); mountAppearance(appearance, 'seller');
}
await run(async () => {
  try { session = await api('/session'); csrf = session.csrfToken; nav(); if (session.stage === 'FULL') await listShops(); else await authenticator(); }
  catch (error) { if (error.status === 401) await signIn(); else throw error; }
});
addEventListener('pagehide', () => {
  for (const canvas of content.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
  for (const node of content.querySelectorAll('[data-secret]')) node.replaceChildren();
  secretValue.textContent = ''; document.querySelector('#secret-tools').replaceChildren();
  for (const input of document.querySelectorAll('input')) input.value = '';
});
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
