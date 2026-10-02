(() => {
  const storageKey = 'online-shopping-seller-palette-v1';
  const paletteIds = new Set(['evergreen-teal', 'warm-plum', 'ocean-blue', 'high-contrast', 'graphite']);
  const defaultPalette = 'evergreen-teal';
  const validPalette = (value) => paletteIds.has(value) ? value : defaultPalette;
  let current = defaultPalette;
  try { current = validPalette(localStorage.getItem(storageKey)); } catch { /* Browser storage is optional. */ }
  document.documentElement.dataset.sellerPalette = current;

  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(current); };
  function choose(value) {
    if (!paletteIds.has(value)) return false;
    current = value;
    document.documentElement.dataset.sellerPalette = current;
    notify();
    try { localStorage.setItem(storageKey, current); return true; }
    catch { return false; }
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    current = validPalette(event.newValue);
    document.documentElement.dataset.sellerPalette = current;
    notify();
  });
  window.sellerPalette = Object.freeze({
    current: () => current,
    choose,
    subscribe(listener) { listeners.add(listener); listener(current); return () => listeners.delete(listener); },
  });
})();
