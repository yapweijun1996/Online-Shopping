import { apiUrl } from '../shared/base-path.js';
import { renderProductDetail } from '../shared/product-detail.js';
import { editorText as copy } from './product-editor-copy.js';

const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
const labelText = (tag, key, className = '') => { const el = node(tag, className, copy(key)); el.dataset.i18n = `pedit_${key}`; return el; };
function control(key, action, className = 'secondary-button') {
  const button = labelText('button', key, className); button.type = 'button'; button.addEventListener('click', action); return button;
}
async function imageFile(file) {
  if (!file || file.size > 512 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('imageLimit');
  // Decode locally before staging: header-only server validation cannot prove a usable browser image.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height || bitmap.width > 32768 || bitmap.height > 32768 || bitmap.width * bitmap.height > 40000000) throw new Error('imageDecode');
  } catch { throw new Error('imageDecode'); }
  finally { bitmap?.close(); }
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('failed')); reader.readAsDataURL(file); });
}

export function mountProductDetailEditor({ api, isCurrent, fallbackText = () => '' }) {
  const root = node('section', 'product-rich-editor'); root.id = 'product-rich-editor';
  const help = labelText('p', 'detailHelp', 'shop-note');
  const note = labelText('p', 'saveFirst', 'shop-note');
  const protectedNote = node('details', 'product-editor-assistant-note'); protectedNote.append(labelText('summary', 'assistantInfo'), labelText('p', 'protected', 'shop-note'));
  const toolbar = node('div', 'product-rich-toolbar');
  const kind = document.createElement('select'); kind.id = 'product-detail-block-kind';
  kind.setAttribute('aria-label', copy('add'));
  for (const key of ['heading', 'paragraph', 'list', 'image', 'specs']) { const option = labelText('option', key); option.value = key; kind.append(option); }
  const upload = document.createElement('input'); upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp'; upload.hidden = true; upload.id = 'product-detail-upload';
  const add = control('add', () => { if (kind.value === 'image') upload.click(); else addBlock(kind.value); });
  toolbar.append(kind, add, upload);
  const blocks = node('div', 'product-rich-blocks'); blocks.id = 'product-detail-blocks';
  const state = node('p', 'message'); state.id = 'product-detail-status'; state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
  const actions = node('div', 'product-rich-actions');
  const save = control('saveDetail', () => saveDetail(), 'primary-button'); save.id = 'product-detail-save';
  const reload = control('reload', () => { if (!dirty() || window.confirm(copy('conflict'))) load(productId); }); reload.id = 'product-detail-reload';
  actions.append(save, reload);
  const previewSection = node('section', 'product-rich-preview-section');
  const previewHeading = labelText('h3', 'preview'); previewHeading.id = 'product-detail-preview-title';
  const previewModes = node('div', 'product-rich-preview-modes'); previewModes.setAttribute('role', 'group'); previewModes.setAttribute('aria-label', copy('preview'));
  const preview = node('div', 'product-rich-preview'); preview.id = 'product-detail-preview';
  const modes = ['desktop', 'mobile'].map((mode) => control(mode, () => { preview.dataset.mode = mode; modes.forEach((button, i) => button.setAttribute('aria-pressed', String(['desktop', 'mobile'][i] === mode))); }));
  modes[0].setAttribute('aria-pressed', 'true'); modes[1].setAttribute('aria-pressed', 'false'); preview.dataset.mode = 'desktop';
  previewModes.append(...modes); previewSection.setAttribute('aria-labelledby', previewHeading.id); previewSection.append(previewHeading, previewModes, preview);
  root.append(help, protectedNote, note, toolbar, blocks, state, actions, previewSection);
  let stagedIds = new Set();
  let productId = null, revision = null, baseline = '', data = { version: 1, blocks: [] }, assets = [], active = false, loaded = false, sequence = 0, statusKey = '';
  const dirty = () => loaded && baseline !== JSON.stringify(data);
  const notify = () => document.dispatchEvent(new Event('updateguardchange'));
  const owns = (id, seq) => isCurrent() && productId === id && seq === sequence;
  function message(key) { statusKey = key; state.textContent = key ? copy(key) : ''; state.classList.toggle('product-rich-error', ['failed', 'conflict', 'invalid', 'imageLimit', 'imageDecode', 'blockLimit'].includes(key)); }
  function renderPreview() { preview.replaceChildren(renderProductDetail(data, assets, { fallbackText: fallbackText() })); }
  function controls() {
    note.hidden = Boolean(productId); toolbar.hidden = !productId; actions.hidden = !productId;
    add.disabled = active || !loaded; kind.disabled = active || !loaded; save.disabled = active || !loaded || !dirty(); reload.disabled = active;
    blocks.querySelectorAll('input,textarea,button').forEach((el) => { el.disabled = active || !loaded || el.dataset.edge === 'true'; });
  }
  function changed() { message(dirty() ? 'unsaved' : ''); renderPreview(); controls(); notify(); }
  function addBlock(type, values = {}) {
    if (data.blocks.length >= 40 || (type === 'image' && data.blocks.filter((block) => block.type === 'image').length >= 20)) { message('blockLimit'); return; }
    const defaults = { heading: { text: '' }, paragraph: { text: '', bold: false }, list: { items: [''] }, specs: { rows: [{ label: '', value: '' }] } };
    data.blocks.push({ type, ...(defaults[type] || {}), ...values }); renderBlocks(); changed(); blocks.lastElementChild?.querySelector('textarea,input')?.focus();
  }
  function field(card, key, value, update, { multiline = false, maxLength = 4000 } = {}) {
    const label = node('label'); label.append(labelText('span', key));
    const input = document.createElement(multiline ? 'textarea' : 'input'); input.value = value; input.maxLength = maxLength; if (multiline) input.rows = 3;
    input.addEventListener('input', () => { update(input.value); changed(); }); label.append(input); card.append(label); return input;
  }
  function renderBlocks() {
    blocks.replaceChildren();
    if (!data.blocks.length) { blocks.append(labelText('p', 'empty', 'shop-note')); return; }
    data.blocks.forEach((block, index) => {
      const card = node('section', 'product-rich-block'); card.dataset.block = String(index);
      const head = node('div', 'product-rich-block-head'); const title = node('h4', '', `${index + 1}. ${copy(block.type)}`); title.dataset.blockTitle = block.type;
      const buttons = node('div', 'product-rich-block-actions');
      for (const [key, delta] of [['up', -1], ['down', 1]]) {
        const move = control(key, () => { const next = index + delta; [data.blocks[index], data.blocks[next]] = [data.blocks[next], data.blocks[index]]; renderBlocks(); changed(); blocks.children[next]?.querySelector('button')?.focus(); });
        move.dataset.edge = String(index + delta < 0 || index + delta >= data.blocks.length); move.setAttribute('aria-label', `${copy(key)}: ${index + 1}`); buttons.append(move);
      }
      buttons.append(control('remove', () => removeBlock(index))); head.append(title, buttons); card.append(head);
      if (block.type === 'heading' || block.type === 'paragraph') {
        field(card, 'text', block.text, (value) => { block.text = value; }, { multiline: block.type === 'paragraph', maxLength: block.type === 'heading' ? 240 : 5000 });
        if (block.type === 'paragraph') { const label = node('label', 'check-row'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(block.bold); input.addEventListener('change', () => { block.bold = input.checked; changed(); }); label.append(input, labelText('span', 'bold')); card.append(label); }
      } else if (block.type === 'list') field(card, 'items', block.items.join('\n'), (value) => { block.items = value.split('\n'); }, { multiline: true, maxLength: 10000 });
      else if (block.type === 'specs') field(card, 'rows', block.rows.map((row) => `${row.label} | ${row.value}`).join('\n'), (value) => { block.rows = value.split('\n').map((line) => { const [label, ...rest] = line.split('|'); return { label: label.trim(), value: rest.join('|').trim() }; }); }, { multiline: true, maxLength: 10000 });
      else if (block.type === 'image') {
        card.append(renderProductDetail({ version: 1, blocks: [block] }, assets));
        field(card, 'alt', block.alt, (value) => { block.alt = value; }, { maxLength: 500 });
        field(card, 'caption', block.caption, (value) => { block.caption = value; }, { maxLength: 1000 });
      }
      blocks.append(card);
    }); controls();
  }
  async function removeBlock(index) {
    if (active || !loaded) return;
    const block = data.blocks[index], id = productId, seq = sequence;
    if (block.type === 'image' && stagedIds.has(block.assetId) && !data.blocks.some((item, i) => i !== index && item.type === 'image' && item.assetId === block.assetId)) {
      active = true; controls(); notify();
      try {
        await api('DELETE', apiUrl(`v1/seller/products/${id}/detail/images/${block.assetId}`));
        if (!owns(id, seq)) return; stagedIds.delete(block.assetId); assets = assets.filter((asset) => asset.id !== block.assetId);
      } catch (failure) { if (!owns(id, seq)) return; if (failure.code !== 'DETAIL_IMAGE_IN_USE' && failure.status !== 404) { message('failed'); return; } stagedIds.delete(block.assetId); if (failure.status === 404) assets = assets.filter((asset) => asset.id !== block.assetId); }
      finally { if (owns(id, seq)) { active = false; controls(); notify(); } }
    }
    if (!owns(id, seq)) return; data.blocks.splice(index, 1); renderBlocks(); changed(); add.focus();
  }
  async function load(id, { preserve = false } = {}) {
    if (preserve && productId === id && loaded) { renderBlocks(); renderPreview(); controls(); return; }
    productId = id; const seq = ++sequence; loaded = false; revision = null; baseline = ''; data = { version: 1, blocks: [] }; assets = []; stagedIds = new Set(); active = false; renderBlocks(); renderPreview(); message(id ? 'loading' : ''); controls();
    if (!id) return;
    try {
      const result = await api('GET', apiUrl(`v1/seller/products/${id}/detail`)); if (!owns(id, seq)) return;
      data = structuredClone(result.document); assets = result.assets; revision = result.revision; loaded = true; baseline = JSON.stringify(data); renderBlocks(); renderPreview(); message('');
    } catch { if (owns(id, seq)) message('failed'); }
    finally { if (owns(id, seq)) { controls(); notify(); } }
  }
  async function saveDetail() {
    if (active || !loaded || !dirty()) return;
    const id = productId, seq = sequence;
    const valid = data.blocks.every((block) => (block.type === 'heading' || block.type === 'paragraph') ? block.text.trim() : block.type === 'image' ? block.alt.trim() : block.type === 'list' ? block.items.length && block.items.length <= 30 && block.items.every((item) => item.trim() && item.length <= 500) : block.rows.length && block.rows.length <= 30 && block.rows.every((row) => row.label.trim() && row.value.trim() && row.label.length <= 120 && row.value.length <= 500));
    if (!valid || JSON.stringify(data).length > 160000 || data.blocks.reduce((sum, block) => sum + (block.text?.length || 0) + (block.alt?.length || 0) + (block.caption?.length || 0) + (block.items || []).reduce((n, item) => n + item.length, 0) + (block.rows || []).reduce((n, row) => n + row.label.length + row.value.length, 0), 0) > 50000) { message('invalid'); return; }
    active = true; controls(); message('working'); notify();
    try {
      const result = await api('PUT', apiUrl(`v1/seller/products/${id}/detail`), { expectedRevision: revision, document: data });
      if (!owns(id, seq)) return;
      revision = result.revision; data = structuredClone(result.document); assets = result.assets; stagedIds.clear(); baseline = JSON.stringify(data); renderBlocks(); renderPreview(); message('saved');
    } catch (failure) { if (owns(id, seq)) message(failure.status === 409 ? 'conflict' : failure.status === 422 || failure.status === 400 ? 'invalid' : 'failed'); }
    finally { if (owns(id, seq)) { active = false; controls(); notify(); } }
  }
  upload.addEventListener('change', async () => {
    const file = upload.files[0]; upload.value = ''; if (!file || active || !loaded) return;
    if (data.blocks.length >= 40 || data.blocks.filter((block) => block.type === 'image').length >= 20) { message('blockLimit'); return; }
    const id = productId, seq = sequence; active = true; controls(); message('working'); notify();
    try {
      const imageDataUrl = await imageFile(file); if (!owns(id, seq)) return;
      const asset = await api('POST', apiUrl(`v1/seller/products/${id}/detail/images`), { imageDataUrl });
      if (!owns(id, seq)) return; assets.push(asset); stagedIds.add(asset.id); addBlock('image', { assetId: asset.id, alt: '', caption: '' });
    } catch (failure) { if (owns(id, seq)) message(['imageLimit', 'imageDecode'].includes(failure.message) ? failure.message : 'failed'); }
    finally { if (owns(id, seq)) { active = false; controls(); notify(); } }
  });
  function refreshLocale() {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = copy(el.dataset.i18n.slice(6));
    for (const el of root.querySelectorAll('[data-block-title]')) el.textContent = `${Number(el.closest('[data-block]').dataset.block) + 1}. ${copy(el.dataset.blockTitle)}`;
    for (const el of root.querySelectorAll('[data-edge]')) el.setAttribute('aria-label', `${copy(el.dataset.i18n.slice(6))}: ${Number(el.closest('[data-block]').dataset.block) + 1}`);
    kind.setAttribute('aria-label', copy('add')); previewModes.setAttribute('aria-label', copy('preview')); message(statusKey); renderPreview();
  }
  return { root, load, refreshLocale, dirty, busy: () => active, signature: () => JSON.stringify([productId, data]), refreshPreview: renderPreview };
}
