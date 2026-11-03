import { icon } from './icons.js';

// The one top bar update control for every console (Platform, Seller, Shop). It is shown while an update waits, installs or
// has failed, and it never applies anything by itself: a tap runs the caller's explicit update (or a new check after a failure).
export function createTopbarUpdate({ update, retry }) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'topbar-update'; button.hidden = true;
  const label = document.createElement('span'); label.className = 'topbar-update-label';
  button.append(icon('download'), label);
  let mode = 'idle';
  button.addEventListener('click', () => { if (mode === 'failed') retry?.(); else if (mode === 'ready') update?.(); });
  // mode: 'idle' | 'ready' | 'busy' | 'failed'; text: { short, full } in the page's language.
  function render(next, { short, full } = {}) {
    mode = next; button.hidden = next === 'idle'; button.dataset.state = next; button.disabled = next === 'busy';
    label.textContent = short || ''; button.setAttribute('aria-label', full || short || ''); button.title = full || short || '';
  }
  return { element: button, render };
}

// Maps the shared update lifecycle state (public/shared/pwa.js onState) to a top bar mode.
export function topbarMode(state) {
  if (state?.applying) return 'busy';
  if (state?.statusKey === 'updateFailed' && state?.ready) return 'failed';
  if (state?.ready) return 'ready';
  return 'idle';
}
