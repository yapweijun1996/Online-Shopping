# Multi-tenant plan: SuperAdmin and one shop = one seller

Status: **owner decisions D1, D2, D3 and the role question recorded 2026-10-09; P1 (tenant context, PR #116) and P2 (platform database, provisioner, tenant pool, audit; `src/platform/`) are implemented; R1 implements configuration-gated P3/P4 and backend P5; production activation remains R4. See [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md) for closed decisions and [ledger](MULTI_TENANT_LEDGER.md) for evidence.** Written 2026-10-08 against `main` (schema 21); the shop schema is now 24 and each tenant database carries the accounts, roles, notes and history added since (`seller_account` with Owner, Manager and Staff roles, `must_change_password`, `scripts/reset-seller-password.js`). It refines [MULTI_TENANT_PRODUCTION_PLAN.md](MULTI_TENANT_PRODUCTION_PLAN.md) (2026-10-05) with the owner's later decisions: **own PostgreSQL database per tenant** (recorded in [INTEGRATION_DESIGN.md](INTEGRATION_DESIGN.md) section 0) and **one shop = one seller**. Where the two disagree, this plan wins; the old plan's shared-database `company_id` model is not used.

Facts are marked **[repo]** (checked in this repository), **[owner]** (decided by the owner) or **[proposal]** (my recommendation, not decided).

## 0. Goal and hard rules

- A **SuperAdmin** account sits above all tenants. It can create a tenant (a shop together with its single seller account), suspend or resume it, reset the seller's password, rename its code, and run backups.
- **One shop = one seller at creation [owner].** The SuperAdmin creates a shop together with its single seller, who becomes that shop's Owner. **Update 2026-10-09 [owner]:** the Owner/Manager/Staff roles already built for a single shop (SEL-04) stay, and each shop manages its own people inside its own database; the SuperAdmin never manages shop staff. Buyers stay guests.
- **Each tenant has its own database [owner].** Tenant URLs are path style, such as `/abc/` **[owner]**.
- **The current live site is not touched [owner].** It is a sample site with passwordless sign-in; it keeps working at today's URLs and keeps its data and its quick sign-in. It becomes the default tenant (section 4.5).
- Every phase is its own pull request, merges and deploys through the existing gate, and can be reverted on its own.

## 1. What exists today (evidence)

- **[repo]** One database, one shop: `shop_setup` has one row; the seller side has one `admin` row (`admin.id = 1`); no table has a tenant id. This already matches "one shop = one seller" inside a single database, so a tenant database can reuse the current schema and auth unchanged.
- **[repo]** `createApi({ store, config })` takes one store and one config. The session cookie is `seller_session` with `Path=/api/v1/seller`. PWA manifests fix `scope` and `start_url` to `/shop/` and `/seller/`.
- **[repo]** The frontend uses absolute paths: 69 `/api/v1…` strings and 143 absolute `/shop/`, `/seller/`, `/shared/`, `/demo/` references across 15 files. Serving under `/abc/` needs a base-path layer (phase 6).
- **[repo]** Deploy: Docker Compose with one `backend`, one `frontend` (Caddy), one `postgres`, one `tunnel`. The updater applies additive schema upgrades to **one** database (`scripts/upgrade-database.mjs`), takes one backup (`deploy/backup-postgres.py`), and protects only `deploy/cloudflared.yml` and `deploy/init-postgres.sh`.
- **[repo]** `src/secret-box.js` (AES-256-GCM, rotating keys) and the master key secret `integration_keys` exist; WhatsApp tables live in the tenant database, so they become per-tenant automatically.
- Observed risk: the host (a MacBook Air) showed a load average above 100 and one image build timed out; capacity is a real constraint (section 9).

## 2. Architecture decision

| | A. One stack per tenant | B. One backend process, database per tenant (recommended) | C. One shared database with `company_id` |
| --- | --- | --- | --- |
| Data isolation | Strongest (separate containers and databases) | Strong: separate databases and database roles; a bug in the router cannot read another database without that tenant's credentials | Weakest: one missed filter leaks data |
| Containers | N backends, N frontends | Same four containers as today | Same as today |
| Fits the host | Poor on a laptop (memory and build time grow per tenant) | Good | Good |
| Upgrades | N deployments | One image; schema upgraded in each database (section 7) | One schema |
| Owner decision | Allowed | Matches "own database per tenant" | Rejected by the owner |

**Recommendation: B.** One backend image holds a tenant registry. Each tenant has its own PostgreSQL database and its own database role (least privilege), all on the existing PostgreSQL server. A small **platform database** holds the SuperAdmin, the tenant registry and the platform audit trail. A request resolves its tenant first; the rest of the code receives that tenant's store exactly as it receives the single store today.

If the owner later wants hard process isolation for a large client, that tenant can run as option A with the same code.

## 3. Data model

### Platform database (new, one per installation)

| Table | Purpose |
| --- | --- |
| `platform_admin` | SuperAdmin accounts (id, username, scrypt password hash, sealed TOTP secret, TOTP enabled, last used TOTP step, failed attempts, locked until) |
| `platform_recovery_code` | One-time recovery codes, stored as hashes |
| `platform_session` | Sessions (token hash, CSRF token, expiry) in the same style as `session` |
| `tenant` | id, `code` (unique, lower case), display name, status `PROVISIONING / ACTIVE / SUSPENDED / FAILED / DELETING`, database name, database role, sealed database password, seller username, `sample` flag, created and updated times |
| `tenant_code_alias` | Old codes that redirect to the current code |
| `platform_audit` | Append-only: actor, action (`TENANT_CREATE`, `SELLER_PASSWORD_RESET`, `TENANT_SUSPEND`, `CODE_RENAME`, `LOGIN`, `LOGIN_FAILED`, …), tenant, time, no secrets. The application role gets INSERT and SELECT only |

### Tenant database (unchanged)

The current schema (`schema.sql`, version 21 and later): `shop_setup` (the shop), `admin` (the single seller), products, orders, integrations. A tenant is created from the latest `schema.sql`; schema upgrades are covered in section 7.

## 4. Behaviour

### 4.1 SuperAdmin account and sign-in

- Created at first start from Docker secret files (`PLATFORM_ADMIN_USERNAME`, `PLATFORM_ADMIN_PASSWORD_FILE`), the same pattern as the seller admin today. No default password.
- **Password plus mandatory TOTP [owner, 2026-10-05].** TOTP is RFC 6238 (HMAC-SHA1, 30 s, 6 digits, plus or minus one step) built on `node:crypto`, no new dependency; a used step cannot be reused. Enrolment is forced at the first sign-in through a restricted, password-only session that can only show the secret and accept one confirming code; the full session and the 10 one-time recovery codes (shown once) come only after that confirmation.
- Throttling: login limiter per address and per account, lockout after repeated failures, every attempt audited. Separate cookie name and CSRF token from tenant sessions; origin and CSRF checks on every write.
- **Where it lives [proposal]:** its own hostname `admin.gmb01.xyz`, so its cookie, CSP and origin checks are separate from shops. This needs one Cloudflare step by the owner (a DNS record and an ingress rule in `cloudflared.yml`, which is a protected file). Optional extra gate: Cloudflare Access (an email one-time code) in front of that hostname, free for a few users. Alternative without a new hostname: a path on the seller hostname, weaker separation.

### 4.2 SuperAdmin console (new page at the admin host)

List tenants with status, schema version, last activity and order counts; create a tenant; suspend and resume; reset the seller password (one-time password shown once); rename a code (alias redirect); view the audit trail; trigger a backup of one tenant. No in-shop impersonation in the first release; support is done by resetting the password.

### 4.3 Create a tenant (single transaction of work, safe to retry)

Form: shop code (3 to 30 letters and digits, lower case, reserved words refused), shop name, currency (MYR or SGD), seller username, optional initial password (otherwise generated).

1. Validate; insert `tenant` as `PROVISIONING` and audit.
2. Create the database role (random password, sealed with the master key) and the database owned by it, through a **provisioner role** with `CREATEDB` and `CREATEROLE`. In PostgreSQL 16 the creator of a role receives administrative rights over it and can grant itself the right to act as that role, so this credential must be treated as able to reach every shop's data: it is one new cross-shop privileged secret, mounted as a Docker secret only where provisioning runs and used only by the create-shop flow. A narrow privileged database function that creates the role and database and leaves the caller without rights over them is the preferred longer-term design (P4 decision).
3. Apply the latest `schema.sql` as the tenant role; run `setupShop` (production mode, shop name) and set the company currency.
4. Create the seller (`ensureAdmin`) with a one-time password; mark the seller as "must change password at first sign-in" (small new feature).
5. Mark `ACTIVE`, audit, show the one-time password and the two URLs once.

If any step fails the tenant becomes `FAILED`; the retry cleans up the half-created database and role and starts again (idempotent). A crash between steps is detected by the status and finished or cleaned up by the same routine.

### 4.4 Suspend, delete, rename

- **Suspend:** every tenant route answers "shop unavailable" (503) and the WhatsApp worker skips it; data is kept. P4 only adds the action; the 503 depends on P5 (tenant routing) and the worker skip on P7, so suspension is not an effective control before those phases.
- **Delete:** two-step SuperAdmin confirmation, a final dump first, database dropped only after a retention period (proposal: 30 days). Never automatic.
- **Rename code:** SuperAdmin only [owner]; the old code stays as an alias that redirects. Browser data is keyed by an internal tenant id, not the code.

### 4.5 URLs and routing

- **[proposal]** Buyer `https://shop.gmb01.xyz/<code>/`, seller `https://seller.gmb01.xyz/<code>/`, API under the same prefix (`/<code>/api/v1/…`), share links `/<code>/p/<id>`. The existing two hostnames are kept, so origin checks stay host based. The alternative from the old plan (`/s/<code>/shop/`) works the same way; pick one in D2.
- **Reserved codes:** `admin, api, shop, seller, s, p, demo, www, health, ready, static, assets, shared, platform` and similar, plus anything that collides with a top-level path.
- **The live site stays at the root:** `/shop/`, `/seller/`, `/api/v1/…`, `/p/…` keep resolving to the **default tenant**, which is today's database registered as a tenant flagged `sample`. Installed PWAs, bookmarks and the passwordless sample entry keep working unchanged.
- **Quick sign-in and the demo reset exist only for tenants flagged `sample`;** a tenant created by the SuperAdmin can never have them.
- **Backend:** a tenant resolver runs first, and returns that tenant's store and settings; unknown, suspended or still provisioning tenants get 404 or 503 and touch no database. Stores are opened lazily in a small bounded pool cache (about 3 connections per tenant, idle eviction), so the number of tenants does not multiply PostgreSQL connections.
- **Per-tenant cookies and limits:** the seller cookie path becomes `/<code>/api/v1/seller` with the code in its name; limiter buckets include the code.
- **Manifest and service worker:** generated per tenant (scope, start URL, name, icons) and cached under a name that includes the code, so shops cannot overwrite each other's caches.
- **Edge:** the Caddyfile gets a rule for `/<code>/…` that rewrites static files to the shared assets and sends API, share and crawler paths to the backend. The Caddyfile is not a protected file.

### 4.6 What every tenant feature must respect

- **WhatsApp:** connection, outbox and webhook already live in the tenant database. The callback URL shown on the connection card gets the tenant prefix, and the message worker loops over active tenants, one at a time, with per-tenant error isolation. Each tenant uses its own Meta app and number.
- **Backups:** the backup script reads the tenant list from the platform database and dumps the platform database and every tenant database, each verified by restoring into a scratch database as today.
- **Master key:** one master key for the installation; sealed values stay bound to a context string, and the tenant database separation keeps them apart.

## 5. Security model

- Server derives tenant and principal on every request; a path code only selects the tenant, and the session found in that tenant's database decides access. A session from tenant A is meaningless in tenant B because it is not in B's database.
- **New high-risk areas to add to the threat model:** the tenant router, the platform console, the provisioner credential, per-tenant database credentials, and the SuperAdmin account (its takeover affects every tenant, hence mandatory TOTP, a separate hostname, optional Cloudflare Access, throttling, lockout and audit).
- Platform audit is append-only for the application role. No endpoint returns a sealed secret or a hash.
- Negative tests required before merge: same SKU, same order number and same phone in two tenants stay separate; a tenant session cookie does not work on another tenant's path; a suspended tenant opens no database; reserved and malformed codes are refused; path traversal and encoded slashes in the code position; the provisioner failing midway leaves no usable tenant; a seller cannot reach the platform console.

## 6. Phases (each its own pull request or short series)

| Phase | Scope | Notes |
| --- | --- | --- |
| **P0** Decisions | Section 10 answered; Cloudflare admin hostname decided | No code |
| **P1** Tenant context | **Done (PR #116).** `createApi` takes a tenant resolver; today's single store is registered as the default tenant. No behaviour change, all tests unchanged | Small, safe first step |
| **P2** Platform database | **Done.** `src/platform/`: schema (`platform_admin`, `platform_recovery_code`, `platform_session`, `tenant`, `tenant_code_alias`, append-only `platform_audit`), `createTenant` (role, database, schema, shop, seller with forced password change, idempotent retry), bounded tenant pool with idle eviction and schema-version check, sealed database passwords, shop-code rules. Tests in `test/platform.test.js` (PostgreSQL) | PostgreSQL tests; no routes yet. The provisioner and platform database URLs are not read from configuration yet; P3 adds that |
| **P3** SuperAdmin sign-in | **Built in R1.** Mandatory TOTP, recovery, lockout, restricted/full sessions, file bootstrap, reset and console | Activation in R4 through a separate admin tunnel (X7), not the protected existing tunnel |
| **P4** Tenant provisioning | **Built in R1.** Console/API lifecycle with revision checks, permanent aliases, thirty-day retention and one-time passwords | Manual purge requires the R3 verified tenant backup support; never scheduled |
| **P5** Tenant routing | **Backend built in R1; edge built in R2.** Path resolver for API, static, manifest, service worker, share and crawler routes; Caddy rules; per-tenant cookies and limiter buckets; legacy root mapped to the default tenant; the full cross-tenant negative suite | Largest backend step |
| **P6** Frontend base path | **Built in R2.** Relative assets and API helper, network-first scoped storage bootstrap, independent manifests/workers, offline/update/install and same-origin two-shop Chrome checks | Exact-count allow-list guard, real Caddy matrix, independent security review; legacy root pass-set retained |
| **P7** Operations | **Implemented in the R3 worktree; real-stack gate pending.** Verified snapshot sets, durable maintenance/drain, sequential platform/shop upgrades, attempted-database restore, sequential tenant WhatsApp worker and in-process recovery | Protected-file changes avoided; production deployment and installed controller replacement still pending |
| **P8** Hardening and release | Independent security review (Codex plus my own), load test with many tenants, failure drills (provisioner crash, one tenant database down), runbooks, threat model and docs | |

Rough size: P1 small, P2 medium, P3 medium, P4 medium, P5 large, P6 large, P7 medium, P8 medium. P1 to P4 can ship without changing what any shop or buyer sees; P5 and P6 are the ones that touch the shops.

## 7. Schema upgrades and deploys with many databases

- R3 first pauses business requests, worker work and platform bootstrap/reconciliation through a durable host-only flag, drains existing work and takes the verified backup set. Main, platform and eligible shops then upgrade in order. Every attempted database is restored and verified on failure before traffic resumes; recording intent before the writer also covers an unknown commit outcome. Named runners are stopped before restore. Ordinary schema-compatible releases do not require this maintenance window.
- Upgrades stay additive and repeatable; a rehearsal against restored copies of every database is required before merge (the check that caught the schema 20 problem), and the backend refuses to serve a tenant whose schema is older than the release expects.
- New tenants are always created from the latest `schema.sql`.
- A failed upgraded cutover restores this deployment's verified snapshots before starting the previous application. A voluntary rollback after successful deployment still needs compatible schemas and must not silently restore old customer data.

## 8. What is deliberately not in scope

Staff accounts and roles, custom domains per tenant, SuperAdmin impersonation, billing and plans, per-tenant themes beyond the shop name, buyer accounts, moving a tenant between servers. Each can be added later without changing this design.

## 9. Risks

- **Host capacity:** the MacBook Air is already heavily loaded; many tenants multiply database work, pools and backups. Mitigation: bounded pools with idle eviction, a stated maximum number of tenants for this host (proposal: 20), and a move to the planned Ubuntu server before real clients rely on it.
- **PWA scope change:** shops at new paths are new apps for browsers; the legacy root is kept so existing installs are not broken.
- **One process, many tenants:** a crash affects all; mitigated by health checks, restart policy and per-tenant error isolation in workers.
- **Upgrade across N databases:** not atomic. R3 chooses a drained maintenance window to prevent writes after the backup. Every attempted database is restored and verified before a failed deployment resumes service. Restore failure keeps maintenance enabled and requires operator investigation. Real backup, partial-failure and interruption drills remain an activation prerequisite.
- **Provisioner credential:** has `CREATEDB` and `CREATEROLE`, which in PostgreSQL 16 gives it administrative rights over every role it creates, so it can in principle read any shop; treat it as cross-shop privileged. Kept as a separate secret, not a superuser, never exposed to routes other than the SuperAdmin provisioning call.
- **Cloudflare tunnel changes are manual** (protected file): the admin hostname needs the owner.

## 10. Decisions

Recorded 2026-10-09 by the owner: **D1** one backend with its own database per tenant; **D2** `shop.gmb01.xyz/<code>/` and `seller.gmb01.xyz/<code>/`; **D3** the SuperAdmin on its own hostname `admin.gmb01.xyz` (the Cloudflare DNS record and tunnel rule are a manual step for the owner, needed before P3); **shop roles** kept and managed per shop. D4 (mandatory TOTP) was decided on 2026-10-05. D1 to D10 and X1 to X20 are closed by [MULTI_TENANT_GOAL.md](MULTI_TENANT_GOAL.md). The executor performs the additive setup authorized in the launch message; the existing tunnel configuration remains protected.

| # | Decision | Recommendation |

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Architecture (decided) | B: one backend, own database per tenant |
| D2 | URL shape (decided) | `shop.gmb01.xyz/<code>/` and `seller.gmb01.xyz/<code>/` (keeps the two hostnames) |
| D3 | SuperAdmin location (decided) | New hostname `admin.gmb01.xyz`, optionally behind Cloudflare Access |
| D4 | TOTP | Mandatory for the SuperAdmin (as decided 2026-10-05); optional for sellers later |
| D5 | Seller first password | Generated, shown once, forced change at first sign-in |
| D6 | Current live site | Registered as the default tenant, flagged `sample`, unchanged |
| D7 | Delete policy | Suspend first; delete only after a 30 day retention with a final dump |
| D8 | Tenant limit on this host | 20 until the Ubuntu server |
| D9 | Reserved code list | As in section 4.5; owner may add words |
| D10 | Per-tenant WhatsApp | Each tenant its own Meta app and number; callback URL includes the code |

## 11. First step if approved

P1 (tenant context with no behaviour change) and P2 (platform database and provisioner) can start immediately, because they do not change anything visible; P3 waits for D3 and the owner's Cloudflare step.
