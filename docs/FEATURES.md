# Current features and behavior

Detailed description of what the shop and seller portal do today. The [README](../README.md) has the short overview; [PROGRESS.md](PROGRESS.md) holds the evidence-based status.

## How it works today

Seller login, product management, public catalog/cart, guest checkout, and seller order queue/detail/decision views now run locally against the documented API. A decision uses the current server revision; another tab's decision triggers a 409 and reloads the latest state. The initial super admin username and password come from ignored server configuration: `.env` for direct Node development or an ignored Docker environment file plus Compose secret. There is no built-in credential in source or committed configuration. Production startup rejects known development defaults and missing or weak credentials.

There is no customer-facing cross-device history lookup in the MVP. A phone number or email supplied without verification is contact data, not proof of ownership.

The address book supports adding, editing, deleting and choosing a default address. Existing contact-history data is preserved but is not combined into addresses; Settings retains its clear action. Profile and address storage are browser-local and do not authenticate the customer. MYR is the initial company default. Sellers may price each product in MYR or SGD; the company setting controls the default for new products. Existing prices and orders retain their currency. Mixed-currency carts must be split before checkout; there is no automatic conversion, shipping-charge calculation or delivery-area enforcement. Destination addresses are collected for seller review.

The owner requests permanent server retention of submitted orders, including contact and address snapshots. There is currently no automatic order purge or deletion API. The lawful basis and durable recovery requirements for that request remain an AC-16 release blocker; do not use the local instance for real customer data. Browser suggestion history follows its separate clearable 90-day rule.

Both web surfaces have separate local PWA manifests/scopes, versioned public-shell caches, and offline pages. Local checkout and seller decisions require a server response; offline seller actions are disabled and the offline shell contains no private order data. Installation across target browsers remains unverified. The UI defaults to English and offers, in order, English, Malay, Mandarin, Vietnamese, Thai, Japanese, and Korean; local phone/desktop browser checks cover core flows, errors, focus and layout in all seven. See the [seller desktop/mobile previews](UI_SPEC.md) and [PWA/i18n requirements](PWA_I18N.md).

The [verification workflow](../.github/workflows/verify.yml) runs the new application's Node 24 syntax checks, tests, and dependency audit on future GitHub pushes and pull requests. It has not run remotely for this local work.

## Customer experience

Products open at shareable `/shop/#product/<id>` URLs, with an enlarged image viewer, quantity stepper, live subtotal, Add to cart, Buy now and same-category links. On phones, the image fills the content width, the price follows it, and purchase buttons remain visible above the navigation bar. Product links survive refresh and browser history navigation. The public Demo suppresses outbound contact; a manually configured Production shop can expose its owner-approved Seller contact link. Chat sends no message or buyer details automatically. Cart and checkout show per-line totals; Checkout displays saved Profile details read-only and selects one saved delivery address. App version and manual update checks are in Account → Settings; a ready update appears near the catalog's Demo notice and below the product image. Clean pages update on one click, while unsaved edits require confirmation. Clients older than Shop v37 / Seller v41 must close all old app tabs once to adopt this updater.


### Profile and selected-item checkout

The top-bar account button opens Profile, My addresses and Settings. Profile starts empty, saves locally in this browser, and requires a full name plus a WhatsApp number or email. It is not an authenticated or verified customer account. A yellow cart warning links to setup until a profile is saved. Checkout shows these details read-only and links back to Profile for changes.

Cart checkboxes select the items and total for the next order. Buy now opens checkout for the quantity chosen on the product page without changing existing cart quantities or selections. Each checkout has one delivery address; another address requires another order. A cart-backed order deducts only its submitted quantities, preserving unselected cart items; a Buy now order leaves the cart unchanged. Demo asks users to enter their own sample profile/address without prefilling identity and replaces contacts with anonymous placeholders before sending. Production validates contacts server-side; email-only buyers have no WhatsApp permission. The existing multi-delivery API and historical seller order views remain compatible, but the customer UI no longer offers split destinations.

### Address book and checkout (Shop v39)

`#addresses` owns explicit address saves in `online-shopping-addresses-v1` local storage. Entries have stable IDs; the first becomes default. Deleting the default requires confirmation and promotes the earliest remaining entry. The checkout selection is stored by ID per tab and is read again immediately before submission; deleting it requires reselection. No legacy history migration or new database tables are involved.

Cart quantities range from 1–100. The fixed action bar summarizes selected quantities and totals, and reserves its measured height in the page. Only selected available items in a single currency can proceed. Profile setup returns to the originating cart or checkout. Checkout contains read-only buyer details, one address, selected products and the total; no shipping/payment/promotion controls are included. Address selection uses a desktop dialog/mobile sheet and cancellation preserves the current address.

Demo payload construction anonymizes contacts before any network transmission. Server pricing, idempotency, multi-delivery API compatibility and historical orders remain unchanged. Failed saves retain form input. New modules are included in the PWA allowlist; Shop v39 and Seller v43 wait for user-approved updates.

### Seller order documents

Seller order details offer **Order summary** and, for confirmed orders, **Packing sheet**. Preview uses a fresh authenticated order snapshot; **Print / Save as PDF** opens the browser print workflow. Each destination is isolated with repeated identifying table headers and accurate snapshot quantities/amounts. Demo documents are explicitly simulated. These are manual records/checklists, not tax invoices, payment receipts or courier labels, and do not record packing or shipment state. See [acceptance and QA gates](SELLER_ACCEPTANCE.md).

The current owner-request repair candidate is Shop v106 / Seller v83 with version-labelled safe updates, complete Seller demo galleries, company-inherited readonly product currency, five previewable browser palettes and a separate fictional Admin/Seller sandbox. PR #15 is merged; the repair candidate is not deployed and includes no live tenant migration/grant. See [the reviewable multi-company design](ADMIN_MULTI_COMPANY_DESIGN.md) and [18-item Production acceptance reconciliation](PRODUCTION_ACCEPTANCE.md).
