# AGENTS.md

Guidance for coding agents and automated reviewers (including Codex Code Review and Security Review) working in this repository. Repository evidence is the source of truth; when this file and the code disagree, trust the code and fix this file.

Security context lives in [docs/threat-model.md](docs/threat-model.md). Read it before reviewing or changing anything listed under "High-risk areas" there.

## Project snapshot

- Node 24 (`engines`: `>=24.15.0 <25`), ES modules, runtime dependencies `pg` and `libphonenumber-js` only. No frontend build step: `public/` is served as-is.
- `src/app.js` is a runtime-neutral Fetch API router (`Request` → `Response`). `src/server.js` is the Node adapter. `src/store.js`, `src/db.js` (SQLite, migrations) and `src/postgres-*.js` / `src/postgres/schema.sql` (PostgreSQL) share one async store contract (`get`, `all`, `run`, `exec`, `transaction`).
- Production: Docker Compose on OrbStack, PostgreSQL, Caddy, Cloudflare Tunnel (`compose.production.yaml`, `deploy/`). `deploy/auto-update.py` deploys `main` only after the GitHub `verify` workflow passes.
- Customers are guests (no accounts). The seller/admin side has one configured administrator and one shop; there are no per-seller tenants yet (see the threat model and `docs/MULTI_TENANT_PRODUCTION_PLAN.md`).
- There is no payment, no live courier and no automatic WhatsApp integration. `src/integration-*.js` is an offline, synthetic-only foundation that no HTTP route calls.
- `worker-runtime/` is a leftover copy of the Cloudflare Worker runtime; the Worker deployment was removed. Tests still import it, so keep it syntactically valid and do not extend it unless a task says so.

## Commands

```sh
npm ci
npm run check          # node --check over src, worker-runtime and public JS
NODE_ENV=test npm test # full suite (node:test, one worker); PostgreSQL tests need SHOP_TEST_DATABASE_URL
npm run test:integrations
python3 test/auto-update.test.py
```

CI (`.github/workflows/verify.yml`) runs the auto-update test, `npm run check`, `npm test` against PostgreSQL 16, and `npm audit --omit=dev --audit-level=high`.

## Working rules

- Make the smallest correct change. Do not refactor unrelated code or add dependencies without a stated need.
- Reuse existing helpers (`validation.js`, `http.js`, `limiter.js`, store contract) instead of duplicating them.
- Keep SQLite and PostgreSQL behavior equivalent. Any schema change needs a SQLite migration in `src/db.js`, the matching `src/postgres/schema.sql`, and the schema-compatibility tests.
- Preserve customer-facing behavior unless the task explicitly changes it.
- Never commit secrets, `.env*`, `.dev.vars`, `.local/`, database files, or real customer data. Use `ADMIN_PASSWORD_FILE` / `DATABASE_PASSWORD_FILE` style secrets, never inline values, in deploy files.
- Tests must not make real network calls, charges, shipments or WhatsApp sends. Use the deterministic fixtures (`createFixtureIntegrationTransport`, `test/helpers/`) and fictional data.
- Write code, comments, docs and commit messages in English. Do not hardcode fake behavior to simulate success.

## Architecture rules

- Order, payment, fulfillment and shipment are independent state machines. Do not merge them into one generic status, and do not let one provider event write another machine's state. Today only the order status (`SUBMITTED → CONFIRMED/REJECTED → SHIPPED → DELIVERED`, `CONFIRMED → CANCELLED`) and manual tracking fields exist in the production schema; payment, fulfillment and shipment states are future work and must be added as separate, validated state machines.
- Provider-specific logic belongs behind the integration boundary (`src/integration-*.js`: contracts, requests, ledger/outbox, inbox ingress, adapters). Do not call a provider from order, product or seller-order code.
- Integration design direction (currently offline/synthetic): outbox for outbound effects, inbox with deduplication for inbound events, normalization of provider statuses, audit/error records, deterministic simulation providers, PostgreSQL-ready storage.
- Totals, prices and stock are computed and enforced on the server. Client values (`expectedPriceMinor`, `expectedCurrency`) may only be compared against server data, never trusted.
- Every state change goes through a compare-and-set update (`status` and `revision` in the `WHERE` clause) inside a transaction and writes an `order_event` row.

## Code Review Rules

Prioritize real bugs over style. Report only issues you can tie to a concrete failure scenario in this code. Do not comment on formatting, naming taste, or subjective style.

### Severity

**P0 — Critical**
- Exploitable security vulnerability
- Authentication or authorization bypass
- Data corruption or irreversible data loss
- Payment or order amount manipulation
- Leaked production secrets
- Remote code execution
- Cross-tenant or cross-seller data exposure

**P1 — High**
- Functional regression in a production workflow
- Incorrect order, payment, fulfillment or shipment state transition
- Broken seller, customer or admin access control
- Webhook authenticity or replay weakness
- SQL or data-integrity issue
- Race condition causing duplicate orders, payments or shipments
- Unsafe external API integration
- Serious mobile or customer checkout regression

**P2 — Medium**
- Performance or scalability problem
- Missing edge-case handling or weak validation
- Maintainability issue likely to cause future defects
- Incomplete error recovery
- Observability or audit gaps

**P3 — Low**
- Minor maintainability issue, non-blocking UX issue, style or naming cleanup

Focus on P0, P1 and P2. Mention P3 only when it is trivial to fix and attached to a larger finding.

### Check where applicable

**Security**
- Authentication correctness; authorization enforced server-side at every `/api/v1/seller/*` route (session cookie, `requireOrigin`, `requireCsrf` on every mutation).
- IDOR and object ownership: guests may read only the order status for which they hold the access key; seller/admin data must stay behind a session. Any new per-seller or per-company data must be scoped by owner in the query, not in the UI.
- Seller isolation, customer order isolation, admin privilege boundaries (including the passwordless demo session, which must stay unreachable outside `SHOP_MODE=public-demo`).
- SQL injection (parameters only; dynamic SQL limited to fixed allow-listed identifiers), XSS (existing `innerHTML` uses are static templates; never interpolate buyer, product or server text into `innerHTML`, and no `eval`; CSP must stay `script-src 'self'`), CSRF, command/code injection, path traversal (`src/static.js`), SSRF, unsafe redirects.
- Secret or token leakage in code, logs, errors, responses and frontend bundles; error responses must not expose internals.
- Webhook signature verification over the raw bytes with constant-time comparison, replay protection, and duplicate-event handling before any state change.
- API credential handling (references only, never stored or returned in plaintext) and rate-limit/abuse risks (`SqlLimiter` buckets, body-size limits).

**Business logic**
- Order totals computed server-side; quantity bounds; inventory consistency (stock check at submit, deduction at confirm, restore on cancel).
- Payment, order, fulfillment and shipment transitions are validated independently; invalid transitions are rejected.
- Cancellation and refund behavior; retry and idempotency (`Idempotency-Key`, `checkout_idempotency`); duplicate-operation prevention.
- A seller cannot change another seller's resources and a customer cannot read or modify another customer's order, once such boundaries exist.

**Data integrity**
- Transaction boundaries, unique constraints and deduplication, race conditions, partial-write recovery, stale-state updates (`expectedRevision`), and state-machine correctness.
- Migrations and `schema.sql` stay consistent; audit tables (`order_event`) are never rewritten or deleted by application code outside the Demo reset.

**External integrations** (payment provider, Ninja Van, SPX/logistics, WhatsApp, webhook providers, future providers)
- Timeouts, bounded retries, idempotency keys, signature verification, response validation, handling of unexpected provider responses and outages, safe fallback, and no silent state corruption (an unknown outcome must become a reconcile state, not success or failure).
- Never log or store provider tokens, App Secrets, or message bodies beyond what the existing audit design retains.

**Frontend and mobile**
- Checkout flow, cart behavior (IndexedDB/localStorage scoping), My orders status, seller order management, admin operations, service-worker/PWA update behavior, and accessibility of important actions (labels, focus, touch targets).

**Performance**
- Unneeded full-page refreshes, N+1 queries, unbounded loops or result sets (lists must keep `limit`/`offset` caps), large payloads, blocking external calls, and expensive work inside request paths.

## Definition of done for a change

1. Relevant tests added or updated; `npm run check` and `NODE_ENV=test npm test` pass.
2. Security-relevant changes re-read against [docs/threat-model.md](docs/threat-model.md), and that document updated if a trust boundary, entry point or control changed.
3. No secrets, real data or real provider calls introduced.
4. Documentation under `docs/` updated when behavior or the API contract changes.
