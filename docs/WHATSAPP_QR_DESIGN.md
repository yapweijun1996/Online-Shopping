# WhatsApp readiness audit and isolated QR reply module

Audit/research date: 2026-10-20. Repository: `/Users/yapweijun/Documents/GitHub/Online-Shopping`. Read-only investigation; no repository edits, dependency installation, git mutations, real credentials, provider sends or deployment changes. This document is a design, not implementation approval or seller risk acceptance.

**Decision:** retain Cloud API as the supported integration. It is substantially implemented and locally exercised, but the GCP configuration is not ready for credentials alone: it lacks an integration-key mount and backend internet egress. Repair the known inbound routing/privacy defects before live use. For the requested alternative, use an independently deployed, default-off, single-tenant Baileys worker for human replies, not Chromium inside the backend. Buyer-initiated conversations reduce unsolicited-message risk; they do not make an unofficial client compliant or protect its number from bans.

Evidence vocabulary: **Observed** = current source or executed local scenario; **Research** = linked public source inspected/searched on the date above; **[INFERENCE]** = consequence of source/configuration, not an observed deployment failure; **UNVERIFIED** = external behavior, performance or account condition not established here. Source paths below are repository-relative. Line numbers refer to the working copy, not historical review permalinks.

## A. Official Cloud API audit and go-live checklist

### A1. What exists and what was exercised

| Area | Observed implementation and limits |
| --- | --- |
| Credential connection | `src/integration-connections.js:17-32,54-99`: strict four-credential input plus environment, fixed numeric IDs, provider verification before persistence, transactional sealing/audit, write-only secret fields, masked token hint. `SANDBOX` and `PRODUCTION` are separate rows. The labels do not select separate Graph hosts. |
| Encryption | `src/secret-box.js:13-62`: AES-256-GCM, random 12-byte IV, context-bound AAD, 32-byte keys, active key first in the file, key IDs and resealing. Existing Cloud context is only `WHATSAPP_CLOUD:<environment>`; database isolation is not cryptographic tenant binding. Individual plaintext seal limit is 8192 characters. |
| Verification and sending | `src/whatsapp-transport.js:1-78`: Graph `v21.0`, fixed `https://graph.facebook.com`, bearer header, manual redirects, 10-second timeout, 16 KiB response cap. Verification GET reads phone display/name; send POST uses `/<phoneNumberId>/messages`. Verification success is not a complete onboarding check. |
| Order-message production | `src/whatsapp-outbox.js:13-75`: polls order events, four fixed templates, opted-in orders only, production shop setup only, newest eligible events within six hours and after initial connection creation. Production connection wins over Sandbox. Unique event key prevents duplicate queue insertion. Order handlers do not send to Meta. |
| Delivery worker | `src/whatsapp-outbox.js:86-176`: atomic claim, network outside transaction, two-minute lease, bounded preparation retry, accepted/rejected/unknown outcomes. Timeout, network errors, 429/5xx or unusable responses become `RECONCILE`, never automatic resend. Active tenant stores are visited serially; maintenance pauses subsequent work. |
| Inbound | `src/whatsapp-inbound.js:18-91`: verify-token subscribe challenge; raw-body HMAC before parsing/persistence; 256 KiB cap; receipt-body SHA-256 dedupe plus message-ID dedupe; phone-ID filtering; monotonic delivery status helper; text-only reply storage. Unknown contacts can be stored with no order. |
| Seller access | `src/app.js:280-334` and capability checks: authenticated reads; Owner connection management; Origin/CSRF on mutations; limited lists and rate-limited connection checks. Missing master key and passwordless sample mode fail closed for management. `src/server.js:94-98` does not start an unsupported worker. |
| Seller interface | `public/seller/whatsapp-connection.js:17-166`: callback/verify-token copy, password inputs, clear secrets after successful mutation, stale-session guards, localized errors and connection status. `public/seller/messages.js:54-240`: unread badge, read marking, order links, attention list, explicit duplicate-risk confirmation on resend. Text uses `textContent`. **There is no free-text reply composer or official reply-send route today.** |
| Synthetic foundation | `src/integration-*.js` contains contracts, fixtures, synthetic ledger/consent/ingress, with some shared helpers reused by Cloud. Do not mistake synthetic demos for the production sender or add a second production pipeline accidentally. `src/message-plan.js:11-17` is referenced by tests, not the live worker; its key is `<order>:ORDER_CONFIRMED`, whereas the live outbox uses `<order>:CONFIRMED`. It is not evidence of a live integration hook. |

Executed, with network-free fixtures and in-memory SQLite, using Node 24.21.0:

```text
env -u SHOP_TEST_DATABASE_URL NODE_ENV=test \
  /opt/homebrew/Cellar/node@24/24.21.0/bin/node \
  --test --test-concurrency=1 \
  test/integration-connections.test.js test/whatsapp-outbox.test.js \
  test/whatsapp-inbound.test.js test/seller-whatsapp-api.test.js \
  test/whatsapp-connection-ui.test.js test/integration-keys.test.js

67 tests; 64 passed; 0 failed; 3 PostgreSQL cases skipped.
```

Coverage exercised: sealing/context refusal, rotation and rollback, malformed credentials, response caps/timeouts, origin/CSRF/session denial, quick-login/no-key denial, local UI fixture behavior, signed webhook acceptance and tampering/replay rejection, consent withdrawal, outbox claims/concurrency, unknown outcomes, lease expiry, active-tenant serial processing and maintenance pause. One deliberate failing-tenant fixture prints `WhatsApp tenant worker failed: Error`; suite passes. Existing source-string UI tests are not browser proof. No real browser, running Caddy, live PostgreSQL, internet egress or actual Meta account was verified. Full-suite/production readiness is not claimed.

A separate inline smoke invoked the actual connection store and `receiveWhatsAppWebhook` with two synthetic connections sharing an App Secret and a correctly signed Sandbox text event. Actual output:

```json
{"result":{"outcome":"processed","statuses":0,"messages":0,"skipped":1},"inbound":{"n":0}}
```

This confirms B08 locally without writing a probe file or changing the repository.

### A2. Findings and readiness blockers

1. **GCP missing integration key wiring — functional blocker.** `compose.gcp.yaml:25-43,86-93` supplies only administrator and database secrets, no `INTEGRATION_KEY_FILE`. `src/config.js:112-117` leaves keys null when omitted; `src/app.js:287-296` returns unavailable/refuses configuration; `src/server.js:94-98` does not start the worker. `docs/GCP_DEPLOY.md:9` explicitly documents this intentional opt-out. Owner credentials alone cannot activate Cloud. A reviewed protected configuration/controller-policy change must mount a host-generated key file and set the variable.
2. **GCP backend lacks outbound network — functional blocker [INFERENCE].** `compose.gcp.yaml:43,94-100` attaches the backend only to `private`, declared `internal: true`; only frontend is on the external edge. Docker internal networking does not provide normal internet egress. Cloud verification/send calls originate in backend, not frontend. Add a deliberately configured egress network/proxy/firewall path for backend HTTPS/DNS without published backend ports or granting it access to the trusted edge network. Verify from the actual deployed network before go-live; no live connectivity probe was made here.
3. **B08 remains open and reproduced.** `docs/CODEBASE_BUG_REVIEW.md:171-181` and threat-model sections 3/7 say open. Current `src/whatsapp-inbound.js:32-38` returns the first signature-matching connection; `src/integration-connections.js:127-129` sorts environments; `src/whatsapp-inbound.js:49-57,61-75` filters exclusively against that phone ID and records the receipt. Shared App Secrets make Production win and Sandbox events vanish with HTTP 200; receipt dedupe then suppresses replay. Repair by authenticating the app once and dispatching each signed event by authenticated phone/account identity to the correct connection, including mixed-phone batches; do not simply reverse the sort. Until fixed, keep only one connected environment for an app in a shop and avoid relying on mixed deliveries. Tenant callback fan-out also needs an explicit account-to-tenant routing strategy; a prefix alone does not cause Meta to deliver each phone to a different callback.
4. **B09 privacy gap remains in code.** `src/whatsapp-inbound.js:75-84` associates by historical recipient hash without checking `shop_order.contact_erased_at`; `docs/CODEBASE_BUG_REVIEW.md:183-197` describes late text repopulating an erased order and repeat erasure being refused. Fix the ingress/erasure contract before live personal replies; deletion once is not a retention policy.
5. **Connected is a partial check, not readiness.** `src/integration-connections.js:57-59` passes only access token and phone ID to `verify`; `src/whatsapp-transport.js:45-64` never proves WABA ownership, App Secret correctness, app subscription, token messaging permissions, approved templates, billing or number registration. A syntactically valid wrong App Secret/WABA can be stored with `CONNECTED`. Document this or expand readiness checks in a separate job. Never show it as end-to-end verified.
6. **Delivery race and misleading reconnect cutoff.** `src/whatsapp-inbound.js:63-65` drops receipts with no persisted provider message ID; sender writes that ID only after Meta returns (`src/whatsapp-outbox.js:124-129`). A fast receipt can be lost. Queue cutoff uses connection `created_at` (`:41-51`), but reconnect upsert preserves it (`src/integration-connections.js:86-91`): eligible events from a recent disconnect can queue, contrary to the plan's “no backlog after a reconnect.” Six-hour cutoff still bounds it. Disconnect cannot recall an already in-flight send; documentation promising immediate cessation must say so.
7. **Thread association is heuristic.** `src/whatsapp-inbound.js:75-76` picks latest outbox entry for a recipient, not a verified buyer-selected order; queued/failed entries can qualify. Multiple orders or shared phone numbers can produce the wrong order link. Keep “suggested order” distinct from confirmed association in a reply UI.
8. **Documentation drift.** `README.md:37` prohibits automatic WhatsApp and unofficial Web automation despite implemented Cloud messages. `docs/WHATSAPP_IMPLEMENTATION_PLAN.md:3` says nothing implemented, while its slices say done; owner section says three templates but table correctly lists four. `docs/WHATSAPP_GO_LIVE.md` is OrbStack/sample-site-specific and marks vendor claims assumed. Its blanket business-verification requirement and approximate approval timing are not established for every account. Update it for GCP and account-specific Meta dashboard requirements, not as universal promises. Historical threat-model “no endpoint today” wording is stale relative to implemented webhook.

### A3. Exact owner inputs and callback forms

**Infrastructure, supplied on host, never in chat/Git:**

- Integration master-key file: one `keyId=base64key` per line, canonical base64 of **32 random bytes**, first key active (`src/secret-box.js:13-29`). Mount read-only as a Docker secret, for example `/run/secrets/integration_keys`; set `INTEGRATION_KEY_FILE` to that exact mount. Back up separately from database; test restore and resealing before dropping old keys. File must be readable by the non-root backend user, not exposed via public mounts.
- Correct `PUBLIC_ORIGIN=https://demoonlineshopping.xyz`, `SELLER_ORIGIN=https://seller.demoonlineshopping.xyz`, production business shop setup, password login and `SELLER_QUICK_LOGIN=0`. `SHOP_MODE=manual` is compatible; actual `shop_setup.mode` must be `production`, not demo. GCP currently disables platform routing.
- Working DNS/TLS/gateway, controlled backend HTTPS egress, matching database schema and an authorized manual deployment/policy update. Backend health alone does not prove integrations ready.

**Four fields pasted into Owner → Settings → WhatsApp connection:**

1. `accessToken`: Meta system-user access token assigned to the correct WABA/phone assets. Obtain permissions `whatsapp_business_messaging` and `whatsapp_business_management` appropriate to the application and verify actual granted scopes/assets. Long-lived does not mean irrevocable; monitor expiry/revocation. Meta temporary development tokens are test-only.
2. `appSecret`: **Meta developer app App Secret**, not verify token, app ID, phone PIN or business ID.
3. `phoneNumberId`: Meta Graph **Phone Number ID**, numeric object ID, not the international phone digits.
4. `businessAccountId`: WhatsApp Business Account **WABA ID**, not Meta Business Portfolio ID.

Also prepare a WhatsApp-enabled business app, appropriate phone registration/display name, test recipient allowlist when using a Meta test number, dashboard-required verification/access/billing, and app subscription to the WABA `messages` webhook field. Phone registration PIN/onboarding may be required in Meta; the repo has no onboarding/PIN workflow and does not ask the owner for it. The application generates `verifyToken` after connection; copy it to Meta's webhook verification field. It is not the App Secret and does not authenticate POSTs.

| Deployment | Callback |
| --- | --- |
| Current GCP default shop | `https://demoonlineshopping.xyz/api/v1/webhooks/whatsapp` |
| Generic default | `<PUBLIC_ORIGIN>/api/v1/webhooks/whatsapp` |
| Platform-enabled tenant with code `abc` | `<PUBLIC_ORIGIN>/abc/api/v1/webhooks/whatsapp` |
| Seller-host equivalent, where tenant edge routing exists | `<SELLER_ORIGIN>/abc/api/v1/webhooks/whatsapp`; prefer the returned shop-host URL |

Tenant prefix is `/<code>`, **not `/t/<code>`** (`src/platform/registry.js:43-45,92-99`); tenant request rewriting removes that prefix before the handler. `src/app.js:290` constructs the URL using public origin and tenant `basePath`. Current GCP has `PLATFORM_ENABLED=0` and no prefixed API proxy; **prefixed variants are not supported on this deployment** until deliberate platform/edge enablement. Default seller-host `/api/v1/webhooks/whatsapp` is forwarded too, but use the canonical URL returned by the Owner API.

**GCP Caddy route answer:** yes, at the tracked application Caddy layer, unprefixed GET and POST reach backend on **both SHOP and SELLER hosts**. `deploy/gcp/Caddyfile:25-31` rejects seller/demo/platform/prefix-private shop paths, then `:32-35` proxies `/api/*`; the webhook is not excluded. Seller private matcher `:67-74` blocks customer order paths but not webhook; `:75-78` proxies `/api/*`. No webhook-specific route needs adding for the unprefixed path. Top-level `/<tenant>/api/...` matches neither API block and falls through to 404. This file is HTTP behind the separate shared TLS gateway, not the root gateway's installed configuration. `docs/GCP_DEPLOY.md:7,25` requires both TLS hosts to forward preserving Host to `online-shopping-frontend:80`; the actual root Caddy configuration/DNS was not inspected and public delivery remains **UNVERIFIED**.

**Template contract** (`src/whatsapp-outbox.js:13-33`): Utility classification/approval must be obtained from Meta, not assumed from the names. `order_submitted`, `order_confirmed`, `order_rejected` each require body variables buyer name then order number; `order_shipped` adds carrier then tracking number. Exact language codes: `en`, `ms`, `zh_CN`, `vi`, `th`, `ja`, `ko`. Create/approve each language actually offered to buyers; arbitrary locale falls back to English. Verify current Graph v21.0 availability and template API requirements against current Meta documentation/dashboard before enabling; **API-version support/end-of-life not independently confirmed here**.

### A4. Go-live gates, in order

- [ ] Review/fix B08 and B09; add mixed-phone/shared-secret and late-erasure regressions. Keep historical bug status accurate after verification, not merely after an edit.
- [ ] Approve GCP key mount, outbound networking and controller-policy changes manually; no assumption that protected compose/secrets changes auto-deploy. Keep backend/Postgres unpublished and proxy-header boundary unchanged.
- [ ] Confirm actual VM RAM/free headroom: this task specifies 2 GiB/2 vCPU, but `docs/GCP_DEPLOY.md:3` says e2-micro **1 GiB plus 2 GiB swap**. Swap is not physical RAM. No host inspection performed.
- [ ] Provision/restore-test master keys and database backup; ensure available disk, non-root secret readability, no secret output in logs.
- [ ] Exercise shop/seller TLS and webhook routing through real gateway; unsigned POST must return 401 and store nothing; wrong verify token 403. Do not put secrets in a probe transcript.
- [ ] Owner logs in with password, confirms production shop setup and connects Sandbox with controlled test number. No simultaneous same-app Production until B08 is fixed. Missing-key availability must now become true.
- [ ] Configure exact callback plus generated verify token; Meta must complete subscribe challenge and `messages` subscription. Prove App Secret by real signed inbound; connection status alone cannot do this.
- [ ] Re-check Meta scopes/assets, registration, billing, restrictions, template approvals, language codes and Graph version. Test number success is not production permission.
- [ ] Create opted-in order to owner-controlled allowlisted recipient: inspect one accepted send and actual handset receipt, then delivery/read status (read only if supported/enabled). Confirm/reject on separate applicable orders, and ship; confirm exact four-template contract and locale parameters.
- [ ] Reply from handset: verify inbox, unread/read and order association, including unmatched buyer and multiple-order cases. Confirm retention notice and erased-contact behavior before real buyer data.
- [ ] Simulate definite rejection with a test template/configuration; recover intentionally. Lost/ambiguous outcome stays `RECONCILE`; seller checks handset before any resend. Do not “test” duplicate safety by resending to buyers.
- [ ] Disconnect/restart drill: no new claims, encrypted state restore, no surprise replay; document possible in-flight send and bounded preparation retries for queued rows. Check token rotation/hash continuity, key rotation and privacy cleanup.
- [ ] Only after the above, connect production number and do one owner-controlled production send/receipt/reply. Record deployment revision, time, redacted evidence and rollback steps. Disconnect is local credential removal, not guaranteed remote token revocation; revoke in Meta as needed.

## B. Unofficial Node.js route research

### B1. Maintained candidates and resource fit

All URLs accessed/researched 2026-10-20; release dates below are upstream published timestamps, not inferred from search age. Maintenance activity does not imply WhatsApp authorization or a support SLA.

| Candidate | Evidence, pairing and persistence | Runtime fit |
| --- | --- | --- |
| **WhiskeySockets Baileys** | [Upstream](https://github.com/WhiskeySockets/Baileys), MIT. [Release v6.7.24](https://github.com/WhiskeySockets/Baileys/releases/tag/v6.7.24), published **2026-07-29**, commit `e0629940ee2d335b0c0119367fd2a934e0fa3189`; [release API timestamp](https://api.github.com/repos/WhiskeySockets/Baileys/releases/tags/v6.7.24). Release feed also exposes v7.0.0-rc14: active but major-version breaking changes, not evidence that every branch/version works today. QR is emitted by connection events, seller scans in WhatsApp Linked devices, and the session becomes an authenticated multi-device socket. Persist credentials and Signal key changes, not just a QR or access token. [Session-management guide](https://baileys.wiki/authentication/session-management) explicitly says `useMultiFileAuthState` is not production storage; [socket config](https://baileys.wiki/concepts/socket-config) requires auth credentials plus Signal key store. | WebSocket/protocol client, **no Chromium**. [Exact package metadata](https://registry.npmjs.org/@whiskeysockets%2fbaileys/6.7.24) says Node >=20, ESM, 12,885,764 unpacked bytes; disk bytes are **not RSS**. No trustworthy measured RAM baseline for this workload was obtained: **UNVERIFIED**. Lighter architectural fit than browser automation [INFERENCE], but key/history caches can still exceed a small container. |
| **whatsapp-web.js** | [Upstream](https://github.com/wwebjs/whatsapp-web.js), Apache-2.0; [v1.34.7](https://github.com/wwebjs/whatsapp-web.js/releases/tag/v1.34.7) published **2026-04-24**, [timestamp](https://api.github.com/repos/wwebjs/whatsapp-web.js/releases/tags/v1.34.7). README supports multi-device and Node >=18; exposes `qr`, `ready`, `message`. [Authentication guide](https://wwebjs.dev/guide/creating-your-bot/authentication.html): default NoAuth loses session; LocalAuth retains Chromium profile (including history) in persistent directory; RemoteAuth backs up remotely and `ready` is not proof session saved (separate saved event, roughly a minute in guide). | Puppeteer plus Chrome/Chromium, browser subprocesses and profile data; broader resource/security footprint. Exact RSS and startup peak **UNVERIFIED**, not a defensible fit inside the existing 256 MiB backend. Guide suggests no-sandbox flags for headless systems; do not weaken this deployment to accommodate that recipe. Not selected for the shared VM. |

**Recommendation:** candidate `@whiskeysockets/baileys` **exactly `6.7.24`**, in its own package/lockfile and worker image only, subject to compatibility/security gate. Do not silently substitute package `baileys`, a fork or the v7 release candidate. The upstream README now points at the unscoped npm package, while the scoped 6.7.24 registry metadata identifies the same upstream commit; package-name migration and 6.x protocol viability must be checked in the dependency spike. This is an exact review candidate, **not a claim of live compatibility**. If it cannot pair reliably, stop the release and review another exact pin instead of following `latest` at runtime. `whatsapp-web.js@1.34.7` is the researched fallback candidate only for a separately budgeted browser host, not a second adapter to build now.

### B2. Terms, policy and community evidence

- **Primary terms:** [WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service). The fetch exposed only page metadata, not full clause text; exact current clause wording/effective date is **UNVERIFIED**, and no quotation is invented.
- **Primary unofficial-client policy:** [About unofficial apps](https://faq.whatsapp.com/general/security-and-privacy/about-unofficial-apps) (redirects to [current help article](https://faq.whatsapp.com/1217634902127718)). Search-index text explicitly states linking accounts to unofficial versions violates Terms of Service; fetched article body was not available. Access date 2026-10-20; article publication date **UNVERIFIED**.
- **Primary automated/bulk policy:** [Unauthorized use of automated or bulk messaging](https://faq.whatsapp.com/5957850900902049). Search-index text says products are not intended for bulk or automated messaging and that these violate terms. Access date 2026-10-20; publication date **UNVERIFIED**.
- **Business messaging constraints:** [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy?lang=en_US): indexed policy text permits non-template replies within 24 hours of the last user message; outside that window use approved templates on the official platform. Opt-in and honoring opt-outs still matter. An order is not, by itself, general permission to contact anyone forever. Applying a 24-hour window to QR is a conservative product restriction, **not permission to use an unofficial client**.
- **Maintainer warning:** [whatsapp-web.js README](https://github.com/wwebjs/whatsapp-web.js#disclaimer) expressly says unofficial clients/bots are not allowed and blocking is not prevented. [Baileys disclaimer](https://github.com/WhiskeySockets/Baileys#disclaimer) disclaims affiliation and discourages spam, stalking, bulk and automated use.
- **Dated community report:** [Baileys #1245](https://github.com/WhiskeySockets/Baileys/issues/1245), **2025-02-05**, reporter says number banned after new connection/QR and 503/403; maintainer responds “expected.” Another commenter describes connection failure without a ban. This establishes reported failures, not an independent causal finding or ban frequency.
- **Additional report:** [Baileys #1850](https://github.com/WhiskeySockets/Baileys/issues/1850), indexed **2025-10-01**, reports restriction within two hours of linking while handling hundreds of conversations. Date/details are search evidence, not independently reproduced. It is not comparable to low-volume human seller replies.

**Seller-facing truth:** the seller's actual number may be temporarily restricted or permanently banned even when buyers message first and every portal reply is human-written. Dedicated spare number, low volume and opt-in reduce some abuse triggers; none eliminate unofficial-client enforcement, guarantee appeal/recovery, or make the operator compliant. Do not advertise “safe QR,” “ban-proof,” or a numerical ban probability. Owner acceptance does not waive WhatsApp's terms or recipients' rights.

### B3. Supply chain and dependency acceptance

The exact [6.7.24 npm metadata](https://registry.npmjs.org/@whiskeysockets%2fbaileys/6.7.24) reports MIT, upstream commit above, GitHub Actions OIDC trusted publisher, npm signatures and a SLSA-v1 provenance URL. **Presence observed; cryptographic verification not performed.** Reported tarball integrity:

```text
sha512-Ljq7si+gsNIE9d5dP69E99TTQp+BxxPgitWvmZMXExGc1Ctr0SCDLFZmxRLUDC5HB0/Itw5uk+HJeBONrLP99Q==
```

It also declares `libsignal` as a Git URL without an explicit commit in its manifest, caret-range dependencies, installation hooks and a `sharp: "*"` peer that is not marked optional. A top-level exact pin is insufficient: resolve and audit every transitive dependency, Git commit, peer/native artifact and lifecycle script in the committed worker lockfile. Review whether sharp is actually required for the text-only installation; do not assume all media dependencies are optional. Verify Node 24 and target Linux architecture before approval.

Do not install look-alike forks to solve setup errors. [GitHub malware advisory GHSA-r58r-8rfq-ff52](https://github.com/advisories/GHSA-r58r-8rfq-ff52), published **2026-09-30** according to indexed advisory, concerns `spencer-baileys`; [GHSA-vcwh-7gr6-f894](https://github.com/advisories/GHSA-vcwh-7gr6-f894), **2026-10-02**, concerns `@celestial-community/baileys`. These are evidence of malicious related package names, **not evidence the official scoped package is compromised**. Advisory contents were search-index evidence, not downloaded malware inspection.

Acceptance: isolated dependency spike; verify registry signature/provenance against repository/workflow/commit; review release diff including the unusually sparse 6.7.24 revert release note; inspect scripts; reproducible `npm ci` with reviewed script policy; lock full graph; record SBOM/licenses/audit and image digest; no production-host npm install, floating Git branch, CDN QR generator, dynamic protocol/package update or unattended upgrades. `npm audit` alone does not prove absence of malware. Update via reviewed PR and fake-transport regression suite. Justification under `AGENTS.md`: implementing WhatsApp multi-device cryptography/protocol in-house is substantially riskier than a maintained specialized library; keep this necessary dependency out of the two-dependency backend. QR rendering also needs a reviewed local encoder or vetted vendored asset with exact version/hash/license; choose and pin in the dependency spike rather than making up an unverified encoder pin here.

## C. Design — isolated, default-off human reply module

Everything in C is **proposed**, not current behavior. This replaces the older QR design in `docs/INTEGRATION_DESIGN.md:6.4`, which proposes automated templates and enabling QR on the passwordless sample site. Neither is appropriate for this human-reply module.

### C1. Boundary, process and activation

```text
Seller HTTPS portal -> existing seller auth/capability/Origin/CSRF
                    -> integration reply service -> durable command/outbox
                    -> private tenant-bound worker API -> Baileys -> WhatsApp
WhatsApp -> Baileys -> authenticated normalized ingress -> durable inbox/threads
Order state routes -> existing order_event only; never call QR worker/library
```

- Separate non-root container/process **per enabled tenant**, not in `src/server.js`, not inside the 256 MiB backend and not one shared Baileys process holding every tenant key. Initial VM supports **one active QR tenant/session total** pending measurement; further shops are capacity-gated, not silently multiplexed. Do not expose Docker socket to dynamically provision workers. Operator provisions fixed worker instances/tenant bindings.
- Global `WHATSAPP_QR_ENABLED=0` default, plus per-shop mode/acknowledgement and an operator capacity allowlist. No worker container when disabled; backend must not import the Baileys dependency. Refuse all QR activation on demo/passwordless sample sites. Existing Cloud operation unaffected by a disabled/failed QR service.
- Backend handles trusted tenant selection/auth; worker accepts only an assigned immutable tenant UUID/connection generation from a fixed authenticated internal client, never a browser-supplied database/path/URL/JID. Bind per-worker credentials to one tenant; no general-purpose outbound proxy or arbitrary `sendMessage` endpoint.
- Use existing integration architecture helpers for validation/status/error/audit conventions. Add production-facing integration reply/QR modules behind that boundary; do not route through `integration_demo_*` synthetic ledger. Order routes remain unchanged.
- Worker gets a dedicated private control link and a reviewed outbound network with DNS/TLS access to WhatsApp, no host ports, Docker socket, platform provisioning credentials or broad application database role. Internal API can be a narrow backend broker: worker fetches only its encrypted auth rows/claimed reply intents and posts normalized events over authenticated requests. Mount only that tenant's session key ring and control token in worker; backend need not expose Cloud secrets to it. Scope backend session-record APIs to worker tenant and connection, not merely bearer-token validity.

### C2. Data model and secret custody

Reuse `integration_connection` for provider `WHATSAPP_QR` (already allowed by PostgreSQL schema at `src/postgres/schema.sql:213-226`) and `integration_audit` for `RISK_ACKNOWLEDGED`/connect/disconnect (already allowed at `:228-236`). Use one QR production connection; do not present Sandbox as a safety guarantee for an unofficial real number. Keep dynamic pairing state separate from the existing coarse connection status enum.

New tenant-database tables, SQLite/PostgreSQL parity, migrations/grants/import inventory/backup contract included:

| Proposed table | Purpose/invariants |
| --- | --- |
| `integration_channel` | One WhatsApp send mode `OFF/CLOUD/QR`, generation/revision, pause flag and transition time. Compare-and-set switches; source of truth for all senders. |
| `whatsapp_qr_session` | Connection ID, runtime state, generation, lease/fence, encrypted credential records and key IDs, last durable update/heartbeat, reconnect/error code. Store credentials and Signal key mutations atomically with version checks; no plaintext session filesystem. |
| `whatsapp_qr_auth_key` | Keyed by connection, generation, Signal category and key identity; encrypted bounded records; exact deletion/upsert behavior. Chunk records exceeding 8192 plaintext characters with authenticated manifest/version and independently bound chunks; never truncate or weaken `secret-box` limits. |
| `message_thread` | Provider/connection, keyed peer hash, sealed canonical peer identifier, first/last inbound time, suppression/opt-out, activity/retention fields. No order required. Unique connection/peer identity with explicit verified alias mappings for WhatsApp LIDs versus phone JIDs. No guessing that every sender identifier is a phone. |
| `message_thread_order` | Explicit validated order associations and attribution `SUGGESTED/CONFIRMED`; many orders per thread, no last-message overwrite. Check tenant and phone match for suggested links; seller cannot bind cross-tenant order IDs. |
| `message_reply_outbox` | Separate human text intents: thread ID, connection generation/provider snapshot, actor, idempotency key, encrypted body/payload, status, attempts/lease, provider message ID, error code and timestamps. Unique tenant intent key plus content digest rejects changed content on replay. |

Keep the existing Cloud `message_outbox` for order-template sends: schema `:246-260` requires non-null order/template and only four order kinds; unlinked customer replies do not fit. **Do not squeeze free text into a template column or fabricate an order.** Existing `message_inbound` can remain the Cloud legacy projection initially; add a normalized thread-message table for QR inbound/outbound with unique `(connection_id, generation, direction, provider_message_id)` and a projection adapter to shared seller views. This avoids current global message-ID uniqueness conflating future providers. Migration must preserve Cloud history without changing existing worker dispatch semantics. Unify reads through the integration message service, not duplicate unrelated UI inboxes. No attempt to reuse Cloud's phone-free reply rows as a sendable address: hashes are intentionally irreversible; QR needs the separately encrypted peer identifier.

Secret contexts: `WHATSAPP_QR:<immutableTenantId>:<connectionId>:<generation>:<recordType>:<recordKey>:<chunkIndex>`, with versioned manifest for chunks. Never tenant display code alone; renaming shop must not lose/declassify keys. Reuse `createSecretBox`, but implement a real transactional Baileys auth-state adapter, including binary/protobuf serialization, key deletion, credential updates and `creds.update`; do not use the development multi-file helper. Serialize per-session updates and durable-ack before advancing worker state. On failed persistence stop the socket; continuing with stale Signal keys risks corruption. Refresh key ring/reseal all auth records safely; keep old key available until verified. No complete account-history cache or initial history import.

Disconnect: stop accepting intents, advance/fence generation, stop worker, attempt remote device logout, remove all local encrypted auth/peer records and active QR material, audit reason/actor without secrets. If remote logout is unavailable, say so and require seller to unlink the device in the official app. Backup copies outlive deletion until retention expiry; restored stale session must not auto-connect without an operator recovery gate. Master-key compromise is account/session compromise; at-rest encryption does not stop a compromised worker with live keys.

### C3. Pairing and seller UI

Proposed tenant-relative endpoints under `/api/v1/seller/integrations/whatsapp-qr`: `GET status`, `POST acknowledge`, `POST pair`, `GET pairing`, `POST disconnect`. Pair/ack/disconnect are Owner-only; all mutation routes require existing session, exact Origin and CSRF. Rate-limit pairing to 3 attempts/15 minutes/shop and 5/IP; return unavailable while global flag off, missing worker/key, quick login or unsupported tenant. Persist acknowledgement actor/time/notice version in `integration_audit` before QR generation.

State machine: `OFF -> IDLE -> PAIRING -> CONNECTING -> CONNECTED`; terminal/session states `EXPIRED`, `LOGGED_OUT`, `ERROR`; transient `RECONNECTING`. Each response carries generation/revision and safe reason codes. Library QR updates replace older values; expose QR only to authenticated Owner for current pairing attempt, local expiry **at most 60 seconds or earlier library replacement**, pairing attempt capped at 2 minutes. Those are product limits, not claimed WhatsApp QR lifetimes. Refresh requires an explicit new pairing request; stop old socket first. Poll status/QR every 2 seconds only while visible/pairing; cancel on logout/navigation. Prefer existing same-origin fetch over introducing a public worker WebSocket or new WebSocket dependency in backend.

Render a locally encoded QR image/canvas, countdown, “Open WhatsApp → Linked devices → Link a device,” status, masked paired number, last sync/error and Disconnect. No raw QR in logs/analytics, no browser persistence, no third-party QR service; APIs `no-store`, seller service worker must not cache QR/API responses. QR is a short-lived pairing credential; account access requires its protection. Clear old QR on expiry, connection, logout, stale generation or session change. Screen-reader status and keyboard-operable refresh/disconnect; test desktop and 390 px. Do not promise same-device scan: a seller viewing portal on their only phone may need another screen; phone-number pairing is out of scope, not a hidden fallback.

Inbox: reuse Messages navigation and order detail surface; show thread text with safe text nodes, provider badge and suggested/confirmed linked orders. Reply textarea is text-only, 1–4096 characters, no media, attachments, canned auto-send, bots, AI auto-replies, bulk selector or broadcasts. A manual press of Send creates one idempotent intent; browser retains exact pending intent only in memory while unresolved and queries intent status after a lost response. Server retains authoritative intent; double-click/reload must not create new sends. Paginated durable thread history; unread/read on server, no private contact data in URLs.

Eligibility enforced **at enqueue and immediately before send**, not just by hiding the button:

- Recipient must be a direct one-to-one customer who sent a live inbound message to this connection, **or** a normalized same-tenant order buyer with current WhatsApp contact opt-in and a recent order (proposed 7 days). An order without consent is not eligible.
- Conservative initial QR window: inbound path only within 24 hours of last inbound; order-only path within 7 days of order plus consent. UI explains which evidence enables the reply. These are product controls, not a WhatsApp unofficial-client exemption; owner may choose stricter inbound-only deployment. No phone/JID input or contact discovery/search-to-message.
- Suppression/opt-out and erasure override both paths. No self-chat, groups, status, newsletters, broadcasts, history-sync triggers or outbound phone-app echo treated as buyer initiation. Do not infer identity from unverified LID-to-phone guesses.
- Owner/Manager/Staff read according to existing message capabilities; give explicit reply capability only to intended roles, with actor audit. Role/session revocation must take effect server-side before new intent; no frontend-only gating.

### C4. Outbound reliability, coexistence and anti-abuse

Reply service creates durable intent transactionally, snapshots allowed provider/generation and actor, then worker claims with CAS plus lease/fence. Worker validates fixed thread destination/eligibility/mode/generation, sends outside transaction and stores normalized result. One in-flight send/session. Save a client/provider message identifier before dispatch when library supports it, reconcile events by it, but do not claim remote exactly-once guarantees. Unknown outcome/crash after dispatch becomes `RECONCILE`, no automatic resend. Retry only proven pre-dispatch failures. Seller may deliberately resend after checking official app with duplicate-risk confirmation and a new audited intent. Delivery ACK is not read/delivered until a corresponding supported event arrives. Deduplicate inbound delivery and ignore stale fenced callbacks, history/backfill and own-message echoes; they must never generate replies.

Initial hard limits, deliberately conservative and **not ban-safe thresholds**: one reply/5 seconds/session, at most 20/hour/shop, 5/minute/thread, queue cap 50 unsent intents/shop, per-body 4096 characters. Reserve limits transactionally at intent creation, recheck send gate, return explicit retry-after on denial. No scheduled drip marketing or jitter-based anti-detection. No automations from orders in QR mode. Opt-out UI plus common STOP signals suppress immediately; do not rely solely on keyword interpretation. Repeated failures/logouts trigger a circuit breaker and explicit Owner intervention; never rotate numbers or reconnect indefinitely to evade bans.

**Mutually exclusive send provider per shop.** Existing Cloud credentials/history may remain sealed/readable, but mode is only `CLOUD`, `QR` or `OFF`. Introduce this gate into Cloud enqueue **and** pre-send; existing queued messages retain provider/generation and must not be rerouted. Switch requires pausing claims, draining or reconciling in-flight work, explicitly cancelling pending old-mode intents, incrementing generation, then enabling new provider. No silent automatic Cloud failover for QR downtime. Preserve signed Cloud inbound receipts for historical messages even when QR send mode selected, without authorizing new Cloud sends. Same physical number simultaneously registered for Cloud and linked via unofficial Web is **UNVERIFIED**; do not assume official business-app coexistence authorizes Baileys. Recommend different dedicated numbers and deliberate cutover, not simultaneous account operations.

### C5. Tenant/resource isolation and failure handling

Worker limits are **384 MiB RAM, 0.5 vCPU, Node old-space 192 MiB**, bounded tmpfs/PIDs, read-only root, capabilities dropped and no-new-privileges. Two static workers include the permanent default slot and one admitted tenant; no shared-process sessions or Docker socket. These are protective ceilings, not measured requirements. Backend/frontend/PostgreSQL ceilings total 624 MiB; two workers add 768 MiB, totaling 1392 MiB before kernel/gateway/other workloads. Require measured simultaneous pairing/reconnect/burst peaks with >=512 MiB host available RAM, no sustained swap and no OOM before slot 1 admission. Failure keeps slot 1 disabled pending separate resize. Heap limits do not bound native/RSS memory or reserve host RAM. No unbounded caches, full-history sync, media downloads or rendering; discard unsupported media bodies without remote URL fetch.

| Failure | Required behavior |
| --- | --- |
| QR timeout/replacement | Clear stale QR, fence attempt; explicit Refresh, never background infinite pairing. |
| Remote logout/unlink/session revoked | `LOGGED_OUT`, stop sends/reconnect; remove invalid auth and require Owner re-pair/ack as applicable. |
| Temporary socket loss | `RECONNECTING`; capped exponential backoff (1/2/4/8/16/30 seconds, then pause after 5 minutes); do not retry uncertain messages. |
| Worker OOM/crash | Backend/order API unaffected; expired dispatch leases become reconcile; bounded operator restart, no QR exposed automatically. |
| Backend/DB/auth persistence unavailable | Stop new sends/close socket if key updates cannot persist; bounded buffers and clear stale status. No success acknowledgement before durability. |
| Duplicate worker/stale callback | Durable lease/fence rejects second writer and stale generation callbacks; split-brain sessions must stop rather than race. |
| Ban/repeated auth rejection | Stop, show explicit unsupported-client/number risk, advise official app/support; no evasion. |
| Tenant suspended/deleting | Stop worker, deny intents/QR fetch, fence active generations and apply retention/deletion policy. |
| Forged internal event | Deny before parsing/persistence using fixed tenant credential, body cap and replay identity; no browser access to worker API. |

### C6. Consent, PII and documentation changes

Before pilot, publish privacy notice covering seller-operated unofficial linked device/server processing, customer bodies/identifiers, purpose (order/support), access roles, retention, hosting and erasure/export limitations. Seller risk acknowledgement is separate from buyer contact consent. WhatsApp transport E2EE does not mean plaintext is inaccessible on this server. Avoid linking a personal number: device session can expose non-shop messages; filter ingestion to supported live direct customer traffic and avoid storing unrelated contact/history data. Dedicated business number strongly recommended, while still at risk of ban.

Proposed body retention: 30 days since message, peer/session metadata only as needed for active support with 90-day inactivity expiry; policy/legal approval required, not asserted as local law. Bounded daily cleanup, delete message bodies and sealed peer identifiers on valid erasure/expiry, retain minimal non-PII audit/dedupe tombstones with separate expiry. Integrate order erasure and thread suppression so late replies cannot resurrect erased contact or reopen eligibility. New inbound after erasure should create no retained text until the approved new-contact policy authorizes it. Backups contain personal data until expiry; this repository documents unencrypted backups—encrypt session/text payloads, protect master keys separately, document restore suppression/revocation. Do not claim encryption of existing Cloud body storage, which is plaintext today.

Required documentation changes in implementation jobs: README replace absolute MVP prohibition with “Cloud supported; unofficial QR human replies isolated, experimental/default off, risk acknowledgement required”; correct existing Cloud boundary. Update `docs/threat-model.md` with worker/key custody, internal API, QR/session theft, tenant fencing, unofficial account enforcement, egress, message retention and host OOM; preserve distinction from official signatures. Update `docs/INTEGRATION_DESIGN.md:6.4` to remove sample quick-login activation and fixed automated QR templates; record this human-reply scope and provider exclusivity. Correct Cloud implementation/go-live status and GCP key/egress checklist. Record dependency justification/pins, manual release/controller policy gates and rollback in GCP docs; do not quietly loosen AGENTS dependency rules. No repository docs were edited by this audit.

### C7. Implementation phases — one bounded omp job each

Each job ends with its specific offline scenario/runtime smoke and documentation for that changed behavior; security-sensitive changes require owner review. None includes a live WhatsApp send in CI.

1. **Cloud shared-secret routing repair:** current inbound/connections tests only; dispatch mixed-phone batches correctly after authentication, dedupe per processed identity; prove wrong signatures still store nothing and same-app Sandbox/Production both receive their events.
2. **Cloud erasure repair:** inbound/erase/privacy tests; tombstone/suppression policy, reject late PII resurrection, exercise erasure then late signed reply on SQLite/PostgreSQL. Update B09 status only with evidence.
3. **GCP Cloud readiness configuration:** key secret, egress and protected controller-policy acceptance, no new ports/proxy trust. Offline compose/policy checks; deployment gate requires later operator egress/Meta proof, not fictional credentials. Correct go-live docs.
4. **Dependency/resource spike:** separate worker package exact 6.7.24, provenance and full-lock review, local QR encoder pin review, Node/Linux smoke with socket/transport faked, no provider traffic. Record measured fake-workload memory separately from live-memory unknowns. Do not approve production compatibility on fake tests.
5. **Channel/session schema:** additive SQLite/PostgreSQL migrations for mode/generation and auth records, restrictive grants, importer/backup inventory, secret-box chunk adapter. Smoke round-trip binary auth and a simulated concurrent key update/crash; no pairing UI yet.
6. **Isolated pairing worker/control API:** fixed tenant binding, leases, custom auth state, status/QR expiry/disconnect, internal authentication; synthetic QR and disconnect/restart smoke. No reply sends.
7. **Thread ingress/read projection:** normalized live-message filtering, aliases, dedupe, suppression/retention and order links; fake multi-order/unmatched/history/erasure scenario; Cloud read views preserved.
8. **Human reply intent/worker:** eligibility, idempotency, rate/queue bounds, CAS claims, reconcile, normalized ACKs, mode switch/generation gates including existing Cloud worker. Fake crash-after-dispatch and cross-mode cutover smoke.
9. **Seller UI:** risk acknowledgement, QR lifecycle, inbox/thread/order selection and composer using existing vanilla UI/i18n patterns. Fake service only; actual browser at desktop/390 px including timeout, stale session and lost-response recovery. No secrets in browser storage/cache.
10. **Deployment/privacy pilot:** opt-in compose worker and secret custody, capacity admission, docs/threat-model/retention/export/erasure, restore and suspension drills. Offline fake end-to-end first; live pilot only after explicit seller acknowledgement, verified host capacity and dedicated number supplied by owner. Record real pairing/restart/reply outcomes separately; do not turn that into a CI test or default-on rollout.

Phases 1–3 deliver official readiness prerequisites independently of whether the unofficial risk is accepted. Do not ship reachable half-implemented routes between phases: absent end-to-end behavior stays disabled/unmounted.

### C8. Verification contract for QR implementation

Use an injected fake multi-device adapter (connect/QR updates/auth mutations/inbound/send outcome/logout); never real WhatsApp, arbitrary phone numbers, Chromium downloads or network in tests. Reuse existing fixture transport conventions. The fake must drive state transitions, not merely echo a requested send as success.

Permanent behavior regressions: global/tenant/quick-login denial; Owner versus Staff pairing access; Origin/CSRF and session revocation; cross-tenant thread/QR/internal-token rejection; QR generation expiry and stale-attempt denial; encrypted binary auth restore/chunk corruption/wrong AAD/key rotation; concurrent auth updates and worker fencing; actual duplicate inbound idempotence; history/own/group messages do not authorize replies; order-without-opt-in denied; LID unresolved denied; opt-out/erasure override and no resurrection; recipient eligibility rechecked after queueing; exact boundary rate/queue limits; duplicate intent with altered content rejected; unknown send never auto-retried; lease crash becomes reconcile; Cloud and QR never send the same queued intent across mode switch; stopped/suspended tenant cannot reconnect/send; body XSS rendered as literal text; retention and restored-backup suppression survive restart. Schema parity/import preservation on both stores.

Runtime smoke: launch backend plus fake worker in local isolation, log in as synthetic Owner, acknowledge risk, receive synthetic QR, simulate scan/connected, post fake inbound, open thread, type/send one reply, inspect durable outbox and simulated delivery, restart worker, then disconnect and prove subsequent send denied. Browser verify mobile/desktop surface. Optional real pilot later must measure RSS including reconnect/history/burst on the actual host, observe controlled phone reply, restart persistence, remote unlink and no duplicate sends. That is deployment evidence, not a substitute for offline tests. Current audit did not run this unimplemented scenario.

## D. Risks and open questions

### Five biggest risks

1. **Number restriction/permanent ban and ToS exposure.** Unofficial linked-device access remains unsupported even for legitimate inbound/order conversations. The seller may lose a valuable business number; risk has no reliable probability estimate or guaranteed appeal outcome. Dedicated number and human replies mitigate some abuse, not terms enforcement.
2. **Official GCP activation is incomplete.** No integration master key wiring and an internal-only backend network mean credentials alone do not produce a functioning sender. Real gateway/egress/Meta validation must follow reviewed configuration changes; local tests do not establish live readiness.
3. **Silent inbound loss and privacy resurrection.** Reproduced B08 drops same-secret Sandbox events; B09 can restore personal text after erasure. Mixed app/phone/tenant delivery and late reply handling must be repaired before storing customer conversations.
4. **Session compromise and dependency risk.** A leaked QR, auth-state database plus key, compromised worker or malicious dependency can expose/operate the linked account and private conversations. Registry provenance, isolated keys and tenant-bound APIs reduce blast radius but cannot secure a malicious runtime with decrypted credentials.
5. **Shared-host exhaustion/protocol instability.** VM RAM conflicts between task and deployment docs, no measured live memory, WhatsApp protocol changes and reconnect bursts can destabilize a small shared VM. Separate worker, caps and one-session admission protect backend better but cannot promise capacity or continuous messaging.

### Decisions still requiring explicit resolution/evidence

- Actual VM physical memory, other-container usage and available CPU/disk: task says 2 GiB/2 vCPU; checked-in GCP doc says 1 GiB e2-micro. No host/network access was used to resolve it. Enable only after operational evidence, not based on swap.
- Account-specific Meta verification, permissions, Graph v21.0 lifetime, subscription configuration, template/language approvals, billing and actual signed delivery: **UNVERIFIED without current dashboard/docs/live controlled test**. Do not ask owner to paste secrets into a research report.
- Whether one app/WABA will serve multiple tenant phones: Meta webhook callback distribution must be designed explicitly; tenant URL isolation alone is insufficient for a single app delivering all events to one URL.
- Exact 6.7.24 live multi-device/LID compatibility and official-versus-unofficial number coexistence: **UNVERIFIED**. Dependency pin is a candidate with known metadata, not a successful pilot. No library was installed here.
- Approve the suggested order-only seven-day eligibility path versus stricter inbound-only; retain explicit opt-in either way. Low-volume behavior is not a terms exemption.
- Approve retention/lawful basis, customer notice, erasure semantics, backup expiry and handling of unrelated messages on the linked business account. Earlier DEC-07 remains unresolved; seller risk acceptance alone is insufficient.
- Review local QR encoder exact pin/license and full transitive graph (especially Git libsignal, install hooks and native peers), then record independently verified provenance and image digest. No claim of cryptographic verification in this audit.
- Assign an operator for disabled-by-default deployment, dependency security updates, key backup/revocation, resource alarms and controlled manual reconciliation. Neither worker restart nor Cloud failover may silently resend an ambiguous reply.

**Release position:** Cloud is implemented but not “just enter Meta credentials” ready on the tracked GCP stack. QR human reply design is technically plausible with Baileys and strict isolation, but remains an unsupported-client integration with a real risk to the seller's number. No user communication pattern or acceptance checkbox removes that risk.

## Fixed-slot GCP implementation

The tenant design supersedes the original single-default deployment ceiling:
two static isolated workers maximum, including default. Each retains 384 MiB /
0.5 CPU, with 192 MiB Node old-space. No dynamic container creation or shared
worker credentials. Slot 1 remains unavailable until the host simultaneous-load
drill maintains >=512 MiB available RAM without sustained swap or OOM.
See [tenant design](WHATSAPP_QR_TENANTS_DESIGN.md) and
[release gates](GCP_DEPLOY.md#fixed-slot-protected-release). Container running
digest/readiness is not evidence of real pairing or delivery.
