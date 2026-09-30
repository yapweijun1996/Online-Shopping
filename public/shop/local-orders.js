import { ORDER_RETENTION_MS, statusAccessKeyPattern } from '../shared/order-status.js';

const DB_NAME = 'online-shopping-local-orders';
const STORE_NAME = 'orders';
export { ORDER_RETENTION_MS };
export const ORDER_CLOCK_SKEW_MS = 5 * 60 * 1000;
const statuses = new Set(['SUBMITTED', 'CONFIRMED', 'REJECTED']);

function normalizeOrder(receipt, items = [], accessKey = receipt?.statusAccessKey) {
  if (!receipt || !/^(?:OS|DEMO)-\d{8,}$/.test(receipt.orderNo) ||
      !['MYR', 'SGD'].includes(receipt.currency) ||
      !Number.isSafeInteger(receipt.totalMinor) || receipt.totalMinor < 0 ||
      typeof receipt.submittedAt !== 'string' || !Number.isFinite(Date.parse(receipt.submittedAt)) ||
      !Array.isArray(items)) return null;
  const lines = [];
  for (const item of items) {
    if (!item || typeof item.productId !== 'string' || item.productId.length > 100 ||
        typeof item.name !== 'string' || !item.name || item.name.length > 200 ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 ||
        !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0) return null;
    lines.push({ productId: item.productId, name: item.name, quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor });
  }
  const statusAccessKey = typeof accessKey === 'string' && statusAccessKeyPattern.test(accessKey) ? accessKey : null;
  const status = statusAccessKey && statuses.has(receipt.status) ? receipt.status : null;
  const statusUpdatedAt = status && typeof receipt.statusUpdatedAt === 'string' &&
    Number.isFinite(Date.parse(receipt.statusUpdatedAt)) ? receipt.statusUpdatedAt : receipt.submittedAt;
  return { orderNo: receipt.orderNo, submittedAt: receipt.submittedAt,
    totalMinor: receipt.totalMinor, currency: receipt.currency,
    simulation: receipt.simulation === true, items: lines,
    ...(statusAccessKey ? { statusAccessKey, status, statusUpdatedAt } : {}) };
}

export function isLocalOrderCurrent(order, now = Date.now()) {
  const submitted = Date.parse(order.submittedAt);
  return Number.isFinite(submitted) && submitted <= now + ORDER_CLOCK_SKEW_MS && now - submitted < ORDER_RETENTION_MS;
}

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
        request.result.createObjectStore(STORE_NAME, { keyPath: 'orderNo' });
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

export async function createLocalOrderStore(provider = globalThis.indexedDB, now = () => Date.now()) {
  const memory = new Map();
  let database = null;
  try {
    database = await openDatabase(provider);
    const opened = database;
    opened.onversionchange = () => { opened.close(); if (database === opened) database = null; };
  } catch {
    database?.close();
    database = null;
  }

  async function persist(operation) {
    if (!database) return false;
    const opened = database;
    try { await transact(opened, 'readwrite', operation); return true; }
    catch {
      opened.close();
      if (database === opened) database = null;
      return false;
    }
  }

  async function refreshNow() {
    if (database) {
      const opened = database;
      try {
        const stored = await transact(opened, 'readonly', (store) => store.getAll());
        const current = new Map();
        const expired = [];
        for (const value of stored) {
          const order = normalizeOrder(value, value.items);
          if (order && isLocalOrderCurrent(order, now())) current.set(order.orderNo, order);
          else if (typeof value?.orderNo === 'string') expired.push(value.orderNo);
        }
        if (expired.length) await transact(opened, 'readwrite', (store) => {
          for (const orderNo of expired) store.delete(orderNo);
        });
        memory.clear();
        for (const [orderNo, order] of current) memory.set(orderNo, order);
        return true;
      } catch {
        opened.close();
        if (database === opened) database = null;
      }
    }
    for (const order of memory.values()) {
      if (!isLocalOrderCurrent(order, now())) memory.delete(order.orderNo);
    }
    return false;
  }

  let mutation = Promise.resolve();
  function serialize(operation) {
    const result = mutation.then(operation); mutation = result.catch(() => {}); return result;
  }
  const refresh = () => serialize(refreshNow);
  await refresh();

  return {
    get persistent() { return Boolean(database); },
    list() {
      return [...memory.values()].filter((order) => isLocalOrderCurrent(order, now()))
        .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
        .map((order) => ({ ...order, items: order.items.map((item) => ({ ...item })) }));
    },
    refresh,
    save(receipt, items = [], accessKey) { return serialize(async () => {
      const order = normalizeOrder(receipt, items, accessKey);
      if (!order || !isLocalOrderCurrent(order, now())) return false;
      const previous = memory.get(order.orderNo);
      if (previous?.items.length && !order.items.length) order.items = previous.items;
      if (previous?.statusAccessKey && !order.statusAccessKey) {
        order.statusAccessKey = previous.statusAccessKey;
        order.status = previous.status;
        order.statusUpdatedAt = previous.statusUpdatedAt;
      }
      memory.set(order.orderNo, order);
      return persist((store) => store.put(order));
    }); },
    updateStatuses(items) { return serialize(async () => {
      if (!Array.isArray(items)) return false;
      const updated = [];
      for (const item of items) {
        const previous = memory.get(item?.orderNo);
        if (!previous?.statusAccessKey || !statuses.has(item.status) ||
            typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) ||
            Date.parse(item.updatedAt) < Date.parse(previous.statusUpdatedAt || previous.submittedAt)) continue;
        const order = { ...previous, status: item.status, statusUpdatedAt: item.updatedAt };
        memory.set(order.orderNo, order);
        updated.push(order);
      }
      if (!updated.length) return true;
      return persist((store) => { for (const order of updated) store.put(order); });
    }); },
    close() { database?.close(); database = null; },
  };
}
