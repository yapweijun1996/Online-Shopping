# PWA and internationalization requirements

**Status: both local PWA shells and seven-language seller/shop core UI run in Chromium.** Distinct manifests/service-worker scopes, public-shell caches and offline pages exist. Local 320/1280px seller, catalog, cart, checkout, receipt, error, status, focus and accessible-label checks support AC-15/18. Target-device installation and deployed update acceptance remain unverified under AC-17.

## PWA

- Serve production pages over HTTPS. Provide an installable web app manifest for each installable surface, with its own app name, start URL, scope, display mode, theme colors, and suitable 192px and 512px icons. Verify install behavior on target browsers rather than assuming every browser offers the same prompt. See [MDN installability guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) and the [Web Application Manifest specification](https://www.w3.org/TR/appmanifest/).
- Use a service worker for an offline app shell and a clear offline page. A service worker is an offline capability choice, not a universal prerequisite for installation. Cache versioned public static assets and translation bundles; refresh safely after deployment. See [MDN offline guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation).
- Do not cache seller sessions, private API responses, buyer details, or order responses in the service worker. Seller and checkout mutations require a live server response. If offline, show a clear unavailable state and let the user retry when online; do not claim an order or review decision was saved.
- Preserve the IndexedDB boundary: the current cart module keeps product IDs and quantities locally with an in-memory fallback; the latest minimal same-browser receipt is kept in localStorage. Authoritative prices and orders stay on the server. An installable PWA does not make browser storage permanent.
- Verify install/launch, navigation, offline fallback, safe update behavior, and authenticated-data boundaries on mobile and desktop before release. Local Chromium already showed the seller offline page, disabled offline review controls, failed-offline decision without a success claim, and public-only static cache entries; target-device installation remains.

The current workers use an explicit public-file allowlist and separate seller/shop cache versions. Bump the affected worker version whenever its precached files change; bump both when a shared file changes. A controlled page keeps its current cached shell while a new worker waits, so navigation does not mix new HTML with old scripts. Shop shows the active version and manual Check for updates under Account → Settings, plus a Home banner only when an update is actionable; Seller retains its update entry. A waiting worker exposes its target version through a message channel. Updating checks for unsaved work and active submissions before activation; only the requesting tab reloads automatically on controller change, while other tabs offer a reload without interrupting their forms. Closing all controlled pages still allows normal activation. Version numbers come from each worker configuration, independently of package.json or Cloudflare deployment IDs. Registration bypasses the HTTP cache for update checks; returning to the tab and reconnecting also check for updates. Offline/manual failures are retryable. Existing pre-v37/v41 clients lack this UI and need all old tabs closed once to adopt it. Target-device installation remains unverified.

In a dedicated persistent desktop Chrome test profile on local loopback, DevTools reported zero installability errors for each manifest, both pages were service-worker controlled, and each emitted `beforeinstallprompt`. An incognito profile reported only `in-incognito`. These checks do not establish actual installation or production HTTPS behavior.

## Language order and codes

English is the default. Show languages in this exact sequence everywhere, including the selector and translation file organization:

| Order | Language label | Initial language tag |
| --- | --- | --- |
| 1 | English | `en` |
| 2 | Bahasa Melayu | `ms` |
| 3 | 简体中文 (Mandarin) | `zh-Hans` |
| 4 | Tiếng Việt | `vi` |
| 5 | ไทย | `th` |
| 6 | 日本語 | `ja` |
| 7 | 한국어 | `ko` |

The initial Mandarin written form is Simplified Chinese, matching the owner's current written preference; this can be changed or expanded without changing order data. These tags are BCP 47 language tags. Declare the active language on the HTML root and use locale-aware number/date formatting. See [W3C language declarations](https://www.w3.org/International/docs/bp-html-lang/) and [MDN JavaScript internationalization](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Internationalization).

## Translation behavior

Both online shells and their offline pages use a compact SVG globe button for language selection. It opens a keyboard-accessible list in the required order, announces the selected language, closes with Escape or an outside click, and returns focus after a choice. Visible brand marks are the shared SVG asset; the manifests retain PNG sizes for installation compatibility. Seller category/settings and image-removal states have translations in all seven locales.

- Both customer and seller interfaces support all seven languages. Keep interface strings in locale resources, not duplicated across components. English is the source and fallback when a noncritical translation is missing during development; complete and review every core flow in all seven languages before release.
- The language selector changes labels, validation messages, empty/error states, accessibility names, order status wording, and navigation without altering server status codes, IDs, customer-entered values, or authoritative prices.
- Language choice is independent of phone calling code. The Profile and address editor derive MY `+60` or SG `+65` from the public shop's default currency (MYR or SGD).
- Remember the chosen language for that browser; a first visit defaults to English. Do not infer an account identity from the language choice.
- Keep product names and descriptions as seller-authored content. The current catalog stores one seller-authored text set, shown unchanged in every UI language. Optional localized product text with English fallback and stable order snapshots is deferred as [LATER-02](TASK.md).
- Allow text expansion and appropriate fonts for all scripts. Do not use flags to stand for languages. Test desktop and mobile layouts in every language, including long labels, line wrapping, copy controls, and screen-reader language announcement.

Release v39/v43: all shop ES module imports are covered by an automated offline-allowlist regression test. Live v38 detected v39 and showed the save-work confirmation. The Chrome extension connection timed out at confirmation, so that old-tab reload is not claimed verified. A fresh independent Chrome session displayed v39 and loaded the address book/editor successfully. Seven language dictionaries have matching nonempty keys.

## Legacy clients without update controls

Shop v36 cached a registration-only PWA module and cannot display the later update UI. Use `/shop-update.html` (Cloudflare canonicalizes it to `/shop-update`) to recover without clearing browser data. This page is outside the `/shop/` worker scope, loads the current shared update module, and shows the waiting worker version. Activation still requires explicit confirmation. After activation it returns to `/shop/`; an out-of-scope page observes worker state instead of relying on controllerchange. Cart IndexedDB, Profile/address local storage and tab selection storage are not cleared. Unsaved forms must be saved before updating.

Shop v41 / Seller v45 include the recovery-compatible shared module. Automated regression tests cover cancelled versus confirmed activation and scope-limited shell cache cleanup. Real installed-PWA and software-keyboard checks still require a connected phone.

## Shop v42 / Seller v46

Shop update presentation now lives in Account → Settings. A separate catalog banner appears only when a worker is waiting or an externally activated worker requires this page to reload. `registerWorker` publishes shared state and commands to the Shop view, while its legacy footer remains available to Seller and the recovery page. Foreground, online and initial checks are coalesced. Clean updates take one click; unsaved profile/address edits require the shared dialog, and cart writes/order submission block activation. No business storage is cleared. Profile drafts survive internal navigation until saved or the page is reloaded.

Language and category choices share the native-dialog shell with update confirmation: fullscreen through 760px, centered above that breakpoint, SVG close, Escape, restored trigger focus, locked background scrolling and reduced-motion support. Address dialogs retain their existing behavior. Home explicitly resets search/category/pagination and scroll even when the hash is unchanged; returning from product details retains browsing state. Stale filter completion cannot scroll over a newer Home request. Catalog failures expose Retry.

Regression verification: 72 tests, JavaScript syntax validation and Worker dry-run pass. Chrome checks cover mobile dialog/cart layouts and desktop layout. Physical phone keyboard and installed-PWA checks remain unverified without a connected device.

Shop v43 / Seller v47 harden update recovery: a successful automatic check after an error clears the stale failure message. Worker activation-message exceptions and activation timeouts release the applying state and allow retry without refreshing the page. Version-query message exceptions are treated as unavailable version information. Offline/network/activation retry regression tests cover these transitions; Chrome validates offline error → automatic online recovery and clean/dirty update interactions.

Shop v46 / Seller v48 cache the product gallery, option selector, search controls, and seller gallery manager. Product image URLs remain network-managed; a waiting Shop v46 worker shows the existing Home update banner and activates only after the user chooses Update.

Shop v47 / Seller v49 include the seven-language product-information heading and reorganized detail layout. The shared translation file changes both precached shells; Shop's service worker also caches the detail controller and stylesheet. Updating remains user-initiated.

Shop v48 / Seller v50 add localized previous/next photo controls and a phone SKU selection sheet. Both shells advance because the shared translation file is cached by both; existing update consent and saved browser data are unchanged.

Shop v49 / Seller v51 use the shared native dialog for address selection and editing. On phones it fills the screen. The public shop endpoint includes the seller's default currency, which determines the address country and fixed calling prefix. Malaysian addresses require line 1, city, state and a five-digit postcode found in the [MCMC postcode dataset](https://data.gov.my/data-catalogue/poskod); the postcode must match the selected state. The bundled June 2026 snapshot is CC BY 4.0 and should be refreshed when the annual source changes. City is free text. Existing saved addresses remain available to edit; incomplete or wrong-country entries cannot be selected for a new checkout. Address line 2 remains optional.

Shop v50 / Seller v52 also fixes the buyer Profile calling prefix to the shop's default-currency country. A saved phone from another country remains visible for correction but cannot unlock checkout; an email-only Profile remains valid. The shared localization change advances both workers.

Shop v51 adds product-card skeletons for initial catalog, search/category changes and pagination, plus a matching product-detail placeholder. The existing localized loading status remains available to assistive technology while decorative placeholders are hidden from it. Reduced-motion users see static placeholders. Failed catalog requests remove placeholders and expose Retry; pagination failure retains already loaded cards and retries the same offset.

Shop v52 extends the same loading feedback to cart price checks. Existing rows and their totals are hidden while product data is refreshed; the checkout action stays disabled until the request succeeds. Failure removes the skeleton, retains browser cart data and offers Retry without reporting an empty cart. Quantity-button focus returns after successful refresh.

Shop v53 waits 250ms before showing catalog, product-detail, or cart skeletons, so fast responses do not flash placeholders. A separate full-screen startup overlay appears only when initial shop setup exceeds 180ms. It closes as soon as initialization finishes; after 8 seconds it offers a page retry. Normal route changes continue to use inline feedback. Reduced-motion mode keeps the startup progress indicator static.

Shop v54 / Seller v53 style the shared update confirmation as a compact centered dialog on mobile and desktop. Language, category and address dialogs retain their existing full-screen phone layout. The confirmation keeps Cancel as the initial focus target and gives its two actions consistent touch-sized styling.

Shop v55 gives the Settings cards a consistent 16px gap and removes empty status paragraphs and default heading margins that made the cards look uneven. No browser storage or update behavior changes.

Shop v56 / Seller v54 change the seven-language Settings help text to name the Language button without assuming its position. The Shop Account pages share a 16px section rhythm; saved address cards also use a 16px grid gap, with empty status space removed. Shared translations require both service-worker cache versions to advance. No browser storage or order behavior changes.

Shop v57 / Seller v55 introduce Shop-only semantic color tokens in `/shop/tokens.css`. Shared base components accept those tokens with their previous colors as fallbacks, so Seller retains its existing appearance. Shop prices, order totals, warning/error states and brand controls have separate roles; this release adds no palette picker or persisted preference. The Shop HTML theme color now matches its manifest and primary brand token (`#087f83`), checked by a PWA regression test. The Shop worker caches the token file, and the Seller worker advances because the shared base stylesheet changed.

Shop v58 selects the Evergreen Teal palette. Shop input, search, category, outline-button, modal action, and mobile category boundaries use the stronger control-border token; keyboard focus uses the primary teal token. Price and order-total roles use a stable terracotta distinct from the brand color. The Shop-only style and token files change, so Seller remains v55. A contrast regression test checks the released role pairs; no preference or browser storage changes.

Shop v59 changes selected navigation and badge text to the darker selected-text role so their small labels remain legible on pale selected surfaces. The same contrast regression test covers both selected backgrounds. Seller remains v55.

## Candidate version and draft protection (Shop v104 / Seller v80)

Current version identifies the loaded app shell, even when another tab activates a newer worker. Seller Account and Customer Settings show the version; a ready-update button includes its target worker version. Update checks never force activation. Customer profile/address drafts and cart/checkout writes, Seller product/company/category drafts and order decisions, and page-wide in-flight Seller writes guard activation. Unsaved drafts require explicit confirmation. If a field changes or a write starts after activation was accepted, reload is deferred until another explicit update action. Cart/profile/address browser storage is never cleared by update; service-worker caches still contain only the allowlisted public shell. Local Chromium/VM evidence does not satisfy installed target-device AC-17.
