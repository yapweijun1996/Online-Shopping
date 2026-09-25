# Online Shopping MVP

**Status: MVP implementation in progress.** Seller sign-in/session, MYR product management, public catalog/cart, guest multi-destination checkout, seller order review, and responsive PWA shells run locally. A two-container Docker Compose stack passed local smoke checks. AC-01–15 and AC-18 are locally verified; PWA installation and production operations remain unfinished, and nothing is released. The local `sample/` prototype is a separate business-rule reference; its code, UI, database, and demo credentials are not the new application.

## Run the current slice

Use Node 24.15 or later in the 24.x line. Copy `.env.example` to ignored `.env`, set a unique `ADMIN_USERNAME` and a non-default `ADMIN_PASSWORD` of at least 16 characters with letters and numbers, and keep `DB_PATH` outside `public/`. Production startup also rejects known placeholder words. Do not reuse example or sample credentials. Then run `npm start` with Node 24. On this machine, where the default Node is older, use `npx --yes node@24 --env-file=.env src/server.js`.

Open `/seller/` for seller login, product management, all-status order search/detail, and a pending-order confirmation queue. The seller can confirm or reject with an audit record, copy individual authorized contact/address fields, and open a manual WhatsApp chat only when the buyer opted in. Open `/shop/` for active-product discovery, a same-browser cart, and guest checkout. Checkout accepts buyer and per-destination +60/+65 contacts, optional email, and WhatsApp order-contact consent, then shows a server-issued order number after commit. Saved phone/address suggestions require an explicit choice and can be typed, selected, or cleared. Seller product images may be uploaded as PNG, JPEG, or WebP up to 512 KB; the browser sends base64 to the API, which stores decoded bytes in the private database. The public product API shows only active MYR products and serves their images at active-only URLs. `/health` is liveness; `/ready` checks the local database schema. The default private database path is `.local/online-shopping.db`. Run `npm ci && npm run check && npm test` with Node 24. The test script deliberately excludes the separate `sample/` suite. The application is for local development only until the production decisions and release gates in [PROGRESS.md](docs/PROGRESS.md) are resolved.

The shop catalog now has a responsive header search, a discovery banner using an active product image, API-backed category navigation, and compact product cards. The reference layout's mock ratings, discounts, wishlists, account controls, and delivery promises are not implemented. See the [web UI specification](docs/UI_SPEC.md).

The seller portal groups product search and editing controls, shows compact product cards, and presents the order queue and detail in separate panels on wide screens. Narrow screens show one order surface at a time. The signed-out page now uses the full viewport width. These layout changes do not change seller permissions or server-owned order decisions.

## Goal

Make it easy for a seller to set up products, for a customer to shop without registering, and for the seller to review each submitted order on a phone or desktop. Keep the customer and seller web interfaces separate from the server API and private database so UI changes do not silently change order behavior.

## MVP journey

1. A super admin signs in to the seller panel and creates or edits products. Only active products appear at the public shop link.
2. A customer browses products, adds items to a cart, and enters a buyer name and WhatsApp number. Email is optional and unverified. Buyer and recipient phone inputs support Malaysia (+60) and Singapore (+65).
3. The customer enters a separate recipient name, phone, address, and postcode for each delivery destination, reviews the order, and submits it without an account or OTP.
4. The server saves the order and returns a unique order number. The page shows a receipt. IndexedDB keeps the cart; localStorage keeps only the latest minimal receipt. The server remains authoritative.
5. An authenticated seller reviews the order on a responsive dashboard, then confirms or rejects it. The seller can copy recipient details into a separate shipping system or open the opted-in buyer's WhatsApp chat and send a message manually.

## Implementation order

Seller login, product management, public catalog/cart, guest checkout, and seller order queue/detail/decision views now run locally against the documented API. A decision uses the current server revision; another tab's decision triggers a 409 and reloads the latest state. The initial super admin username and password come from ignored server configuration: `.env` for direct Node development or an ignored Docker environment file plus Compose secret. There is no built-in credential in source or committed configuration. Production startup rejects known development defaults and missing or weak credentials.

There is no customer-facing cross-device history lookup in the MVP. A phone number or email supplied without verification is contact data, not proof of ownership.

Checkout offers optional same-browser history for buyer and recipient phones and destination addresses: after an explicit save choice on a confirmed order, customers can type or select previous values and clear that history. Saved suggestions expire 90 days after the most recent save; storage failure leaves them in the current page only. The server does not expose a public contact-history lookup. MYR is the only shop currency; the MVP has no shipping-charge calculation or delivery-area enforcement. Destination addresses are collected for seller review.

The owner requests permanent server retention of submitted orders, including contact and address snapshots. There is currently no automatic order purge or deletion API. The lawful basis and durable recovery requirements for that request remain an AC-16 release blocker; do not use the local instance for real customer data. Browser suggestion history follows its separate clearable 90-day rule.

Both web surfaces have separate local PWA manifests/scopes, versioned public-shell caches, and offline pages. Local checkout and seller decisions require a server response; offline seller actions are disabled and the offline shell contains no private order data. Installation across target browsers remains unverified. The UI defaults to English and offers, in order, English, Malay, Mandarin, Vietnamese, Thai, Japanese, and Korean; local phone/desktop browser checks cover core flows, errors, focus and layout in all seven. See the [seller desktop/mobile previews](docs/UI_SPEC.md) and [PWA/i18n requirements](docs/PWA_I18N.md).

The [verification workflow](.github/workflows/verify.yml) runs the new application's Node 24 syntax checks, tests, and dependency audit on future GitHub pushes and pull requests. It has not run remotely for this local work.

## Run with Docker Compose

The [Compose stack](compose.yaml) runs **two containers**: Caddy serves both PWA shells and proxies `/api/*`, `/health`, and `/ready`; one Node backend owns the API and private SQLite database. SQLite is a file in the `db_data` named volume, not a third container. The backend has no published host port. The default frontend binding is `127.0.0.1:8080` for local testing.

Create an ignored `.local/admin-password` file containing a unique 16–256 character secret with letters and numbers; restrict it to the deployment operator. For a local synthetic-data setup, run `mkdir -p .local` and `(umask 077; openssl rand -base64 32 > .local/admin-password)`. Copy [the Compose environment example](deploy/docker.env.example) with `cp deploy/docker.env.example .local/docker.env`, set `ADMIN_USERNAME`, and review the bind and origin values. Then run `docker compose --env-file .local/docker.env up --build -d`, check `docker compose --env-file .local/docker.env ps`, and visit `http://127.0.0.1:8080/shop/` and `/seller/`. Keep the secret file, `.local/docker.env`, and database volume out of source control and public static paths. Restart with `docker compose --env-file .local/docker.env restart`; do not remove `db_data` with `down -v` without an approved data recovery or disposal procedure.

For a future HTTPS host, set `SITE_ADDRESS` to the hostname, `PUBLIC_ORIGIN` to its exact `https://` origin, `NODE_ENV=production`, and bind the frontend to public ports 80 and 443 after DNS, TLS reachability, data retention, backups, and rollback are settled. Caddy obtains certificates for a reachable domain. Do not expose the backend port; its trusted proxy setting assumes only the Caddy container can reach it. Production startup fails if the secret is missing or weak. Local Docker smoke checks do not establish a released service. See [deployment operations](docs/DEPLOY.md) for data and release gates.

For a local restricted backup, run `./deploy/backup.sh`. It pauses both containers, archives the full SQLite volume under ignored `.local/backups/` with mode `0600`, verifies the archive, writes a SHA-256 checksum, and restarts the stack. The script accepts an environment file and Compose project name as optional arguments. This local snapshot is unencrypted; settle encrypted storage, off-host copies, schedule, and retention before using real customer data. An isolated synthetic-data restore rehearsal passed; see [DEPLOY.md](docs/DEPLOY.md).

## Local demo catalog

After starting the loopback Compose stack, run `npx --yes node@24 --env-file=.local/docker.env scripts/seed-demo-products.js` to add the [20 fictional products](demo/catalog.json) with generated product photos, English descriptions/details, six categories, and MYR prices. The script signs in through the seller API using the ignored username and password file, creates active `DEMO-001`–`DEMO-020` products, and signs out. It accepts only a local HTTP origin, which can be supplied as its first argument when the frontend uses a different loopback port. Re-running it skips matching SKUs and stops on a conflicting existing product. Images are sent as bounded base64 and stored in private SQLite; the source WebP files are reusable local demo assets, not the public runtime image source. Demo specifications and prices are fictional and need seller confirmation before any real sale. Do not seed a real-data deployment.

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
