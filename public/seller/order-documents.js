import { formatDate, formatMoney, t } from '../shared/i18n.js';
import { orderDocumentModel } from './order-document-model.js';

function node(tag, text = '', className = '') {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
export function createOrderDocuments() {
  let trigger = null;
  let printing = false;
  let printRoot = null;
  const dialog = node('dialog', '', 'order-document-dialog'); dialog.id = 'order-document-dialog';
  dialog.setAttribute('aria-labelledby', 'order-document-title');
  const toolbar = node('div', '', 'order-document-toolbar');
  const close = node('button', t('close')); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  const print = node('button', t('printSavePdf'), 'primary-button'); print.type = 'button'; print.addEventListener('click', () => window.print());
  toolbar.append(close, print);
  const content = node('div', '', 'order-document-pages'); dialog.append(toolbar, content); document.body.append(dialog);
  dialog.addEventListener('close', () => { if (dialog.open || printing) return; content.replaceChildren(); if (trigger?.isConnected) trigger.focus(); trigger = null; });
  function paginatePrint(root) {
    // A4 content area: 297mm less two 14mm margins. Keep a rounding reserve.
    const measure = node('div', '', 'document-page-measure'); root.append(measure);
    const capacity = measure.getBoundingClientRect().height - 16; measure.remove();
    const pages = root.querySelector('.order-document-pages');
    for (const original of [...pages.children]) {
      const table = original.querySelector('table'); const totals = original.querySelector('.order-document-totals');
      const rows = [...table.querySelectorAll('tbody tr')]; const header = [...original.children].slice(0, [...original.children].indexOf(table));
      let sheet, body;
      function newSheet(first = false) {
        sheet = original.cloneNode(false); pages.insertBefore(sheet, original);
        if (first) header.forEach(element => sheet.append(element.cloneNode(true)));
        else {
          sheet.append(header[0].cloneNode(true), header[1].cloneNode(true));
          sheet.append(node('p', table.querySelector('.document-repeat-id').textContent));
        }
        const nextTable = table.cloneNode(false);
        nextTable.append(table.querySelector('colgroup').cloneNode(true), table.querySelector('thead').cloneNode(true));
        body = node('tbody'); nextTable.append(body); sheet.append(nextTable);
      }
      newSheet(true);
      for (const row of rows) {
        body.append(row.cloneNode(true));
        if (sheet.getBoundingClientRect().height > capacity && body.children.length > 1) {
          const overflow = body.lastElementChild; overflow.remove(); newSheet(); body.append(overflow);
        }
      }
      const footer = totals.cloneNode(true); sheet.append(footer);
      if (sheet.getBoundingClientRect().height > capacity) {
        footer.remove(); const tail = [];
        for (let count = 0; count < 3 && body.children.length; count++) { const row = body.lastElementChild; row.remove(); tail.unshift(row); }
        newSheet(); body.append(...tail); sheet.append(footer);
      }
      original.remove();
    }
  }
  function beforePrint() {
    if (!dialog.open) return;
    printing = true;
    printRoot = node('main'); printRoot.id = 'order-print-root';
    printRoot.append(content.cloneNode(true));
    printRoot.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    document.body.append(printRoot); document.body.dataset.orderPrint = 'true';
    paginatePrint(printRoot);
    dialog.close();
  }
  function afterPrint() {
    if (!printing) return;
    printRoot?.remove(); printRoot = null; delete document.body.dataset.orderPrint;
    if (dialog.isConnected) { dialog.showModal(); print.focus(); }
    printing = false;
  }
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  function field(parent, label, value) { if (value) { const row = node('p'); row.append(node('strong', label + ': '), document.createTextNode(String(value))); parent.append(row); } }
  function open(order, kind, shopName, source) {
    const data = orderDocumentModel(order, kind); trigger = source; content.replaceChildren();
    close.textContent = t('close'); print.textContent = t('printSavePdf');
    data.deliveries.forEach((delivery, index) => {
      const section = node('section', '', `order-document-page ${kind === 'packing' ? 'packing-document' : ''}`);
      const heading = node('h1', t(kind === 'packing' ? 'packingSheet' : 'orderDocument')); if (!index) heading.id = 'order-document-title';
      section.append(node('p', shopName || t('sellerPortal'), 'order-document-brand'), heading);
      section.append(node('p', data.simulation ? t('documentDemo') : t('documentLimits'), 'order-document-notice'));
      field(section, t('orderNumber'), data.orderNo); field(section, t('orderStatus'), t({SUBMITTED:'statusSubmitted',CONFIRMED:'statusConfirmed',REJECTED:'statusRejected'}[data.status]));
      field(section, t('orderRevision'), data.revision); field(section, t('submittedAt'), `${formatDate(data.submittedAt)} (${data.submittedAt})`);
      field(section, t('updatedAt'), `${formatDate(data.updatedAt)} (${data.updatedAt})`);
      if (data.rejectionReason) field(section, t('rejectionReason'), data.rejectionReason);
      if (kind === 'summary') { section.append(node('h2', t('buyerDetails'))); field(section,t('fullName'),data.buyer.fullName); if (!data.simulation) { field(section,t('buyerWhatsApp'),data.buyer.whatsappPhone); field(section,t('emailLabel'),data.buyer.email); } }
      section.append(node('h2', `${t('destination')} ${index + 1} / ${data.deliveries.length}`));
      field(section,t('recipientName'),delivery.recipient.fullName);
      if (!data.simulation) { field(section,t('recipientPhone'),delivery.recipient.phone); field(section,t('deliveryAddress'),Object.values(delivery.address).filter(Boolean).join(', ')); }
      else section.append(node('p',t('demoContactUnavailable')));
      const table = node('table'); const head = node('thead'); const row = node('tr');
      const keys = kind === 'packing' ? ['sku','product','quantity','packedCheck'] : ['sku','product','quantity','unitPrice','orderTotal'];
      const columns = node('colgroup'); for (const width of kind === 'packing' ? ['15%','50%','15%','20%'] : ['15%','38%','9%','19%','19%']) { const col = node('col'); col.className = 'document-col-' + width.replace('%',''); columns.append(col); } table.append(columns);
      for (const [indexKey, key] of keys.entries()) { const th = node('th',t(key)); th.scope = 'col'; if (!indexKey) th.append(node('span', `${data.orderNo} · ${t('destination')} ${index + 1} / ${data.deliveries.length} · ${t('orderRevision')} ${data.revision}`, 'document-repeat-id')); row.append(th); } head.append(row); table.append(head);
      const body = node('tbody');
      for (const item of delivery.items) { const r = node('tr'); for (const value of kind === 'packing' ? [item.sku,item.name,item.quantity,'☐'] : [item.sku,item.name,item.quantity,formatMoney(item.priceMinor,data.currency),formatMoney(item.lineTotalMinor,data.currency)]) r.append(node('td',String(value))); body.append(r); } table.append(body); section.append(table);
      const totals = node('div', '', 'order-document-totals');
      totals.append(node('p', `${data.orderNo} · ${t('destination')} ${index + 1} / ${data.deliveries.length} · ${t('orderRevision')} ${data.revision}`, 'document-repeat-id'));
      field(totals,t('destinationQuantity'),delivery.quantity);
      if (kind === 'summary') { field(totals,t('destinationSubtotal'),formatMoney(delivery.items.reduce((sum,item)=>sum+item.lineTotalMinor,0),data.currency)); field(totals,t('orderTotal'),formatMoney(data.totalMinor,data.currency)); totals.append(node('p',t('documentOrderTotalNote'))); }
      else totals.append(node('p',t('manualPackingNote')));
      section.append(totals);
      content.append(section);
    });
    dialog.showModal(); close.focus();
  }
  return { open, dispose() { window.removeEventListener('beforeprint', beforePrint); window.removeEventListener('afterprint', afterPrint); printRoot?.remove(); delete document.body.dataset.orderPrint; printing = false; if (dialog.open) dialog.close(); dialog.remove(); } };
}
