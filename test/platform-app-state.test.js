import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appState, bannerState, initialFlags, reduceWorkerState } from '../public/platform/app-state.js';

const flags = (over = {}) => ({ ...initialFlags(), booted: true, ...over });

test('state priority: reloading, updating, failed, update available, error, offline, ready, starting', () => {
  assert.equal(appState(initialFlags()), 'STARTING'); assert.equal(appState(flags()), 'READY'); assert.equal(appState(flags({ offline: true })), 'OFFLINE');
  assert.equal(appState(flags({ workerError: 'x', offline: true })), 'ERROR'); assert.equal(appState(flags({ ready: true, workerError: 'x' })), 'UPDATE_AVAILABLE');
  assert.equal(appState(flags({ failed: true, ready: true })), 'UPDATE_FAILED'); assert.equal(appState(flags({ applying: true, failed: true })), 'UPDATING');
  assert.equal(appState(flags({ reloading: true, applying: true })), 'RELOADING');
});

test('a dismissed update never hides the offline warning, and an undismissed one shows', () => {
  const update = flags({ ready: true, available: 'v2' });
  assert.equal(bannerState(update), 'UPDATE_AVAILABLE');
  assert.equal(bannerState({ ...update, dismissed: 'v2' }), null);
  assert.equal(bannerState({ ...update, dismissed: 'v2', offline: true }), 'OFFLINE');
  assert.equal(bannerState({ ...update, dismissed: 'v1' }), 'UPDATE_AVAILABLE', 'a newer version re-offers the update');
  assert.equal(bannerState(flags()), null); assert.equal(bannerState(flags({ offline: true })), 'OFFLINE'); assert.equal(bannerState(flags({ failed: true })), 'UPDATE_FAILED');
});

test('a deferred activation ends RELOADING so the loader cannot stay on screen', () => {
  const accepted = reduceWorkerState(flags({ ready: true, available: 'v2' }), { available: 'v2', ready: true, applying: true });
  assert.equal(appState(accepted), 'UPDATING');
  const reloading = { ...accepted, reloading: true };
  assert.equal(appState(reloading), 'RELOADING');
  const deferred = reduceWorkerState(reloading, { available: 'v2', ready: true, applying: false, statusKey: 'updateAvailable' });
  assert.equal(deferred.reloading, false); assert.equal(appState(deferred), 'UPDATE_AVAILABLE');
});

test('failed updates and clean checks are reported', () => {
  const failed = reduceWorkerState(flags({ applying: true, reloading: true }), { applying: true, statusKey: 'updateFailed' });
  assert.equal(failed.failed, true); assert.equal(failed.applying, false); assert.equal(failed.reloading, false); assert.equal(appState(failed), 'UPDATE_FAILED');
  const clean = reduceWorkerState(failed, { applying: false, statusKey: 'appUpToDate' });
  assert.equal(clean.failed, false); assert.equal(clean.checked, true);
  assert.equal(reduceWorkerState(clean, { checking: true }).checking, true); assert.equal(reduceWorkerState(clean, {}).checking, false);
});
