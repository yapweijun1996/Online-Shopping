import PrintForm from './vendor/printform.js';
import { formatDate, formatMoney, t } from '../shared/i18n.js';
import { orderDocumentModel } from './order-document-model.js';
import { containDialogFocus } from '../shared/modal.js';

function node(tag, text = '', className = '') {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
export function createOrderDocuments() {
  let trigger = null;
  let printing = false;
  let printRoot = null;
  const dialog = node('dialog', '', 'order-document-dialog'); dialog.id = 'order-document-dialog';
  containDialogFocus(dialog);
  dialog.setAttribute('aria-labelledby', 'order-document-title');
  const toolbar = node('div', '', 'order-document-toolbar');
  const close = node('button', t('close')); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  const print = node('button', t('printSavePdf'), 'primary-button'); print.type = 'button'; print.addEventListener('click', () => window.print());
  toolbar.append(close, print);
  const content = node('div', '', 'order-document-pages'); dialog.append(toolbar, content); document.body.append(dialog);
  dialog.addEventListener('close', () => { if (dialog.open || printing) return; content.replaceChildren(); if (trigger?.isConnected) trigger.focus(); trigger = null; });
  function formatPages() {
    content.classList.remove('document-formatted');
    content.style.setProperty('--document-scale', '1');
    for (const section of [...content.children]) {
      section.classList.add('printform');
      const table = section.querySelector('table');
      const header = node('div', '', 'pheader');
      const info = node('div', '', 'pdocinfo');
      const children = [...section.children];
      for (const element of children.slice(0, children.indexOf(table))) {
        (element === children[0] || element === children[1] ? header : info).append(element);
      }
      const gridClass = section.classList.contains('packing-document') ? 'document-grid packing-grid' : 'document-grid summary-grid';
      const rowHeader = node('div', '', 'prowheader ' + gridClass);
      for (const cell of table.querySelectorAll('thead th')) { const next = node('strong', cell.firstChild.textContent); rowHeader.append(next); }
      const rows = [...table.querySelectorAll('tbody tr')].map(row => {
        const next = node('div', '', 'prowitem ' + gridClass);
        for (const cell of row.children) next.append(node('span', cell.textContent));
        return next;
      });
      const totals = section.querySelector('.order-document-totals'); totals.classList.add('pfooter');
      const pageFooter = node('div', '', 'pfooter_pagenum document-page-footer');
      pageFooter.append(node('span', table.querySelector('.document-repeat-id').textContent));
      const number = node('span'); number.append(node('span', '', 'document-page-number'), document.createTextNode(' / '), node('span', '', 'document-page-total'));
      number.firstChild.setAttribute('data-page-number', ''); number.lastChild.setAttribute('data-page-total', ''); pageFooter.append(number);
      section.replaceChildren(header, info, rowHeader, ...rows, totals, pageFooter);
      PrintForm.format(section, { papersizeWidth: 182 * 96 / 25.4, papersizeHeight: 269 * 96 / 25.4 - 2,
        repeatHeader: true, repeatDocinfo: true, repeatRowheader: true, repeatFooter: false, repeatFooterPagenum: true,
        insertDummyRowItemWhileFormatTable: false, insertPtacDummyRowItems: false, insertDummyRowWhileFormatTable: false, insertFooterSpacerWhileFormatTable: false, insertFooterSpacerWithDummyRowItemWhileFormatTable: false, fillPageHeightAfterFooter: false, debug: false });
    }
    // Repeated engine headers must not duplicate the dialog's accessible title ID.
    content.querySelectorAll('#order-document-title').forEach(title => title.removeAttribute('id'));
    const title = content.querySelector('h1'); if (title) title.id = 'order-document-title';
    const pages = [...content.querySelectorAll('.printform_page')];
    for (const page of pages) {
      if (page.scrollHeight > 269 * 96 / 25.4 + 2) throw new Error('Document content exceeds A4; reduce oversized snapshot content');
    }
    content.classList.add('document-formatted');
    fitPreview();
  }
  function fitPreview() {
    const width = content.clientWidth - 24;
    content.style.setProperty('--document-scale', String(Math.min(1, Math.max(.25, width / (210 * 96 / 25.4)))));
  }
  const resize = new ResizeObserver(() => { if (dialog.open) fitPreview(); }); resize.observe(content);
  function beforePrint() {
    if (!dialog.open) return;
    printing = true;
    printRoot = node('main'); printRoot.id = 'order-print-root';
    printRoot.append(content.cloneNode(true));
    printRoot.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    document.body.append(printRoot); document.body.dataset.orderPrint = 'true';
    // Clone the already formatted preview; printing never repaginates.
    printRoot.style.setProperty('--document-scale', '1');
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
    dialog.showModal();
    try { formatPages(); } catch (error) { dialog.close(); content.replaceChildren(); throw error; }
    close.focus();
  }
  return { open, dispose() { resize.disconnect(); window.removeEventListener('beforeprint', beforePrint); window.removeEventListener('afterprint', afterPrint); printRoot?.remove(); delete document.body.dataset.orderPrint; printing = false; if (dialog.open) dialog.close(); dialog.remove(); } };
}
