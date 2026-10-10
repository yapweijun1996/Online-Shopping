import { apiUrl, basePath } from './base-path.js';
const tenantScope = /^t-[a-f0-9]{12}$/;
const sampleScope = /^public-general-demo-[a-z0-9][a-z0-9-]{0,31}$/;
export function storageKey(key) {
  const scope = globalThis.shopStorageNamespace;
  return typeof scope === 'string' && (tenantScope.test(scope) || sampleScope.test(scope)) ? `${key}:${scope}` : key;
}
// Resolve scope before importing any module that reads shop-specific browser state.
function optionalStorage() { try { return globalThis.localStorage; } catch { return undefined; } }
export async function resolveStorageScope({ fetcher = globalThis.fetch, storage = optionalStorage(), pathname = globalThis.location.pathname } = {}) {
  const base = basePath(pathname), key = `scope-for:${base}`;
  let info, scope;
  try {
    const response = await fetcher(apiUrl('v1/shop', pathname), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { const error = new Error(response.status === 404 ? 'Shop not found.' : 'This shop is temporarily unavailable.'); error.status = response.status; throw error; }
    info = await response.json(); scope = info.storageScope || info.demoNamespace || '';
    if (base ? !tenantScope.test(scope) : scope !== '' && !sampleScope.test(scope)) throw new Error('Shop storage scope is unavailable.');
    try { storage?.setItem(key, scope); } catch { /* Optional offline scope cache. */ }
  } catch (error) {
    // A server rejection must not reuse an old scope or expose data from an unavailable shop.
    if (error.status || globalThis.navigator?.onLine === true && error.name !== 'TypeError' && error.name !== 'TimeoutError') throw error;
    try { scope = storage?.getItem(key); } catch { /* Optional storage. */ }
    if (!base && scope == null) scope = '';
    if (base ? !tenantScope.test(scope || '') : scope !== '' && !sampleScope.test(scope || '')) throw error;
  }
  globalThis.shopStorageNamespace = scope;
  globalThis.shopBootstrapInfo = info;
  return info;
}
export function showBootstrapError(error) {
  const main = document.createElement('main'), title = document.createElement('h1'), retry = document.createElement('button');
  title.textContent = error.status === 404 ? 'Shop not found' : 'This shop is temporarily unavailable';
  retry.type = 'button'; retry.textContent = 'Try again'; retry.addEventListener('click', () => location.reload());
  main.append(title, retry); document.body.replaceChildren(main); title.tabIndex = -1; title.focus();
}
