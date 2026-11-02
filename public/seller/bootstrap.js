import { resolveStorageScope, showBootstrapError } from '../shared/storage-scope.js';
try {
  await resolveStorageScope();
  await import('./palette.js');
  await import('./app.js');
} catch (error) { showBootstrapError(error); }
