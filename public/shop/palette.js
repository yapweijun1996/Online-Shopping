import { storageKey as scopedKey } from '../shared/storage-scope.js';
(() => {
  const storageKey = scopedKey('online-shopping-shop-palette-v1');
  const paletteIds = new Set(['evergreen-teal', 'warm-plum', 'ocean-blue', 'navy-orange', 'high-contrast', 'graphite']);
  const defaultPalette = 'evergreen-teal';
  const validPalette = (value) => paletteIds.has(value) ? value : defaultPalette;
  let current = defaultPalette;
  try { current = validPalette(localStorage.getItem(storageKey)); } catch { /* Browser storage is optional. */ }
  document.documentElement.dataset.shopPalette = current;

  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(current); };
  function choose(value) {
    if (!paletteIds.has(value)) return false;
    current = value;
    document.documentElement.dataset.shopPalette = current;
    notify();
    try { localStorage.setItem(storageKey, current); return true; }
    catch { return false; }
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    current = validPalette(event.newValue);
    document.documentElement.dataset.shopPalette = current;
    notify();
  });
  window.shopPalette = Object.freeze({
    current: () => current,
    choose,
    subscribe(listener) { listeners.add(listener); listener(current); return () => listeners.delete(listener); },
  });
})();
