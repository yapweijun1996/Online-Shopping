const KEY = 'online-shopping-contact-history-v1';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10;

function recentUnique(values, key) {
  const seen = new Set();
  return values.filter((value) => {
    const identifier = key(value);
    if (!identifier || seen.has(identifier)) return false;
    seen.add(identifier);
    return true;
  }).slice(0, MAX_ENTRIES);
}

function safePhone(value) {
  return typeof value === 'string' && /^\+\d{8,15}$/.test(value) ? value : null;
}

function safeAddress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['line1', 'line2', 'city', 'region', 'postcode', 'country'];
  if (!fields.every((field) => typeof value[field] === 'string' && value[field].length <= 160)) return null;
  if (!value.line1 || !value.postcode || !/^[A-Z]{2}$/.test(value.country)) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

export function createContactHistory(storage = globalThis.localStorage, now = () => Date.now()) {
  let data = { savedAt: 0, buyerPhones: [], recipientPhones: [], addresses: [] };
  let persistent = true;
  let storedText = null;
  try { storedText = storage.getItem(KEY); }
  catch { persistent = false; }
  try {
    const stored = JSON.parse(storedText || 'null');
    if (stored?.savedAt > now() - MAX_AGE_MS && stored.savedAt <= now() &&
        Array.isArray(stored.buyerPhones) && Array.isArray(stored.recipientPhones) && Array.isArray(stored.addresses)) {
      data = {
        savedAt: stored.savedAt,
        buyerPhones: recentUnique(stored.buyerPhones.map(safePhone).filter(Boolean), (value) => value),
        recipientPhones: recentUnique(stored.recipientPhones.map(safePhone).filter(Boolean), (value) => value),
        addresses: recentUnique(stored.addresses.map(safeAddress).filter(Boolean),
          (value) => JSON.stringify(Object.values(value).map((field) => field.toLowerCase()))),
      };
    } else if (storedText && persistent) {
      storage.removeItem(KEY);
    }
  } catch {
    if (storedText && persistent) {
      try { storage.removeItem(KEY); }
      catch { persistent = false; }
    }
  }

  return {
    get persistent() { return persistent; },
    snapshot() {
      return {
        buyerPhones: [...data.buyerPhones],
        recipientPhones: [...data.recipientPhones],
        addresses: data.addresses.map((value) => ({ ...value })),
      };
    },
    save({ buyerPhone, recipientPhones, addresses }) {
      const buyer = safePhone(buyerPhone);
      const recipients = Array.isArray(recipientPhones) ? recipientPhones.map(safePhone).filter(Boolean) : [];
      const destinations = Array.isArray(addresses) ? addresses.map(safeAddress).filter(Boolean) : [];
      data = {
        savedAt: now(),
        buyerPhones: recentUnique([buyer, ...data.buyerPhones].filter(Boolean), (value) => value),
        recipientPhones: recentUnique([...recipients, ...data.recipientPhones], (value) => value),
        addresses: recentUnique([...destinations, ...data.addresses],
          (value) => JSON.stringify(Object.values(value).map((field) => field.toLowerCase()))),
      };
      try { storage.setItem(KEY, JSON.stringify(data)); }
      catch { persistent = false; }
      return persistent;
    },
    clear() {
      data = { savedAt: 0, buyerPhones: [], recipientPhones: [], addresses: [] };
      try { storage.removeItem(KEY); }
      catch { persistent = false; }
      return persistent;
    },
  };
}
