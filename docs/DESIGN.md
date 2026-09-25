# Design specification

**Status: proposed end-state with a local seller-authentication slice implemented.** This document describes the new MVP, not the `sample/` prototype.

## Verified repository state

The new root application now has a Node 24 HTTP entry point, a versioned private SQLite schema, a persistent seller session, a responsive seller login shell, and targeted tests. The root still has no product/order implementation, CI, release workflow, or deployed runtime. The local `sample/` is a separate Node HTTP/SQLite PWA prototype: its Commerce/Logistics/Fulfillment rules are business references, while its in-memory sessions, fictional customer links, credentials, PWA cache, and logistics workflow are not new-app design decisions.

The local development stack uses Node 24 built-ins and `node:sqlite`, with the database outside `public/` under the ignored `.local/` directory by default. This is a reversible local choice; production hosting, backup, retention, and recovery remain DEC-04. The current `GET /health` liveness endpoint is independent of the `GET /ready` schema check. The first schema owns exactly one configured admin and hashed, expiring sessions. The seller login UI uses the API; no browser code reads the database. See [API.md](API.md) for implemented paths and [PROGRESS.md](PROGRESS.md) for proof and limits.

## Users and journeys

- Customer: discover products, manage a cart, enter buyer contact, assign items to one or more delivery destinations, submit, and view the resulting order number and same-browser receipt.
- Super admin: sign in to the seller panel, configure products, review server-calculated orders, confirm or reject, copy order details, and open a buyer WhatsApp chat for manual communication.

## Application boundaries

```text
Customer web app ----\
                     >---- Backend API ---- Domain rules ---- Private database
Seller web app ------/
Customer browser: IndexedDB for cart and minimal same-browser receipts only
```

The two web surfaces can live in one repository but must build and evolve separately from the API. They never read or write the database directly. The backend owns validation, price calculation, order-number allocation, persistence, seller authorization, status changes, and audit events. An API contract and contract tests protect those boundaries when the UI changes. Database schema changes remain internal when the API contract can stay stable; business changes may require an explicit contract update.

## Customer experience

- Use familiar mobile shopping patterns: readable product cards, search and categories, clear product details, persistent cart access, a short checkout, field-level errors, and a clear success receipt. Draw inspiration from common marketplaces without copying their branding or layouts.
- Checkout requires buyer full name and WhatsApp phone. Email is optional. All contacts are unverified in the MVP and may be edited before submission.
- Buyer WhatsApp and recipient phone inputs support Malaysia `+60` and Singapore `+65`. Show a country-code selector and accept common local spacing, but normalize and validate the complete number on the server before saving or building a WhatsApp link. Keep phone country independent from buyer identity, selected UI language, and delivery address country. Do not use an unverified phone as authentication.
- Each delivery destination has its own recipient name, phone, address, and postcode. Items are assigned to a destination. Buyer contact and recipient contact are distinct.
- Record a clear opt-in for order-related WhatsApp contact before using the number to message a buyer. Marketing consent, if ever needed, is separate. See the [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/).
- After the API confirms the write, show the server-generated order number. Keep only a minimal receipt in IndexedDB. If local browser data disappears, the seller still has the authoritative order; customer self-service recovery is deferred.

## Order model and rules

- `Product`: server-owned catalog identity, availability, price in integer minor units, currency, required English name/description, and optional localized text keyed by supported language.
- `Order`: internal opaque ID, public order number, buyer contact snapshot, status, revision, server-calculated total, timestamps, and WhatsApp order-contact consent evidence.
- `Delivery`: destination address and recipient contact snapshot; one order has one or more deliveries.
- `OrderItem`: product name/SKU/price snapshot, quantity, line total, and one delivery assignment. Snapshot the selected display name and locale so later catalog translation edits do not rewrite an order.
- `OrderEvent`: append-only review history with actor, prior status, new status, and timestamp. Avoid duplicating contact details in events.

For the MVP, the state path is `SUBMITTED -> CONFIRMED` or `SUBMITTED -> REJECTED`. Seller decisions use the current order revision so a stale browser cannot overwrite a later decision. Rejection records a bounded reason. The order write, number allocation, item/delivery snapshots, and initial event commit together. A retry of the same checkout intent returns the same order; a distinct intent may create a distinct order even when its contents match.

Phone and email are searchable contact fields, not primary keys or customer authentication. Use internal generated IDs. Do not expose an API that lists historical orders merely because a visitor enters a matching phone or email.

## Seller setup and authentication

Build the seller panel first. The initial super admin creates, edits, activates, or deactivates products; public catalog reads return active products only. Product names, descriptions, images, prices, and availability are configured through the seller API, which validates writes and owns the database. Do not delete products referenced by order snapshots.

Read initial super admin credentials from server-side environment variables, provisioned through an ignored local `.env` during development. No source-code fallback credentials or committed password file. Use a server-controlled session with secure cookie settings and CSRF protection for browser mutations. The login endpoint needs rate limiting and a generic failure response. In production, refuse startup if the configured credential is absent, a known development default, or below the minimum password policy. Seller access remains server-authorized; hiding UI controls is insufficient.

## Seller navigation and order handoff

After login, show a top bar and a collapsible left side bar. The side bar has `Products` and a `Sales Manager` group with `Sales Orders` and `Sales Order Confirmation`. Its visible toggle switches between expanded labels and a compact icon rail without losing the current page; on narrow screens it opens as a dismissible navigation drawer. Use actual SVG icons in the implementation, with accessible names, keyboard-operable controls, visible focus, and an indicated current page. The top bar has a seller account menu with `View profile` and `Sign out`. The profile shows the current username and role from the authenticated session; sign-out invalidates the server session and returns to login.

`Sales Orders` lists submitted orders and opens their detail; `Sales Order Confirmation` is the seller's review and confirm/reject workflow, not a second order record. Keep one authoritative order state in the backend. On an order detail, show buyer contact separately from each delivery's recipient and destination. Provide a copy button beside each name, phone, address line, and postcode, with clear success/failure feedback and permission-sensitive visibility. This supports manual transfer to a separate shipping system. Future CSV/Excel export or Ninja Van integration must use a separately verified external format; no external integration is claimed for the MVP.

## Seller and WhatsApp

The seller interface works at phone and desktop widths, prioritizes the new-order queue, and displays the complete order snapshot before a decision. For a buyer who opted in to order-related WhatsApp contact, a seller-only action opens an official WhatsApp click-to-chat link for the normalized buyer number. This opens the app on a phone or WhatsApp Web on a desktop; sending remains manual. See [WhatsApp click to chat](https://faq.whatsapp.com/5913398998672934). No QR-based automation, WhatsApp session custody, or outbound messaging API is part of the MVP. A future official API integration is a separate reviewed project.

## Privacy and reliability

- Keep the database and seller session private; enforce seller authorization on every order read and decision.
- Collect only checkout data needed to fulfill and contact about the order. Do not log raw contact fields or include real PII in source fixtures.
- Rate-limit public checkout and seller login; validate bounded input on the server; escape displayed customer text.
- Use server-side unique constraints and an idempotency key for duplicate submission protection.
- Display submission errors without claiming an order exists when persistence failed. Retrying the same intent must not create a second order.
- Treat IndexedDB writes as optional convenience. A cache failure must not undo a successfully saved server order.

## Failure and operational boundaries

A failed database transaction returns an error and no order number. After a network timeout, the checkout client must retry the same idempotency key rather than claim success or start a second intent. A stale seller decision returns a conflict and requires a reload. Use structured error codes and request correlation without raw contact fields in logs. Hosting and database choices must define liveness/readiness, migrations, backup/restore, and rollback before real-data release. The new application has no existing runtime data or public clients to migrate; the sample's development data is not a compatibility target.

Browser verification must cover seller setup, guest checkout, receipt and seller review at phone and desktop widths, including loading/empty/error/success states, keyboard access, labels/focus/error messages, safe areas, overflow, and console errors. Both new web surfaces have local manifests, separate service-worker scopes, and explicit public-static-asset caches; their offline pages are locally verified in Chromium. Workers bypass all `/api/` requests. Verify actual installation, offline mutation behavior, and update behavior on target devices before AC-17. Both surfaces have seven-language shell resources, but full core-flow translations and verification in [PWA_I18N.md](PWA_I18N.md) remain. See [UI_SPEC.md](UI_SPEC.md) for desktop/mobile layout and previews.

## Open decisions before implementation

- Product image storage and initial catalog presentation details.
- Shop currency, shipping charges, and supported delivery countries/postcodes. GST calculation is excluded from the MVP.
- Seller session persistence, hosting, and database choice.
- Retention and deletion policy for real customer contact and address data before any production launch.
