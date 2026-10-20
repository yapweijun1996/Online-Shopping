# Online Shopping Threat Model

Evidence base: R1–R4 release source and actual verification dated 2026-10-11; exact SHAs, CI and production state are recorded in MULTI_TENANT_LEDGER.md. Statements describe what the code does today; anything else is labelled **Planned**, **Partial** or **Missing**. Update this file when a trust boundary, entry point or control changes.

Source review at `41407a7bda20adf167e2825900a268f3949316cc`: [CODEBASE_BUG_REVIEW.md](CODEBASE_BUG_REVIEW.md) preserves 15 confirmed findings. B01–B07 are fixed and locally verified; B08–B15 remain open. These checks do not establish production deployment or activation. Invariants below remain required properties.

## 1. Scope

### Currently implemented

| Component | Evidence | Notes |
| --- | --- | --- |
| Node HTTP server | `src/server.js` | Node `http` server; converts requests to Fetch `Request`; 10 s request/header timeouts. |
| API router | `src/app.js` | Runtime-neutral `createApi({ store, config, serveStatic })`. All routes live here. |
| Customer interface | `public/shop/` | Static PWA served at `/shop/`. Guest checkout, no accounts. Cart and "My orders" in browser storage (IndexedDB/localStorage). |
| Seller / admin interface | `public/seller/` | Static PWA at `/seller/` and tenant-prefixed addresses. Per-shop Owner/Manager/Staff; separate SuperAdmin at `/platform/` on the admin host. |
| Demo interface | `public/demo/`, `src/demo-sandbox.js` | Fictional in-memory sandbox (roles `ADMIN`, `SELLER`, two fictional companies). Enabled only when `SHOP_MODE=public-demo` and the shop setup mode is `demo`. |
| Authentication | `src/auth.js` | Per-shop seller_account, scrypt hashes and scoped seller_session; separate platform_admin with mandatory TOTP/recovery and restricted/full platform sessions. |
| Storage | `src/store.js`, `src/db.js`, `src/postgres-*.js`, `src/postgres/schema.sql` | SQLite (`node:sqlite`) for local/dev/tests; PostgreSQL 16 in production. Same store contract. |
| Edge / runtime | `compose.production.yaml`, `deploy/Caddyfile.production`, `deploy/cloudflared.yml` | Cloudflare Tunnel → Caddy (`frontend`) → Node (`backend`) → PostgreSQL on an internal Docker network. Shop/seller prefix routing plus a dedicated admin hostname and separate tunnel. |
| Deployment automation | `deploy/auto-update.py`, `deploy/backup-postgres.py`, `.github/workflows/verify.yml` | Host-side poller deploys `main` after the `verify` workflow succeeds on that exact SHA; backups; rollback. |
| Offline integration foundation | `src/integration-contracts.js`, `-requests.js`, `-ledger.js`, `-consent.js`, `-ingress.js`, `-adapters.js` | Synthetic ledger/consent/ingress/adapters use fixture transport and on-demand `integration_demo_*` tables, with no runtime route. Shared signature/response-normalization helpers are reused by real WhatsApp; the synthetic ledger itself is not wired into order routes. |
| WhatsApp Cloud runtime | `src/integration-connections.js`, `src/secret-box.js`, `src/whatsapp-transport.js`, `src/whatsapp-outbox.js`, `src/whatsapp-inbound.js` | Optional real connection verification/template sends and signed public webhook. Credentials are sealed at rest; sample sign-in disables connection management and sends for that shop. This runtime is separate from the synthetic ledger/ingress. |

### Not implemented (planned or removed)

- Payments: none. There is no payment provider, payment state, refund flow or payment webhook. `docs/SPEC.md` lists "no online payment" as an MVP boundary.
- Ninja Van / SPX / any courier: no live integration. Only contract helpers (`ninjaContractLocation`, `verifyNinjaSignature`) and synthetic fixtures exist. Seller enters carrier and tracking number manually when shipping.
- Payment/courier public webhook endpoints: none. WhatsApp's implemented endpoint requires a connected account and, for POST processing, configured integration keys.
- Per-shop databases/roles, seller Owner/Manager/Staff and platform TOTP: implemented and tested. Production platform activation and bootstrap counts follow the R4 ledger; the shop schema remains 24.
- Cloudflare Worker and Durable Object: the Worker deployment was removed (`docs/RUNBOOK.md`, 2026-10-06). `worker-runtime/` (including `durable-store.js`) remains as a tracked copy of the runtime that tests import; no Worker entry point or `wrangler` config is tracked. Treat it as dead for deployment but still review it for divergence.
- Customer accounts, password reset, email/OTP verification: none by design.
- Image upload endpoints accept JSON data URLs from the authenticated seller only (no multipart upload).

## 2. Protected Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Seller accounts and privileges | `seller_account` table (scrypt hash, role, active flag), `account_event`; `ADMIN_USERNAME`, `ADMIN_PASSWORD_FILE` only bootstrap the first Owner | Owner, Manager and Staff roles (`src/roles.js`) are enforced on every `/api/v1/seller/*` route; the Owner controls settings, accounts, export and erasure. |
| Authentication sessions / tokens | `session` table (SHA-256 of token, CSRF token); cookie `seller_session` | Session theft equals full admin access. |
| Customer PII | `shop_order` (buyer name, phone, email, WhatsApp consent), `delivery` (recipient name, phone, address) | Visible in full to the admin; guests see only status. |
| Order status access keys | Client `crypto.randomUUID()` used as the `Idempotency-Key`; server stores `SHA-256` in `checkout_idempotency.key_hash` | Bearer credential for `POST /api/v1/orders/statuses`. |
| Orders and order totals | `shop_order`, `order_item` (price/name/SKU snapshots), `order_event` | Integrity of what was sold at what price. |
| Product/catalog data, pricing, stock | `product`, `product_gallery_image`, `general_code`, `company_setting` | Price and stock drive server-side totals. |
| Cart state | Browser IndexedDB/localStorage | Untrusted client state. |
| Order, fulfillment and tracking state | `shop_order.status`, `revision`, `tracking_carrier`, `tracking_no` | One status column covers submit/confirm/ship/deliver today. |
| Payment status, refund state | none | Not implemented; becomes a P0 asset when payments are added. |
| Audit records | `order_event`, `account_event`, `product_event`, `integration_audit`, erasure markers; separate `platform_audit` | Order/account/catalog/integration/platform changes have their own evidence. Shop audit tables remain writable by the app role; platform audit rejects rewriting/deletion. |
| Webhook secrets, provider API credentials | AES-256-GCM sealed `integration_connection.secret_ciphertext`; keys loaded from `INTEGRATION_KEY_FILE` | Real access tokens, App Secrets and sender-hash keys are opened only server-side. Offline simulation records separately use credential references. |
| WhatsApp reply/message history | `message_inbound`, `message_outbox`, `webhook_receipt` | Reply bodies are personal text; keyed sender hashes support threading, outbox outcomes control duplicate-send recovery. |
| Infrastructure secrets | `.local/*` secret files, Cloudflare tunnel credentials, Postgres passwords, `.env` | Host-only, mounted as Docker secrets; gitignored. |
| Database contents and backups | PostgreSQL volume `pg_data`, `deploy/backup-postgres.py` output | Contain all PII. Backups are unencrypted by owner decision (`docs/MULTI_TENANT_PRODUCTION_PLAN.md`). |
| Deployment pipeline integrity | GitHub `main`, `verify` workflow, `deploy/auto-update.py` | Pushing to `main` that passes CI is deployed automatically to production. |

## 3. Trust Boundaries

```
Customer browser (shop host) ──HTTPS──► Cloudflare ─► Tunnel ─► Caddy ─► Node API ─► PostgreSQL
Admin browser (seller host)  ──HTTPS──► Cloudflare ─► Tunnel ─► Caddy ─► Node API ─► PostgreSQL
Public demo visitor ──► /api/v1/demo/* ──► in-memory sandbox (no store handle)
GitHub main + CI ──► host-side auto-update.py ──► docker compose (production)
Host secret files ──► Docker secrets ──► backend / postgres / tunnel containers
Backend WhatsApp worker ──HTTPS──► Meta Graph API
Meta ──signed HTTPS webhook──► shop host / tenant prefix ──► backend
```

1. **Customer browser → API** (shop hostname). Untrusted. Guest endpoints: catalog, order create, order status. Caddy returns 404 for seller and demo paths on this host.
2. **Admin browser → API** (seller hostname). Authenticated by session cookie plus CSRF header plus exact `Origin`. Caddy returns 404 for `/shop`, `/api/v1/orders*` and demo paths on this host. Caddy host separation is defence in depth; the Node API also enforces the session on every `/api/v1/seller/*` route and picks the expected origin by path prefix.
3. **Edge → backend.** Backend is on the internal `private` network; only `frontend` (Caddy) is on `edge`. Client IP comes from `X-Real-IP` set by Caddy from `CF-Connecting-IP`, honored only when `TRUST_PROXY=1` and the value is a valid IP.
4. **API → database.** The app connects as `online_shopping_app` with `SELECT, INSERT, UPDATE, DELETE` on all tables (`deploy/init-postgres.sh`). Queries are parameterized.
5. **Demo sandbox → rest of the system.** `createDemoSandbox` receives no store, session or credential; state is bounded in memory.
6. **CI/CD → production.** `auto-update.py` trusts `yapweijun1996/Online-Shopping` `main` plus a successful `verify.yml` run on the same SHA, and refuses releases that change the protected files listed in `PROTECTED`.
7. **Application → external providers.** `src/whatsapp-transport.js` verifies connections and sends templates to a fixed Meta Graph API host with a timeout. The worker sends outside database transactions through this boundary; order routes never call providers. Payments/couriers and the separate synthetic ledger have no live transport.
8. **External provider → webhook endpoint.** `/api/v1/webhooks/whatsapp` and its tenant-prefixed route authenticate raw bytes using a connected account's App Secret, then deduplicate/process receipts and replies. There is no seller session/Origin/CSRF requirement on provider callbacks. Shared-secret connection selection has an open defect (review B08).

## 4. Entry Points

All HTTP routes are in `src/app.js` (path constants at the top, handlers in `route()`).

**Unauthenticated**
- `GET /health`, `GET /ready` (DB readiness).
- `GET /api/v1/shop`, `GET /api/v1/products` (query: filters, search, paging via `listProducts`), `GET /api/v1/products/{uuid}` and `/image`, `GET /api/v1/products/{uuid}/gallery/{uuid}`.
- `POST /api/v1/orders` — guest checkout. Origin check, `checkout` limiter (30 per 15 min per client IP), body ≤128 KiB, required `Idempotency-Key` (16–128 chars). Logic in `src/orders.js` and `src/checkout-input.js`.
- `POST /api/v1/orders/statuses` — status lookup by `{orderNo, accessKey}` pairs (≤50 per call, UUIDv4 key). Origin check, `order-status` limiter (30 per 15 min per IP).
- `POST /api/v1/seller/session` — admin login. Origin check, `login` limiter (5 per 15 min per IP, cleared on success), username ≤64, password ≤256.
- `GET` and `POST /api/v1/webhooks/whatsapp` — called by Meta, so there is no session, origin or CSRF check; the HMAC-SHA256 signature over the raw body (`X-Hub-Signature-256`, constant-time compare) against the sealed app secret of a connected account is the authentication. `whatsapp-webhook` limiter (600 per 15 min per client IP), body ≤256 KiB, dedupe by the SHA-256 of the raw body in `webhook_receipt`. Unsigned or wrongly signed requests get 401 and store nothing. `GET` is Meta's subscribe handshake and answers only with the stored verify token. Logic in `src/whatsapp-inbound.js`.
- `POST /api/v1/seller/demo-session` — default-shop sample entry when `SHOP_MODE=public-demo` or the explicit `SELLER_QUICK_LOGIN` configuration enables it; never enabled for non-default platform shops. `/api/v1/demo/*` separately requires public-demo configuration and demo setup.
- Static files via `src/static.js` (`/shop/`, `/seller/`, `/demo/`, shared assets). Path traversal guarded by `realpath` containment and dot-segment rejection; strict CSP set on every response.

**Authenticated (session cookie; mutations also need `Origin` and `X-CSRF-Token`)**
- `GET/DELETE /api/v1/seller/session`.
- Setup: `GET/POST /api/v1/seller/setup`, `POST /api/v1/seller/demo/reset` (demo mode only; deletes orders, products, categories).
- Catalog: `GET/POST /api/v1/seller/products`, `GET/PATCH /api/v1/seller/products/{uuid}`, `.../image`, `POST .../gallery` (JSON data URL, ≤750 KB body), `GET/DELETE .../gallery/{uuid}` (product body limit 7.5 MB via `src/request-limits.js`).
- WhatsApp connection: `GET /api/v1/seller/integrations/whatsapp` (status, webhook URL, never a secret), `PUT` and `DELETE .../whatsapp/{SANDBOX|PRODUCTION}` (origin and CSRF, body ≤8 KiB, `integration-connect` limiter 10 per 15 min per IP; the provider is verified before anything is stored). While quick sign-in is on (a passwordless sample site) the reads return `available: false` and the writes 403, so a visitor can neither connect nor disconnect real credentials. Logic in `src/integration-connections.js`.
- WhatsApp messages: `GET /api/v1/seller/messages/{summary,replies,outbox}`, `GET /api/v1/seller/orders/{uuid}/messages`, `POST /api/v1/seller/messages/replies/{uuid}/read`, `POST /api/v1/seller/messages/outbox/{uuid}/resolve` (origin and CSRF on the POSTs, lists capped at 100 rows, body ≤1 KiB). Buyer reply text is personal data shown only to the signed-in seller as plain text; no phone number or sender hash is returned; empty and read-only while quick sign-in is on. Logic in `src/whatsapp-messages.js`.
- Settings: `/api/v1/seller/categories`, `/api/v1/seller/company-settings`, `GET /api/v1/seller/integrations` (static catalog, no credentials).
- Orders: `GET /api/v1/seller/orders` (status, search ≤40 chars, `limit` ≤100, `offset` ≤10 000), `GET /api/v1/seller/orders/summary`, `GET /api/v1/seller/orders/{uuid}` (full buyer and delivery PII), `POST /api/v1/seller/orders/{uuid}/{confirm|reject|ship|deliver|cancel}` (`src/seller-orders.js`).

**Non-HTTP**
- Environment/config: `src/config.js` (`ADMIN_*`, `DATABASE_*`, `PUBLIC_ORIGIN`, `SELLER_ORIGIN`, `TRUST_PROXY`, `SHOP_MODE`).
- Host automation: `deploy/auto-update.py` (polls GitHub API), `deploy/backup-postgres.py`.
- Offline-only (no entry point): `createOfflineMetaIngress` raw-body ingress, `verifyNinjaSignature`, `verifyMetaSignature`.

## 5. Threat Scenarios

Each item states the current behavior. "Status" follows the vocabulary in section 7.

### Authorization / IDOR
- **Customer reads another customer's order.** Guests have no account. The only guest read path is `POST /api/v1/orders/statuses`, gated by `orderNo` plus an access key whose SHA-256 must match `checkout_idempotency.key_hash` for that order. Returns status, `updatedAt`, tracking carrier/number only, within 90 days. Residual risk: the key is whatever UUIDv4-shaped value the client sends as `Idempotency-Key`; the server does not generate it and `createOrder` accepts any 16–128 character key, so a client (or a weak client implementation) could choose a guessable key. Status lookup requires the UUIDv4 shape but not randomness. Brute force is bounded by the limiter (30 requests/15 min/IP, up to 50 pairs each). Status: Partial.
- **Customer modifies another customer's order.** No guest write endpoint exists after creation. Idempotent replay with a known key returns the original receipt (order number, total) only; a different payload under the same key returns 409.
- **Seller reads or modifies another seller's products/orders.** Each resolved shop has its own role/store, seller cookie path and handler identity. A seller sees only that database and its account capabilities; negative PostgreSQL and same-profile browser tests prove cross-shop denial. Status: Implemented.
- **Privilege escalation to admin.** All `/api/v1/seller/*` routes except `session` (POST) and the configuration-gated `demo-session` require `readSession`. Roles come from the signed-in account (`OWNER`, `MANAGER` or `STAFF`). `SHOP_MODE: manual` alone does not disable passwordless sample entry if `SELLER_QUICK_LOGIN` explicitly enables it; that setting grants visitors the default shop's Owner workspace and must be restricted to intentional sample installations. Non-default platform shops force it off. The Demo sandbox keeps separate in-memory role/company checks.

- **Permanent erasure of buyer data by a visitor.** `POST /api/v1/seller/orders/{id}/erase-contact` destroys personal data irreversibly. It needs the Owner capability, a session, same origin, CSRF, the current revision and the typed order number, only works on finished orders, and answers 403 while quick sign-in is on. Existing contact fields/reply bodies are blanked in place; prior backups retain old values until expiry. `checkout_idempotency` keeps only hashes. Late inbound replies can repopulate an erased order and repeat erasure is refused (review B09). Status: Partial for continuing reply retention; visitor authorization is implemented.

- **Bulk export of buyer data.** `GET /api/v1/seller/orders/export.csv` returns names, numbers and emails for up to 5000 orders. It needs a session (a GET, so no CSRF token, and `SameSite=Strict` cookies keep other sites from triggering it), is refused with 403 on a quick sign-in site, is `no-store`, and neutralises spreadsheet formulas in buyer-controlled cells. Residual risk: the file leaves the system once downloaded; there is no per-download audit record yet. Status: Partial.

- **Account takeover and privilege escalation (SEL-04).** `GET /api/v1/seller/integrations/whatsapp` tells Managers and Staff only that WhatsApp is on (no connection details, no webhook URL). Roles come from the database on every request, never from the client or the session cookie, and are enforced per route with one capability table; a Manager or Staff call to an Owner-only route returns 403 before the resource is looked up (`test/seller-accounts.test.js` drives every route for every role). Login cost is constant for unknown, deactivated and wrong-password cases; the per-IP limiter (5 per 15 minutes) is the only brute-force control, and there is deliberately no per-username lockout because it would let anyone lock the Owner out. Passwords: 12 to 256 characters, scrypt, never returned or logged; account events record who changed what but never a password. A password change or reset ends the person's other sessions; a deactivated account is rejected on its next request. The Owner account cannot be changed through the API, so the shop cannot be left without an Owner; recovery is the host-side script. Quick sign-in sites refuse every account and password route, otherwise any visitor could take over the Owner. Residual risks: seller accounts have no second factor (platform SuperAdmin requires TOTP), no password-breach check, no login audit trail beyond `last_login_at`, no per-account session list. Status: Partial.
- **Environment password no longer authoritative.** `ADMIN_PASSWORD_FILE` creates the first Owner only; a leaked or stale secret file cannot reset an existing Owner. Rotating the Owner password is done in the app or with the reset script on the server.
- **Credential reset serialization.** Seller login verifies credentials and creates the session in one store transaction. Own-password changes recheck the active session, verify the password, replace the hash and revoke other sessions in one transaction. Host/API resets serialize with these operations; a reset that follows an in-flight login revokes that issued session. SQLite writer serialization and PostgreSQL advisory transaction locks cover the boundaries (regressions for B01/B02). Platform authentication keeps its separate transaction-bound flow.

- **Internal notes and product history (SEL-07).** Notes are seller-written free text on an order: append-only, 1000 characters, 50 per order, rendered with `textContent`, never returned by a buyer route. They can contain personal data the seller types, and erasure of contact data deliberately leaves them, so the UI warns against it. Product history is written in the edit's own transaction with the account name, is never changed by the application, and stores at most 4000 characters per entry. Bulk switching needs the catalog capability, is capped at 100 products and is all-or-nothing. Status: Implemented.

- **Catalog import (product CSV).** The import writes prices, stock and visibility in bulk, so it needs the catalog capability, origin and CSRF, and is bounded (1,000,000 characters, 2000 rows, 4000 characters per cell). Every value passes the editor's own validation; the commit re-checks everything in one transaction instead of trusting a preview, so a changed catalog between preview and commit cannot slip a bad row through; one error writes nothing. Variants cannot be created or regrouped by import, and every change lands in the product history under the account that imported it. A seller can still set a wrong price on purpose or by mistake: the preview shows old and new values and the history keeps them. Status: Implemented.

- **Platform core (R1; configuration-gated, production activation is R4).** `src/platform/` now includes password/TOTP/recovery-code authentication, restricted and full sessions, console routes, shop lifecycle, registry and per-shop stores. The exact configured admin host owns only `/platform` and `/api/v1/platform`; other hosts refuse them. No platform settings means the legacy server remains inert. Enabled but invalid file settings fail startup; runtime platform outage returns 503 only for platform/non-default paths. The default shop and readiness never query the platform database.
- **SuperAdmin takeover.** Password-only sessions last five minutes and permit only second-factor enrolment/confirmation. TOTP is sealed with tenant-independent admin context and checked with constant-time comparison; used steps and recovery codes cannot be replayed. Full tokens rotate at confirmation, expire after thirty minutes idle or four hours absolute, and use HttpOnly/Secure/Strict cookies scoped to the platform API. Exact Origin and CSRF protect every write, including password sign-in via an encrypted challenge. Account and IP lockouts are audited without secrets. Bootstrap never overrides an existing account. The executor must leave production TOTP unenrolled; until the owner's first sign-in, anyone holding the host-only bootstrap password could enrol. Host break-glass resets password, TOTP, sessions, recovery codes and lockout, with `ADMIN_RESET` audit.
- **Tenant boundaries and probing.** Each shop uses its own database and role; PUBLIC CONNECT is revoked. Root routes use the legacy store; valid non-reserved prefixes resolve through a bounded 1000-entry cache (30-second positive, ten-second negative), with an IP unknown-code probe limiter before cold lookup. Successful known-code lookups and platform lookup failures refund the temporary probe reservation; positive cache refreshes do not consume it. Invalid or unavailable tenants open no shop store. Tenant identities include store identity so eviction cannot retain a route table pointing at a closed store. Raw encoded path segments are rejected before URL normalization. Server-generated URLs and seller cookie paths include the tenant prefix. Non-default config forbids quick sign-in and removes legacy bootstrap/database credentials. Rename aliases are permanent; deletion requires suspension, typed code and thirty-day retention. The default shop is protected from console mutation.
- **Lifecycle cache races.** Every invalidation advances a generation; in-flight tenant/alias reads and shared cold lookups must re-read after a generation change. Expired bounded positive entries are probe hints only, never routing state. Same-IP/code cold readers share a lookup; every unknown attempt still consumes the thirty-attempt quota. Repeated mutation churn fails closed. Concurrent suspension/rename and cold forty-reader regressions cover the boundary.
- **Provisioner risk (X6, accepted).** `platform_app` owns only the platform database and has no CREATEDB/CREATEROLE. `platform_provisioner` is a separate non-superuser LOGIN with CREATEDB/CREATEROLE and `createrole_self_grant='set, inherit'`. These PostgreSQL 16 privileges permit acting as created tenant roles and therefore reaching every shop. The backend also holds the master key and sealed passwords: process or provisioner compromise crosses shops. Tests run as this non-superuser; a narrow privileged function remains future work. Generated identifiers are pattern-validated/quoted; failures store only a short code. The platform audit refuses UPDATE, DELETE and TRUNCATE. Manual purge is never scheduled and requires a verified final dump.
- **Shared browser origin.** Shops share buyer and seller origins, so same-origin script compromise can reach another shop's browser storage. R2 resolves a validated storage scope before importing state-reading modules, scopes shop-specific state and SW caches, keeps appearance/language shared and retains default keys. Two shops in one installed Chrome profile are tested for cart/profile/address/history/local-order/alert/palette separation, independent worker caches, installation, offline start and update. Explicit unavailable responses cannot use a cached scope; offline pages with no tenant scope fail closed. CSP and textContent prevent normal content from becoming script. A same-origin redirected navigation bypasses the old cached shell so an installed app follows permanent rename aliases.
- **Tenant static edge.** Caddy applies host privacy blocks before the metadata-only availability gate and strips valid non-reserved prefixes only for the intended static surface/shared files. The seller retains the existing static tokens CSS exception. Unknown/unavailable tenants open no shop database; aliases preserve path/query. Caddy overwrites the original URI header. The gate adds no seller/platform capability. Real-image routing checks cover encoded/malformed codes, both hosts, crawler/share paths, streamed request preservation and the dedicated admin block.
- **Dedicated admin tunnel.** R4 uses a new `online-shopping-admin` tunnel and credentials, leaving the existing tunnel untouched. If X7 fallback is needed, the seller origin also hosts the console and seller-page XSS becomes an admin-origin risk; record that deviation before activation. No tunnel or compose platform wiring is introduced by R1.
- **Multi-database upgrade recovery (R3; real-stack verified).** With platform mode enabled, a schema upgrade pauses business requests on a durable project-owned volume and drains HTTP requests, worker sends and platform bootstrap/reconciliation before taking the verified snapshot set. The backend can only read the flag; a private host operator helper writes it and no public control endpoint exists. Named upgrade runners have durable intent before creation and must be stopped before restore, including when the controller lost their outcome. A failure restores every attempted database transactionally and verifies schema, row counts and content hashes. Restore failure keeps traffic paused. Migration intent is cleared durably before unpausing, preventing a later restart from erasing post-recovery orders with a stale backup. Ordinary releases retain image-only rollback. Platform-disabled main-shop upgrades bypass this recovery protocol (review B06). Operator reports and dumps are private sensitive artifacts; they never contain credential values in logs. The main schema remains 24.
- **Tenant worker and interrupted provisioning (R3).** One worker visits shops serially, rechecks ACTIVE status immediately before opening each store, skips SUSPENDED/DELETING and isolates shop errors. Bounded pools use three connections per shop and timed idle eviction. In-process reconciliation marks abandoned PROVISIONING reservations FAILED with a revision check and an audit event, while tracking local in-flight creations so an active operation cannot be mistaken for a crash. Reconciliation pauses with upgrade maintenance. A process or database outage remains an availability risk; five real fault drills, twenty-shop mixed traffic and idle eviction/reopen are recorded in the R4 ledger.


### Order manipulation
- **Client changes product price/discount/totals.** Totals are recomputed from `product.price_minor` inside the order transaction. The client sends `expectedPriceMinor` and `expectedCurrency`, which are only compared; a mismatch returns `409 PRICE_CHANGED`. The client sends no total or discount. There is no discount feature. Safe-integer overflow is checked. Status: Implemented.
- **Quantity changes after validation.** Quantity is an integer 1–100, ≤50 lines per delivery, ≤100 lines, ≤10 deliveries, one line per product per delivery. Submit checks requested stock after subtracting holds from SUBMITTED orders younger than 48 hours (`src/stock-reservation.js`). Confirm deducts physical stock transactionally and fails with `INSUFFICIENT_STOCK` if short. Expired holds do not guarantee later confirmation. Confirmation/cancellation advance tracked product timestamps; the seller editor supplies a revision and omits unchanged stock. Switching limited/unlimited tracking is rejected while any affected order is CONFIRMED, preserving deduction semantics until cancellation or shipment. Unversioned API clients retain last-write metadata/stock behavior. Shared listing sibling revision propagation remains open (B11).
- **Skipping or replaying transitions.** `decideSellerOrder` requires the exact `from` status and `expectedRevision`, performs a compare-and-set `UPDATE ... WHERE status = ? AND revision = ?`, and writes `order_event`. Invalid or stale transitions return 409. Status: Implemented. Note that `status` is a single column that also represents shipment/delivery; separate payment, fulfillment and shipment machines do not exist yet.
- **Duplicate orders from retries or double submit.** `Idempotency-Key` with request hash in `checkout_idempotency` provides server-side replay protection for the same key. The browser durably stores the unresolved key, exact body and receipt/cart context under the resolved shop storage namespace before sending. Unknown outcomes replay the original intent across reloads and defer automatic updates. Corrupt or unavailable storage blocks submission. Definitive rejections permit corrections; successful receipt handling clears the intent. Browser-data deletion, another profile/device or concurrent independent submissions are outside this recovery guarantee.

### Payment
Payment is not implemented, so there is no payment attack surface today. The following apply the moment a payment provider is added and should be treated as P0/P1 review triggers:
- Client claiming payment success (payment state must be set only from a verified provider callback or server-to-provider query, never from a request body or redirect parameter).
- Forged, replayed or duplicate payment callbacks (verify raw-body signature, dedupe by provider event ID, reject out-of-order regressions).
- Payment/order desynchronization (payment state must be its own machine; order confirmation must not be inferred from a client-reported amount).
Status: Missing (by design).

### Webhooks
One endpoint exists: `/api/v1/webhooks/whatsapp` (section 4). HMAC-SHA256 over raw bytes precedes JSON parsing; body receipts and effects share a transaction. Body hashes deduplicate deliveries, and unique provider-message IDs deduplicate inbound messages. Receipt state changes are monotonic and never write order state. Replies retain keyed sender hashes and plain-text bodies. The route has a per-IP limiter and 256 KiB body bound. Shared-secret routing and post-erasure reply retention remain open defects (review B08/B09).

`src/integration-ingress.js` is a separate offline model with bounded synthetic events, quarantine and operation correlation; its status must not be confused with the running webhook. Remaining gaps include an App Secret overlap/rotation policy and provider IP allow-listing. No timestamp replay window is imposed; replay safety relies on persisted identities/receipts. Master-key resealing exists in `src/secret-box.js` and `src/integration-connections.js`, but does not provide an App Secret overlap window. Ninja inbound ingress has no live endpoint.

### Integrations
- **Compromised API credential / secret exposure.** The running WhatsApp connection stores access tokens, App Secrets and hash keys sealed with AES-256-GCM; its master key comes from a secret file. Server-only helpers decrypt them for provider operations. API responses expose connection metadata and a masked hint, never access tokens/App Secrets. Offline simulation separately uses credential references. Backend/master-key compromise crosses this boundary.
- **Malicious provider response.** The WhatsApp runtime uses shared `normalizeProviderResponse` and `normalizeProviderStatus` helpers; unverified/unparseable send outcomes become reconcile. The synthetic ledger remains separate from production order state.
- **Timeout / retry duplication.** Runtime outbox states are `QUEUED, SENDING, ACCEPTED, DELIVERED, READ, FAILED, RECONCILE`, with atomic claims and leases; a provider SENT receipt maps to ACCEPTED. Preparation failures have bounded retry; uncertain network outcomes require seller reconciliation before resend. The separate offline ledger has its own state vocabulary.
- **Incorrect status mapping corrupting internal state.** Inbox processing in the offline code does not mutate shopping order state. Keep it that way: provider events update provider-facing projections, and a separate, validated step decides any order/fulfillment change.
- **Provider outage.** The WhatsApp sender (`src/whatsapp-outbox.js`) is the only outbound flow. It sends the buyer's name, order number, carrier and tracking number and the buyer's phone number to Meta, only for orders whose buyer opted in, only through the seller's own connected account, and never from a sample shop or a quick sign-in site. An unknown outcome (timeout, network error, 429, 5xx, unparsable answer, expired lease) becomes `RECONCILE` and is never retried automatically; messages are claimed with one atomic update so two workers cannot send the same row; stored errors hold codes only, never numbers, names, bodies or tokens.

### Injection
- **SQL injection.** All queries use positional parameters through the store contract. Dynamic SQL exists only for fixed identifier lists (`resetDemo` table names) and static fragments (the `tracking` columns in `decideSellerOrder`). Search uses `instr(lower(?), ...)` with parameters. Status: Implemented; review any new string-built SQL.
- **XSS.** First-party `public/**/*.js` uses `innerHTML` for static templates and internal SVG constants (for example seller settings/integrations and shop detail/app); buyer, product and order text is rendered through text nodes. Any interpolation of server/user text into HTML is a P0/P1 review trigger. `public/seller/vendor/printform.js` is vendored and needs separate review. CSP blocks inline script and framing. Local/static headers use `script-src 'self'`; production Caddy additionally permits fixed Cloudflare Web Analytics script URLs and its collection origin. Re-check print/document views and the actual deployed CSP when changing these surfaces.
- **Command/code injection.** The Node app spawns no processes. `deploy/*.py` run Docker/git commands with validated inputs (`SHA` regexp, fixed repository constant); review any change that builds a command from remote data.
- **Template injection.** No server-side templating.
- **Stored image content.** Uploaded images are validated (`src/product-image.js`, MIME allow-list png/jpeg/webp in the schema) and served with `X-Content-Type-Options: nosniff`.

### Sensitive data
- **Tokens/secrets in logs.** Server logging is limited to error codes/names (`console.error('Request failed:', error?.code || error?.name)`); request bodies and credentials are not logged.
- **Secrets in frontend.** `public/` contains no credentials; `GET /api/v1/seller/integrations` returns a static catalog.
- **Secrets in Git.** `.gitignore` covers `.env*`, `.dev.vars*`, `.local/`, `*.db`, `output/`. No secret files are tracked (`git ls-files` shows only `.env.example`, `deploy/docker.env.example`, `deploy/production.env.example`). A local `.dev.vars` and `.local/` exist in some working copies and must stay untracked. `deploy/cloudflared.yml` tracks the tunnel ID (not a credential).
- **PII leakage.** Seller order detail returns buyer/recipient data only after its account capability check; guest status responses contain no PII. WhatsApp reply bodies are seller-only personal data. API JSON is `no-store`. Backups are unencrypted (owner decision), so host access equals full PII access. SQLite migration imports and verifies all durable baseline tables, including sealed connections, integration audit, receipts, outbox and inbound replies; schema inventory and byte/content-digest tests guard omissions. Checkout recovery temporarily stores buyer/recipient details in shop-scoped localStorage until receipt handling succeeds; it has the same browser access boundary as local profiles and addresses.
- **Verbose errors.** `errorResponse` returns generic messages for unknown errors; known `ApiError`/`FieldError` messages are user-safe by convention.

### Availability / abuse
- **Brute force.** Login is limited to 5 attempts per 15 minutes per client IP (stored in `rate_limit_attempt`, key hashed). Password hashing is async scrypt. No per-account lockout; a distributed attacker can try 5 per IP per window. Password policy (16+ chars, letters and digits, weak-password denylist) is enforced at startup.
- **Repeated checkout/order creation.** 30 submissions per 15 min per IP; each order is bounded to 100 lines. There is no global cap, CAPTCHA or order-volume alarm, so a botnet can still fill the queue and the stock-check path.
- **Rate-limit key spoofing.** Client IP is trusted from `X-Real-IP` only when `TRUST_PROXY=1`; otherwise the socket address is used. If the backend were reachable without Caddy, or Caddy were fed a non-Cloudflare `CF-Connecting-IP`, limits could be bypassed. Production keeps the backend on an internal network.
- **Large/unbounded requests.** `readBody` enforces `maxBytes` while streaming; list endpoints cap `limit` (≤100) and `offset` (≤10 000); product body cap 7.5 MB. `GET /api/v1/products` pagination limits should be re-checked when changing `listProducts`.
- **Webhook flooding / retry storms.** No endpoint today; design requirement for any future route (body cap, pre-parse signature check, dedupe before expensive work).
- **Limiter table growth.** Expired attempts are deleted on each `attempt` inside the same transaction; each request performs a `DELETE` and `COUNT` on this table.
- **Supply chain.** `main` deploys automatically after CI. Anyone able to push to `main` (or compromise the GitHub account) can ship code to production. Branch protection and required review are not verifiable from the repository. Status: Partial (CI gate and protected-file fingerprint exist in `auto-update.py`).

## 6. Security Invariants

Hold these true; a change that weakens one is at least P1.

1. Every `/api/v1/seller/*` route except session creation (and demo-session in demo mode) requires a valid server-side session; every state-changing seller route also requires exact `Origin` and a matching `X-CSRF-Token`.
2. Guest access to an order is limited to its status fields and requires `orderNo` plus the matching access key. No endpoint returns buyer or delivery PII to a guest.
3. Totals, line prices and currency come from the database inside the order transaction. Client-supplied prices/totals are never authoritative.
4. Stock is never negative: confirm fails and rolls back if stock is short; cancelling a confirmed order restores it.
5. Order status changes only through `decideSellerOrder`'s compare-and-set (`status` + `revision`), only along the allowed transitions, and each change inserts an `order_event` in the same transaction.
6. Order creation is idempotent per `Idempotency-Key`; the same key with a different payload is rejected.
7. Order, payment, fulfillment and shipment states are separate state machines. Today only the order status (with manual tracking fields) exists; new states must not be folded into `shop_order.status`.
8. Credentials, tokens and App Secrets never reach the frontend, logs, error messages or Git. Secrets are mounted from files outside the repository.
9. Payment success, once implemented, may be established only by a trusted, authenticated provider event or a server-side provider query.
10. Any external event is authenticated (signature over raw bytes, constant-time compare) before it can cause a state change, and an event identity must not cause the same business effect twice.
11. Unknown or ambiguous provider outcomes become a reconcile state; they are never treated as success or silently retried into duplicate effects.
12. The demo sandbox must require public-demo configuration and demo setup. Passwordless `demo-session` must require intentional default-shop sample configuration (`SHOP_MODE=public-demo` or explicit `SELLER_QUICK_LOGIN`), and must never be enabled for a non-default platform shop. `POST /api/v1/seller/demo/reset` must be unreachable outside Demo shops.
13. Sensitive operations (order decisions, and later refunds/shipments/credential changes) are auditable through append-only events.
14. Once per-seller or per-company data exists: every query for it is scoped by the authenticated owner server-side; a seller can never read or change another seller's resources.

## 7. Security Controls

| Control | Status | Evidence |
| --- | --- | --- |
| Admin password hashing (scrypt, random salt, timing-safe compare) | Implemented | `src/auth.js` |
| Server-side sessions; token stored as SHA-256; 12 h expiry; deleted on logout | Implemented | `src/auth.js` |
| Cookie `HttpOnly; SameSite=Strict; Path=/api/v1/seller; Secure` in production | Implemented | `cookieFor` |
| CSRF: per-session token header plus exact `Origin` on mutations | Implemented | `requireCsrf`, `requireOrigin` in `src/app.js`, `src/http.js` |
| Separate customer and seller origins, path-based expected origin | Implemented | `src/app.js` (`expectedOrigin`), `deploy/Caddyfile.production` |
| Authorization on seller routes (session required) | Implemented | `src/app.js` |
| Per-shop database isolation and seller capability authorization | Implemented | `src/platform/registry.js`, `src/roles.js`, PostgreSQL negative suite |
| SuperAdmin MFA/TOTP | Implemented; activation evidence in ledger | `src/platform/admin-auth.js`, RFC 6238 and API tests |
| Session invalidation on password change/reset | Implemented; local concurrency verification | Seller login/session issuance, own-password changes and recovery serialize; revoked sessions are rechecked before own-password mutation. Platform reset clears separate sessions. |
| Server-side pricing and total calculation | Implemented | `createOrder` |
| Request validation (`boundedText`, field allow-lists, regex IDs, phone normalization) | Implemented | `src/validation.js`, `src/checkout-input.js`, `src/product-input.js` |
| Idempotent checkout | Implemented within one retained browser scope | Server replay plus persisted exact checkout intent; unknown outcomes survive reload and storage failures block submission. Clearing browser data loses this recovery state. |
| Optimistic concurrency and transition validation for order decisions | Implemented | `src/seller-orders.js` |
| Database constraints (CHECKs, FKs `ON DELETE RESTRICT`, unique order numbers) | Implemented | `src/db.js`, `src/postgres/schema.sql` |
| Parameterized SQL | Implemented | all `src/*.js` store calls |
| Database-backed rate limiting (login, checkout, status, demo) | Implemented | `src/limiter.js` |
| Body-size limits and request timeouts | Implemented | `src/http.js` `readBody`, `src/server.js` |
| CSP, `nosniff`, `Referrer-Policy`, `frame-ancestors 'none'` | Implemented | `src/static.js`, `public/_headers`, `deploy/Caddyfile.production` |
| HSTS | Missing in repo config | Not set in Caddy; Cloudflare may set it outside the repo |
| Secrets via files / Docker secrets; read-only backend container; `no-new-privileges`; internal private network | Implemented | `compose.production.yaml` |
| Least-privilege DB role (no DDL) | Partial | `online_shopping_app` has DML on all tables including `order_event` and `admin` |
| Append-only audit log | Partial | `order_event` is written on each transition but the app role can `UPDATE`/`DELETE` it; Demo reset deletes it |
| Audit of login, session, settings and catalog changes | Partial | Account/product/integration events and platform audit exist; seller login/session/settings audit remains limited. |
| Webhook signature verification | Implemented, routing gap | Real WhatsApp raw-body HMAC; shared-secret selection loses events (review B08). Ninja helpers are offline. |
| Webhook inbox and deduplication | Partial | Real WhatsApp body/message dedupe; late replies undermine erasure (review B09). Synthetic ingress separately models quarantine. |
| Outbox with leases, retry and reconcile states | Implemented | `src/whatsapp-outbox.js`; preparation retry is bounded, uncertain send outcomes require reconciliation. |
| Replay window / App Secret rotation overlap | Missing | Receipt/identity dedupe exists; master-key resealing is separate from App Secret rotation. |
| Provider contract/registry and deterministic simulation providers | Partial | Real WhatsApp transport exists; payment/courier foundation remains synthetic. |
| Dependency audit in CI; pinned GitHub Actions by SHA; pinned base images by digest | Implemented | `verify.yml`, `compose.production.yaml` |
| CI-gated auto-deploy with a tunnel/database gate, compose policy checks, backup-then-migrate and rollback | Implemented in source; controller installation remains operational | Main-only and platform upgrades use maintenance, tracked runners and verified restore before old-image activation. Unit failure paths pass; this repair has not run a real Docker rollback drill. |
| Per-account login lockout, CAPTCHA, global abuse caps | Missing | Only per-IP limits |
| Encrypted backups | Missing (owner decision) | `docs/MULTI_TENANT_PRODUCTION_PLAN.md` |

## 8. High-Risk Files / Modules

Give these extra scrutiny.

- Authentication and sessions: `src/auth.js`, `src/config.js`, `src/app.js` (login, demo-session, `requireCsrf`, `requireOrigin`).
- Seller credential recovery: `src/accounts.js`, `scripts/reset-seller-password.js`; credential validation and session issuance must serialize with reset.
- Authorization/routing: `src/app.js`, `src/http.js`, `deploy/Caddyfile.production`, `deploy/Caddyfile`.
- Checkout and pricing: `src/orders.js`, `src/checkout-input.js`, `src/phone.js`, `src/validation.js`, `public/shop/checkout.js`, `public/shop/checkout-payload.js`, `public/shop/cart.js`.
- Order state and stock: `src/seller-orders.js`, `public/seller/orders.js`.
- Catalog/price/stock mutations: `src/products.js`, `src/product-input.js`, `src/product-image.js`, `src/product-gallery.js`, `src/settings.js`, `src/shop-setup.js`.
- Database and migrations: `src/db.js`, `src/postgres/schema.sql`, `src/postgres/upgrade.js`, `src/postgres-store.js`, `src/postgres-db.js`, `src/store.js`, `deploy/init-postgres.sh`, `deploy/postgres/schema12.js`, `src/limiter.js`.
- Static serving and headers: `src/static.js`, `public/_headers`.
- Demo and destructive operations: `src/demo-sandbox.js`, `resetDemo` in `src/shop-setup.js`, `scripts/replace-catalog.mjs`, `scripts/import-sqlite.js`.
- Live WhatsApp boundary and erasure: `src/integration-connections.js`, `src/secret-box.js`, `src/whatsapp-transport.js`, `src/whatsapp-outbox.js`, `src/whatsapp-inbound.js`, `src/whatsapp-webhook.js`, `src/whatsapp-messages.js`, `src/erase-contact.js`.
- Offline integration foundation: `src/integration-contracts.js`, `src/integration-requests.js`, `src/integration-ledger.js`, `src/integration-consent.js`, `src/integration-ingress.js`, `src/integration-adapters.js`, `public/shared/integration-catalog.js`. Shared helpers used by live WhatsApp still require live-path review.
- Database import inventory/verification: `src/sqlite-import.js`, `scripts/import-sqlite.js`.
- Deployment and secrets: `compose.production.yaml`, `compose.yaml`, `deploy/auto-update.py`, `deploy/install-auto-update.py`, `deploy/backup-postgres.py`, `deploy/backup.sh`, `deploy/cloudflared.yml`, `Dockerfile.*`, `.github/workflows/verify.yml`, `.gitignore`, `.dockerignore`, `.env.example`.
- Divergent copy to keep in sync or remove: `worker-runtime/*` (mirrors `src/` modules; imported by tests).

## 9. Review Priorities

**Critical**
- Auth bypass, including any new route added without the session check, or demo-session reachable in production mode.
- Cross-account or cross-seller data access once ownership exists; any route returning buyer/delivery PII without a session.
- Secret exposure (credentials in Git, logs, responses, frontend, images or compose files).
- Payment manipulation (once payments exist) and any path where the client influences price, total or currency.
- Arbitrary code/command execution; destructive database operations outside the Demo guard; weakening of `auto-update.py` protections.

**High**
- Forged or unauthenticated webhook accepted; signature computed over parsed rather than raw bytes; non-constant-time compare.
- Seller isolation failure, order ownership failure, weaker guest status access key handling.
- Incorrect order/payment/fulfillment/shipment transition; transitions without compare-and-set or without an `order_event`.
- Replay or duplicate processing causing duplicate orders, shipments, messages or refunds.
- SQL injection from string-built SQL, XSS from untrusted text, CSRF or origin check gaps on mutations.
- Idempotency regressions in `createOrder` (race between concurrent submits with the same key).

**Medium**
- Incomplete validation, unbounded lists or payloads, N+1 queries.
- Unsafe retry or missing timeout on any future external call; unknown outcome treated as success.
- Audit gaps (new sensitive operation without an event), rate-limit weaknesses, information leakage in errors or logs.
- Drift between `src/`, `worker-runtime/`, `src/db.js` and `src/postgres/schema.sql`.

## Known gaps summary

1. One shared backend/master key/provisioner remains a cross-shop trust boundary (accepted X6); a narrow provisioning function is future work.
2. Guest order status key is client-chosen and not checked for entropy at creation.
3. `order_event` is not append-only at the database level; app role has broad DML.
4. Platform authentication has audit and account/IP lockout; seller authentication remains IP-limited without platform-style account lockout. Settings audit remains limited; catalog/account/order events cover their own mutations.
   Platform claim issuance is default-off (`PLATFORM_ADMIN_CLAIM_ENABLED`). Schema v2 has lower-cased unverified contact email (not a login/recovery identifier), hash-only current claim state and metadata-only generation history. Any admin insertion closes a database-enforced permanent latch; reset cannot reopen it. Existing admins migrate closed with NULL email. Claim mode rejects legacy bootstrap credentials. Eligible backend startup issues 32 random bytes, stores domain-separated SHA-256 only, uses DB-time 30-minute expiry and atomically supersedes older generations with an ADMIN_CLAIM_ISSUED audit containing only the generation UUID. One post-commit structured stdout URL is an explicit, narrow exception to the no-secret-logging rule: log readers can seize bootstrap authority, and retained/exported copies cannot be recalled. Restrict bootstrap log access and exports. Reconnects never reprint or renew, maintenance pauses do not issue, and a trusted later restart rotates; overlapping starts share the winner using runtime-start/DB-issuance timestamps (synchronized clocks required). Commit/log delivery is not atomic; lost output requires trusted restart. Database-owner DDL/backup restore remains privileged and can undo these controls.
   P5 adds exact shop-origin GET `/api/v1/setup/status` and POST `/api/v1/setup/claim`, default-off. Eligibility checks no admin, permanent latch, current unexpired generation (DB time) and fewer than five wrong-code attempts. Closed/off/expired/exhausted/unknown routes and failed proof return generic 404. JSON is capped at 4096 bytes; exact Origin and non-ambient bearer proof defend claim CSRF without a setup cookie. Persisted per-client five/15-minute limit precedes parsing; wrong-code attempts increment generation/state counters and audit without input, with rate-limit audit bounded to one/client/window. Fixed-length constant-time hash comparison precedes field validation; email is unverified contact-only. Serialized claim closes the latch before admin insertion, consumes generation, audits and creates only a five-minute PASSWORD session atomically; failures roll back. Mandatory existing admin-origin TOTP/CSRF gates remain unchanged. The host-only cookie emitted on the shop host does not cross to the admin host: browser continuation must use ordinary admin-origin password login, not Domain widening or cross-origin handoff. No setup page or deployment activation is included.
   P6 adds Node-only exact shop-origin GET `/setup/`, `/setup/setup.js`, `/setup/setup.css`, sharing status eligibility on every request. Generic static serving blocks decoded setup paths, including direct-index, encoded and tenant-rewrite bypasses; claim-off legacy setup tenants remain routable. Page/assets are no-store/no-referrer/noindex with external-only first-party script/style CSP. The loader clears the fragment before fetching, keeps the code only in memory, uses textContent and never browser storage, and clears form secrets on success. The claim response adds a config-derived HTTPS admin-host `/platform/` nextUrl without secrets. Separate-host sign-in remains required; no cookie widening or cross-origin session transfer. Existing scoped workers neither intercept nor cache setup paths/APIs. P7 must independently route/block frontend edge file serving; browser rendering and deployed routing remain unverified.
5. Order status single column; no payment/fulfillment/shipment machines in the production schema (integration foundation is offline).
6. The real WhatsApp webhook deduplicates body/message identities but has no timestamp replay window or App Secret overlap policy; master-key resealing is implemented. Shared-secret routing and late-reply erasure gaps are open (review B08/B09).
7. Auto-deploy trusts `main`; branch protection cannot be verified from the repository.
8. `worker-runtime/` is a retained copy of a removed deployment target.
9. Shared listing edits still leave sibling revision tokens stale (B11); API clients omitting product revisions retain last-write behavior. Browser recovery depends on retained shop storage and does not coordinate independent simultaneous checkout intents across tabs/devices.
10. B01–B07 repairs are locally verified only. The installed updater does not replace itself; production activation of these controls needs an explicit release/controller installation and applicable operational checks.

## GCP deployment boundary (2026-10-20)

`compose.gcp.yaml` and `deploy/gcp/` define an independent deployment on the existing shared GCP e2-small VM; preserve its initialized PostgreSQL volume. TLS terminates at the root-managed shared gateway, preserving Host and overwriting X-Real-IP. No Cloudflare header authority, published application/database ports or container Docker socket. Platform claim defaults off; manual activation adds UID1000/0600 master/platform/provisioner secrets and additive roles/database without modifying the shop database. Root-only Linux provisioning inspects existing boundaries and never overwrites secrets or resets role passwords. The seller host also serves SuperAdmin by explicit owner decision: seller-origin script compromise can reach that origin's admin surface; mandatory TOTP does not remove this shared-origin risk. Shop-host setup is Node-only, with no frontend static fallback; tenant static requests use the metadata-only availability gate before rewriting, and cross-host private paths remain denied. Both hosts proxy WhatsApp webhook APIs; backend signature verification remains authoritative. Platform schema/version/migrations are manual-release protected. Cloud Logging delivery, real Caddy routing, capacity and production activation remain unverified.

### Accepted claim residual risks

Log readers (including exports and crash/heap/core dumps) can seize the live bearer before consumption/expiry; restrict access and retention before enabling. An unauthenticated attacker can exhaust all five wrong-code attempts for each generation, even after trusted restart; public status exposes the open window. Seller and SuperAdmin intentionally share an origin: seller-script compromise can act against the platform surface despite mandatory TOTP. Overlap detection compares application-start wall time and database issuance time; clock skew can invalidate restart/overlap distinctions, so synchronized clocks and single-instance stop-before-start remain required. Privileged restoration of an older empty platform backup can reopen the latch; restore-test before the mutation block, not after DDL. The shared PostgreSQL 20-connection cap must accommodate default/platform/tenant/provisioner pools and operations. Live connection pressure, memory, outbound WhatsApp limits, log policy and multi-database restore remain unverified operational acceptance gates.

Claim schema 002 is an explicit opt-in (`upgrade-platform.mjs --with-claim`), not an automatic OrbStack migration. Automatic platform version remains 1; claim-off fresh/runtime v1 behavior preserves previous-image rollback. Claim-on runtime requires v2, initializing it only on an empty database; existing v1 requires the explicit command.

The publisher trusts successful same-repository main push verification at the exact source SHA and uses the repository GITHUB_TOKEN only to publish public, revision-labelled GHCR images. The VM uses anonymous source/image access and no GitHub write credential. Public images must contain public code only; existing Dockerfiles and .dockerignore exclude local secrets and data. Repository maintainers and verification workflow changes remain trusted, so branch-review policy is a repository-owner responsibility.

The root-installed controller fixes host Compose/runtime policy outside downloaded releases. It validates source Git blob hashes, image labels/digests/platform, main and latest CI status, then checks backend and frontend readiness/revision. Durable pending state permits application-image rollback after failure or interruption. It does not roll back database writes or perform migrations. Protected source/dependency/schema changes require manual review and a restore-tested backup/migration procedure; root policy changes also pause automation. Controller/config updates are privileged manual operations. Resource limits, rotated logs and a low-cost shared VM do not provide a spending hard cap, capacity guarantee, off-host backup or automatic recovery from disk exhaustion. Deployment-specific procedures and verification limits are in [GCP_DEPLOY.md](GCP_DEPLOY.md).
