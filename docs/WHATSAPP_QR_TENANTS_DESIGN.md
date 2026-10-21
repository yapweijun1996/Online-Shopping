# WhatsApp QR for platform shops

Status: design with job 2 platform policy, job 3 static broker and job 4 seller/SuperAdmin UI implemented locally; 2026-10-21. No deployment authorization. Requirements outside the implementation contracts below remain design decisions, not existing behavior. Historical evidence references are working-copy file:line ranges. Host figures supplied by the task are not independently measured here.

## Decision

Use **one isolated worker process/container per admitted shop**, with **two fixed operator-provisioned slots total**, including the default shop. Keep the existing default worker as slot 0; add one statically declared tenant worker as slot 1. SuperAdmin assigns/enables shops in these slots; the application never creates containers. No Docker socket in any container. Additional shops remain unavailable for QR until capacity is increased in a separate measured, manual infrastructure release.

This preserves C5's process isolation rather than replacing it with shared-process key custody (`docs/WHATSAPP_QR_DESIGN.md:158-162,210-224`). A shared N-session Baileys process would save runtime overhead but expose every loaded session to one dependency compromise or process crash; per-session JavaScript objects are not a security boundary [INFERENCE]. Separate containers limit a compromised worker's API credential and live Signal keys to its assigned shop; host/backend/platform compromise remains cross-shop risk. The current worker already constructs exactly one Session (`worker/whatsapp-qr/src/main.js:7-23`), so reuse it, not a new session scheduler.

### Capacity budget

- Task-reported physical RAM: ~1.96 GB; available with one idle worker: ~1.2 GB; idle worker RSS ~43 MiB. **UNVERIFIED here**, and idle is not paired/reconnect peak.
- Retain **384 MiB hard cap and 0.5 CPU per worker**, as currently configured (`compose.gcp.yaml:75-95`). Budget the full 384 MiB per admitted session, not 43 MiB. Two slots = 768 MiB worker ceilings. Existing backend/frontend/PostgreSQL ceilings total 624 MiB (384+48+192); combined ceiling = **1392 MiB**, excluding gateway, kernel and other host workloads (`compose.gcp.yaml:17-18,57-58,98-111`).
- Conservatively replacing the first worker's 43 MiB idle footprint with 384 MiB consumes 341 MiB more; adding a second full worker consumes another 384 MiB: 725 MiB additional. From ~1.2 GB available this leaves roughly **420–500 MiB**, depending on GB/GiB reporting. Therefore **two slots are the configuration ceiling, not unconditional permission to pair two sessions**. Require measured available RAM >=512 MiB throughout simultaneous pairing/reconnect/burst, no sustained swap-in/out and no OOM before opening slot 1. If this fails, keep one slot and resize before admitting another shop. Do not reduce safety reserve or count swap as RAM.
- Enabled reservations consume slots even when OFF, disconnected or temporarily unreachable. No oversubscription based on current socket count. Third enable returns 409 `QR_CAPACITY`; never silently displace another shop. Serialize admission in the platform DB. An operator configures which slots actually exist; SuperAdmin cannot raise that ceiling.
- Keep per-worker PID/tmpfs/read-only/capability limits. Add a Node old-space ceiling of 192 MiB to the worker environment; current worker environment has no such setting (`compose.gcp.yaml:78-95`). Heap limits do not bound native/RSS use. Paired-session resource measurements remain a release gate, not a prediction.

## Current behavior and constraints

| Observed repository behavior | Evidence |
| --- | --- |
| QR seller routes require default tenant, empty base path, keys, enabled flag and non-passwordless/non-public-demo mode; unavailable paths return 404. | `src/app.js:88-90,254-255` |
| Internal server always receives the default database and one token. Authentication is constant-time before JSON parsing; route bodies are capped. | `src/server.js:55-65,115-118`; `src/whatsapp-qr/internal-api.js:7-35` |
| Config rejects non-default WHATSAPP_QR_SHOP and global quick-login/public-demo activation. | `src/config.js:79-94` |
| Registry resolves canonical code to immutable tenant id/store, rewrites prefixes, redirects aliases and rejects inactive lifecycle states before opening a shop DB. | `src/platform/registry.js:8-12,75-110` |
| Runtime has an ACTIVE-only background-worker store lookup; tenant pool unseals tenant DB passwords and validates schema version. | `src/platform/runtime.js:89-96`; `src/platform/tenant-pool.js:20-34` |
| Each shop DB has one session row; generation, lease owner/expiry, revision and auth-version CAS already fence local operations. Encryption contexts currently hardcode default. | `src/whatsapp-qr/schema.js:4-20`; `src/whatsapp-qr/store.js:8-10,25-36,81-87,129-142` |
| Disconnect advances generation, clears auth/QR and cancels queued replies; worker attempts bounded logout on generation change. | `src/whatsapp-qr/seller-api.js:45-50`; `worker/whatsapp-qr/src/session.js:24-43` |
| GCP release record says all shop DBs reached 27 and worker was idle; real pairing/delivery was not verified. This is recorded evidence, not a live inspection in this task. | `docs/GCP_DEPLOY.md:346-362` |

“Demo shop” means a password-authenticated, persistent shop used by the owner for demonstration, with a dedicated test number and risk acknowledgement. It may be the default shop or a normal tenant and consumes a slot. **Do not enable real linked devices in the public-demo/passwordless sandbox.** The protocol's owner intent includes a Demo shop, but code explicitly rejects public-demo/quick login (`docs/WHATSAPP_QR_PROTOCOL.md:3-5`; `src/config.js:88-89`; `src/app.js:89`). No bypass is implied.

## Binding, credentials and control plane

### Fixed slots, tenant-scoped bearer credentials

Add a host-owned binding manifest mounted read-only **in backend only**, listing slot id, immutable shop identity, private credential-file reference and worker identity label. Slot 0 uses identity `default` permanently, preserving its existing encrypted data; slot 1 uses the platform tenant UUID, never its mutable code. The platform's default registry UUID is mapped to `default`, not used to reseal existing default QR records (`src/platform/runtime.js:55-59`; `src/whatsapp-qr/store.js:8-10`).

Generate an independent random 32-byte base64url token per slot binding. Mount each token only in backend and its assigned worker; no derivation from a shared root in workers and no plaintext/sealed tokens in platform DB. Backend must reject duplicate token values, duplicate identities, unknown slot names and inconsistent bindings at startup. Token lookup yields exactly one immutable tenant binding; no tenant selector in URL/body/header may override it. Keep internal routes unchanged. Never accept DB name, role, DSN, path or callback URL from workers.

SuperAdmin can enable only a shop already present in the reviewed host manifest. Otherwise return 409 `QR_WORKER_NOT_PROVISIONED` with non-secret operator guidance. This deliberately trades instant arbitrary-shop activation for process/key isolation and no container orchestration. Rebinding a slot is **host-only**: disable/drain old binding, stop its worker, fence/clear old auth, rotate token, change manifest/env, then start the new worker. No token may move between tenants.

### Store resolution and authorization

Extend the existing platform registry with an internal `resolveWorkerTenant(id)` (not a synthetic public Request). Read the registry row by immutable UUID from platform on **every** tenant worker request and seller QR operation; require ACTIVE, enabled binding, matching slot and binding epoch before opening its store through the existing tenant pool. Runtime owns registry/pool access and injects the resolver into the internal server and seller handlers. Reuse the ACTIVE re-read pattern in `src/platform/runtime.js:91-95`, not the public code/alias cache. Do not cache store-based authorization in the existing tenant handler cache (`src/app.js:578-582`). Default store remains independent of platform availability; its host enable flag/token continue to work without platform configuration.

Authorization order: authenticate token -> validate route/worker UUID -> fresh policy/lifecycle lookup -> resolve store -> body parsing -> existing per-shop transaction/fence. Invalid credentials must not open tenant databases. Platform failure denies tenant QR with 503, not fallback to default. Worker closes its socket on policy/auth/control failure before any later send; it cannot continue using an old successful control response. Default worker remains unaffected by tenant/platform failure.

Keep generation + auth-version + lease validation inside each shop DB. Add a binding epoch in platform policy and pass the observed epoch through broker operations; policy changes must serialize against admission/claims using a platform policy-row lock. Hold that authorization lock until the bounded shop transaction finishes (no provider/network I/O in it); lifecycle writes acquire the same lock. This orders policy revoke against durable claims despite separate databases. No distributed transaction is promised. After a policy commit, no new authorized DB operation may pass; a dispatch already claimed/sent may still complete or become RECONCILE. Never advertise instant remote cancellation.

### Disable, suspension and deletion

Platform policy is authoritative even if shop DB is down. Disable/suspend/request-deletion transaction marks binding disabled, advances epoch and records cleanup pending; it does not release/reassign a slot yet. A bounded runtime reconciler then locks that shop session, increments generation, sets OFF, clears QR/auth, cancels QUEUED and moves SENDING to RECONCILE without resend. Retain existing thread history/erasure rules. Failures remain pending and retry locally; no cross-tenant fallback. Worker shutdown/control revocation closes socket; remote logout is best effort and UI advises unlinking in official WhatsApp.

A slot becomes reusable only after cleanup succeeds and its old worker has acknowledged stop, or the host has explicitly stopped it. Platform resume/cancel-deletion does not reactivate QR: explicit SuperAdmin enable and Owner Pair required. PURGED/missing/PROVISIONING/FAILED deny access. Purge must refuse unresolved QR cleanup and stop/retire the static binding before database removal. Existing lifecycle changes use revision CAS and invalidate the registry, but have no QR orchestration (`src/platform/shops.js:45-85`). Current worker tick errors end the socket (`worker/whatsapp-qr/src/main.js:19-23`); preserve this fail-closed property with explicit revoked handling and code-only logs.

## Schema and crypto cutover

**Shop schema stays 27.** Tables already belong to each shop database; no tenant_id columns/shared message tables are needed (`src/whatsapp-qr/schema.js:4-42`; `src/db.js:10,607-614`). Existing upgrade enumerates ACTIVE/SUSPENDED/DELETING tenant databases and upgrades through the current shop version (`scripts/upgrade-platform.mjs:27-42`); new provisioning opens the current PostgreSQL schema (`src/platform/provisioner.js:93-105`; `src/postgres-db.js:16-21`). Do not infer that every external installation is upgraded from the GCP release record; verify each before enable.

Parameterize **all** store crypto contexts by immutable identity, including peer-HMAC key and thread peer records, and pass it to seller, internal and contact-erasure callers. Default stays byte-for-byte `default`; tenant UUID contexts have no legacy default fallback. Existing per-DB limiter keys named default remain DB-local (`src/whatsapp-qr/seller-api.js:15-18,40,101-102`), so do not create unnecessary limiter schema changes. Refuse admission of a tenant with pre-existing nonempty QR auth/peer material sealed under the old default context; require an explicitly reviewed reseal/reset procedure rather than silently discarding it. No such tenant data was established in this investigation.

**Platform schema 3**, explicit opt-in migration `src/platform/migrations/003-whatsapp-qr.sql`; preserve immutable v1 baseline and migration 002. Current legacy target is 1, claim target 2, and open refuses incompatible versions rather than migrating existing databases (`src/platform/platform-db.js:5-20`; `src/platform/migrations.js:5-23`). Add a QR schema target/explicit upgrade option; retain unflagged legacy migration target 1, allow compatible updated runtime to open 3 without enabling claims or QR, and never auto-upgrade existing v1/v2 on startup. Explicit v1->3 runs 002 then 003; it does not activate claim issuance.

Proposed table `tenant_qr_binding`: tenant_id PK/FK tenant, slot_id UNIQUE, enabled boolean, epoch positive integer, cleanup_pending boolean, revision nonnegative integer, updated_at, updated_by. Rows are reservations; cleanup-pending rows retain slots. No session keys, token, bodies, QR text or full phones. Backend maps host slot configuration to this table; DB assignments cannot expand host permission. Migration extends platform audit CHECK with QR_ENABLE, QR_DISABLE, QR_CLEANUP, QR_BINDING_RETIRED. Use existing append-only audit machinery (`src/platform/schema.sql:65-81`). Admission serializes on a singleton capacity row containing revision (also added by 003), verifies host ceiling and existing reservations, then CAS-updates binding/tenant revision and audits. Record the default reservation for capacity/display when platform exists, but default runtime authorization stays host-local; reserve slot 0 unconditionally in admission calculations so platform outage/deletion cannot free it accidentally.

Platform DDL, scripts and compose/controller configuration require a **manual protected release**: updater protects src/platform, configuration and deployment paths and does not run migrations (`deploy/gcp/update.py:21-22`; `docs/GCP_DEPLOY.md:70-78`). Update backup inventories/restore rehearsal to include new platform rows; restored bindings start disabled/cleanup-pending under an operator recovery gate, never automatically reconnect restored device sessions. No change to the schema-27 SQLite import exclusion contract (`docs/WHATSAPP_QR_PROTOCOL.md:152-156`).

## UI and documentation contract

- SuperAdmin shop detail: provisioned/not provisioned, enabled, slot occupancy/capacity, safe state/heartbeat/error and cleanup pending; Enable/Disable requires full MFA session, exact Origin, CSRF and expectedRevision. Never expose QR, token, auth keys or chats to SuperAdmin. Add explicit default-shop QR controls separate from generic lifecycle mutations, which currently reject default (`src/platform/shops.js:52`; auth pattern `src/platform/admin-routes.js:25-46`).
- Seller: reuse existing QR/settings/chats surfaces with relative URLs; show disabled-by-platform, capacity/not-provisioned, unavailable and revoked states. Owner still acknowledges/pairs/disconnects; ordinary role/session capabilities remain enforced (`src/whatsapp-qr/seller-api.js:23-50`; `src/app.js:254-278`). Revocation clears QR and composer immediately on next response; do not persist QR. No public-demo exception, automation, bulk send or Cloud failover.
- Update protocol one-shop binding section, design C5 capacity, seller guide, GCP release/runbook and tenant onboarding. Update threat-model private worker section to cover slot credentials, registry policy, cross-database revocation, per-tenant AAD, shared-host OOM and restore gate. Current threat model describes default-only binding and plaintext text retention triggered by polling (`docs/threat-model.md:388-415`). Disabled shops still need bounded retention cleanup by backend reconciler; otherwise stopping control polling stops that cleanup. Preserve bans/privacy/remote logout warnings; real pairing remains unverified (`docs/GCP_DEPLOY.md:361-362`).

## Bounded implementation jobs

Each row is one omp job, with its own behavior docs and runtime smoke. Tests use fake sockets, fictional shops and no provider traffic. Proposed new filenames are explicit, not claims that files already exist.

| Job | Exact implementation files | Acceptance / smoke |
| --- | --- | --- |
| 1. Tenant-bound store crypto | `src/whatsapp-qr/store.js`, `src/whatsapp-qr/seller-api.js`, `src/app.js`; extend `test/whatsapp-qr-internal.test.js`, `test/whatsapp-qr-seller.test.js` | Trace/migrate every createWhatsAppQrStore caller including erasure in app. Default ciphertext remains readable; identical peer/message ids in A/B isolated; copied auth, peer-key and thread ciphertext fails under other UUID; erasure-before-ingress stays suppressed in both DB dialects. Smoke actual two-store ingress/claim/erasure. No tenant activation yet. |
| 2. Platform policy/admission/lifecycle | new `src/platform/migrations/003-whatsapp-qr.sql`, new `src/platform/whatsapp-qr.js`; `src/platform/platform-db.js`, `src/platform/migrations.js`, `src/platform/runtime.js`, `src/platform/registry.js`, `src/platform/shops.js`, `src/platform/admin-routes.js`, `scripts/upgrade-platform.mjs`, `deploy/purge-tenant.py`; `test/platform-claim-upgrade.test.js`, `test/platform-shops.test.js`, new `test/platform-whatsapp-qr.test.js` | Explicit v1/v2->3; unflagged legacy stays 1; no startup migration; audit constraints/restore. Concurrent enables cannot exceed slots; suspend/disable racing claim ordered; DB-down cleanup survives restart; resume never auto-enables; default cannot be displaced; purge pending denied. Smoke PostgreSQL lifecycle with two shop DBs and backend restart. |
| 3. Broker and static worker bindings | `src/config.js`, `src/server.js`, `src/app.js`, `src/whatsapp-qr/internal-api.js`, `src/platform/runtime.js`, `src/platform/registry.js`; `worker/whatsapp-qr/src/config.js`, `client.js`, `main.js`, `session.js`; `test/whatsapp-qr-internal.test.js`, `test/whatsapp-qr-seller.test.js`, `worker/whatsapp-qr/test/worker.test.mjs`, `boundaries.test.mjs` | Manifest validation, one token->one store, no selector override, bad token opens no DB, rename stable, suspended/deleting rejected, stale epoch/generation/lease/auth CAS refused, persistence/control loss closes only affected socket, late send RECONCILE. Smoke two real internal HTTP clients plus seller sessions through prefixed APIs, synthetic pairing/inbound/reply/disconnect, no real WhatsApp. |
| 4. Seller/SuperAdmin UI | `public/platform/app.js`, `public/platform/index.html`, `public/platform/style.css`; `public/seller/whatsapp-qr.js`, `whatsapp-qr-ui.js`, `whatsapp-qr-copy.js`, `whatsapp-chats.js`; `test/whatsapp-qr-ui.test.js`, `test/platform-assets.test.js` | Browser default+A/B at 390 and 1280 px: capability denial, MFA/CSRF/revision errors, provision/capacity messaging, revoke while QR visible, no stale composer, rename/prefix URLs, no cross-shop cookies/history, keyboard/status accessibility, no QR in cache/storage. Exercise actual UI with synthetic backend. |
| 5. Fixed-slot GCP release tooling | `compose.gcp.yaml`, `deploy/gcp/update.py`, `test/gcp-deploy.test.py`, `test/gcp-platform.test.py`; new `deploy/gcp/whatsapp-qr-bindings.example.json`; update `docs/GCP_DEPLOY.md`, `docs/WHATSAPP_QR_PROTOCOL.md`, `docs/WHATSAPP_QR_DESIGN.md`, `docs/WHATSAPP_QR_GUIDE.md`, `docs/TENANT_ONBOARDING.md`, `docs/threat-model.md`, this design | Compose has exactly two static workers, disjoint token mounts, no socket/ports/master key/DB credentials in workers; updater pulls same reviewed digest, checks both enabled workers, stop-before-start and rollback cannot overlap old bindings. Offline controller suite plus actual isolated Compose synthetic smoke and resource drill; no production mutation in job. |

All implementation jobs run `npm run check` and `NODE_ENV=test npm test` with PostgreSQL available; worker/deployment jobs also run worker tests and `python3 test/gcp-deploy.test.py`. These are future acceptance requirements, not results of this design task. No dependency addition is needed for multiplexing or orchestration.

### Job 2 implementation contract

Platform policy is implemented independently of worker activation. Run
`node scripts/upgrade-platform.mjs --with-qr` explicitly to apply 002 then 003;
`--with-claim` still targets 2 and unflagged upgrades still target 1. Startup
does not migrate existing databases. Shop schema remains 27.

Full-MFA SuperAdmin endpoints are `GET /api/v1/platform/shops/:id/qr` and
`POST /api/v1/platform/shops/:id/qr/enable` or `/disable`. POST accepts only
`expectedRevision` (the tenant revision), exact console Origin and session CSRF.
The runtime receives `config.platform.qrTenantSlots` (default 1, excluding slot 0)
and `qrProvisionedTenantIds` (default empty). These are host inputs, never admin
request fields. Default uses slot 0 only and cannot consume a tenant slot.
Disabled/cleanup-pending reservations continue consuming capacity.

`registry.resolveWorkerTenant(id, slot, epoch, work)` authorizes fresh state and
holds the platform transaction/capacity lock through `work`; the callback must
perform only bounded shop operations, not provider I/O. Job 3 must wire all
broker/seller operations to this boundary and replace provisional tenant-id
admission with validated static manifest bindings. No worker activation is
implemented by job 2.

Suspend and deletion requests persist disabled/pending state and advance epoch
even with the shop DB down. Resume/cancel-deletion never enable QR. Runtime
accepts a host-only `qrCleanupAndStop(binding)` callback and retries pending rows
on its maintenance pass; absent callback leaves reservations pending. It must
return true only after durable shop generation/auth/queue cleanup and confirmed
worker stop. Job 3 must supply that real implementation; no callback may infer
stop from an unreachable worker. Successful retirement appends QR_CLEANUP and
QR_BINDING_RETIRED and removes the reservation. Purge rejects any remaining
reservation under the same platform writer lock before database removal.

Jobs 4–5 must wire safe policy/status UI and host stop/retirement, manifest,
restore-disabled recovery and release tooling. A restore must disable bindings,
mark cleanup pending and advance epochs before workers are started; do not
automatically run restored enabled reservations. This remains a manual recovery
gate, not an automatic startup transformation.

### Job 3 broker contract

`WHATSAPP_QR_BINDINGS_FILE` names a backend-only JSON array. Each entry has
`slot` (0 or 1), `shopId` (`default` for 0, lowercase tenant UUID for 1),
`tokenFile` (absolute backend path), and `workerLabel` (bounded safe label).
Slot 0 is required. Each credential file contains an independent 32-byte
base64url token (43 characters). Duplicate slots, identities or token values
fail startup without disclosing file contents. Without this variable the
existing `WHATSAPP_QR_TOKEN_FILE` configuration remains unchanged.

The manifest supplies platform provisioning/capacity inputs; it does not enable
policy. Tenant control returns `X-Binding-Epoch`; the worker echoes it on later
operations. Fresh control discovery may omit it, but mutations cannot. Policy
authorization holds the existing capacity lock through each shop operation.
Disabled/revoked tenants return 403 `QR_REVOKED`; missing static provisioning
keeps seller routes at 404. Tenant platform failure is unavailable, not default.

On revocation the worker ends the socket, drains pending session events and
acknowledges `POST /internal/whatsapp-qr/v1/stopped` using its existing credential.
The backend records stop only for a currently disabled cleanup-pending binding,
scoped to its epoch. Maintenance performs durable shop cleanup and retires only
with that acknowledgement or host confirmation. An unavailable shop or worker
leaves the reservation pending. A revoked worker requires an operator restart
before later activation; it never resumes its old session automatically.

Job 4 supplies safe policy/revocation presentation below. Job 5 still owns read-only manifest
mounts, separate worker credentials, explicit host stop/restart, restore-disabled
recovery, deployment health checks and measured resource/release gates. No
production provisioning or real WhatsApp pairing is implied by synthetic tests.

### Job 4 UI behavior

Shop detail includes a separate QR policy panel, also for the default shop.
Enable/Disable uses the existing full-session API client, CSRF header and tenant
revision, with a keyboard-accessible confirmation dialog. Reserved tenant capacity
excludes slot 0 and includes disabled reservations awaiting cleanup. The console
does not fetch seller QR or chat APIs. Shop detail returns only the last reported
worker state, heartbeat timestamp and an error-present boolean, never error text,
phone numbers, keys or QR material. Last reported state is not a live health check.

Seller settings show localized platform revocation, missing provisioning,
capacity and temporary-unavailability messages. A failed policy response clears
the rendered QR; chats clear drafts and disable sending on policy/access failure.
Unknown reply outcomes retain their idempotency intent for safe manual retry.
URLs continue through the existing tenant-aware relative API helper. QR data is
never persisted. Revocation is observed on the next response, not instant remote
cancellation; unlink the device in official WhatsApp and have the host restart
the revoked worker before reactivation.

Local UI verification uses synthetic API responses, never provider traffic.
Browser smoke at 390 and 1280 pixels covered default/Alpha/Bravo QR revocation,
draft clearing, disabled composers, tenant API paths and horizontal overflow.
The opt-in platform asset browser test exercises confirmation, revision/CSRF
payloads, MFA/CSRF/revision errors, default controls and pending/unprovisioned
disablement. This is not handset pairing, remote logout or delivery evidence.



## GCP release sequence

1. Review full policy/DDL/credential diff and CI-approved immutable backend/frontend/worker digests. Inspect actual host RAM, paired workload peaks, schema versions and current bindings privately; do not treat historical docs as live health. Confirm platform activation and owner MFA. Keep slot 1 unavailable until its capacity drill passes.
2. Stop updater timer/service; preserve controller/config/state/current and previous digests. Pause application QR work and stop all workers before migration. Take coordinated private platform + all shop backups and restore-test in isolated PostgreSQL 16, including row counts/schema and recovery-disabled QR state. Follow existing protected-release rule (`docs/GCP_DEPLOY.md:74-78,348-352`).
3. Run the new explicit platform QR migration using the reviewed image/script, target 3; validate shop schemas remain 27. Do not repurpose existing `--with-claim` to silently mean QR. Preserve migration report; failures stay maintenance-blocked until reviewed repair/restore. Old v1/v2-only binaries are not schema-3 rollback candidates.
4. Install reviewed static compose, binding manifest, independent secret files and controller allowlist/health updates. Provision no Docker resources from app. Keep tenant policy disabled. Preserve slot-0 identity/token and default encrypted records; start compatible backend/frontend, then slot 0, then slot 1 after its binding is validated. No overlapping old/new workers. No PostgreSQL recreation, public port or edge route for :3001.
5. Verify readiness/digests, public internal-path 404, internal unauthenticated 401, prefixed seller isolation, disabled tenant rejection, lifecycle fencing, duplicate worker lease rejection and private egress guard. Drill synthetic simultaneous loads/reconnects while recording RSS/cgroup peaks, host available/swap/OOM. If reserve fails, leave slot 1 disabled and resize in a separate release.
6. SuperAdmin enables the admitted tenant; its Owner acknowledges and pairs a dedicated controlled number. Prove handset pairing, one live inbound, one human reply and actual handset receipt, then disable/suspend/restart/unlink drill. These owner-device steps cannot be proven by CI. Default/demo shop undergoes the same consent/risk controls. No buyer test sends.
7. Record revision/digests, platform 3/shop 27 versions, capacity measurements, redacted lifecycle and phone acceptance evidence. Only then establish reviewed controller baseline and restart timer. Existing updater checks only the single worker's running digest today (`deploy/gcp/update.py:195-238`); neither that nor backend readiness proves pairing/delivery.
8. Rollback: disable policies and stop workers first; retain schema 3 and use only a tested compatible previous image/config, or perform a separately reviewed full DB restore with recovery gate. Never restore old enabled bindings/auth and auto-connect. Keep timer stopped on unresolved acceptance; no state deletion/reinitialize to bypass gates.

## Verification limits

The original investigation was source-based. Job 2 has local PostgreSQL migration/admission/lifecycle tests and admin-route/purge smoke evidence; job 4 has the synthetic browser verification recorded above. Neither establishes deployed tenant worker support. No host inspection, phone scan, live send, deployment or resource measurement was performed. Task-provided RSS/RAM figures and recorded GCP acceptance remain distinct from locally exercised behavior. Release acceptance must supply its own evidence, not convert estimates into readiness claims.
