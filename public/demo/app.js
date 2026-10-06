import { createModal } from '../shared/modal.js';
import { mountAppearance } from '../shared/appearance.js';

const byId = id => document.getElementById(id);
let session, companies = [], selectedCompany, view = 'products', sequence = 0, busy = false;
const status = message => { byId('demo-status').textContent = message; };
const node = (tag, text, className = '') => { const item = document.createElement(tag); item.textContent = text; item.className = className; return item; };
const button = (text, action) => { const item = node('button', text); item.type = 'button'; item.addEventListener('click', action); return item; };
function fail(error) {
  status(error.code === 'COMPANY_CURRENCY_CONFLICT' ? 'Existing products use another currency. Review prices before changing company currency.' : error.message);
  if (error.status === 401) { byId('demo-workspace').hidden = true; byId('demo-restart').hidden = false; }
}
async function api(method, path, body) {
  const result = await fetch(`/api/v1/demo/${path}`, { method, cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': session?.csrfToken || '' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await result.json();
  if (!result.ok) throw Object.assign(new Error(data.error?.message || 'Preview unavailable.'), { status: result.status, code: data.error?.code });
  return data;
}
function companyPath(collection = '') { return `companies/${selectedCompany.id}${collection ? `/${collection}` : ''}`; }
async function mutation(action) {
  if (busy) return; busy = true;
  const controls = [...document.querySelectorAll('button, input, select, textarea')].map(control => [control, control.disabled]);
  for (const [control] of controls) control.disabled = true;
  try { await action(); } catch (error) { fail(error); }
  finally { busy = false; for (const [control, disabled] of controls) if (control.isConnected) control.disabled = disabled; }
}
function syncCompany() {
  selectedCompany = companies.find(company => company.id === byId('demo-company').value) || companies[0];
  byId('demo-company').value = selectedCompany.id;
  const form = byId('demo-settings-form');
  form.elements.name.value = selectedCompany.name; form.elements.currency.value = selectedCompany.currency; form.elements.active.checked = selectedCompany.active;
}
async function loadCompanies() {
  const current = selectedCompany?.id;
  companies = (await api('GET', 'companies')).items;
  byId('demo-company').replaceChildren(...companies.map(company => new Option(`${company.name} · ${company.currency}${company.active ? '' : ' · disabled'}`, company.id)));
  if (companies.some(company => company.id === current)) byId('demo-company').value = current;
  syncCompany();
}
async function loadSellers() {
  if (session.role !== 'ADMIN') return;
  const sellers = (await api('GET', 'sellers')).items;
  byId('demo-sellers').replaceChildren(...sellers.map(seller => {
    const row = node('article', '', 'seller-row');
    row.append(node('strong', seller.name), node('span', companies.find(company => company.id === seller.companyId)?.name || seller.companyId));
    row.append(button(seller.active ? 'Disable preview access' : 'Enable preview access', () => mutation(async () => {
      await api('PATCH', `sellers/${seller.id}`, { active: !seller.active, expectedRevision: seller.revision }); await loadSellers(); status('Fictional access updated.');
    })));
    if (seller.active) row.append(button('View as this seller', () => mutation(async () => {
      const next = await api('POST', 'assume-seller', { sellerId: seller.id }); session = { ...session, ...next };
      byId('demo-admin').hidden = true; byId('demo-role').textContent = 'Seller preview · fictional';
      await loadCompanies(); await loadResources(); status('Seller view uses this membership only. New Admin login starts a fresh workspace.');
    })));
    return row;
  }));
}
async function loadResources() {
  const request = ++sequence, companyId = selectedCompany.id, requestedView = view;
  status('Loading fictional records…');
  try {
    const result = await api('GET', companyPath(view));
    if (request !== sequence || selectedCompany.id !== companyId || view !== requestedView) return;
    byId('demo-resource-title').textContent = view[0].toUpperCase() + view.slice(1);
    byId('demo-new-product').hidden = view !== 'products';
    byId('demo-resources').replaceChildren(...result.items.map(record => {
      const card = node('article', '', 'demo-card');
      if (view === 'products') {
        if (record.images[0]) { const image = document.createElement('img'); image.src = record.images[0]; image.alt = record.name; card.append(image); }
        card.append(node('h3', record.name), node('p', `${record.sku} · ${record.currency} ${(record.priceMinor / 100).toFixed(2)} · ${record.active ? 'Active' : 'Inactive'}`), button('Edit product', () => editProduct(record)));
      } else if (view === 'orders') card.append(node('h3', record.orderNo), node('p', `${record.status} · ${record.currency} ${(record.totalMinor / 100).toFixed(2)}`), button('Review order', () => reviewOrder(record)));
      else card.append(node('h3', record.fullName), node('p', record.email));
      return card;
    }));
    status(`${result.items.length} fictional ${view} in ${selectedCompany.name}.`);
  } catch (error) { if (request === sequence) fail(error); }
}
function editProduct(record) {
  const modal = createModal(), company = selectedCompany;
  const form = document.createElement('form'); form.id = 'demo-product-form';
  const input = (name, label, value = '', tag = 'input') => {
    const wrap = node('label', label), control = document.createElement(tag); control.name = name; control.value = value; control.required = true; wrap.append(control); form.append(wrap); return control;
  };
  input('sku', 'SKU', record?.sku || '').maxLength = 40;
  input('name', 'Name', record?.name || '').maxLength = 120;
  input('description', 'Description', record?.description || '', 'textarea').maxLength = 2000;
  input('category', 'Category', record?.category || 'GENERAL').maxLength = 80;
  const price = input('price', 'Price', record ? (record.priceMinor / 100).toFixed(2) : ''); price.inputMode = 'decimal';
  input('currency', 'Currency · inherited from Company Settings', company.currency).readOnly = true;
  const activeLabel = node('label', '', 'check-row'), active = document.createElement('input'); active.type = 'checkbox'; active.checked = record?.active ?? true; active.name = 'active';
  activeLabel.append(active, node('span', 'Active')); form.append(activeLabel);
  if (record) {
    const gallery = node('div', '', 'demo-gallery');
    for (const [index, source] of record.images.entries()) {
      const figure = document.createElement('figure'), image = document.createElement('img'); image.src = source; image.alt = `${record.name}, photo ${index + 1}`;
      figure.append(image, node('figcaption', index ? `Gallery photo ${index + 1}` : 'Primary image')); gallery.append(figure);
    }
    form.append(node('h3', `Existing images · ${record.images.length}`), gallery);
  }
  const line = node('p', ''); line.setAttribute('role', 'status');
  const submit = node('button', 'Save fictional product', 'primary-button'); submit.type = 'submit'; form.append(line, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(price.value)) { line.textContent = 'Enter a price with at most two decimal places.'; price.focus(); return; }
    mutation(async () => {
      try {
        const payload = { sku: form.elements.sku.value, name: form.elements.name.value, description: form.elements.description.value,
          category: form.elements.category.value, priceMinor: Math.round(Number(price.value) * 100), active: active.checked,
          ...(record ? { expectedRevision: record.revision } : {}) };
        await api(record ? 'PATCH' : 'POST', `companies/${company.id}/products${record ? `/${record.id}` : ''}`, payload);
        modal.close(); await loadResources();
      } catch (error) { line.textContent = error.message; }
    });
  });
  modal.content.append(form); modal.open(record ? 'Edit fictional product' : 'Add fictional product', () => modal.content.parentElement.remove());
}
function reviewOrder(order) {
  const modal = createModal(), company = selectedCompany;
  modal.content.append(node('h3', order.orderNo), node('p', `${order.status} · ${order.currency} ${(order.totalMinor / 100).toFixed(2)}`), node('p', `${order.buyer.fullName} · ${order.buyer.email}`));
  const items = node('ul', '', 'demo-order-items');
  for (const item of order.items) items.append(node('li', `${item.sku} · ${item.name} · ${item.quantity} × ${item.currency} ${(item.priceMinor / 100).toFixed(2)} (order snapshot)`));
  modal.content.append(items);
  const line = node('p', ''); line.setAttribute('role', 'status');
  if (order.status === 'SUBMITTED') {
    const label = node('label', 'Reason for rejection'), reason = document.createElement('textarea'); reason.maxLength = 300; label.append(reason); modal.content.append(label);
    const actions = node('div', '', 'demo-dialog-actions');
    for (const decision of ['confirm', 'reject']) actions.append(button(decision === 'confirm' ? 'Confirm fictional order' : 'Reject fictional order', () => mutation(async () => {
      try { await api('POST', `companies/${company.id}/orders/${order.id}/${decision}`, { expectedRevision: order.revision, ...(decision === 'reject' ? { reason: reason.value } : {}) }); modal.close(); await loadResources(); }
      catch (error) { line.textContent = error.message; }
    })));
    modal.content.append(actions);
  }
  modal.content.append(line); modal.open('Review fictional order', () => modal.content.parentElement.remove());
}
byId('demo-company').addEventListener('change', () => { syncCompany(); loadResources(); });
for (const control of document.querySelectorAll('[data-view]')) control.addEventListener('click', () => {
  view = control.dataset.view; for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-pressed', String(item === control)); loadResources();
});
byId('demo-new-product').addEventListener('click', () => editProduct());
byId('demo-company-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; mutation(async () => {
  await api('POST', 'companies', { name: form.elements.name.value, currency: form.elements.currency.value });
  form.reset(); await loadCompanies(); await loadResources();
}); });
byId('demo-seller-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; mutation(async () => {
  await api('POST', 'sellers', { name: form.elements.name.value, companyId: selectedCompany.id }); form.reset(); await loadSellers(); status('Fictional seller added. No credential or live access was created.');
}); });
byId('demo-settings-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; mutation(async () => {
  await api('PATCH', companyPath(), { name: form.elements.name.value, currency: form.elements.currency.value, active: form.elements.active.checked, expectedRevision: selectedCompany.revision });
  await loadCompanies(); await loadSellers(); await loadResources();
}); });
byId('demo-reset').addEventListener('click', () => { if (!window.confirm('Discard changes and reset only your fictional preview workspace?')) return; mutation(async () => {
  Object.assign(session, await api('POST', 'reset', {})); await loadCompanies(); await loadSellers(); await loadResources();
}); });
byId('demo-exit').addEventListener('click', () => mutation(async () => { await api('DELETE', 'session'); location.assign('/seller/'); }));
try {
  session = await api('GET', 'session');
  byId('demo-role').textContent = `${session.role === 'ADMIN' ? 'Admin' : 'Seller preview'} · fictional`;
  byId('demo-admin').hidden = session.role !== 'ADMIN'; byId('demo-workspace').hidden = false;
  mountAppearance(byId('demo-appearance'), 'seller');
  await loadCompanies(); await loadSellers(); await loadResources();
} catch (error) { fail(error); byId('demo-restart').hidden = false; }
