# Shared Seller and Shop themes

Seller Studio and Shop offer System, Light and Dark in the top bar beside the
language menu, including on mobile and the offline fallback pages. System is the
default and follows changes to the operating system's color scheme. Light and
Dark override that scheme. Both PWAs retain their locked zoom viewport.

`public/shared/theme.css` owns the shared color, palette and layout tokens. Dark
uses the Platform console's forest palette. Action backgrounds and action text
have separate roles so both white button labels and green links remain readable.
The ten presets in Appearance settings supply light and dark accent roles.
Dark mode uses a shared forest surface with palette-specific accents.
`public/shop/tokens.css` remains a compatibility import. Platform resolves
the shared files through its existing symlink layout and follows the operating
system theme.

`public/shared/theme.js` is a classic external script loaded before styles. It sets
`data-theme="light|dark"` and `data-theme-preference="system|light|dark"` on the root
before the page paints, then mounts the accessible native select controls at DOM
ready. Icons use inline 24px outline SVG with currentColor. The theme-color meta matches the neutral Topbar surface. Topbar styles
consume shared semantic color and typography tokens from `public/shared/base.css`.
Brand, utility, search, and count styles use reusable font roles. See
[Shop palettes](SHOP_PALETTES.md) for appearance preferences.

The `online-shopping-theme-v1` localStorage preference is shared across Seller,
Shop and shop prefixes on the same origin. It contains only a display preference;
shop data and the existing per-surface brand palette preferences keep their own
storage scopes. Storage exceptions fall back to a usable session-only choice.
Storage events synchronize open tabs. Each worker caches both shared files;
shell versions and fingerprints must be updated when they change.

## Local validation

```sh
npm ci
npm run check
NODE_ENV=test npm test
QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  NODE_ENV=test node --test test/theme-browser.test.js
```

Set `QA_BROWSER_EXECUTABLE` if using an existing Chromium executable rather than
Playwright's installed browser. `THEME_SHOTS` defaults to `/tmp/os-theme-shots`.
The browser test uses a disposable SQLite fixture and real Seller/Shop pages,
checks reload and cross-surface/tab persistence, System changes, blocked storage,
chrome colors, viewport overflow and token contrast. It captures light and dark
screenshots for `seller-login`, `seller-dashboard` and `shop` at 390 and 1440 pixels
as `<surface>-<width>-<mode>.png`, plus `report.json` with contrast measurements.
Browser tests require a runtime that permits Chromium and local HTTP listeners.
