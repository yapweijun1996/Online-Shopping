# Customer catalog proposal

Three responsive visual anchors are provided at the requested viewports:

- `shop-v72-catalog-proposal-desktop.svg` — 1440×900
- `shop-v72-catalog-proposal-tablet.svg` — 820×900
- `shop-v72-catalog-proposal-mobile.svg` — 390×844

## Direction

Remove the large catalog hero and the repeated desktop category controls. Keep the shared Shop header, search, Browse/Cart, language and profile controls; move the full shop name into the compact demo notice. Put the catalog heading and loaded-item status directly above the results. Use one category control at each viewport: a pill rail on wide screens, a labeled 44px select at tablet width, and horizontally scrollable chips on mobile. Mobile Category navigation opens the existing chooser and updates those same chips.

At 1440px use four columns and landscape media; at 820px use three columns and a single compact category select; at 390px use two columns with square media and keep the five-item bottom navigation fixed. The first desktop and tablet card rows show product names, the actual formatted MYR prices, a product details link, and a 44px Add to cart button without scrolling. The first two mobile cards show those elements above the bottom navigation. Long names wrap naturally; do not drop variant or size text. Align actions at the bottom of each row while allowing taller rows for unusually long names.

## Existing contracts to preserve

- Catalog requests continue to use `/api/v1/products` with its existing search, category, limit, offset, and `nextOffset` behavior. Render only returned products and available categories.
- Use `formatMoney(priceMinor, currency)` for each product's price. The anchors use current Demo seed examples and amounts (for example, MYR 36.90 and MYR 73.90); their package/device drawings are synthetic and marked **ILLUSTRATION**.
- Product image and name/details links keep using `productHash(product.id)`. Add to cart continues through the existing `addToCart(product)` path. Do not change server APIs, price validation, cart, or checkout.
- `Products shown: 24` means the number loaded so far. Never present it as the catalog total or invent an overall count.
- Reuse existing localized strings for demo disclosure, categories, search, result count, Add to cart, loading, empty/error, retry, and pagination. Preserve all seven supported languages and the selected color palette.

## States and interaction

- **Loading:** keep the heading and filters stable, set the grid `aria-busy`, show the existing skeletons, and announce the localized loading status. For Load more, retain loaded cards and show the page spinner/message.
- **Empty catalog:** show the localized no-products message, with no fake cards or count.
- **Search/filter no match:** retain the query and selected category, explain that no products match, and offer a clear-search/clear-filter action. Do not show the unfiltered empty-catalog copy.
- **Request error:** show the existing network/offline message and retry control. On a later-page error, keep existing cards visible and retry the same offset.
- **Pagination:** show Load more only when `nextOffset` exists; announce completion when it is null. Keep the loaded-item count accurate as pages append.
- **Keyboard/accessibility:** retain the skip link to results and visible `:focus-visible` rings. Category chips expose `aria-pressed`; focus on a horizontally clipped chip scrolls it into view. The tablet select supports native keyboard/type-ahead. Search, product links, cart actions, language/profile controls, and mobile navigation remain in logical tab order; no focus trap is added to the page. Keep control targets at least 44px (mobile nav items at least 48px), preserve status live regions, and respect reduced-motion settings.

## Breakpoints and acceptance

- At ≥1100px: hide the redundant select/sidebar, show the category rail and four-column grid.
- At 761–1099px: hide the category rail/sidebar, show one labeled category select beside the catalog heading, and use three columns.
- At ≤760px: keep the search header, demo/shop name, scrollable category chips, two-column cards, and all five mobile navigation items. At ≤355px allow the existing one-column card fallback.
- Given a loaded catalog, the first row's add actions are visible without scrolling at 1440px and 820px; the first two are visible at 390px.
- Given a product card, its image/title detail route and Add to cart route still work; displayed price/currency come from that product record.
- Given loading, empty, no-match, network error, or a later-page error, show the matching localized state and preserve retry/loaded results behavior.

## Self-review

- **Desktop:** removes the tall hero and sidebar, preserves every global control and makes four complete cards discoverable early. Category labels and amounts remain readable; demo art cannot be mistaken for product photography.
- **Tablet:** the full-width category rail and duplicated select are replaced by one 48px select; three complete cards and actions fit in the first screen with breathing room.
- **Mobile:** preserves the compact search-only header, current fast-scanning chip pattern, two-column cards, visible purchase actions, and five-item navigation. The demo disclosure and full shop name fit before product browsing begins.
- **Trade-off to review:** landscape product media is shorter than the existing square catalog art at desktop/tablet. Keep `object-fit: contain` or an equivalent non-cropping treatment for actual images; use the card's neutral media background to avoid clipping product packaging.

## Parent review and implemented refinement

The real catalog uses seller images with text and packaging details. The implementation kept square `object-fit: contain` media to avoid cropping, while removing the hero and repeated desktop/tablet category controls. It keeps the configured shop name by the catalog heading, including in Production, where there is no Demo notice. A new no-match Clear filters action resets both query and category. Local browser checks found first-row Add to cart buttons inside the initial 900px viewport at 1440px, 820px, 390px and 320px, with no horizontal overflow; tablet category filtering, no-match recovery and Chinese mobile text also passed.
