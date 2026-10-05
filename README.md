# Online Shopping MVP

**Status: public Demo available; Production is not released.** Seller sign-in/session, MYR/SGD product management, public catalog/cart, guest checkout with one delivery address per order, seller order review, and responsive PWA shells run locally. A two-container Docker Compose stack passed local smoke checks. AC-01–15 and AC-18 are locally verified; PWA installation and production operations remain unfinished, and the Production release remains pending. The local `sample/` prototype is a separate business-rule reference; its code, UI, database, and demo credentials are not the new application.

## Run the current slice

Local courier/messaging preparation is documented in [INTEGRATION_FOUNDATION.md](docs/INTEGRATION_FOUNDATION.md). Company Settings shows all providers as NOT_CONFIGURED. The company-isolated ledger is opt-in and synthetic only; ordinary startup does not migrate or connect a provider.

The next local slice, [INTEGRATION_ADAPTERS.md](docs/INTEGRATION_ADAPTERS.md), adds verified request builders and response/status normalization through a data-only synthetic transport. It cannot submit to a real provider.

[INTEGRATION_TRUST_INGRESS.md](docs/INTEGRATION_TRUST_INGRESS.md) records the subsequent local server-consent and signed-inbox slice. Caller consent flags and unevidenced FOUND/ABSENT reconciliation are disabled; ingress remains offline and unattached.

Use Node 24.15 or later in the 24.x line. Copy `.env.example` to ignored `.env`, set a unique `ADMIN_USERNAME` and a non-default `ADMIN_PASSWORD` of at least 16 characters with letters and numbers, and keep `DB_PATH` outside `public/`. Production startup also rejects known placeholder words. Do not reuse example or sample credentials. Then run `npm start` with Node 24. On this machine, where the default Node is older, use `npx --yes node@24 --env-file=.env src/server.js`.

Open `/seller/` for seller login, product management, all-status order search/detail, and a pending-order confirmation queue. The seller can confirm or reject with an audit record, copy individual authorized contact/address fields, and open a manual WhatsApp chat only when the buyer opted in. Open `/shop/` for active-product discovery, a same-browser cart, and guest checkout. Customers save a browser-local Profile (name plus WhatsApp or email) and address book, select cart items, then review one address and the order total. WhatsApp contact requires explicit order-only consent when supplied in Production. The server then shows an order number after commit. Addresses are saved explicitly in this browser; legacy suggestions can still be cleared from Settings. Seller product images may be uploaded as PNG, JPEG, or WebP up to 512 KB; the browser sends base64 to the API, which stores decoded bytes in the private database. The public product API shows only active products in their stored currency and serves their images at active-only URLs. `/health` is liveness; `/ready` checks the local database schema. The default private database path is `.local/online-shopping.db`. Run `npm ci && npm run check && npm test` with Node 24. The test script deliberately excludes the separate `sample/` suite. The application is for local development only until the production decisions and release gates in [PROGRESS.md](docs/PROGRESS.md) are resolved.

The shop catalog now has a responsive header search, a discovery banner using an active product image, API-backed category navigation, and compact product cards. The reference layout's mock ratings, discounts, wishlists, account controls, and delivery promises are not implemented. See the [web UI specification](docs/UI_SPEC.md).

The seller portal manages stable category codes and the default currency for new products, groups product search and editing controls, shows compact product cards, and presents the order queue and detail in separate panels on wide screens. Its signed-in desktop side bar fills the viewport height, wraps long navigation names, and owns the left edge; the top bar and content begin beside it. On phones, the side bar becomes a full-height drawer and the top bar spans the screen. Narrow screens show one order surface at a time. The signed-out page has a responsive photo introduction, factual capability notes, a focused login card, and a keyboard-accessible password visibility button. The photo is decorative; login still uses the server session API. These layout changes do not change seller permissions or server-owned order decisions.

## Goal

Make it easy for a seller to set up products, for a customer to shop without registering, and for the seller to review each submitted order on a phone or desktop. Keep the customer and seller web interfaces separate from the server API and private database so UI changes do not silently change order behavior.

## MVP journey

1. A super admin signs in to the seller panel and creates or edits products. Only active products appear at the public shop link.
2. A customer browses products, adds items to a cart, and enters a buyer name and WhatsApp number. Email is optional and unverified. Buyer and recipient phone inputs support Malaysia (+60) and Singapore (+65).
3. The customer selects one saved recipient/address, reviews selected products and the total, and submits without an account or OTP. Separate destinations require separate orders.
4. The server saves the order and returns a unique order number. The page shows a receipt. IndexedDB keeps the cart and a 90-day, browser-local My orders list with product snapshots and a random status credential for each new order; it does not store buyer contact or delivery details in that list. localStorage keeps only the latest minimal receipt for compatibility. My orders refreshes seller decisions through a status-only API when opened or manually refreshed. Earlier orders without a status credential retain their local receipt but cannot securely retrieve later decisions. The server remains authoritative.
5. An authenticated seller reviews the order on a responsive dashboard, then confirms or rejects it. The seller can copy recipient details into a separate shipping system or open the opted-in buyer's WhatsApp chat and send an order-related message manually. Earlier orders without opt-in retain no WhatsApp action.

## Implementation order

Seller login, product management, public catalog/cart, guest checkout, and seller order queue/detail/decision views now run locally against the documented API. A decision uses the current server revision; another tab's decision triggers a 409 and reloads the latest state. The initial super admin username and password come from ignored server configuration: `.env` for direct Node development or an ignored Docker environment file plus Compose secret. There is no built-in credential in source or committed configuration. Production startup rejects known development defaults and missing or weak credentials.

There is no customer-facing cross-device history lookup in the MVP. A phone number or email supplied without verification is contact data, not proof of ownership.

The address book supports adding, editing, deleting and choosing a default address. Existing contact-history data is preserved but is not combined into addresses; Settings retains its clear action. Profile and address storage are browser-local and do not authenticate the customer. MYR is the initial company default. Sellers may price each product in MYR or SGD; the company setting controls the default for new products. Existing prices and orders retain their currency. Mixed-currency carts must be split before checkout; there is no automatic conversion, shipping-charge calculation or delivery-area enforcement. Destination addresses are collected for seller review.

The owner requests permanent server retention of submitted orders, including contact and address snapshots. There is currently no automatic order purge or deletion API. The lawful basis and durable recovery requirements for that request remain an AC-16 release blocker; do not use the local instance for real customer data. Browser suggestion history follows its separate clearable 90-day rule.

Both web surfaces have separate local PWA manifests/scopes, versioned public-shell caches, and offline pages. Local checkout and seller decisions require a server response; offline seller actions are disabled and the offline shell contains no private order data. Installation across target browsers remains unverified. The UI defaults to English and offers, in order, English, Malay, Mandarin, Vietnamese, Thai, Japanese, and Korean; local phone/desktop browser checks cover core flows, errors, focus and layout in all seven. See the [seller desktop/mobile previews](docs/UI_SPEC.md) and [PWA/i18n requirements](docs/PWA_I18N.md).

The [verification workflow](.github/workflows/verify.yml) runs the new application's Node 24 syntax checks, tests, and dependency audit on future GitHub pushes and pull requests. It has not run remotely for this local work.

## Run with Docker Compose

The [Compose stack](compose.yaml) runs **two containers**: Caddy serves both PWA shells and proxies `/api/*`, `/health`, and `/ready`; one Node backend owns the API and private SQLite database. SQLite is a file in the `db_data` named volume, not a third container. The backend has no published host port. The default frontend binding is `127.0.0.1:8080` for local testing.

Create an ignored `.local/admin-password` file containing a unique 16–256 character secret with letters and numbers; restrict it to the deployment operator. For a local synthetic-data setup, run `mkdir -p .local` and `(umask 077; openssl rand -base64 32 > .local/admin-password)`. Copy [the Compose environment example](deploy/docker.env.example) with `cp deploy/docker.env.example .local/docker.env`, set `ADMIN_USERNAME`, and review the bind and origin values. Then run `docker compose --env-file .local/docker.env up --build -d`, check `docker compose --env-file .local/docker.env ps`, and visit `http://127.0.0.1:8080/shop/` and `/seller/`. Keep the secret file, `.local/docker.env`, and database volume out of source control and public static paths. Restart with `docker compose --env-file .local/docker.env restart`; do not remove `db_data` with `down -v` without an approved data recovery or disposal procedure.

For a future HTTPS host, set `SITE_ADDRESS` to the hostname, `PUBLIC_ORIGIN` to its exact `https://` origin, `NODE_ENV=production`, and bind the frontend to public ports 80 and 443 after DNS, TLS reachability, data retention, backups, and rollback are settled. Caddy obtains certificates for a reachable domain. Do not expose the backend port; its trusted proxy setting assumes only the Caddy container can reach it. Production startup fails if the secret is missing or weak. Local Docker smoke checks do not establish a released service. See [deployment operations](docs/DEPLOY.md) for data and release gates.

For a local restricted backup, run `./deploy/backup.sh`. It pauses both containers, archives the full SQLite volume under ignored `.local/backups/` with mode `0600`, verifies the archive, writes a SHA-256 checksum, and restarts the stack. The script accepts an environment file and Compose project name as optional arguments. This local snapshot is unencrypted; settle encrypted storage, off-host copies, schedule, and retention before using real customer data. An isolated synthetic-data restore rehearsal passed; see [DEPLOY.md](docs/DEPLOY.md).

## Demo on Cloudflare Workers

The Cloudflare Worker is the public **fictional general-store Demo**, backed by an isolated SQLite Durable Object. `SHOP_MODE=public-demo` and `SHOP_DEMO_REVISION=v1` select `public-general-demo-v1`. Existing `shop` and `pet-shop-demo-v1` data remain untouched. Production security still applies: owner credentials and HTTPS origin stay in ignored configuration or Worker secrets.

Demo setup seeds 35 fictional products across Home, Stationery, Kitchen, Travel, Tech Accessories, Apparel and Pet Care. Product pictures are original AI-generated illustrations; descriptions and MYR prices are fictional samples. There are no real offers, delivery, payments or outbound messages. No customers/orders are seeded. Submitted simulation data is replaced with fictional contacts and destinations before storage; browser-local data is partitioned by Demo revision. Seller authentication and order status access keys remain enforced.

Use a new empty local database for local Demo testing. `scripts/seed-demo-products.js` is limited to authenticated loopback HTTP. Setup is atomic and idempotent, and refuses existing unconfigured data. To start a fresh public Demo, change only `SHOP_DEMO_REVISION` to a new bounded lowercase label and deploy after tests. This selects a new object and browser storage keys without deleting old data; reverting the label restores the previous object. See [Demo provenance and controls](docs/PUBLIC_DEMO.md) and [image source manifest](src/public-demo-image-manifest.json).

Legacy third-party product seed images and historical unverified screenshots have been removed from the current source tree. Git history still contains earlier artifacts; this release does not rewrite history or make an exclusivity/copyright guarantee for generated images.

The future Production target is Docker + PostgreSQL on the owner's server, exposed through Cloudflare Tunnel with a domain and company settings. **PostgreSQL is not implemented yet**: the current Node/Docker adapter still uses SQLite. Keep this as a separate migration after the Demo customer journey is reviewed. The mobile product detail page uses a square image hero with overlay navigation, a white bar after the image scrolls away, and a fixed Chat / Add to cart / Buy now dock. Chat opens the seller's configured WhatsApp number. Unsupported promotion and rating data no longer take space in the purchase path; Demo order limitations, Production fulfillment terms, and the unavailable reviews state are available in expandable disclosures. No voucher, rating, return policy or delivery promise is invented. Cart/checkout refinement and company configuration remain separate work.

## MVP boundaries

- No online payment or payment verification workflow.
- No GST calculation in the MVP.
- No customer account, password, OTP, or cross-device order recovery.
- No automatic WhatsApp messages or unofficial WhatsApp Web automation.
- No courier, AWB, tracking, CSV/Excel batch export, or logistics-platform integration. Seller order details support manual copy and paste for now.
- No real customer data, credentials, or database files in the public repository.

## Documentation

- [Goal](docs/GOAL.md), [MVP specification](docs/SPEC.md), and [epics](docs/EPIC.md)
- [Proposed design](docs/DESIGN.md) and [goal prompt](docs/GOAL_PROMPT.md)
- [Web UI specification and seller previews](docs/UI_SPEC.md) and [PWA/i18n requirements](docs/PWA_I18N.md)
- [Draft API contract](docs/API.md)
- [Roadmap](docs/ROADMAP.md), [task ledger](docs/TASK.md), and [evidence-based progress](docs/PROGRESS.md)

Do not use commands or credentials from `sample/` for the new application.

## Current customer experience

Products open at shareable `/shop/#product/<id>` URLs, with an enlarged image viewer, quantity stepper, live subtotal, Add to cart, Buy now and same-category links. On phones, the image fills the content width, the price follows it, and purchase buttons remain visible above the navigation bar. Product links survive refresh and browser history navigation. The public Demo suppresses outbound contact; a manually configured Production shop can expose its owner-approved Seller contact link. Chat sends no message or buyer details automatically. Cart and checkout show per-line totals; Checkout displays saved Profile details read-only and selects one saved delivery address. App version and manual update checks are in Account → Settings; a ready update appears near the catalog's Demo notice and below the product image. Clean pages update on one click, while unsaved edits require confirmation. Clients older than Shop v37 / Seller v41 must close all old app tabs once to adopt this updater.


## Profile and selected-item checkout

The top-bar account button opens Profile, My addresses and Settings. Profile starts empty, saves locally in this browser, and requires a full name plus a WhatsApp number or email. It is not an authenticated or verified customer account. A yellow cart warning links to setup until a profile is saved. Checkout shows these details read-only and links back to Profile for changes.

Cart checkboxes select the items and total for the next order. Buy now opens checkout for the quantity chosen on the product page without changing existing cart quantities or selections. Each checkout has one delivery address; another address requires another order. A cart-backed order deducts only its submitted quantities, preserving unselected cart items; a Buy now order leaves the cart unchanged. Demo asks users to enter their own sample profile/address without prefilling identity and replaces contacts with anonymous placeholders before sending. Production validates contacts server-side; email-only buyers have no WhatsApp permission. The existing multi-delivery API and historical seller order views remain compatible, but the customer UI no longer offers split destinations.

## Address book and checkout (Shop v39)

`#addresses` owns explicit address saves in `online-shopping-addresses-v1` local storage. Entries have stable IDs; the first becomes default. Deleting the default requires confirmation and promotes the earliest remaining entry. The checkout selection is stored by ID per tab and is read again immediately before submission; deleting it requires reselection. No legacy history migration or new database tables are involved.

Cart quantities range from 1–100. The fixed action bar summarizes selected quantities and totals, and reserves its measured height in the page. Only selected available items in a single currency can proceed. Profile setup returns to the originating cart or checkout. Checkout contains read-only buyer details, one address, selected products and the total; no shipping/payment/promotion controls are included. Address selection uses a desktop dialog/mobile sheet and cancellation preserves the current address.

Demo payload construction anonymizes contacts before any network transmission. Server pricing, idempotency, multi-delivery API compatibility and historical orders remain unchanged. Failed saves retain form input. New modules are included in the PWA allowlist; Shop v39 and Seller v43 wait for user-approved updates.

## Seller order documents

Seller order details offer **Order summary** and, for confirmed orders, **Packing sheet**. Preview uses a fresh authenticated order snapshot; **Print / Save as PDF** opens the browser print workflow. Each destination is isolated with repeated identifying table headers and accurate snapshot quantities/amounts. Demo documents are explicitly simulated. These are manual records/checklists, not tax invoices, payment receipts or courier labels, and do not record packing or shipment state. See [acceptance and QA gates](docs/SELLER_ACCEPTANCE.md).

The current owner-request repair candidate is Shop v105 / Seller v81 with version-labelled safe updates, complete Seller demo galleries, company-inherited readonly product currency, five previewable browser palettes and a separate fictional Admin/Seller sandbox. PR #15 is merged; the repair candidate is not deployed and includes no live tenant migration/grant. See [the reviewable multi-company design](docs/ADMIN_MULTI_COMPANY_DESIGN.md) and [18-item Production acceptance reconciliation](docs/PRODUCTION_ACCEPTANCE.md).
