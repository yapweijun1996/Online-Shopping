import { aiText } from './ai-copy.js';
import { translate } from '../shared/i18n.js';
import { apiUrl } from '../shared/base-path.js';
import { beginMutation } from '../shared/update-guard.js';
import { confirmModal } from '../shared/modal.js';
export function aiNode(tag, key) {
  const element = document.createElement(tag);
  if (key) { element.dataset.i18n = `ai_${key}`; element.textContent = aiText(key); }
  return element;
}
export function mountAiSettings(root, { csrfToken, onUnauthorized, confirm = confirmModal }) {
  const section = aiNode('section'); section.className = 'settings-card ai-settings'; section.hidden = true;
  const form = aiNode('form'); form.className = 'settings-form';
  const line = aiNode('p'); line.setAttribute('role', 'status');
  section.append(aiNode('h2','title'), aiNode('p','draftOnly'), aiNode('p','privacy'), form, line); root.append(section);
  const inputs = {}, errors = {};
  for (const key of ['enabled','tone','businessNotes','dailyTokenCap']) {
    const label = aiNode('label'), input = aiNode(key === 'businessNotes' ? 'textarea' : 'input'), error = aiNode('span');
    input.name = key;
    if (key === 'enabled') { input.type = 'checkbox'; input.setAttribute('role','switch'); }
    if (key === 'tone') input.maxLength = 300;
    if (key === 'businessNotes') { input.maxLength = 3000; input.rows = 5; }
    if (key === 'dailyTokenCap') { input.type = 'number'; input.min = 1000; input.max = 2000000; input.step = 1; input.required = true; }
    error.id = `ai-error-${key}`; input.setAttribute('aria-describedby', error.id);
    label.append(aiNode('span',key), input, error); form.append(label); inputs[key] = input; errors[key] = error;
    if (key === 'businessNotes') form.append(aiNode('p','help'));
  }
  const save = aiNode('button','save'); save.type = 'submit'; save.className = 'primary-button'; form.append(save);
  let baseline = '', revision, busy = false, statusKey = '';
  const values = () => ({ enabled: inputs.enabled.checked, tone: inputs.tone.value, businessNotes: inputs.businessNotes.value, dailyTokenCap: Number(inputs.dailyTokenCap.value) });
  const identity = csrfToken();
  const current = () => section.isConnected && identity === csrfToken();
  const result = { section, available: false, refreshLocale() { translate(section); line.textContent = statusKey ? aiText(statusKey) : ''; for (const key of Object.keys(errors)) if (errors[key].textContent) errors[key].textContent = aiText('invalid'); }, hasUnsavedChanges: () => busy || result.available && JSON.stringify(values()) !== baseline };
  result.isBusy = () => busy;
  async function request(method, body) {
    const finish = body ? beginMutation() : () => {};
    try {
      const response = await fetch(apiUrl('v1/seller/ai-settings'), { method, cache: 'no-store', headers: body ? { 'Content-Type':'application/json', 'X-CSRF-Token':csrfToken() } : {}, body: body ? JSON.stringify(body) : undefined });
      if (response.status === 401 && current()) onUnauthorized();
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('request'), { status:response.status, code:data.error?.code, field:data.error?.field });
      return data;
    } finally { finish(); }
  }
  function apply(data) {
    revision = data.revision;
    for (const key of Object.keys(inputs)) if (key === 'enabled') inputs[key].checked = data[key]; else inputs[key].value = data[key];
    baseline = JSON.stringify(values());
  }
  result.ready = request('GET').then(data => {
    if (!current() || data.available !== true) return false;
    result.available = true; apply(data); return true;
  }).catch(() => false);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !result.available || !current()) return;
    busy = true; save.disabled = true;
    for (const key of Object.keys(inputs)) { inputs[key].disabled = true; inputs[key].removeAttribute('aria-invalid'); errors[key].textContent = ''; }
    try {
      const data = await request('PATCH', { ...values(), expectedRevision:revision });
      if (current()) { apply(data); statusKey = 'saved'; }
    } catch (error) {
      if (!current()) return;
      if (error.code === 'STALE_REVISION') {
        statusKey = 'stale';
        if (await confirm(aiText('stale')) && current()) { try { const data = await request('GET'); if (current()) { apply(data); statusKey = ''; } } catch { statusKey = 'failed'; } }
      } else {
        statusKey = error.status === 403 ? 'forbidden' : error.field ? 'invalid' : 'failed';
        if (inputs[error.field]) { errors[error.field].textContent = aiText('invalid'); inputs[error.field].setAttribute('aria-invalid','true'); }
      }
    } finally {
      busy = false;
      if (current()) { save.disabled = false; for (const input of Object.values(inputs)) input.disabled = false; line.textContent = statusKey ? aiText(statusKey) : ''; }
    }
  });
  return result;
}
