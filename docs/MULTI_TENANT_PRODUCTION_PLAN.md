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

What does run in Docker is the **Node server** that already exists. The API (`src/app.js`) is runtime-neutral, so Docker with PostgreSQL needs a PostgreSQL storage adapter, not a rewrite of the routes. Recommendation: the Demo also runs from the same Docker image and code, as a second instance with its own database and `SHOP_MODE=public-demo`, so only one storage layer is maintained. The Cloudflare Worker version keeps working because both engines share the same synchronous storage contract (see "Storage approach").

## Storage approach (updated 2026-10-05)

The application code uses a **synchronous** storage contract (`get`, `all`, `run`, `transaction` in [store.js](../src/store.js)). An earlier version of this plan assumed PostgreSQL needed an asynchronous rewrite of every module. That is not needed: the PostgreSQL stack from PRs #10 and #11 keeps the synchronous contract by running libpq's `querySync` (`pg-native`) inside a dedicated worker thread ([postgres-store.js](../src/postgres-store.js), [postgres-server.js](../src/postgres-server.js)), so the HTTP thread stays responsive while the worker waits on the database. Consequences:

- The same business code runs on SQLite (local, Cloudflare Durable Object) and on PostgreSQL (Docker). The Cloudflare Worker Demo does **not** need to be frozen; the earlier freeze idea is withdrawn.
- One database connection per backend process serializes queries. That is adequate for a small number of shops on one machine; scaling out later means a connection pool and an asynchronous contract, which stays possible because callers only use the contract.
- `pg-native` compiles libpq, so it is an **optional** dependency: `npm ci` still succeeds on hosts without PostgreSQL headers (such as the Cloudflare Workers build), and only the PostgreSQL image installs it with libpq headers.
- SQL differs between the engines. The SQLite migrations in [db.js](../src/db.js) and the PostgreSQL schema in [postgres-schema.js](../src/postgres-schema.js) are maintained side by side and must change together; the schema version is shared.

A Cloudflare Workers Build is connected to this repository and builds pushes and pull requests. A failing build there should be treated as a deployment blocker for the Demo.

## Phases

Each phase is its own pull request or short series, leaves the Demo working, and has a rollback.

| Phase | Scope | Done when |
| --- | --- | --- |
| **0. Decisions and environment** | Owner decisions recorded. The Docker PostgreSQL stack and CI smoke test come from PR #11. | Done once PR #10 is merged. |
| **1. Async storage contract** | Not needed (see Storage approach). | Withdrawn. |
| **2. PostgreSQL adapter and schema** | Mostly delivered by PR #11 (synchronous adapter, schema, Compose stack, encrypted backup and restore drill). Remaining: keep the PostgreSQL schema in step with every SQLite migration, and run the application scenarios against a real PostgreSQL server in CI. | A scenario suite passes on SQLite and PostgreSQL. |
| **3. Tenant model** | Built in slices. **3a Data model:** `shop` table with code and aliases, `shop_id` on every tenant table, per-shop order numbers, idempotency, categories and settings, a shop-scoped store handle, SQLite migration and PostgreSQL schema, cross-tenant tests. **3b Routing:** `/s/{shop-code}/` for the API and the shop and seller pages, old-code redirects, per-shop browser storage and service-worker scopes. **3c Shop administration:** SuperAdmin API and console to create, rename and disable shops. Row-level security in PostgreSQL follows as a second barrier. | Cross-tenant tests pass: same SKU, phone number and idempotency key in two shops; foreign IDs return 404; no request without shop context can reach tenant tables. |
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

Keeping the Cloudflare Worker and Durable Object for the public Demo is possible and costs nothing on the free plan. It is not the same code path as Production: the Worker uses SQLite inside the Durable Object, Production uses PostgreSQL, so the tenant model and its tests have to work on both stores. Two ways to run the Demo:

| Option | Free | One storage layer | Always on | Isolation from Production data |
| --- | --- | --- | --- | --- |
| A. Demo as a second Docker instance on the Mac Mini with its own database and its own path or hostname on the tunnel | yes | no longer an issue: both engines share one contract | only while the Mac Mini and its internet are up | separate database, same machine |
| B. Demo stays on Cloudflare Worker and Durable Object | yes | yes: SQLite and PostgreSQL share one contract, but both schemas are maintained | yes, independent of the Mac Mini | physically separate |

Recommendation: build Production and the Demo as option A (one codebase, one storage layer, fewer bugs), and keep the current Worker Demo online unchanged until that Demo is proven. Choose B if the Demo must stay reachable when the Mac Mini is off; the extra cost is keeping SQLite migrations and the PostgreSQL schema in step.

## Final decisions (2026-10-05, second round)

| Item | Decision |
| --- | --- |
| Demo hosting | Option A: the Demo is a second Docker instance with its own database, published through the same Cloudflare Tunnel. |
| Host machine | A MacBook Air, temporary, runs Docker, PostgreSQL and the tunnel for both Production and the Demo. Moving to an Ubuntu server or a cloud host later uses the same Compose files. A laptop can sleep, lose power or lose its network, so sleep must be disabled and the machine kept on power while it serves customers. |
| Renaming a shop code | SuperAdmin only. A shop Owner cannot rename their own shop. |
| Second backup copy | Deferred. For now only the regular data backup is made (Phase 6), stored outside the project folder. A second copy on another disk or machine should be added before real customers rely on the system, because a single copy on the same machine is lost if the machine fails. |

### Later cloud hosting

When the project moves off the laptop, any small VPS that runs Docker will do (2 vCPU and 4 GB RAM is a reasonable start). Providers with a Singapore region, which suits Malaysian and Singapore customers, include DigitalOcean, Vultr, Linode (Akamai), AWS Lightsail and Hetzner. Prices and regions change, so compare current offers. Prefer a provider that offers automatic disk snapshots, and decide then whether PostgreSQL stays in a container or moves to a managed database.

## Not in scope here
Payment, courier booking, WhatsApp messaging and marketing features follow later, per [INTEGRATIONS.md](INTEGRATIONS.md); they build on the tenant and account model from phases 3 and 4.

## Phase 3a status: shop data model (implemented 2026-10-05, not deployed)

Schema version 14 introduces shops. In this repository a "shop" is the tenant that the older design draft calls a "company".

| Item | How it works |
| --- | --- |
| Tables | `shop` (id, code, name, status ACTIVE or DISABLED, mode demo or production) and `shop_code_alias` (old codes that redirect). `shop_id NOT NULL` with a foreign key on `product`, `general_code` (categories), `shop_order`, `checkout_idempotency`, `company_setting` and `order_sequence`. The old `shop_setup` table is folded into `shop`. Children such as `delivery`, `order_item`, `order_event` and gallery images reach their shop through their parent. |
| Per-shop uniqueness | SKU, variant option, category code and label, order number and idempotency key are unique per shop. Each shop has its own order number sequence and settings, so the same SKU, phone number or idempotency key can exist in two shops. |
| Shop-scoped store | `scopeStore(store, shopId)` ([tenant.js](../src/tenant.js)) returns the store plus a read-only `shopId`. Every repository function reads it with `shopIdOf()` and puts it in each WHERE clause and INSERT. A foreign shop's IDs behave like missing ones (404). |
| Transitional rule | Code that still passes the plain store works while exactly one shop exists (the existing deployments) and fails closed with `SHOP_CONTEXT_REQUIRED` as soon as a second shop exists. The HTTP layer must therefore resolve a shop for every request before more than one shop is created (Phase 3b). |
| Shop administration | [shops.js](../src/shops.js): create, list, resolve a code (with redirect to the current code), rename a code (old code kept as an alias, only reserved or taken codes refused), disable and enable. No API or console exposes it yet (Phase 3c). |
| Existing data | Migration 14 turns the existing data into the shop `main` with its previous name and mode. Counts and rows are preserved. |
| PostgreSQL | The fresh schema and an in-place upgrade from version 13 are in [postgres-schema.js](../src/postgres-schema.js); the upgrade runs automatically at start-up. Take a backup before the first start of this version. |

### Verification

- SQLite: `npm test` (the new `test/tenant.test.js` covers code rules, isolation of products, categories, settings, orders, order numbers, idempotency, status lookup, stock and fulfilment, code rename and redirect, disable, and demo reset per shop).
- PostgreSQL: the same tenant tests plus `test/postgres-upgrade.test.js` run against a real server when `PGTEST_HOST`, `PGTEST_PORT`, `PGTEST_DATABASE`, `PGTEST_USER` and `PGTEST_PASSWORD_FILE` point at a disposable database; CI starts a PostgreSQL 16 service and sets them.
- Cloudflare Durable Object: a local `wrangler dev` object created by the previous release (schema 12, with orders, a gallery image and idempotency keys) was started with this version. It migrated to schema 14 with all data intact, then accepted new orders and a demo reset. A Durable Object enforces foreign keys at all times, so a table that other tables reference cannot be dropped while it still has dependents; migration 14 copies the dependents aside, rebuilds the parents and restores the dependents, and schema 13 no longer rebuilds tables (the earlier version of migration 13 failed on a Durable Object that already held orders).
