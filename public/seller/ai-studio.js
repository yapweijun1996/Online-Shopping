// AI Studio page: the shop's OpenAI key (Owner), a product draft made from one photo, and styled images for a draft.
// Everything the server or the AI returns is shown with textContent only. Nothing here publishes a product.
import { studioText, STUDIO_STYLES } from './ai-studio-copy.js';
import './p1-copy.js';
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
  const live = () => !disposed && root.isConnected && root.contains(page) && identity === csrfToken();
  const refreshers = [];
  const state = { available: false, configured: false, last4: null, usedToday: null, dailyCallCap: null, keyRevision: 0, settingRevision: 1 };
  let chosenProduct = null, photoData = null, currency = 'MYR', categories = [];
  let searchToken = 0, loaded = false;
  let task = initialProductId ? 'images' : 'create', processingPhoto = false, analyzing = false, savedDraft = null;
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
  const photoInput = document.createElement('input'); photoInput.type = 'file'; photoInput.accept = 'image/png,image/jpeg,image/webp'; photoInput.className = 'ai-studio-file'; photoInput.tabIndex = -1;   // visually hidden; the native choose button opens this input
  const pickLabel = button('choosePhoto', 'secondary-button ai-studio-pick', 'M12 16V4M7 9l5-5 5 5M4 20h16');
  pickLabel.addEventListener('click', () => photoInput.click());
  const dropZone = document.createElement('div'); dropZone.className = 'ai-studio-drop';
  const replacePhoto = button('replacePhoto'), removePhoto = button('removePhoto');
  replacePhoto.addEventListener('click', () => photoInput.click());
  const photoActions = document.createElement('div'); photoActions.className = 'ai-studio-actions'; photoActions.append(replacePhoto, removePhoto);
  const previewHint = text('p', 'previewHint', 'ai-studio-note');
  dropZone.append(text('p', 'dropHint', 'ai-studio-note'), pickLabel, photoInput);
  const fileName = text('p', 'noFile', 'ai-studio-note ai-studio-filename');
  const preview = document.createElement('img'); preview.className = 'ai-studio-preview'; preview.alt = studioText('source'); preview.hidden = true;
  refreshers.push(() => { preview.alt = studioText('source'); });
  const readButton = button('analyzePhoto', 'primary-button', 'M4 7h3l2-3h6l2 3h3v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
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
  photoCard.append(text('p', 'photoHelp', 'ai-studio-note'), dropZone, fileName, previewHint, preview, photoActions, text('p', 'analyzeCost', 'ai-studio-note'), readButton, photoStatus, draftForm);

  // Images for a draft
  const genCard = card('genTitle');
  const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.maxLength = 100; searchInput.autocomplete = 'off';
  const searchButton = button('searchGo', 'secondary-button');
  const searchRow = document.createElement('div'); searchRow.className = 'ai-studio-search'; searchRow.append(field('search', searchInput), searchButton);
  const hits = document.createElement('ul'); hits.className = 'ai-studio-hits';
  const chosen = text('p', 'selected', 'ai-studio-selected', () => ({ name: chosenProduct ? `${chosenProduct.name}${chosenProduct.sku ? ` · ${chosenProduct.sku}` : ''}` : '' })); chosen.hidden = true;
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
  // Keep both task trees mounted so switching tasks never discards drafts or results.
  const settings = document.createElement('details'); settings.className = 'ai-studio-settings';
  settings.append(text('summary', 'keyTitle'), usageCard);
  const tabs = document.createElement('div'); tabs.className = 'ai-studio-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', studioText('nav'));
  refreshers.push(() => tabs.setAttribute('aria-label', studioText('nav')));
  const createTab = button('createTask'), imagesTab = button('imagesTask');
  const panels = [photoCard, genCard], taskTabs = [createTab, imagesTab];
  panels.forEach((panel, index) => {
    panel.id = index ? 'ai-images-panel' : 'ai-create-panel'; panel.setAttribute('role', 'tabpanel');
    const tab = taskTabs[index]; tab.id = `${panel.id}-tab`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
    tab.addEventListener('click', () => selectTask(index ? 'images' : 'create'));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      selectTask(next ? 'images' : 'create'); taskTabs[next].focus();
    }); tabs.append(tab);
  });
  function steps(keys) {
    const list = document.createElement('ol'); list.className = 'ai-studio-steps';
    keys.forEach(key => list.append(text('li', key))); return list;
  }
  const createSteps = steps(['stepUpload', 'stepAnalyze', 'stepSave']), imageSteps = steps(['stepProduct', 'stepStyle', 'stepGenerate']);
  function pane(key) { const node = document.createElement('section'); node.className = 'ai-studio-pane'; node.append(text('h3', key)); return node; }
  const sourcePane = pane('source'), suggestionPane = pane('suggestions'), imageSourcePane = pane('stepProduct'), outputPane = pane('output');
  const createEmpty = text('p', 'createEmpty', 'ai-studio-note'), imageEmpty = text('p', 'imagesEmpty', 'ai-studio-note');
  const photoReason = liveLine(); photoReason.id = 'ai-photo-reason'; readButton.setAttribute('aria-describedby', photoReason.id);
  const genReason = liveLine(); genReason.id = 'ai-gen-reason'; generate.setAttribute('aria-describedby', genReason.id);
  sourcePane.append(...[...photoCard.children].filter(node => node.tagName !== 'H2' && node !== photoStatus && node !== draftForm), photoReason);
  const savedActions = document.createElement('div'); savedActions.className = 'ai-studio-actions'; savedActions.hidden = true;
  const editSaved = button('editSaved'), imagesSaved = button('imagesSaved'); savedActions.append(editSaved, imagesSaved);
  editSaved.addEventListener('click', () => { if (savedDraft) onNavigate(`products/${savedDraft.id}`); });
  imagesSaved.addEventListener('click', () => { if (savedDraft && !running) { choose(savedDraft); selectTask('images'); imagesTab.focus(); } });
  suggestionPane.append(text('p', 'reviewNote', 'ai-studio-note'), createEmpty, photoStatus, draftForm, savedActions);
  imageSourcePane.append(genNote, searchRow, hits, chosen, styleBox, cost, generate, genReason);
  outputPane.append(text('p', 'reviewNote', 'ai-studio-note'), imageEmpty, genStatus, results, openProduct);
  photoCard.append(createSteps, sourcePane, suggestionPane); genCard.append(imageSteps, imageSourcePane, outputPane);
  styleBox.hidden = false;
  keyForm.hidden = true; capForm.hidden = true; removeKey.hidden = true;
  page.append(intro, unavailable, tabs, photoCard, genCard, settings);
  root.replaceChildren(page);
  function selectTask(next) { task = next; paintWorkspace(); }
  function markStep(list, current) { [...list.children].forEach((item, index) => { if (index === current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); }); }
  function paintWorkspace() {
    panels.forEach((panel, index) => { const selected = task === (index ? 'images' : 'create'); panel.hidden = !selected; taskTabs[index].setAttribute('aria-selected', String(selected)); taskTabs[index].tabIndex = selected ? 0 : -1; });
    markStep(createSteps, !draftForm.hidden || savedDraft ? 2 : photoData || analyzing ? 1 : 0);
    markStep(imageSteps, results.children.length || running ? 2 : chosenProduct ? 1 : 0);
    createEmpty.hidden = !draftForm.hidden || analyzing || Boolean(savedDraft);
    imageEmpty.hidden = running || results.children.length > 0;
  }
  function usageKnown() { return Number.isInteger(state.usedToday) && Number.isInteger(state.dailyCallCap); }
  function eligibility(calls) {
    return !loaded ? 'working' : !state.available ? 'unavailable' : !state.configured ? 'eNoKey' : state.usedToday + calls > state.dailyCallCap ? 'eCap' : null;
  }
  function paintCost() {
    const n = styleInputs.filter(input => input.checked).length;
    cost.textContent = loaded && usageKnown() ? studioText('cost', { n, calls: n * 2, left: Math.max(0, state.dailyCallCap - state.usedToday) }) : studioText(loaded ? 'unavailable' : 'working');
    const genBlocked = running ? 'working' : eligibility(n * 2) || (!chosenProduct ? 'noProduct' : chosenProduct.active ? 'published' : !n ? 'ePicked' : null);
    generate.disabled = Boolean(genBlocked); genReason.show(genBlocked);
    const photoBlocked = processingPhoto || analyzing || saveDraft.disabled ? 'working' : eligibility(1) || (!photoData ? 'eNoPhoto' : null);
    readButton.disabled = Boolean(photoBlocked); photoReason.show(photoBlocked);
    previewHint.hidden = Boolean(photoData); photoActions.hidden = !photoData;
    pickLabel.hidden = Boolean(photoData); savedActions.hidden = !savedDraft;
    imagesSaved.disabled = running;
    for (const control of [photoInput, pickLabel, replacePhoto, removePhoto]) control.disabled = saveDraft.disabled;
    paintWorkspace();
  }
  function paintState() {
    unavailable.hidden = !loaded || state.available;
    usageLine.textContent = state.configured ? studioText('keySaved', { last4: state.last4 ?? '' }) : studioText('keyNone');
    usageCount.textContent = loaded && usageKnown() ? studioText('usage', { used: state.usedToday, cap: state.dailyCallCap }) : studioText(loaded ? 'unavailable' : 'working');
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
    if (!live()) return;
    loaded = true; paintState();
  }
  const reloadCounts = () => api('GET', 'ai-studio').then((data) => { if (!live()) return; Object.assign(state, { usedToday: data.usedToday, dailyCallCap: data.dailyCallCap, configured: data.configured }); paintState(); }).catch(() => {});

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

  async function setPhoto(file, action = 'replacePhoto') {
    if (!live() || saveDraft.disabled) return;
    // Claim intent before the asynchronous confirmation and decoding: newest intent wins.
    const mine = ++photoToken;
    if (dirty && !draftForm.hidden && !await confirmModal(studioText('discardPhoto'), { title: studioText(action), confirmLabel: studioText(action) })) { photoInput.value = ''; return; }
    if (!live() || mine !== photoToken) return;
    photoData = null; dirty = false; savedDraft = null; draftForm.hidden = true; preview.hidden = true; preview.removeAttribute('src'); photoStatus.show(null);
    fileName.textContent = file ? file.name : studioText('noFile'); photoInput.value = '';
    processingPhoto = Boolean(file); paintCost();
    if (!file) return;
    try {
      const shrunk = await shrinkPhoto(file);
      if (!live() || mine !== photoToken) return;
      photoData = shrunk; preview.src = photoData; preview.hidden = false;
    } catch (error) {
      if (!live() || mine !== photoToken) return;
      photoStatus.show(error.key || 'eFile', {}, true); fileName.textContent = studioText('noFile');
    } finally { if (mine === photoToken && live()) { processingPhoto = false; paintCost(); } }
  }
  photoInput.addEventListener('change', () => setPhoto(photoInput.files[0]));
  removePhoto.addEventListener('click', () => setPhoto(null, 'removePhoto'));
  for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.add('is-dragging'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
  dropZone.addEventListener('drop', event => { event.preventDefault(); dropZone.classList.remove('is-dragging'); if (event.dataTransfer?.files.length) setPhoto(event.dataTransfer.files[0]); });
  readButton.addEventListener('click', async () => {
    if (!live() || readButton.disabled) return;
    if (!photoData) { photoStatus.show('eNoPhoto', {}, true); return; }
    analyzing = true; paintCost(); photoStatus.show('working');
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
      draftForm.hidden = false; photoStatus.show(null); if (task === 'create') inputs.name.focus();
    } catch (error) { if (live() && mine === photoToken && sent === photoData) photoStatus.show(errorKey(error), {}, true); }
    finally { analyzing = false; if (live()) { paintCost(); reloadCounts(); } }
  });
  draftForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!live() || saveDraft.disabled) return;
    const priceMinor = priceToMinor(inputs.price.value);
    if (priceMinor === null || !draftForm.reportValidity()) { inputs.price.setAttribute('aria-invalid', String(priceMinor === null)); draftStatus.show('eField', {}, true); return; }
    saveDraft.disabled = true; for (const input of Object.values(inputs)) input.disabled = true; paintCost();
    try {
      const product = await api('POST', 'products', { sku: inputs.sku.value.trim(), name: inputs.name.value.trim(), description: inputs.description.value.trim(),
        category: inputs.category.value, priceMinor, currency, active: false, imageDataUrl: photoData });
      if (!live()) return;
      dirty = false; photoStatus.show('draftSaved');
      draftForm.hidden = true; photoData = null; photoToken += 1; photoInput.value = ''; preview.hidden = true; fileName.textContent = studioText('noFile');   // no second save of the same suggestion
      savedDraft = product; paintCost();
    } catch (error) { draftStatus.show(errorKey(error), {}, true); if (error.field && inputs[error.field]) inputs[error.field].setAttribute('aria-invalid', 'true'); }
    finally { saveDraft.disabled = false; for (const input of Object.values(inputs)) input.disabled = false; if (live()) paintCost(); }
  });

  function setGenControls(disabled) {
    for (const control of [searchInput, searchButton, ...styleInputs, ...hits.querySelectorAll('button')]) control.disabled = disabled;
  }
  function choose(product) {
    if (!live() || running) return;
    searchToken++;
    chosenProduct = product; results.replaceChildren(); genStatus.show(product.active ? 'published' : null, {}, product.active);
    chosen.hidden = false; chosen.textContent = studioText('selected', { name: `${product.name}${product.sku ? ` · ${product.sku}` : ''}` }); styleBox.hidden = false; hits.replaceChildren();
    openProduct.hidden = false; paintCost();
  }
  async function search() {
    if (!live() || running) return;
    const mine = ++searchToken;
    try {
      const data = await api('GET', `products?limit=8&search=${encodeURIComponent(searchInput.value.trim())}`);
      if (!live() || running || mine !== searchToken) return;
      hits.replaceChildren();
      const items = data.items || [];
      if (!items.length) { const none = document.createElement('li'); none.textContent = studioText('noResults'); hits.append(none); return; }
      for (const item of items) {
        const row = document.createElement('li'); const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'secondary-button';
        pick.textContent = `${item.name} · ${item.sku}`; pick.addEventListener('click', () => choose({ id: item.id, name: item.name, sku: item.sku, active: Boolean(item.active) }));
        row.append(pick); hits.append(row);
      }
    } catch (error) { if (live() && !running && mine === searchToken) genStatus.show(errorKey(error), {}, true); }
  }
  searchButton.addEventListener('click', search);
  searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
  openProduct.addEventListener('click', () => { if (chosenProduct) onNavigate(`products/${chosenProduct.id}`); });

  function resultRow(style) {
    const row = document.createElement('li'); row.className = 'ai-studio-result'; row.dataset.style = style;
    const name = text('strong', `style_${style}`), status = document.createElement('span'); status.className = 'ai-studio-result-status';
    let currentKey = 'waiting', currentValues;
    const paintStatus = () => { status.textContent = studioText(currentKey, currentValues); status.dataset.key = currentKey; status.classList.toggle('is-error', currentKey.startsWith('e') || currentKey === 'failedItem' || currentKey === 'published'); };
    paintStatus(); refreshers.push(paintStatus);
    const body = document.createElement('div'); body.className = 'ai-studio-result-body'; body.append(name, status);
    row.append(body); results.append(row);
    return { row, body, setStatus(key, values) { currentKey = key; currentValues = values; paintStatus(); } };
  }
  generate.addEventListener('click', async () => {
    if (!live() || generate.disabled || !chosenProduct) return;
    const styles = styleInputs.filter((input) => input.checked).map((input) => input.value);
    if (!styles.length) { genStatus.show('ePicked', {}, true); return; }
    const target = { ...chosenProduct };   // later clicks cannot redirect a running batch to another product
    searchToken++; running = true; setGenControls(true); paintCost(); genStatus.show('working'); results.replaceChildren();
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
          refreshers.push(() => { image.alt = studioText(`style_${styles[index]}`); });
          image.src = apiUrl(`v1/seller/products/${target.id}/gallery/${made.galleryImageId}?size=thumb`);
          const badges = document.createElement('p'); badges.className = 'ai-studio-badges';
          const ai = text('span', 'aiLabel', 'ai-studio-badge');
          const verdict = text('span', made.verdict ? `v${made.verdict}` : 'unreviewed', `ai-studio-badge verdict-${made.verdict || 'NONE'}`);
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

  paintState();
  const initialLookupToken = searchToken;
  load().then(async () => {
    if (!initialProductId || !live() || !state.configured || initialLookupToken !== searchToken) return;
    try {
      const product = await api('GET', `products/${initialProductId}`);
      if (live() && initialLookupToken === searchToken && !running) choose({ id: product.id, name: product.name, sku: product.sku, active: Boolean(product.active) });
    } catch { /* Search remains available if the initial product is no longer accessible. */ }
  });
  return {
    dispose() { disposed = true; photoToken++; page.remove(); },
    refreshLocale() { translate(page); refreshers.forEach((paint) => paint()); if (chosenProduct) chosen.textContent = studioText('selected', { name: `${chosenProduct.name}${chosenProduct.sku ? ` · ${chosenProduct.sku}` : ''}` }); paintState(); },
    hasUnsavedChanges: () => dirty && !draftForm.hidden,
    isBusy: () => busy > 0,
  };
}
