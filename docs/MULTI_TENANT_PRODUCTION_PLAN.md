# Multi-tenant production plan (Docker, PostgreSQL, SuperAdmin)

**Status: plan approved in outline by the owner on 2026-10-05; nothing here is implemented.** It turns the review draft in [ADMIN_MULTI_COMPANY_DESIGN.md](ADMIN_MULTI_COMPANY_DESIGN.md) into ordered, separately mergeable phases. The data model, authorization and migration rules in that draft still apply; this plan adds the owner's decisions, the runtime question and the build order.

## Owner decisions (2026-10-05)

| Topic | Decision |
| --- | --- |
| Runtime and database | Docker with PostgreSQL for Production. |
| Tenants | One tenant per shop or company, with one **SuperAdmin** above all tenants. |
| Tenant URLs | Path style: `/s/{shop-code}/shop/` and `/s/{shop-code}/seller/`. One domain and one certificate; works through Cloudflare Tunnel. Custom domains per shop can be added later. |
| Sign-in security | Password plus mandatory TOTP code for the SuperAdmin; optional TOTP for shop accounts; no TOTP in the Demo. |
| Personal data | Orders are kept permanently; a seller can delete an order's buyer contact and address data manually, with an audit record. |
| Backups | Required: scheduled, stored away from the app folder with a second copy, with a rehearsed restore. Unencrypted for ease of import and export (owner decision); only the SuperAdmin can run them. |
| Demo | Must be easy to test with data already in place (several pre-seeded shops, one-click reset). |
| Process | Design first, then one phase at a time, each merged and reversible on its own. |

## Can the Cloudflare Durable Object version run in Docker?

Not as such. A Durable Object is a Cloudflare-hosted service: its storage, single-writer guarantee and persistence come from Cloudflare. The open-source `workerd` runtime behind `wrangler dev` can run a Worker and a Durable Object in a container with local files, but that is a development tool: no managed durability, backups, replication or support, and it would not use PostgreSQL. It is not a sound base for a secure multi-tenant production system.

What does run in Docker is the **Node server** that already exists. The API (`src/app.js`) is runtime-neutral, so Docker with PostgreSQL needs a PostgreSQL storage adapter, not a rewrite of the routes. Recommendation: the Demo also runs from the same Docker image and code, as a second instance with its own database and `SHOP_MODE=public-demo`, so only one storage layer is maintained. The Cloudflare Worker version is frozen and removed once the Docker Demo replaces it (see "Consequence for the Cloudflare Worker version").

## Main technical obstacle

All data access today is **synchronous** (`get`, `all`, `run`, `transaction` in [store.js](../src/store.js)), which suits `node:sqlite` and a Durable Object but not PostgreSQL, whose client is asynchronous. Every module that touches the database (orders, products, auth, settings, limiter, demo, setup) and its tests must become `async`. SQL also differs: `STRICT` tables, `datetime('now')`, `instr()`, `json_valid()`, triggers and the table-rebuild migrations are SQLite-specific, so the schema is rewritten for PostgreSQL rather than ported line by line. Doing the async conversion first, on SQLite, with the existing 147 tests as the safety net, keeps that risk separate from the database change.

## Phases

Each phase is its own pull request or short series, leaves the Demo working, and has a rollback.

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Decisions and environment** | Owner confirms the open items below; choose the `pg` client; set up a Docker PostgreSQL service and a test database in CI. | Decisions recorded; CI can start PostgreSQL. |
| **1. Async storage contract** | Make the store interface and every caller `async` with no behavior change, still on SQLite and Durable Objects. | All existing tests pass unchanged in meaning; Worker dry run passes. |
| **2. PostgreSQL adapter and schema** | `pg` adapter, PostgreSQL migrations (including stock, fulfilment and tracking), pooled connections with transaction-local context, readiness checks, Compose service with a private network. Same contract tests run against SQLite and PostgreSQL. | Full suite green on PostgreSQL; a SQLite-to-PostgreSQL import script with row counts and hashes. |
| **3. Tenant model** | `company` (shop) with a unique shop code, `company_id NOT NULL` and composite keys on every tenant table, tenant resolved from `/s/{shop-code}/` for public and seller routes, tenant-scoped idempotency and receipts, tenant-scoped browser storage and service-worker caches. Row-level security as a second barrier, with a restricted database role. | Cross-tenant tests pass: same SKU, phone number and idempotency key in two shops; foreign IDs return 404; no request without tenant context can query tenant tables. |
| **4. Accounts and SuperAdmin** | Principals and memberships replace the single config-file admin: SuperAdmin plus per-shop owner and staff roles; TOTP enrolment and recovery codes (mandatory for the SuperAdmin, optional for shop accounts, off in the Demo); shop roles Owner, Manager and Staff as in the matrix above; password change; session revocation; login audit and lockout. SuperAdmin console to create, disable and inspect shops and assign owners. SuperAdmin has no silent access to shop data: entering a shop is an explicit, audited action. | Authorization matrix tests; revocation takes effect on the next request. |
| **5. Manual deletion and retention** | Seller action to erase an order's buyer contact and delivery data (order number, items, amounts and status are kept), with confirmation and an audit event; SuperAdmin tenant offboarding and export. | Tests prove only personal fields change and the audit row exists; policy text reviewed by the owner. |
| **6. Backups and restore** | Scheduled `pg_dump` backups as plain files (owner chose no encryption) with restricted file permissions, stored outside the project folder and never committed, a second copy on another disk or machine, a retention policy, SuperAdmin-only start, download and restore, an optional encryption switch, a restore script and a documented restore rehearsal with measured recovery time and data-loss window; alerts for a missing backup. | A restore into a clean database passes row counts and an application smoke test. |
| **7. Demo with ready data** | A Demo instance seeded with several fictional shops (different currencies and categories), orders in each status, stock examples, a pre-created SuperAdmin and shop-owner accounts shown on the sign-in page, and a one-click reset per shop and for the whole Demo. The Demo cannot reach production data. | Fresh Demo is usable with no setup; reset restores the same data. |
| **8. Hardening and release** | Independent security review, rate limits per tenant, secrets handling, HTTPS and Cloudflare Tunnel, log redaction, monitoring, real-device PWA tests, cutover and rollback runbook. | AC-16 and AC-17 evidence recorded in [PRODUCTION_ACCEPTANCE.md](PRODUCTION_ACCEPTANCE.md). |

## Security rules that apply to every phase
- Every request derives principal, role and tenant on the server; client claims are ignored except a shop code that is checked against the account's memberships.
- A repository call without tenant context fails closed. Foreign IDs behave exactly like missing IDs.
- Secrets live in environment or secret files, never in the repository or logs. Logs hold no tokens or personal data.
- Demo-only features (passwordless login, reset) must be impossible to enable in production mode; tests assert they return 404 there.
- Changes to authentication, tenancy or backups are merged only with their negative tests.

## Owner answers and decisions on the open items (2026-10-05)

| Item | Decision |
| --- | --- |
| Shop codes | Letters and digits only, no other characters; stored lower case, 3 to 30 characters, with a reserved list (`admin`, `api`, `demo`, `s`, `www`, and similar). The code **must be changeable**. A change keeps the old code as a redirect to the new one so bookmarks, printed links and QR codes keep working. Browser-side data is keyed by an internal shop id, not by the code, so a change does not lose carts or order history. An installed PWA is tied to the code in its path, so after a change it opens through the redirect and should be reinstalled; the UI warns before a rename. |
| Staff and users | Every shop has its own staff accounts, created and removed by its Owner (and by the SuperAdmin). Roles are decided below. Buyers stay guests with no account. |
| Backups | Plain, unencrypted dumps so they are easy to import and export; **only the SuperAdmin** can start, download or restore them. Safeguards that do not cost convenience: files readable only by the backup user, stored outside the project folder and never committed, a second copy on a different disk or machine, and an optional encryption switch that can be turned on later. See Phase 6. |
| Hosting | Now: the Mac Mini runs Docker and PostgreSQL and is published through a Cloudflare Tunnel on the owner's domain. Later: an Ubuntu server with Docker, using the same Compose files. |
| TOTP | Mandatory for the SuperAdmin. Optional for shop accounts (each person can turn it on; an Owner can require it for their shop later). Not used in the Demo. |
| Cost | The owner wants this to cost nothing extra: Mac Mini plus Cloudflare Tunnel for Production, and the existing free Cloudflare Worker for sharing the Demo. See "Demo hosting" below. |

### Shop roles

| Action | Owner | Manager | Staff |
| --- | --- | --- | --- |
| View orders, buyer contact and addresses, print documents | yes | yes | yes |
| Ship and deliver orders | yes | yes | yes |
| Confirm, reject and cancel orders | yes | yes | no |
| Create and edit products, prices and stock | yes | yes | no |
| Shop settings, company currency, WhatsApp number | yes | no | no |
| Add, remove and change staff accounts | yes | no | no |
| Delete an order's personal data, export shop data | yes | no | no |

The SuperAdmin is a platform role, not a shop role: it creates, disables and renames shops, assigns Owners, runs backups and restores, and can enter a shop for support only through an explicit, audited action.

### Demo hosting

Keeping the Cloudflare Worker and Durable Object for the public Demo is possible and costs nothing on the free plan. It is not the same code path as Production: the Worker uses SQLite inside the Durable Object, Production uses PostgreSQL, so the tenant model and its tests have to work on both stores. The async storage phase (Phase 1) is needed either way. Two ways to run the Demo:

| Option | Free | One storage layer | Always on | Isolation from Production data |
| --- | --- | --- | --- | --- |
| A. Demo as a second Docker instance on the Mac Mini with its own database and its own path or hostname on the tunnel | yes | yes | only while the Mac Mini and its internet are up | separate database, same machine |
| B. Demo stays on Cloudflare Worker and Durable Object | yes | no, SQLite and PostgreSQL are both maintained | yes, independent of the Mac Mini | physically separate |

Recommendation: build Production and the Demo as option A (one codebase, one storage layer, fewer bugs), and keep the current Worker Demo online unchanged until that Demo is proven. Choose B if the Demo must stay reachable when the Mac Mini is off and the owner accepts the extra work of two storage layers.

## Final decisions (2026-10-05, second round)

| Item | Decision |
| --- | --- |
| Demo hosting | Option A: the Demo is a second Docker instance with its own database, published through the same Cloudflare Tunnel. |
| Host machine | A MacBook Air, temporary, runs Docker, PostgreSQL and the tunnel for both Production and the Demo. Moving to an Ubuntu server or a cloud host later uses the same Compose files. A laptop can sleep, lose power or lose its network, so sleep must be disabled and the machine kept on power while it serves customers. |
| Renaming a shop code | SuperAdmin only. A shop Owner cannot rename their own shop. |
| Second backup copy | Deferred. For now only the regular data backup is made (Phase 6), stored outside the project folder. A second copy on another disk or machine should be added before real customers rely on the system, because a single copy on the same machine is lost if the machine fails. |

### Consequence for the Cloudflare Worker version

Production and the Demo both run on the Node server with PostgreSQL, so the application code becomes asynchronous (Phase 1). The Worker's Durable Object cannot run that code: its SQL API only supports transactions through a synchronous callback (`transactionSync`), which cannot wait on asynchronous work. The Worker build is therefore **frozen** at the last pre-conversion commit (tag `worker-demo-final`) and the currently deployed Worker Demo keeps running unchanged, without new features, until the Docker Demo replaces it in Phase 7. After that the Worker files, `wrangler.jsonc`, the Worker CI step and the Worker tests are removed from `main`. History and the tag keep them recoverable.

### Later cloud hosting

When the project moves off the laptop, any small VPS that runs Docker will do (2 vCPU and 4 GB RAM is a reasonable start). Providers with a Singapore region, which suits Malaysian and Singapore customers, include DigitalOcean, Vultr, Linode (Akamai), AWS Lightsail and Hetzner. Prices and regions change, so compare current offers. Prefer a provider that offers automatic disk snapshots, and decide then whether PostgreSQL stays in a container or moves to a managed database.

## Not in scope here
Payment, courier booking, WhatsApp messaging and marketing features follow later, per [INTEGRATIONS.md](INTEGRATIONS.md); they build on the tenant and account model from phases 3 and 4.
