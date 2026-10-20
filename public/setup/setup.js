let code = location.hash.slice(1);
history.replaceState(null, '', location.pathname + location.search);
const form = document.querySelector('#claim'), status = document.querySelector('#status');
const error = document.querySelector('#error'), button = form.querySelector('button');
const unavailable = () => { code = ''; form.hidden = true; status.textContent = 'This page is not available'; };
const failed = () => { error.textContent = 'Unable to complete setup. Check your details or sign in to the platform if you already submitted them.'; error.hidden = false; error.focus(); };
let pending = false;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) return;
  error.hidden = true;
  if (!form.reportValidity() || form.elements.password.value !== form.elements.confirm.value) { failed(); return; }
  pending = true; button.disabled = true; form.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('../api/v1/setup/claim', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, email: form.elements.email.value, username: form.elements.username.value, password: form.elements.password.value }),
    });
    if (!response.ok) throw new Error('claim');
    const result = await response.json();
    const target = new URL(result.nextUrl);
    if (target.protocol !== 'https:' || target.pathname !== '/platform/' || target.search || target.hash || target.username || target.password) throw new Error('target');
    code = ''; form.reset(); form.hidden = true;
    status.textContent = 'Account created. Sign in to finish authenticator setup.';
    const link = document.querySelector('#continue'); link.href = target.href; link.hidden = false;
    location.replace(target.href);
  } catch { failed(); }
  finally { pending = false; button.disabled = false; form.removeAttribute('aria-busy'); }
});
try {
  const response = await fetch('../api/v1/setup/status', { credentials: 'omit', cache: 'no-store' });
  if (!response.ok || !(await response.json()).open || !/^[A-Za-z0-9_-]{43}$/.test(code)) unavailable();
  else { status.textContent = 'Create your SuperAdmin account.'; form.hidden = false; form.elements.email.focus(); }
} catch { unavailable(); }
