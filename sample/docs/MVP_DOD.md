# MVP definition of done

This is a historical implementation checklist for the separate local prototype, not acceptance evidence for the new Online Shopping MVP. Current verification is incomplete: on 2026-09-25, Node 24.20.0 ran 32 sample tests with 31 passing and one failing stale revision-snapshot assertion in `test/fulfillment.test.js`. The checked items below indicate prototype code paths exist; they do not assert a current all-pass suite or a release.

- [x] Local Node 24 start, configurable host/port, health endpoint, and 100 fictional customers.
- [x] Mobile customer PWA with access context, sender profiles, multi-parcel forms, MY/SG validation, submission reference, and offline static shell.
- [x] Seller login, KPI/search/exception queue, details, notes, audits, corrections, revision/cancel, customer directory, handoff, AWB, and tracking.
- [x] Revision fence, append-only audit, duplicate warnings, validation history, current-revision validation before approval, and complete local workflow.
- [x] Isolated local CSV/manual adapter, no external call, formula safety, idempotency, failure/retry.
- [x] Deterministic local service/validation/PWA tests and production-equivalent PostgreSQL schema documentation.
- [x] Commerce catalog, Customer address book, multi-address sales-order snapshots, Seller review/revision/confirmation, revision fences, and append-only Commerce audits.
- [x] Commerce PWA IndexedDB cart/address convenience cache with token-free records and API cache bypass.
- [x] Commerce boundary documented: confirmed sales order only; no automatic Shipment or Parcel creation.
- [x] Seller Fulfillment UI and routes: confirmed-only start-once, immutable revision source, independent shipments, pick fences, parcels, exact allocation, weight/content/service readiness, fictional logistics-product CRUD, audit timeline, and customer-safe summaries ending at `READY_FOR_HANDOFF`.

Independent QA and Reviewer sign-off are process gates external to this implementation. Their results must be recorded before claiming `READY_FOR_ACCEPTANCE`.
