'use strict';
const main = document.querySelector('main');
const login = document.querySelector('#login');
const consent = document.querySelector('#consent');
const message = document.querySelector('#message');
let csrf = null;
const base = main.dataset.base;
async function send(path, body, extra = {}) {
  const response = await fetch(base + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Authorization failed. Restart the connection and verify your password.');
  return response.json();
}
login.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(login);
  try {
    const result = await send('/api/v1/seller/session', { username: data.get('username'), password: data.get('password'), mcpAuthorization: { authorizationRequestId: main.dataset.request, proof: main.dataset.proof } });
    csrf = result.csrfToken; login.reset(); login.hidden = true; consent.hidden = false;
    delete main.dataset.proof;
    consent.querySelector('button').focus(); message.textContent = 'Password verified. Choose access and approve or deny.';
  } catch (error) { login.reset(); message.textContent = error.message; }
});
consent.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!csrf) return;
  const buttons = [...consent.querySelectorAll('button')]; buttons.forEach((b) => { b.disabled = true; });
  try {
    const result = await send('/api/v1/seller/mcp/consent', { authorizationRequestId: main.dataset.request, decision: event.submitter.value, scopes: new FormData(consent).getAll('scope') }, { 'X-CSRF-Token': csrf });
    csrf = null; window.location.assign(result.redirectTo);
  } catch (error) { message.textContent = error.message; buttons.forEach((b) => { b.disabled = false; }); }
});
