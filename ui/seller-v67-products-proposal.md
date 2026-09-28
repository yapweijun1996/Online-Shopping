# Seller Products list proposal (v67)

These standalone illustrations anchor the Products list at 1440 × 900, 820 × 900, and 390 × 844. Product art is labeled as illustration; catalog entries use synthetic Demo content. Keep the current teal visual system, persistent desktop sidebar, and existing tablet/mobile navigation drawer.

## Design handoff

- Keep the page title clear and place name/SKU search beside Add product. At mobile width, keep Search beside the input and move Add product to a full-width row below it.
- Use two-column cards on desktop and a single-column compact row layout at tablet width. On mobile, show one card per row with a small illustration, wrapping product name, SKU/category/price metadata, a textual Active/Inactive chip, then Edit and availability actions.
- Long names wrap to two lines without clipping metadata or status. Every visible button is at least 44 px high. Availability remains explicit in both the status label and Activate/Deactivate action.
- Add product and Edit product navigate to an individual product editor page. The current shared working tree now includes products/new and products/{id} editor route wiring; this proposal aligns the list actions with that flow. Reuse the existing seller create, detail, update, and status operations. No API changes are needed.
- After the global header and navigation, the page sequence is heading, search input, Search, Add product, then each row's Edit and availability action, followed by Load more. Keep a visible focus outline. Focus the editor heading/first field on navigation and restore focus to the initiating action when returning to the list. Retain the unsaved-change guard and availability Undo behavior.
- Loading shows skeleton rows and a polite status, distinct from an empty catalog. The empty catalog state offers Add product. A no-match state explains the name/SKU query found no products and allows clearing that query. Load errors keep the query and provide Retry. Show Load more only when the response has a nextOffset; expose its loading/disabled state. Announce status updates politely and failures as alerts.

## Responsive behavior

- **1440 px:** retain the 248 px sidebar; use a flexible search toolbar and two-column product cards with actions aligned at the bottom.
- **820 px:** keep the top bar and closed drawer; use one full-width column so long names and both actions have room.
- **390 px:** keep the top bar and drawer; stack Add product below the search row and use full-width cards with equal-width actions. Let metadata wrap and avoid horizontal scrolling.

## Evidence and self-review

The inspected client requests 24 products per page, searches by name or SKU, renders item status and actions, and uses nextOffset for pagination. The seller list API returns items and nextOffset rather than an exact total, so the proposal shows no count. Existing endpoints support product list/detail/create/update and availability PATCH. The current working tree has editor route wiring; no new endpoint or route name is proposed here.

Reviewed hierarchy, content density, long names, status text, 44 px product actions, focus sequence, empty/loading/error states, pagination, and the desktop/tablet/mobile shell. The 820 px anchor is a distinct layout, not a resized desktop image. All three SVGs pass XML parsing. A rendered preview could not be produced because no offline SVG renderer is installed and the browser policy blocked local-file URLs. The requested gpt-6-luna CLI review was attempted, but the sandbox denied the CLI's user-state database write and app-server initialization. No substitute model review is claimed; the proposal uses the supplied baseline screenshots and inspected source behavior.
