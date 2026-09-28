# Seller portal responsive proposal

**Status:** generated as a design proposal before implementation. The companion SVG is an illustration, not a browser capture. The subsequent source changes and browser results are recorded in `docs/SELLER_PORTAL_E2E_REVIEW.md`.

## Layout decisions

| Viewport | Navigation and content |
| --- | --- |
| **Mobile · 390px (≤760px)** | Keep the existing header and one-column Products list. Keep the product search and Add product controls. Put Order number and Status fields in two equal columns, with Search on a second, right-aligned row. In the selected-order view, place **Back to orders** beside **Order details**; keep the order number and status directly below. |
| **Tablet · 820px (761–900px)** | Use the existing hamburger control to open the existing labelled navigation as a drawer over the page. The closed drawer leaves the full content width available. Show Products in two columns. Keep order filters on one row and preserve the current queue-then-detail flow: selecting an order opens its detail view, with a back control. |
| **Desktop · 1440px (>900px)** | Keep the persistent 248px sidebar and header, two-column Products grid, one-row order filters, and side-by-side order queue/details. A selected order fills the existing detail pane. |

Use the 900px navigation cutoff so the 820px tablet does not reserve sidebar width. Keep the current 760px content cutoff: only the drawer behavior is shared across 761–900px; phone-specific single-column layouts stay at 760px and below. Replace the current `@media(max-width:1199px)` one-column product override with two columns above 760px and one column at or below 760px. Keep the existing `@media(max-width:1080px)` queue/detail selection behavior.

## CSS and behavior handoff

| Existing owner / selector | Proposed adjustment |
| --- | --- |
| `#open-menu`, `#sidebar`, `.drawer-open`, `#drawer-backdrop`, `.topbar`, `.main` | Move the drawer presentation rules into a `max-width:900px` range: show the existing menu button and brand, remove the signed-in sidebar offsets, and slide the existing sidebar over a backdrop. At tablet width, keep the drawer closed initially. |
| `public/seller/app.js`: `syncDrawerAccess()`, `#collapse-nav` handler | Use the same `900px` media query as the CSS drawer cutoff for `inert` and drawer actions. Preserve focus to the close control on open, Escape/backdrop close, focus return to the menu button, route navigation, and page-title focus. Do not expose off-canvas links to keyboard or assistive-technology navigation while closed. |
| `.product-list`, `.product-card`, `.product-card-actions`, `.product-toolbar`, `.product-search`, `#product-new` | Two equal product columns above 760px; one column at 760px and below. Keep existing product card content, image, Active state, Edit product and Deactivate actions. Keep the mobile toolbar stacked as it is. |
| `.order-filter`, `.order-filter label`, `.order-filter button`, `#order-search`, `#order-status` | At ≤760px use a two-column grid for the labelled fields and put Search on its own right-aligned row. Above 760px retain the inline filter row; the drawer gives the 820px page room for both 210px-minimum fields and Search. Keep the current labels and control order. |
| `.order-layout`, `.order-queue`, `.order-detail`, `#workspace-content.order-show-detail` | Preserve the current ≤1080px queue/detail switch and the desktop split view. Do not add a new route or persistent filter state. |
| `.order-detail`, `.order-back`, `#order-detail-title`, `#order-detail-content` | In the ≤1080px selected-order view, use a two-column header row: title on the left, Back to orders on the right; let detail content span both columns. Remove the full-width sticky treatment from the back button. This saves vertical space without hiding the control. |
| `.page-heading` | At ≤760px reduce only the bottom gap (e.g. 12px) to bring the first card closer to the page title. Keep the eyebrow and page title. |
| `#open-menu`, `#close-menu`, `.language-trigger`, `.account-button` | Keep each header control's hit area at least 44×44px at mobile and tablet sizes; the avatar artwork can remain 30px inside its target. |

Keep the existing colors, typography, borders, radii, labels, Demo notice, `#products` / `#orders` / `#review` routes, search semantics, status options, and empty/loading/error messages. Keep visible focus styling. All interactive targets must remain at least 44px high; retain the existing 44px inputs and action buttons. Preserve DOM/tab order and semantic buttons, forms, labels, and headings. The icon-only navigation items retain their existing localized accessible names.

## Review checks for implementation

- At 390px, no horizontal overflow; both labelled order filters share a row, Search remains at least 44px high, and Back to orders shares a row with Order details.
- At 820px, navigation opens from the header and overlays rather than displacing content; Products show two columns; order Search stays on the filter row. The selected order remains reachable through the existing queue/detail flow.
- At 1440px, the sidebar remains persistent, Products remain two columns, and the order queue and details remain side by side.
- At all three sizes, keyboard focus remains visible, closed-drawer links are inert, opening/closing works by keyboard, and no labels, routes, Demo semantics, or actions change.

**Illustrative / validate during implementation:** the SVG uses representative Demo copy, first-fold crops, and schematic card heights. Verify actual localized text wrapping, long product names/order numbers, the 44px header targets, drawer focus/inert behavior at 820px, and the selected-detail header at narrow widths in a browser before merging CSS/JS changes.
