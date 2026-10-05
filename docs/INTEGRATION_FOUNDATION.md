# Courier and messaging integration foundation

Local preparation, 2026-10-02. Branch `codex/integration-foundation-local` starts from owner-merged PR #16, main `5966ca8626c6c75e8e0ec4e34488a7c47fa29376`. The B Seller design remains on its separate local branch at `1b53f8d23dc77de86ec173d7155036101c264baf`. This branch is not published or deployed. Both branches currently label their separate Seller candidate v82; combine/rebase and assign a new version before any exact-artifact release review. Customer remains v105.

## Boundaries and ownership

`app.js` owns the existing single-store Seller session. GET `/api/v1/seller/integrations` is authenticated, read-only and `no-store`. It exposes the public capability catalog, no account IDs, secret references or credentials. All four providers show **NOT_CONFIGURED**, no enabled capability, no dispatch, no connect/QR/send/create-shipment action. Company Settings adds seven-language status cards with loading/retry and stale-response identity checks. This does not install a tenant authentication system.

`demo-sandbox.js` owns fictional company membership. GET `/api/v1/demo/companies/{id}/integrations` uses the existing `companyFor` gate; foreign and unknown companies return the same 404. The status read cannot grant access to the ordinary Seller API.

`createSyntheticIntegrationLedger` is a separately opted-in domain prototype. It requires `mode: SYNTHETIC` and fictional company identifiers. It is not imported by application startup, not added to `db.js` migrations, and not attached to HTTP writes, webhooks, scheduled jobs or a dispatcher. The existing schema version remains 11. Tests open isolated in-memory Stores. The Store API is shared with Node SQLite and SQLite Durable Objects; this prototype has not been executed against a real Durable Object or PostgreSQL.

## Implemented offline behavior

- Company-bound connections include provider, explicit environment, unique provider account binding, a reference-only secret location and a database constraint keeping status NOT_CONFIGURED. A synthetic operation requires the SYNTHETIC environment. Sandbox/production bindings remain disabled. SPX and unofficial QR paths reject operations pending contract/risk review.
- Shipment intents retain immutable fictional recipient/address and parcel snapshots. Message intents require explicit consent metadata, an open 24-hour service window for text, or an approved-template flag. Those flags/timestamps are synthetic inputs; a live adapter must obtain approval and consent evidence from trusted server records, never a client claim.
- Intent, request hash/idempotency record and outbox insertion are one transaction. Same company/connection/key returns the prior operation; changed content conflicts. The same key in a different company is independent. Composite company foreign keys protect the persistence boundary.
- Synthetic attempts use bounded leases and at most three safe retries. Unknown outcomes and expired leases enter RECONCILE. They cannot be resent until an explicit synthetic reconciliation result reports absence. Stale lease tokens cannot finalize another attempt. A production reconciler would need provider lookup evidence and its own audit/authorization.
- A completed message's identical same-key retry still returns its stored outcome after the service window closes. Current-time consent/window policy runs only for new intents; changed content still conflicts. Independent review reproduced the original policy-before-replay error and the candidate fixes it.
- A synthetic inbox validates the bound account, deduplicates event identifiers, conflicts on changed content, and commits inbox/projection together. Older synthetic sequence numbers are retained without regressing the projection. **Sequence is an internal fixture contract, not a claim that any courier supplies monotonically ordered events.** Real mappings, equal-timestamp ambiguity and lifecycle transitions require the official provider contract.
- Event projections touch no shopping order, payment, currency or historical price snapshot. There is no outbound network transport or credential resolver.

## Public contract evidence

Ninja Van's [official API documentation](https://api-docs.ninjavan.co/) links the public [OpenAPI document](https://api-docs.ninjavan.co/static/media/orderapi.eeb602efc469008e7758.yaml), inspected 2026-10-02. It specifies separate sandbox/production tokens, Singapore's `/sg` sandbox path even for Malaysian address tests, OAuth `/2.0/oauth/access_token` and order creation `/4.2/orders`. The transport-free helper permits only fixed official MY/SG locations. It does not construct a complete provider order payload or request a token.

Inspected OpenAPI bytes SHA-256: `5f8775949219a2cccab4a08e877ff8f5896fbec20fdfcc0f11dae07394707c25`. The source was read publicly; no third-party specification copy is committed.

The same contract specifies raw-body HMAC-SHA256 with base64 encoding in `X-Ninjavan-Hmac-Sha256`, and a 3-second webhook timeout. The tested verifier compares bounded raw bytes in constant time; there is no webhook endpoint. A future ingress must resolve the company/account from a trusted binding, verify first, persist the inbox before acknowledgement, then defer processing. Production access requires the provider's integration review. No sandbox or production API was called.

SPX's [official Malaysia VIP page](https://spx.com.my/en/vip-delivering-trust-at-speed.html) advertises API integration but supplies no API contract here. Its disabled catalog entry has no assumed endpoints, authentication scheme or payload. Obtain the official private account contract before writing an adapter; Shopee marketplace APIs cannot substitute for it.

Meta's [official service-message documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages) describes the customer service window. Its [Business App onboarding documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) describes official coexistence onboarding through Embedded Signup. Search returned the v2 deprecation warning for 2026-10-15; the full page was access-limited in this environment, so onboarding version details need a fresh official check before implementation. This branch implements no OAuth/Embedded Signup, template synchronization, Meta webhook or consumer WhatsApp pairing.

The unofficial QR option is a disabled research placeholder. If later authorized, isolate a tenant-specific stateful Node sidecar, require explicit risk acknowledgement and independent session encryption/revocation/reconnect review. Never silently substitute it for the official provider or reuse another application's live WhatsApp session.

## Verification and release gates

Local targeted tests cover account/company negatives, unexpected secret fields and references, live-environment refusal, atomic fault rollback, duplicate/change conflict, snapshot immutability, leases/unknown outcomes/reconciliation, bounded retry, inbox duplicate/out-of-order handling, consent/window/template checks, fixed host selection and raw signature encoding. Ordinary application startup and status reads create no integration tables. The browser status payload is never stored by the PWA cache.

Code checkpoint: `562a6cc6e6670cfc1d40d687bc33cf20374f6c31`. Final code regression: **154/154**, Node 24.19.0, one worker; the integration file contributes 12 tests. Syntax, diff whitespace and nonpublishing Worker dry run with **744 assets** passed. Initial sandbox-only full execution could not open loopback listeners; approved local execution passed without changing assertions. The post-review replay fix was reverified with the complete suite.

Independent security and PWA/status reviews cleared this exact code checkpoint. The security reviewer independently reproduced and closed the delayed-message replay defect, checked company/foreign operation/lease/inbox negatives, and used a real shopping-schema fixture to prove stored order/delivery/item/audit/idempotency snapshots and a payment-fixture balance were unchanged. The PWA reviewer verified source/assets, seven actual-module DOM checks, and all three recaptured screenshot pixels. Reports remain in ignored local `output/review-security/integration-review.md` and `output/review-pwa/integration-review.md`. Clearance covers this offline foundation only; production and live-provider limits remain open.

Actual browser: one existing Chromium session, 21 width/language combinations (320/390/1440 × seven locales), four unconfigured providers and no overflow. Held late 401 after route departure was ignored. PWA cache contained no API paths and no unhandled page errors occurred. One console HTTP 401 was deliberately injected for that negative test. Independent PWA/status source review also ran seven actual-module DOM checks for stale success/error/401, changed identity during JSON parsing, retry races, copy and payload semantics. Source review and pixel review are distinct from physical-device certification.

Screenshots below are the actual synthetic Company Settings component at this code checkpoint. Mobile images use a taller 390px viewport to capture the whole component without the sticky header covering its heading. They are not a soft-keyboard or installed-PWA proof. The signed-in fixture uses fictional identity and an in-memory database. It was signed out and its browser session closed; only its own preview PID was stopped, with shared browser binaries preserved.

| Capture | File | Library file |
| --- | --- | --- |
| Desktop, English, 1440px | [Screenshot](assets/integration-status-1440-en.png) | `libfile_4f786cfae6348191af78c6a63ffbfc0d` |
| Mobile, English, 390px | [Screenshot](assets/integration-status-390-en.png) | `libfile_7a7b984584ec8191b3d382d275da4c1c` |
| Mobile, Chinese, 390px | [Screenshot](assets/integration-status-390-zh-Hans.png) | `libfile_9ff09a07e2288191b1ecce748e39f153` |

Library creation confirmed all three images with matching local sizes and receipt attributes. `offlineFoundation: true` denotes availability of this shared synthetic framework; it does not certify a provider adapter. `sandboxVerified`, `providerApproved` and `liveAccepted` remain false for every provider.

Before credentials: tenant API/grant design and durable production repository, official private SPX contract, complete public provider request/response mapping, approved Meta/QR onboarding choice, dispatch retry classification, signed ingress/account matching, revocation/reconciliation audit, secure label/media retrieval with fixed allowed hosts and redirect policy. No label/media URL is fetched in this phase.

Then distinguish offline test evidence, sandbox verification, provider approval and authorized live acceptance. None implies the next. Exact reviewed release, migrations/backup/rollback and owner approval remain mandatory. No real messages, shipments, payments, grants, pairing, provider secrets or credentials were created.

Payment/courier automation remains an extension outside the original **18 MVP** denominator. Historical local baseline stays 16/18, production released 0/18. AC-16 operations and AC-17 physical installed-PWA verification remain open; see [PRODUCTION_ACCEPTANCE.md](PRODUCTION_ACCEPTANCE.md). The B design and this integration prototype do not close production tenant isolation.

## Knowledge preflight

Current project KB and exact source records were read before this phase. Existing UI/privacy/release notes were compared with current source and acceptance docs. The reuse service returned no applicable integration prior art; broad earlier matches belonged to other projects and were rejected. Its runtime preflight-validation evidence was unavailable despite the supplied source/relationship/business-rule/risk report. Following the repository/global AGENTS rule that unavailable KB evidence blocks only dependent work, this credential-free phase uses verified local source and official public contracts. No claim of a successful automated engineering-preflight gate is made.

Source baseline: `5966ca86`; relationship paths: authenticated API → public catalog and fictional membership → scoped catalog; Store → explicitly synthetic ledger. Unresolved assumptions are listed above rather than filled with guessed provider behavior.
