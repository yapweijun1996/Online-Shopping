// AI Studio page: the shop's OpenAI key (Owner), a product draft made from one photo, and styled images for a draft.
// Everything the server or the AI returns is shown with textContent only. Nothing here publishes a product.
import { studioText, STUDIO_STYLES } from './ai-studio-copy.js';
import { translate } from '../shared/i18n.js';
import { apiUrl } from '../shared/base-path.js';
import { beginMutation } from '../shared/update-guard.js';
import { confirmModal } from '../shared/modal.js';

const ERROR_KEYS = { AI_STUDIO_NO_KEY: 'eNoKey', AI_STUDIO_CAP: 'eCap', AI_STUDIO_BUSY: 'eBusy', AI_STUDIO_KEY_REJECTED: 'eKeyRejected', AI_STUDIO_TIMEOUT: 'eTimeout',
  AI_STUDIO_PROVIDER_LIMIT: 'eRate', AI_STUDIO_REFUSED: 'eRefused', AI_STUDIO_BAD_RESPONSE: 'eBad', AI_STUDIO_REQUEST_REJECTED: 'eRequest',
  AI_STUDIO_IMAGE_REJECTED: 'eImage', AI_STUDIO_VARIANT: 'eVariant', AI_STUDIO_GALLERY_FULL: 'eFull', AI_STUDIO_PUBLISHED: 'published',
  AI_STUDIO_UNAVAILABLE: 'eFailed', STALE_REVISION: 'eStale', RATE_LIMITED: 'eBusy' };
// After these the remaining styles would fail the same way, so a batch stops.
const STOPS = new Set(['AI_STUDIO_NO_KEY', 'AI_STUDIO_CAP', 'AI_STUDIO_KEY_REJECTED', 'AI_STUDIO_PROVIDER_LIMIT', 'AI_STUDIO_PUBLISHED', 'AI_STUDIO_VARIANT', 'AI_STUDIO_GALLERY_FULL', 'AI_STUDIO_TIMEOUT']);
const errorKey = (error) => error.status === 403 ? 'eForbidden' : ERROR_KEYS[error.code] || (error.field ? 'eField' : 'eFailed');
const PHOTO_LIMIT = 480 * 1024;

function svg(path) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true'); node.setAttribute('class', 'ai-studio-icon');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path); node.append(shape);
  return node;
}

/* Photos are shrunk in the browser to fit the 512 KB limit; transparent PNGs get a white background. */
export async function shrinkPhoto(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Object.assign(new Error('format'), { key: 'eFile' });
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw Object.assign(new Error('format'), { key: 'eFile' }); }
  let scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', Math.max(0.5, 0.88 - attempt * 0.06)));
    if (blob && blob.size <= PHOTO_LIMIT) {
      bitmap.close?.();
      return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('read')); reader.readAsDataURL(blob); });
    }
    scale *= 0.8;
  }
  bitmap.close?.();
  throw Object.assign(new Error('size'), { key: 'eSize' });
}

export function priceToMinor(text) {
  const value = String(text).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  const minor = Math.round(Number(value) * 100);
  return minor >= 1 && minor <= 1_000_000_000 ? minor : null;
}

export function mountAiStudio(root, { csrfToken, onUnauthorized, role, onNavigate = () => {}, initialProductId = null }) {
  const owner = role === 'OWNER';
  const identity = csrfToken();
  const live = () => !disposed && root.isConnected && identity === csrfToken();
  const refreshers = [];
  const state = { available: false, configured: false, last4: null, usedToday: 0, dailyCallCap: 20, keyRevision: 0, settingRevision: 1 };
  let chosenProduct = null, photoData = null, currency = 'MYR', categories = [];
  let busy = 0, dirty = false, running = false, disposed = false, photoToken = 0;
  function text(tag, key, className, values) {
    const node = document.createElement(tag); if (className) node.className = className;
    const paint = () => { node.textContent = studioText(key, values?.() ?? {}); };
    paint(); refreshers.push(paint); return node;
  }
  function field(key, input, className = '', values) {
    const label = document.createElement('label'); label.className = `ai-studio-field ${className}`.trim();
    label.append(text('span', key, undefined, values), input); return label;
  }
  function button(key, className = 'secondary-button', icon) {
    const node = document.createElement('button'); node.type = 'button'; node.className = className;
    if (icon) node.append(svg(icon));
    const label = text('span', key); node.append(label); return node;
  }
  function card(titleKey) {
    const node = document.createElement('section'); node.className = 'settings-card ai-studio-card';
    const heading = text('h2', titleKey); node.append(heading); return node;
  }
  function liveLine() {
    const node = document.createElement('p'); node.className = 'ai-studio-status'; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite');
    let current = null;
    const paint = () => { node.textContent = current ? studioText(current.key, current.values) : ''; node.classList.toggle('is-error', Boolean(current?.error)); };
    refreshers.push(paint);
    node.show = (key, values = {}, error = false) => { current = key ? { key, values, error } : null; paint(); };
    return node;
  }
  async function api(method, path, body) {
    const finish = body ? beginMutation() : () => {};
    busy += 1;
    try {
      const response = await fetch(apiUrl(`v1/seller/${path}`), { method, cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {}, body: body ? JSON.stringify(body) : undefined });
      if (response.status === 401 && live()) onUnauthorized();
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('request'), { status: response.status, code: data.error?.code, field: data.error?.field });
      return data;
    } finally { busy -= 1; finish(); }
  }

  const page = document.createElement('div'); page.className = 'ai-studio';
  const intro = text('p', 'reviewNote', 'ai-studio-note'); 
  const unavailable = text('p', 'unavailable', 'ai-studio-note'); unavailable.hidden = true;
  const usageCard = card('keyTitle'); usageCard.classList.add('ai-studio-key-card');
  const usageLine = text('p', 'keyNone', 'ai-studio-usage', () => ({ last4: state.last4 ?? '' }));
  const usageCount = text('p', 'usage', 'ai-studio-usage', () => ({ used: state.usedToday, cap: state.dailyCallCap }));
  usageCard.append(text('p', 'keyHelp', 'ai-studio-note'), usageLine, usageCount);
  refreshers.push(() => { usageLine.textContent = state.configured ? studioText('keySaved', { last4: state.last4 ?? '' }) : studioText('keyNone'); });

  // Key and daily limit (Owner only)
  const keyForm = document.createElement('form'); keyForm.className = 'settings-form ai-studio-form';
  const keyInput = document.createElement('input'); keyInput.type = 'password'; keyInput.name = 'apiKey'; keyInput.autocomplete = 'off'; keyInput.spellcheck = false; keyInput.maxLength = 220; keyInput.required = true;
  keyInput.setAttribute('autocapitalize', 'off'); keyInput.setAttribute('data-lpignore', 'true');
  const saveKey = button('saveKey', 'primary-button'); saveKey.type = 'submit';
  const removeKey = button('removeKey', 'secondary-button');
  const keyActions = document.createElement('div'); keyActions.className = 'ai-studio-actions'; keyActions.append(saveKey, removeKey);
  const keyStatus = liveLine();
  keyForm.append(field('keyLabel', keyInput), keyActions, keyStatus);
  const capForm = document.createElement('form'); capForm.className = 'settings-form ai-studio-form';
  const capInput = document.createElement('input'); capInput.type = 'number'; capInput.min = 1; capInput.max = 500; capInput.step = 1; capInput.required = true; capInput.inputMode = 'numeric';
  const saveCap = button('saveCap', 'secondary-button'); saveCap.type = 'submit';
  const capStatus = liveLine();
  capForm.append(field('capLabel', capInput), saveCap, capStatus);
  const ownerNote = text('p', 'ownerOnly', 'ai-studio-note');
  if (owner) usageCard.append(keyForm, capForm); else usageCard.append(ownerNote);

  // Draft from a photo
  const photoCard = card('photoTitle');
  const photoInput = document.createElement('input'); photoInput.type = 'file'; photoInput.accept = 'image/png,image/jpeg,image/webp'; photoInput.className = 'ai-studio-file';   // visually hidden; the label below is the button
  const pickLabel = document.createElement('label'); pickLabel.className = 'secondary-button ai-studio-pick';
  pickLabel.append(svg('M12 16V4M7 9l5-5 5 5M4 20h16'), text('span', 'choosePhoto'), photoInput);
  const fileName = text('p', 'noFile', 'ai-studio-note ai-studio-filename');
  const preview = document.createElement('img'); preview.className = 'ai-studio-preview'; preview.alt = ''; preview.hidden = true;
  const readButton = button('readPhoto', 'primary-button', 'M4 7h3l2-3h6l2 3h3v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
  const photoStatus = liveLine();
  const draftForm = document.createElement('form'); draftForm.className = 'settings-form ai-studio-form'; draftForm.hidden = true;
  const inputs = { name: document.createElement('input'), description: document.createElement('textarea'), category: document.createElement('select'), sku: document.createElement('input'), price: document.createElement('input') };
  inputs.name.maxLength = 120; inputs.name.required = true; inputs.description.maxLength = 2000; inputs.description.rows = 5; inputs.description.required = true;
  inputs.category.required = true; inputs.sku.maxLength = 40; inputs.sku.required = true; inputs.sku.autocapitalize = 'characters'; inputs.sku.pattern = '[A-Za-z0-9][A-Za-z0-9._\\-]*';
  inputs.price.inputMode = 'decimal'; inputs.price.required = true; inputs.price.pattern = '\\d{1,7}(\\.\\d{1,2})?';
  for (const [name, input] of Object.entries(inputs)) { input.name = name; input.addEventListener('input', () => { dirty = true; input.removeAttribute('aria-invalid'); }); }
  const priceLabel = field('fPrice', inputs.price, '', () => ({ currency })); const priceSpan = priceLabel.querySelector('span');
  const saveDraft = button('saveDraft', 'primary-button'); saveDraft.type = 'submit';
  const draftStatus = liveLine();
  draftForm.append(text('p', 'suggestion', 'ai-studio-note ai-studio-flag'), field('fName', inputs.name), field('fDesc', inputs.description), field('fCategory', inputs.category), field('fSku', inputs.sku), priceLabel, saveDraft, draftStatus);
  photoCard.append(text('p', 'photoHelp', 'ai-studio-note'), pickLabel, fileName, preview, readButton, photoStatus, draftForm);

  // Images for a draft
  const genCard = card('genTitle');
  const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.maxLength = 100; searchInput.autocomplete = 'off';
  const searchButton = button('searchGo', 'secondary-button');
  const searchRow = document.createElement('div'); searchRow.className = 'ai-studio-search'; searchRow.append(field('search', searchInput), searchButton);
  const hits = document.createElement('ul'); hits.className = 'ai-studio-hits';
  const chosen = text('p', 'selected', 'ai-studio-selected', () => ({ name: chosenProduct?.name ?? '' })); chosen.hidden = true;
  const styleBox = document.createElement('fieldset'); styleBox.className = 'ai-studio-styles'; styleBox.hidden = true;
  const legend = text('legend', 'genTitle'); styleBox.append(legend);
  const styleInputs = STUDIO_STYLES.map((style) => {
    const label = document.createElement('label'); label.className = 'ai-studio-style';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = style; input.checked = style === 'studio';
    label.append(input, text('span', `style_${style}`)); styleBox.append(label); input.addEventListener('change', paintCost); return input;
  });
  const cost = text('p', 'cost', 'ai-studio-note', () => { const n = styleInputs.filter((input) => input.checked).length; return { n, calls: n * 2, left: Math.max(0, state.dailyCallCap - state.usedToday) }; });
  const generate = button('generate', 'primary-button', 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z');
  const genStatus = liveLine();
  const results = document.createElement('ul'); results.className = 'ai-studio-results';
  const openProduct = button('openProduct', 'secondary-button'); openProduct.hidden = true;
  const genNote = text('p', 'genHelp', 'ai-studio-note');
  genCard.append(genNote, searchRow, hits, chosen, styleBox, cost, generate, genStatus, results, openProduct);
  photoCard.hidden = true; genCard.hidden = true;   // shown only once the server reports a saved key
  keyForm.hidden = true; capForm.hidden = true; removeKey.hidden = true;
  page.append(intro, unavailable, usageCard, photoCard, genCard);
  root.append(page);

  function paintCost() { cost.textContent = studioText('cost', (() => { const n = styleInputs.filter((input) => input.checked).length; return { n, calls: n * 2, left: Math.max(0, state.dailyCallCap - state.usedToday) }; })()); generate.disabled = running || !state.configured || !chosenProduct; }
  function paintState() {
    unavailable.hidden = state.available;
    for (const card of [photoCard, genCard]) card.hidden = !state.available || !state.configured;
    usageLine.textContent = state.configured ? studioText('keySaved', { last4: state.last4 ?? '' }) : studioText('keyNone');
    usageCount.textContent = studioText('usage', { used: state.usedToday, cap: state.dailyCallCap });
    removeKey.hidden = !state.configured; keyForm.hidden = !state.available; capForm.hidden = !state.available;
    capInput.value = state.dailyCallCap; paintCost();
  }
  async function load() {
    try {
      const data = await api('GET', 'ai-studio');
      if (!live()) return;
      Object.assign(state, { available: data.available, configured: data.configured, last4: data.last4 ?? null, usedToday: data.usedToday, dailyCallCap: data.dailyCallCap,
        keyRevision: data.keyRevision ?? state.keyRevision, settingRevision: data.settingRevision ?? state.settingRevision });
    } catch { if (live()) state.available = false; }
    paintState();
  }
  const reloadCounts = () => api('GET', 'ai-studio').then((data) => { Object.assign(state, { usedToday: data.usedToday, dailyCallCap: data.dailyCallCap, configured: data.configured }); paintState(); }).catch(() => {});

  keyForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!owner || !live()) return;
    const apiKey = keyInput.value.trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) { keyStatus.show('eKeyFormat', {}, true); keyInput.setAttribute('aria-invalid', 'true'); return; }
    saveKey.disabled = true; keyInput.removeAttribute('aria-invalid');
    keyInput.value = '';   // the key never stays in the page, whatever the outcome
    try {
      const data = await api('PUT', 'ai-studio/key', { apiKey, expectedRevision: state.keyRevision });
      Object.assign(state, { configured: true, last4: data.last4, keyRevision: data.revision });
      keyStatus.show('keyOk'); paintState();
    } catch (error) { keyStatus.show(error.status === 422 ? 'eKeyRejected' : errorKey(error), {}, true); }
    finally { saveKey.disabled = false; }
  });
  removeKey.addEventListener('click', async () => {
    if (!owner || !live() || !await confirmModal(studioText('removeConfirm'), { title: studioText('removeKey'), confirmLabel: studioText('removeKey') })) return;
    try {
      const data = await api('DELETE', 'ai-studio/key', { expectedRevision: state.keyRevision });
      Object.assign(state, { configured: false, last4: null, keyRevision: data.revision });
      keyStatus.show('keyRemoved'); paintState();
    } catch (error) { keyStatus.show(errorKey(error), {}, true); }
  });
  capForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!owner || !live()) return;
    const cap = Number(capInput.value);
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) { capStatus.show('eField', {}, true); capInput.setAttribute('aria-invalid', 'true'); return; }
    capInput.removeAttribute('aria-invalid');
    try {
      const data = await api('PATCH', 'ai-studio/settings', { dailyCallCap: cap, expectedRevision: state.settingRevision });
      Object.assign(state, { dailyCallCap: data.dailyCallCap, settingRevision: data.revision }); capStatus.show('capSaved'); paintState();
    } catch (error) { capStatus.show(errorKey(error), {}, true); }
  });

  photoInput.addEventListener('change', async () => {
    photoToken += 1; const mine = photoToken;
    photoData = null; draftForm.hidden = true; preview.hidden = true; photoStatus.show(null);
    const [file] = photoInput.files;
    fileName.textContent = file ? file.name : studioText('noFile');
    if (!file) return;
    try {
      const shrunk = await shrinkPhoto(file);
      if (mine !== photoToken) return;   // a newer photo was chosen meanwhile
      photoData = shrunk; preview.src = photoData; preview.hidden = false;
    } catch (error) { if (mine !== photoToken) return; photoStatus.show(error.key || 'eFile', {}, true); photoInput.value = ''; fileName.textContent = studioText('noFile'); }
  });
  readButton.addEventListener('click', async () => {
    if (!live() || readButton.disabled) return;
    if (!photoData) { photoStatus.show('eNoPhoto', {}, true); return; }
    readButton.disabled = true; photoStatus.show('working');
    const mine = photoToken, sent = photoData;
    try {
      const [suggestion, settings, list] = await Promise.all([api('POST', 'ai-studio/analyze', { imageDataUrl: photoData }),
        api('GET', 'company-settings').catch(() => ({})), api('GET', 'categories').catch(() => ({ items: [] }))]);
      if (!live() || mine !== photoToken || sent !== photoData) return;   // the photo changed while the AI was reading it
      currency = settings.defaultCurrency || 'MYR'; priceSpan.textContent = studioText('fPrice', { currency });
      categories = (list.items || []).filter((item) => item.active);
      inputs.category.replaceChildren(new Option(studioText('chooseCategory'), ''), ...categories.map((item) => new Option(item.label, item.code)));
      const tidy = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();   // the product form accepts single-line text only
      inputs.name.value = tidy(suggestion.name); inputs.description.value = tidy(suggestion.description); inputs.category.value = suggestion.category || '';
      inputs.sku.value = ''; inputs.price.value = ''; dirty = true;
      draftForm.hidden = false; photoStatus.show(null); inputs.name.focus(); reloadCounts();
    } catch (error) { photoStatus.show(errorKey(error), {}, true); reloadCounts(); }
    finally { readButton.disabled = false; }
  });
  draftForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!live() || saveDraft.disabled) return;
    const priceMinor = priceToMinor(inputs.price.value);
    if (priceMinor === null || !draftForm.reportValidity()) { inputs.price.setAttribute('aria-invalid', String(priceMinor === null)); draftStatus.show('eField', {}, true); return; }
    saveDraft.disabled = true;
    try {
      const product = await api('POST', 'products', { sku: inputs.sku.value.trim(), name: inputs.name.value.trim(), description: inputs.description.value.trim(),
        category: inputs.category.value, priceMinor, currency, active: false, imageDataUrl: photoData });
      dirty = false; photoStatus.show('draftSaved');
      draftForm.hidden = true; photoData = null; photoToken += 1; photoInput.value = ''; preview.hidden = true; fileName.textContent = studioText('noFile');   // no second save of the same suggestion
      choose({ id: product.id, name: product.name, active: false });
      genCard.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch (error) { draftStatus.show(errorKey(error), {}, true); if (error.field && inputs[error.field]) inputs[error.field].setAttribute('aria-invalid', 'true'); }
    finally { saveDraft.disabled = false; }
  });

  function setGenControls(disabled) {
    for (const control of [searchInput, searchButton, ...styleInputs, ...hits.querySelectorAll('button')]) control.disabled = disabled;
  }
  function choose(product) {
    chosenProduct = product; results.replaceChildren(); genStatus.show(product.active ? 'published' : null, {}, product.active);
    chosen.hidden = false; chosen.textContent = studioText('selected', { name: product.name }); styleBox.hidden = false; hits.replaceChildren();
    openProduct.hidden = false; paintCost();
  }
  async function search() {
    if (!live()) return;
    try {
      const data = await api('GET', `products?limit=8&search=${encodeURIComponent(searchInput.value.trim())}`);
      hits.replaceChildren();
      const items = data.items || [];
      if (!items.length) { const none = document.createElement('li'); none.textContent = studioText('noResults'); hits.append(none); return; }
      for (const item of items) {
        const row = document.createElement('li'); const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'secondary-button';
        pick.textContent = `${item.name} · ${item.sku}`; pick.addEventListener('click', () => choose({ id: item.id, name: item.name, active: Boolean(item.active) }));
        row.append(pick); hits.append(row);
      }
    } catch (error) { genStatus.show(errorKey(error), {}, true); }
  }
  searchButton.addEventListener('click', search);
  searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
  openProduct.addEventListener('click', () => { if (chosenProduct) onNavigate(`products/${chosenProduct.id}`); });

  function resultRow(style) {
    const row = document.createElement('li'); row.className = 'ai-studio-result'; row.dataset.style = style;
    const name = text('strong', `style_${style}`), status = text('span', 'waiting', 'ai-studio-result-status');
    const body = document.createElement('div'); body.className = 'ai-studio-result-body'; body.append(name, status);
    row.append(body); results.append(row);
    return { row, body, setStatus(key, values) { status.textContent = studioText(key, values); status.dataset.key = key; status.classList.toggle('is-error', key.startsWith('e') || key === 'failedItem' || key === 'published'); } };
  }
  generate.addEventListener('click', async () => {
    if (!live() || generate.disabled || !chosenProduct) return;
    const styles = styleInputs.filter((input) => input.checked).map((input) => input.value);
    if (!styles.length) { genStatus.show('ePicked', {}, true); return; }
    const target = { ...chosenProduct };   // later clicks cannot redirect a running batch to another product
    running = true; setGenControls(true); paintCost(); genStatus.show('working'); results.replaceChildren();
    const rows = styles.map(resultRow);
    try {
      for (let index = 0; index < styles.length; index += 1) {
        if (!live()) break;
        const item = rows[index]; item.setStatus('working');
        try {
          const made = await api('POST', `ai-studio/products/${target.id}/images`, { style: styles[index] });
          if (!live()) break;
          item.setStatus('done');
          const image = document.createElement('img'); image.className = 'ai-studio-thumb'; image.loading = 'lazy'; image.alt = studioText(`style_${styles[index]}`);
          image.src = apiUrl(`v1/seller/products/${target.id}/gallery/${made.galleryImageId}?size=thumb`);
          const badges = document.createElement('p'); badges.className = 'ai-studio-badges';
          const ai = document.createElement('span'); ai.className = 'ai-studio-badge'; ai.textContent = studioText('aiLabel');
          const verdict = document.createElement('span'); verdict.className = `ai-studio-badge verdict-${made.verdict || 'NONE'}`; verdict.textContent = made.verdict ? studioText(`v${made.verdict}`) : studioText('unreviewed');
          badges.append(ai, verdict);
          item.body.prepend(image); item.body.append(badges);
          if (made.issues?.length) { const issues = document.createElement('ul'); issues.className = 'ai-studio-issues'; for (const issue of made.issues) { const li = document.createElement('li'); li.textContent = issue; issues.append(li); } item.body.append(issues); }
        } catch (error) {
          item.setStatus(errorKey(error));
          if (error.status === 401 || STOPS.has(error.code)) { rows.slice(index + 1).forEach((rest) => rest.row.remove()); break; }
        }
      }
    } finally { running = false; if (live()) { setGenControls(false); paintCost(); genStatus.show(null); reloadCounts(); } }
  });

  load().then(() => { if (initialProductId && live() && state.configured) api('GET', `products/${initialProductId}`).then((p) => choose({ id: p.id, name: p.name, active: Boolean(p.active) })).catch(() => {}); });
  return {
    dispose() { disposed = true; page.remove(); },
    refreshLocale() { translate(page); refreshers.forEach((paint) => paint()); if (chosenProduct) chosen.textContent = studioText('selected', { name: chosenProduct.name }); paintState(); },
    hasUnsavedChanges: () => dirty && !draftForm.hidden,
    isBusy: () => busy > 0,
  };
}
