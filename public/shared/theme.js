/* Classic, parser-blocking script: resolve the shared preference before styles paint. */
(() => {
  const key = 'online-shopping-theme-v1';
  const modes = ['system', 'light', 'dark'];
  const valid = value => modes.includes(value) ? value : 'system';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let mode = 'system';
  try { mode = valid(localStorage.getItem(key)); } catch { /* Session-only preference when storage is unavailable. */ }
  const apply = () => {
    const theme = mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#202d25' : '#ffffff';
    const artwork = {
          system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
          light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
          dark: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>'
    };
    document.querySelectorAll('[data-theme-control] svg').forEach(icon => { icon.innerHTML = artwork[mode]; });
    document.querySelectorAll('[data-theme-control] select').forEach(select => { select.value = mode; });
  };
  apply();
  system.addEventListener('change', apply);
  addEventListener('storage', event => {
    if (event.key === key || event.key === null) { mode = valid(event.newValue); apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-control]').forEach(control => {
      // Outline artwork follows SVG Icon Studio: 24px viewBox, currentColor, rounded 1.5px strokes.
      control.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"></svg>';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Theme');
      for (const value of modes) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value[0].toUpperCase() + value.slice(1);
        select.append(option);
      }
      select.value = mode;
      select.addEventListener('change', () => {
        mode = valid(select.value);
        try { localStorage.setItem(key, mode); } catch { /* Keep the selected theme for this page. */ }
        apply();
      });
      control.append(select);
    });
    apply();
  });
})();
