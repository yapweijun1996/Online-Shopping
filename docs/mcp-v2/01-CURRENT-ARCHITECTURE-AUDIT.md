# Online-Shopping MCP v2 — current architecture audit

## Implementation baseline revalidation, 2026-11-05

**VERIFIED:** the current isolated implementation starts from `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`, branch `codex/mcp-v2-seller-engine`. The fetched `origin/main` still points to that SHA. Direct comparison with the older audit baseline below shows ten added operation prototype files (904 lines); the audited existing OAuth transport, business services, adapters, roles and schema version 29 were unchanged across those baselines. The added prototypes were not wired into `createConnector` at the implementation baseline. They did not establish live approval, consent, migration or business write readiness.

**VERIFIED since that baseline:** phases0–8 and all32 tool names, including independently gated full catalog CREATE/UPDATE, are implemented through the same server and shared services. Root finalb8614b4 passed2012/2012 with0failures/0skips and all browser/native opt-ins; schema34 and acceptance/failed historical snapshots are recorded in [progress](09-IMPLEMENTATION-PROGRESS.md) and [validation](10-FINAL-VALIDATION-REPORT.md). **UNKNOWN:** live production commerce state, real vendor interoperability and operational release gates were not inspected or activated. The following original audit is historical and its labels apply to its stated baseline.

Date: 2026-11-04. Repository: `yapweijun1996/Online-Shopping`.
Baseline: `17bc1de65a83838e0332f2c2cc5271beac6a109b`, branch `codex/mcp-v2-isolated`. This is a source audit of an isolated checkout, not an assertion about live deployment. Existing behavior means behavior at that commit. No live tenant or production database was inspected.

Labels: **VERIFIED** means directly established from this baseline; test execution is reported separately. **HISTORICAL** means a dated document/KB claim, not current deployment proof. **PROPOSED** means not present in the baseline and not permission to deploy. **UNKNOWN** identifies unresolved verification.

## Scope and evidence

**VERIFIED:** Inspected `README.md`, `AGENTS.md`, `docs/FEATURES.md`, `docs/API.md`, `docs/PROGRESS.md`, `docs/PRODUCTION_ACCEPTANCE.md`, `docs/ADMIN_MULTI_COMPANY_DESIGN.md`, `docs/SELLER_MCP_DESIGN.md`, the MCP directory, config, SQLite and PostgreSQL stores/migrations, domain services, tests and CI. This audit calls out material boundaries; the code remains the authority for exact validation and tool schemas.

**HISTORICAL:** Both KBs `online-shopping` (last item 2026-09-28) and `online-shopping-project-knowledge` (last item 2026-11-03), plus Brain recall, were consulted. Several search hits are low-confidence or describe the separate `sample/` prototype; those are not evidence for this runtime. One Brain entry describes the 48-hour stock hold, corroborated by current source. The 2026-09-25 KB assertion that the main runtime did not yet exist is stale. Do not copy its architecture into the present runtime. No KB record was edited.

## Existing MCP entry points, transport and tools

**VERIFIED:** `src/app.js` resolves an active tenant first and builds `createConnector` per tenant. `src/mcp/routes.js` provides discovery, OAuth routes, consent and `/mcp`. `src/mcp/protocol.js` implements stateless JSON-RPC over HTTPS with MCP revision `2025-06-18`, not a separate process. Enablement requires explicit `MCP_ENABLED=1`, HTTPS seller origin, and no quick login. Resource/issuer/tenant are server-bound. Existing request cap is 65,536 bytes, deadline 10 seconds, response cap 262,144 bytes. The protocol checks bearer credentials before and again inside the shared transaction, intersects grant, role and token scopes, rate limits, and records read metadata. Product/order text is explicitly untrusted.

**VERIFIED / INFERENCE:** `src/platform/registry.js` caches tenant metadata for up to 30 seconds and `src/app.js` checks its ACTIVE status when routing. The existing tenant database transaction does not itself hold a platform lifecycle lock. Therefore a future long-running write must not assume this initial check proves the shop remained ACTIVE until commit, especially across instances. The QR integration demonstrates a platform-policy lock held around a tenant operation; adapt and test an appropriate lifecycle lock/lease and lock order for MCP, without assuming that the QR policy is a drop-in solution.

**VERIFIED:** The complete eight-tool registry and executable closed JSON schemas are in `src/mcp/tools.js`:
| Tool | Scope | Behavior |
| --- | --- | --- |
| `catalog.list` | `catalog.read` | Bounded, paginated product projection/search/category. |
| `catalog.get` | `catalog.read` | Product, description and bounded variant projection. |
| `catalog.categories` | `catalog.read` | Bounded categories. |
| `catalog.history` | `catalog.read` | Bounded changed-field names, without actors/free text. |
| `catalog.low_stock` | `catalog.read` | Bounded low stock projection. |
| `orders.list` | `orders.read` | Bounded filterable redacted order summaries. |
| `orders.get` | `orders.read` | Redacted order/delivery/item projection with size bound. |
| `analytics.summary` | `analytics.read` | Existing seller dashboard figures. |

**VERIFIED:** No seller operation proposal, human per-operation approval, business write, operation lifecycle, upload staging or inventory movement ledger is implemented by this registry. Preserve these names, input/output schemas, authorization, redaction and error behavior; adding write scopes to existing grants is forbidden.

## OAuth and account boundaries

**VERIFIED:** `src/mcp/credentials.js` has exactly `catalog.read`, `orders.read`, `analytics.read`, mapped respectively to `catalog.write`, `orders.fulfil`, `figures.read`. Eligibility is active OWNER/MANAGER without a forced password change; STAFF is not eligible even though it may have `orders.fulfil`. Capability decisions use the latest account. Tenant routing selects a separate store, and `liveGrant` checks tenant, issuer, audience/resource, grant expiry/revocation, account auth version, client tenant/issuer and client disabled status. Account changes invalidate grants; access/refresh credentials are stored hashed.

**VERIFIED:** `src/mcp/oauth.js` enforces allowlisted exact HTTPS redirects and PKCE S256, fresh password-bound seller consent with Origin/CSRF checks, up-to-ten-minute pending authorization, 60-second single-use authorization code, access token up to 15 minutes, rotating refresh token up to seven days and grant absolute lifetime 30 days. Refresh is narrowed to granted/current effective scopes. OAuth consent is broad delegated read access, not approval of a specific business operation. `src/mcp/consent.js` is its first-party browser controller.

**VERIFIED:** `src/roles.js`: OWNER alone has `settings.write` and `staff.manage`; OWNER/MANAGER have `catalog.write`, `orders.decide`, `figures.read`; STAFF can fulfill but not decide. Do not invent role capabilities or accept a tenant/account ID from an MCP argument as authority.

## Data and transaction compatibility

**VERIFIED:** Schema version is 29 (`src/db.js`). SQLite uses Node SQLite, foreign keys and `BEGIN IMMEDIATE`; PostgreSQL uses a shared transaction and `pg_advisory_xact_lock(73119, 1)` for app-owned writes (`src/store.js`, `src/postgres-store.js`). Nested store transactions join the outer transaction. `run` discards affected-row counts; compare-and-set must use `UPDATE ... RETURNING` via `get`. PostgreSQL fresh schema is `src/postgres/schema.sql`, upgrades are explicit in `src/postgres/upgrade.js`; SQLite upgrades/readiness are in `src/db.js`. Any additive migration must cover fresh schemas, upgrade from v29, older supported upgrades, readiness, restricted roles and schema compatibility in both engines.

**VERIFIED:** `mcp_audit` currently enforces a fixed event and eight-tool allowlist and is pruned in bounded batches after 90 days (`src/mcp/schema.js`, `src/mcp/credentials.js`). It does not record approval identity or operation metadata. Changing audit retention is out of scope. `product_event` is recorded by `trackCreate`/`trackUpdate` wrappers in `src/product-history.js` from seller HTTP routes, not automatically by `createProduct`/`updateProduct`; calling a domain function alone would silently bypass history. `order_event` is appended in the order decision transaction.

**VERIFIED:** `src/sqlite-import.js` copies seller sessions and OAuth grant/token rows into a fresh PostgreSQL destination and validates row digests; QR credentials are deliberately excluded. Adding v2 consent, pending operations or approvals to that import without a restore policy could reactivate them in a different environment. A v2 migration must explicitly address import/restore and prove that pending approvals and new write authority cannot be resurrected.

**UNKNOWN:** No fully reviewed solution has yet been demonstrated for immutable stored proposals, approval provenance and stale revisions across every seller UI and adapter. There is no existing stock-movement ledger. Company `updated_at` is maintained, but its revision/compare-and-set contract is not exposed by `getCompanySettings`; product uses `updatedAt` and gallery-specific checks, and order uses integer `revision`. Approval and currency policy need implementation and tests, not assumptions.

## Business rules

**VERIFIED — company:** `getCompanySettings`/`updateCompanySettings` in `src/settings.js` support default currency (MYR/SGD), WhatsApp phone, mobile setting, availability/shipping/returns text and sender fields in `src/sender-settings.js`. Company name/registration/store description/branding are not established as writable fields through this service. Currency changes reject when existing products use another currency; no historical order rewrite is permitted.

**VERIFIED — products:** `src/product-input.js` validates required SKU, name, description, category, integer minor-unit price, currency, active flag and existing options/variants/stock; `src/products.js` enforces SKU, active category, company currency, variants, tracking conflicts and gallery logic. Product IDs belong to the already-resolved tenant store. Inactive products are not public. Prices and product facts in placed orders are snapshots. Seller history requires the wrappers above.

**VERIFIED — shared-revision hazard:** `syncListing` in `src/listings.js` updates shared name/description/category on every sibling product row but does not advance each sibling's `product.updated_at`. A preview fenced only by the target product's `updatedAt` can therefore miss a newer edit made through another variant. Gallery ownership, listing moves, option changes, category/currency and SKU uniqueness also affect the commit's dependency set. A product write adapter must fence the authoritative listing and complete affected set, or introduce shared revisions used by every writer; the generic single-resource prototype is not sufficient.

**VERIFIED — images:** `src/product-image.js` accepts canonical base64 PNG/JPEG/WebP with at most 512 KiB original and 80 KiB thumbnail and checks magic signatures against MIME. It does **not** fully decode, check pixel dimensions or detect decompression bombs. `src/product-gallery.js` applies SHA-256 deduplication, ten selected images, product-specific references and shared variant gallery ownership, transactionally. Original and thumbnail bytes are database-backed; some public-demo static references are manifest-backed. MCP body cap cannot carry a maximum image as base64. No URL fetch or server path is needed.

**VERIFIED — inventory:** Null stock is unlimited. Contrary to the requested baseline, `src/stock-reservation.js` and `src/orders.js` compute a hold from quantities in `SUBMITTED` orders younger than 48 hours; checkout subtracts this computed hold from tracked stock. Nothing is stored as a separate reservation. Confirmation deducts actual stock, rejection ends the hold, expiry ends it, and cancellation of a confirmed order restores stock. `docs/API.md:90` agrees but its later line 120 and portions of old documentation say no reservation and are stale. Preserve the actual code and tests; a different reservation rule requires a separate business decision.

**VERIFIED — orders:** `src/seller-orders.js` permits `SUBMITTED→CONFIRMED|REJECTED`, `CONFIRMED→SHIPPED|CANCELLED`, `SHIPPED→DELIVERED`. The current integer revision and state are compare-and-set; reasons/tracking have action-specific validation, order event and stock changes share the transaction. Current totals are server-derived, prices and order items are snapshots. No automatic WhatsApp, refunds, courier shipment creation or deletion should be added.

**VERIFIED — analytics:** `src/dashboard-figures.js` defines UTC+8 business days, separate currencies, accepted statuses CONFIRMED/SHIPPED/DELIVERED, grouping by order submission time and 30-day top five products. Amount is accepted order value, not collected cash or profit. Custom dates, detailed comparisons and movement history are not supplied by that service.

## Current tests, security gaps and readiness

**VERIFIED:** `test/seller-mcp.test.js` covers OAuth PKCE, explicit fresh consent, redaction/injected text, eight read tools, rotation/revocation, role changes, bounds/rates, tenant routing and SQLite/PostgreSQL paths (the latter skipped without a disposable test URL). `.github/workflows/verify.yml` runs Node 24, full tests, PostgreSQL 16 and dependency audit. Its historical success is not a current-run result; see validation report for actual commands and counts.

**UNKNOWN:** Line/branch coverage was not instrumented or measured for the existing connector or the new prototype. The presence of tests and passing counts is not a coverage percentage or proof that every security path is exercised.

**VERIFIED gaps:** The existing consent screen calls all scopes read-only; adding write scopes without a changed consent and opt-in would misrepresent access. There is no trusted operation-specific approval, immutable proposal, idempotency/revision protection for MCP writes, write risk policy, write auditing, bounded upload staging or audit for stock changes. Image signature checks alone do not satisfy the requested decode-level assurance. Existing product history is route-wrapped and can be bypassed by careless adapters. Current audit table rejects new tool names/events. Company has no exposed revision contract. Full v2 is therefore not production-ready.

**UNKNOWN:** Production feature flags, artifacts, live OAuth grants, operational backup/restore, vendor/client compatibility, full cross-process race safety and actual live release state were not inspected in this task. Historical notes in `docs/SELLER_MCP_DESIGN.md` about auto-migration and rollback are warnings to reverify before any future release, not a current production status report.

## Proposed file-level impact and acceptance gates

| Phase | Proposed boundaries / files | Gate before next phase |
| --- | --- | --- |
| 0 | `src/mcp/{credentials,oauth,consent,protocol,schema,routes}.js`, new isolated operation/approval modules, `src/{config,db,roles}.js`, PostgreSQL schema/upgrade, seller approval UI, tests | default off; existing eight unchanged; verified human/session/hash binding, expiry/replay/revocation/role/tenant/concurrent commit and rollback on SQLite and PostgreSQL; audit constraints/retention preserved; migration rollback documented. |
| 1 | `src/settings.js`, company MCP adapter and operation policy | current fields/currency service, explicit high-risk currency approval, revision-safe concurrent seller edit, integration tests. |
| 2 | `src/products.js`, `src/product-history.js`, adapter | create/update through validation plus history wrappers, atomic CAS, no lost seller edit, snapshot/currency/variants. |
| 3 | `src/product-image.js`, `src/product-gallery.js`, bounded upload staging and first-party preview | actual image decode and bounds, ownership, no remote/path input, atomic rollback, old/new human preview. |
| 4 | `src/stock-reservation.js`, products, new migration/ledger and adapter | maintain 48-hour computed holds; atomic stock/ledger; race with checkout/confirmation; null and nonnegative semantics. |
| 5 | `src/seller-orders.js`, operation adapter | exact state machine, immutable decision, approval, event/stock atomicity and single execution. |
| 6 | `src/dashboard-figures.js`, bounded analytical adapters and indexes | independent synthetic fixture calculation, SQLite/PostgreSQL equality, explicit coverage and no mislabeled financial metric. |
| 7 | operation/audit service and restricted projection | ownership, retention, no sensitive raw data, cancellation race and audit correctness. |
| 8 | knowledge integration documentation, not live-commerce authorization | KB failure cannot grant access; untrusted retrieval cannot authorize writes. |

Production deployment, migration and credential handling are not authorized by this audit. See the companion architecture, threat model, test and rollback documents.
