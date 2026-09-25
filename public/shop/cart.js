const DB_NAME = 'online-shopping-cart';
const STORE_NAME = 'lines';
const MAX_QUANTITY = 100;

function openDatabase(provider) {
  if (!provider) return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('IndexedDB open timed out')), 5000);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
    try { request = provider.open(DB_NAME, 1); } catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'productId' });
      }
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      clearTimeout(timeout);
      resolve(request.result);
    };
    request.onerror = () => fail(request.error || new Error('IndexedDB failed'));
    request.onblocked = () => fail(new Error('IndexedDB upgrade blocked'));
  });
}

function transact(database, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function validateLine(productId, quantity) {
  if (typeof productId !== 'string' || productId.length < 1 || productId.length > 100) {
    throw new TypeError('productId must be a bounded string');
  }
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
    throw new RangeError(`quantity must be an integer from 0 to ${MAX_QUANTITY}`);
  }
}

export async function createCartStore(provider = globalThis.indexedDB) {
  const memory = new Map();
  let database = null;
  try {
    database = await openDatabase(provider);
    const opened = database;
    opened.onversionchange = () => { opened.close(); if (database === opened) database = null; };
    for (const line of await transact(database, 'readonly', (store) => store.getAll())) {
      if (typeof line.productId === 'string' && Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= MAX_QUANTITY) {
        memory.set(line.productId, line.quantity);
      }
    }
  } catch {
    database?.close();
    database = null;
  }

  async function persist(operation) {
    if (!database) return false;
    const opened = database;
    try {
      await transact(opened, 'readwrite', operation);
      return true;
    } catch {
      opened.close();
      if (database === opened) database = null;
      return false;
    }
  }

  return {
    get persistent() { return Boolean(database); },
    list() { return [...memory].map(([productId, quantity]) => ({ productId, quantity })); },
    async set(productId, quantity) {
      validateLine(productId, quantity);
      if (quantity === 0) {
        memory.delete(productId);
        return persist((store) => store.delete(productId));
      }
      memory.set(productId, quantity);
      return persist((store) => store.put({ productId, quantity }));
    },
    async clear() {
      memory.clear();
      return persist((store) => store.clear());
    },
    close() { database?.close(); database = null; },
  };
}
