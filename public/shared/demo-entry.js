// Entry is created only after the server explicitly identifies a fictional demo.
const roles = [
  ['SELLER', 'Try demo seller · no password', 'primary'],
  ['ADMIN', 'Open demo admin', 'link'],
];

export async function mountDemoEntry(root) {
  try {
    const response = await fetch('/api/v1/shop', { cache: 'no-store' });
    if (!response.ok || (await response.json()).demoRolesAvailable !== true || !root.isConnected) return;
    const section = document.createElement('section'); section.className = 'demo-role-entry';
    const divider = document.createElement('p'); divider.className = 'demo-role-divider'; divider.textContent = 'or';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const note = document.createElement('p'); note.className = 'demo-role-note';
    note.textContent = 'Fictional private workspace · resets on new login · expires after one hour';
    section.append(divider);
    for (const [role, label, kind] of roles) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = kind === 'primary' ? 'secondary-button demo-role-primary' : 'demo-role-link';
      button.textContent = label;
      button.addEventListener('click', async () => {
        for (const item of section.querySelectorAll('button')) item.disabled = true;
        try {
          const result = await fetch('/api/v1/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
          if (!result.ok) throw Error('unavailable');
          location.assign('/demo/');
        } catch {
          status.textContent = 'Demo workspace unavailable. Try again.';
          for (const item of section.querySelectorAll('button')) item.disabled = false;
        }
      });
      section.append(button);
    }
    section.append(note, status);
    const submit = root.querySelector('#login-submit');
    if (submit) submit.after(section); else root.append(section);
  } catch { /* Normal production login does not depend on demo availability. */ }
}
