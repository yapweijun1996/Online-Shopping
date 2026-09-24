# Draft API contract

**Status: partially implemented.** Seller session, liveness, and readiness paths run locally; product and order paths below remain proposed targets. Keep this file aligned with actual behavior.

## Implemented local endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Process liveness, without database readiness claims. |
| `GET` | `/ready` | Checks the expected private SQLite schema and a query. |
| `POST` | `/api/v1/seller/session` | Same-origin JSON login, rate limited, using the configured single admin; returns username, role and CSRF token and sets an `HttpOnly`, `SameSite=Strict` session cookie. |
| `GET` | `/api/v1/seller/session` | Requires a valid session; returns username, role and CSRF token with `no-store`. |
| `DELETE` | `/api/v1/seller/session` | Requires session, same origin and CSRF token; invalidates the session and expires the cookie. |

The local session is stored by token hash in SQLite and expires after 12 hours. Production cookies add `Secure`; production startup requires an HTTPS `PUBLIC_ORIGIN`. The initial admin is provisioned once from ignored server configuration and startup fails if later configuration does not match it. Product and order endpoints in the tables below are **not yet live**.

## Principles

- All order and product facts come from the server. The browser may cache a cart and minimal receipt, but never supplies an authoritative price, total, status, or buyer identity.
- Customer checkout and the seller login endpoint are unauthenticated entry points. All other seller endpoints require an authenticated super admin session and server-side authorization.
- JSON responses use stable error codes. Private responses use `Cache-Control: no-store`.
- State-changing requests validate input and are bounded. The server records the actual authenticated seller as the review actor.
- Product responses may resolve localized name/description from a supported BCP 47 language tag, with English fallback. Locale changes never alter IDs, prices, order states, or authorization. See [PWA_I18N.md](PWA_I18N.md).

## Public endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/products` | List available products; support search and category filters. |
| `GET` | `/api/v1/products/{productId}` | Read one available product. |
| `POST` | `/api/v1/orders` | Save a guest order and return its receipt. |

Example checkout request (illustrative; no real personal data):

```json
{
  "buyer": { "fullName": "Demo Buyer", "whatsappPhone": "+60100000000", "email": null },
  "whatsappOrderContactOptIn": true,
  "deliveries": [
    {
      "recipient": { "fullName": "Demo Recipient", "phone": "+60100000001" },
      "address": { "line1": "Example Street", "postcode": "47810", "country": "MY" },
      "items": [{ "productId": "product-example", "quantity": 2 }]
    }
  ]
}
```

Buyer WhatsApp and recipient phone fields accept valid international numbers with Malaysia (`+60`) or Singapore (`+65`) calling codes for the MVP. The server normalizes them to E.164 before persistence and rejects malformed input with a field-specific `INVALID_INPUT` error. Phone country does not have to match UI language or the destination address country. GST is not calculated in the MVP; currency, delivery charges, and delivery-area policy still need a business decision.

The client sends one fresh `Idempotency-Key` per intended order and reuses it only when retrying that same submission. The backend persists the key with the result and rejects reuse with different content. The server loads current available products, computes integer minor-unit prices and totals, saves immutable order snapshots, then responds after the transaction commits:

```json
{
  "orderNo": "ORDER-EXAMPLE",
  "status": "SUBMITTED",
  "currency": "MYR",
  "totalMinor": 900,
  "submittedAt": "2026-09-25T00:00:00.000Z"
}
```

The values above are format examples, not a decision about the shop's final currency or numbering scheme. There is no public endpoint to enumerate orders by phone, email, or order number in the MVP.

## Seller endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/seller/session` | Sign in using server-configured super admin credentials. |
| `GET` | `/api/v1/seller/session` | Read the current seller username and role for the profile view. |
| `DELETE` | `/api/v1/seller/session` | Sign out, invalidate the session, and clear its cookie. |
| `GET` | `/api/v1/seller/products` | List all products, including inactive products. |
| `POST` | `/api/v1/seller/products` | Create a product after server-side validation. |
| `PATCH` | `/api/v1/seller/products/{productId}` | Edit product fields or active status. |
| `GET` | `/api/v1/seller/orders` | List seller-visible orders, with status/search filters and pagination. |
| `GET` | `/api/v1/seller/orders/{orderId}` | Read an authorized order snapshot and review history. |
| `POST` | `/api/v1/seller/orders/{orderId}/confirm` | Confirm a submitted order using `expectedRevision`. |
| `POST` | `/api/v1/seller/orders/{orderId}/reject` | Reject a submitted order using `expectedRevision` and a bounded reason. |

Seller browser sessions use a server-controlled, `HttpOnly` cookie with production `Secure` and appropriate `SameSite` settings. Mutating requests must satisfy the selected CSRF defense. Login responses are generic on failure and rate limited. Product prices use integer minor units and are snapshotted into orders; later catalog edits do not rewrite existing orders.

Seller product writes require English catalog text and may include translated text keyed by the supported language tags. Public product reads return the requested translation when available and English otherwise. Order creation snapshots the display name and locale shown at checkout alongside the stable product identity and price; translations changed later do not rewrite existing orders. The exact locale negotiation field/header is finalized with the frontend contract before implementation.

The seller web app may build an official click-to-chat link from the authorized buyer phone in an order detail response when the buyer opted in to order-related WhatsApp contact. It may also copy individual buyer and recipient contact/address fields from that authorized response. The API does not send WhatsApp messages or export courier files in the MVP. `Sales Orders` and `Sales Order Confirmation` are UI views over the same order endpoints and order state.

## Error contract

```json
{ "error": { "code": "STALE_REVISION", "message": "The order changed. Reload and try again." } }
```

Planned codes include `INVALID_INPUT` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `STALE_REVISION` (409), `IDEMPOTENCY_CONFLICT` (409), and `RATE_LIMITED` (429). Do not reveal whether an unverified phone or email exists through a public lookup response.

## Deferred APIs

Customer account/history recovery, OTP, payment, automatic messaging, batch CSV/Excel export, and courier integration have no MVP endpoints. Verify Ninja Van's current import format and operational requirements before designing any export or integration.
