# Customer repair integration delivery checkpoint

Application merge commit: `d98f035aea6eeb252f9cfb8777effa0ed9b3fb2a`.
Parents: main `85a54cd00665dd2963e1c21ae06fadf01531271d` and repair `fd60136ebfd6a556965de303b124e6e35ed54baa`.
Current application assets: Customer v113, Seller v91; runtime schema15.

## Verified locally

- Node24 combined suite:235 passed, zero failed/skipped, using real isolated PostgreSQL16.
- PostgreSQL physical schemas10/11/12/13: explicit upgrades, injected rollback, byte retention, gallery mutations and reopen.
- Actual historical repair schema12 fixture: both Node and synchronous Worker migration recognize its missing stock column, retain historical order/item snapshots, add fulfilment, and reject missing-column readiness.
- JavaScript syntax checks cover Node, PostgreSQL and Worker modules. Worker deploy dry-run succeeds; npm audit reports zero vulnerabilities.
- Auto-deploy controller tests:11 passed.
- Browser: customer discovery14; profile/address16; controlled sharing42; seller integration6; seller follow-up12; seller catalog16. Finite race matrix:22 non-PWA rows (60 substeps). Native Chromium PWA lifecycle:16 scenarios with genuine committed predecessor109/84 and target113/91 bytes, zero page errors/external requests. Historical labels in earlier logs do not override their recorded actual worker versions.
- Actual local workerd/Durable Object fresh initialization returns readiness200. This is local emulation, not deployed recovery verification.

QA harnesses await main's asynchronous database/API. Seller fixture login uses actual UI login rather than an incomplete cookie-only session. Currency policy probes use current revisions so they test money policy rather than incidental stale-gallery rejection. Gallery-capacity fixtures use distinct image bytes, retaining deduplication and overflow assertions. Account keyboard tests retain main's alerts button in the expected tab order. Historical schema12 SQL mock tests are separately scoped and do not certify PostgreSQL.

## Failure records and remaining boundaries

Initial integration tests failed on async fixtures, old schema/version assertions, reused image bytes and incomplete editor fixtures. Initial browser runs found stale synchronous harness calls, missing fixture session hints, a nonexistent palette Cancel control, and an account tab-order expectation omitting main's alerts button. Those failures remain in the local evidence logs and were corrected without skipping tests or suppressing assertions.

PWA lifecycle initially failed because fixed version literals did not match current commits, browser callbacks lacked passed version parameters, and the script checked the Seller waiting worker before installation finished. Version assertions now derive from actual committed version/worker bytes and wait for the native installation state before the same assertions.

Payment/provider dispatch remains disabled or unconfigured. Native share/clipboard permission UI, physical iOS/Android, production restore and live provider connectivity remain unverified. Guest profiles are local data. Customer account identity and customer-side cancellation are not implemented by this merge; preserved Seller cancellation and customer status/tracking remain tested. No production database was manually migrated and no real order, payment or outbound message was created.

This is a verified integration with stated limits, not QA100. A GitHub merge may trigger Cloudflare Builds. The installed PostgreSQL auto-deploy controller should hold schema changes as `manual_migration_required`; verify its observed state after merge. Production migration/recovery still needs a reviewed backup, restore proof and maintenance plan as described in V112_MAIN_INTEGRATION.md.
