# MVP epics

**Status: E1 and E2 in progress with guest checkout locally verified; E4 PWA groundwork in progress; E3 planned.** Epics group the 18 acceptance items in [SPEC.md](SPEC.md); they are not separate proof of completion. AC-01 is the first locally verified item.

| Epic | Outcome and boundary | Acceptance items | Exit evidence |
| --- | --- | --- | --- |
| E1 Seller foundation | One super admin can sign in and manage a private catalog. Server authorization owns access; public reads expose active products only. | AC-01–04 | Startup/auth and product contract tests; seller setup and public visibility browser checks. |
| E2 Guest shop and checkout | Guest discovers products, manages a convenience cart, supplies buyer and per-destination recipient details, and receives one durable server receipt. | AC-05–11 | Multi-destination browser journey; server pricing, atomic write, failure, and retry/idempotency tests. |
| E3 Seller order decision | Seller sees the saved order, confirms or rejects it once, copies fields, and opens manual opted-in WhatsApp contact. | AC-12–14 | Authorized queue/detail, stale-decision, audit, clipboard, and click-to-chat checks. |
| E4 Quality and release | Phone/desktop experience, privacy, PWA install/offline behavior, seven-language UI, data operations, and deployed behavior meet the MVP acceptance gates. | AC-15–18 | Browser/accessibility/locale/PWA review, security/operations evidence, deployed health/version and rollback proof. |

## Dependency order

E1 authentication and catalog API precede the public catalog and E2 checkout. E2 durable order records precede E3 review. E4 checks run incrementally but its release gate follows E1–E3. MYR, no shipping charges or delivery-area enforcement, and bounded base64 images are recorded local-MVP choices. Hosting, multi-instance session behavior, retention, and recovery remain open before E4 production release. See [TASK.md](TASK.md) for executable work and [ROADMAP.md](ROADMAP.md) for milestone gates.
