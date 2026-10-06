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

The local session is stored by token hash in SQLite and expires after 12 hours. Production cookies add `Secure`; production startup requires an HTTPS `PUBLIC_ORIGIN` and rejects missing, too-short, or known-placeholder admin passwords. The initial admin is provisioned once from ignored server configuration (`ADMIN_PASSWORD` or `ADMIN_PASSWORD_FILE`, never both) and startup fails if later configuration does not match it. In Compose, Caddy serves the PWAs and proxies these same-origin endpoints; the backend and SQLite volume are private. `TRUST_PROXY=1` is valid only while the backend is unreachable except through the Caddy private network, where Caddy overwrites `X-Real-IP` for rate limiting.

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

The client sends one fresh 16–128 character `Idempotency-Key` per intended order and reuses it only when retrying that same submission. The backend stores its hash with the normalized request hash and order, returns the original `SUBMITTED` receipt on same-intent retry (`200`), and rejects reuse with different content (`409`). A new order returns `201`. The server loads current active products inside one SQLite transaction, computes integer minor-unit prices and totals, saves immutable order snapshots and consent time/version, then responds after commit. Up to 10 destinations and 100 item lines are accepted; quantities are 1–100. Each item must carry `expectedPriceMinor` and `expectedCurrency`, the unit price and currency the buyer saw in the cart; if either differs from the product's current value the server rejects the order with `PRICE_CHANGED` (409) and the item field, saves nothing, and the shop returns the buyer to the refreshed cart. This also catches a seller changing a product's currency without changing its minor-unit amount, which would otherwise silently charge the buyer in the wrong currency. The expected price and currency only guard against silent changes: the saved amount and currency are always the server's current values, and client total, shipping and GST fields do not contribute to it. A failed transaction returns no receipt and does not reserve the idempotency key. The public checkout limit is 30 attempts per client address per 15 minutes, and seller login allows 5 attempts per client address per 15 minutes; a successful login clears that address's count. Attempts are reserved before the request is processed and stored as hashed client keys in the `rate_limit_attempt` table, so limits survive restarts. Both deployments run a single database writer (one Node process or one Durable Object). Example receipt:

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

The planned localized catalog extension would accept text keyed by supported language tags, return English when a translation is absent, and snapshot the checkout display name and locale. No translation write field is implemented yet. Current orders snapshot the seller-authored English name and the selected UI locale.

Seller product requests require SKU, English name/description, an active category `code` in `category`, integer `priceMinor`, `currency: "MYR" | "SGD"` and boolean `active` on create. PATCH accepts a nonempty subset. Optional `variantGroup` and `variantLabel` must be supplied together. Products in one group share category and currency, but each keeps its own SKU, price, image and active state. Duplicate option labels within a group return `DUPLICATE_VARIANT` (409); duplicate SKUs return `DUPLICATE_SKU` (409). Public detail includes active `variants` and `images`; seller detail includes inactive variants. Orders continue to reference the selected product ID and snapshot its server-verified SKU and price. Optional `stockQuantity` is an integer from 0 to 1,000,000, or `null` for unlimited stock (the default). Seller product responses include `stockQuantity`; public product responses include only `inStock` (false when a tracked count is 0).

Optional `imageDataUrl` is a PNG/JPEG/WebP base64 data URL up to 512 KB decoded; `null` removes an image only after additional images are removed. Up to four additional images may be uploaded individually after a main image exists. The server validates signature and size, stores decoded bytes in private SQLite, and returns image paths rather than embedding base64 in product lists. The seller page uses a placeholder when no image exists. Localized product text remains a planned extension; English is the current public fallback. Product JSON and seller image responses use `Cache-Control: no-store`. Public image URLs include `v` tokens; matching image versions use an immutable one-year cache, while requests without a current token receive `no-store`. A browser that already cached an image may keep showing it from cache after the product is deactivated.

The seller web app builds an official `https://wa.me/<international-digits>` click-to-chat link from the authorized buyer phone only when that buyer opted in to order-related WhatsApp contact. It copies individual buyer and recipient contact/address fields from that authorized response, with visible clipboard success/failure feedback. The link has no prefilled message; sending remains manual. The API does not send WhatsApp messages or export courier files in the MVP. `Sales Orders` and `Sales Order Confirmation` are UI views over the same order endpoints and order state. The confirmation view reloads the queue/detail after a stale 409 and keeps mutations online only.

## Managed categories and company settings

`general_code` currently has only `PRODUCT_CATEGORY` rows. Creating a category requires `{ "code": "HOME_GOODS", "label": "Home goods" }`; `code` is immutable and accepts uppercase letters, digits, `_` and `-`. PATCH accepts a nonempty subset of `label` and `active`. Deactivating a category prevents new assignments but does not delete or hide products already assigned to it. The public product `category` and public list `categories` contain display labels. Seller product responses add `categoryCode` so the editor can select the stable code. The optional product-list `category` query filters by current display label. Company settings change the default currency shown for new product drafts; each product's submitted currency remains authoritative. Existing products and order snapshots are never converted by this setting.

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
