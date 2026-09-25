# Online Shopping MVP

**Status: MVP implementation in progress.** Seller sign-in/session, responsive PWA shells, and a browser cart storage module run locally. Product management, catalog/cart UI, checkout, order review, complete i18n flows, and release operations remain unfinished. The local `sample/` prototype is a separate business-rule reference; its code, UI, database, and demo credentials are not the new application.

## Run the current slice

Use Node 24.15 or later in the 24.x line. Copy `.env.example` to ignored `.env`, set a unique `ADMIN_USERNAME` and a non-default `ADMIN_PASSWORD` of at least 16 characters with letters and numbers, and keep `DB_PATH` outside `public/`. Do not reuse example or sample credentials. Then run `npm start` with Node 24. On this machine, where the default Node is older, use `npx --yes node@24 --env-file=.env src/server.js`.

Open `/seller/` for the seller login or `/shop/` for the current storefront placeholder. `/health` is liveness; `/ready` checks the local database schema. The default private database path is `.local/online-shopping.db`. Run `npm ci && npm test` with Node 24, or `npx --yes node@24 --test test/cart.test.js test/checkout-input.test.js test/i18n.test.js test/phone.test.js test/product-input.test.js test/pwa.test.js test/server.test.js` on this machine after `npm ci`. The test script deliberately excludes the separate `sample/` suite. The application is for local development only until the production decisions and release gates in [PROGRESS.md](docs/PROGRESS.md) are resolved.

## Goal

Make it easy for a seller to set up products, for a customer to shop without registering, and for the seller to review each submitted order on a phone or desktop. Keep the customer and seller web interfaces separate from the server API and private database so UI changes do not silently change order behavior.

## MVP journey

1. A super admin signs in to the seller panel and creates or edits products. Only active products appear at the public shop link.
2. A customer browses products, adds items to a cart, and enters a buyer name and WhatsApp number. Email is optional and unverified. Buyer and recipient phone inputs support Malaysia (+60) and Singapore (+65).
3. The customer enters a separate recipient name, phone, address, and postcode for each delivery destination, reviews the order, and submits it without an account or OTP.
4. The server saves the order and returns a unique order number. The page shows a receipt. IndexedDB keeps the cart and a minimal same-browser receipt; the server remains authoritative.
5. An authenticated seller reviews the order on a responsive dashboard, then confirms or rejects it. The seller can copy recipient details into a separate shipping system or open the opted-in buyer's WhatsApp chat and send a message manually.

## Implementation order

Start with the seller login and product management panel. Then build the public catalog, cart, checkout, and order review against the backend API. The initial super admin username and password will come from a local, ignored `.env` file. There is no built-in credential in source or committed configuration. Production startup must reject known development defaults and missing or weak credentials.

There is no customer-facing cross-device history lookup in the MVP. A phone number or email supplied without verification is contact data, not proof of ownership.

Both web surfaces now have separate local PWA manifests/scopes, versioned public-shell caches, and offline pages. Installation across target browsers and online-only checkout/review behavior remain unverified until those journeys exist. The UI defaults to English and offers, in order, English, Malay, Mandarin, Vietnamese, Thai, Japanese, and Korean. See the [seller desktop/mobile previews](docs/UI_SPEC.md) and [PWA/i18n requirements](docs/PWA_I18N.md).

The [verification workflow](.github/workflows/verify.yml) runs the new application's Node 24 syntax checks, tests, and dependency audit on future GitHub pushes and pull requests. It has not run remotely for this local work.

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
- [Seller UI specification and previews](docs/UI_SPEC.md) and [PWA/i18n requirements](docs/PWA_I18N.md)
- [Draft API contract](docs/API.md)
- [Roadmap](docs/ROADMAP.md), [task ledger](docs/TASK.md), and [evidence-based progress](docs/PROGRESS.md)

Do not use commands or credentials from `sample/` for the new application.
