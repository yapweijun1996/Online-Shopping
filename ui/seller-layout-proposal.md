# Seller portal layout proposal

This is a design proposal for the existing seller portal, not a capture of a running application. It keeps the current palette, typography, navigation, product cards, and service-worker update flow while making the three requested interactions easier to find.

## Component placement

### Product search

- Keep the search form at the top of the Products view, immediately below the page heading and above the product list.
- Use the existing search input and submit button. Give the input a visible hint, **“Name or SKU”**, and retain the accessible label **“Search products by name or SKU”**. A leading search icon is decorative; the words remain visible so the affordance does not depend on an icon.
- Keep Add product as a separate primary action in the same toolbar. At narrow widths it occupies its own row after search.
- At desktop, search input and Search button share the first row with Add product. Let the input take remaining width and set a sensible minimum width; allow the toolbar to wrap when its container cannot fit all three controls.

### Product-specific Undo

- After a successful Activate/Deactivate request, update that product card’s status and render an inline action message in the card footer, next to Edit product. Example copy: **“Deactivated · Undo”** or **“Activated · Undo”**. The Undo button’s accessible name identifies the product and operation, e.g. **“Undo deactivation for PETKIT Pura Max / Pura X Replacement Parts”**.
- Keep this action in the product card’s normal flow, not in a toast, fixed overlay, or page-level status region. It remains visible while the card is in the list and never covers another card or the search controls. On mobile it wraps below Edit product when needed.
- Undo sends the inverse active value for that product through the existing product PATCH endpoint. On success, restore the prior status and remove that Undo affordance. Announce the result in the existing polite status region.
- Keep one undoable activation change per product. A later successful toggle on that same product replaces its prior Undo with the new operation. Changes to other products do not clear it. On request failure, preserve the last confirmed status and show the existing product error feedback; do not offer an Undo for a change that did not succeed.
- Treat Undo as available for the current rendered page session. A page reload or navigation away ends the in-memory undo opportunity; do not imply server-side or cross-session undo.

### Update check and update available notice

- Remove the always-visible version/check footer from the seller work area. Do not show the current app version during normal product/order work.
- Add **“Check for updates”** to the existing Account menu, alongside the profile and sign-out actions. It is available on desktop and mobile and invokes the current service-worker manual check. While checking, disable that menu action and show **“Checking for updates…”** as a polite status. On completion show a concise status such as **“You’re up to date”** or **“Couldn’t check for updates. Try again.”** Keep the menu open so the result is discoverable.
- If a waiting service-worker version is detected, show a compact notice directly below the page heading and above the page toolbar/content. Copy: **“Update ready”**, supporting text **“A new version is available.”**, primary button **“Install update”**, and secondary text button **“Later”**. Show it on the currently open seller view, including Sales Orders as pictured. It must not be fixed to the viewport or cover content.
- Install update uses the existing update apply flow and its unsaved-work guard. While applying, disable both actions and replace supporting text with **“Updating…”**. Later hides the notice for the current page session; the update remains available from Account → Check for updates. A subsequent view/session may show it again if it is still waiting.
- With no available update, render no notice. Checking, up-to-date, and failure feedback belongs in the Account menu status rather than a persistent footer.

## Responsive rules

- At 320 CSS px, page content has 16 px side gutters. Search uses a full-width row with a flexible input plus a 72–80 px Search button; the input must retain visible placeholder text. Add product fills the next row. No horizontal page overflow.
- At 390 px, retain the same stacked search and Add product arrangement shown in the proposal. Product cards use a compact image column and a shrinkable text column; metadata wraps naturally. Card actions may wrap and remain at least 44 px high.
- At desktop (1280 px), retain the existing sidebar and two-column product list. Search input, Search, and Add product fit in one row; the input absorbs remaining width. Product-card action controls align to the card footer without shrinking the product title into an unreadable column.
- The update notice is a normal-flow, full-width compact banner at all widths. Its copy may wrap; buttons may stack under the copy on narrow screens. It must not obscure the heading or search/order filters.
- Avoid fixed bottom notices and page-level sticky action bars. Product Undo is attached to its own card so long-list scrolling cannot detach the action from the product it affects.

## Accessibility and interaction details

- Use a real `<form>` and submit button for product search so Enter submits and browser/assistive technology semantics remain intact.
- Keep a programmatic label even though the visible placeholder explains the search field. Ensure focus styles remain visible for the input and every button.
- Use native buttons for Activate, Deactivate, Undo, Check for updates, Later, and Install update. Do not communicate status through color alone; pair active/inactive color with text.
- Give each Undo button an accessible name that includes the product name and reversed operation. Keep the operation message associated with that product card; ensure repeated Undo controls remain distinguishable in screen-reader button lists.
- Announce successful status changes and update-check results through a polite live region. Use an assertive error announcement only for failed product/update operations if existing error handling requires it.
- Preserve logical keyboard order: page heading → update notice actions if present → search input → Search → Add product → product cards in visual order. In the Account menu, place Check for updates before Profile and Sign out; Escape closes the menu and returns focus to its trigger according to existing menu behavior.
- Maintain visible focus indicators, at least 44 px target height for touch controls, sufficient text/background contrast, and no focus movement when a status change completes.
- If the update notice is dismissed with Later, move no focus unexpectedly; if the focused Later button disappears, restore focus to the page heading or the first page control in a predictable way.

## Proposal frames

`seller-layout-proposal.svg` contains three visibly distinct frames: mobile Products (390 × 720), mobile Sales Orders with an available update (390 × 720), and desktop Products (1280 × 800, displayed scaled). They are vector illustrations of the proposed layout and are not screenshots of the application.
