# Draft API contract

**Status: locally implemented for seller session, products, guest order creation, and seller order review.** Deployment behavior remains unverified. Keep this file aligned with actual behavior.

## Implemented local endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Process liveness, without database readiness claims. |
| `GET` | `/ready` | Checks the expected private SQLite schema and a query. |
| `POST` | `/api/v1/seller/session` | Same-origin JSON login, rate limited, using the configured single admin; returns username, role and CSRF token and sets an `HttpOnly`, `SameSite=Strict` session cookie. |
| `GET` | `/api/v1/seller/session` | Requires a valid session; returns username, role and CSRF token with `no-store`. |
| `DELETE` | `/api/v1/seller/session` | Requires session, same origin and CSRF token; invalidates the session and expires the cookie. |
| `GET` | `/api/v1/products` | Public active-only list, with `search`, `category`, `limit` and `offset`; returns `{items, nextOffset, categories}`. |
| `GET` | `/api/v1/products/{id}` | Public active-only product detail. |
| `GET` | `/api/v1/products/{id}/gallery/{imageId}` | Active-only additional product image; immutable cache with its matching `v` token. |
| `GET` | `/api/v1/products/{id}/image` | Bounded image bytes for an active product; returns 404 for absent/inactive images. Cacheable for a year when `v` matches the `imageUrl` version token. |
| `GET` | `/api/v1/seller/products` | Authorized seller list, including inactive products; `search`, `category`, `limit`, `offset`. |
| `POST` | `/api/v1/seller/products` | Authorized same-origin/CSRF product create in MYR or SGD with a managed category code. |
| `PATCH` | `/api/v1/seller/products/{id}` | Authorized same-origin/CSRF partial edit or availability change. |
| `GET` | `/api/v1/seller/products/{id}/image` | Authorized image read, including inactive products. |
| `GET` | `/api/v1/seller/products/{id}` | Authorized detail, including variant options and gallery URLs. |
| `POST` | `/api/v1/seller/products/{id}/gallery` | Authorized same-origin/CSRF upload of one additional image. |
| `GET`, `DELETE` | `/api/v1/seller/products/{id}/gallery/{imageId}` | Authorized image read or same-origin/CSRF removal. |
| `GET` | `/api/v1/seller/categories` | Authorized list of category codes, labels and active states. |
| `POST` | `/api/v1/seller/categories` | Same-origin/CSRF create with immutable uppercase `code` and `label`; returns 409 for a duplicate. |
| `PATCH` | `/api/v1/seller/categories/{code}` | Same-origin/CSRF update of `label` and/or `active`; no deletion endpoint. |
| `GET` | `/api/v1/seller/company-settings` | Authorized `{ "defaultCurrency": "MYR" | "SGD", "sellerWhatsAppPhone": string | null, "mobileHideBarsOnScroll": boolean, "availabilityText": string | null, "shippingText": string | null, "returnsText": string | null }` read. The phone is stored as international digits without `+`. |
| `GET` | `/api/v1/seller/option-types` | Authorized `{ items }` of tenant-defined option types with their values. See `docs/PRODUCT_OPTIONS.md`. |
| `POST`/`PATCH` | `/api/v1/seller/option-types[/{id}]`, `/api/v1/seller/option-types/{id}/values[/{valueId}]` | Same-origin/CSRF create and update of option types and values (never deleted, only `active: false`). Products take `options: [{ typeId, valueId }]` together with `variantGroup`. |
| `PATCH` | `/api/v1/seller/company-settings` | Same-origin/CSRF partial update of `defaultCurrency`, `sellerWhatsAppPhone`, `mobileHideBarsOnScroll` and the storefront texts `availabilityText`, `shippingText`, `returnsText` (each a trimmed string of 1–1000 characters shown in the matching section of every product page; `null` or an empty string clears it, and a section without text is not shown on the product page). Public `GET /api/v1/shop` returns them as `storefrontTexts: { availability, shipping, returns }`. Use a valid +60/+65 number (or international digits) for public product Chat; `""` or `null` disables it. Existing prices and orders are unchanged. |
| `POST` | `/api/v1/orders` | Same-origin guest checkout with a bounded JSON body and `Idempotency-Key`; creates an atomic order and returns a receipt. |
| `POST` | `/api/v1/orders/statuses` | Same-origin, rate-limited Customer status lookup for 1–50 `{orderNo, accessKey}` pairs; returns only matching `{orderNo, status, updatedAt}` entries from the last 90 days. |
| `GET` | `/api/v1/seller/orders` | Authorized seller queue with `status`, order-number `search`, `limit` and `offset`; returns `{items, nextOffset}`. |
| `GET` | `/api/v1/seller/orders/{orderId}` | Authorized complete order snapshot and audit history. |
| `POST` | `/api/v1/seller/orders/{orderId}/confirm` | Same-origin/CSRF seller decision with `expectedRevision`; returns updated detail. |
| `POST` | `/api/v1/seller/orders/{orderId}/reject` | Same-origin/CSRF seller decision with `expectedRevision` and bounded `reason`; returns updated detail. |

The local session is stored by token hash in SQLite and expires after 12 hours. Production cookies add `Secure`; production startup requires an HTTPS `PUBLIC_ORIGIN` and rejects missing, too-short, or known-placeholder admin passwords. The initial admin is provisioned once from ignored server configuration (`ADMIN_PASSWORD` or `ADMIN_PASSWORD_FILE`, never both) and is only a bootstrap value: once an account exists the database is authoritative and a different configured password is ignored. In Compose, Caddy serves the PWAs and proxies these same-origin endpoints; the backend and SQLite volume are private. `TRUST_PROXY=1` is valid only while the backend is unreachable except through the Caddy private network, where Caddy overwrites `X-Real-IP` for rate limiting.

There is no order or contact deletion API or automatic purge. An authorized `DELETE /api/v1/seller/orders/{orderId}` returns 404 without changing the order, delivery, item, event, or idempotency records. The owner requests permanent server retention of order records; this has not passed the lawful-basis or recovery release gate. Expired seller sessions are a different data class and are deleted. Optional same-browser phone/address suggestions remain user-clearable and expire after 90 days.

## Principles

- All order and product facts come from the server. The browser may cache a cart and minimal receipt, but never supplies an authoritative price, total, status, or buyer identity.
- Customer checkout, capability-scoped status lookup, and the seller login endpoint are unauthenticated entry points. All seller order endpoints require an authenticated super admin session and server-side authorization.
- JSON responses use stable error codes. Private responses use `Cache-Control: no-store`.
- State-changing requests validate input and are bounded. The server records the actual authenticated seller as the review actor.

Customer status lookup requires the random UUID v4 idempotency key from the original checkout, kept only in that browser's IndexedDB. The server stores its SHA-256 hash and matches it with the order number; the sequential order number alone never authorizes a lookup. The credential is sent in a POST body, not a URL or the legacy localStorage receipt. Wrong credentials produce an empty `items` list; responses omit buyer, recipient, address, item and rejection-reason data. Legacy orders without the credential cannot retrieve seller status, and the browser marks cached status as potentially outdated if refresh fails.
- Current product responses return seller-authored English name/description. Optional localized catalog text is planned; language changes never alter IDs, prices, order states, or authorization. See [PWA_I18N.md](PWA_I18N.md).

## Public checkout

Example checkout request (illustrative; no real personal data):

```json
{
  "buyer": { "fullName": "Demo Buyer", "whatsappPhone": "+60123456789", "email": null },
  "whatsappOrderContactOptIn": true,
  "locale": "en",
  "deliveries": [
    {
      "recipient": { "fullName": "Demo Recipient", "phone": "+6581234567" },
      "address": { "line1": "Example Street", "postcode": "47810", "country": "MY" },
      "items": [{ "productId": "product-example", "quantity": 2, "expectedPriceMinor": 450, "expectedCurrency": "MYR" }]
    }
  ]
}
```

Buyer WhatsApp and recipient phone fields accept valid international numbers with Malaysia (`+60`) or Singapore (`+65`) calling codes for the MVP. The server normalizes them to E.164 before persistence and rejects malformed input with a field-specific `INVALID_INPUT` error. Phone country does not have to match UI language or destination address country. Products can use MYR or SGD, initially defaulting to MYR. A checkout must contain one currency: `MIXED_CURRENCY` (409) is returned before any order write, and the cart disables checkout until items are separated. There is no automatic currency conversion. The MVP does not calculate shipping charges or GST, enforce a delivery area, or integrate logistics. The address and postcode are collected for seller review, without an automatic serviceability promise.

Server-side contact validators check supplied `+60`/`+65` phones with pinned `libphonenumber-js` maximum metadata, normalize them to E.164, and bound buyer/recipient names and email. Buyers must supply a full name and at least one of WhatsApp phone or email. A supplied WhatsApp number still requires `whatsappOrderContactOptIn: true`; false, omitted or non-boolean consent returns `INVALID_INPUT`. Email-only buyers are stored with an empty buyer phone and false/null WhatsApp permission metadata, even if the request attempts to opt in. Recipient phone remains required. The buyer actively checks order-only WhatsApp permission when applicable; it is not preselected and does not cover marketing. New orders record `whatsapp_consent_version: order-contact-v2`; existing orders keep their original permission evidence and visibility. A structurally valid number is not proof of ownership, reachability, or WhatsApp registration. Addresses require line 1, postcode and a two-letter country code; line 2, city and region are optional. The country code is recorded for manual seller review and does not enforce a delivery area.

Stock-tracked products are held by pending orders: available units are `stock_quantity` minus the units in `SUBMITTED` orders younger than 48 hours (`src/stock-reservation.js`), so checkout answers `409 OUT_OF_STOCK` once the last unit is held. Confirming deducts the stock; rejecting, cancelling or waiting past 48 hours releases the hold. Nothing extra is stored.

The shop keeps one key per checkout attempt until the server gives an outcome, even if the buyer edits the form after a lost response; on `IDEMPOTENCY_CONFLICT` it replays the original body and shows the original order, so a retry never creates a second order. The client sends one fresh 16–128 character `Idempotency-Key` per intended order and reuses it only when retrying that same submission. The backend stores its hash with the normalized request hash and order, returns the original `SUBMITTED` receipt on same-intent retry (`200`), and rejects reuse with different content (`409`). A new order returns `201`. The server loads current active products inside one SQLite transaction, computes integer minor-unit prices and totals, saves immutable order snapshots and consent time/version, then responds after commit. Up to 10 destinations and 100 item lines are accepted; quantities are 1–100. Each item must carry `expectedPriceMinor` and `expectedCurrency`, the unit price and currency the buyer saw in the cart; if either differs from the product's current value the server rejects the order with `PRICE_CHANGED` (409) and the item field, saves nothing, and the shop returns the buyer to the refreshed cart. This also catches a seller changing a product's currency without changing its minor-unit amount, which would otherwise silently charge the buyer in the wrong currency. The expected price and currency only guard against silent changes: the saved amount and currency are always the server's current values, and client total, shipping and GST fields do not contribute to it. A failed transaction returns no receipt and does not reserve the idempotency key. The public checkout limit is 30 attempts per client address per 15 minutes, and seller login allows 5 attempts per client address per 15 minutes; a successful login clears that address's count. Attempts are reserved before the request is processed and stored as hashed client keys in the `rate_limit_attempt` table, so limits survive restarts. Both deployments run a single database writer (one Node process or one Durable Object). Example receipt:

```json
{
  "orderNo": "OS-00000001",
  "status": "SUBMITTED",
  "currency": "MYR",
  "totalMinor": 900,
  "submittedAt": "2026-09-25T00:00:00.000Z"
}
```

The order number is allocated by a private sequence; the example is illustrative. The browser keeps the same idempotency key while retrying unchanged details after a 12-second request timeout or lost response. It never treats a network error as confirmation. On confirmed success, it clears the form and cart and stores only the latest minimal receipt in localStorage; browser storage failures show a warning without erasing server success. There is no public endpoint to enumerate orders by phone, email, or order number in the MVP. Prior phone/address choices are held only in localStorage after an explicit save choice on a confirmed order, with a clear-history control and expiry 90 days after the most recent save; the server does not expose contact history lookup.

## Seller order review contract

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/seller/session` | Sign in using server-configured super admin credentials. |
| `GET` | `/api/v1/seller/session` | Read the current seller username and role for the profile view. |
| `DELETE` | `/api/v1/seller/session` | Sign out, invalidate the session, and clear its cookie. |
| `GET` | `/api/v1/seller/orders` | List orders with `status=SUBMITTED|CONFIRMED|REJECTED`, order-number substring search, `limit` 1–100, `offset` 0–10000, and `nextOffset`. Default limit is 20. |
| `GET` | `/api/v1/seller/orders/{orderId}` | Read an authorized order snapshot and review history. |
| `POST` | `/api/v1/seller/orders/{orderId}/confirm` | Confirm a submitted order using `expectedRevision`. |
| `POST` | `/api/v1/seller/orders/{orderId}/reject` | Reject a submitted order using `expectedRevision` and a bounded reason. |

Queue items contain order ID/number, buyer name, status, revision, stored-currency total and timestamps; phone and address appear only in the authorized detail. Detail returns `buyer` with full name, normalized WhatsApp phone, optional email, opt-in boolean and consent evidence; ordered `deliveries` with recipient, address and item price snapshots; and ordered `events` with actor, previous/new status, reason and time. A detail read uses one SQLite snapshot. Seller browser sessions use a server-controlled, `HttpOnly` cookie with production `Secure` and appropriate `SameSite` settings. Mutating requests require same origin and a CSRF token. Login responses are generic on failure and rate limited. Later catalog edits do not rewrite existing order snapshots.

Confirm body is `{ "expectedRevision": 1 }`; reject body is `{ "expectedRevision": 1, "reason": "Cannot fulfill this order." }` with a required reason of at most 500 characters. Only `SUBMITTED` can move to `CONFIRMED` or `REJECTED`. A decision increments the revision and appends an event with the authenticated seller username in the same transaction. An outdated revision or already-decided order returns `STALE_REVISION` (409) without another event. Unknown order IDs return 404. The seller UI must reload after a stale response. Confirming an order deducts its quantities from tracked stock in the same transaction; if any tracked product is short the request fails with `INSUFFICIENT_STOCK` (409) and nothing changes. Rejecting never changes stock. Order creation does not reserve stock but refuses a request that exceeds tracked stock with `OUT_OF_STOCK` (409). After confirmation the seller moves an order forward with `POST /api/v1/seller/orders/{id}/ship` (body `{ expectedRevision, carrier, trackingNo? }`, carrier required up to 40 characters, tracking number optional up to 60), `.../deliver` (body `{ expectedRevision }`) and `.../cancel` (body `{ expectedRevision, reason }`). Allowed moves: `SUBMITTED`→`CONFIRMED` or `REJECTED`; `CONFIRMED`→`SHIPPED` or `CANCELLED`; `SHIPPED`→`DELIVERED`. Any other move, or a stale revision, returns `STALE_REVISION` (409). Cancelling a confirmed order returns its quantities to tracked stock; a shipped order cannot be cancelled. Order summaries and details include `trackingCarrier` and `trackingNo` once shipped, and the buyer status lookup returns the same two fields. `GET /api/v1/seller/orders/summary` returns `{ pending, latestSubmittedAt }` for the new-order alert, and the seller order list accepts the new statuses as `status` filters.

Erase contact data (SEL-05): `POST /api/v1/seller/orders/{uuid}/erase-contact`, body `{ expectedRevision, confirmOrderNo }` (origin and CSRF). Only `REJECTED`, `DELIVERED` and `CANCELLED` orders qualify (`ORDER_NOT_FINISHED` 409 otherwise); `confirmOrderNo` must equal the order number (400); a stale revision returns `STALE_REVISION` and a second erase `ALREADY_ERASED` (409). In one transaction it replaces the buyer name, phone, email, delivery recipient names, phones and address lines with fixed placeholders, clears the WhatsApp consent, empties stored buyer reply text, fails still-queued WhatsApp messages for the order, increments the revision and records `contact_erased_at` and `contact_erased_by` on the order. Order number, items, amounts, status and `order_event` history are unchanged. The order detail then carries `contactErased`, `contactErasedAt` and `contactErasedBy`; summaries carry `contactErased`. It answers 403 while quick sign-in is on, and seller session responses carry `quickLogin` so the UI can hide the action. Logic in `src/erase-contact.js`. `GET /api/v1/seller/audit-log` also lists each erasure as an item of type `CONTACT_ERASED` (actor `SELLER`, `actorId` the account, `occurredAt` the erase time), merged newest first with the order events and subject to the same filters.

Product CSV export: `GET /api/v1/seller/products/export.csv` (Manager and Owner, optional `search` on name or SKU) returns one row per product, variants included: SKU, name, description, category label, variant group and label, currency, price in major units, stock (blank means unlimited), active yes or no, last update (UTC). Same file format and formula protection as the order export (`src/csv.js`), `no-store`, `Content-Disposition: attachment`, 413 `TOO_MANY_ROWS` above 5000 products. It holds no buyer data, so it also works on a quick sign-in site. Logic in `src/product-export.js`.

Product CSV import: `POST /api/v1/seller/products/import` (`{ csv, commit }`, Manager and Owner, origin and CSRF, at most 1,000,000 characters and 2000 rows). Rows are matched by SKU (case-insensitive): an existing SKU is updated, a new SKU is created. The file is the one the export produces, matched by column name; unknown columns are ignored and a leading apostrophe added by the export is removed. Only `Name`, `Description`, `Category` (code or label, must be active), `Price` (decimal, at most two places), `Stock` and `Active` (yes/no/true/false/1/0) are applied. On an existing product a blank cell leaves the value alone, except `Stock`, where a blank cell means unlimited (and a missing column means unchanged); a new product needs name, description, category and price, takes the shop currency, defaults to active, and `Currency` must match when given. `Variant group` and `Variant label` cannot be imported: on a new SKU they are an error, on an existing SKU they must equal what is stored. Variants of one product must agree on name, description and category. With `commit: false` the answer is `{ summary: { create, update, unchanged, errors }, rows: [{ line, sku, action: create|update|error, changes: [{ field, from, to }], errors: [{ field, code, message }] }], hiddenRows }` and nothing is written. With `commit: true` the same checks run again inside one transaction; any error returns 409 `IMPORT_HAS_ERRORS` with the same body and writes nothing, otherwise every create and update goes through the editor's own code and product history. Error codes: `REQUIRED`, `DUPLICATE_IN_FILE`, `CATEGORY_UNKNOWN`, `CURRENCY_MISMATCH`, `VARIANT_NOT_IMPORTABLE`, `SHARED_CONFLICT`, `COMPANY_CURRENCY_CONFLICT`, `INVALID`. Logic in `src/product-import.js`.

Notes, product history and bulk switching (schema 24): `POST /api/v1/seller/orders/{uuid}/notes` (`{ body }`, 1 to 1000 characters, line breaks allowed, any seller role, origin and CSRF, at most 50 per order, `TOO_MANY_NOTES` 409) appends an internal note; notes are append-only (no edit or delete), are returned as `notes` on the order detail and never reach the buyer. Erasing contact data does not remove notes, so the page tells the seller not to write phone numbers or addresses in them. `GET /api/v1/seller/products/{uuid}/history` (Manager and Owner; `limit` up to 100, `offset`) lists `{ actor, action: CREATED|UPDATED, changes: [{ field, from, to }], at }`, newest first, for sku, name, description, category, price, currency, active, stock, variant label and photo count; an edit that changes nothing writes nothing, and a rejected edit writes nothing because the entry shares the edit's transaction. Stock that moves when an order is confirmed or cancelled is shown on the order, not here. `POST /api/v1/seller/products/bulk` (`{ ids: [1 to 100 different product ids], action: activate|deactivate }`, Manager and Owner) switches the products in one transaction and records one history entry per changed product; one unknown product or conflict returns an error and changes nothing. Logic in `src/order-notes.js` and `src/product-history.js`.

Accounts and roles (SEL-04, schema 23): `POST /api/v1/seller/session` signs in a `seller_account` (username is case-insensitive, one password hash is always computed so timing does not reveal which usernames exist) and the session response is `{ username, role, quickLogin, mustChangePassword, capabilities, csrfToken }`. Roles are `OWNER`, `MANAGER` and `STAFF`, checked on the server for every request from the account row, so a role change, deactivation or password reset applies on the next request (`src/roles.js`). Staff may view orders, ship and deliver; Managers also confirm, reject, cancel, manage the catalog, resolve WhatsApp messages and read sales figures; only the Owner reads or changes company settings, shop setup, the WhatsApp connection, accounts, exports and erases contact data. A forbidden call returns 403 `FORBIDDEN`. `POST /api/v1/seller/account/password` (`{ currentPassword, newPassword }`, any role, origin and CSRF, 10 attempts per 15 minutes per account) needs the current password, requires 12 to 256 characters that do not contain the username, ends every other session of the account and clears `mustChangePassword`; a wrong current password is 403 `WRONG_PASSWORD`. While `mustChangePassword` is true (new account, or password reset) every other seller route returns 403 `PASSWORD_CHANGE_REQUIRED`. Owner only: `GET /api/v1/seller/accounts` (accounts and the 20 latest account events, never a password), `POST` (`{ username, role: MANAGER|STAFF, password }`, the password is temporary) and `PATCH /api/v1/seller/accounts/{uuid}` (`role`, `active`, `resetPassword`; deactivating or resetting ends the person's sessions; the Owner account and the caller's own account cannot be changed this way). Accounts are never deleted because order events name the person who acted. All account routes and the password change answer 403 while quick sign-in is on. Recovery on the server: `scripts/reset-seller-password.js` (see DEPLOY.md).

Order filters, CSV export and dashboard figures: `GET /api/v1/seller/orders` and `GET /api/v1/seller/orders/export.csv` share one filter set: `status` (comma list), `search` (order-number fragment), `from` and `to` (exact UTC instants, `to` exclusive, applied to `submittedAt`), `currency` (`MYR` or `SGD`), `minTotal` and `maxTotal` (integers in minor units). Anything else invalid returns 400 `INVALID_INPUT`. The CSV (UTF-8 with BOM, CRLF, `Content-Disposition: attachment`, `no-store`) holds order number, submitted time, status, currency, total, item count, buyer name, WhatsApp number and email, destination count, carrier, tracking number and whether contact data was erased. A cell that starts with `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe so a spreadsheet never runs it. More than 5000 matching orders returns 413 `TOO_MANY_ROWS`; it answers 403 while quick sign-in is on because it contains buyer contact data. `GET /api/v1/seller/dashboard` returns `ordersToday` and `pending`, `salesToday` and `salesWindow` (last 30 days) as one row per currency (`{ currency, orders, totalMinor }`, never summed across currencies), and the five `topProducts` by units sold. Days are Malaysia/Singapore days (UTC+8) and only `CONFIRMED`, `SHIPPED` and `DELIVERED` orders count as sales. Logic in `src/seller-orders.js` (`orderFilter`), `src/order-export.js` and `src/dashboard-figures.js`.

The planned localized catalog extension would accept text keyed by supported language tags, return English when a translation is absent, and snapshot the checkout display name and locale. No translation write field is implemented yet. Current orders snapshot the seller-authored English name and the selected UI locale.

Images have an optional small preview (schema 20): `imageDataUrl` may be sent with `thumbDataUrl` (a PNG, JPEG or WebP of at most 80 KB, made by the seller's browser; only valid together with an image), gallery uploads accept `{ imageDataUrl, thumbDataUrl }`, and `PUT /api/v1/seller/products/{id}/thumbnail` and `/gallery/{imageId}/thumbnail` set a preview for an existing image. `GET .../image?size=thumb` (product and gallery images, public and seller) returns the preview, or the full image when none exists. Replacing an image without a preview removes the old preview.

Seller product requests require SKU, English name/description, an active category `code` in `category`, integer `priceMinor`, `currency: "MYR" | "SGD"` and boolean `active` on create. PATCH accepts a nonempty subset. Optional `variantGroup` and `variantLabel` must be supplied together. Products in one group share category and currency, but each keeps its own SKU, price, image and active state. Duplicate option labels within a group return `DUPLICATE_VARIANT` (409); duplicate SKUs return `DUPLICATE_SKU` (409). Products of one variant group belong to one listing: title, description and category are shared (editing them on any variant updates all), and the seller list returns one row per listing with `variantCount`, `activeCount`, `priceFromMinor`, `priceToMinor` and `stockTotal`. The photo gallery is shared by the listing and edited on its first variant; other variants ignore a `gallery` in an edit and answer `GALLERY_SHARED` (409) to photo add/delete, and a variant's own main photo (`imageDataUrl`) is shown first for that variant only. Public detail includes active `variants` and `images`; seller detail includes inactive variants. Orders continue to reference the selected product ID and snapshot its server-verified SKU and price. Optional `stockQuantity` is an integer from 0 to 1,000,000, or `null` for unlimited stock (the default). Seller product responses include `stockQuantity`; public product responses include only `inStock` (false when a tracked count is 0).

Optional `imageDataUrl` is a PNG/JPEG/WebP base64 data URL up to 512 KB decoded; `null` removes an image only after additional images are removed. Up to four additional images may be uploaded individually after a main image exists. The server validates signature and size, stores decoded bytes in private SQLite, and returns image paths rather than embedding base64 in product lists. The seller page uses a placeholder when no image exists. Localized product text remains a planned extension; English is the current public fallback. Product JSON and seller image responses use `Cache-Control: no-store`. Public image URLs include `v` tokens; matching image versions use an immutable one-year cache, while requests without a current token receive `no-store`. A browser that already cached an image may keep showing it from cache after the product is deactivated.

The seller web app builds an official `https://wa.me/<international-digits>` click-to-chat link from the authorized buyer phone only when that buyer opted in to order-related WhatsApp contact. It copies individual buyer and recipient contact/address fields from that authorized response, with visible clipboard success/failure feedback. The link has no prefilled message; sending remains manual. The API does not send WhatsApp messages or export courier files in the MVP. `Sales Orders` and `Sales Order Confirmation` are UI views over the same order endpoints and order state. The confirmation view reloads the queue/detail after a stale 409 and keeps mutations online only.

## Managed categories and company settings

`general_code` currently has only `PRODUCT_CATEGORY` rows. Creating a category requires `{ "code": "HOME_GOODS", "label": "Home goods" }`; `code` is immutable and accepts uppercase letters, digits, `_` and `-`. PATCH accepts a nonempty subset of `label` and `active`. Deactivating a category prevents new assignments but does not delete or hide products already assigned to it. The public product `category` and public list `categories` contain display labels. Seller product responses add `categoryCode` so the editor can select the stable code. The optional product-list `category` query filters by current display label. Company settings change the default currency shown for new product drafts; each product's submitted currency remains authoritative. Existing products and order snapshots are never converted by this setting.

## WhatsApp webhook (provider callback)

`GET /api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` answers Meta's subscribe handshake with the challenge as plain text when the token equals the verify token of a connected account; otherwise 403.

`POST /api/v1/webhooks/whatsapp` accepts a Meta delivery (body ≤256 KiB). There is no session, origin or CSRF check: the `X-Hub-Signature-256` header must be the HMAC-SHA256 of the raw body under the app secret of a connected account, otherwise 401 and nothing is stored. A valid delivery is recorded once (a repeat of the same body is acknowledged and ignored), delivery receipts advance the matching message in the outbox (never backwards) and buyer replies are stored for the seller panel. Responses are `{ "received": true }`, `401 INVALID_SIGNATURE`, `413`, `429` or `503 INTEGRATIONS_UNAVAILABLE` when no master key is configured. Rate limit: 600 requests per 15 minutes per client address.

## WhatsApp connection (seller)

All routes need the seller session; `PUT` and `DELETE` also need the same origin and `X-CSRF-Token`.

- `GET /api/v1/seller/integrations/whatsapp` returns `{ available, webhookUrl, connections: [{ provider, environment, status, publicConfig, secretHint, lastCheckedAt, lastError, updatedAt }] }`. `publicConfig` holds the phone number id, business account id, the display name and number returned by Meta and the `verifyToken` to paste into Meta's webhook setup. `available` is false (and `connections` empty) while quick sign-in is on or no master key is configured.
- `PUT /api/v1/seller/integrations/whatsapp/{SANDBOX|PRODUCTION}` with `{ accessToken, appSecret, phoneNumberId, businessAccountId }` (body ≤8 KiB; the environment comes from the URL only). The provider is called first; `400 CONNECTION_REJECTED` or `502 PROVIDER_UNAVAILABLE` store nothing. On success the access token and app secret are stored sealed and the response is the status object above, never a secret. `429` after 10 attempts per 15 minutes per client address; `403` on a quick-sign-in site; `503 INTEGRATIONS_UNAVAILABLE` without a master key.
- `DELETE /api/v1/seller/integrations/whatsapp/{SANDBOX|PRODUCTION}` clears the stored secrets and returns the status (`NOT_CONFIGURED`); `404` when no connection exists.

## WhatsApp messages (seller)

Session required; `POST` also needs the same origin and `X-CSRF-Token`. While quick sign-in is on, every read returns empty data and every write is 403, so a passwordless visitor never sees buyer text. No phone number and no sender hash is ever returned.

- `GET /api/v1/seller/messages/summary` returns `{ unreadReplies, reconcile, failed }`.
- `GET /api/v1/seller/messages/replies?unread=1&limit=&offset=` returns `{ items: [{ id, orderId, orderNo, kind, body, receivedAt, read }], nextOffset }`, newest first (`limit` 1 to 100, default 50; `offset` up to 10 000). `kind` is `TEXT`, `MEDIA_UNSUPPORTED` or `OTHER`; `body` is plain text or null.
- `POST /api/v1/seller/messages/replies/{uuid}/read` marks one reply read and returns it; 404 for an unknown id.
- `GET /api/v1/seller/messages/outbox` lists messages that need attention (`RECONCILE` or `FAILED`): `{ items: [{ id, orderId, orderNo, kind, status, lastError, attempts, createdAt, updatedAt }], nextOffset }`.
- `POST /api/v1/seller/messages/outbox/{uuid}/resolve` with `{ "resolution": "SENT" | "RESEND" }`. `SENT` (only for `RECONCILE`) records that the seller confirmed in WhatsApp Manager that Meta sent it; `RESEND` (for `RECONCILE` or `FAILED`) queues it again and accepts the risk of a duplicate. Anything else is `409 NOT_RESOLVABLE`; an accepted message can never be queued again.
- `GET /api/v1/seller/orders/{uuid}/messages` returns `{ replies, messages }` for one order.

## Error contract

```json
{ "error": { "code": "STALE_REVISION", "message": "The order changed. Reload and try again." } }
```

Observed codes include `INVALID_INPUT` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `PRODUCT_UNAVAILABLE` (409), `MIXED_CURRENCY` (409), `PRICE_CHANGED` (409), `OUT_OF_STOCK` (409), `INSUFFICIENT_STOCK` (409), `DUPLICATE_CATEGORY` (409), `IDEMPOTENCY_CONFLICT` (409), `STALE_REVISION` (409), and `RATE_LIMITED` (429). Do not reveal whether an unverified phone or email exists through a public lookup response.

## Deferred APIs

Customer account/history recovery, OTP, payment, automatic messaging, batch CSV/Excel export, and courier integration have no MVP endpoints. Verify Ninja Van's current import format and operational requirements before designing any export or integration.

## Shop setup

`GET /api/v1/shop` returns `{ mode: null | "demo" | "production", shopName, currency: "MYR" | "SGD", sellerWhatsAppPhone: string | null }` publicly. Currency is the seller's current default currency; the storefront uses it to choose the address country and calling prefix. New Demo and Production shops start with no contact. Public fictional Demo always returns `null`, even if an authenticated seller configures a number; its response also includes `demoNamespace` for browser-storage isolation. Legacy Demo and Production settings can replace or clear their contact. Unconfigured shops return `null`. Opening the product Chat link does not send a message automatically or include buyer information. `GET /api/v1/seller/setup` returns the mode and shop name after seller authentication.

`POST /api/v1/seller/setup` requires seller session, same origin and CSRF token. Accepts `{ mode: "demo" }` or `{ mode: "production", shopName: "Your shop" }` (1–80 characters). Demo creates 35 general-store products with images and seven categories atomically, only in an empty catalog without categories or orders. It establishes MYR before seeding inside the same transaction, including when an empty unconfigured shop previously selected SGD. A failure rolls back settings and every seed row; nonempty stores retain existing settings/data. Production inserts no products. Repeating the chosen mode is idempotent; changing it returns `409 SHOP_ALREADY_CONFIGURED`. Demo against existing catalog data returns `409 SHOP_NOT_EMPTY`. Use a separate database for another mode; no persistent reset/delete operation is provided.

### Simulation orders

When the persisted shop mode is `demo`, `POST /api/v1/orders` retains item/quantity/price/currency/locale validation but replaces all buyer, recipient and address fields with fixed demo data. It saves `whatsapp_opt_in=0`, null consent metadata and no email. The client cannot activate this behavior in Production. Receipts use `DEMO-` numbers and include `simulation: true`, including idempotent replays; seller summaries/details expose the same marker. There is no payment or dispatch operation.

The current customer UI submits exactly one delivery per order and only checked cart lines. The API retains the existing 1–10 delivery contract for older clients and seller history compatibility. Browser-local Profile is a checkout convenience, not server-authenticated buyer identity.

## Company currency and gallery candidate (2026-10-02)

Product creation inherits `company_setting.default_currency`; omitted currency is accepted, an explicitly different currency fails 400. Product PATCH cannot change its recorded currency. A legacy product whose currency differs from Company Settings rejects price edits, currency patches or activation with 409 `COMPANY_CURRENCY_CONFLICT`; metadata/deactivation remains possible. Changing company currency fails 409 when any active or inactive product uses another currency. No automatic conversion/relabel/snapshot rewrite exists. A historic order retains its original price/currency/events.

In public-demo mode, authenticated Seller GET product detail exposes primary plus immutable fictional gallery photos when the seed identity/hero hash still match. Custom Seller galleries and changed seed identity continue using stored content. The independent `/api/v1/demo/` API has no live store or credential input; its role, company/resource isolation, reset/expiry/limits and production gates are described in ADMIN_MULTI_COMPANY_DESIGN.md.


## Platform API and tenant paths (R1)

The platform is disabled unless `PLATFORM_ENABLED=1` and its validated file-based settings are present. The console is `/platform/` on the exact configured `PLATFORM_ADMIN_HOST`; these paths return 404 on other hosts. All JSON is `Cache-Control: no-store`. Every write requires the exact HTTPS admin Origin and `X-CSRF-Token`.

| Method | Path under `/api/v1/platform` | Contract |
| --- | --- | --- |
| GET | `/csrf` | Five-minute encrypted login challenge cookie and CSRF token; no authenticated capability. |
| POST | `/session` | `{username,password}` plus challenge/CSRF; creates a five-minute PASSWORD session. |
| GET | `/session` | Session stage, username, TOTP enrolment flag and CSRF token. Unauthenticated: 401. |
| POST | `/totp/enrol` | Restricted session only; setup key, issuer, account and otpauth URI. |
| POST | `/totp/confirm` | `{code}` or `{recoveryCode}`; rotates to FULL (30-minute idle, four-hour absolute); first enrolment returns ten recovery codes once. |
| DELETE | `/session` | FULL only; ends the current session. |
| GET, POST | `/shops` | FULL only; list, or create `{code,name,currency,sellerUsername}`. Generated seller password and addresses returned once; caller-supplied passwords refused. |
| GET | `/shops/{id}` | Safe metadata and counts; no database credential. |
| POST | `/shops/{id}/{action}` | `expectedRevision` required. Actions: `suspend`, `resume`, `rename`, `request-deletion`, `cancel-deletion`, `reset-seller-password`. Rename adds `code,name`; deletion adds the exact `code`. |
| GET | `/audit?limit=50&cursor=...` | Append-only events; hard cap 100, cursor paging. |
| POST | `/account/password` | `{currentPassword,newPassword}`; ends other sessions. |
| POST | `/account/recovery-codes` | `{password}`; replaces all recovery codes, returned once. |
| GET | `/status` | FULL only; reachability, open pool size and counts by status. |

Five failed password/TOTP attempts lock the account for 15 minutes; successful password verification alone cannot clear failures. Sign-in is limited to ten attempts per IP per 15 minutes. TOTP uses RFC 6238 SHA-1, six digits, 30 seconds, a one-step window, and refuses a used step. Recovery codes are hashed and single use. `platform_session` is HttpOnly, Secure, SameSite=Strict, path `/api/v1/platform`.

Non-default shops add `/<code>` to normal paths: `/<code>/shop/`, `/<code>/seller/`, `/<code>/api/v1/...`, `/<code>/p/{id}`, `/<code>/s/home`. Seller cookies use `/<code>/api/v1/seller`. `GET <base>/api/v1/shop` adds `storageScope` = `t-` plus twelve hex characters from SHA-256 of the immutable tenant id. The default shop keeps its existing response and URLs. Dynamic tenant manifests have independent id/scope/start_url; aliases redirect 308 preserving the remaining path and query. Unknown, malformed, PROVISIONING, FAILED and PURGED codes return 404; SUSPENDED and DELETING return 503 without opening a tenant database. Platform outages do not affect the default shop or readiness.

The default registry row cannot be mutated through the console. The limit is twenty non-purged shops including the default. Requested deletion retains data for thirty days; the console never drops a database. Manual purge retains the registry row and aliases in terminal PURGED state, preventing code reuse.
