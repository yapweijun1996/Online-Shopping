import './whatsapp-qr-copy.js';
import { t } from '../shared/i18n.js';
import { apiUrl } from '../shared/base-path.js';
import { beginMutation } from '../shared/update-guard.js';
export const text = (key, n) => t(`qr_${key}`).replace('{n}', String(n));
export function node(tag, key, className) {
  const el = document.createElement(tag);
  if (key) { el.dataset.i18n = `qr_${key}`; el.textContent = text(key); }
  if (className) el.className = className;
  return el;
}
export function button(key, action) {
  const el = node('button', key, 'secondary-button'); el.type = 'button'; el.addEventListener('click', action); return el;
}
export function client({ csrfToken, onUnauthorized }) {
  return async (path, body, key) => {
    const finish = body ? beginMutation() : () => {};
    try {
      const response = await fetch(apiUrl(`v1/seller/${path}`), { method: body ? 'POST' : 'GET', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(), ...(key ? { 'Idempotency-Key': key } : {}) } : {}, body: body ? JSON.stringify(body) : undefined });
      if (response.status === 401) onUnauthorized();
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('request'), { status: response.status, code: data.error?.code, reason: data.reason, retryAfter: Math.max(1, Number(response.headers.get('Retry-After')) || 60) });
      return data;
    } finally { finish(); }
  };
}
export const failureText = error => error.status === 429 ? text('retry', error.retryAfter) : text('failed');
// One bounded timer per surface; no requests after detach, logout or hidden pages.
export function watch(root, identity, csrfToken, tick) {
  let active = true;
  const current = () => active && root.isConnected && identity === csrfToken();
  const timer = setInterval(() => { if (!current()) { dispose(); return; } if (!document.hidden) tick(); }, 1000);
  timer.unref?.();
  const visible = () => { if (current() && !document.hidden) tick(true); };
  const clear = () => dispose();
  document.addEventListener('visibilitychange', visible);
  globalThis.window?.addEventListener('pagehide', clear);
  function dispose() { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); globalThis.window?.removeEventListener('pagehide', clear); }
  return { current, dispose };
}
