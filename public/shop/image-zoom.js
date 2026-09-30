import { t } from '../shared/i18n.js';

export function boundedZoom(scale, x, y, width, height) {
  scale = Math.min(4, Math.max(1, Number.isFinite(scale) ? scale : 1));
  const maxX = width * (scale - 1) / 2;
  const maxY = height * (scale - 1) / 2;
  return { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
}

// Pointer handling is confined to this dialog; browser/page zoom is untouched.
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
  let state = { scale: 1, x: 0, y: 0 }, pointers = new Map(), gesture, start, lastTap = 0;
  let active = false, entry, scrollY = 0, returning = false, failed = false;
  let swipe = () => {};
  function apply(scale = state.scale, x = state.x, y = state.y) {
    state = boundedZoom(scale, x, y, stage.clientWidth, stage.clientHeight);
    image.style.transform = `translate(${state.x}px,${state.y}px) scale(${state.scale})`;
    stage.dataset.zoomed = String(state.scale > 1);
    status.textContent = `${Math.round(state.scale * 100)}%`;
    minus.disabled = failed || state.scale === 1;
    plus.disabled = failed || state.scale === 4;
    reset.disabled = failed || state.scale === 1;
  }
  function control(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label);
    button.addEventListener('click', action); controls.append(button); return button;
  }
  const minus = control('−', t('zoomOut'), () => apply(state.scale - .5));
  const plus = control('+', t('zoomIn'), () => apply(state.scale + .5));
  const reset = control('↺', t('resetZoom'), () => apply(1, 0, 0));
  controls.append(status); dialog.querySelector('.image-viewer-header').prepend(controls);
  const error = document.createElement('span'); error.className = 'image-zoom-error';
  error.textContent = t('imageMissing'); error.hidden = true; stage.append(error);
  function resetImage() { lastTap = 0; pointers.clear(); gesture = null; start = null; failed = false; error.hidden = true; image.hidden = false; apply(1, 0, 0); }
  image.addEventListener('load', () => { failed = false; error.hidden = true; image.hidden = false; apply(1, 0, 0); });
  image.addEventListener('error', () => { failed = true; image.hidden = true; error.hidden = false; apply(1, 0, 0); });
  function finish(restore = true) {
    active = false; returning = false; pointers.clear();
    window.removeEventListener('popstate', onBack, true);
    window.removeEventListener('resize', onResize);
    document.documentElement.classList.remove('image-zoom-open');
    dialog.close();
    if (restore) { window.scrollTo(0, scrollY); if (trigger.isConnected) trigger.focus({ preventScroll: true }); }
  }
  function onBack(event) {
    if (!active) return;
    event.stopImmediatePropagation(); finish();
  }
  function onResize() { apply(); }
  function dismiss() {
    if (!active || returning) return;
    if (history.state?.shopImageZoom === entry) { returning = true; history.back(); }
    else finish();
  }
  closeButton.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length && !el.hidden);
      const first = items[0], last = items.at(-1);
      if (items.length && ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first) || !dialog.contains(document.activeElement))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); apply(state.scale + .5); }
    if (event.key === '-') { event.preventDefault(); apply(state.scale - .5); }
    if (event.key === '0') { event.preventDefault(); apply(1, 0, 0); }
    if (state.scale > 1 && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      apply(state.scale, state.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), state.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0));
    }
  }, true);
  stage.addEventListener('pointerdown', event => {
    if (failed || (event.pointerType === 'mouse' && event.button !== 0)) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    start = { x: event.clientX, y: event.clientY, moved: false, multi: pointers.size > 1 };
    if (pointers.size === 2) {
      const [a,b] = [...pointers.values()];
      gesture = { distance: Math.hypot(a.x-b.x,a.y-b.y), scale: state.scale, x: state.x, y: state.y, cx: (a.x+b.x)/2, cy: (a.y+b.y)/2 };
    } else gesture = { x: state.x, y: state.y, cx: event.clientX, cy: event.clientY };
  });
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (start && Math.hypot(event.clientX-start.x,event.clientY-start.y)>8) start.moved = true;
    if (pointers.size === 2 && gesture?.distance) {
      const [a,b] = [...pointers.values()];
      apply(gesture.scale * Math.hypot(a.x-b.x,a.y-b.y) / Math.max(1,gesture.distance), gesture.x + (a.x+b.x)/2-gesture.cx, gesture.y + (a.y+b.y)/2-gesture.cy);
    } else if (pointers.size === 1 && state.scale > 1 && gesture) apply(state.scale, gesture.x+event.clientX-gesture.cx, gesture.y+event.clientY-gesture.cy);
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    const ended = start; pointers.delete(event.pointerId);
    if (!pointers.size && ended && event.type === 'pointerup' && !ended.multi) {
      const dx = event.clientX-ended.x, dy = event.clientY-ended.y;
      if (state.scale === 1 && Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)*1.4) swipe(dx<0 ? 1 : -1);
      else if (!ended.moved) { const now = Date.now(); if (now-lastTap<300) { apply(state.scale>1 ? 1 : 2.5,0,0); lastTap=0; } else lastTap=now; }
    }
    if (pointers.size) { const p=[...pointers.values()][0]; gesture={x:state.x,y:state.y,cx:p.x,cy:p.y}; if(start)start.multi=true; }
    else { gesture=null; start=null; }
  }
  stage.addEventListener('pointerup', release); stage.addEventListener('pointercancel', release);
  return {
    reset: resetImage,
    setSwipe(handler) { swipe = handler; },
    open() {
      if (active) return; resetImage(); scrollY=window.scrollY; entry=`image-${Date.now()}`;
      history.pushState({ ...history.state, shopImageZoom: entry }, '', location.href);
      active=true; window.addEventListener('popstate',onBack,true); window.addEventListener('resize',onResize);
      document.documentElement.classList.add('image-zoom-open'); dialog.showModal(); apply(); closeButton.focus();
      if (image.complete && !image.naturalWidth) { failed=true; image.hidden=true;error.hidden=false;apply(); }
    },
    destroy() {
      if (!active) return;
      if(history.state?.shopImageZoom===entry) { const next={...history.state}; delete next.shopImageZoom;history.replaceState(next,'',location.href); }
      finish(false);
    },
  };
}
