# MVP specification

**Status: acceptance contract with AC-01–11 locally verified.** The other items remain incomplete. Each `AC` is one progress unit; a row becomes **Implemented** when code and a runnable path exist, **Verified** only when its listed observable checks pass, and **Released** only when verified in the deployed release. See [PROGRESS.md](PROGRESS.md).

## Users and scope

The super admin configures a seller catalog and decides on submitted orders. A guest customer browses and buys without registration or payment. Buyer contact and each destination's recipient contact are different records. A phone or email supplied without verification is not proof of ownership. Out-of-scope work is listed in [GOAL.md](GOAL.md).

## Acceptance items

| ID | Requirement and observable acceptance | Verification gate |
| --- | --- | --- |
| AC-01 | Initial super admin credentials come from ignored server configuration; sign-in, current session, and sign-out work. No built-in production credential; missing/weak production configuration fails startup. | Configuration tests, login/session browser flow, missing/weak-startup tests. |
| AC-02 | Every seller product/order read or mutation checks the current authenticated seller; unauthenticated or unauthorized calls fail without leaking private facts. Mutations satisfy CSRF defense. | API authorization/CSRF tests with valid and invalid sessions. |
| AC-03 | Seller can create/edit/activate/deactivate a MYR product with validated SKU, name, minor-unit price, availability and optional bounded base64 PNG/JPEG/WebP image. Existing order snapshots remain unchanged after edits. | Product API and seller UI tests; image validation and snapshot regression. |
| AC-04 | Public product list/detail/search/category/image responses expose active products only; unavailable products cannot be checked out. Products without images show a placeholder. | Public API contract and browser discovery tests. |
| AC-05 | Guest can add, change, and remove cart lines; cart survives same-browser reload when IndexedDB works and checkout still works if cache writes fail. | Browser cart/reload and cache-failure tests. |
| AC-06 | Checkout collects buyer full name and WhatsApp phone; email is optional. Buyer phone accepts valid Malaysia (+60) and Singapore (+65) numbers and is normalized before storage. Buyer explicitly opts in before seller uses WhatsApp for order contact. No account or OTP is required. | MY/SG valid/invalid phone, form validation, consent, and API tests. |
| AC-07 | Each order has one or more destinations with separate recipient name, phone, address, postcode, and assigned items; recipient phone accepts valid +60/+65 numbers independently of buyer phone and address country. Field errors identify the affected destination. On-device phone/address history can be typed or selected and can be cleared; it never authenticates a buyer. | Multi-destination and mixed-country-phone API/browser tests; history save/select/clear/failure checks. |
| AC-08 | Server loads current active products, rejects invalid quantities, uses MYR integer minor-unit prices, and calculates totals. Client totals are ignored; no shipping charge or GST calculation is included in the MVP. | Price tampering, unavailable product, no-shipping/no-GST, and boundary tests. |
| AC-09 | One transaction saves a unique order number, immutable buyer/destination/item price snapshots, `SUBMITTED` state, consent evidence, initial event, and idempotency result before returning a receipt. Persistence failure returns no success. | Transaction/failure injection, uniqueness, and receipt tests. |
| AC-10 | Retrying the same checkout intent/key returns the same receipt; the same key with different content returns a conflict. Network retry does not create a duplicate. | API idempotency and timeout-retry tests. |
| AC-11 | On confirmed API success, guest sees the server order number and minimal same-browser receipt. Cache failure does not erase server success; no public contact-based order-history lookup exists. | Browser success/failure and public API negative tests. |
| AC-12 | Seller sees a searchable/paged order queue and a full authorized detail with buyer and per-destination recipient contacts, server totals, and history. `Sales Orders` and `Sales Order Confirmation` use the same record under `Sales Manager`. | API contract, authorization, and phone/desktop browser tests. |
| AC-13 | Seller confirms or rejects only `SUBMITTED` orders using the current revision; rejection has a bounded reason; every decision records actor/time/old/new state. Stale decisions fail with 409. | State, concurrent/stale decision, audit, and UI recovery tests. |
| AC-14 | Authorized seller detail offers field-by-field copy of buyer/recipient name, phone, address lines, and postcode with visible success/failure feedback; an opted-in buyer gets official click-to-chat only. No automatic send occurs. | Browser clipboard/permission and URL tests. |
| AC-15 | Core seller and guest journeys work at phone and desktop widths, with usable loading/empty/error/success states, keyboard access, labels/focus/error announcements, no horizontal overflow, and no unexplained console errors. Seller navigation has an accessible SVG-icon collapsible side bar/drawer and session-backed profile/sign-out menu. | Browser E2E, responsive, and accessibility checks. |
| AC-16 | Release uses private persistence, bounded/rate-limited public inputs, secure sessions, no real secrets/PII in the repository or logs, a defined contact-data retention/deletion policy, health/readiness, backup/recovery, and a verified deployment/rollback path. | Security review, artifact/config inspection, operational and deployed smoke checks. |
| AC-17 | Public shop and seller panel can be installed as PWAs on supported target browsers using HTTPS, valid manifests/icons, and distinct app scopes. An offline app shell gives clear feedback, while checkout/review require a live server; private responses and session data are never service-worker cached. | Manifest/install checks on phone/desktop, offline/reconnect/update checks, private-cache inspection, and failed-offline mutation tests. |
| AC-18 | Both interfaces default to English and offer language selection in this exact order: English, Malay, Mandarin, Vietnamese, Thai, Japanese, Korean. Core UI, errors, status text, accessibility labels, and seller navigation are translated; language switching preserves order data and formats dates/numbers appropriately. | Locale resource completeness checks and phone/desktop browser journeys in all seven languages; BCP 47 HTML language and layout checks. |

## Proposed API and error contract

[API.md](API.md) identifies the live seller session, product, guest order-create, and seller queue/detail/decision paths; seller review UI remains. Public catalog and guest checkout are public; seller management is private. Order-create contract tests cover validation, `Idempotency-Key`, atomicity, and a local rate limit. `PRODUCT_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, and `STALE_REVISION` are observed.

## Verification matrix

| Area | New MVP gate | Current evidence |
| --- | --- | --- |
| Static/config/build | Source lint/type/build and production configuration rejection appropriate to chosen stack. | Node 24 syntax checks and production credential-startup tests pass. A SHA-pinned Node 24 CI workflow is configured but has not run remotely; no production build/artifact gate yet. |
| Domain/API/data | Unit, integration, contract, transaction, authorization, idempotency, failure and concurrency checks for AC-01–14. | Seller session, CSRF, startup, product API, schema v1→v3/v2→v3, order-create transaction, failure, idempotency and concurrency tests pass. Seller order queue/detail/decision authorization, stale/concurrent decisions, audit and rollback tests pass; seller review UI is pending. |
| Browser | Seller setup, guest multi-destination checkout, receipt, review, loading/error states, keyboard, 390px/mobile and desktop, console/overflow; seven-language UI checks. | Seller product and public catalog/cart flows, two-destination checkout, field-error focus, typed/clicked/keyboard history selection, receipt reload, lost-response retry, and storage-failure receipt passed in local Chromium. Seller review and all-language checks remain. |
| PWA/offline | Both surfaces: install/launch, service-worker private-cache boundaries, offline shell, update, and online-only mutations. | Local Chromium confirmed distinct scopes/caches, offline pages, and a waiting-then-activated worker update; target-device install and order/review mutation checks remain. |
| Release/data | Private schema/migrations, backup/restore, retention, secret scan, artifact inspection, health/readiness, deployed version and rollback. | Local schema v1→v3 and v2→v3 migration tests pass; no backup/restore, deployed artifact, or release exists. |

Tests in `sample/` are scoped to its prototype and do not satisfy these gates.
