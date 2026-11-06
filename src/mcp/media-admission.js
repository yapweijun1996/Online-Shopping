import { ApiError } from '../http.js';

// One process-wide lease across every tenant/connector, never one per adapter.
// No waiting queue and no reset/backdoor. The sole engine owns its finally release.
let active = null;
export function acquireMediaPreparation() {
  if (active !== null) throw new ApiError(503, 'MEDIA_BUSY', 'Media preparation is busy. Retry later.');
  const owner = Symbol(); active = owner;
  let held = true;
  return () => { if (held) { held = false; if (active === owner) active = null; } };
}
