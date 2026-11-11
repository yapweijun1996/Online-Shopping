# AI Studio cost analytics and budgets

Schema36 adds shop-local USD cost estimates and Owner-only budget configuration. It preserves the independent daily call cap. Budget periods use UTC dates and calendar months. No real model request is used by the automated acceptance tests.

## Accounting boundary

`ai_studio_usage` remains the call ledger. `ai_studio_cost` adds immutable first-observed model, whitelisted token metadata, price snapshot and integer micro-USD estimate. Existing calls without a cost record are unknown, not zero. A provider response is metered before parsing its business output; a refusal/malformed business answer can therefore have a known estimate. Timeout, connection interruption and provider5xx remain possibly charged. Explicitly rejected authorization/request/rate-limit failures release the call count. Process-crash PENDING rows remain unknown until their accounting period expires; historical records are not deleted.

Prices use the OpenAI standard USD snapshot dated2026-11-11: gpt-6-astra input10, cached input1, output50 USD per million tokens; gpt-image-2.5-sunburst text input5, image input8, output30. Only complete supported usage is priced. Unsupported models, missing usage, invalid counters and unsupported nonzero token categories remain unknown. No real provider invoice is connected. Estimates exclude taxes, account adjustments and calls made elsewhere with the same key. Historic cost records retain their snapshot; new price revisions must use a new version identifier. Sources: https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/guides/image-generation .

## Enforcement and UI

Owner sets optional daily/monthly budgets (USD0.01–100000), warning threshold1–100%, and WARN/BLOCK. Empty budgets are disabled. Updates require revision CAS, Origin, CSRF and existing `ai.settings` Owner capability, and append an audit event. Analytics is Owner-only; normal catalog operations retain their current capability. The general AI Studio status exposes cost totals only to Owner.

WARN allows calls while displaying estimates and alerts. BLOCK is intentionally conservative: the current vision and image requests do not have a proven maximum billable cost. When any BLOCK budget is configured, calls are rejected before reservation/provider invocation with `AI_STUDIO_BUDGET_UNCERTAIN`; if the known estimate has already reached the limit, `AI_STUDIO_BUDGET` is returned. The mode selector and help state this explicitly. It does not advertise an account-wide guaranteed billing ceiling. Owner can select WARN to keep using those requests. Budget checking uses the existing store-owned writer transaction, preserving SQLite/PostgreSQL concurrency semantics. No client-supplied cost is trusted. No fake fixed per-call reservation is used.

The Usage & budget tab shows daily/monthly known estimated totals, unknown call counts, budget balance estimates, daily trend, operation/model breakdown and paginated call details. Ranges are today,7/30/90 days, current month or validated custom dates up to366 days; details use25/page, maximum100/page and offset10000. Missing historical costs are visibly unknown. Monetary estimates never substitute for OpenAI invoices. Seven supported languages and shared Seller palette tokens apply.

## Persistence and release

Only three tables are added: ai_studio_budget, ai_studio_cost and ai_studio_budget_event. No old table columns or data are rewritten. Defaults are WARN with no monetary budget. SQLite migration35→36 and explicit PostgreSQL upgrade35→36 are idempotent, preserve existing usage and provide the existing application role grants. Import includes all three tables; the singleton is handled as a baseline default. Readiness verifies new columns and singleton. Compatible MCP/inventory storage guards now accept schema36 without changing their frozen manifests or authority rules.

GCP requires a manual protected/schema release: stop release-related writers/timers according to the reviewed operator protocol; private cluster backup and independent restore proof; upgrade default and applicable tenant schemas with the exact reviewed source; activate verified immutable images; check internal/public readiness and published UI assets. Keep the prior app images. An application rollback must stop new writers and explicitly return schema_meta to35 after verifying only these additive changes; retain new tables and their audit/cost records. Do not delete data or bypass readiness.

## Local recovery validation

Run the recovery suites against a loopback disposable PostgreSQL16 test cluster with `NODE_ENV=test`, `SHOP_TEST_DATABASE_URL`, and optional `SHOP_TEST_PG_BIN` pointing to the absolute PostgreSQL16 bin directory (Linux default `/usr/lib/postgresql/16/bin`; Homebrew example `/opt/homebrew/opt/postgresql@16/bin`). Tool names remain restricted to pg_dump/pg_restore, shell-free invocation and each fixture's test/loopback checks remain intact. The rich-detail recovery fixtures pin the original schema34 and35 source hashes, then restore actual dumps and upgrade to36; digest comparisons cover every table that existed in the pinned legacy schema, while the budget suite separately verifies additive36 state and usage preservation.
