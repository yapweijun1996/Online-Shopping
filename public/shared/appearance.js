import { t, translate } from './i18n.js';
import { createModal } from './modal.js';

export const paletteChoices = [
  ['evergreen-teal', 'paletteEvergreen'], ['warm-plum', 'palettePlum'],
  ['ocean-blue', 'paletteOcean'], ['high-contrast', 'paletteContrast'], ['graphite', 'paletteGraphite'],
];

export function mountAppearance(root, surface) {
  const preference = window[`${surface}Palette`];
  const titleKey = surface === 'seller' ? 'sellerAppearance' : 'paletteTitle';
  const make = (tag, key, className = '') => {
    const element = document.createElement(tag); element.className = className;
    if (key) { element.dataset.i18n = key; element.textContent = t(key); }
    return element;
  };
  const title = make('h2', titleKey);
  title.id = `${surface}-palette-title`;
  root.setAttribute('aria-labelledby', title.id);
  const help = make('p', 'paletteHelp', 'shop-note');
  const options = make('fieldset', '', 'appearance-options');
  options.append(make('legend', titleKey, 'sr-only'));
  const status = make('p', '', 'shop-note'); status.setAttribute('role', 'status');
  const choose = id => {
    status.dataset.i18n = preference.choose(id) ? 'paletteSaved' : 'paletteSessionOnly';
    status.textContent = t(status.dataset.i18n);
  };
  const inputs = [];
  for (const [id, key] of paletteChoices) {
    const row = make('div', '', 'appearance-option');
    const label = make('label');
    const input = make('input'); input.type = 'radio'; input.name = `${surface}-palette`; input.value = id;
    input.addEventListener('change', () => { if (input.checked) choose(id); });
    inputs.push(input);
    const swatch = make('span', '', 'appearance-swatch palette-preview');
    swatch.dataset.palette = id; swatch.setAttribute('aria-hidden', 'true');
    label.append(input, swatch, make('span', key));
    const preview = make('button', 'previewPalette', 'outline-button'); preview.type = 'button';
    preview.addEventListener('click', () => {
      const modal = createModal();
      const sample = make('section', '', 'appearance-sample palette-preview'); sample.dataset.palette = id;
      sample.append(make('h3', key), make('p', 'paletteSample'));
      const action = make('button', 'paletteSampleButton', 'primary-button'); action.type = 'button';
      const field = make('input'); field.readOnly = true; field.value = 'MYR 14.90'; field.setAttribute('aria-label', t('price'));
      sample.append(field, action, make('p', 'paletteSampleNotice', 'appearance-warning'), make('p', 'paletteSampleError', 'appearance-error'));
      const apply = make('button', 'applyPalette', 'primary-button'); apply.type = 'button';
      apply.addEventListener('click', () => { choose(id); modal.close(); });
      modal.content.append(sample, apply);
      modal.open(`${t('previewPalette')}: ${t(key)}`, () => modal.content.parentElement.remove());
    });
    row.append(label, preview); options.append(row);
  }
  root.replaceChildren(title, help, options, status);
  let unsubscribe;
  unsubscribe = preference.subscribe(current => {
    if (!root.isConnected) { unsubscribe?.(); return; }
    for (const input of inputs) input.checked = input.value === current;
  });
  translate(root);
}
