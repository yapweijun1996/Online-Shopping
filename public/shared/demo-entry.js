// Entry is created only after the server explicitly identifies a fictional demo.
export async function mountDemoEntry(root) {
  try {
    const response = await fetch('/api/v1/shop', { cache: 'no-store' });
    if (!response.ok || (await response.json()).demoRolesAvailable !== true || !root.isConnected) return;
    const section = document.createElement('section'); section.className = 'demo-role-entry';
    const note = document.createElement('p'); note.textContent = 'Fictional private preview workspace · resets on new login · expires after one hour';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    for (const [role, label] of [['ADMIN', 'Login as Admin'], ['SELLER', 'Login as Seller preview']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = label;
      button.addEventListener('click', async () => {
        for (const item of section.querySelectorAll('button')) item.disabled = true;
        try {
          const result = await fetch('/api/v1/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
          if (!result.ok) throw Error('unavailable');
          location.assign('/demo/');
        } catch {
          status.textContent = 'Preview workspace unavailable. Try again.';
          for (const item of section.querySelectorAll('button')) item.disabled = false;
        }
      });
      section.append(button);
    }
    section.prepend(note); section.append(status); root.prepend(section);
  } catch { /* Normal production login does not depend on demo availability. */ }
}
