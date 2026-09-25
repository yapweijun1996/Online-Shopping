# Roadmap

**Lifecycle: MVP implementation in progress.** Milestones are dependency gates, not dates or claims of delivery. Each acceptance item in [SPEC.md](SPEC.md) moves through Planned → Implemented → Verified → Released separately.

| Milestone | Depends on | Outcome and exit gate | Current state |
| --- | --- | --- | --- |
| M0 Evidence and documentation baseline | Repository review | Core documents, desktop/mobile previews, draft API, explicit open decisions, measured progress, and a goal prompt under 2,000 characters agree with code and tests. | Verified as a documentation milestone. Later MVP code and local tests are tracked separately under M1–M4 and the AC counts. |
| M1 Seller foundation | M0; credential and MYR/image decisions | Build private backend/store, super admin login/session/authorization, catalog API, seller login and product management. Establish reusable locale selection and seller PWA shell. Verify AC-01–04 and seller parts of AC-17–18. | In progress: seller product API/editor, private schema v2, login/session and PWA shell run locally; AC-01 verified. Localized catalog text, snapshot regression and full browser gates remain. |
| M2 Public storefront | M1 catalog API | Build original responsive public catalog/search/detail and IndexedDB convenience cart. Add shop PWA shell and seven-language interface. Verify AC-04–05 and relevant AC-15/17/18 states on phone/desktop. | In progress: active-only public catalog/search/detail, no-image placeholder, cart add/change/remove, same-browser reload and 320/390px browser checks pass. Checkout storage-failure path and complete locale/browser gates remain. |
| M3 Guest checkout and seller review | M1–M2 | Implement AC-06–14: validated multi-destination checkout with +60/+65 buyer and recipient phones, optional on-device history, MYR authoritative totals without shipping/GST, atomic order/idempotency receipt, seller queue/detail, revision-fenced confirm/reject, copy, and manual opted-in WhatsApp. Verify failure/concurrency/API and browser journeys. | Planned. |
| M4 Release readiness | M1–M3; hosting/database/session/retention decisions | Complete AC-15–18, contract/build/browser/accessibility/security, PWA and seven-language checks, private-data review, migration/backup/recovery, runtime health/readiness, deployment smoke, and rollback proof. Only then mark released. | Planned. |

## Deferred work

Payment, inventory/shipping automation, customer accounts/OTP and cross-device recovery, outbound WhatsApp automation, courier/AWB/tracking, and CSV/Excel batch export are outside these milestones. Verify any external platform/import contract before adding an integration milestone.
