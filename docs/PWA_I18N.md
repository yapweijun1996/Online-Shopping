# PWA and internationalization requirements

**Status: design requirement with local shell implementation in progress.** Both surfaces now have distinct manifests/service-worker scopes, public-shell caches, offline pages, and seven-language shell resources. Full installation, checkout/review, and all-language acceptance remain unverified.

## PWA

- Serve production pages over HTTPS. Provide an installable web app manifest for each installable surface, with its own app name, start URL, scope, display mode, theme colors, and suitable 192px and 512px icons. Verify install behavior on target browsers rather than assuming every browser offers the same prompt. See [MDN installability guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) and the [Web Application Manifest specification](https://www.w3.org/TR/appmanifest/).
- Use a service worker for an offline app shell and a clear offline page. A service worker is an offline capability choice, not a universal prerequisite for installation. Cache versioned public static assets and translation bundles; refresh safely after deployment. See [MDN offline guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation).
- Do not cache seller sessions, private API responses, buyer details, or order responses in the service worker. Seller and checkout mutations require a live server response. If offline, show a clear unavailable state and let the user retry when online; do not claim an order or review decision was saved.
- Preserve the planned IndexedDB boundary: customer cart and minimal same-browser receipts may be local; authoritative orders stay on the server. An installable PWA does not make browser storage permanent.
- Verify install/launch, navigation, offline fallback, safe update behavior, and authenticated-data boundaries on mobile and desktop before release.

The current workers use an explicit public-file allowlist and separate seller/shop cache versions. Bump the affected worker version whenever its precached files change; bump both when a shared file changes. A controlled page keeps its current cached shell while a new worker waits, so navigation does not mix new HTML with old scripts. The new worker activates after old controlled pages close, then removes its prior cache. This local behavior was exercised in Chromium; target-device installation and update checks remain.

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

- Both customer and seller interfaces support all seven languages. Keep interface strings in locale resources, not duplicated across components. English is the source and fallback when a noncritical translation is missing during development; complete and review every core flow in all seven languages before release.
- The language selector changes labels, validation messages, empty/error states, accessibility names, order status wording, and navigation without altering server status codes, IDs, customer-entered values, or authoritative prices.
- Language choice is independent of phone calling code: a customer using any supported UI language can enter a Malaysia `+60` or Singapore `+65` buyer/recipient phone.
- Remember the chosen language for that browser; a first visit defaults to English. Do not infer an account identity from the language choice.
- Keep product names and descriptions as seller-authored content. The catalog model should allow optional localized text per supported language with English fallback, so multilingual catalog content can be added without redesigning product identity or order snapshots.
- Allow text expansion and appropriate fonts for all scripts. Do not use flags to stand for languages. Test desktop and mobile layouts in every language, including long labels, line wrapping, copy controls, and screen-reader language announcement.
