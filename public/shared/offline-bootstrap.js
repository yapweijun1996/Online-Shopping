import { resolveStorageScope, showBootstrapError } from './storage-scope.js';
let resolved = false;
try { await resolveStorageScope(); resolved = true; } catch (error) { showBootstrapError(error); }
if (resolved) {
  const surface = /\/seller\//.test(location.pathname) ? 'seller' : 'shop';
  await import(`../${surface}/palette.js`);
  await import('./offline.js');
}
