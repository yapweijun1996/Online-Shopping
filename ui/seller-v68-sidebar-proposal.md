# Seller navigation visual proposal

## Recommendation

Use a focused correction, not a new navigation model. Keep the existing 248 px expanded desktop rail and 74 px icon rail, their six destinations, and the teal current-page treatment. The expanded rail is readable at 1440 px and gives long labels room to wrap. The compact rail preserves the workspace but removes labels and group names; retain it as an intentional space-saving option, and give every icon a localized accessible name and a hover/focus tooltip so destinations remain discoverable. At tablet and phone widths, keep a full-label modal drawer.

The small-screen header should show a static Seller portal mark/name and exactly one 44 px minimum `Close navigation` button. Remove the collapse chevron/toggle behavior from this responsive header: collapsing has no useful phone effect and competes with the X. The header opener remains the one entry point. This is the clearest correction supported by the current UI and requested behavior.

## Visual anchors

- [Desktop expanded and dashboard context](seller-v68-sidebar-proposal-desktop.svg) — 1440 × 900; expanded rail.
- [Tablet modal drawer and dashboard context](seller-v68-sidebar-proposal-tablet.svg) — 820 × 900; 300 px drawer.
- [Phone modal drawer and dashboard context](seller-v68-sidebar-proposal-mobile.svg) — 390 × 844; 300 px drawer, with visible dimmed page context.

The desktop anchor keeps the main dashboard panels and truthful `Simulated` state visible. At 820 px, the adjacent content is deliberately compressed to the available width. The tablet and phone anchors illustrate an open modal drawer; the exposed page is dimmed to show modality, not to imply that the obscured controls remain interactive.

## Responsive and keyboard specification

- Desktop: expanded rail is 248 px; compact rail is 74 px. The main workspace offsets to match. Keep six icon-only destinations centered in the compact rail, each with a localized accessible name and a visible tooltip on hover and keyboard focus. Preserve an unmistakable current-page background and teal edge marker in both modes.
- Tablet/phone: header menu button opens a full-label modal drawer. Drawer width is `min(300px, 86vw)`; backdrop covers the remaining viewport. The brand is not a collapse control. Provide one labeled close button with at least a 44 × 44 px target. Navigation rows remain at least 44 px tall and may grow for wrapped translations.
- On open, set the opener's expanded state and move focus to the current destination (or drawer heading/close button if that is more appropriate to the implementation). Keep keyboard focus inside the modal drawer. Escape and backdrop activation close it; clicks inside do not. On close, restore focus to the menu opener. Activating a destination also closes the drawer and moves focus to the new page heading, while retaining route-change/unsaved-change behavior.
- All six visible destination labels and the close accessible name must use the existing localization system. Check the longest strings in all seven supported languages; allow wrapping, avoid clipping, and permit vertical scrolling instead of shrinking text or hiding destinations.
- Keep the Demo/Simulated status in page content and ensure it is not mistaken for navigation. The drawing uses the screenshot's synthetic Demo content solely as context.
- Use a strong `:focus-visible` outline with adequate contrast, not color-only focus indication. Respect reduced-motion preferences for drawer transitions.

## Self-review

- Scope reviewed: `public/seller/index.html`, `public/seller/app.js`, `public/seller/style.css`, and the supplied desktop, collapsed-desktop, tablet-open, and phone-open screenshots. The app currently has a 248 px expanded rail and a 74 px collapsed rail. At small breakpoints the collapsed class is visually expanded again, while the brand button and a separate X remain; that explains the redundant phone controls.
- The anchors preserve the exact six navigation destinations, groupings, teal styling, and truthful Dashboard `Simulated` badge. No new count, section, or action was added. The desktop uses only the expanded state as the visual anchor; the compact state is specified because its icons cannot be self-explanatory without hover/focus labels.
- The phone screenshot gives the close control 52 × 48 px, tablet 48 × 48 px, and navigation rows 48 px; all satisfy the 44 px minimum. The longest navigation entry wraps on the phone without clipping.
- The SVGs are design illustrations with the same supplied viewport sizes; they are not browser captures and do not prove runtime focus trapping, localization fit, or responsive behavior. No app source, project documentation, tests, or KB was changed. KB retrieval was unavailable in this session, so the proposal relies on the checked local implementation and supplied screenshots.

## Parent review and implementation comparison

The outer Codex CLI invocation used `gpt-6-luna` with the four real screenshots; the first invocation failed after attempting an unnecessary nested CLI. The successful second invocation produced these SVGs directly. Parent review found that the first desktop drawing reversed the collapse chevron, so `gpt-6-luna` regenerated the [approved desktop illustration](seller-v70-sidebar-proposal-desktop.svg) with a left-pointing control; the earlier SVG remains historical. The modal drawer drawings are useful anchors for the static brand and single X close action. Browser testing exposed an additional focus leak into the page behind the open drawer; the implementation makes the drawer modal, keeps Tab inside it, and restores focus after closing or navigation.

Real local screenshots after implementation: [expanded desktop](seller-v70-after-sidebar-desktop.png), [collapsed desktop with keyboard tooltip](seller-v70-after-sidebar-desktop-collapsed-tooltip.png), [open tablet drawer](seller-v70-after-sidebar-tablet-open.png), and [open phone drawer](seller-v70-after-sidebar-mobile-open.png). They are browser captures, not generated proposals. At 320/390 px, all seven supported languages kept the drawer within the viewport. The remaining direct-device keyboard and installed-PWA checks are not established by viewport simulation.
