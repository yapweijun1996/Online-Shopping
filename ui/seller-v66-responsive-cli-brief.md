# Seller portal responsive proposal brief

Use the attached real screenshots from the isolated local Demo seller portal. Produce a concrete visual **after proposal** for mobile 390px, tablet 820px, and desktop 1440px. The screenshots show Products, Sales Orders, and order detail. Save these files under `ui/`:

- `seller-v66-responsive-proposal.svg`: one viewable SVG artboard with clearly labeled mobile, tablet, and desktop panels. It is an illustration, not a running screenshot.
- `seller-v66-responsive-proposal.md`: concise implementation spec with exact responsive layout changes, CSS breakpoints, accessibility/interaction constraints, and mapping to current selectors.

Inspect `public/seller/index.html`, `public/seller/style.css`, and `public/seller/app.js` enough to ground the proposal. **Do not edit any source, test, configuration, or existing artifact. Only create the two proposal files above.** Use English in the artifacts.

Observed problems to solve: at 820px a full 248px sidebar starves the main area, Orders Search wraps to another line, Products are one sparse column, and at 390px the order filters and detail header consume too much first-screen space. Preserve the existing palette, UI components, labels, Demo semantics, routes, accessible names, 44px touch targets, and keyboard behavior. Do not invent features or show private information. Prefer the smallest feasible responsive adjustments. Include annotations showing which existing controls remain and how the navigation becomes available on tablet/mobile. Explicitly mark anything illustrative or requiring implementation validation.
