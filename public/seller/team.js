import { apiUrl } from '../shared/base-path.js';
import './ops-copy.js';
import './team-copy.js';
import { icon } from '../shared/icons.js';
import { formatDate, t, translate } from '../shared/i18n.js';
import { confirmModal, createModal } from '../shared/modal.js';
import { beginMutation } from '../shared/update-guard.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
const EVENT_KEYS = new Set(['CREATED', 'ROLE_CHANGED', 'DEACTIVATED', 'ACTIVATED', 'PASSWORD_RESET', 'PASSWORD_CHANGED']);
const ROLE_KEY = { OWNER: 'roleOwner', MANAGER: 'roleManager', STAFF: 'roleStaff' };
const text = (key, values = {}) => t(key).replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
const control = (label, action, className = 'secondary-button') => { const button = node('button', className, t(label)); button.type = 'button'; button.dataset.i18n = label; button.addEventListener('click', action); return button; };

// The server remains authoritative for account roles, credential validation and revocation.
export function mountTeam(root, { csrfToken, onUnauthorized, headingHost = null }) {
  root.replaceChildren();
  const identity = csrfToken();
  const confirmations = new AbortController();
  let active = true, data = null, loading = false, loadFailed = false, sequence = 0, busy = false;
  let messageKey = '', messageName = '', errorMessage = false, changedId = null, drawer = null, draftRevision = 0;
  const page = node('div', 'team-page'); root.append(page);
  const current = () => active && page.isConnected && root.contains(page) && csrfToken() === identity;
  const updateGuard = () => document.dispatchEvent(new Event('updateguardchange'));
  const heading = node('div', 'team-heading');
  const intro = node('p', 'team-intro', t('teamUI_intro')); intro.dataset.i18n = 'teamUI_intro';
  const add = control('teamCreate', () => openEditor('add'), 'primary-button'); add.id = 'team-add-person';
  const headingActions = node('div', 'ui-page-heading-actions');
  if (headingHost) { headingHost.classList.add('ui-page-heading'); intro.classList.add('ui-page-heading-description'); headingActions.append(add); headingHost.append(intro, headingActions); }
  else heading.append(intro, add);
  const filters = node('div', 'team-filters');
  const field = (key, input, helpKey = '') => {
    const label = node('label'); const caption = node('span', '', t(key)); caption.dataset.i18n = key; label.append(caption, input);
    if (helpKey) { const help = node('small', 'team-field-help', t(helpKey)); help.dataset.i18n = helpKey; help.id = `${input.id}-help`; input.setAttribute('aria-describedby', help.id); label.append(help); }
    return label;
  };
  const search = node('input'); search.id = 'team-search'; search.type = 'search'; search.maxLength = 64; search.placeholder = t('teamUI_searchPlaceholder');
  const roleFilter = node('select'); roleFilter.id = 'team-filter-role';
  const statusFilter = node('select'); statusFilter.id = 'team-filter-status';
  const option = (select, value, key) => { const item = node('option', '', t(key)); item.value = value; item.dataset.i18n = key; select.append(item); };
  option(roleFilter, '', 'teamUI_allRoles'); for (const role of ['OWNER', 'MANAGER', 'STAFF']) option(roleFilter, role, ROLE_KEY[role]);
  option(statusFilter, '', 'teamUI_allStatus'); option(statusFilter, 'active', 'teamActive'); option(statusFilter, 'inactive', 'teamInactive');
  const clear = control('clearFilters', () => { search.value = ''; roleFilter.value = ''; statusFilter.value = ''; renderRows(); search.focus(); }); clear.id = 'team-clear-filters';
  filters.append(field('teamUI_search', search), field('role', roleFilter), field('orderStatus', statusFilter), clear);
  const message = node('p', 'team-feedback'); message.id = 'team-feedback'; message.setAttribute('role', 'status'); message.tabIndex = -1;
  const recovery = node('div', 'team-recovery');
  const loadMessage = node('p', '', t('loading')); loadMessage.setAttribute('role', 'status');
  const retry = control('retry', () => load()); retry.id = 'team-retry'; recovery.append(loadMessage, retry);
  const result = node('p', 'team-result-count'); result.setAttribute('role', 'status');
  const listContainer = node('section', 'team-list-container'); listContainer.setAttribute('aria-label', t('teamUI_members'));
  const table = node('table', 'team-table'); const caption = node('caption', 'sr-only', t('teamUI_members')); const head = node('thead'); const headRow = node('tr');
  const columns = ['username', 'role', 'orderStatus', 'teamLastSignIn', 'actions'];
  for (const key of columns) { const cell = node('th', '', t(key)); cell.scope = 'col'; cell.dataset.i18n = key; headRow.append(cell); }
  head.append(headRow); const rows = node('tbody'); table.append(caption, head, rows);
  const empty = node('div', 'team-empty'); const emptyText = node('p'); const emptyClear = control('clearFilters', () => clear.click()); empty.append(emptyText, emptyClear); listContainer.append(table, empty);
  const activity = node('details', 'team-activity'); const activityTitle = node('summary');
  const activityLabel = node('span', '', t('teamActivity')); activityLabel.dataset.i18n = 'teamActivity';
  const activityCount = node('span', 'team-activity-count'); const activityLatest = node('time', 'team-activity-latest');
  activityTitle.append(icon('chevronDown'), activityLabel, activityCount, activityLatest);
  const activityTable = node('table', 'team-activity-table'); const activityHead = node('thead'); const activityHeading = node('tr');
  const activityColumns = ['teamUI_time', 'teamUI_actor', 'teamUI_member', 'teamUI_action'];
  for (const key of activityColumns) { const cell = node('th', '', t(key)); cell.scope = 'col'; cell.dataset.i18n = key; activityHeading.append(cell); }
  activityHead.append(activityHeading); const activityCaption = node('caption', 'sr-only', t('teamActivity')); activityCaption.dataset.i18n = 'teamActivity';
  const events = node('tbody'); activityTable.append(activityCaption, activityHead, events);
  const activityEmpty = node('p', 'team-activity-empty', t('teamUI_noActivity')); activityEmpty.dataset.i18n = 'teamUI_noActivity';
  activity.append(activityTitle, activityTable, activityEmpty);
  page.append(...(headingHost ? [] : [heading]), filters, message, recovery, result, listContainer, activity);
  const matches = account => (!search.value.trim() || account.username.toLowerCase().includes(search.value.trim().toLowerCase())) && (!roleFilter.value || account.role === roleFilter.value) && (!statusFilter.value || account.active === (statusFilter.value === 'active'));
  const filtered = () => Boolean(search.value.trim() || roleFilter.value || statusFilter.value);

  function say(key, name = '', isError = false) { messageKey = key; messageName = name; errorMessage = isError; renderFeedback(); }
  function renderFeedback() {
    message.textContent = messageKey ? text(messageKey, { name: messageName }) : '';
    message.classList.toggle('is-error', errorMessage); message.hidden = !messageKey;
    loadMessage.textContent = loading ? t('loading') : loadFailed ? t(data ? 'teamUI_stale' : 'teamLoadError') : '';
    retry.hidden = !loadFailed || loading; recovery.hidden = !loading && !loadFailed;
    page.setAttribute('aria-busy', String(loading)); add.disabled = busy || !data;
    for (const button of rows.querySelectorAll('button')) button.disabled = busy;
  }
  async function call(method, path, body) {
    const finish = method === 'GET' ? () => {} : beginMutation();
    try {
      const response = await fetch(path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {}, body: body ? JSON.stringify(body) : undefined });
      if (response.status === 401) { if (current()) onUnauthorized(); throw Object.assign(new Error('unauthorized'), { status: 401 }); }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('failed'), { status: response.status, code: payload.error?.code, field: payload.error?.field });
      return payload;
    } finally { finish(); }
  }
  async function load() {
    const request = ++sequence; loading = true; renderFeedback();
    try {
      const result = await call('GET', apiUrl('v1/seller/accounts'));
      if (!current() || request !== sequence) return false;
      data = result; loadFailed = false; renderRows(); return true;
    } catch (error) { if (current() && request === sequence && error.status !== 401) loadFailed = true; return false; }
    finally { if (current() && request === sequence) { loading = false; renderFeedback(); } }
  }
  function focusMember(id) {
    if (!current()) return;
    const target = [...rows.children].find(row => row.dataset.accountId === id)?.querySelector('.team-username');
    (target || message).focus({ preventScroll: true });
  }
  function renderRows() {
    rows.replaceChildren(); const shown = (data?.items || []).filter(matches);
    for (const account of shown) {
      const row = node('tr', account.id === changedId ? 'team-member is-updated' : 'team-member'); row.dataset.accountId = account.id;
      const cells = columns.map(key => { const cell = node('td'); cell.dataset.label = t(key); row.append(cell); return cell; });
      const name = node('strong', 'team-username', account.username); name.tabIndex = -1; cells[0].append(name);
      if (account.mustChangePassword) cells[0].append(node('small', 'team-subtext', t('teamMustChange')));
      if (account.id === changedId) cells[0].append(node('small', 'team-updated-label', t('teamUI_updated')));
      cells[1].append(node('span', 'team-role', t(ROLE_KEY[account.role])));
      cells[2].append(node('span', `team-status${account.active ? '' : ' is-inactive'}`, t(account.active ? 'teamActive' : 'teamInactive')));
      cells[3].textContent = account.lastLoginAt ? formatDate(account.lastLoginAt) : t('teamUI_never');
      if (account.role === 'OWNER') {
        const help = node('details', 'team-owner-help'); const summary = node('summary');
        summary.append(node('span', 'team-owner-protected', t('teamUI_ownerProtected')), icon('info'));
        const guidance = node('p', 'team-owner-guidance', text('teamUI_ownerGuidance', { account: t('account'), profile: t('profile'), changePassword: t('changePassword') }));
        help.addEventListener('keydown', event => { if (event.key === 'Escape' && help.open) { event.stopPropagation(); help.open = false; summary.focus(); } });
        help.append(summary, guidance); cells[4].append(help);
      }
      else {
        const menu = node('details', 'team-more'); const summary = node('summary'); summary.setAttribute('aria-label', `${t('teamUI_more')}: ${account.username}`); summary.append(icon('more'));
        const actions = node('div', 'team-menu-actions');
        for (const [mode, key] of [['role', 'teamUI_changeRole'], ['reset', 'teamResetPassword'], ['active', account.active ? 'teamDeactivate' : 'teamActivate']]) {
          const button = control(key, () => { if (busy) return; menu.open = false; summary.focus(); if (mode === 'active') toggle(account); else openEditor(mode, account); }); button.dataset.teamAction = mode; actions.append(button);
        }
        summary.addEventListener('click', () => { for (const other of rows.querySelectorAll('details[open]')) if (other !== menu) other.open = false; });
        menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; summary.focus(); } }); menu.append(summary, actions); cells[4].append(menu);
      }
      rows.append(row);
    }
    table.hidden = !shown.length; empty.hidden = Boolean(shown.length) || !data;
    emptyText.textContent = t(filtered() ? 'teamUI_noMatches' : 'teamUI_noMembers'); emptyClear.hidden = !filtered();
    result.textContent = data ? text(filtered() ? 'teamUI_count' : 'teamUI_countDefault', { count: shown.length, total: data.items.length }) : ''; clear.hidden = !filtered();
    events.replaceChildren();
    for (const event of data?.events || []) {
      const row = node('tr');
      const values = [formatDate(event.at), event.actor, event.account, t(EVENT_KEYS.has(event.action) ? `event${event.action}` : 'teamUI_accountUpdated')];
      for (const [index, value] of values.entries()) { const cell = node('td', '', value); cell.dataset.label = t(activityColumns[index]); row.append(cell); }
      events.append(row);
    }
    const recent = data?.events || [];
    activityCount.textContent = text('teamUI_recentEvents', { count: recent.length });
    const latest = recent.map(event => event.at).filter(at => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    activityLatest.textContent = latest ? text('teamUI_latestActivity', { time: formatDate(latest) }) : '';
    activityLatest.dateTime = latest || ''; activityLatest.hidden = !latest; activityEmpty.hidden = recent.length > 0; activityTable.hidden = recent.length === 0;
    activity.hidden = !data;
    renderFeedback();
  }
  search.addEventListener('input', renderRows); roleFilter.addEventListener('change', renderRows); statusFilter.addEventListener('change', renderRows);

  async function mutate(account, body, done) {
    if (!current() || busy) return false;
    busy = true; updateGuard(); renderFeedback(); drawer?.refreshBusy();
    try {
      const result = await call(account ? 'PATCH' : 'POST', apiUrl(account ? `v1/seller/accounts/${account.id}` : 'v1/seller/accounts'), body);
      if (!current()) return false;
      changedId = result.id; say(done, result.username);
      // Credentials stay in the open input only until the successful response.
      if (drawer) { const editing = drawer; editing.clearSensitive(); editing.saved = true; editing.modal.close(); await editing.closed; }
      if (!current()) return false;
      const refreshed = await load();
      if (current() && refreshed) {
        if (!matches(result)) say('teamUI_hiddenSuccess', result.username);
        focusMember(result.id);
      }
      return true;
    } catch (error) {
      if (error.status !== 401 && current()) {
        const key = error.code === 'USERNAME_TAKEN' ? 'teamUsernameTaken' : error.status === 400 ? 'teamInvalid' : 'teamSaveError';
        if (drawer) drawer.fail(key, error.field); else say(key, account?.username || '', true);
      }
      return false;
    } finally { busy = false; if (current()) { updateGuard(); renderFeedback(); drawer?.refreshBusy(); } }
  }
  async function toggle(account) {
    if (busy || !current()) return;
    const key = account.active ? 'teamUI_deactivateImpact' : 'teamUI_reactivateImpact';
    if (!await confirmModal(text(key, { name: account.username }), { title: t(account.active ? 'teamDeactivate' : 'teamActivate'), confirmLabel: t(account.active ? 'teamDeactivate' : 'teamActivate'), signal: confirmations.signal })) return;
    if (!current()) return;
    await mutate(account, { active: !account.active }, 'teamUI_saved');
  }
  function openEditor(mode, account = null) {
    if (!current() || busy || drawer || account?.role === 'OWNER') return;
    const modal = createModal('team-drawer'); const dialog = modal.content.parentElement; dialog.dataset.teamMode = mode;
    const form = node('form', 'team-editor'); form.noValidate = true;
    const name = node('input'); name.id = 'team-person-username'; name.name = 'username'; name.autocomplete = 'off'; name.spellcheck = false; name.required = true; name.minLength = 3; name.maxLength = 64; name.pattern = '[A-Za-z0-9][A-Za-z0-9._-]{2,63}';
    const role = node('select'); role.id = 'team-person-role'; role.name = 'role'; for (const value of ['MANAGER', 'STAFF']) option(role, value, ROLE_KEY[value]); role.value = account?.role || 'STAFF';
    const password = node('input'); password.id = 'team-person-password'; password.name = 'password'; password.dataset.privateDraft = 'true'; password.dataset.privateDraftRevision = '0'; password.type = 'password'; password.required = true; password.minLength = 12; password.maxLength = 256; password.autocomplete = 'new-password';
    const reveal = control('teamUI_show', () => { password.type = password.type === 'password' ? 'text' : 'password'; refresh(); }); reveal.className = 'text-button team-show-password'; reveal.setAttribute('aria-controls', password.id);
    const passwordField = field('teamTempPassword', password, 'teamUI_passwordHelp'); passwordField.append(reveal);
    const roleHelp = node('p', 'team-role-help');
    const impact = node('p', 'team-impact');
    const error = node('p', 'team-editor-error'); error.id = 'team-editor-error'; error.tabIndex = -1; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = node('div', 'team-editor-actions'); const cancel = control('cancel', requestClose); const submit = node('button', 'primary-button'); submit.type = 'submit'; actions.append(cancel, submit);
    if (mode === 'add') form.append(field('username', name, 'teamUI_usernameHelp'));
    else form.append(node('p', 'team-editor-identity', account.username));
    if (mode !== 'reset') form.append(field('role', role), roleHelp);
    if (mode !== 'role') form.append(passwordField);
    form.append(impact, error, actions); modal.content.append(form);
    let dirty = false, saved = false, errorKey = '', closePending = false, resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const titleKey = mode === 'add' ? 'teamAdd' : mode === 'role' ? 'teamUI_changeRole' : 'teamResetPassword';
    function refresh() {
      translate(form); modal.setTitle(t(titleKey)); submit.textContent = t(mode === 'add' ? 'teamCreate' : mode === 'reset' ? 'teamUI_reset' : 'passwordSave');
      reveal.textContent = t(password.type === 'password' ? 'teamUI_show' : 'teamUI_hide'); reveal.setAttribute('aria-pressed', String(password.type === 'text'));
      roleHelp.textContent = t(role.value === 'MANAGER' ? 'teamUI_managerHelp' : 'teamUI_staffHelp');
      impact.textContent = t(mode === 'reset' ? 'teamUI_resetImpact' : mode === 'role' ? 'teamUI_roleImpact' : 'teamTempHelp');
      error.textContent = errorKey ? t(errorKey) : ''; refreshBusy();
    }
    function refreshBusy() { for (const input of form.querySelectorAll('input,select,button')) input.disabled = busy; dialog.querySelector('.modal-close').disabled = busy; form.setAttribute('aria-busy', String(busy)); }
    function fail(key, invalidField) { const invalid = invalidField === 'username' ? name : invalidField?.includes('assword') ? password : null; if (invalid) invalid.setAttribute('aria-describedby', `${invalid.id}-help ${error.id}`); errorKey = key; error.textContent = t(key); error.hidden = false; if (invalidField === 'username') name.setAttribute('aria-invalid', 'true'); if (invalidField?.includes('assword')) password.setAttribute('aria-invalid', 'true'); (invalidField === 'username' ? name : invalidField?.includes('assword') ? password : error).focus(); }
    async function requestClose() {
      if (busy || closePending) return;
      closePending = true;
      if (!dirty || await confirmModal(t('unsavedChangesConfirm'), { title: t('cancelEdit'), confirmLabel: t('cancelEdit'), signal: confirmations.signal })) { if (current()) modal.close(); }
      closePending = false;
    }
    // Route every close surface through the same draft guard, reusing the shared modal focus trap.
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopImmediatePropagation(); requestClose(); }, true);
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      const outside = event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      if (event.target.closest?.('.modal-close') || outside) { event.preventDefault(); event.stopImmediatePropagation(); requestClose(); }
    }, true);
    form.addEventListener('input', () => { errorKey = ''; error.hidden = true; dirty = true; draftRevision++; password.dataset.privateDraftRevision = String(draftRevision); name.removeAttribute('aria-invalid'); password.removeAttribute('aria-invalid'); updateGuard(); });
    role.addEventListener('change', () => { dirty = true; draftRevision++; refresh(); updateGuard(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !current()) return;
      const username = mode === 'add' ? name.value.trim() : account.username;
      if (mode === 'add' && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) { fail('teamUI_usernameHelp', 'username'); return; }
      if (mode !== 'role' && (password.value.length < 12 || password.value.length > 256 || password.value.toLowerCase().includes(username.toLowerCase()) || /^(.)\1+$/.test(password.value))) { fail('teamUI_passwordHelp', 'password'); return; }
      if (mode === 'role' && role.value === account.role) { fail('teamUI_chooseDifferentRole'); return; }
      await mutate(account, mode === 'add' ? { username, role: role.value, password: password.value } : mode === 'role' ? { role: role.value } : { resetPassword: password.value }, mode === 'reset' ? 'teamResetDone' : mode === 'add' ? 'teamUI_created' : 'teamUI_saved');
    });
    drawer = { modal, dialog, closed, resolveClosed, refresh, refreshBusy, fail, get dirty() { return dirty && !saved; }, set saved(value) { saved = value; }, clearSensitive() { password.value = ''; password.type = 'password'; } };
    refresh(); modal.open(t(titleKey), () => { resolveClosed(); password.value = ''; dialog.remove(); if (drawer?.dialog === dialog) drawer = null; updateGuard(); });
    (mode === 'add' ? name : mode === 'role' ? role : password).focus();
  }
  renderRows();
  load();
  return {
    refreshLocale() { search.placeholder = t('teamUI_searchPlaceholder'); translate(page); if (headingHost) translate(headingHost); caption.textContent = t('teamUI_members'); listContainer.setAttribute('aria-label', t('teamUI_members')); renderRows(); drawer?.refresh(); },
    dispose() { active = false; if (headingHost) { headingHost.classList.remove('ui-page-heading'); intro.remove(); headingActions.remove(); } confirmations.abort(); sequence++; if (drawer) { drawer.clearSensitive(); drawer.resolveClosed(); drawer.dialog.close(); drawer.dialog.remove(); drawer = null; } },
    hasUnsavedChanges: () => Boolean(drawer?.dirty), isBusy: () => busy,
    // Monotonic edit identity protects update/navigation guards without serializing credentials.
    draftSignature: () => `${drawer?.dialog.dataset.teamMode || 'closed'}:${draftRevision}`,
  };
}
