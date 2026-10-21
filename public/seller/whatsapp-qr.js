import qrcode from './vendor/qrcode.js';
import { translate } from '../shared/i18n.js';
import { confirmModal } from '../shared/modal.js';
import { node, button, text, client, failureText, watch } from './whatsapp-qr-ui.js';
const path = 'integrations/whatsapp-qr';
export function mountWhatsAppQr(root, { csrfToken, onUnauthorized, role = 'OWNER', encoder = qrcode, confirm = confirmModal }) {
  const section = node('section', null, 'settings-card whatsapp-qr-card'); section.hidden = true; root.append(section);
  let state = null, busy = false, loading = false, last = 0, onScreen = true, canvas = null, countdown = null;
  let pairWaitingUntil = 0;
  const owner = role === 'OWNER';
  const lifecycle = watch(section, csrfToken(), csrfToken, force => {
    if (pairWaitingUntil && Date.now() >= pairWaitingUntil) { pairWaitingUntil = 0; render(); }
    updateCountdown();
    const pending = pairWaitingUntil > Date.now() || state && (state.desired === 'PAIR' && state.state === 'IDLE' || ['PAIRING','CONNECTING','RECONNECTING'].includes(state.state));
    const interval = pending ? 2000 : state?.state === 'CONNECTED' && onScreen ? 15000 : Infinity;
    if (force || Date.now() - last >= interval) load();
  });
  const api = client({ csrfToken, onUnauthorized: () => { if (lifecycle.current()) onUnauthorized(); } });
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { onScreen = entries[0].isIntersecting; }) : null;
  observer?.observe(section);
  const line = node('p'); line.setAttribute('aria-live', 'polite'); line.setAttribute('role', 'status');
  function updateCountdown() {
    if (!countdown) return;
    const seconds = Math.max(0, Math.ceil((Date.parse(state.qrExpiresAt) - Date.now()) / 1000));
    countdown.textContent = seconds ? text('seconds', seconds) : text('expired');
    if (!seconds && canvas) { canvas.width = 0; canvas.remove(); canvas = null; render(); }
  }
  function render() {
    if (!lifecycle.current() || !state) return;
    const focused = section.contains?.(document.activeElement);
    if (canvas) canvas.width = 0;
    canvas = null; countdown = null;
    section.hidden = !state.available; section.replaceChildren();
    if (section.hidden) return;
    const heading = node('h2', 'title'); heading.append(node('span', 'unofficial', 'status-badge')); section.append(heading);
    const notice = node(state.acknowledged ? 'details' : 'div', null, 'qr-risk');
    if (state.acknowledged) notice.append(node('summary', 'notice'));
    notice.append(node('p', 'risk')); section.append(notice);
    if (!state.acknowledged && owner) section.append(button('ack', () => mutate('acknowledge', { noticeVersion: 1 })));
    const linked = !pairWaitingUntil && state.desired !== 'OFF' && state.state === 'CONNECTED';
    const pending = pairWaitingUntil > Date.now() || state.desired !== 'OFF' && ['CONNECTING','RECONNECTING'].includes(state.state) || state.desired === 'PAIR' && state.state === 'IDLE';
    const errorKey = { LOGGED_OUT: 'loggedOut', RECONNECT_LIMIT: 'reconnectError' }[state.lastError] || 'error';
    const key = linked ? 'connected' : pending ? 'connecting' : state.state === 'PAIRING' && state.desired !== 'OFF' ? 'pairing' : state.state === 'LOGGED_OUT' ? 'loggedOut' : state.state === 'ERROR' ? errorKey : 'idle';
    const status = node('p', key, linked ? 'qr-connected' : pending ? 'qr-connecting' : ''); status.setAttribute('aria-live', 'polite'); section.append(status);
    if (linked) { const phone = node('p'); phone.textContent = state.phoneMasked || ''; section.append(phone); }
    if (owner && state.desired !== 'OFF' && state.state === 'PAIRING') {
      const remaining = Date.parse(state.qrExpiresAt) - Date.now();
      if (state.qr && remaining > 0) {
        canvas = node('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', text('qr'));
        try {
          const code = encoder(0, 'M'); code.addData(state.qr); code.make();
          const count = code.getModuleCount(), scale = 4, quiet = 4;
          canvas.width = canvas.height = (count + quiet * 2) * scale;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
          for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (code.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
          section.append(canvas, node('p', 'steps')); countdown = node('p'); section.append(countdown); updateCountdown();
        } catch { canvas.width = 0; canvas = null; line.textContent = text('error'); }
      } else section.append(button('expired', () => mutate('pair')));
    }
    if (owner && state.acknowledged) {
      if (linked) section.append(button('disconnect', async () => { if (await confirm(text('confirm'), { title: text('disconnect'), confirmLabel: text('disconnect') }) && lifecycle.current()) mutate('disconnect'); }));
      else if (!pending && state.state !== 'PAIRING' || state.desired === 'OFF') section.append(button(['ERROR','LOGGED_OUT'].includes(state.state) ? 'again' : 'pair', () => mutate('pair')));
    }
    section.append(line);
    section.querySelectorAll('button').forEach(el => { el.disabled = busy; });
    if (focused) { status.tabIndex = -1; status.focus(); }
  }
  async function load() {
    if (loading || !lifecycle.current() || document.hidden) return;
    loading = true; last = Date.now();
    try {
      const value = await api(path);
      if (!lifecycle.current()) return;
      const wasWaiting = pairWaitingUntil;
      if (value.desired === 'OFF' || ['PAIRING','CONNECTING','RECONNECTING'].includes(value.state) || value.state === 'CONNECTED' && value.desired === 'RUN') pairWaitingUntil = 0;
      if (wasWaiting !== pairWaitingUntil || JSON.stringify(state) !== JSON.stringify(value)) { state = value; render(); }
    }
    catch (error) { if (lifecycle.current() && error.status === 404) { state = null; section.hidden = true; section.replaceChildren(); } }
    finally { loading = false; }
  }
  async function mutate(action, body = {}) {
    if (busy || !lifecycle.current()) return;
    busy = true; line.textContent = ''; section.querySelectorAll('button').forEach(el => { el.disabled = true; });
    try {
      await api(`${path}/${action}`, body);
      // The API changes desired/generation before the worker reports a new state.
      if (action === 'pair') pairWaitingUntil = Date.now() + 60000;
      await load();
    }
    catch (error) { if (lifecycle.current()) line.textContent = failureText(error); }
    finally { busy = false; if (lifecycle.current()) section.querySelectorAll('button').forEach(el => { el.disabled = false; }); }
  }
  function dispose() {
    lifecycle.dispose(); observer?.disconnect(); if (canvas) canvas.width = 0;
    section.replaceChildren(); state = null;
    globalThis.window?.removeEventListener('pagehide', dispose);
  }
  globalThis.window?.addEventListener('pagehide', dispose);
  load();
  return { refreshLocale() { translate(section); render(); }, dispose };
}
