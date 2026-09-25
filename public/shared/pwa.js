export async function registerWorker(script, scope) {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register(script, { scope });
}
