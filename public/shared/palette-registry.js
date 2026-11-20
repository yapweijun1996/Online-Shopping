export const defaultPalette = 'evergreen-teal';

export const paletteChoices = [
  [defaultPalette, 'paletteEvergreen'],
  ['warm-plum', 'palettePlum'],
  ['ocean-blue', 'paletteOcean'],
  ['navy-orange', 'paletteNavyOrange'],
  ['high-contrast', 'paletteContrast'],
  ['graphite', 'paletteGraphite'],
  ['indigo', 'paletteIndigo'],
  ['emerald', 'paletteEmerald'],
  ['rose', 'paletteRose'],
  ['copper', 'paletteCopper'],
];

const paletteIds = new Set(paletteChoices.map(([id]) => id));

export function mountPalettePreference(surface, storageKey) {
  const attribute = `${surface}Palette`;
  const root = document.documentElement;
  const listeners = new Set();
  const validPalette = value => paletteIds.has(value) ? value : defaultPalette;
  let current = defaultPalette;
  try { current = validPalette(localStorage.getItem(storageKey)); } catch { /* Browser storage is optional. */ }
  root.dataset[attribute] = current;

  function apply(value) {
    current = value;
    root.dataset[attribute] = current;
    for (const listener of listeners) listener(current);
  }

  window.addEventListener('storage', event => {
    if (event.key === storageKey) apply(validPalette(event.newValue));
  });

  return Object.freeze({
    current: () => current,
    choose(value) {
      if (!paletteIds.has(value)) return false;
      apply(value);
      try { localStorage.setItem(storageKey, current); return true; }
      catch { return false; }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
  });
}
