# Multi-tenant production plan (Docker, PostgreSQL, SuperAdmin)

**Status: plan approved in outline by the owner on 2026-10-05; nothing here is implemented.** It turns the review draft in [ADMIN_MULTI_COMPANY_DESIGN.md](ADMIN_MULTI_COMPANY_DESIGN.md) into ordered, separately mergeable phases. The data model, authorization and migration rules in that draft still apply; this plan adds the owner's decisions, the runtime question and the build order.

## Owner decisions (2026-10-05)

| Topic | Decision |
| --- | --- |
| Runtime and database | Docker with PostgreSQL for Production. |
| Tenants | One tenant per shop or company, with one **SuperAdmin** above all tenants. |
| Tenant URLs | Path style: `/s/{shop-code}/shop/` and `/s/{shop-code}/seller/`. One domain and one certificate; works through Cloudflare Tunnel. Custom domains per shop can be added later. |
| Sign-in security | Password plus mandatory TOTP code for the SuperAdmin; tenant accounts get TOTP too (policy to be set per tenant). |
| Personal data | Orders are kept permanently; a seller can delete an order's buyer contact and address data manually, with an audit record. |
| Backups | Required: encrypted, scheduled, off-host, with a rehearsed restore. |
| Demo | Must be easy to test with data already in place (several pre-seeded shops, one-click reset). |
| Process | Design first, then one phase at a time, each merged and reversible on its own. |

## Can the Cloudflare Durable Object version run in Docker?

Not as such. A Durable Object is a Cloudflare-hosted service: its storage, single-writer guarantee and persistence come from Cloudflare. The open-source `workerd` runtime behind `wrangler dev` can run a Worker and a Durable Object in a container with local files, but that is a development tool: no managed durability, backups, replication or support, and it would not use PostgreSQL. It is not a sound base for a secure multi-tenant production system.

What does run in Docker is the **Node server** that already exists. The API (`src/app.js`) is runtime-neutral, so Docker with PostgreSQL needs a PostgreSQL storage adapter, not a rewrite of the routes. Recommendation: the Demo also runs from the same Docker image and code, as a second instance with its own database and `SHOP_MODE=public-demo`, so only one storage layer is maintained. The Cloudflare Worker version stays as it is until the Docker Demo replaces it; no new feature work targets it after Phase 1.

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
| **4. Accounts and SuperAdmin** | Principals and memberships replace the single config-file admin: SuperAdmin plus per-shop owner and staff roles; TOTP enrolment and recovery codes; password change; session revocation; login audit and lockout. SuperAdmin console to create, disable and inspect shops and assign owners. SuperAdmin has no silent access to shop data: entering a shop is an explicit, audited action. | Authorization matrix tests; revocation takes effect on the next request. |
| **5. Manual deletion and retention** | Seller action to erase an order's buyer contact and delivery data (order number, items, amounts and status are kept), with confirmation and an audit event; SuperAdmin tenant offboarding and export. | Tests prove only personal fields change and the audit row exists; policy text reviewed by the owner. |
| **6. Backups and restore** | Scheduled `pg_dump` or base backups, encrypted with a key kept off the server, copied off-host, retention policy, a restore script and a documented restore rehearsal with measured recovery time and data-loss window; alerts for a missing backup. | A restore into a clean database passes row counts and an application smoke test. |
| **7. Demo with ready data** | A Demo instance seeded with several fictional shops (different currencies and categories), orders in each status, stock examples, a pre-created SuperAdmin and shop-owner accounts shown on the sign-in page, and a one-click reset per shop and for the whole Demo. The Demo cannot reach production data. | Fresh Demo is usable with no setup; reset restores the same data. |
| **8. Hardening and release** | Independent security review, rate limits per tenant, secrets handling, HTTPS and Cloudflare Tunnel, log redaction, monitoring, real-device PWA tests, cutover and rollback runbook. | AC-16 and AC-17 evidence recorded in [PRODUCTION_ACCEPTANCE.md](PRODUCTION_ACCEPTANCE.md). |

## Security rules that apply to every phase
- Every request derives principal, role and tenant on the server; client claims are ignored except a shop code that is checked against the account's memberships.
- A repository call without tenant context fails closed. Foreign IDs behave exactly like missing IDs.
- Secrets live in environment or secret files, never in the repository or logs. Logs hold no tokens or personal data.
- Demo-only features (passwordless login, reset) must be impossible to enable in production mode; tests assert they return 404 there.
- Changes to authentication, tenancy or backups are merged only with their negative tests.

## Open items for the owner
1. **Shop codes**: allowed characters and whether a code can change after launch (changing breaks bookmarked links).
2. **Staff roles** inside a shop: owner only, or owner plus staff with fewer rights (for example staff cannot delete personal data or change settings).
3. **Backups**: where the off-host copy goes, how long to keep it, and who holds the encryption key.
4. **Hosting**: the server that runs Docker and PostgreSQL, and whether the database runs in a container or as a managed service.
5. **TOTP for shop accounts**: mandatory for everyone, or optional for staff.
6. **Existing Demo data**: keep the current Worker Demo online until the Docker Demo replaces it, then retire it.

## Not in scope here
Payment, courier booking, WhatsApp messaging and marketing features follow later, per [INTEGRATIONS.md](INTEGRATIONS.md); they build on the tenant and account model from phases 3 and 4.
