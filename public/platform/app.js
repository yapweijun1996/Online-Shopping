const content = document.querySelector('#content'), navigation = document.querySelector('#navigation');
const errorBox = document.querySelector('#error'), notice = document.querySelector('#notice');
const dialog = document.querySelector('#secret-dialog'), secretValue = document.querySelector('#secret-value');
let csrf = null, session = null, busy = false, fieldId = 0, returnFocus = null;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (label, action) => { const node = element('button', label); node.type = 'button'; node.addEventListener('click', () => run(action)); return node; };
function field(form, name, title, { type = 'text', value = '', required = true, autocomplete = 'off', maxLength = 80 } = {}) {
  const label = element('label', title), input = element('input'); input.id = `platform-field-${++fieldId}`; label.htmlFor = input.id;
  Object.assign(input, { name, type, value, required, autocomplete, maxLength }); label.append(input); form.append(label);
  if (type === 'password') {
    const toggle = button('Show password', () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? 'Show password' : 'Hide password'; toggle.setAttribute('aria-pressed', String(input.type === 'text')); });
    toggle.setAttribute('aria-controls', input.id); toggle.setAttribute('aria-pressed', 'false'); label.after(toggle);
  }
  return input;
}
function screen(title) {
  for (const canvas of content.querySelectorAll('canvas')) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); canvas.width = 0; }
  for (const node of content.querySelectorAll('[data-secret]')) node.replaceChildren();
  document.body.classList.toggle('auth', session?.stage !== 'FULL');
  document.body.classList.remove('saving-recovery');
  content.replaceChildren(element('h2', title)); notice.textContent = ''; errorBox.hidden = true; errorBox.textContent = '';
  const current = ({ 'Add shop': 'Add shop', 'Audit trail': 'Activity', Account: 'Account' })[title] || 'Shops';
  for (const node of navigation.querySelectorAll('button')) {
    if (node.textContent === current) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  }
  document.querySelector('#main').focus();
}
function form(action) {
  const node = element('form'); node.addEventListener('submit', (event) => { event.preventDefault(); if (node.reportValidity()) run(() => action(Object.fromEntries(new FormData(node)), node)); });
  content.append(node); return node;
}
function submit(node, text) { const value = element('button', text); value.type = 'submit'; node.append(value); }
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
  } finally { busy = false; content.removeAttribute('aria-busy'); for (const node of document.querySelectorAll('button')) node.disabled = node.dataset.requiresSaved === 'true' && !content.querySelector('.check-label input')?.checked; }
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
  document.body.classList.add('auth', 'saving-recovery');
  content.append(element('p', 'Shown once. Each code lets you sign in once if you lose your authenticator. Store them somewhere private, separate from your phone.', 'callout'));
  const grid = element('div', undefined, 'recovery-grid'); grid.dataset.secret = '';
  for (const code of codes) grid.append(element('code', code));
  const tools = element('div', undefined, 'actions');
  tools.append(button('Copy all', () => copy(grid.textContent ? [...grid.children].map(n => n.textContent).join('\n') : '')),
    button('Download .txt', () => download([...grid.children].map(n => n.textContent).join('\n'), 'shop-platform-recovery-codes.txt')));
  const label = element('label', undefined, 'check-label'), check = element('input'); check.type = 'checkbox'; label.append(check, document.createTextNode('I have saved these recovery codes'));
  const next = button('Continue to shops', async () => { if (!check.checked) throw new Error('Save your recovery codes and tick the checkbox first.'); grid.replaceChildren(); nav(); await listShops(); });
  next.dataset.requiresSaved = 'true';
  next.disabled = true; check.addEventListener('change', () => { next.disabled = !check.checked; });
  content.append(grid, tools, label, next); navigation.hidden = true;
}
function showSecrets(title, value) {
  returnFocus = document.activeElement; document.querySelector('#secret-title').textContent = title; secretValue.textContent = value;
  document.querySelector('#secret-notice').textContent = '';
  document.querySelector('#secret-tools').replaceChildren(button('Copy details', () => copy(secretValue.textContent)));
  dialog.showModal();
}
dialog.addEventListener('close', () => {
  secretValue.textContent = ''; document.querySelector('#secret-tools').replaceChildren();
  const target = returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : document.querySelector('#main');
  target.focus(); returnFocus = null;
});
function nav() {
  const full = session?.stage === 'FULL'; navigation.hidden = !full;
  const identity = document.querySelector('#identity'); identity.hidden = !full; identity.textContent = full ? `${session.username || 'SuperAdmin'} · Session active` : '';
  navigation.replaceChildren(button('Shops', listShops), button('Add shop', createShop), button('Activity', audit), button('Account', account),
    button('Sign out', async () => { await api('/session', { method: 'DELETE' }); session = null; csrf = null; await signIn(); }));
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
async function listShops() {
  const result = await api('/shops'); screen('Shops'); const cards = element('div', undefined, 'cards');
  content.append(element('p', 'Your shops, at a glance. Open a workspace or manage its access.'), button('Add shop', createShop));
  for (const shop of result.items) {
    const card = element('article', undefined, 'card'); const chip = element('span', shop.status, `chip status-${shop.status.toLowerCase()}`);
    card.append(chip, element('h3', shop.name), element('p', `${shop.code} · ${shop.currency}`));
    if (shop.createdAt) card.append(element('p', `Created ${new Date(shop.createdAt).toLocaleDateString()}`, 'meta'));
    for (const [label, url] of [['Shop', shop.shopUrl], ['Seller', shop.sellerUrl]]) if (url) {
      const row = element('div', undefined, 'url-row'), link = element('a', `Open ${label.toLowerCase()}`); link.href = url; link.target = '_blank'; link.rel = 'noopener';
      row.append(element('small', url), link, button(`Copy ${label.toLowerCase()} URL`, () => copy(url))); card.append(row);
    }
    if (shop.isDefault) card.append(element('p', 'Current shop · managed on the host'));
    const menu = element('details', undefined, 'shop-actions'); menu.append(element('summary', 'Shop actions'));
    menu.append(button('Manage shop', () => detail(shop.id)));
    if (!shop.isDefault) {
      const change = async action => { await mutateShop(shop, action); await listShops(); notice.textContent = 'Shop updated.'; };
      if (shop.status === 'ACTIVE') menu.append(button('Suspend shop', () => change('suspend')));
      if (shop.status === 'SUSPENDED') menu.append(button('Resume shop', () => change('resume')));
      if (['ACTIVE', 'SUSPENDED'].includes(shop.status)) menu.append(button('Reset seller password', () => change('reset-seller-password')), button('Rename shop code', () => detail(shop.id)));
    }
    card.append(menu); cards.append(card);
  }
  content.append(cards); if (!result.items.length) content.append(element('p', 'No shops yet.'));
}
async function mutateShop(shop, action, body = {}) {
  const result = await api(`/shops/${shop.id}/${action}`, { method: 'POST', body: { expectedRevision: shop.revision, ...body } });
  // Preserve one-time credentials before any subsequent query can fail.
  if (result.sellerPassword) showSecrets('Save the new seller password', `${shop.sellerUsername}\n${result.sellerPassword}`);
  return result;
}
async function createShop() {
  screen('Add shop'); content.append(element('p', 'Give your shop a home. We will create a separate workspace and a temporary password for its seller. Up to 20 shops per host.'));
  const node = form(async (data) => {
    const result = await api('/shops', { method: 'POST', body: data }); node.reset();
    showSecrets('Save the new shop details', `Buyer: ${result.shopUrl}\nSeller: ${result.sellerUrl}\nUsername: ${result.tenant.sellerUsername}\nFirst password: ${result.sellerPassword}`);
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
    data.append(element('dt', title), element('dd', String(value)));
  }
  content.append(data); if (shop.isDefault) return;
  const action = async (name, body = {}) => {
    const result = await mutateShop(shop, name, body);
    await detail(id); return result;
  };
  const actions = element('div', undefined, 'actions');
  if (shop.status === 'ACTIVE') actions.append(button('Suspend shop', () => action('suspend')));
  if (shop.status === 'SUSPENDED') actions.append(button('Resume shop', () => action('resume')));
  if (shop.status === 'DELETING') actions.append(button('Cancel deletion', () => action('cancel-deletion')));
  if (['ACTIVE', 'SUSPENDED'].includes(shop.status)) {
    actions.append(button('Reset seller password', () => action('reset-seller-password')));
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
  const result = await api(`/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); screen('Audit trail');
  const list = element('ol', undefined, 'audit-list');
  for (const item of result.items) {
    const row = element('li'), time = element('time', new Date(item.created_at).toLocaleString()); time.dateTime = item.created_at;
    row.append(time, element('strong', item.action.toLowerCase().replaceAll('_', ' ')), element('span', `${item.actor}${item.detail ? ` · ${item.detail}` : ''}`)); list.append(row);
  }
  content.append(list); if (result.nextCursor) content.append(button('Older events', () => audit(result.nextCursor)));
}
async function account() {
  screen('Account'); content.append(element('p', `Signed in as ${session.username || 'SuperAdmin'}.`), element('h3', 'Change password'));
  const passwordForm = form(async (data, node) => { await api('/account/password', { method: 'POST', body: data }); node.reset(); notice.textContent = 'Password changed. Other sessions ended.'; });
  field(passwordForm, 'currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 });
  field(passwordForm, 'newPassword', 'New password', { type: 'password', autocomplete: 'new-password', maxLength: 256 }); submit(passwordForm, 'Change password');
  content.append(element('h3', 'Recovery codes'), element('p', 'Regenerating invalidates every previous recovery code.'));
  const recoveryForm = form(async (data, node) => { const result = await api('/account/recovery-codes', { method: 'POST', body: data }); node.reset(); recovery(result.recoveryCodes); });
  field(recoveryForm, 'password', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 }); submit(recoveryForm, 'Regenerate recovery codes');
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
