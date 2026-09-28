# Customer product detail proposal

## Design decision

Keep the existing two-column desktop and tablet detail card, price-first heading, product-information order, and mobile single-column gallery. Refine three things the screenshots and source support: make the zoom action visible, reduce the phone gallery's first-screen height without cropping the image, and give the 820px summary/actions enough width to avoid wrapped purchase buttons. The mobile purchase bar stays fixed directly above the existing five-item navigation.

The package art and all example catalog data in these SVGs are synthetic. The artwork says **Illustration** in each viewport. The MYR amounts and two pack options are mock content for explaining selection only; they do not describe seeded Demo products or seller availability.

## Screenshot audit and anchors

- **1440 × 900:** The current first screen has a clear image/summary split, strong price, long name, quantity and purchase actions. It spends much of the right column on open space because the sample has no SKU options. The anchor keeps the card and adds seller-option examples, a clear selected state, an explicit `1 / 3` gallery state and a 44px zoom affordance. Product information remains below the purchase decision.
- **820 × 900:** The desktop header and two-column product card remain active because the current mobile breakpoint is 760px. The supplied capture shows a narrow summary: long title and Add to cart wrap, and the action row feels compressed. The anchor gives the image 42% and summary 58% of the card, tightens their gap, keeps option tiles side by side, and sizes Chat/Add/Buy to fit in one row. This is a source-informed proposal, not a new browser capture.
- **390 × 844:** The supplied page gives the square hero nearly half the viewport before price, Demo note, quantity, and details appear; zoom is implicit in tapping the image. The anchor uses a 263px gallery stage with `object-fit: contain`, so the image remains whole while the option row and quantity move up. Back/share/cart stay over the image; a 44px zoom cue makes enlargement discoverable. The fixed Chat/Add/Buy row is immediately above Home/Category/Cart/Language/Account.

## Behavior and data contract

| Area | Required behavior |
| --- | --- |
| Product identity and price | Use the fetched product's name, category, SKU, currency and `priceMinor`. Show the existing Demo disclosure. Recalculate the displayed subtotal from the currently selected product and quantity; it is an estimate until the server accepts the purchase. Keep the server's current price and availability validation authoritative. |
| SKU choices | Render choices only when the API returns more than one product in the same variant group. On desktop/tablet show available options inline; on phones open the existing option sheet, focus the selected option, support Escape/close and restore focus to the trigger. Choosing an option navigates to that SKU's product detail so its own image, price and ID are used. The example options/prices in these anchors are synthetic and must not be copied into Demo seeds. |
| Gallery | Use only `product.images` / `imageUrl`. Keep 44px previous/next buttons, thumbnails, swipe on the image and viewer, image count, and left/right arrow keys in the enlarged dialog. Add a visible 44px zoom cue inside the existing full-image button; preserve its accessible zoom name and open the same dialog. Keep Escape, close, focus restoration, and vertical page scrolling. Hide arrows/count/thumbnails for a single-image product. |
| Quantity and actions | Keep integer quantity 1–100; disable minus at 1 and plus at 100. Update item subtotal immediately. Add to cart and Buy now use the current product ID and quantity, keep duplicate submissions disabled while busy, and report success/failure through the existing status region. Buy now continues through the current re-fetch and server price check. Chat remains conditional on a valid seller WhatsApp number. |
| Product information | Keep seller SKU, category, full description and same-category products below the purchase section. Do not add ratings, review counts, discount claims, stock amounts, delivery promises or payment claims. In Demo, all explanatory copy must continue to say that details and reference prices are not live offers. |
| Mobile fixed controls | At widths up to 760px, place the purchase bar above the five-item navigation while both are visible. Reserve document scroll clearance for the measured purchase bar, nav height and safe-area inset so the last description/related-product content can scroll above them. Keep the existing keyboard/dialog suppression and scroll-hide behavior; when nav chrome hides, align the bar to the viewport bottom and restore it above nav when chrome returns. |
| Localization | The anchors use English for review. Reuse existing translated strings where possible; add any new labels (including zoom and pack-size labels) to all seven locales. Check long translations for title wrapping, option price visibility, and button fit at 820px and 390px. |

## States, reading order and accessibility

Reading order remains: back/navigation → gallery → price/name/category/share → SKU option → quantity/subtotal → purchase actions → Demo details → SKU/category/description → related products. The share control reports copied/fallback state; it does not change the product URL contract.

- **Loading:** Retain the existing skeleton and loading status; do not show stale product details while a new SKU is loading.
- **Unavailable:** Keep the current unavailable heading and return-to-catalog action; no purchase controls.
- **Network error:** Keep Retry and focus the error heading on a route load/retry.
- **Quantity invalid/limit:** Show the localized inline error, focus quantity, and do not send a request.
- **Purchase busy/error/success:** Disable purchase actions during the request; use the existing status message and View cart recovery after a successful add. On failure, retain the selection and allow retry.
- **Keyboard/focus:** All visible buttons, option choices, thumbnails and disclosure summaries retain visible focus styling. Preserve native dialog focus trap, Escape close and return focus. Labels must name the image, selected SKU, quantity stepper controls and share action without relying on icon shape or color.
- Keep all action targets at least 44px; retain the existing 44px quantity, gallery, share and modal controls. Selected SKU state uses a border/check plus text, not color alone.

## Honest critique and implementation limits

The existing hierarchy is already strong on desktop and tablet; a full structural redesign would add risk without solving a demonstrated problem. The most useful improvements are the explicit zoom cue and clearer tablet action fit. The mobile gallery reduction improves the first screen, but a seller image with embedded text may be less legible at 263px; opening the viewer must remain an easy one-tap path and the full-resolution image must stay contained.

The actual Demo catalog currently has single-SKU products, so the option examples are design-only synthetic data. The supplied 820px image is the baseline used here; intermediate widths and seven localized strings still need browser review when implementation is requested. These files are proposal anchors, not implemented or usability-tested UI.

## Parent review and implemented refinement

The proposal's mobile bottom navigation conflicts with the live product route: that route intentionally hides the five-item nav and places its purchase dock at the viewport bottom. The illustration's multi-SKU options and gallery count are also synthetic. The implementation kept the actual navigation and API-driven option/gallery behavior. It added a visible zoom cue inside the existing full-image button and gave the 820px summary more space so Add to cart stays on one line. The 390px image remains square because the sample package includes small text that would become harder to read at the proposed 263px height. Local browser checks confirmed no overflow at 390/820px, zoom dialog open/Escape/focus return, and one-line tablet purchase actions.
