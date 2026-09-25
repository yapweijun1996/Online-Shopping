# Draft API contract

**Status: partially implemented.** Seller session, liveness/readiness and product paths run locally; order paths below remain proposed targets. Keep this file aligned with actual behavior.

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
| `GET` | `/api/v1/products/{id}/image` | Bounded image bytes for an active product; returns 404 for absent/inactive images. |
| `GET` | `/api/v1/seller/products` | Authorized seller list, including inactive products; `search`, `category`, `limit`, `offset`. |
| `POST` | `/api/v1/seller/products` | Authorized same-origin/CSRF product create; MYR only. |
| `PATCH` | `/api/v1/seller/products/{id}` | Authorized same-origin/CSRF partial edit or availability change. |
| `GET` | `/api/v1/seller/products/{id}/image` | Authorized image read, including inactive products. |

The local session is stored by token hash in SQLite and expires after 12 hours. Production cookies add `Secure`; production startup requires an HTTPS `PUBLIC_ORIGIN` and rejects missing, too-short, or known-placeholder admin passwords. The initial admin is provisioned once from ignored server configuration and startup fails if later configuration does not match it. **Order endpoints below are not yet live.**

## Principles

- All order and product facts come from the server. The browser may cache a cart and minimal receipt, but never supplies an authoritative price, total, status, or buyer identity.
- Customer checkout and the seller login endpoint are unauthenticated entry points. All other seller endpoints require an authenticated super admin session and server-side authorization.
- JSON responses use stable error codes. Private responses use `Cache-Control: no-store`.
- State-changing requests validate input and are bounded. The server records the actual authenticated seller as the review actor.
- Current product responses return seller-authored English name/description. Optional localized catalog text is planned; language changes never alter IDs, prices, order states, or authorization. See [PWA_I18N.md](PWA_I18N.md).

## Public endpoints

| Method | Path | Purpose |
| --- | --- | --- |
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

Buyer WhatsApp and recipient phone fields accept valid international numbers with Malaysia (`+60`) or Singapore (`+65`) calling codes for the MVP. The server normalizes them to E.164 before persistence and rejects malformed input with a field-specific `INVALID_INPUT` error. Phone country does not have to match UI language or destination address country. The shop uses MYR; the MVP does not calculate shipping charges or GST, enforce a delivery area, or integrate logistics. The address and postcode are collected for seller review, without an automatic serviceability promise.

Server-side contact validators now check strict `+60`/`+65` input with pinned `libphonenumber-js` maximum metadata, normalize it to E.164, bound buyer/recipient names and optional email, require a boolean WhatsApp order-contact choice, and identify the invalid field. They are not connected to an order endpoint yet. A structurally valid number is not proof of ownership, reachability, or WhatsApp registration.

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

The order number is an illustrative format, not a finalized numbering scheme. There is no public endpoint to enumerate orders by phone, email, or order number in the MVP. Optional prior phone/address choices will be held only in the same browser after an explicit save choice, with a clear-history control; the server does not expose contact history lookup.

## Seller endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/seller/session` | Sign in using server-configured super admin credentials. |
| `GET` | `/api/v1/seller/session` | Read the current seller username and role for the profile view. |
| `DELETE` | `/api/v1/seller/session` | Sign out, invalidate the session, and clear its cookie. |
| `GET` | `/api/v1/seller/orders` | List seller-visible orders, with status/search filters and pagination. |
| `GET` | `/api/v1/seller/orders/{orderId}` | Read an authorized order snapshot and review history. |
| `POST` | `/api/v1/seller/orders/{orderId}/confirm` | Confirm a submitted order using `expectedRevision`. |
| `POST` | `/api/v1/seller/orders/{orderId}/reject` | Reject a submitted order using `expectedRevision` and a bounded reason. |

Seller browser sessions use a server-controlled, `HttpOnly` cookie with production `Secure` and appropriate `SameSite` settings. Mutating requests must satisfy the selected CSRF defense. Login responses are generic on failure and rate limited. Product prices use integer minor units and are snapshotted into orders; later catalog edits do not rewrite existing orders.

The planned localized catalog extension would accept text keyed by supported language tags, return English when a translation is absent, and snapshot the checkout display name and locale. No translation write or locale negotiation field is implemented yet. The order snapshot contract will be finalized with checkout.

Seller product requests require SKU, English name/description, category, integer `priceMinor`, `currency: "MYR"` and boolean `active` on create. PATCH accepts a nonempty subset. Optional `imageDataUrl` is a PNG/JPEG/WebP base64 data URL up to 512 KB decoded; `null` removes an image. The server validates signature and size, stores decoded bytes in private SQLite, and returns an `imageUrl` path rather than embedding base64 in product lists. The seller page uses a placeholder when no image exists. Localized product text remains a planned extension; English is the current public fallback. Duplicate SKU returns `DUPLICATE_SKU` (409). Product responses use `Cache-Control: no-store`.

The seller web app may build an official click-to-chat link from the authorized buyer phone in an order detail response when the buyer opted in to order-related WhatsApp contact. It may also copy individual buyer and recipient contact/address fields from that authorized response. The API does not send WhatsApp messages or export courier files in the MVP. `Sales Orders` and `Sales Order Confirmation` are UI views over the same order endpoints and order state.

## Error contract

```json
{ "error": { "code": "STALE_REVISION", "message": "The order changed. Reload and try again." } }
```

Planned codes include `INVALID_INPUT` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `STALE_REVISION` (409), `IDEMPOTENCY_CONFLICT` (409), and `RATE_LIMITED` (429). Do not reveal whether an unverified phone or email exists through a public lookup response.

## Deferred APIs

Customer account/history recovery, OTP, payment, automatic messaging, batch CSV/Excel export, and courier integration have no MVP endpoints. Verify Ninja Van's current import format and operational requirements before designing any export or integration.
