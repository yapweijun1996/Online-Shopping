import './ops-copy.js';
import { formatDate, t } from '../shared/i18n.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
const ROLE_KEY = { OWNER: 'roleOwner', MANAGER: 'roleManager', STAFF: 'roleStaff' };

/* The Team page (Owner only): list the people who can sign in, add Managers and Staff, change a role, deactivate or
   reactivate, and set a new temporary password. The server enforces all of it; this page only asks. */
export function mountTeam(root, { csrfToken, onUnauthorized }) {
  root.replaceChildren();
  const identity = csrfToken();
  let active = true, data = null, messageKey = '', loadFailed = false;
  const page = node('div', 'team-page');
  root.append(page);
  const current = () => active && page.isConnected && csrfToken() === identity;

  async function call(method, path, body) {
    const response = await fetch(path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {}, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 401) { if (current()) onUnauthorized(); throw Object.assign(new Error('unauthorized'), { status: 401 }); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status, code: payload.error?.code });
    return payload;
  }

  async function load() {
    try { data = await call('GET', '/api/v1/seller/accounts'); loadFailed = false; }
    catch (error) { if (error.status === 401) return; loadFailed = true; }
    if (current()) render();
  }

  const status = node('p', 'message'); status.setAttribute('role', 'status');
  const say = (key, isError = false) => { messageKey = key; status.textContent = key ? t(key) : ''; status.classList.toggle('is-error', isError); };

  function addForm() {
    const form = node('form', 'settings-card team-add');
    form.append(node('h2', '', t('teamAdd')));
    const field = (labelKey, control) => { const label = node('label'); label.append(node('span', '', t(labelKey)), control); return label; };
    const name = node('input'); name.required = true; name.maxLength = 64; name.autocomplete = 'off'; name.spellcheck = false;
    const role = node('select');
    for (const value of ['MANAGER', 'STAFF']) { const option = node('option', '', t(ROLE_KEY[value])); option.value = value; role.append(option); }
    role.value = 'STAFF';
    const password = node('input'); password.type = 'password'; password.required = true; password.minLength = 12; password.maxLength = 256; password.autocomplete = 'new-password';
    const submit = node('button', 'primary-button', t('teamCreate')); submit.type = 'submit';
    form.append(field('username', name), field('role', role), field('teamTempPassword', password), node('p', 'shop-note', t('teamTempHelp')), submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true; say('');
      try {
        await call('POST', '/api/v1/seller/accounts', { username: name.value.trim(), role: role.value, password: password.value });
        if (!current()) return;
        name.value = ''; password.value = ''; say('teamCreated');
        await load();
      } catch (error) { if (error.status !== 401 && current()) say(error.code === 'USERNAME_TAKEN' ? 'teamUsernameTaken' : error.status === 400 ? 'teamInvalid' : 'teamSaveError', true); }
      if (submit.isConnected) submit.disabled = false;
    });
    return form;
  }

  function row(account) {
    const li = node('li', `team-row${account.active ? '' : ' is-inactive'}`);
    const who = node('div', 'team-who');
    who.append(node('strong', '', account.username),
      node('span', 'team-meta', `${t(ROLE_KEY[account.role])} · ${t(account.active ? 'teamActive' : 'teamInactive')}${account.mustChangePassword ? ` · ${t('teamMustChange')}` : ''}`),
      node('span', 'team-meta', `${t('teamLastSignIn')}: ${account.lastLoginAt ? formatDate(account.lastLoginAt) : t('teamNever')}`));
    li.append(who);
    if (account.role === 'OWNER') return li;
    const controls = node('div', 'team-controls');
    const role = node('select'); role.setAttribute('aria-label', `${t('role')}: ${account.username}`);
    for (const value of ['MANAGER', 'STAFF']) { const option = node('option', '', t(ROLE_KEY[value])); option.value = value; role.append(option); }
    role.value = account.role;
    const act = (body, doneKey, control) => async () => {
      control.disabled = true; say('');
      try { await call('PATCH', `/api/v1/seller/accounts/${account.id}`, body); if (!current()) return; say(doneKey); await load(); }
      catch (error) { if (error.status !== 401 && current()) say(error.status === 400 ? 'teamInvalid' : 'teamSaveError', true); if (control.isConnected) control.disabled = false; }
    };
    role.addEventListener('change', () => act({ role: role.value }, '', role)());
    const toggle = node('button', 'secondary-button', t(account.active ? 'teamDeactivate' : 'teamActivate')); toggle.type = 'button';
    toggle.addEventListener('click', () => act({ active: !account.active }, '', toggle)());
    const reset = node('button', 'text-button', t('teamResetPassword')); reset.type = 'button';
    const resetForm = node('form', 'team-reset'); resetForm.hidden = true;
    const temp = node('input'); temp.type = 'password'; temp.required = true; temp.minLength = 12; temp.maxLength = 256; temp.autocomplete = 'new-password';
    temp.setAttribute('aria-label', `${t('teamTempPassword')}: ${account.username}`);
    const save = node('button', 'primary-button', t('passwordSave')); save.type = 'submit';
    resetForm.append(temp, save);
    reset.addEventListener('click', () => { resetForm.hidden = !resetForm.hidden; if (!resetForm.hidden) temp.focus(); });
    resetForm.addEventListener('submit', (event) => { event.preventDefault(); act({ resetPassword: temp.value }, 'teamResetDone', save)(); });
    controls.append(role, toggle, reset);
    li.append(controls, resetForm);
    return li;
  }

  function render() {
    page.replaceChildren();
    page.append(node('p', 'audit-intro', t('teamIntro')));
    if (loadFailed) {
      const retry = node('button', 'secondary-button', t('retry')); retry.type = 'button'; retry.addEventListener('click', load);
      page.append(node('p', 'dashboard-error', t('teamLoadError')), retry);
      return;
    }
    page.append(addForm(), status);
    say(messageKey);
    const list = node('ul', 'team-list');
    for (const account of data.items) list.append(row(account));
    const section = node('section', 'settings-card'); section.append(list);
    page.append(section);
    if (data.events.length) {
      const activity = node('section', 'settings-card');
      activity.append(node('h2', '', t('teamActivity')));
      const events = node('ul', 'team-events');
      for (const event of data.events) events.append(node('li', '', `${formatDate(event.at)} · ${event.actor} → ${event.account}: ${t(`event${event.action}`)}`));
      activity.append(events);
      page.append(activity);
    }
  }

  load();
  return { refreshLocale() { if (data || loadFailed) render(); }, dispose() { active = false; }, hasUnsavedChanges: () => false, isBusy: () => false };
}
