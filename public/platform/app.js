const content = document.querySelector('#content'), navigation = document.querySelector('#navigation');
const errorBox = document.querySelector('#error'), notice = document.querySelector('#notice');
const dialog = document.querySelector('#secret-dialog'), secretValue = document.querySelector('#secret-value');
let csrf = null, session = null, busy = false, fieldId = 0, returnFocus = null;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (label, action) => { const node = element('button', label); node.type = 'button'; node.addEventListener('click', () => run(action)); return node; };
function field(form, name, title, { type = 'text', value = '', required = true, autocomplete = 'off', maxLength = 80 } = {}) {
  const label = element('label', title), input = element('input'); input.id = `platform-field-${++fieldId}`; label.htmlFor = input.id;
  Object.assign(input, { name, type, value, required, autocomplete, maxLength }); label.append(input); form.append(label); return input;
}
function screen(title) {
  content.replaceChildren(element('h2', title)); notice.textContent = ''; errorBox.hidden = true; errorBox.textContent = '';
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
  } finally { busy = false; content.removeAttribute('aria-busy'); for (const node of document.querySelectorAll('button')) node.disabled = false; }
}
function showSecrets(title, value) {
  returnFocus = document.activeElement; document.querySelector('#secret-title').textContent = title; secretValue.textContent = value; dialog.showModal();
}
dialog.addEventListener('close', () => { secretValue.textContent = ''; returnFocus?.isConnected && returnFocus.focus(); returnFocus = null; });
function nav() {
  const full = session?.stage === 'FULL'; navigation.hidden = !full;
  navigation.replaceChildren(button('Shops', listShops), button('Create shop', createShop), button('Audit', audit), button('Account', account),
    button('Sign out', async () => { await api('/session', { method: 'DELETE' }); session = null; csrf = null; await signIn(); }));
}
async function signIn() {
  session = null; nav(); screen('Sign in');
  const challenge = await api('/csrf'); csrf = challenge.csrfToken;
  const node = form(async (data) => {
    const result = await api('/session', { method: 'POST', body: data }); node.reset(); session = result; csrf = result.csrfToken; await authenticator();
  });
  field(node, 'username', 'SuperAdmin username', { autocomplete: 'username', maxLength: 64 });
  field(node, 'password', 'Password', { type: 'password', autocomplete: 'current-password', maxLength: 256 }); submit(node, 'Continue');
}
async function authenticator() {
  screen(session.totpEnabled ? 'Confirm authenticator' : 'Set up authenticator'); nav();
  if (!session.totpEnabled) {
    const setup = await api('/totp/enrol', { method: 'POST', body: {} });
    content.append(element('p', `Add an account to your authenticator. Issuer: ${setup.issuer}. Account: ${setup.account}.`));
    content.append(element('p', setup.setupKey.match(/.{1,4}/g).join(' '), 'setup-key'));
    const link = element('a', 'Open in authenticator'); link.href = setup.uri; content.append(link);
  }
  const node = form(async (data) => {
    const result = await api('/totp/confirm', { method: 'POST', body: data }); node.reset(); csrf = result.csrfToken; session = { ...result, totpEnabled: true }; nav();
    await listShops(); if (result.recoveryCodes) showSecrets('Save your recovery codes', result.recoveryCodes.join('\n'));
  });
  const input = field(node, 'code', 'Six-digit authenticator code', { autocomplete: 'one-time-code', maxLength: 6, required: !session.totpEnabled }); input.inputMode = 'numeric'; input.pattern = '[0-9]{6}';
  if (session.totpEnabled) field(node, 'recoveryCode', 'Or a recovery code', { required: false, maxLength: 11 });
  submit(node, 'Confirm');
}
async function listShops() {
  const result = await api('/shops'); screen('Shops'); const cards = element('div', undefined, 'cards');
  for (const shop of result.items) {
    const card = element('article', undefined, 'card'); card.append(element('h3', shop.name), element('p', `${shop.code} · ${shop.currency} · ${shop.status}`));
    if (shop.isDefault) card.append(element('p', 'Current shop · managed on the host'));
    card.append(button('View shop', () => detail(shop.id))); cards.append(card);
  }
  content.append(cards); if (!result.items.length) content.append(element('p', 'No shops yet.'));
}
async function createShop() {
  screen('Create shop'); content.append(element('p', 'The seller starts as Owner and must replace the first password. This host supports 20 shops including the current shop.'));
  const node = form(async (data) => {
    const result = await api('/shops', { method: 'POST', body: data }); node.reset();
    showSecrets('Save the new shop details', `Buyer: ${result.shopUrl}\nSeller: ${result.sellerUrl}\nUsername: ${result.tenant.sellerUsername}\nFirst password: ${result.sellerPassword}`);
    await detail(result.tenant.id);
  });
  const code = field(node, 'code', 'Shop code', { maxLength: 30 }); code.pattern = '[a-z0-9]{3,30}';
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
    const result = await api(`/shops/${id}/${name}`, { method: 'POST', body: { expectedRevision: shop.revision, ...body } });
    // Preserve the only copy of a returned password even if the next detail query fails.
    if (result.sellerPassword) showSecrets('Save the new seller password', `${shop.sellerUsername}\n${result.sellerPassword}`);
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
  for (const item of result.items) list.append(element('li', `${item.created_at} · ${item.actor} · ${item.action}${item.detail ? ` · ${item.detail}` : ''}`));
  content.append(list); if (result.nextCursor) content.append(button('Older events', () => audit(result.nextCursor)));
}
async function account() {
  screen('Account'); content.append(element('p', `Signed in as ${session.username || 'SuperAdmin'}.`), element('h3', 'Change password'));
  const passwordForm = form(async (data, node) => { await api('/account/password', { method: 'POST', body: data }); node.reset(); notice.textContent = 'Password changed. Other sessions ended.'; });
  field(passwordForm, 'currentPassword', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 });
  field(passwordForm, 'newPassword', 'New password', { type: 'password', autocomplete: 'new-password', maxLength: 256 }); submit(passwordForm, 'Change password');
  content.append(element('h3', 'Recovery codes'), element('p', 'Regenerating invalidates every previous recovery code.'));
  const recoveryForm = form(async (data, node) => { const result = await api('/account/recovery-codes', { method: 'POST', body: data }); node.reset(); showSecrets('Save your new recovery codes', result.recoveryCodes.join('\n')); });
  field(recoveryForm, 'password', 'Current password', { type: 'password', autocomplete: 'current-password', maxLength: 256 }); submit(recoveryForm, 'Regenerate recovery codes');
}
await run(async () => {
  try { session = await api('/session'); csrf = session.csrfToken; nav(); if (session.stage === 'FULL') await listShops(); else await authenticator(); }
  catch (error) { if (error.status === 401) await signIn(); else throw error; }
});
