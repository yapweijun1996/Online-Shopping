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
      control.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
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
  });
})();
