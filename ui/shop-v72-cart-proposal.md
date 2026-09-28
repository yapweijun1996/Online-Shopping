# Customer cart proposal

## Design decision

Move the missing-profile guidance to the fixed checkout action. The supplied baseline and the source at the start of this task showed a detached warning and a checkout click that left the shopper on Cart. The current worktree now contains cart-flow edits that add a dynamic **Set up profile to continue** action, a `#cart-profile-state`, profile return to `#cart`, and focus restoration after save. These anchors align with that in-progress behavior and add the exact profile requirement beside the action: the local profile needs a full name and a valid WhatsApp phone number or email address.

With a valid profile, the action becomes **Continue to checkout (1)** and the action bar shows **Profile ready · Edit profile**.

The cart rows, teal selection controls, price note, Demo disclosure, and fixed totals remain familiar. The sample line is synthetic; its package drawing is marked **Illustration** in every anchor.

## Anchor critique

- **390 × 844 mobile:** The supplied baseline has a full-width profile warning above the item and a short checkout bar that gives no reason why checkout cannot proceed. The anchor removes that detached warning and puts the required profile fields in the fixed bar directly above a full-width profile action. The selected item remains a readable card with product link, unit price, stepper, subtotal, and remove. The five existing bottom items remain visible, with Cart active. The in-progress CSS currently hides `.cart-profile-state` on mobile when its Edit link is hidden; keep the required-fields line visible in this missing-profile state. The fixed bar is taller, so implementation must include its measured height plus the 64 px navigation and safe-area inset in body clearance. Existing CSS uses the mobile layout at `max-width:760px` and cart-card layout at `max-width:800px`.
- **820 × 900 tablet:** No captured baseline was supplied at 820 px. The anchor is inferred from the actual CSS: the desktop header remains above the 760 px mobile breakpoint, `max-width:1050px` compresses table columns, the in-progress `801–1050px` action-bar rule prevents wrapping, and mobile card rules start at 800 px. It keeps the compact table and fits the selection, estimate, prerequisite detail, and CTA on one fixed row. Verify real text wrapping and header fit when implementation is available; do not treat this inferred anchor as a measured screenshot.
- **1440 × 900 desktop:** The baseline has a detached profile panel between the heading and cart table. The anchor preserves the full desktop shop header, Demo banner, table headings, and wide cart row, while moving the required setup action beside the fixed total and selection controls. The action bar stays a single row at this width; the cart still has open space below its note and Continue shopping link, as in the baseline.

## Interaction and state contract

| State | Display and action |
| --- | --- |
| Cart loading / refreshing | Keep cart skeleton visible, set `aria-busy="true"`, announce “Loading…” in the existing `#cart-status` status region, and disable selection, quantity, and checkout actions until product resolution finishes. |
| Cart read error | Show the existing network error in the status region, keep totals unavailable (`—`), and expose **Try again**. Checkout stays disabled. |
| Empty cart | Show a clear empty-cart message and **Continue shopping** link. Disable Select all and checkout; show no selected items and `MYR 0.00` only when the shop currency is known. |
| Item unselected | Keep its unit price and line subtotal visible; exclude its subtotal from the estimated total. The select-all control becomes unchecked or indeterminate as appropriate. |
| No selected items | Show “Selected items: 0” and a zero estimate in the shop currency. Disable checkout and explain that at least one available item must be selected. |
| Selected, available lines; profile missing | Show only selected available subtotals in the estimate. Keep **Set up profile to continue** enabled; activate it only after the cart refresh and currency checks pass. Route to `#profile`, persist return route `cart`, and return to the cart after a valid profile save. |
| Valid local profile | Show **Profile ready · Edit profile** in the action area. The enabled action reads **Continue to checkout (n)**, where `n` is selected quantity. Reuse `#profile` for edit navigation. |
| Selected unavailable line or mixed currency | Show a specific status; show `—` if the selected total cannot be trusted; disable checkout. An unselected unavailable line does not enter the estimate, but remains visibly unavailable. |
| Profile save | Change the submit label to **Saving profile…** and disable it until local storage succeeds. On validation or storage failure, keep the shopper on Profile, announce the error, and focus the invalid/first required field. On success, return to Cart and focus the checkout action; announce that the profile is saved. |
| Checkout busy / server error | While `beginCheckout()` refreshes current products, show **Checking selected items…**, set `aria-busy="true"`, and disable duplicate activation. Retain its final product, currency, selection, and profile checks. On `#checkout`, reuse the existing submit busy state and error region; keep retry possible after recoverable errors. Demo submission continues to use the existing simulation flow and disclosure. |

Quantity stays within the existing 1–100 range; disable minus at 1 and plus at 100. Recalculate the selected estimate and line subtotal after a committed quantity change.

The displayed estimate is `sum(priceMinor × quantity)` for selected, resolved items only and only when all selected items share one currency. `refreshCart()` already fetches each current product before checkout; the order endpoint remains authoritative and must keep its existing final price and availability validation.

## Accessibility and focus

- Keep real checkboxes and buttons/links with visible labels. Give each row checkbox and quantity stepper an accessible name that includes the product name, following the existing names in `renderCart()`.
- Preserve a visible `:focus-visible` outline using `--ui-focus`. Make minus, quantity, plus, Remove, profile, and checkout targets at least 44 px high where space allows; label checkboxes through their text.
- Use the existing cart status `role="status"` for loading, selection counts, and nonurgent state changes; use an alert for blocking failures. Do not announce the full cart on every quantity update.
- Make the profile action a real navigation control to `#profile`, not a button that silently stays at `#cart`. After profile save, restore focus to the updated checkout action. On save error, focus the invalid field and retain the error message.
- When a selected row is removed or changes quantity, preserve focus on the corresponding surviving control, matching the current `data-focus-key` restoration behavior.

## Responsive layout and implementation handoff

- **1440 px:** 58 px page gutters; 54 px table header; a 140 px product row; fixed footer about 82 px high. Place selection on the left and count, estimate, the full-name/contact requirement, and CTA on the right.
- **820 px:** 32 px gutters; preserve the desktop header/table because the 800 px cart-card breakpoint has not been crossed. Use the 1050 px compressed columns and keep selection, estimate, profile requirement, and CTA on one fixed row.
- **390 px:** 16 px page gutters; stack the Demo copy within its current banner; use a single readable cart card. Place selection and total on the first fixed-bar row, a concise profile field requirement on the next line, and a full-width next-step action below. Keep the 64 px five-item mobile navigation immediately underneath.
- Measure the fixed action bar and expose the height through the existing `--shop-action-height` sizing path; body bottom padding must cover that bar, mobile navigation, 24 px breathing room, and `env(safe-area-inset-bottom)` on mobile. Keep the cart controls reachable while the keyboard is open.

Reuse `#cart-view`, `#cart-list`, `#cart-status`, `#cart-select-all`, `#cart-summary`, `#cart-total`, `#checkout-button`, the current `#cart-profile-state`, `mountProfile()` and `#profile`, `createCartSelection()`, `refreshCart()`, and `beginCheckout()` in `public/shop/app.js`. No new API is needed. Keep the current worktree's profile return, duplicate-start guard, and focus-after-save edits. Extend the missing-profile message so the action bar says **Full name + WhatsApp or email** at desktop, tablet, and mobile widths; the mobile CSS currently hides that state with `:has(a[hidden])`. Continue refreshing products before routing to checkout.

## Review provenance

The supplied baseline captures cover 1440 × 900 and 390 × 844; no 820 px baseline capture was provided. The 820 assessment above is based on the repository breakpoints. The requested Codex CLI `gpt-6-luna` review was attempted, but this environment could not reach the model catalog/backend over the restricted network. These anchors were completed from the supplied screenshots and source inspection; they are not represented as Luna-generated or Luna-reviewed output. The SVGs pass XML parsing, but the local browser blocked `file://` previews and no available renderer produced PNGs, so browser-native visual QA remains pending.
