import { t } from './i18n.js';

function workerVersion(worker) {
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (value) => { clearTimeout(timer); channel.port1.close(); resolve(value); };
    const timer = setTimeout(() => finish(null), 3000);
    channel.port1.onmessage = ({ data }) => finish(typeof data?.version === 'string' ? data.version : null);
    try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); }
    catch { finish(null); }
  });
}

export async function registerWorker(script, scope, { returnUrl, target, onState, guard, confirmUpdate, currentVersion, autoUpdate = false } = {}) {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.register(script, { scope, updateViaCache: 'none' });
  const panel = document.createElement('footer');
  panel.className = 'pwa-update';
  const version = document.createElement('span');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const check = document.createElement('button');
  const update = document.createElement('button');
  check.type = update.type = 'button';
  update.hidden = true;
  panel.append(version, check, status, update);
  if (!onState) (target || document.body).append(panel);
  let current = currentVersion || null;
  let available = null;
  let statusKey = '';
  let applying = false;
  let applyingWorker = null;
  let reloadReady = false;
  let reloadRequested = false;
  let activationTimer;
  let activationPoll;
  let activationSignature;
  let activationDirty = false;
  let autoTimer;
  const AUTO_KEY = `pwa-auto-update:${script}`;
  // Applies a ready update without a click, but only when no order submission or unsaved draft would be lost.
  function autoApply() {
    clearTimeout(autoTimer);
    if (!autoUpdate || applying || reloadRequested || (!registration.waiting && !reloadReady)) return;
    const state = guard?.();
    if (state?.busy || state?.dirty) { autoTimer = setTimeout(autoApply, 10000); return; }
    try {
      // A release that fails to take over must not reload the page in a loop.
      if (Date.now() - Number(sessionStorage.getItem(AUTO_KEY) || 0) < 30000) return;
      sessionStorage.setItem(AUTO_KEY, String(Date.now()));
    } catch { /* Storage may be unavailable; the throttle is best-effort. */ }
    applyUpdate({ silent: true });
  }
  function finishActivation() {
    if (reloadRequested) return;
    const state = guard?.();
    if (state?.busy || (!activationDirty && state?.dirty) || (activationSignature !== undefined && state?.signature !== activationSignature)) {
      clearTimeout(activationTimer); clearTimeout(activationPoll);
      applying = false; applyingWorker = null; reloadReady = true;
      update.disabled = check.disabled = false; statusKey = 'updateAvailable'; render();
      autoApply();
      return;
    }
    reloadRequested = true;
    clearTimeout(activationTimer);
    clearTimeout(activationPoll);
    if (returnUrl) location.assign(returnUrl);
    else location.reload();
  }
  function activationFailed() {
    clearTimeout(activationTimer);
    clearTimeout(activationPoll);
    applying = false;
    applyingWorker = null;
    update.disabled = check.disabled = false;
    statusKey = 'updateFailed';
    render();
  }
  function render() {
    version.textContent = `${t('appVersion')}: ${current || '—'}`;
    check.textContent = t('checkUpdates');
    status.textContent = statusKey ? t(statusKey) : '';
    update.textContent = `${t('updateApp')}${available ? ` · ${available}` : ''}`;
    update.hidden = !registration.waiting && !reloadReady;
    onState?.({ current, available, statusKey, ready: !update.hidden, checking: check.disabled, applying }, { check: () => checkForUpdates(true), update: () => applyUpdate() });
  }
  async function inspect() {
    if (!current) current = await workerVersion(navigator.serviceWorker.controller || registration.active);
    const waiting = registration.waiting;
    if (waiting) {
      const candidate = await workerVersion(waiting);
      if (registration.waiting === waiting) {
        available = candidate;
        if (!applying) statusKey = 'updateAvailable';
      }
    } else if (!reloadReady && statusKey === 'updateAvailable') {
      statusKey = '';
    }
    render();
    autoApply();
  }
  function watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // Activation may finish without a controllerchange callback in the current page.
      if (worker.state === 'activated' && worker === applyingWorker) { finishActivation(); return; }
      if (worker.state === 'installed' || worker.state === 'activated') inspect();
      if (worker.state === 'redundant' && worker === applyingWorker) activationFailed();
    });
  }
  registration.addEventListener('updatefound', () => watch(registration.installing));
  watch(registration.installing);
  watch(registration.waiting);
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (applying) { finishActivation(); return; }
    if (current) {
      available = await workerVersion(navigator.serviceWorker.controller);
      reloadReady = available !== current;
      if (reloadReady) statusKey = 'updateAvailable';
    }
    await inspect();
  });
  async function checkForUpdates(manual = false) {
    if (check.disabled || applying) return;
    if (!navigator.onLine) {
      if (manual) { statusKey = 'updateFailed'; render(); }
      return;
    }
    check.disabled = true;
    const reportResult = manual || statusKey === 'updateFailed';
    if (reportResult) { statusKey = 'checkingUpdates'; render(); }
    try {
      await registration.update();
      await inspect();
      if (reportResult && !applying && !registration.waiting && !reloadReady) {
        statusKey = registration.installing ? 'checkingUpdates' : 'appUpToDate';
      }
    } catch { if (reportResult && !applying) statusKey = 'updateFailed'; }
    finally { if (!applying) check.disabled = false; render(); }
  }
  check.addEventListener('click', () => checkForUpdates(true));
  async function applyUpdate({ silent = false } = {}) {
    if (applying || guard?.().busy) return;
    const accepted = silent || (confirmUpdate ? (!guard?.().dirty || await confirmUpdate(t('updateConfirm'))) : window.confirm(t('updateConfirm')));
    if (!accepted || applying || guard?.().busy) return;
    if (reloadReady) { location.reload(); return; }
    if (!registration.waiting) { inspect(); return; }
    applying = true;
    const acceptedState = guard?.();
    activationSignature = acceptedState?.signature;
    activationDirty = acceptedState?.dirty === true;
    update.disabled = check.disabled = true;
    statusKey = 'appUpdating';
    render();
    const waiting = registration.waiting;
    applyingWorker = waiting;
    try { waiting.postMessage({ type: 'SKIP_WAITING' }); }
    catch { activationFailed(); return; }
    function checkActivation() {
      if (!applying || reloadRequested) return;
      if (waiting.state === 'activated') { finishActivation(); return; }
      activationPoll = setTimeout(checkActivation, 250);
    }
    activationPoll = setTimeout(checkActivation, 250);
    activationTimer = setTimeout(() => {
      if (!applying) return;
      activationFailed();
    }, 15000);
  }
  update.addEventListener('click', () => applyUpdate());
  document.addEventListener('localechange', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdates();
  });
  window.addEventListener('online', () => checkForUpdates());
  document.addEventListener('updateguardchange', autoApply);
  if (autoUpdate) setInterval(() => { if (document.visibilityState === 'visible') checkForUpdates(); }, 300000);
  await inspect();
  checkForUpdates();
  return registration;
}
