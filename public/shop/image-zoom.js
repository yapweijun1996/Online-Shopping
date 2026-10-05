import { t } from '../shared/i18n.js';

export function boundedZoom(scale, x, y, width, height, imageWidth = width, imageHeight = height) {
  scale = Math.min(4, Math.max(1, Number.isFinite(scale) ? scale : 1));
  const maxX = Math.max(0, (imageWidth * scale - width) / 2);
  const maxY = Math.max(0, (imageHeight * scale - height) / 2);
  return { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
}

// Keep the image point beneath the cursor/pinch midpoint fixed, until an edge is reached.
export function zoomAt(state, scale, anchorX, anchorY, width, height, imageWidth = width, imageHeight = height, dx = 0, dy = 0) {
  const nextScale = boundedZoom(scale, 0, 0, width, height).scale;
  const ratio = nextScale / state.scale;
  return boundedZoom(nextScale, anchorX - (anchorX - state.x) * ratio + dx, anchorY - (anchorY - state.y) * ratio + dy, width, height, imageWidth, imageHeight);
}

// All custom gestures belong to the opened image stage. Modified wheel/key input
// remains available for browser accessibility zoom, including trackpad pinch-as-Ctrl+wheel.
export function attachImageZoom(dialog, image, trigger, closeButton) {
  const stage = document.createElement('div');
  stage.className = 'image-zoom-stage';
  stage.tabIndex = 0;
  stage.setAttribute('aria-label', t('zoomImage'));
  image.replaceWith(stage); stage.append(image);
  const controls = document.createElement('div');
  controls.className = 'image-zoom-controls';
  const status = document.createElement('output');
  status.setAttribute('aria-live', 'polite');
  let state = { scale: 1, x: 0, y: 0 }, gesture, session, lastTap;
  const pointers = new Map();
  let active = false, entry, scrollY = 0, returning = false, failed = false;
  let swipe = () => {};
  function geometry() {
    const width = stage.clientWidth, height = stage.clientHeight;
    const naturalWidth = image.naturalWidth || width || 1, naturalHeight = image.naturalHeight || height || 1;
    const fit = Math.min(width / naturalWidth, height / naturalHeight);
    return { width, height, imageWidth: naturalWidth * fit, imageHeight: naturalHeight * fit };
  }
  function apply(scale = state.scale, x = state.x, y = state.y) {
    const g = geometry();
    state = boundedZoom(failed ? 1 : scale, failed ? 0 : x, failed ? 0 : y, g.width, g.height, g.imageWidth, g.imageHeight);
    image.style.transform = `translate(${state.x}px,${state.y}px) scale(${state.scale})`;
    stage.dataset.zoomed = String(state.scale > 1);
    status.textContent = `${Math.round(state.scale * 100)}%`;
    minus.disabled = failed || state.scale === 1;
    plus.disabled = failed || state.scale === 4;
    reset.disabled = failed || state.scale === 1;
  }
  function anchored(scale, x = 0, y = 0, base = state, dx = 0, dy = 0) {
    const g = geometry();
    const next = zoomAt(base, scale, x, y, g.width, g.height, g.imageWidth, g.imageHeight, dx, dy);
    apply(next.scale, next.x, next.y);
  }
  function clearGesture() {
    const ids = [...pointers.keys()];
    pointers.clear(); gesture = null; session = null; lastTap = null;
    delete stage.dataset.dragging;
    for (const id of ids) if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
  }
  function interactable() { return active && !returning && !failed && image.complete && image.naturalWidth > 0; }
  function changeScale(scale) { if (interactable()) { clearGesture(); anchored(scale); } }
  function fitImage() { if (active && !returning) { clearGesture(); apply(1, 0, 0); } }
  function control(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label);
    button.addEventListener('click', action); controls.append(button); return button;
  }
  const minus = control('−', t('zoomOut'), () => changeScale(state.scale - .5));
  const plus = control('+', t('zoomIn'), () => changeScale(state.scale + .5));
  const reset = control('↺', t('resetZoom'), fitImage);
  controls.append(status); dialog.querySelector('.image-viewer-header').prepend(controls);
  const error = document.createElement('span'); error.className = 'image-zoom-error';
  error.textContent = t('imageMissing'); error.hidden = true; stage.append(error);
  function resetImage() { clearGesture(); failed = false; error.hidden = true; image.hidden = false; apply(1, 0, 0); }
  image.addEventListener('load', resetImage);
  image.addEventListener('error', () => { clearGesture(); failed = true; image.hidden = true; error.hidden = false; apply(1, 0, 0); });
  function finish(restore = true) {
    active = false; returning = false; clearGesture();
    window.removeEventListener('popstate', onBack, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', clearGesture);
    document.removeEventListener('visibilitychange', onVisibility);
    document.documentElement.classList.remove('image-zoom-open');
    dialog.close();
    if (restore) { window.scrollTo(0, scrollY); if (trigger.isConnected) trigger.focus({ preventScroll: true }); }
  }
  function onBack(event) {
    if (!active) return;
    event.stopImmediatePropagation(); finish();
  }
  function onResize() { clearGesture(); apply(); }
  function onVisibility() { if (document.hidden) clearGesture(); }
  function dismiss() {
    if (!active || returning) return;
    clearGesture();
    if (history.state?.shopImageZoom === entry) { returning = true; history.back(); }
    else finish();
  }
  closeButton.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('click', event => { if (returning) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  dialog.addEventListener('keydown', event => {
    if (!active) return;
    if (returning) { event.stopImmediatePropagation(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length && !el.hidden);
      const first = items[0], last = items.at(-1);
      if (items.length && ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first) || !dialog.contains(document.activeElement))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); changeScale(state.scale + .5); }
    if (event.key === '-') { event.preventDefault(); changeScale(state.scale - .5); }
    if (event.key === '0' || event.key === 'Home') { event.preventDefault(); fitImage(); }
    if (state.scale > 1 && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation(); clearGesture();
      apply(state.scale, state.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), state.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0));
    }
  }, true);
  stage.addEventListener('wheel', event => {
    if (!interactable() || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !event.cancelable || !event.deltaY) return;
    event.preventDefault();
    if (pointers.size) return;
    lastTap = null;
    const rect = stage.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    const delta = Math.max(-300, Math.min(300, event.deltaY * unit));
    anchored(state.scale * Math.exp(-delta * .0025), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  }, { passive: false });
  stage.addEventListener('dragstart', event => { if (active) event.preventDefault(); });
  function rebase() {
    const [a, b] = [...pointers.values()];
    if (pointers.size === 2) {
      const rect = stage.getBoundingClientRect();
      gesture = { distance: Math.hypot(a.x - b.x, a.y - b.y), state: { ...state }, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, ox: rect.left + rect.width / 2, oy: rect.top + rect.height / 2 };
    } else if (pointers.size === 1) gesture = { x: state.x, y: state.y, cx: a.x, cy: a.y };
    else gesture = null;
  }
  stage.addEventListener('pointerdown', event => {
    if (!interactable() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    stage.setPointerCapture(event.pointerId);
    if (!pointers.size) session = { x: event.clientX, y: event.clientY, moved: false, multi: false, fit: state.scale === 1 };
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) { session.multi = true; lastTap = null; }
    stage.dataset.dragging = String(state.scale > 1);
    rebase();
  });
  stage.addEventListener('pointermove', event => {
    if (!interactable() || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (session && Math.hypot(event.clientX - session.x, event.clientY - session.y) > 8) session.moved = true;
    if (pointers.size === 2 && gesture?.distance) {
      const [a, b] = [...pointers.values()];
      anchored(gesture.state.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance, gesture.cx - gesture.ox, gesture.cy - gesture.oy, gesture.state, (a.x + b.x) / 2 - gesture.cx, (a.y + b.y) / 2 - gesture.cy);
    } else if (pointers.size === 1 && state.scale > 1 && gesture) apply(state.scale, gesture.x + event.clientX - gesture.cx, gesture.y + event.clientY - gesture.cy);
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    if (event.type !== 'pointerup' || !interactable()) { clearGesture(); return; }
    const ended = session;
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!pointers.size) {
      gesture = null; session = null; delete stage.dataset.dragging;
      if (ended && !ended.multi) {
        const dx = event.clientX - ended.x, dy = event.clientY - ended.y;
        if (ended.fit && state.scale === 1 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) { lastTap = null; swipe(dx < 0 ? 1 : -1); }
        else if (!ended.moved && Math.hypot(dx, dy) <= 8) {
          const now = Date.now();
          if (lastTap && now - lastTap.time < 300 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
            const rect = stage.getBoundingClientRect();
            anchored(state.scale > 1 ? 1 : 2.5, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2); lastTap = null;
          } else lastTap = { time: now, x: event.clientX, y: event.clientY };
        } else lastTap = null;
      } else lastTap = null;
    } else rebase();
  }
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('lostpointercapture', release);
  return {
    reset: resetImage,
    setSwipe(handler) { swipe = handler; },
    open() {
      if (active) return; resetImage(); scrollY = window.scrollY; entry = `image-${crypto.randomUUID()}`;
      history.pushState({ ...history.state, shopImageZoom: entry }, '', location.href);
      active = true; window.addEventListener('popstate', onBack, true); window.addEventListener('resize', onResize);
      window.addEventListener('blur', clearGesture); document.addEventListener('visibilitychange', onVisibility);
      document.documentElement.classList.add('image-zoom-open'); dialog.showModal(); apply(); closeButton.focus();
      if (image.complete && !image.naturalWidth) { failed = true; image.hidden = true; error.hidden = false; apply(); }
    },
    destroy() {
      if (!active) return;
      if (history.state?.shopImageZoom === entry) { const next = { ...history.state }; delete next.shopImageZoom; history.replaceState(next, '', location.href); }
      finish(false);
    },
  };
}
