import { aiText } from './ai-copy.js';
import { aiNode } from './ai-settings.js';
import { translate } from '../shared/i18n.js';
import { confirmModal } from '../shared/modal.js';
export const suggestionError = error => aiText(error.code === 'AI_CAP' ? 'cap' : error.code === 'AI_DISABLED' ? 'disabled' : error.status === 429 ? 'retry' : error.code === 'AI_TIMEOUT' ? 'timeout' : error.code === 'AI_UNAVAILABLE' ? 'unavailable' : 'failed').replace('{n}', String(error.retryAfter || 60));
export function mountAiSuggestions(form, textarea, { request, current, changed, confirm = confirmModal, lazySettings = false }) {
  const suggest = aiNode('button','suggest'); suggest.type = 'button'; suggest.className = 'secondary-button'; suggest.hidden = true;
  const status = aiNode('p'); status.setAttribute('role','status');
  const handoff = aiNode('p'); handoff.className = 'ai-handoff'; handoff.hidden = true; handoff.setAttribute('role','status');
  const card = aiNode('section'); card.className = 'ai-order-card'; card.hidden = true;
  if (form.prepend) form.prepend(card, handoff);
  else form.append(card, handoff);
  form.append(suggest, status);
  let enabled = false, eligible = false, id = null, generation = 0, busy = false, draft = null, handoffReason = null, statusKey = '', failure = null;
  function eligibility() { suggest.hidden = !enabled || !eligible; suggest.disabled = Boolean(busy || textarea.disabled); }
  function clear(threadId = null) {
    ++generation; id = threadId; busy = false; draft = null; handoffReason = null; statusKey = ''; failure = null;
    status.textContent = ''; handoff.hidden = true; handoff.textContent = ''; card.hidden = true; card.replaceChildren(); eligibility();
  }
  const missingText = value => /^product:.*:unavailable$/.test(value) ? aiText('unavailableItem') : ['address','recipientName'].includes(value) ? aiText(value) : value;
  const money = (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`;
  function summary() {
    if (!draft) return '';
    return [aiText('order'), ...draft.items.map(item => `${item.name} x ${item.quantity} — ${money(item.unitPriceMinor,item.currency)}`), `${aiText('total')}: ${money(draft.totalMinor,draft.currency)}`, ...['recipientName','address','notes'].filter(key => draft[key]).map(key => `${aiText(key)}: ${draft[key]}`), ...(draft.missing.length ? [aiText('missing'), ...draft.missing.map(missingText)] : [])].join('\n');
  }
  function render() {
    status.textContent = failure ? suggestionError(failure) : statusKey ? aiText(statusKey) : '';
    handoff.hidden = !handoffReason;
    handoff.textContent = handoffReason ? aiText('handoff').replace('{reason}',aiText(handoffReason)) : '';
    card.hidden = !draft; card.replaceChildren();
    if (!draft) return;
    card.append(aiNode('h4','order'));
    for (const item of draft.items) { const row = aiNode('p'); row.textContent = `${item.name} x ${item.quantity} — ${money(item.unitPriceMinor,item.currency)}`; card.append(row); }
    const total = aiNode('strong'); total.textContent = `${aiText('total')}: ${money(draft.totalMinor,draft.currency)}`; card.append(total);
    for (const key of ['recipientName','address','notes']) if (draft[key]) { const row = aiNode('p'); row.textContent = `${aiText(key)}: ${draft[key]}`; card.append(row); }
    if (draft.missing.length) { const list = aiNode('ul'); for (const value of draft.missing) { const item = aiNode('li'); item.textContent = missingText(value); list.append(item); } card.append(aiNode('h4','missing'),list); }
    const copy = aiNode('button','copy'); copy.type = 'button'; copy.className = 'secondary-button';
    copy.addEventListener('click', async () => { const ticket = generation; try { await navigator.clipboard.writeText(summary()); if (ticket === generation && current()) statusKey = 'copied'; } catch { if (ticket === generation && current()) statusKey = 'copyFailed'; } if (ticket === generation && current()) { failure = null; render(); } }); card.append(copy);
  }
  suggest.addEventListener('click', async () => {
    if (!current() || !enabled || !eligible || busy || textarea.disabled || !id) return;
    const ticket = generation, threadId = id, original = textarea.value;
    busy = true; eligibility();
    try {
      if (original.trim() && !await confirm(aiText('overwrite'))) return;
      if (ticket !== generation || !current()) return;
      statusKey = 'thinking'; failure = null; render();
      const result = await request(`chats/${encodeURIComponent(threadId)}/suggestions`, {});
      if (ticket !== generation || !current()) return;
      // The seller may continue typing while the provider is working.
      if (textarea.value !== original && textarea.value.trim() && !await confirm(aiText('overwrite'))) return;
      if (ticket !== generation || !current()) return;
      textarea.value = result.reply; draft = result.orderDraft; handoffReason = result.handoff ? (['COMPLAINT','REFUND','UNKNOWN','SENSITIVE','OTHER'].includes(result.handoffReason) ? result.handoffReason : 'OTHER') : null;
      statusKey = 'ready'; render(); changed(); textarea.focus();
    } catch (error) { if (ticket === generation && current()) { failure = error; if (error.code === 'AI_DISABLED') enabled = false; render(); } }
    finally { if (ticket === generation) { busy = false; if (statusKey === 'thinking') { statusKey = ''; render(); } eligibility(); } }
  });
  let settingsRequested = false;
  function loadSettings() {
    if (settingsRequested) return;
    settingsRequested = true;
    request('ai-settings').then(value => { if (current()) { enabled = value.available === true && value.enabled === true; eligibility(); } }).catch(() => {});
  }
  if (!lazySettings) loadSettings();
  return { clear, update(threadId, canReply) {
    if (threadId !== id) clear(threadId);
    eligible = canReply;
    if (threadId) loadSettings();
    eligibility();
  }, refreshLocale() { translate(form); render(); }, isBusy: () => busy };
}
