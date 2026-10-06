// Entry is created only after the server explicitly enables passwordless sign-in for this site.
export async function mountDemoEntry(root, { onSignedIn } = {}) {
  try {
    const response = await fetch('/api/v1/shop', { cache: 'no-store' });
    const shop = response.ok ? await response.json() : {};
    if (shop.demoRolesAvailable !== true || !root.isConnected) return;
    const section = document.createElement('section'); section.className = 'demo-role-entry';
    const divider = document.createElement('p'); divider.className = 'demo-role-divider'; divider.textContent = 'or';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button demo-role-primary';
    button.textContent = 'Try the seller dashboard · no password';
    const note = document.createElement('p'); note.className = 'demo-role-note';
    note.textContent = 'Opens the seller dashboard of this sample store so you can explore it. No password needed.';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await fetch('/api/v1/seller/demo-session', { method: 'POST', cache: 'no-store' });
        if (!result.ok) throw Error('unavailable');
        onSignedIn?.();
        location.assign('/seller/');
      } catch {
        status.textContent = 'Quick sign-in is unavailable. Try again.';
        button.disabled = false;
      }
    });
    section.append(divider, button, note, status);
    if (/^[0-9]{8,15}$/.test(shop.quickLoginContact ?? '')) {
      const contact = document.createElement('a'); contact.className = 'demo-role-contact';
      contact.href = `https://wa.me/${shop.quickLoginContact}?text=${encodeURIComponent('Hi, I tried the online shop system and I am interested.')}`;
      contact.target = '_blank'; contact.rel = 'noopener noreferrer';
      contact.textContent = 'Interested? Chat with us on WhatsApp';
      section.append(contact);
    }
    const submit = root.querySelector('#login-submit');
    if (submit) submit.after(section); else root.append(section);
  } catch { /* Normal production login does not depend on demo availability. */ }
}
