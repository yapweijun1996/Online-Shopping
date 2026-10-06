/*
 * Product option selector: one row per option type the seller defined (colour, storage, ...).
 * Every combination is its own product, so choosing a value opens the matching product page.
 * The helpers up to `targetFor` are pure so they can be tested without a browser.
 */
const swatchPattern = /^#[0-9a-fA-F]{6}$/;

const localized = (entity, field, locale) => entity.translations?.[locale] || entity[field];

/** The value currently chosen for each option type, taken from the product on screen. */
export function currentPicks(product) {
  return new Map((product.options || []).map(({ type, value }) => [type.id, value.id]));
}

const valueOf = (variant, typeId) => variant.options?.find(({ type }) => type.id === typeId)?.value.id;

/**
 * The product to open when `valueId` of `typeId` is chosen: the exact combination with the other current
 * choices when it exists, otherwise the nearest one (most other choices kept, in stock first).
 */
export function targetFor(product, typeId, valueId) {
  const picks = currentPicks(product);
  const others = [...picks.keys()].filter((id) => id !== typeId);
  const scored = (product.variants || [])
    .filter((variant) => valueOf(variant, typeId) === valueId)
    .map((variant, index) => ({ variant, index, score: others.filter((id) => valueOf(variant, id) === picks.get(id)).length }));
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || (b.variant.inStock !== false) - (a.variant.inStock !== false) || a.index - b.index);
  return { variant: scored[0].variant, exact: scored[0].score === others.length };
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Renders the selector. `productHash` builds the route of a product; `t` and `locale` come from i18n. */
export function renderOptionSelector(product, { t, locale, productHash }) {
  const root = element('div', 'product-options');
  const picks = currentPicks(product);
  for (const axis of product.optionTypes) {
    const row = element('div', 'option-row');
    const name = element('span', 'option-name', localized(axis, 'name', locale));
    name.id = `option-${axis.id}`;
    const group = element('div', 'option-choices');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', name.id);
    if (axis.display === 'dropdown') {
      const select = element('select', 'option-select');
      select.setAttribute('aria-labelledby', name.id);
      for (const value of axis.values) {
        const target = targetFor(product, axis.id, value.id);
        const option = element('option', '', `${localized(value, 'label', locale)}${target?.variant.inStock === false ? ` — ${t('outOfStock')}` : ''}`);
        option.value = target ? productHash(target.variant.id) : '';
        option.selected = picks.get(axis.id) === value.id;
        option.disabled = !target;
        select.append(option);
      }
      select.addEventListener('change', () => { if (select.value) location.hash = select.value; });
      group.append(select);
    } else {
      for (const value of axis.values) {
        const target = targetFor(product, axis.id, value.id);
        const selected = picks.get(axis.id) === value.id;
        const choice = element('a', `option-choice option-style-${axis.display}`);
        // Links, not radios: Enter opens the combination, and the chosen one is marked as current.
        if (selected) choice.setAttribute('aria-current', 'true');
        if (target) choice.href = productHash(target.variant.id);
        if (selected) choice.classList.add('is-selected');
        const switches = target && !target.exact && !selected;
        if (switches) choice.classList.add('is-unavailable');
        if (target?.variant.inStock === false) choice.classList.add('is-soldout');
        if (axis.display === 'swatch' && swatchPattern.test(value.swatchColor || '')) {
          const dot = element('span', 'option-swatch');
          dot.style.setProperty('--swatch', value.swatchColor);
          dot.setAttribute('aria-hidden', 'true');
          choice.append(dot);
        } else if (axis.display === 'image' && target?.variant.imageUrl) {
          const thumb = element('img', 'option-thumb');
          thumb.src = target.variant.imageUrl; thumb.alt = ''; thumb.loading = 'lazy'; thumb.decoding = 'async';
          choice.append(thumb);
        }
        choice.append(element('span', 'option-label', localized(value, 'label', locale)));
        if (target?.variant.inStock === false) choice.append(element('span', 'sr-only', ` — ${t('outOfStock')}`));
        if (switches) choice.append(element('span', 'sr-only', ` — ${t('optionChangesOthers')}`));
        group.append(choice);
      }
    }
    row.append(name, group);
    root.append(row);
  }
  const stock = element('p', 'option-stock', product.inStock === false ? t('outOfStock') : t('inStockLabel'));
  stock.dataset.state = product.inStock === false ? 'out' : 'in';
  root.append(stock);
  return root;
}
