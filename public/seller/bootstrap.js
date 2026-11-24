import { resolveStorageScope, showBootstrapError } from '../shared/storage-scope.js';
import { hideBootLoader } from './boot-loader.js';
try {
  await resolveStorageScope();
  await import('./palette.js');
  await import('./app.js');
} catch (error) {
  hideBootLoader();
  showBootstrapError(error);
}
