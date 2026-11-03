# Platform admin console as a PWA (PWA Product Standard v1.0)

Scope: the SuperAdmin console at `/platform/` (the "Admin Panel"). Source standard: KB-MCP skills `pwa:product-standard` v1.0.0 and `pwa:sw-install-integrity`. The skills are marked unverified in the KB, so every rule below was checked against this repository and against real Chrome behaviour. Results are in "Acceptance evidence"; anything not measured is marked NOT TESTED.

## Single sources of truth

| Concern | Authoritative file | Used by the platform through |
|---|---|---|
| Colours and semantic roles (`--ui-*`, `--shop-error`, `--shop-warning-*`) | `public/shop/tokens.css` | symlink `platform/shop/tokens.css`; semantic aliases `--ui-danger`, `--ui-warning-*` in `platform/style.css` |
| Layering, motion, radius, shadow, safe-area tokens (`--ui-z-*`, `--ui-motion-fast`, `--ui-radius-*`, `--ui-shadow-*`, `--ui-safe-*`) | `public/shop/tokens.css` | `var(--ui-…)` only; `platform/style.css` has no raw colours, numeric z-index or `env(safe-area-…)` (tested) |
| Layout and controls | `public/seller/style.css`, `public/seller/commerce.css`, `public/shared/base.css` | `@import` and symlinks |
| Icons (SVG only) | `public/shared/icons.js` | `platform/shared/icons.js` symlink |
| Modal and confirm | `public/shared/modal.js` | symlink |
| Service Worker core (versioned cache, offline page, explicit `SKIP_WAITING`) | `public/shared/sw-core.js` | `importScripts('../shared/sw-core.js')` |
| Update lifecycle (waiting worker, guard, activation, reload) | `public/shared/pwa.js`, `public/shared/update-guard.js` | symlinks, wired in `platform/pwa-shell.js` |

Platform-only files: `manifest.webmanifest`, `sw.js`, `version.js`, `offline.html`, `pwa-shell.js` (DOM, banner, loader, top bar, scroll-to-top) and `app-state.js` (pure lifecycle rules, unit-tested). Everything the worker needs lives under `/platform/` (symlinks to the shared files and the Seller icons), so a host that serves only `/platform/*` can install it.

## Gap analysis before this change

| Rule | Before | Now |
|---|---|---|
| Manifest and installability | none | `manifest.webmanifest`, own id and scope `/platform/`, standalone, 192 and 512 icons |
| Service Worker, versioned cache | none | `sw.js` on `shared/sw-core.js`, cache `os-platform-<version>`, old caches removed on activation |
| Explicit update UX and loader | none | visible banner with **Update now** and **Later**, loader overlay, page behind it inert, one reload |
| Application states | none | `STARTING READY OFFLINE UPDATE_AVAILABLE UPDATING RELOADING ERROR UPDATE_FAILED` on `<html data-app-state>` |
| Offline contract | none | defined below |
| iOS standalone, safe areas | none | `viewport-fit=cover`, `--ui-safe-*` on top bar, sidebar, banner, loader, scroll-to-top, bottom padding |
| Solid theme-aware status bar | none | `theme-color` for light and dark equal to the top bar surface, `apple-mobile-web-app-status-bar-style=default`, opaque top safe-area surface |
| Smart top bar, scroll-to-top | none | hide on scroll down and reveal on scroll up (8 px, transform only), button after one viewport |
| 16 px inputs on phones | not set | set below 720 px |

## Offline contract

| Feature | Offline behaviour |
|---|---|
| Cold launch while offline | The cached `offline.html` (platform styles) is shown: "You are offline", with a Try again link. |
| Application already open, connection lost | State `OFFLINE`: a banner says nothing is saved while offline. Live data is not refreshed. |
| Live API data (`/api/…`) | Needs the network. The worker never intercepts or caches `/api/` requests (tested). |
| Changes (rename, reset password, create shop, …) | Never reported as done without a server answer; a failed request shows an error. There is no write queue. |
| Sign-in and sessions | Need the network; session state is never stored in Cache Storage, `localStorage` or `sessionStorage` (tested). |
| Cached files | Only the static shell listed in `sw.js` (HTML, JS, CSS, icons). A test compares the list with the files the page actually imports, so it cannot drift. |

## Update lifecycle (version N to N+1)

1. A release changes `version.js` and the `version` in `sw.js` together (a test enforces the pair), so the worker bytes change.
2. The browser installs the new worker; it waits. Checks run on start, when the tab becomes visible, when the network returns, every 10 minutes while the page is visible (a phone tab can stay open for days), and from **Account, Check for updates**.
3. State `UPDATE_AVAILABLE`: an **Update** button appears in the top bar (icon with a dot on a phone; it also brings a hidden smart top bar back) and a banner offers **Update now** or **Later**. Later hides only the banner; the top bar button and the Account screen keep the option. Nothing reloads by itself.
4. Unsaved form entries or a request in flight make the update ask first (confirm dialog) or wait.
5. **Update now**: state `UPDATING`, loader and inert page, `SKIP_WAITING`, wait for the controller change, state `RELOADING`, one reload into the new version, old cache deleted.
6. Failure: `UPDATE_FAILED` with Try again; the current version keeps working.

Release rule: bump both version strings whenever any file listed in `sw.js` changes, then run `node scripts/platform-shell-fingerprint.mjs`. CI fails (`test/platform-pwa.test.js`) when a cached file changes under an unchanged version, because installed browsers would otherwise keep serving the old cached files and never offer the update. (This happened once: the top bar update button shipped under version v1 and was invisible to browsers that had already installed v1; fixed by releasing v2 and adding the guard.)

## Acceptance evidence

Tests: `test/platform-pwa.test.js` (static) and `test/platform-pwa-browser.test.js` (real Chrome with a real Service Worker, builds v1 and v2 served from a switchable local server; run with `QA_PLAYWRIGHT_MODULE`).

| Validation | Result | Evidence |
|---|---|---|
| SSOT consistency | PASS | shared files are the same bytes as the platform symlinks; no copies (static test) |
| Design token reuse | PASS for platform CSS, PARTIAL overall | no raw colours or numeric z-index in `platform/style.css` (static test). Spacing and many radii in the legacy shared CSS are still literal values. |
| Component consistency | PASS | sign-in fields, icons, modal and buttons come from shared files; password field uses the Seller login component |
| Responsive layout | PASS | no horizontal overflow at 320 px, sidebar becomes a drawer, touch targets of at least 44 px in the drawer (browser test) |
| iOS safe areas | PARTIAL | the shell reads `--ui-safe-*` (top inset override of 47 px changes top bar height, padding and the opaque surface). A real notch is NOT TESTED. |
| Status-bar theme | PASS in Chrome, NOT TESTED on iOS | top bar colour equals `theme-color` in light and dark (browser test) |
| Manifest and installability | PASS statically, NOT TESTED in an install flow | manifest fields and real PNG sizes (static test); browser install prompt not exercised |
| Service Worker versioning | PASS | cache `os-platform-v1`, then only `os-platform-v2` after the update (browser test) |
| Update notification | PASS | top bar button (desktop and 390 px, 44 px target) and banner; no reload for 1.5 s after the new version is found (browser test) |
| Update loader | PASS | loader seen with the page inert and one navigation, even after a double click (browser test) |
| Offline contract | PASS | OFFLINE state, cold offline launch shows the offline page, no `/api/` in the cache (browser test) |
| Accessibility | PARTIAL | `role=status` regions for the banner and loader, `aria-hidden` SVG icons, 44 px targets, native buttons (keyboard operable by construction, not separately tested for the new controls). Screen reader use and contrast ratios NOT TESTED. |
| Security and privacy regression | PASS | the CSRF token and shop data are in no storage and in no cached request URL or cached response body (browser test); `/api/` and non-GET requests are never intercepted (static test) |
| Smart top bar | PASS | hidden with a transform on scroll down, shown on scroll up and near the top (browser test) |
| Scroll-to-top | PASS | hidden at the top, shown after one viewport, scrolls to the top, 44 px target (browser test) |
| Light and dark theme chrome | PASS in Chrome | see status-bar row |
| Reduced motion | PASS | no transition on the top bar under `prefers-reduced-motion` |

## Exceptions and open items

- Resolved: Seller and Shop no longer use `autoUpdate`; all three consoles apply an update only on a tap. The stand-alone recovery page `/shared/shop-update.html` (opened on purpose to rescue an old installed shop) still activates the waiting version by itself, because opening it is the user's choice.
- One manifest `theme_color` cannot follow the colour scheme; the manifest carries the light colour and the page `theme-color` meta tags carry both.
- Real iPhone standalone behaviour (Dynamic Island, home indicator, status bar icon contrast) must be checked on a device before it is called verified.

## Independent review (Codex, read-only) and what changed

| Finding | Severity | Resolution |
|---|---|---|
| The worker imported `/shared/` and `/seller/` files, which a platform-only host (`Caddyfile.production`, `admin.gmb01.xyz`) does not serve, so install would fail there | High | All worker inputs now live under `/platform/`; a static test fails if any cached file is outside it |
| "Update now" could reload while one-time recovery codes or new seller credentials were on screen | High | Those states count as unsaved: the update asks first (browser test for both) |
| A deferred activation left the loader and inert page up | Medium | `reduceWorkerState` clears `reloading` when activation is deferred (unit test) |
| Dismissing the update banner hid the offline warning | Medium | `bannerState` shows OFFLINE regardless (unit and browser test) |
| The privacy claim inspected cache request URLs only | Low | The test now reads cached response bodies too |

## Account screen (Security)

`Account` is one Security group: Change password (shows the server rules, asks for the new password twice, checks locally before sending, never sends the confirmation field) and Recovery codes (a confirmation names the consequence first; the codes are then shown once and must be saved). Details sit in a second column from 1100 px: who is signed in, appearance, app version. Phones get one column with security first (no overflow at 320, 390 and 430 px, browser test). Each action keeps its own "Current password" field on purpose: both endpoints re-check it, and re-authenticating per sensitive action is the safer design. Not tested: the on-screen keyboard.

## Shops list

Header: title with a live summary ("30 shops · 24 active · 6 suspended") and **Add shop** on the same row. Toolbar: a search field capped at 480 px with an icon, a Clear button only while there is a query, and a labelled Status filter. The table card shows one result count; its footer (range, rows per page, pager) appears only when there is more than one page, and rows-per-page only above ten shops; a visually hidden status line keeps the count announced for screen readers. Rows: name with a "Default shop" chip, code underneath, readable status chip, unambiguous dates (02 Nov 2026), then **Manage** plus a "More actions" menu (open shop, open seller, copy either link, with a "copied" message). Phones get cards. Covered by `test/platform-shops-list-ui.test.js`: menu keyboard use, copy to clipboard, search and no-results, paging with 30 shops, empty and error states, long names, no overflow at 320, 390, 430, 768 px and at 200% zoom, touch targets, focus visibility, and the Activity page that shares the table. Not changed: the sidebar keeps its own "Add shop" entry (navigation), and the visual polish items for the sidebar and top bar.

## Shared top bar Update button and the version guard (all consoles)

`public/shared/topbar-update.js` is the one Update control for Platform, Seller and Shop (styles in `public/shared/base.css`): visible while an update waits (dot), installs (disabled) or failed (Retry), icon-only on phones, 44 px. `test/console-update-browser.test.js` runs Seller and Shop with a real Service Worker: the button appears for a new version, the page does not reload by itself for 3 s, and one tap reloads once into the new version with a single new cache.

The version guard covers all three: `test/platform-shell.fingerprint.json` records, per surface, the hash of every file its worker caches next to its version; CI fails when a cached file changes and the version did not. After bumping `version.js` and the worker `version`, run `node scripts/platform-shell-fingerprint.mjs`.

Sidebar polish (shared with Seller): one selected-state signal (background, no extra bar), readable group labels, tighter rhythm, one icon gap. Platform top bar: the role appears once as a "SuperAdmin" chip (the "SuperAdmin portal" eyebrow is gone; the eyebrow slot now only carries breadcrumbs), and the avatar and "Account" form one control.

## Seller sign-in footer

The sign-in card keeps the sign-in action as its only emphasis. The privacy note sits under the button (13 px); system information sits below a divider as one footer row: "Seller Studio · v156" on the left and one update state on the right: **Check for updates** (quiet underlined text, never the brand colour), **Checking for updates…**, **Up to date** with a check icon, **Update to vN** (outlined, applied only on a tap), or **Check failed** with Try again. The flow is the shared one (`registerWorker` actions); the button now calls the check directly and is disabled while a background check runs, so a tap is never dropped. Browser autofill no longer paints the fields blue. Covered by `test/seller-login-footer-browser.test.js` with a real Service Worker (all five states, divider and spacing, 12 px minimum, keyboard focus, no reload by itself, 320 px). Not changed: the hero panel and the brand shown in both the top bar and the card.
