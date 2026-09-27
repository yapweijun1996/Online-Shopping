import { createModal } from '../shared/modal.js';
import { languages, locale, setLocale, t } from '../shared/i18n.js';

export function scrollChromeState({ previous, current, hidden, anchor }) {
  if (current < 48) return { hidden: false, anchor: current };
  const direction = current - previous;
  if ((direction > 0 && current < anchor) || (direction < 0 && current > anchor)) anchor = previous;
  if (current - anchor > 28) return { hidden: true, anchor: current };
  if (anchor - current > 12) return { hidden: false, anchor: current };
  return { hidden, anchor };
}

export function mountMobileNavigation({ categories, selectCategory, currentCategory }) {
  const nav = document.getElementById('mobile-navigation');
  const media = matchMedia('(max-width: 760px)');
  const modal = createModal();
  let previous = window.scrollY;
  let anchor = previous;
  let hidden = false;
  let frame = false;
  function reveal() {
    hidden = false; anchor = previous = window.scrollY;
    document.body.classList.remove('mobile-chrome-hidden');
  }
  function close() { modal.close(); reveal(); }
  function open(kind) {
    reveal(); modal.content.replaceChildren();
    const choices = document.createElement('div'); choices.className = 'mobile-nav-choices';
    const entries = kind === 'language' ? languages.map(item => ({ value: item.code, label: item.label })) : [{ value: '', label: t('allCategories') }, ...categories().map(value => ({ value, label: value }))];
    for (const entry of entries) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.label;
      button.setAttribute('aria-pressed', String(entry.value === (kind === 'language' ? locale() : currentCategory())));
      if (kind === 'language') button.lang = entry.value;
      button.addEventListener('click', () => {
        close();
        if (kind === 'language') setLocale(entry.value);
        else selectCategory(entry.value);
      });
      choices.append(button);
    }
    modal.content.append(choices);
    modal.open(t(kind === 'language' ? 'selectLanguage' : 'category'), reveal);
  }
  document.getElementById('mobile-language').addEventListener('click', () => open('language'));
  document.getElementById('mobile-category').addEventListener('click', () => open('category'));
  function route() {
    reveal(); if (modal.isOpen) close();
    const page = document.body.dataset.shopRoute;
    for (const link of nav.querySelectorAll('a')) {
      const active = link.hash === '#catalog' ? page === 'catalog' : link.hash === '#profile' ? ['profile','addresses','settings'].includes(page) : ['cart','checkout'].includes(page);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
  }
  new MutationObserver(route).observe(document.body, { attributes: true, attributeFilter: ['data-shop-route'] });
  media.addEventListener('change', reveal);
  document.addEventListener('focusin', event => {
    if (event.target.closest('.shop-topbar, #mobile-navigation')) reveal();
  });
  window.addEventListener('scroll', () => {
    if (frame) return;
    frame = true;
    requestAnimationFrame(() => {
      frame = false;
      const current = Math.max(0, Math.min(window.scrollY, document.documentElement.scrollHeight - innerHeight));
      // Keep transactional controls and focused search reachable; only browsing hides navigation.
      if (!media.matches || !['catalog','product'].includes(document.body.dataset.shopRoute) || document.querySelector('dialog[open]') || document.activeElement?.matches('input, textarea, select')) { reveal(); return; }
      ({ hidden, anchor } = scrollChromeState({ previous, current, hidden, anchor }));
      previous = current;
      document.body.classList.toggle('mobile-chrome-hidden', hidden);
    });
  }, { passive: true });
  function keyboard() {
    const editing = document.activeElement?.matches('input, textarea, select');
    document.body.classList.toggle('mobile-keyboard', Boolean(media.matches && editing && window.visualViewport && innerHeight - visualViewport.height > 120));
  }
  window.visualViewport?.addEventListener('resize', keyboard);
  document.addEventListener('focusin', keyboard);
  document.addEventListener('focusout', () => requestAnimationFrame(keyboard));
  return { reveal, route, openLanguage: () => open('language') };
}
