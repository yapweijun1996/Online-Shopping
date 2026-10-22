import { translate, formatDate } from '../shared/i18n.js';
import { node, button, text, client, failureText, policyFailure, watch } from './whatsapp-qr-ui.js';
export function mountWhatsAppChats(root, cloud, { csrfToken, onUnauthorized }) {
  const tabs = node('div', null, 'qr-tabs'); tabs.hidden = true;
  const panel = node('section', null, 'qr-inbox'); panel.hidden = true;
  root.replaceChildren(tabs, cloud, panel);
  let selected = false, connection = null, threads = [], thread = null, history = [], orders = [], listMore = true, earlier = true;
  let listAt = 0, threadAt = 0, listBusy = false, threadBusy = false, sending = false, intent = null, epoch = 0, retryUntil = 0;
  const lifecycle = watch(panel, csrfToken(), csrfToken, force => {
    if (!selected) return;
    eligibility();
    if (force || Date.now() - listAt >= 15000) loadList();
    if (thread && (force || Date.now() - threadAt >= 5000)) loadMessages();
  });
  const request = client({ csrfToken, onUnauthorized: () => { if (lifecycle.current()) onUnauthorized(); } });
  const api = async (...args) => {
    try { return await request(...args); }
    catch (error) {
      if (lifecycle.current() && (policyFailure(error) || error.status === 401 || error.status === 403)) {
        connection = null; textarea.value = ''; eligibility();
        alert.textContent = failureText(error);
      }
      throw error;
    }
  };
  const cloudTab = button('cloud', () => select(false)), chatTab = button('chats', () => select(true));
  tabs.append(cloudTab, chatTab);
  const listPane = node('div', null, 'qr-thread-pane'), conversation = node('div', null, 'qr-conversation');
  const list = node('div', null, 'qr-thread-list'), more = button('more', () => loadList(true));
  const alert = node('p'); alert.setAttribute('role', 'status'); alert.setAttribute('aria-live', 'polite');
  const search = node('input', null, 'qr-search'); search.type = 'search'; search.maxLength = 100; search.autocomplete = 'off'; search.setAttribute('aria-label', text('search')); search.placeholder = text('search');
  let needle = '';
  search.addEventListener('input', () => { needle = search.value.trim().toLowerCase(); renderList(); });
  listPane.append(search, list, more); panel.append(listPane, conversation, alert);
  const back = button('back', () => { ++epoch; thread = null; intent = null; history = []; textarea.value = ''; panel.classList.remove('qr-thread-open'); conversation.hidden = true; renderList(); list.querySelector('button')?.focus(); });
  const heading = node('h3'), suggestions = node('div', null, 'qr-order-chips'), messages = node('div', null, 'qr-bubbles');
  const older = button('earlier', () => loadMessages(true));
  const form = node('form', null, 'qr-composer'), label = node('label'), textarea = node('textarea');
  textarea.maxLength = 4096; textarea.rows = 3; textarea.setAttribute('aria-label', text('draft')); label.append(node('span', 'draft'), textarea);
  textarea.value = '';
  const counter = node('span'), reason = node('p'), send = node('button', 'send', 'primary-button'); send.type = 'submit';
  reason.setAttribute('aria-live', 'polite'); form.append(label, counter, reason, send);
  conversation.append(back, heading, suggestions, older, messages, form); conversation.hidden = true;
  function select(value) {
    selected = value; cloud.hidden = value; panel.hidden = !value;
    cloudTab.setAttribute('aria-pressed', String(!value)); chatTab.setAttribute('aria-pressed', String(value));
    if (value) loadList();
  }
  function eligibility() {
    if (!thread) return;
    let why = connection?.state !== 'CONNECTED' || connection?.desired === 'OFF' ? 'notLinked' : thread.suppressed ? 'suppressed' : !thread.canReply ? 'closed' : null;
    const wait = Math.ceil((retryUntil - Date.now()) / 1000);
    reason.textContent = wait > 0 ? text('retry', wait) : why ? text(why) : '';
    textarea.disabled = Boolean(why) || sending; send.disabled = Boolean(why) || wait > 0 || sending || !textarea.value.trim();
    counter.textContent = `${textarea.value.length} / 4096`;
  }
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  // Today shows the clock time like WhatsApp Web; older chats show the date.
  function shortTime(value) {
    const date = new Date(value); if (Number.isNaN(date.getTime())) return '';
    try { return sameDay(date, new Date()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: 'numeric', month: 'short' }); } catch { return ''; }
  }
  const initial = value => { const first = [...String(value || '').trim()].find(char => /[\p{L}\p{N}]/u.test(char)); return first ? first.toUpperCase() : '#'; };
  function renderList() {
    list.replaceChildren();
    const shown = needle ? threads.filter(item => [item.displayName, item.peerMasked, item.lastMessageText].some(value => String(value ?? '').toLowerCase().includes(needle))) : threads;
    if (!shown.length) list.append(node('p', threads.length ? 'noMatch' : 'empty', 'qr-empty'));
    for (const item of shown) {
      const row = button(null, () => open(item)); row.className = 'qr-thread'; row.setAttribute('aria-current', String(thread?.id === item.id));
      const label = item.displayName || item.peerMasked || '';
      const avatar = node('span', null, 'qr-avatar'); avatar.textContent = initial(label); avatar.setAttribute('aria-hidden', 'true');
      const name = node('strong'); name.textContent = label;
      const time = node('time'); time.textContent = shortTime(item.lastMessageAt); time.dateTime = item.lastMessageAt || '';
      const preview = node('p'); preview.textContent = `${item.lastMessageDirection === 'OUT' ? `${text('you')}: ` : ''}${item.lastMessageText ?? ''}`;
      row.append(avatar, name, time, preview);
      if (item.unreadCount) { const badge = node('span', null, 'status-badge'); badge.textContent = String(item.unreadCount); row.append(badge); }
      list.append(row);
    }
    more.hidden = !listMore; more.disabled = listBusy;
  }
  function renderMessages() {
    messages.replaceChildren();
    let lastDay = null;
    for (const item of history) {
      const created = new Date(item.createdAt);
      if (!Number.isNaN(created.getTime()) && (!lastDay || !sameDay(lastDay, created))) {
        const day = node('div', null, 'qr-day'); try { day.textContent = created.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); } catch { day.textContent = ''; }
        messages.append(day); lastDay = created;
      }
      const bubble = node('article', null, `qr-bubble ${item.direction === 'OUT' ? 'qr-out' : 'qr-in'}`);
      const body = node('p'); body.textContent = item.text === null ? text('removed') : item.text;
      const time = node('time'); time.dateTime = item.createdAt; try { time.textContent = Number.isNaN(created.getTime()) ? '' : created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { time.textContent = ''; }
      bubble.append(body, time);
      if (item.direction === 'OUT') {
        if (item.actor === 'phone:device') bubble.append(node('span', 'fromPhone', 'qr-from-phone'));
        else bubble.append(node('span', ['QUEUED','SENDING','SENT','FAILED','RECONCILE','CANCELLED'].includes(item.status) ? item.status : 'FAILED', 'status-badge'));
      }
      messages.append(bubble);
    }
    older.hidden = !earlier;
    eligibility();
  }
  async function loadList(append = false) {
    if (listBusy || !lifecycle.current() || document.hidden || !selected) return;
    listBusy = true; listAt = Date.now();
    try {
      const offset = append ? threads.length : 0;
      const [rows, status] = await Promise.all([api(`chats?limit=50&offset=${offset}`), api('integrations/whatsapp-qr')]);
      if (!lifecycle.current()) return;
      connection = status; listMore = rows.length === 50 && offset < 10000;
      threads = append ? [...threads, ...rows.filter(row => !threads.some(old => old.id === row.id))] : [...rows, ...threads.filter(old => !rows.some(row => row.id === old.id))];
      if (thread) thread = threads.find(row => row.id === thread.id) || thread;
      renderList(); eligibility();
    } catch (error) { if (lifecycle.current()) alert.textContent = failureText(error); }
    finally { listBusy = false; more.disabled = false; }
  }
  async function open(item) {
    const ticket = ++epoch; thread = item; history = []; orders = []; earlier = true; intent = null; textarea.value = ''; alert.textContent = ''; retryUntil = 0;
    heading.textContent = item.displayName || item.peerMasked; suggestions.replaceChildren(); messages.replaceChildren(); conversation.hidden = false; panel.classList.add('qr-thread-open');
    eligibility(); heading.tabIndex = -1; heading.focus();
    loadMessages(false, true);
    try {
      const [result] = await Promise.all([api(`chats/${encodeURIComponent(item.id)}/orders`), api(`chats/${encodeURIComponent(item.id)}/read`, {})]);
      if (!lifecycle.current() || ticket !== epoch) return;
      orders = result.suggested; renderOrders(); item.unreadCount = 0; renderList();
    } catch (error) { if (lifecycle.current() && ticket === epoch) alert.textContent = failureText(error); }
  }
  function renderOrders() {
    suggestions.replaceChildren();
    if (orders.length) suggestions.append(node('span', 'suggested'));
    for (const order of orders) { const link = node('a'); link.textContent = order.orderNo; link.href = `#orders/${encodeURIComponent(order.id)}`; suggestions.append(link); }
  }
  async function loadMessages(before = false, opening = false) {
    if (!thread || !lifecycle.current() || document.hidden || !selected || threadBusy && !opening) return;
    const ticket = epoch, id = thread.id; threadBusy = true; threadAt = Date.now();
    const oldHeight = messages.scrollHeight, oldTop = messages.scrollTop;
    try {
      const rows = await api(`chats/${encodeURIComponent(id)}/messages?limit=100${before && history.length ? `&before=${encodeURIComponent(history[0].id)}` : ''}`);
      if (!lifecycle.current() || ticket !== epoch) return;
      if (before || !history.length) earlier = rows.length === 100;
      const byId = new Map((before ? [...rows, ...history] : [...history, ...rows]).map(row => [row.id, row]));
      history = [...byId.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      renderMessages(); messages.scrollTop = before ? oldTop + messages.scrollHeight - oldHeight : opening || oldHeight - oldTop - messages.clientHeight < 80 ? messages.scrollHeight : oldTop;
      if (rows.some(row => row.direction === 'IN')) await api(`chats/${encodeURIComponent(id)}/read`, {});
    } catch (error) { if (lifecycle.current() && ticket === epoch) alert.textContent = failureText(error); }
    finally { if (ticket === epoch) threadBusy = false; }
  }
  textarea.addEventListener('input', eligibility);
  textarea.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } });
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  async function submit() {
    if (!lifecycle.current() || !selected) return;
    eligibility(); if (send.disabled || !thread) return;
    const body = textarea.value.trim(), ticket = epoch;
    if (!intent || intent.text !== body || intent.threadId !== thread.id) intent = { text: body, threadId: thread.id, key: crypto.randomUUID() };
    const pending = intent; sending = true; eligibility(); alert.textContent = '';
    try {
      const result = await api(`chats/${encodeURIComponent(pending.threadId)}/replies`, { text: body }, pending.key);
      if (!lifecycle.current() || ticket !== epoch) return;
      history = [...history.filter(row => row.id !== result.id), result]; intent = null; textarea.value = ''; renderMessages(); messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      if (!lifecycle.current() || ticket !== epoch) return;
      if (error.status === 429) retryUntil = Date.now() + error.retryAfter * 1000;
      if (error.reason === 'NOT_CONNECTED') connection = { state: 'IDLE' };
      else if (error.reason) { thread.canReply = false; thread.suppressed = error.reason === 'SUPPRESSED'; }
      alert.textContent = failureText(error);
    } finally { sending = false; if (lifecycle.current() && ticket === epoch) { eligibility(); if (!textarea.disabled) textarea.focus(); } }
  }
  api('integrations/whatsapp-qr').then(status => { if (!lifecycle.current() || !status.available) return; connection = status; tabs.hidden = false; select(false); }).catch(error => {
    if (!lifecycle.current() || !policyFailure(error)) return;
    tabs.hidden = false; selected = true; cloud.hidden = true; panel.hidden = false;
    cloudTab.setAttribute('aria-pressed', 'false'); chatTab.setAttribute('aria-pressed', 'true');
    alert.textContent = failureText(error);
  });
  return {
    refreshLocale() { translate(tabs); translate(panel); textarea.setAttribute('aria-label', text('draft')); search.setAttribute('aria-label', text('search')); search.placeholder = text('search'); renderList(); renderOrders(); renderMessages(); },
    hasUnsavedChanges: () => Boolean(textarea.value.trim()) || sending,
    draftSignature: () => JSON.stringify([thread?.id, textarea.value]),
    isBusy: () => sending,
    dispose() { ++epoch; lifecycle.dispose(); textarea.value = ''; intent = null; history = []; panel.remove(); tabs.remove(); },
  };
}
