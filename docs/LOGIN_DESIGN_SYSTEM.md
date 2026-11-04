# Seller and Platform login design system

## Objective and current evidence

The Seller Studio and Platform administrator sign-in pages must share one implementation of the login layout and its responsive behavior. The live Platform v16 copied Seller dimensions into separate selectors; its `#main` safe-area padding then left a 24px white strip under the image. Equal widths and matching colors did not prove the card edges were aligned. Baseline: `4bfa2b75dd7f714a547be079963e945a47a6c463` (2026-11-04).

## Ownership and contract

- `public/shared/login-shell.css` owns the sign-in shell: card layout, image/intro geometry, title styling, form-area placement and responsive breakpoints. Seller and Platform use the same `.login-layout`, `.login-intro`, `.login-photo`, `.login-intro-content`, `.login-hero-title`, and `.login-area` contracts; there must not be a second set of Platform-specific shell dimensions.
- The common stylesheet is imported by the existing Seller stylesheet already used by both surfaces. The Platform-scoped shared asset is a symlink to the same file, not a copy. Existing shared tokens, input, button and footer components remain in their current sources until a separately justified migration; this work does not claim the entire application is a unified design system.
- Outer page and safe-area spacing belongs outside the visual card. The card owns its border and clipping; on desktop the image, intro and form area meet the card's inside bottom edge, regardless of outer padding. Mobile stacking and short-screen behavior use explicit shared modifiers if needed, rather than copied geometry.
- Seller and Platform may differ in title, copy, logos, language, update presentation, responsive content emphasis and accessibility semantics. Seller accounts are per-shop; Platform uses a separate SuperAdmin session and mandatory authenticator/recovery flow. No UI sharing may change authentication, CSRF, rate limits, permissions, trusted-device behavior or secret handling.

## Implementation and release sequence

1. Capture current main revision, repository state, existing seller/platform layout and PWA asset graphs. Keep a clean isolated branch.
2. Extract the shared shell rules and responsive breakpoints from Seller's existing styles to the common file; replace their old definitions rather than maintaining duplicate copies. Adopt the same shell structure in Platform and keep page-specific form/status styling local. Preserve safe-area padding on the outer page.
3. Update both surfaces' Service Worker asset lists, version identities and shell fingerprints; ensure Platform-only hosting and tenant-prefixed Seller URLs can load the one shared source.
4. Add behavior-based checks for shared ownership and drift: Seller/Platform card and image edge alignment, desktop column geometry, mobile stacking, no horizontal overflow, keyboard focus, light/dark and short viewports. Keep auth, error/retry, MFA, PWA update/offline and signed-in regression checks.
5. Run syntax, focused browser and PWA checks, the repository suite, and exact-commit CI with PostgreSQL. Distinguish skipped tests, simulated environments, and physical-device or screen-reader gaps.
6. Once CI and immutable GCP images pass, release the exact authorized main revision using the existing updater; verify live revision, health, static asset hashes and both visible login screens without using real credentials. The updater retains its previous application image for rollback; never change or delete database volumes.

## Acceptance

- One canonical shell stylesheet exists and both surfaces load it; duplicate Platform shell rules are removed. A shared-rule change affects both surfaces, while authentication remains independent.
- At 1920, 1440, 1024, 768, 390 and 320 CSS px, check both pages: no unexplained strip at the card/image edge, no page-level horizontal overflow, controls are reachable, and safe-area insets do not cover content. For stacked layouts assess the relevant edges rather than expecting the intro and full card to have equal heights.
- Existing Seller sign-in, language selection and Platform CSRF/session/MFA/recovery and password visibility continue to function. Tests use synthetic credentials and data; no production login, order, or account mutations.
- Both cached shell inventories and versions match their assets, both update flows require user activation and protect drafts, and platform-only hosting resolves all assets. Physical iOS, assistive technologies, color contrast and live authentication are reported separately if not actually tested.
- Capture exact checks, failures, release and rollback evidence in `docs/TASK.md`; do not mark planned work deployed before observing it.

## State

Implemented and verified locally on 2026-11-04 against baseline `4bfa2b75`: both pages use `public/shared/login-shell.css`; Platform resolves the same file via a symlink and keeps safe-area padding outside the card. Browser geometry checks covered 1920/1440/1024/768/390/320px, both card edges and a synthetic dark-mode safe area; a 320×568 Platform primary action remained visible. Seller seven-locale overflow, synthetic Platform sign-in/MFA and update behavior were checked. Tenant-prefixed Seller and Platform-scoped static asset resolution passed. Focused checks passed 33/33; the full local suite passed 709 with 168 skipped, and syntax passed. CI, immutable image publication, live asset and release evidence are separate from this local record. Physical iOS, real screen readers, image-overlay contrast ratios and real production authentication remain unverified.

## Live verification (2026-11-04)

GCP accepted application revision `410beec4d33b882edcef34fee415d1de735dc387` after the exact-SHA GitHub verification and image publication passed. Platform v17 and Seller v163 were served; both scoped login-shell CSS responses matched the committed shared file. Seller and shop readiness returned that revision. At 1920 and 768 CSS px, live Seller and Platform image bottoms met the card edge inside the 1px border; at 390 and 320px, the stacked image and form sections met without a gap or horizontal overflow. Backend and PostgreSQL reported healthy; the PostgreSQL container was not recreated. Browser checks were unauthenticated and used desktop Chromium. Physical iOS, screen readers, image-overlay contrast ratios and production login remain unverified.
