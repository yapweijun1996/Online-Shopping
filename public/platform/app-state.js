// Pure lifecycle logic for the platform PWA shell (no DOM), so it can be unit-tested.
export const APP_STATES = Object.freeze(['STARTING', 'READY', 'OFFLINE', 'UPDATE_AVAILABLE', 'UPDATING', 'RELOADING', 'ERROR', 'UPDATE_FAILED']);

export const initialFlags = (offline = false) => ({ booted: false, offline, available: null, ready: false, applying: false, reloading: false, failed: false, workerError: '', dismissed: '', checked: false });

// What the application is doing, in priority order (pwa:product-standard §11).
export function appState(flags) {
  if (flags.reloading) return 'RELOADING';
  if (flags.applying) return 'UPDATING';
  if (flags.failed) return 'UPDATE_FAILED';
  if (flags.ready) return 'UPDATE_AVAILABLE';
  if (flags.workerError) return 'ERROR';
  if (flags.offline) return 'OFFLINE';
  return flags.booted ? 'READY' : 'STARTING';
}

// Which status banner is shown. A dismissed update must never hide the offline warning.
export function bannerState(flags) {
  const state = appState(flags);
  if (state === 'UPDATE_AVAILABLE' && flags.dismissed === (flags.available || 'ready')) return flags.offline ? 'OFFLINE' : null;
  return ['OFFLINE', 'UPDATE_AVAILABLE', 'UPDATE_FAILED', 'ERROR'].includes(state) ? state : null;
}

// Folds a report from the shared update lifecycle (public/shared/pwa.js onState) into the flags.
export function reduceWorkerState(flags, state) {
  const next = { ...flags, available: state.available ?? null, ready: Boolean(state.ready), applying: state.applying === true };
  // "Reloading" is only true while an accepted activation is still going ahead; a deferred activation keeps the page, so the loader must go.
  if (!next.applying) next.reloading = false;
  if (state.statusKey === 'updateFailed') { next.failed = true; next.applying = false; next.reloading = false; }
  else if (state.statusKey === 'appUpToDate') { next.failed = false; next.checked = true; }
  return next;
}
