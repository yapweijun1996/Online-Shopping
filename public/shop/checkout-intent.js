import { storageKey } from './storage-scope.js';

const key = () => storageKey('checkout-pending-intent-v1');
const storageError = () => new Error('checkoutIntentStorageFailed');

// An unknown outcome must survive reloads. Never expire or silently discard it: the server may have committed.
export function readCheckoutIntent() {
  try {
    const raw = localStorage.getItem(key());
    if (raw === null) return null;
    if (raw.length > 300_000) throw storageError();
    const intent = JSON.parse(raw);
    if (!intent || typeof intent.key !== 'string' || !/^[0-9a-f-]{36}$/.test(intent.key) ||
        typeof intent.serialized !== 'string' || !Array.isArray(intent.orderItems) || !intent.orderItems.length ||
        intent.orderItems.some(item => !item || typeof item.productId !== 'string' || typeof item.name !== 'string' ||
          !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 1) ||
        !Array.isArray(intent.submittedItems) || typeof intent.cartBacked !== 'boolean' ||
        typeof intent.editable !== 'boolean') throw storageError();
    const payload = JSON.parse(intent.serialized);
    if (!payload || !payload.buyer || !Array.isArray(payload.deliveries) || !payload.deliveries.length ||
        payload.deliveries.some(delivery => !delivery || !Array.isArray(delivery.items) || !delivery.items.length ||
          delivery.items.some(item => !item || typeof item.productId !== 'string' || !['MYR', 'SGD'].includes(item.expectedCurrency)))) throw storageError();
    return intent;
  } catch { throw storageError(); }
}

export function writeCheckoutIntent(intent) {
  try {
    const raw = JSON.stringify(intent);
    if (raw.length > 300_000) throw storageError();
    localStorage.setItem(key(), raw);
    if (localStorage.getItem(key()) !== raw) throw storageError();
  } catch { throw storageError(); }
}

export function clearCheckoutIntent() {
  try {
    localStorage.removeItem(key());
    if (localStorage.getItem(key()) !== null) throw storageError();
  } catch { throw storageError(); }
}
