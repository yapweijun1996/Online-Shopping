import { messages, t, translate } from '../shared/i18n.js';

const locales = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
  ['companyTabsLabel', 'Company settings sections', 'Bahagian tetapan syarikat', '公司设置分区', 'Các mục cài đặt công ty', 'ส่วนการตั้งค่าบริษัท', '会社設定のセクション', '회사 설정 섹션'],
  ['companyTabGeneral', 'General', 'Umum', '常规', 'Chung', 'ทั่วไป', '一般', '일반'],
  ['companyTabStorefront', 'Product page', 'Halaman produk', '商品页', 'Trang sản phẩm', 'หน้าสินค้า', '商品ページ', '상품 페이지'],
  ['companyTabShipping', 'Shipping', 'Penghantaran', '发货', 'Giao hàng', 'การจัดส่ง', '発送', '배송'],
  ['companyTabMessaging', 'WhatsApp', 'WhatsApp', 'WhatsApp', 'WhatsApp', 'WhatsApp', 'WhatsApp', 'WhatsApp'],
  ['companyTabAppearance', 'Appearance', 'Rupa', '外观', 'Giao diện', 'รูปลักษณ์', '外観', '모양'],
];
for (const [key, ...values] of rows) locales.forEach((locale, index) => { messages[locale][key] = values[index]; });

const STORAGE_KEY = 'seller-company-tab';
const remembered = () => { try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; } };
const remember = (id) => { try { sessionStorage.setItem(STORAGE_KEY, id); } catch { /* private window: the tab is simply not remembered */ } };

/* Tab strip for the Company settings page. `tabs` is [{ id, label (i18n key), panels: [elements] }]; every element that
   belongs to any tab is hidden unless the selected tab lists it. Returns { select, refreshLocale }. */
export function mountCompanyTabs(root, tabs, { onSelect = () => {} } = {}) {
  const initialTab = remembered();
  const list = document.createElement('div');
  list.className = 'company-tabs'; list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', t('companyTabsLabel'));
  const buttons = new Map();
  const everything = new Set(tabs.flatMap((tab) => tab.panels));
  function select(id, { focus = false } = {}) {
    const chosen = tabs.find((tab) => tab.id === id) ?? tabs[0];
    for (const tab of tabs) {
      const button = buttons.get(tab.id), active = tab === chosen;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    }
    for (const element of everything) element.hidden = !chosen.panels.includes(element);
    buttons.get(chosen.id).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    remember(chosen.id); onSelect(chosen.id);
    if (focus) buttons.get(chosen.id).focus();
  }
  for (const tab of tabs) {
    const button = document.createElement('button');
    button.type = 'button'; button.id = `company-tab-${tab.id}`; button.dataset.i18n = tab.label; button.textContent = t(tab.label);
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => select(tab.id));
    button.addEventListener('keydown', (event) => {
      const at = tabs.findIndex((item) => item.id === tab.id);
      const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); select(tabs[(next + tabs.length) % tabs.length].id, { focus: true });
    });
    buttons.set(tab.id, button); list.append(button);
  }
  root.prepend(list);
  for (const tab of tabs) for (const element of tab.panels) if (!element.hasAttribute('role')) { element.setAttribute('role', 'tabpanel'); element.setAttribute('aria-labelledby', `company-tab-${tab.id}`); }
  select(initialTab);
  return {
    select,
    add(tab) {
      if (tabs.some(item => item.id === tab.id)) return;
      tabs.push(tab);
      const button = document.createElement('button');
      button.type = 'button'; button.id = `company-tab-${tab.id}`; button.dataset.i18n = tab.label; button.textContent = t(tab.label);
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false'); button.tabIndex = -1;
      button.addEventListener('click', () => select(tab.id));
      button.addEventListener('keydown', event => {
        const at = tabs.indexOf(tab), next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault(); select(tabs[(next + tabs.length) % tabs.length].id, { focus: true });
      });
      buttons.set(tab.id, button); list.append(button);
      for (const panel of tab.panels) { everything.add(panel); panel.hidden = true; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); }
      if (initialTab === tab.id) select(tab.id);
    },
    refreshLocale() { translate(list); list.setAttribute('aria-label', t('companyTabsLabel')); }
  };
}
