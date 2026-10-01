import { storageKey } from './storage-scope.js';
const KEY = 'online-shopping-selection-v1';
export function createCartSelection(storage) {
  let known = new Set();
  let selected = new Set();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey(KEY)) || 'null');
    if (Array.isArray(saved?.known) && Array.isArray(saved?.selected)) {
      known = new Set(saved.known.filter((id) => typeof id === 'string'));
      selected = new Set(saved.selected.filter((id) => known.has(id)));
    }
  } catch { /* Selection remains usable in this tab. */ }
  function save() {
    try { storage?.setItem(storageKey(KEY), JSON.stringify({ known: [...known], selected: [...selected] })); } catch { /* Optional tab persistence. */ }
  }
  return {
    has: (id) => selected.has(id),
    sync(lines) {
      const ids = new Set(lines.map(({ productId }) => productId));
      for (const id of ids) if (!known.has(id)) selected.add(id);
      selected = new Set([...selected].filter((id) => ids.has(id)));
      known = ids;
      save();
    },
    set(id, value) { if (value) selected.add(id); else selected.delete(id); save(); },
    only(id) { selected = new Set([id]); save(); },
    items: (items) => items.filter(({ productId }) => selected.has(productId)),
  };
}
