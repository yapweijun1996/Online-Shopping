import { apiUrl } from '../shared/base-path.js';
import './ops-copy.js';
import './team-copy.js';
import { icon } from '../shared/icons.js';
import { formatDate, t, translate } from '../shared/i18n.js';
import { confirmModal, createModal } from '../shared/modal.js';
import { generateTemporaryPassword, sellerLoginUrl, validTemporaryPassword } from './team-password.js';
import { beginMutation } from '../shared/update-guard.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
const EVENT_KEYS = new Set(['CREATED', 'ROLE_CHANGED', 'DEACTIVATED', 'ACTIVATED', 'PASSWORD_RESET', 'PASSWORD_CHANGED']);
const ROLE_KEY = { OWNER: 'roleOwner', MANAGER: 'roleManager', STAFF: 'roleStaff' };
const text = (key, values = {}) => t(key).replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
const control = (label, action, className = 'secondary-button') => { const button = node('button', className, t(label)); button.type = 'button'; button.dataset.i18n = label; button.addEventListener('click', action); return button; };

// The server remains authoritative for account roles, credential validation and revocation.
export function mountTeam(root, { csrfToken, onUnauthorized, headingHost = null, getShopName = () => '' }) {
  root.replaceChildren();
  const identity = csrfToken();
  const confirmations = new AbortController();
  let active = true, data = null, loading = false, loadFailed = false, sequence = 0, busy = false, mutationSequence = 0;
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
    const mutation = ++mutationSequence, editing = drawer;
    busy = true; updateGuard(); renderFeedback(); editing?.refreshBusy();
    try {
      const result = await call(account ? 'PATCH' : 'POST', apiUrl(account ? `v1/seller/accounts/${account.id}` : 'v1/seller/accounts'), body);
      if (!current()) return false;
      changedId = result.id; say(done, result.username);
      // Only an actual successful response can create a one-time credential handoff.
      if (editing && drawer === editing) {
        editing.saved = true;
        const hasHandoff = editing.complete(result, body.password ?? body.resetPassword);
        delete body.password; delete body.resetPassword;
        if (hasHandoff) { busy = false; updateGuard(); renderFeedback(); editing.refreshBusy(); }
        else { editing.clearSensitive(); editing.modal.close(); await editing.closed; }
      }
      if (!current()) return false;
      const refreshed = await load();
      if (current() && refreshed && mutation === mutationSequence) {
        if (!matches(result)) say('teamUI_hiddenSuccess', result.username);
        if (!drawer) focusMember(result.id);
      }
      return true;
    } catch (error) {
      if (error.status !== 401 && current()) {
        const key = error.code === 'USERNAME_TAKEN' ? 'teamUsernameTaken' : error.status === 400 ? 'teamInvalid' : 'teamSaveError';
        if (editing && drawer === editing) editing.fail(key, error.field); else say(key, account?.username || '', true);
      }
      return false;
    } finally {
      delete body.password; delete body.resetPassword;
      if (mutation === mutationSequence) { busy = false; if (current()) { updateGuard(); renderFeedback(); drawer?.refreshBusy(); } }
    }
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
    let dirty = false, saved = false, errorKey = '', closePending = false, resolveClosed, handoff = null, disposed = false;
    let copyPending = false, copySequence = 0, copyKey = '', handoffCopyKey = '', pendingCopy = null;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const belongs = () => !disposed && current() && drawer?.dialog === dialog && dialog.isConnected;
    const form = node('form', 'team-editor'); form.noValidate = true;
    const name = node('input'); name.id = 'team-person-username'; name.name = 'username'; name.autocomplete = 'off'; name.spellcheck = false; name.required = true; name.minLength = 3; name.maxLength = 64; name.pattern = '[A-Za-z0-9][A-Za-z0-9._-]{2,63}';
    const role = node('select'); role.id = 'team-person-role'; role.name = 'role'; for (const value of ['MANAGER', 'STAFF']) option(role, value, ROLE_KEY[value]); role.value = account?.role || 'STAFF';
    const password = node('input'); password.id = 'team-person-password'; password.name = 'password'; password.dataset.privateDraft = 'true'; password.dataset.privateDraftRevision = '0'; password.type = 'password'; password.required = true; password.minLength = 12; password.maxLength = 256; password.autocomplete = 'new-password';
    const reveal = control('teamUI_show', () => { password.type = password.type === 'password' ? 'text' : 'password'; refresh(); }); reveal.className = 'text-button team-show-password'; reveal.setAttribute('aria-controls', password.id);
    const copyPassword = control('teamPW_copyPassword', () => copyText(password.value, false)); copyPassword.className = 'text-button team-copy-password'; copyPassword.removeAttribute('data-i18n'); copyPassword.replaceChildren(icon('copy'));
    const passwordField = field('teamTempPassword', password, 'teamUI_passwordHelp');
    const passwordLine = node('div', 'team-password-line'); password.before(passwordLine); passwordLine.append(password, reveal, copyPassword);
    const generate = control('teamPW_generate', () => {
      if (!belongs() || busy || copyPending || saved) return;
      try { const generated = generateTemporaryPassword(mode === 'add' ? name.value.trim() : account.username); password.value = generated; password.dispatchEvent(new Event('input', { bubbles: true })); copyKey = 'teamPW_generated'; refresh(); }
      catch { copyKey = 'teamPW_generateFailed'; refresh(); }
    });
    const copyStatus = node('p', 'team-copy-status'); copyStatus.setAttribute('role', 'status');
    const manualPassword = node('textarea', 'team-manual-copy'); manualPassword.readOnly = true; manualPassword.hidden = true; manualPassword.rows = 2; manualPassword.dataset.privateDraft = 'true'; manualPassword.dataset.privateDraftRevision = '0'; manualPassword.setAttribute('aria-label', t('teamPW_manualPassword'));
    const passwordTools = node('div', 'team-password-tools'); passwordTools.append(generate); passwordField.append(passwordTools, copyStatus, manualPassword);
    const roleHelp = node('p', 'team-role-help'); const impact = node('p', 'team-impact');
    const error = node('p', 'team-editor-error'); error.id = 'team-editor-error'; error.tabIndex = -1; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = node('div', 'team-editor-actions'); const cancel = control('cancel', requestClose); const submit = node('button', 'primary-button'); submit.type = 'submit'; actions.append(cancel, submit);
    if (mode === 'add') form.append(field('username', name, 'teamUI_usernameHelp')); else form.append(node('p', 'team-editor-identity', account.username));
    if (mode !== 'reset') form.append(field('role', role), roleHelp);
    if (mode !== 'role') form.append(passwordField);
    form.append(impact, error, actions); modal.content.append(form);

    const handoffPanel = node('section', 'team-handoff'); handoffPanel.tabIndex = -1;
    const handoffTitle = node('h3', 'sr-only', t('teamPW_handoffTitle')); handoffTitle.id = 'team-handoff-title'; handoffTitle.dataset.i18n = 'teamPW_handoffTitle'; handoffPanel.setAttribute('aria-labelledby', handoffTitle.id);
    const handoffIdentity = node('p', 'team-editor-identity'); const handoffNote = node('p', 'team-field-help'); handoffNote.dataset.i18n = 'teamPW_handoffNote';
    const savedPasswordCopy = control('teamPW_copyPassword', () => copyText(handoff?.password || '', false)); savedPasswordCopy.id = 'team-copy-saved-password';
    const emailCopy = control('teamPW_copyEmail', () => copyText(emailText.value, true), 'primary-button'); emailCopy.id = 'team-copy-email';
    const emailDetails = node('details', 'team-email-details'); const emailSummary = node('summary', '', t('teamPW_viewEmail')); emailSummary.dataset.i18n = 'teamPW_viewEmail';
    const emailText = node('textarea', 'team-email-text'); emailText.readOnly = true; emailText.rows = 15; emailText.dataset.privateDraft = 'true'; emailText.dataset.privateDraftRevision = '0'; emailText.setAttribute('aria-label', t('teamPW_emailText'));
    emailDetails.append(emailSummary, emailText);
    const handoffStatus = node('p', 'team-copy-status'); handoffStatus.setAttribute('role', 'status');
    const handoffActions = node('div', 'team-editor-actions'); const done = control('teamPW_done', requestClose); done.id = 'team-handoff-done'; handoffActions.append(done);
    handoffPanel.append(handoffTitle, handoffIdentity, handoffNote, savedPasswordCopy, emailCopy, handoffStatus, emailDetails, handoffActions);
    const titleKey = mode === 'add' ? 'teamAdd' : mode === 'role' ? 'teamUI_changeRole' : 'teamResetPassword';
    function renderHandoff() {
      translate(handoffPanel); modal.setTitle(t('teamPW_handoffTitle'));
      handoffIdentity.textContent = `${handoff.username} · ${t(ROLE_KEY[handoff.role])}`;
      const values = { shop: handoff.shop || t('teamPW_genericShop'), username: handoff.username, role: t(ROLE_KEY[handoff.role]), login: handoff.login, password: handoff.password };
      const value = `${text('teamPW_emailSubject', values)}\n\n${text('teamPW_emailBody', values)}${handoff.active ? '' : `\n\n${t('teamPW_inactiveNote')}`}`;
      if (emailText.value !== value) { emailText.value = value; draftRevision++; emailText.dataset.privateDraftRevision = String(draftRevision); }
      handoffStatus.textContent = handoffCopyKey ? t(handoffCopyKey) : ''; handoffNote.textContent = t('teamPW_handoffNote');
      emailText.setAttribute('aria-label', t('teamPW_emailText')); refreshBusy();
    }
    function refresh() {
      if (handoff) { renderHandoff(); return; }
      translate(form); modal.setTitle(t(titleKey)); submit.textContent = t(mode === 'add' ? 'teamCreate' : mode === 'reset' ? 'teamPW_resetAndHandoff' : 'passwordSave');
      reveal.textContent = t(password.type === 'password' ? 'teamPW_show' : 'teamPW_hide'); reveal.setAttribute('aria-label', t(password.type === 'password' ? 'teamUI_show' : 'teamUI_hide')); copyPassword.setAttribute('aria-label', t('teamPW_copyPassword')); reveal.setAttribute('aria-pressed', String(password.type === 'text'));
      roleHelp.textContent = t(role.value === 'MANAGER' ? 'teamUI_managerHelp' : 'teamUI_staffHelp');
      impact.textContent = t(mode === 'reset' ? 'teamUI_resetImpact' : mode === 'role' ? 'teamUI_roleImpact' : 'teamPW_firstLogin');
      error.textContent = errorKey ? t(errorKey) : ''; copyStatus.textContent = copyKey ? t(copyKey) : ''; manualPassword.setAttribute('aria-label', t('teamPW_manualPassword')); refreshBusy();
    }
    function refreshBusy() {
      for (const input of form.querySelectorAll('input,select,textarea,button')) input.disabled = busy || copyPending || saved;
      copyPassword.disabled = busy || copyPending || saved || !password.value;
      manualPassword.disabled = busy || copyPending; cancel.disabled = busy; savedPasswordCopy.disabled = busy || copyPending; emailCopy.disabled = busy || copyPending; done.disabled = busy; dialog.querySelector('.modal-close').disabled = busy;
      form.setAttribute('aria-busy', String(busy)); handoffPanel.setAttribute('aria-busy', String(busy || copyPending));
    }
    function fail(key, invalidField) {
      const invalid = invalidField === 'username' ? name : invalidField?.includes('assword') ? password : null;
      if (invalid) invalid.setAttribute('aria-describedby', `${invalid.id}-help ${error.id}`);
      errorKey = key; error.textContent = t(key); error.hidden = false; if (invalid) invalid.setAttribute('aria-invalid', 'true'); (invalid || error).focus();
    }
    async function copyText(value, email) {
      if (!belongs() || busy || copyPending || !value) return;
      const request = ++copySequence, revision = draftRevision;
      const job = { value }; pendingCopy = job; value = '';
      let selectFallback = null;
      copyPending = true; refreshBusy();
      try {
        if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('COPY_UNAVAILABLE');
        await navigator.clipboard.writeText(job.value);
        if (!belongs() || request !== copySequence || revision !== draftRevision) return;
        if (email) handoffCopyKey = 'teamPW_emailCopied'; else { if (handoff) handoffCopyKey = 'teamPW_savedPasswordCopied'; else copyKey = 'teamPW_passwordCopied'; manualPassword.value = ''; manualPassword.hidden = true; }
      } catch {
        if (!belongs() || request !== copySequence || revision !== draftRevision) return;
        if (email) { handoffCopyKey = 'teamPW_copyFailed'; emailDetails.open = true; selectFallback = emailText; }
        else { if (handoff) { handoffCopyKey = 'teamPW_copyFailed'; handoffStatus.after(manualPassword); } else copyKey = 'teamPW_copyFailed'; manualPassword.value = job.value; manualPassword.dataset.privateDraftRevision = String(revision); manualPassword.hidden = false; selectFallback = manualPassword; }
      } finally {
        job.value = ''; if (pendingCopy === job) pendingCopy = null;
        if (belongs() && request === copySequence) { copyPending = false; refresh(); if (selectFallback && revision === draftRevision) { selectFallback.focus(); selectFallback.select(); } }
      }
    }
    async function requestClose() {
      if (busy || closePending) return;
      closePending = true;
      if (!dirty || saved || await confirmModal(t('unsavedChangesConfirm'), { title: t('cancelEdit'), confirmLabel: t('cancelEdit'), signal: confirmations.signal })) { if (belongs()) { clearSensitive(); modal.close(); } }
      closePending = false;
    }
    function clearSensitive() {
      copySequence++; if (pendingCopy) pendingCopy.value = ''; pendingCopy = null; copyPending = false; password.value = ''; password.type = 'password'; manualPassword.value = ''; manualPassword.hidden = true; emailText.value = ''; handoff = null; copyKey = ''; handoffCopyKey = ''; copyStatus.textContent = ''; handoffStatus.textContent = '';
    }
    function complete(result, submittedPassword) {
      if (mode === 'role') return false;
      if (!belongs() || typeof submittedPassword !== 'string') return false;
      handoff = { username: result.username, role: result.role, active: result.active, password: submittedPassword, shop: getShopName() || '', login: sellerLoginUrl() };
      password.value = ''; password.type = 'password'; manualPassword.value = ''; manualPassword.hidden = true; dirty = false; dialog.dataset.teamState = 'handoff';
      modal.content.replaceChildren(handoffPanel); refresh(); handoffPanel.focus(); updateGuard(); return true;
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopImmediatePropagation(); requestClose(); }, true);
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect(); const outside = event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      if (event.target.closest?.('.modal-close') || outside) { event.preventDefault(); event.stopImmediatePropagation(); requestClose(); }
    }, true);
    form.addEventListener('input', () => {
      if (saved) return; errorKey = ''; error.hidden = true; copyKey = ''; manualPassword.value = ''; manualPassword.hidden = true;
      dirty = true; draftRevision++; password.dataset.privateDraftRevision = String(draftRevision); name.removeAttribute('aria-invalid'); password.removeAttribute('aria-invalid'); refresh(); updateGuard();
    });
    role.addEventListener('change', () => { if (saved) return; dirty = true; draftRevision++; refresh(); updateGuard(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || copyPending || saved || !belongs()) return;
      const username = mode === 'add' ? name.value.trim() : account.username;
      if (mode === 'add' && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) { fail('teamUI_usernameHelp', 'username'); return; }
      if (mode !== 'role' && !validTemporaryPassword(password.value, username)) { fail('teamUI_passwordHelp', 'password'); return; }
      if (mode === 'role' && role.value === account.role) { fail('teamUI_chooseDifferentRole'); return; }
      await mutate(account, mode === 'add' ? { username, role: role.value, password: password.value } : mode === 'role' ? { role: role.value } : { resetPassword: password.value }, mode === 'reset' ? 'teamResetDone' : mode === 'add' ? 'teamUI_created' : 'teamUI_saved');
    });
    drawer = { modal, dialog, closed, resolveClosed, refresh, refreshBusy, fail, complete, clearSensitive, get hasHandoff() { return Boolean(handoff); }, get dirty() { return dirty && !saved; }, set saved(value) { saved = value; } };
    refresh(); modal.open(t(titleKey), () => { disposed = true; resolveClosed(); clearSensitive(); dialog.remove(); if (drawer?.dialog === dialog) drawer = null; updateGuard(); });
    (mode === 'add' ? name : mode === 'role' ? role : password).focus();
  }
  renderRows();
  load();
  return {
    refreshLocale() { search.placeholder = t('teamUI_searchPlaceholder'); translate(page); if (headingHost) translate(headingHost); caption.textContent = t('teamUI_members'); listContainer.setAttribute('aria-label', t('teamUI_members')); renderRows(); drawer?.refresh(); },
    dispose() { active = false; if (headingHost) { headingHost.classList.remove('ui-page-heading'); intro.remove(); headingActions.remove(); } confirmations.abort(); sequence++; if (drawer) { drawer.clearSensitive(); drawer.resolveClosed(); drawer.dialog.close(); drawer.dialog.remove(); drawer = null; } },
    hasUnsavedChanges: () => Boolean(drawer?.dirty), isBusy: () => busy || Boolean(drawer?.hasHandoff),
    // Monotonic edit identity protects update/navigation guards without serializing credentials.
    draftSignature: () => `${drawer?.dialog.dataset.teamMode || 'closed'}:${draftRevision}`,
  };
}
