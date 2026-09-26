# Design specification

**Status: implemented local seller, shop, checkout, and order-review paths with release gates remaining.** This document describes the new MVP, not the `sample/` prototype.

## Verified repository state

The new root application now has a Node 24 HTTP entry point, private SQLite schema v5, a persistent seller session, seller product API/editor, responsive seller and public shop catalog/cart, contact validators, and targeted tests. The product API owns per-product MYR/SGD prices, active-only public visibility, and authenticated image access. A Node 24 CI workflow is configured but has not run remotely. The root has an atomic guest order API and checkout UI plus authorized seller queue/detail and revision-fenced decision APIs consumed by the seller order views. Production operations and a deployed runtime remain. The local `sample/` is a separate Node HTTP/SQLite PWA prototype: its Commerce/Logistics/Fulfillment rules are business references, while its in-memory sessions, fictional customer links, credentials, PWA cache, and logistics workflow are not new-app design decisions.

The local development stack uses Node 24 built-ins and `node:sqlite`, with the database outside `public/` under the ignored `.local/` directory by default. A local two-container Compose runtime now places static PWA delivery and API reverse proxy in Caddy, and the Node API with SQLite in one private backend container. SQLite and session hashes persist in a named volume; there is no separate database server or published backend port. The backend trusts the client IP header only when Caddy overwrites it on the private network; its rate limiters require one backend instance. Production hostname, backup, retention, and recovery remain DEC-04. See [DEPLOY.md](DEPLOY.md) for the runtime boundary. The current `GET /health` liveness endpoint is independent of the `GET /ready` schema check. The first schema owns exactly one configured admin and hashed, expiring sessions. The seller login UI uses the API; no browser code reads the database. A new customer cart module stores only product IDs and quantities in IndexedDB and falls back to page memory when storage fails; it never owns prices or orders. See [API.md](API.md) for implemented paths and [PROGRESS.md](PROGRESS.md) for proof and limits.

The guest order-create API calls the server's contact validators for both buyer and recipient fields. They use pinned `libphonenumber-js` number-plan metadata for +60/+65 validation and E.164 output, bound names/email, require `whatsappOrderContactOptIn: true`, and identify invalid fields without echoing contact values. The browser requires an active check; the API rejects false or missing permission without writing an order. The browser checkout posts to this endpoint and uses its field-specific validation results. The dependency validates number structure only; neither the helpers nor checkout treat an unverified number as identity proof.

The server product validator bounds SKU, English name/description, managed category code, MYR/SGD integer minor-unit price, status and optional base64 image input. The seller API persists decoded image bytes in private SQLite and serves images only through authenticated seller or active-only public paths; product list JSON contains an image URL, not image bytes. The public shop requests active products through the API for search, category filtering and detail. Its IndexedDB cart stores only product IDs and quantities; cart rendering fetches current active product facts, marks missing products unavailable, and shows an advisory total only when every cart line uses one currency. No image means a local placeholder. Guest checkout assigns each cart line to one destination, posts an idempotency key, and shows a server receipt only after confirmation. Optional local contact history uses explicit save and a keyboard-operable combobox. Localized product text remains planned; order snapshot regression tests pass.

The `general_code` table currently owns only `PRODUCT_CATEGORY` codes. A code is stable; its label can change, and it can be deactivated for new assignments without deleting historical products. Existing v3 category strings migrate to codes with the same initial label. Product writes validate against an active code; public responses show the current label, while seller product responses also include `categoryCode`. The singleton `company_setting.default_currency` starts at MYR and sets the default in the new-product form. Existing products retain their own MYR or SGD price and currency. A default change does not convert prices or order snapshots. The backend rejects a checkout containing both currencies before allocating an order number or writing order rows. SQLite v5 widens the product, order, and order-item currency constraints and retains transaction-owned snapshots.

## Users and journeys

- Customer: discover products, manage a cart, enter buyer contact, assign items to one or more delivery destinations, submit, and view the resulting order number and same-browser receipt.
- Super admin: sign in to the seller panel, configure products, review server-calculated orders, confirm or reject, copy order details, and open a buyer WhatsApp chat for manual communication.

## Application boundaries

```text
Customer web app ----\
                     >---- Backend API ---- Domain rules ---- Private database
Seller web app ------/
Customer browser: IndexedDB for cart; localStorage for the latest minimal receipt and opted-in contact suggestions
```

The two web surfaces can live in one repository but must build and evolve separately from the API. They never read or write the database directly. The backend owns validation, price calculation, order-number allocation, persistence, seller authorization, status changes, and audit events. An API contract and contract tests protect those boundaries when the UI changes. Database schema changes remain internal when the API contract can stay stable; business changes may require an explicit contract update.

## Customer experience

- Use familiar mobile shopping patterns: readable product cards, search and categories, clear product details, persistent cart access, a short checkout, field-level errors, and a clear success receipt. Draw inspiration from common marketplaces without copying their branding or layouts.
- Checkout requires buyer full name and WhatsApp phone. Email is optional. All contacts are unverified in the MVP and may be edited before submission.
- Buyer WhatsApp and recipient phone inputs support Malaysia `+60` and Singapore `+65`. Show a country-code selector and accept common local spacing, but normalize and validate the complete number on the server before saving or building a WhatsApp link. Keep phone country independent from buyer identity, selected UI language, and delivery address country. Do not use an unverified phone as authentication.
- Each delivery destination has its own recipient name, phone, address, and postcode. Items are assigned to a destination. Buyer contact and recipient contact are distinct.
- The MVP records an address country and postcode without shipping charges, delivery eligibility checks, or logistics integration. The seller handles fulfillment manually. After an explicit same-device save choice on a confirmed order, checkout offers earlier phone/address values in typing-friendly comboboxes; the customer can clear that browser history. The local suggestion list is bounded to ten values per type and expires 90 days after the most recent save. It is never a public identity or order lookup.
- WhatsApp is the only buyer order-contact channel. Explain this before submission, require an unchecked, buyer-controlled opt-in for order-related messages, and reject an order without it. A prechecked, locked consent control would not establish active permission. New orders record consent version `order-contact-v2`; historical orders retain their stored permission state. Marketing consent, if ever needed, is separate. See the [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/).
- After the API confirms the write, show the server-generated order number. Keep only the latest minimal receipt in localStorage. If local browser data disappears, the seller still has the authoritative order; customer self-service recovery is deferred.

## Order model and rules

- `Product`: server-owned catalog identity, availability, price in integer minor units, currency, required English name/description, and optional localized text keyed by supported language.
- `GeneralCode(PRODUCT_CATEGORY)`: stable category code, mutable display label, and active state; no deletion endpoint.
- `CompanySetting`: singleton default currency for new product drafts, independent of existing product and order currencies.
- `Order`: internal opaque ID, public order number, buyer contact snapshot, status, revision, server-calculated total, timestamps, and WhatsApp order-contact consent evidence.
- `Delivery`: destination address and recipient contact snapshot; one order has one or more deliveries.
- `OrderItem`: product name/SKU/price snapshot, quantity, line total, and one delivery assignment. Snapshot the selected display name and locale so later catalog translation edits do not rewrite an order.
- `OrderEvent`: append-only review history with actor, prior status, new status, and timestamp. Avoid duplicating contact details in events.

For the MVP, the state path is `SUBMITTED -> CONFIRMED` or `SUBMITTED -> REJECTED`. Seller decisions use the current order revision so a stale browser cannot overwrite a later decision. Rejection records a bounded reason. The local guest order API commits the order, number allocation, item/delivery snapshots, consent evidence, initial event, and idempotency record together. Seller detail reads one database snapshot; a confirm/reject transaction checks the current revision, updates state, and appends an actor/time/reason event atomically. The seller UI reloads the detail and queue after a stale 409. Schema v5 keeps contacts in private tables and public responses to a minimal receipt. A retry of the same checkout intent returns the same original receipt; a distinct intent may create a distinct order even when its contents match.

Phone and email are searchable contact fields, not primary keys or customer authentication. Use internal generated IDs. Do not expose an API that lists historical orders merely because a visitor enters a matching phone or email.

## Seller setup and authentication

Build the seller panel first. The initial super admin creates, edits, activates, or deactivates products; public catalog reads return active products only. Product names, descriptions, images, prices, and availability are configured through the seller API, which validates writes and owns the database. Do not delete products referenced by order snapshots.

Read initial super admin credentials from server-side environment variables or one ignored secret file, provisioned through an ignored local `.env` during direct development or a Compose secret in Docker. No source-code fallback credentials or committed password file. Use a server-controlled session with secure cookie settings and CSRF protection for browser mutations. The login endpoint needs rate limiting and a generic failure response. In production, refuse startup if the configured credential is absent, a known development default, or below the minimum password policy. Seller access remains server-authorized; hiding UI controls is insufficient.

## Seller navigation and order handoff

After login, show a top bar and a collapsible left side bar. The side bar has `Products`, a `Sales Manager` group with `Sales Orders` and `Sales Order Confirmation`, and `Configuration` with category codes and company settings. The seller brand button toggles the desktop rail or closes the phone drawer. Its visible toggle switches between expanded labels and a compact icon rail without losing the current page; on narrow screens it opens as a dismissible navigation drawer. Use actual SVG icons in the implementation, with accessible names, keyboard-operable controls, visible focus, and an indicated current page. The top bar has a seller account menu with `View profile` and `Sign out`. The profile shows the current username and role from the authenticated session; sign-out invalidates the server session and returns to login.

`Sales Orders` lists all statuses with order-number search and status filtering; `Sales Order Confirmation` lists submitted orders for confirm/reject. They are views over the same backend record. On phones, selecting an order opens a detail view with a return button; on wide screens, queue and detail sit side by side. The detail separates buyer contact from every delivery recipient and address. Individual fields have copy controls with inline and announced success/failure feedback. A seller decision requires an explicit dialog; offline controls are disabled, and a missing response never claims success. Future CSV/Excel export or Ninja Van integration must use a separately verified external format; no external integration is claimed for the MVP.

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

A failed database transaction returns an error and no order number. After a network timeout, the checkout client must retry the same idempotency key rather than claim success or start a second intent. A stale seller decision returns a conflict and requires a reload. Use structured error codes and request correlation without raw contact fields in logs. The chosen Docker topology has liveness/readiness and private persistence; migration, backup/restore, and rollback still need production verification before real-data release. The local application has 20 fictional demo products. The v3→v5 migration seeds category codes from existing products and rebuilds currency constraints while preserving data. Before applying it to a persistent instance, back up the stopped SQLite volume and verify the backup. The sample's development data is not a compatibility target.

Browser verification covers seller setup, guest checkout, receipt and seller review at phone and desktop widths, including loading/empty/error/success states, keyboard access, labels/focus/error messages, overflow, and console errors. Local Chromium exercised seller product errors, queue/detail, copy success/failure, opted-in click-to-chat, confirm/reject, a two-tab stale decision, sign-out clearing private DOM, 320/390/1280px layouts, offline decisions, and seven-language shop/seller journeys. Changing language while a decision dialog is open retains translated errors and returns focus to the current action when closed. Both web surfaces have local manifests, separate service-worker scopes, and explicit public-static-asset caches; their offline pages and API cache bypass are locally verified. Verify actual installation and update behavior on target devices before AC-17. See [PWA_I18N.md](PWA_I18N.md) and [UI_SPEC.md](UI_SPEC.md).

## Open decisions before release

- Exact production HTTPS host and certificate reachability; the chosen one-backend Docker topology already uses private SQLite and persisted session hashes.
- The owner requests permanent retention of server orders and their contact/address snapshots. The server currently has no automatic order deletion, but the lawful basis or exception and recovery guarantee remain unresolved before any real-data launch. Browser suggestion history is a separate, clearable 90-day convenience store.
