// Namespace only the new public demo; never erase or migrate another shop's data.
export function storageKey(key) {
  const scope = globalThis.shopStorageNamespace;
  return typeof scope === 'string' && /^public-general-demo-[a-z0-9][a-z0-9-]{0,31}$/.test(scope)
    ? `${key}:${scope}` : key;
}
