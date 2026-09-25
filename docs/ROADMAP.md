# Roadmap

**Lifecycle: MVP implementation in progress.** Milestones are dependency gates, not dates or claims of delivery. Each acceptance item in [SPEC.md](SPEC.md) moves through Planned → Implemented → Verified → Released separately.

| Milestone | Depends on | Outcome and exit gate | Current state |
| --- | --- | --- | --- |
| M0 Evidence and documentation baseline | Repository review | Core documents, desktop/mobile previews, draft API, explicit open decisions, measured progress, and a goal prompt under 2,000 characters agree with code and tests. | Verified for documentation only; new PWA/i18n design added, no new-app feature delivered. |
| M1 Seller foundation | M0; credential policy; currency/image decisions before catalog write contract | Build private backend/store, super admin login/session/authorization, catalog API, seller login and product management. Establish reusable locale selection and seller PWA shell. Verify AC-01–04 and seller parts of AC-17–18. | In progress: local backend, private schema, seller login/session and responsive PWA shell run; AC-01 verified. Products and full PWA/i18n gates remain. |
| M2 Public storefront | M1 catalog API | Build original responsive public catalog/search/detail and IndexedDB convenience cart. Add shop PWA shell and seven-language interface. Verify AC-04–05 and relevant AC-15/17/18 states on phone/desktop. | Planned product UI; shop PWA/locale shell and cart storage module exist, but no catalog or cart controls. |
| M3 Guest checkout and seller review | M1–M2; currency/shipping and delivery-country decisions | Implement AC-06–14: validated multi-destination checkout with +60/+65 buyer and recipient phones, authoritative totals without GST, atomic order/idempotency receipt, seller queue/detail, revision-fenced confirm/reject, copy, and manual opted-in WhatsApp. Verify failure/concurrency/API and browser journeys. | Planned. |
| M4 Release readiness | M1–M3; hosting/database/session/retention decisions | Complete AC-15–18, contract/build/browser/accessibility/security, PWA and seven-language checks, private-data review, migration/backup/recovery, runtime health/readiness, deployment smoke, and rollback proof. Only then mark released. | Planned. |

## Deferred work

Payment, inventory/shipping automation, customer accounts/OTP and cross-device recovery, outbound WhatsApp automation, courier/AWB/tracking, and CSV/Excel batch export are outside these milestones. Verify any external platform/import contract before adding an integration milestone.
