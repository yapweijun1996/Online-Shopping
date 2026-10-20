# First SuperAdmin claim link

Status: **P2 migration, P3a default-off configuration, P4 backend issuance, P5 claim API/routing and P6 Node-gated setup page implemented locally. Not deployed; browser and edge acceptance remain unverified.** Repository inspection: 2026-10-20. This document grants no deployment authority.

Implementation status (P2/P3a): platform schema v2 adds nullable lower-cased contact email, singleton claim state, metadata-only generation history and claim audit actions. `schema.sql` remains the v1 baseline; fresh initialization runs numbered migrations, while existing v1 databases require explicit upgrade. PostgreSQL closes the latch on any admin insertion and prohibits closure changes/removal. The claim transaction finalizes the latch **before** inserting the admin (the admin reference is deferred), so the insert trigger cannot prematurely close an outstanding generation.

`PLATFORM_ADMIN_CLAIM_ENABLED=1` excludes both legacy SuperAdmin credential inputs and skips credential bootstrap. Default/off preserves legacy credential validation. P4 issues a backend-generated code after startup checks. P5 exposes shop-origin status/claim APIs; P6 adds the eligible setup page. Email remains lower-cased unverified contact-only, not a login identifier. No existing admin is backfilled. Generation history carries attempts, supersession, consumption and outcome; only the singleton state stores the current hash.


Goal: after one agent-operated infrastructure enablement, the owner opens `https://demoonlineshopping.xyz/setup/#<code>`, enters their own email, username and password, completes mandatory TOTP on a separate admin origin, and creates shops and seller Owners through the existing console. No email is predetermined. The application generates the claim code: no operator command, environment variable, Compose edit or secret file supplies it.

**Blocking contract conflict:** browsers do not transmit URL fragments. Valid, wrong and missing fragments all initially request `GET /setup/`; the server cannot choose different HTTP statuses from that fragment. Section 3.1 proposes a loader plus POST validation and explicitly identifies the navigation-status exception requiring a PIC decision. A JavaScript Not found screen is not an HTTP 404.

## 1. Evidence (file:line)

Source overrides historical proposals. Recorded production counts are historical, not freshly verified.

| Area | Evidence | Consequence |
| --- | --- | --- |
| Security rules | `AGENTS.md`; `docs/threat-model.md:244-287,293-303` | Authentication, config, routing, migrations and deployment are high risk. Bearer-URL logging requires an explicit exception to the current no-secrets-in-logs invariant. |
| Existing bootstrap decision | `docs/MULTI_TENANT_SUPERADMIN_PLAN.md:57-62`; `docs/MULTI_TENANT_GOAL.md:96-99` | File bootstrap, mandatory TOTP and host reset exist; do not replace an existing account. |
| OrbStack activation | `docs/MULTI_TENANT_LEDGER.md:330-345` | R4 installed platform roles/database and separate `admin.gmb01.xyz` tunnel. Recorded schema1/admin1/TOTP0/default1/non-default0. Keep claim mode off there. |
| Owner onboarding | `docs/TENANT_ONBOARDING.md:14-37` | Host-file password handoff is current first access; console tenant creation, generated seller password and forced change already exist. |
| Platform config | `src/config.js:44-67` | Default off. Enabled mode currently requires master key, admin host, SuperAdmin username/password file and platform/provisioner passwords. Missing admin file currently fails startup. |
| Default seller credentials | `src/config.js:69-86`; `src/server.js:54-62` | `ADMIN_USERNAME`/`ADMIN_PASSWORD_FILE` bootstrap the default shop's seller, not SuperAdmin. This task removes only claim-mode PLATFORM_ADMIN credential requirements. |
| Startup/reconnect | `src/server.js:63-66`; `src/platform/runtime.js:31-75` | Initial connect is asynchronous; new connections currently call bootstrap; reconnect/background work is periodic. Do not issue a claim on every connect/tick. |
| Bootstrap/singleton | `src/platform/admin-auth.js:72-81`; `src/platform/schema.sql:4-20` | No overwrite; `platform_admin_singleton ON platform_admin ((true))` enforces one row across processes. No email/claim state exists. |
| Transactions | `src/postgres-store.js:23-44` | Advisory transaction lock `(73119,1)` and nested transaction reuse. Reuse for rotation/claim/audit; retain singleton index. |
| Auth/MFA/cookies | `src/platform/admin-auth.js:10-59,83-151`; `src/platform/admin-routes.js:10-46` | Five-minute PASSWORD session; mandatory TOTP; one-use TOTP/recovery; FULL 30-minute idle/four-hour absolute. Secure/HttpOnly/Strict host-only cookies, exact admin Origin, CSRF/login challenge. Five account failures lock 15 minutes; password success alone does not reset failures. |
| Actual password policy | `src/accounts.js:13-18`; `src/platform/admin-auth.js:73,160,180` | Platform: 12–256 characters, excludes case-insensitive username inclusion and all-one-character repetition. Different from default seller production bootstrap policy. |
| Login identifier | `src/platform/admin-auth.js:97-108`; `public/platform/app.js:46-53` | Username only, case-folded, maximum64. Email needs server and UI changes. |
| Host boundary | `src/app.js:532-541`; `src/server.js:19-39` | Platform routes require exact configured URL host; Node URL uses Host. Forwarded headers cannot grant admin-host authority. |
| Console to API | `public/platform/app.js:41-71,82-94`; `src/platform/admin-routes.js:45-54`; `src/platform/shops.js:35-40` | FULL session can POST shops, 201; restricted sessions cannot manage shops. |
| Tenant to seller | `src/platform/provisioner.js:62-124`; `src/auth.js:30-36`; `src/app.js:254-259`; `public/seller/app.js:250-252` | PROVISIONING → role/DB/schema/settings → seller OWNER/forced password → ACTIVE. Seller server/UI require temporary-password replacement. |
| Handoff/retry | `public/platform/app.js:37-40,84-87,102-105,118-121`; `src/platform/shops.js:52` | Secret dialog precedes follow-up reads and clears on close; FAILED create can retry; default shop host-managed. Lost successful create response needs list/detail and seller-password reset, not first-password replay. |
| Schema/migration/audit | `src/platform/platform-db.js:5-24,27-31`; `src/platform/migrations.js:1-27`; `src/platform/schema.sql:64-83` | Version1, numbered runner, incompatible-open refusal. Extend audit CHECK; retain append-only UPDATE/DELETE/TRUNCATE triggers. |
| Reset | `scripts/reset-platform-admin.js:1-25`; `src/platform/admin-auth.js:176-184` | Audited host reset clears password/MFA/recovery/sessions/lockout, not admin row. No email reset. |
| GCP baseline | `compose.gcp.yaml:26-42,61-91`; `docs/GCP_DEPLOY.md:3-11,59-63` | Independent fresh DB, platform off, no master/platform keys. PG20 connections/192MiB; backend256MiB. Init scripts only run for an empty volume. |
| GCP edge | `deploy/gcp/Caddyfile:20-49,54-85` | Platform blocked; setup falls through404; seller broad `/api/*` requires explicit setup API block. No tenant-prefix routing. |
| Existing tenant/admin edge | `deploy/Caddyfile.production:29-73,113-152,176-193` | Metadata-only availability gate, lifecycle/aliases/privacy, separate admin block: adapt these for GCP. |
| Packaging/static | `src/static.js:20-59`; `Dockerfile.backend:6-8`; `Dockerfile.frontend:3-4` | Node static can expose public files; frontend contains public tree, backend only two shared public modules. Setup must not have bypassable static aliases. |
| Collision | `src/platform/tenant-code.js:5-13` | `setup` is valid today; opt-in needs tenant/alias collision check and conditional reservation. |
| OrbStack updater | `docs/AUTO_DEPLOY.md:11-25`; `deploy/auto-update.py:21-25,250-259,323-358` | Configured platform upgrades automatic with drained maintenance/verified backup/restore. Platform schema is not a protected tunnel/init file. Controller installation separate. |
| GCP updater | `docs/GCP_DEPLOY.md:43-55`; `deploy/gcp/update.py:21-22,130-149,239-261,277-298` | Image-only, four runtime keys, manual config release. Platform schema/version/migrations not currently fingerprint-protected: fix before activation. |
| Setup portability | `deploy/setup-platform.py:12-17,26-43,48-71` | OrbStack context/container defaults; 0600 setup inputs; creates missing objects/validates flags. Not directly Linux-ready. |
| Cloud log gap | `compose.gcp.yaml:21-23,59,83`; `docs/GCP_DEPLOY.md:55` | Rotated Docker json-file, not Cloud Logging transport. Cloud-viewer delivery UNVERIFIED. |

**Existing end-to-end path:** password login → restricted TOTP → FULL console → Create shop → separate role/database/seller OWNER → forced seller password change. Historical browser proof: `docs/MULTI_TENANT_LEDGER.md:306`; MT-05: `docs/MULTI_TENANT_LEDGER.md:84`. This is source/record inspection, not a new browser run.

**Gaps:** no claim/email flow; no GCP platform infrastructure/admin/tenant routes; no GCP automated multi-DB migration/backup; capacity/log delivery unproven. Provisioning remains multi-step with FAILED/retry reconciliation, not one cross-database transaction. Default-shop administration, permanent purge and loss-of-all-factors recovery remain operator tasks.

## 2. Architecture Gate

### 2.1 Ownership and trust

- Owner authority is possession of the log-delivered bearer code, not legal ownership/mailbox control. Email is no additional claim proof.
- Application generates32 random bytes using node:crypto, unpadded base64url43 characters/256bits. Store only domain-separated SHA-256 hash, emit URL after commit. No token input setting/operator generator.
- Platform PostgreSQL is the single source of truth for admin existence, generation/hash/expiry/use, durable closure and audit. No shop DB, process-local eligibility or Caddy state file.
- Support one active backend, stop-before-start. Serialize concurrent initializers; latest committed generation wins. Stale process cannot accept stale code. No rolling/multi-replica delivery promise.
- Shop origin receives bootstrap capability only, never a platform session. Do not allow shop Origin in existing platform mutation router.
- Console choice: **`https://admin.demoonlineshopping.xyz/platform/`**; config adminHost exactly that hostname. One-time DNS/shared-gateway TLS prerequisite, presently UNVERIFIED. Neither customer nor seller origin: their script compromise must not gain an admin-origin foothold. No silent seller fallback.
- Agent/operator handles one-time roles/keys/mounts/hosts/IP policy/log transport/IAM/deploy baseline; never claims/enrols production owner. This document authorizes none of those operations.

Blast radius: SuperAdmin can reset sellers/change lifecycle across all tenants. Backend/master-key/provisioner already cross tenant boundaries. Default-off claim cannot replace any existing admin. OrbStack retains bootstrap credentials/accounts/MFA/hosts/Compose/tunnel; only additive platform migration reaches its DB.

### 2.2 Configuration

Proposed `PLATFORM_ADMIN_CLAIM_ENABLED=1`; absent/0 retains legacy bootstrap. Default30-minute expiry in application policy; no required TTL/email setting.

| Mode | Contract |
| --- | --- |
| PLATFORM_ENABLED absent/0 | Existing null platform config, no claim initialization/log; legacy routing unchanged. |
| Platform on, claim absent/0 | Existing required PLATFORM_ADMIN_USERNAME/PASSWORD_FILE, validation/idempotent bootstrap unchanged. |
| Platform on, claim1 | Do not require/read/store those two SuperAdmin credential inputs. Reject either supplied with claim mode. Still require master key, exact admin host, platform/provisioner credentials, public/seller origins. |
| Invalid enabled settings, missing infrastructure secret, equal shop/admin host, setup tenant/alias collision | Fail closed before emission, no default password/open fallback/shadowing. |
| Claim on, admin or closure exists | No emission, setup404; normal login/reset without obsolete bootstrap credentials. |

Represent mode explicitly in config.platform and branch before current auth.bootstrap (which validates before existence check). Initialization-once state must survive reconnects. Default seller ADMIN_* remains infrastructure input, not a new owner onboarding step.

### 2.3 Log delivery: deliberate trade-off

PIC-selected channel: one structured stdout record after each generation commit. Placeholders only:

```json
{"event":"platform.claim.issued","url":"https://demoonlineshopping.xyz/setup/#<43-character-code>","expiresAt":"<UTC timestamp>","generation":"<uuid>"}
```

URL from validated config.publicOrigin, never request Host/Forwarded. When absent (development only), use `http://localhost:<config.port or 3000>`; production configuration already requires PUBLIC_ORIGIN. No email/password/DB URL/master key/TOTP/recovery. Audit records metadata, never code/hash/URL.

**Risk:** anyone reading live URL can claim. Retention/exports/alerts/broad viewer roles can copy it; expiry/use cannot retract copies. Restrict owner to dedicated bootstrap log view, exclude event from broad exports/notifications, document retention. Never copy live URL into chat/Git/tickets/CI/evidence. Record this narrow exception to no-secret-logging invariant in implementation threat model.

Alternatives weighed: local-console/loopback page avoids central retention but needs trusted local/SSH access/new handoff; host-control/IAM-signed proof avoids bearer log but adds identity/signature/audience/replay contract (public metadata/supplied hostname is not proof); public register-when-empty rejected takeover; operator env/file password retained only for legacy, rejected for this journey.

DB commit/log delivery cannot be atomic. Promise **at most one application emission attempt per generation**, not exactly-once cloud receipt. Crash after commit/before stdout or lost ingestion strands a generation. No plaintext retention/reprinting on reconnect; trusted restart issues fresh. Ingestion may duplicate record; generation identifies it. Browser extension/XSS/history-sync/clipboard/shoulder-surf risks remain.

## 3. Claim flow and HTTP contract

### P5 authoritative PIC contract (supersedes conflicting proposals below)

- Only exact shop-origin `/api/v1/setup/status` GET and `/api/v1/setup/claim` POST are implemented. Claim mode, no admin, unclosed latch, current hash, DB-time unexpired generation and fewer than five wrong-code attempts are required. Every other setup API path/state returns the unknown-path generic 404. No page/assets or validate endpoint is added.
- Claim JSON is exactly `{code,email,username,password}`, streamed with a 4096-byte cap. Exact shop Origin plus non-ambient bearer possession and JSON provide CSRF protection; no ambient-cookie setup challenge is required. Existing admin-origin CSRF remains mandatory for enrolment and all other platform writes.
- Persisted claim limit: five admitted requests/client/15 minutes, before parsing/hashing. Throttles return generic 404; one rate-limit audit/client/window. Five wrong/missing code attempts permanently disable that generation until trusted restart supersedes it; state/history counters and denied audit commit together. No submitted secrets or identifiers are audited on failure.
- Constant-time domain-separated SHA-256 comparison precedes field errors. Proven-code invalid/extra fields return 400 without consuming the generation. Contact email is lower-cased, bounded ASCII mailbox syntax matching the migration, one @, local part at most 64/total at most 254, no whitespace/controls. Existing username/password policy applies; email sign-in is not added.
- Serialized transaction rechecks eligibility, validates/hash-encodes the password, rechecks expiry, closes the latch before admin INSERT (deferred FK), consumes history, audits ADMIN_CLAIMED, and creates the existing five-minute PASSWORD session and CSRF. Any insert/audit/session failure rolls everything back. Claim never grants FULL; unfinished MFA never reopens setup.
- Response is 200 with login-equivalent `{csrfToken,stage:"PASSWORD",totpEnabled:false}` and the existing Secure/HttpOnly/Strict host-only platform cookie. **Browser boundary:** the cookie set on the shop host cannot be sent automatically to the separate admin host. No cookie Domain widening, cross-origin token transfer or shop-Origin exception is introduced. A browser must sign in again on the admin origin to continue enrolment; API tests explicitly carry the restricted cookie to prove existing enrolment semantics. P6 must preserve this boundary.
- Verification: JavaScript syntax checks and scoped PostgreSQL platform/tenant tests passed (52 tests, zero failures/skips); actual Node HTTP startup → open status → PASSWORD claim → closed status smoke passed. No browser, edge, cloud-log or deployment verification.


The remaining subsections retain historical proposals. The P5 PIC contract above governs implemented API/session/email behavior where these proposals conflict.
### P6 authoritative page contract

- Exact shop-origin GET `/setup/`, `/setup/setup.js` and `/setup/setup.css` share the status API's database eligibility predicate. Other paths, methods, queries and ineligible states return the byte-identical unknown-path JSON 404. Generic static serving refuses decoded setup paths, including prefixed rewrites; claim-off legacy setup tenants remain routable.
- Files live in `public/setup/` and are copied into the backend image. Eligible page/assets use no-store, no-referrer, noindex, nosniff and a first-party-only CSP with no inline code/styles. Setup 404s and status also use no-store/no-referrer/noindex. No sitemap, robots or worker-cache entry is added. Existing workers intercept only scoped navigation/explicit shell assets and exclude APIs.
- The external loader removes the fragment with replaceState before any fetch, retains the code only in memory, checks status, and submits exactly the P5 JSON fields. Failures use one generic message; pending submission is guarded, errors receive focus, and success clears the code/form before navigation.
- The claim response additionally returns `nextUrl`, derived from configured `platform.adminHost` with `/platform/`. The host-only PASSWORD cookie remains on the shop host: separate-origin console sign-in is required, followed by existing mandatory TOTP enrolment. No session transfer, cookie widening, console hook or seller-host fallback.
- English only: shared i18n is a storefront-wide catalog, so this isolated dependency-free page does not import it. Width-constrained layout and labelled controls target 320px; actual browser rendering is UNVERIFIED. P7 must route these exact paths to Node rather than the frontend file server.
- This contract supersedes historical page/asset names, validate endpoint, email-sign-in and handoff proposals below. An open loader returns 200 independent of the fragment; missing/malformed fragments produce the neutral unavailable message, not a fragment-dependent HTTP status.
- Local verification: `node scripts/check.js` passed; scoped node:test run across CSP, frontend base-path, claim API/schema/runtime, setup page, platform admin, tenant routing, tenants, PWA and shop setup passed **69/69, zero failures/skips**. A disposable real-PostgreSQL Fetch-router smoke exercised open HTML/JS/CSS → PASSWORD claim/configured nextUrl → byte-identical closed page/assets/status 404s. Deterministic VM DOM execution covered fragment removal before fetch, duplicate-submit suppression, success cleanup/navigation, closed status and generic error focus. No browser, container build, edge or deployment was exercised.


### 3.1 Required fragment/status decision

Recommended, **conditional on PIC approval Q1**: eligible GET `/setup/` returns **200 inert loader**, no form; external JS reads fragment, immediately history.replaceState removes it, keeps code only in module memory, POSTs validation. Wrong/missing code receives API404 and neutral Not found UI. Expired/used/closed/off setup gets actual404 page/assets/API. Downloaded bytes cannot be revoked; every later server action rechecks.

This does **not** meet literal fragment-dependent initial-navigation404. Alternative: always404 bootstrap document executing external JS, validation POST, then cookie-authorized fixed-path reload returning200; valid link's initial navigation is still404 and error-document scripting is unusual. Owner POST entry changes requested link UX. No option makes initial GET fragment-aware. Query/path tokens prohibited. Resolve Q1 before public-page implementation; remaining contract specifies recommendation without pretending approval.

### 3.2 Startup lifecycle

1. After schema/infrastructure checks, outside maintenance, transaction/advisory lock checks any admin, durable closure, setup tenant/alias collision. DB error never means empty.
2. Only claim mode + empty/unclosed: generate code in app, replace singleton generation/hash/issued/expiry with revision increment. Authoritative DB time: accept only now < expires_at; UTC app display not authority.
3. Append ADMIN_CLAIM_ISSUED, commit, emit one line, release plaintext references. Hash is SHA-256 over `PLATFORM_ADMIN_CLAIM\0` followed by the code. TTL is the application constant `CLAIM_TTL_MS` (30 minutes; policy bound 1–30 minutes). Agent never redeems/enrols production.
4. Track successful initialization once per runtime, before the stdout attempt. Reconnect/reconciliation never rotates, including after expiry or a stdout failure. DB-down-at-boot may issue at first successful initialization; unexpected missing/replaced state after initialization does not cause automatic issuance. Overlapping runtime starts reuse a live generation whose DB issuance timestamp is at or after that runtime's creation timestamp; later restarts supersede it under the existing advisory transaction lock. This overlap distinction assumes synchronized application/database wall clocks; it is not a distributed deployment protocol. Maintenance pauses do not issue.
5. Restart unclaimed creates fresh generation, invalidates old code/challenges. No periodic/public renewal. Existing admin/completed claim closes across restarts.

“404 forever” is permanent after claim/existing-admin and for expired/used codes. Before any claim, trusted restart intentionally opens a new generation; otherwise required recovery/rotation contradict permanent expiry closure. Older empty backup restore can undo latch; privileged disaster recovery, not ordinary reset.

### 3.3 Page, headers and validation

Exact config.publicOrigin host; canonical `/setup/`. Reject queries, `/setup`, direct index/extra-path aliases, unsupported methods404 rather than bearer-navigation redirect. Exact assets `/setup/app.js`/`style.css` through Node eligibility, not file_server. Store assets outside public tree (e.g. platform server assets) and explicitly package backend. No SW/PWA/analytics/third-party fonts/imports/storage. Reload before claim needs private link again.

All setup responses including404: Cache-Control no-store; Referrer-Policy no-referrer; nosniff; no CORS. CSP:

```text
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'
```

External scripts/styles only; textContent; labels/keyboard/error focus/44px actions. Collect email, username, password, optional client confirmation, correct autocomplete. Email label: **Contact email (not verified); also usable to sign in. Not a password-recovery address.**

POST validation, no consumption:

```text
POST /api/v1/setup/validate
Origin: https://demoonlineshopping.xyz
Content-Type: application/json
X-Setup-Request: 1

{"code":"<code>"}
```

Valid current code200:

```json
{"csrfToken":"<random challenge>","expiresAt":"<claim expiry>"}
```

Set host-only Secure/HttpOnly/SameSite=Strict platform_claim cookie, Path `/api/v1/setup`, ≤5minutes and claim expiry. Reuse encrypted login-challenge pattern under separate PLATFORM_CLAIM context, bind CSRF/generation/expiry, no raw code. No admin session. Initial validate needs exact shop Origin/JSON/custom header/no CORS and explicit bearer possession, not ambient auth cookie.

Wrong/missing/malformed/expired/stale code, wrong host/Origin, ineligible404:

```json
{"error":{"code":"NOT_FOUND","message":"Not found."}}
```

Constant-time fixed-length hash comparison; no scrypt token guesses. Stream4096-byte cap. Pre-possession JSON/content-type/oversize errors same404, no parser diagnostics/reflection/account-existence/remaining-window response.

### 3.4 Atomic one-shot claim

```text
POST /api/v1/setup/claim
Origin: https://demoonlineshopping.xyz
Content-Type: application/json
X-CSRF-Token: <challenge>
Cookie: platform_claim=<sealed challenge>

{"email":"<owner input>","username":"<owner input>","password":"<owner input>","code":"<code>"}
```

4096-byte cap/exact fields; reject role/tenant/TOTP/redirect/bootstrap inputs. Prove code before field errors. Valid code invalid email/username/password/extra fields400 INVALID_INPUT, no consume; valid code missing/wrong/expired CSRF403 FORBIDDEN; wrong Origin404. Never return password/hash.

Existing scrypt encoder, outside final transaction where practical; **recheck all eligibility/expiry after hashing inside transaction**:

1. Existing serialized transaction, lock/read state; no admin/no closure.
2. Validate current hash/generation/challenge/revision/unused/DB-time expiry.
3. Insert generated admin id, username/key, email/key, hash, TOTP disabled/unset, no recovery, zero failures; keep singleton index.
4. CAS generation/revision, set used/permanent closure/admin id, clear token hash. UPDATE RETURNING via get must return a row (store.run has no affected-row count). State invalidates generation challenges.
5. Append ADMIN_CLAIMED canonical username/safe generation, same transaction. Any failure/audit failure rolls all back. Only expected singleton/CAS race losses map404, not arbitrary DB failures.

One winner; losers/replays404, never second admin/update. No public success replay cache/idempotency oracle. Unknown response outcome → ordinary login with submitted credentials.

201, clear setup cookie, **no platform session cookie**:

```json
{"claimed":true,"nextUrl":"https://admin.demoonlineshopping.xyz/platform/"}
```

Clear form/password/code references, navigate fixed config-derived URL, show fixed link if navigation fails. No code/password/session in redirect parameters, cross-origin messaging or cookie Domain. Owner re-enters credentials on admin origin, immediately existing restricted TOTP enrolment. Extra password step avoids cross-origin session handoff.

### 3.5 MFA, limits, errors and audit

Existing continuation: GET platform/csrf200; POST platform/session `{username,password}`200 PASSWORD. POST totp/enrol200 key/issuer/account/URI; POST totp/confirm `{code}`200 rotated FULL token/ten recovery codes once. Preserve five-minute restricted, FULL idle30minutes/absolute4hours, replay protection. Fail password/TOTP/recovery401 generic; Origin/CSRF403; existing IP exhaustion429; restricted management403 TOTP_REQUIRED. Account five failures/15minutes, aliases shared, password success alone never resets.

Proposed persisted SqlLimiter buckets, trusted IP reserved before parse/hash: loader/assets shared30/IP/15min; validate10; claim5. Count all, no validation-success clear. Setup throttles indistinguishable404, no validity hint/Retry-After. No global/account/email preclaim lockout enabling stranger DoS. Shared-NAT denial remains risk. Existing admin login10/challenge30 per15minutes unchanged.

Closed/off/existing-admin404 precedes methods/payload/Origin/limits. Eligible pre-possession failures404; proven-code field/CSRF errors400/403. Unknown eligibility due DB outage generic503/no form/no claim; maintenance may existing503 before dispatch. No internal details.

New platform_audit actions: ADMIN_CLAIM_ISSUED, ADMIN_CLAIMED, ADMIN_CLAIM_DENIED, ADMIN_CLAIM_RATE_LIMITED. Issue/success coupled transactionally. Denials actor unknown, bounded reason/generation only, no submitted email/username/code/hash/password/raw IP. Audit admitted attempts and first throttle/IP/window using persistent limiter coordination; no unbounded flood audit. Audit failure cannot allow unaudited success. Expiry derived, no required timer event; existing login/TOTP/recovery/reset events retained.

### 3.6 Node/Caddy double enforcement

Node claim-mode dispatch before tenant/static; exact shop host, DB eligibility, request checks. Separate handler, no shop-Origin exception in platform router. Reject prefixed setup/API, other hosts, aliases/encoded paths, invalid/duplicate Host/forwarding-host spoof. Conditional setup reservation in create/rename/resolver/GCP exclusions; existing tenant/alias collision fails enablement, never rename/shadow. **Off retains legacy routing/reservation**, no public setup files; root setup API remains nonexistent. Do not break an existing legacy setup tenant merely to claim disabled path always404.

GCP manual edge/gateway release:

| Host/path | Caddy | Node |
| --- | --- | --- |
| Shop exact page/assets/validate/claim | Proxy before broad API/tenant/static; no file_server/index fallback/redirect/cache. | Current eligibility/code rules, closed/expired404. |
| Shop other setup/API forms | Explicit404 before broad matchers. | Independent rejection. |
| Shop platform/seller-private | Keep404. | Exact admin host remains mandatory. |
| Seller setup/platform including prefixed | Explicit404 before broad `/api/*`/tenant rewrite. | No setup authority. |
| Admin platform page/assets | Frontend console strict CSP; non-secret canonical redirects allowed. | Local Node exact-host. |
| Admin platform API/health/ready | Proxy. | Existing auth; health alone no platform proof. |
| Admin setup/shop/seller/unrelated; unknown host | 404. | Independent guard. |

Caddy cannot query DB: making Node the only setup responder and propagating404 without static fallback enforces closure in both layers, no duplicated flag/DB. Inherited no-cache must not override no-store/no-referrer/CSP. No gateway/CDN error cache. Downloaded form still cannot mutate closed state.

Adapt R2 tenant edge too: prefixed API/manifests/static/crawler/entry, metadata-only tenant-access gate, aliases/lifecycle, privacy, seller tokens CSS exception, streamed bodies. GCP trusted X-Real-IP, never CF-Connecting-IP. Console success with tenant URLs404 is incomplete.

## 4. Data model + migration

### 4.1 Additive platform v2

Proposed `src/platform/migrations/002-admin-claim.sql`, PLATFORM_SCHEMA_VERSION2. Keep deployed schema.sql v1 immutable; no shop schema/audit-history rewrite.

| Object | Contract |
| --- | --- |
| Admin email/email_key | Nullable TEXT, both NULL or valid bounded pair; unique email_key allowing NULLs. No default/backfill/invented verification. Existing credentials/TOTP/session/singleton unchanged. |
| platform_admin_claim | One id1 PK/CHECK; nullable generation UUID,64-hex token_hash,issued_at,expires_at,used_at,closed_at,claimed_admin_id; nonnegative revision. Existing canonical UTC TEXT generated from DB time. Optional admin FK ON DELETE RESTRICT; closure independently authoritative. |
| State consistency | Outstanding hash/issue/expiry together, expiry after issue, no used/closed. Used implies closed/hash cleared. Expired row may retain hash until replacement. Closed never rotates through app. No plaintext/sealed code. |
| Audit CHECK | Extend four actions, preserve triggers; verify deployed constraint name before replacement. No historical-event rewrite/delete. |

Migration any-admin → closed latch, unchanged credentials/MFA/sessions/lockout, NULL email. Empty → unissued/unclosed, not automatically enabled. Legacy bootstrap insertion transaction also closes latch. Reset never clears. No admin-delete/reopen API.

Fresh empty DB must run baseline+numbered migrations before v2 check (constant bump alone createsv1 then fails). Reuse upgradePlatformSchema, serialize. Nonempty older DB still updater/operator migration, not request startup. Platform PG-only: no SQLite/main shop version change; legacy behavior/tests unchanged.

### 4.2 Email sign-in decision

**Yes additional identifier**, unverified contact PII, not recovery/ownership proof. Username excludes @; namespaces disjoint.

Trim surrounding ASCII whitespace, conservative ASCII mailbox, one@, local≤64/total≤254, valid DNS-label domain; reject controls/whitespace/display names/quoted local part/leading-trailing-consecutive local dots. Exclude SMTPUTF8/internationalized mailbox syntax explicitly, no silent transformation. Preserve accepted spelling, whole-address ASCII lowercase email_key; rare case-sensitive local parts deliberately app-equivalent. No dot/plus-tag removal/provider aliases/DNS/mail lookup; no deliverability claim.

Existing POST session key username retained, UI “Username or email”; email-shaped lookup normalized email_key, others existing username rules. Identifier bound254, username bound64; migrate server/UI/callers/API docs together. NULL-email legacy username-only, no mandatory owner input/backfill. No email-edit/reset feature.

Known-wrong/unknown/malformed/locked identifiers same generic failure and one real-or-dummy password verification; no fast account oracle/input in audit/errors. Both aliases same admin id/lockout. Auth views/audit canonical username; no promise of mathematically identical network timing.

### 4.3 Updaters

OrbStack claim absent/Compose/secrets/tunnel unchanged. Its installed configured R3 controller automatically detectsv2/drains/backs up and restore-tests/platform+eligible shops/upgrade-platform runner/verifies/resumes. Schema alone not protected-file manual gate. Rehearse existing-admin NULL-email/MFA preservation/rollback. Exact-version opener means additivev2 not necessarily old-v1-image-compatible: failed cutover snapshot restore before reopening, not later customer-write loss. Repo changes do not install controller.

GCP add platform schema/version-bearing platform-db.js/migration runner/directory to fingerprint/manual policy first. Currently outside protected tuple, so platform-only incompatible image might auto-deploy while default ready passes. Keep image-only controller; manual drained restore-tested multi-DB migration/audited baseline. No initialize rerun/state erase/imaginary force-migrate. Gate even unchanged main SCHEMA_VERSION.

## 5. Threat model and recovery

| Threat | Control/residual |
| --- | --- |
| Log/fragment theft, shoulder-surf/extensions/history | 256bits/30minutes/fragment/history clearing/no-referrer/no cache-storage-analytics/scoped log IAM. Holder can win, copies cannot be revoked. |
| Claim races/restart/bootstrap | Current generation/revision/expiry serialized plus singleton; account/use/closure/audit atomic. One winner404 loser. Different-mode overlapping backends forbidden operationally. |
| Brute force/DoS | Uniform404, bounded shape/hash/stream before scrypt, persisted IP limits, no public rotation/global/email lockout. Distributed flood/shared-NAT risk remains. |
| Replay | DB closure+any-admin every page/asset/API, clear hash/invalidate challenges. Existing cookies/reset never reopen. |
| Host/admin confusion | Exact gateway/Caddy/Node hosts, config links, reject suffix/port/forwarding-host/encoded/prefixed aliases. No CF header trust on GCP. |
| CSRF | Exact shop Origin/JSON/custom header/bearer validate; sealed generation cookie+CSRF claim, no CORS. Existing admin boundary unchanged. |
| Email enumeration/fraud | Dummy-hash generic auth/shared lockout, no mail/verification/reset/ownership assertion. Another person's email grants no recovery. |
| Password | Existing server-side policy, no claim weakening/incidental OrbStack change. Mandatory MFA not a cure for weak password. |
| Interrupted TOTP/half-claimed admin | Claim permanently consumed at account commit, not MFA finish; no FULL at claim. Reload/expiry/restart → admin password login resumes sealed enrolment. Never auto-delete/unclaim on timeout. |
| TOTP confirm response lost | May have committed: next unused TOTP login, Account regenerate codes with password. No consumed-step replay/old code reveal. |
| Claim response lost | Try admin submitted credentials; if not committed and original code current reopen link, not blindly different credentials. No public success oracle. |
| Expired/lost pre-account link | Generation404, no public renew. Authorized agent project-backend restart preferred; owner VM Restart emergency trusted action then new log. No owner Docker/env/files, but shared-VM restart disrupts other workloads. Q2 must disclose exception. |
| Existing admin, unenrolled too | No issue/setup404; resume enrolment. Stale env/email cannot claim/reset. Closed latch/missing admin fails closed investigation. |
| All factors lost | Password+recovery when available; otherwise authorized agent audited host reset. Unverified email no safe web recovery. |
| DB/log outage/crash | Never infer empty; unavailable setup/default health independent. Commit/emission gap trusted restart; ingestion delay consumes existing window, no extension. |
| Preclaim backup restore | Can undo latch/reopen; privileged restore, pause/inspect before exposure, not sign-in reset. |

Normal claim/TOTP/recovery-code retention/tenant creation web-only after enablement. Expiry renewal/all-factors-lost cannot be unauthenticated app UI under startup-only issuance/post-expiry404. Disclose recovery exceptions, not universal self-service promise.

## 6. GCP enablement plan

### 6.1 One-time agent-operated infrastructure

| Input | Why outside UI / least manual |
| --- | --- |
| Platform DB/app/provisioner | UI cannot grant its own DB authority; adapt idempotent setup explicit Linux project/container, independent generated secrets, validate existing objects not overwrite. |
| Master key | Seals TOTP/tenant DB passwords; generate32-byte id=base64key (`src/secret-box.js:12-28`), outside Git/separate backup, not DB-only custody. No SuperAdmin password/email secret. |
| DNS/TLS/host/IP | DNS/VM authority, add dedicated admin through existing direct shared Caddy. No GCP tunnel/new tunnel credentials. |
| Mounts/log IAM/root runtime | Privilege boundaries, reviewed install/scoped owner view, no app Docker socket/internet expansion. |
| Backups/capacity/maintenance | Rehearse all DB recovery and resource bounds before tenant creation. |

Once-only app settings: PLATFORM_ENABLED1, PLATFORM_ADMIN_CLAIM_ENABLED1, PLATFORM_ADMIN_HOST admin.demoonlineshopping.xyz; existing exact PUBLIC_ORIGIN/SELLER_ORIGIN; INTEGRATION_KEY_FILE, PLATFORM_DATABASE_PASSWORD_FILE, PLATFORM_PROVISIONER_PASSWORD_FILE; DB postgres/platform/platform_app/platform_provisioner. No PLATFORM_ADMIN_USERNAME/PASSWORD_FILE. Default seller credentials/DB owner-app passwords/shop mode/quick login unchanged.

GCP root controller only permits SHOP_HOST/SELLER_HOST/ADMIN_USERNAME/SECRETS_DIR. Narrow extension for admin host/opt-in, fixed secret names under SECRETS_DIR, reviewed installed root controller/Compose/runtime/audited baseline once. Arbitrary env append fails; repo Compose does not replace installed copy. No interpolation/state reset.

Objects: platform_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION owns platform; platform_provisioner LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION, PG16 self-grant set,inherit. Revoke PUBLIC platform; prove default app/tenants cannot connect platform/other tenant DB. Provisioner accepted X6 cross-shop privilege.

Adapt setup-platform.py transport/context retaining OrbStack default, explicitly resolve GCP PostgreSQL container. Preserve0600 setup-input checks; GCP runtime-readable0444 root-owned files inside0700 parent (or reviewed UID/ACL) differ. Use root-only temporary setup inputs, atomic runtime mounts, remove temporary inputs. Verify actual credential auth as well as ownership/flags: skipping existing role does not prove password match. SQL passwords stdin only, no argv/log/audit/errors. Never rerun initdb scripts/recreate/delete initialized volume.

### 6.2 Log delivery and capacity gates

json-file not cloud transport. Prefer reviewed Docker gcplogs for backend, VM log-write identity/owner restricted view, no app internet/custom shipper. **UNVERIFIED** driver/metadata credentials-scopes/JSON mapping/IAM-view-export-retention/latency/owner access. Prove harmless synthetic event first. If unavailable investigate approved host collector, not silent inaccessible local-log fallback. Reconfirm buffering/resource/rotation policy; diagnostics private.

Planned private owner command, not executed:

```sh
gcloud logging read 'jsonPayload.event="platform.claim.issued"' --project=PROJECT_ID --order=desc --limit=1
```

Actual filter includes reviewed installation/log/view/current generation, mapping verified first. Live output must not enter agent transcript. Gateway/driver must not capture setup body/cookies/query; no debug body logging. Generated token fragment-only.

Capacity: main pool8 (`src/postgres-store.js:23-24`), platform3/tenant3 (`src/platform/runtime.js:14,47`), up to20 stores; temporary provisioning adds connections. OrbStack measured53/100 (`docs/MULTI_TENANT_LEDGER.md:322`) exceeds GCP20; micro VM memory differs.

Propose initial GCP cap **two shops including default**, configurable retaining OrbStack20; one non-default pool3, one provisioning operation/temp-store1. Server-enforced cap and dynamic console limit, not hard-coded20. Conservative main8+platform3+tenant3+temporary1+provisioner1=16, four left of20 reserved/operator; prove actual PG slots/overlap/RAM/swap under scrypt/login/provision/worker/backup. Not throughput/OOM guarantee. More tenants require separate rehearsal, not assumed resize/paid service.

Master key also starts WhatsApp worker (`src/server.js:94-97,115`): not auth-only effect. Keep internal no-egress, no provider credentials/sends in rehearsal; check polling/capacity/drain. No external-network enablement.

### 6.3 Minimal safe sequence

1. Resolve Q1/Q2; authorized project/VM/Compose/root-controller/digests/gateway/DNS/log access inventory, current DB/admin/latch/setup collision. No live assertion here; OrbStack untouched.
2. Inert implementation/claim off; empty/existing migration/legacy/GCP fingerprint tests, trusted exact-SHA CI/images before complete public surface.
3. Pause GCP timer, preserve root policy/runtime/state/images; drain/stop only project writers, not shared VM workloads. Restore-test default DB/private roles/privileges backup. Later backups cover platform/tenants and separate keys.
4. Platform still off: adapted setup creates/validates roles/DB on current volume, installs key/DB secrets, reviewed manual platform-owner baseline+002, version/audit/negative-connect proof. No admin/operator claim token.
5. Admin DNS/sharedTLS/gateway/Caddy setup-admin-tenant routes, Host/trusted IP; harmless cloud event owner-readable; capacity bounds/disposable full journey.
6. Manual opt-in: reviewed root controller/Compose/runtime/digests/mounts once, no bootstrap SuperAdmin inputs; single backend no rolling. Application generates/hash-stores/logs. ready only default: separate schema/issuance/public-host proof without production redemption. Failure unavailable/compatible rollback only.
7. Owner privately reads/registers/admin login/TOTP/save recovery/create real tenant/private seller handoff, zero Docker/env/files. Agent no MFA/fictional production tenants; negative/destructive work rehearsal only.
8. Verify permanent setup/assets/API404, MFA, usable tenant URLs/seller forced-change, default shop/cookies/Origin/log scope; restore-tested multi-DB backup operations (image updater provides none); audited baseline then unchanged-schema image automation. No initialize/state-erase bypass.

Before claim invalidate generation via reviewed controlled procedure preserving compatible schema. After claim/tenant/customer writes, never routine rollback to preclaim/default-only snapshots: preserve latch/admin/keys/roles/DBs/subsequent writes; unknown compatibility keeps maintenance/manual recovery. No step executed for this document.

## 7. Test plan with negative tests

Future acceptance, **not executed here**. Existing platform-admin/API/runtime/operations/operators/shops, tenant-routing/isolation, test/gcp-deploy.test.py and scripts/qa-caddy-routing.mjs conventions. Deterministic clocks/fictional accounts/disposable PG16; no email/provider calls/production redemption.

| Boundary | Observable acceptance |
| --- | --- |
| Default off/config | No issue/new DB dependency/new reserved path off; legacy bootstrap no overwrite; claim absent credential files works; mixed/invalid fail; default seller/guest/PWA unchanged. |
| Schema | Empty baseline+002v2; existing admin preserved credentials/MFA/session/lockout NULL-email/closed; missing/ambiguous/future/failed migrations refused/rollback; audit immutability. |
| Startup/log | 256-bit source/hash only/one emission attempt, no reconnect/tick issue; restart stale invalid. Fault beforecommit/aftercommit-beforelog/afterlog, fresh recovery no plaintext reprint/exact-delivery claim. |
| Expiry/closure | Just-before valid, at/after404 including during hash; stale/used/existing-unenrolled/closed-missing/postreset closed; no restart reissue afterclaim. |
| Real races | Two differing claimants real PG one account/use/audit, loser404; rotation/bootstrap races; failed audit/CAS no partial state. |
| API negatives | Wrong/missing/malformed code/JSON/type/oversize/method/query/extra fields/stale-duplicate cookie/Unicode-missing-wrong CSRF/Host/Origin;404 precedence/no-store, field errors no consume, persistent limits. |
| Email | Case aliases same account/lockout, plus/dots not rewritten, trim/length/internationalized rejection, NULL legacy username; unknown/locked cost/generic failure. |
| MFA | No FULL claim cookie; restricted reload/expiry/restart resume; all management denied untilconfirm, rotation/code-once, TOTP/recovery replay, password alone notclear. Lost confirmation nextstep/code regeneration. |
| Browser end-to-end | Real Caddy approved link/form→claim→separate admin password/TOTP→shop DB/role/sellerOWNER→forced password→buyer/seller prefixes.360px/keyboard/focus/CSP/secret clearing, no persistence. |
| Edge/Node | Full host/port/suffix/duplicate Host/forwardedhost-IP/encoded-double-slash-dot/index-assets/prefixed/collision. No static/cache bypass closed; loaded form cannot mutate closed. |
| Tenant regressions | Known/unknown/lifecycle/aliases/manifests/SW/privacy/streamed POST; denied metadata opens no DB; OrbStack unchanged. |
| Deploy/restore | Platform-only GCP manual gate/root baseline; OrbStack v2 failed-cutover verified restore; no post-reopen loss of claim/customer writes. |
| Logging | Only intentional synthetic issuance contains URL; no body/cookies/email/hash/password/TOTP/recovery elsewhere. Harmless real cloud mapping/IAM/view proof; no production URL artifact. |
| Capacity | Enforced GCP2cap/reject extra, bounded provisioning/pools/worker, PG reserves/noOOM/drain; real default-platform-tenant restore with separate keys/role recovery and fault drills. |

Implementation requires actual startup/HTTP claim smoke/browser-Caddy journey/PG races/restore, not unit tests alone. Run npm run check, NODE_ENV=test npm test with disposable SHOP_TEST_DATABASE_URL, applicable controller/integration checks then. None reported executed here.

## 8. Phases P1–P11 (one bounded omp job each)

Default off all slices, affected API/onboarding/security/deploy docs updated with behavior; intermediate slices no enablement permission.

| Phase | Deliverable | Gate |
| --- | --- | --- |
| P1 Contract | Q1/Q2/log exception/admin host/GCP bounds, no code. | No contradictory status/recovery promise. |
| P2 Migration | Email/state/audit/v2/fresh init. | Empty/existing/rollback/immutability PG proof, shop unchanged. |
| P3 Mode/email | Exclusive config/existing login UI/API/legacyNULL. | Real login/lockout/config/bootstrap smoke, no issuance. |
| P4 Issuance — implemented locally | Startup/hash/rotation/expiry/audit/emission/reconnect-maintenance; UUID generation and P2 hash-only singleton/history layout retained. | PostgreSQL runtime tests exercise overlapping starts, restart supersession, expiry without renewal, reconnect, maintenance and log/storage isolation. No deployment or cloud-log receipt verified. |
| P5 API — implemented locally | Shop-origin status/atomic claim/limits/audit/dispatch; authoritative PIC contract above replaces validate/challenge proposal. | PostgreSQL race, rollback, expiry/off/exhaustion, validation, restricted-session/MFA tests and actual Node HTTP claim smoke passed. Separate-host browser continuation requires admin-origin password login. |
| P6 Page — implemented locally | Node-gated exact loader/form/assets; backend packaging, immediate history clearing, generic errors and config-derived handoff; separate-host sign-in preserves P5 cookie boundary. | Scoped PostgreSQL gating and deterministic DOM execution; browser rendering, real edge and image build remain UNVERIFIED. |
| P7 Edge | GCP setup/admin/tenant gating, OrbStack Caddy untouched. | Real hostmatrix/usable tenant URLs. |
| P8 GCP release gate | Platform fingerprint/root-runtime/manualbaseline, image-only updater. | Negative controller/platform-only schema gate. |
| P9 Capacity | Configurable cap legacy20/dynamicUI/GCP pools-provision. | Concurrent workload DB-memory proof. |
| P10 Tooling | Setup Linux context/permissions preserving OrbStack, secrets/log/gateway/multiDB backup-restore. | Disposable complete journey/restore; harmless cloudlog authorized proof. |
| P11 Activation | Authorized manual GCP enablement, owner claim/MFA, private evidence/auditedbaseline. | Closed setup/real tenant/default intact/recoverable backup/no owner Docker-env-file onboarding. |

P2, P3a, P4 and P5 are implemented locally as noted above. Activation requires explicit operational authority/reachable evidence, not just this plan.

## 9. Open questions / UNVERIFIED

1. **Q1 PIC decision:**200loader plus404validation/mutation or explicitly different fragment bootstrap; fragment-dependent initial statuses impossible. Blocks public page implementation, not design completeness.
2. **Q2 recovery exception:**startup-only expiry requires trusted restart; agent project backend preferred, owner VM Restart emergency/disruptive. Confirm rather than public renewal/hidden Docker-env-files.
3. **Live GCP UNVERIFIED:**roles/admin/latch/collision/owner privileges/driver/metadata/logging IAM-scopes-view-export-retention-latency/owner read/gateway IP policy. Repo only json-file; investigate approved alternatives if one transport fails.
4. **DNS/TLS UNVERIFIED:**proposed admin.demoonlineshopping.xyz not verified deployed; authorized inspection/provision needed, no seller/customer fallback.
5. **Capacity proposed not proven:**GCP2cap still load/slots/RAM/swap/scrypt/worker/log rehearsal; OrbStack20 proof does not transfer. No resize/paid/budget change authority.
6. **Operational gaps:**GCP controller lacks migration runner/multiDB scheduler/privileged manual-baseline command. Reviewed tooling/protocol/restore proof before activation, no casual state edits/image rollback assumptions.
7. **OrbStack historical:**R4 one unenrolled admin not current assertion; preserve actual account/MFA/email. Inventory collision before opt-in, no auto rename/delete.
8. **Assurance limits:**no email delivery/verification/recovery, no unauthenticated all-factors recovery, no multi-replica handoff/exactly-once cloud delivery.

Initial design verification was source/runbook inspection only. P5 local API/runtime verification is recorded above; browser, edge, capacity, restore and deployment acceptance remain future gates.
