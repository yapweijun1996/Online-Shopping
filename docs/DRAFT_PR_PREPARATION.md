# Draft PR preparation — 2026-10-04

## Proposed title and scope

**Fix catalog galleries and stale Shop/Seller interactions**

Existing galleries could lose their primary/order selection during editing, and delayed reads, image callbacks or rejected checkout requests could affect a later view. The candidate preserves gallery contents, binds callbacks to their initiating editor/session/purchase intent, restores catalog position and focus, and clears completed checkout submission feedback before an explicit retry. Shop112 and Seller89 match their respective worker versions.

The comparison base is main `5966ca8626c6c75e8e0ec4e34488a7c47fa29376`; application evidence is at `4d02572e130e7aa7b8953c51e23f6c44fadfd11b`. The base is an ancestor. The separate integration branch `5b4aa9b5c2b2d9f3e9e96830e91bfe3d73df9fd0` is not an ancestor and its modules are absent. This is a catalog/API/Worker/UI repair, not a pure frontend change. It includes:

- Atomic gallery layout/primary selection, legacy gallery preservation, immutable historical order prices/currencies, and public presentation of the explicitly configured business contact.
- Schema12 and the shared 7,500,000-byte body budget for product PATCH only; other Worker paths retain the 1 MiB limit. Seller authorization/CSRF remain enforced by the API.
- Customer catalog/checkout ownership, Seller read/save/session ownership, dialog keyboard/focus behavior, browser zoom and PWA cache/version/update protection.
- Existing synthetic regression harnesses, seven-language presentation fixes and review documentation. No new provider connection, payment, courier, credentials, grants, CI configuration, runtime configuration or production action.

## Schema12 and release rollback boundary

Schema12 adds `product.gallery_layout_json` and transactionally rebuilds `product_gallery_image` with positions1–10 instead of1–9. The migration copies existing image IDs, product bindings, positions, MIME, bytes and timestamps. The layout records selected existing/uploaded images and their primary/order; it does not convert prices or rewrite historical order snapshots. Existing synthetic migrations/gallery preservation and atomic rollback tests are relevant evidence. They do not establish a deployed Durable Object migration or production recovery.

The previous schema11 application rejects a schema12 database. Reverting JavaScript alone is therefore not a verified rollback. Before any release, review the exact artifact/migration and rehearse against an isolated copy of representative existing data. Preserve a recoverable pre-migration database and the current database. A rollback must use an explicitly reviewed schema-compatible application or restore into an isolated data space with reconciliation of all orders/writes since the backup. Do not restore over newer orders, discard image/layout data, silently truncate position10, or invent a downgrade migration. Durable Object routing/cutover, off-host recovery and owner approval remain separate release gates.

## Validation attribution

The initial preflight at `4d02572` ran159tests:127passed,31failed to start their loopback HTTP fixtures with sandbox `EPERM`, and one failed because the extracted Seller payload fixture omitted `productId`. The31listener errors are environment-blocked checks. Their application assertions did not establish either PASS or product failure.

The fixture repair supplies the handler's captured product ID and current revision, advances that revision after a real successful API save, and preserves the monetary/historical-snapshot assertions. Negative price/activation edits must report `COMPANY_CURRENCY_CONFLICT`; currency relabelling must report `INVALID_INPUT`, preventing stale-revision errors from masking the business-rule assertions. All four owner-constraint tests pass in the current default execution mode.

The parent independently closed the finite local criterion94 scope24/68 against `4d02572` plus the corrected evidence package. Historical pending-review artifacts remain unchanged. Overall QA remains the bounded100-item inventory with its recorded90PASS/1FAIL/9UNVERIFIED; deployed acceptance remains unverified. Native Share/clipboard, physical installed PWA, cancellation policy, production tenants and operations retain their limits. Payment/courier automation is outside the original18-item MVP and does not block review of this repair.

The preparation package records the final allowed aggregate attempt, exact Git HEAD and any uncommitted patch separately, source/evidence hashes, original failure attribution and any permission blocker. No unchanged heavy browser suite is repeated for this test/documentation-only preparation. No push, PR, merge, deployment or migration is performed.
