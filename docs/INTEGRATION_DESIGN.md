# Integration design: couriers, WhatsApp and per-seller credentials

**Status: design for owner review. Nothing here is implemented.** Written 2026-10-07 against `main` (schema 17). It replaces the sequencing in [INTEGRATIONS.md](INTEGRATIONS.md) and builds on the offline prototype described in [INTEGRATION_FOUNDATION.md](INTEGRATION_FOUNDATION.md) and [INTEGRATION_ADAPTERS.md](INTEGRATION_ADAPTERS.md).

Facts below are marked **[repo]** (checked in this repository), **[docs]** (taken from the earlier vendor-contract notes dated 2026-10-02) or **[assumed]** (general knowledge, to be verified against vendor documentation before work starts).

## 1. Goals

1. A seller connects **their own** Ninja Van account and **their own** WhatsApp Business account by pasting credentials into the seller page; nothing vendor-specific is baked into the code or the deploy files.
2. Orders can create a courier shipment, store the tracking number, and message the buyer, with no duplicate parcels or messages on retries.
3. A sample site can let a visitor try WhatsApp by scanning a QR code, clearly separated from production.
4. Everything ships through the existing auto-deploy gate, with as few manual steps as possible.

Non-goals: payments, marketplace sync, buyer reply inbox in the seller panel (open decision 3 below).

## 2. What exists today

- **[repo]** `src/postgres/schema.sql` has no integration, shipment, message or credential tables. The only related fields are `shop_order.tracking_carrier` / `tracking_no`, `whatsapp_opt_in`, `whatsapp_consent_at` and `whatsapp_consent_version`.
- **[repo]** `src/integration-*.js` is a synthetic, offline prototype: a company-bound ledger with intent, idempotency record and outbox in one transaction, bounded retries, a `RECONCILE` state for unknown outcomes, consent proofs, and request builders for Ninja Van parcels and WhatsApp text. It is not imported by startup, has no tables, no network transport and no credential resolver.
- **[repo]** `GET /api/v1/seller/integrations` returns a static catalog; the seller UI hides it behind `SHOW_INTEGRATIONS = false` (PR #66) until a provider is real.
- **[repo]** The database is single-shop: `shop_setup` has one row and no table carries a shop or tenant id.
- **[docs]** Ninja Van: public order API, separate sandbox and production tokens, label PDF, cancel, status webhooks signed with HMAC-SHA256 (`X-Ninjavan-Hmac-Sha256`), 3-second webhook timeout. SPX: no public contract for independent shops. WhatsApp Cloud: text and template messages, Meta-signed webhooks.

## 3. Tenancy decision (blocks everything below)

Credentials, shipments and message logs must belong to exactly one seller. The current code is single-shop, so there are two ways to serve several clients on `shop.gmb01.xyz` and `seller.gmb01.xyz`:

| | A. One stack per tenant (recommended) | B. One shared stack, `shop_id` column everywhere |
| --- | --- | --- |
| Isolation | Separate database and containers; a bug cannot cross tenants | Every query must filter by shop; one missed filter leaks data |
| Code change | Small: the app stays single-shop | Large: every table, query, test and the idempotency/stock logic |
| Credentials | One master key per tenant, blast radius = one tenant | Shared master key, per-row ciphertext |
| Cost | More containers per client | One stack |
| URLs | Caddy routes `/<tenant>/…` to that tenant's backend | App must be path-aware |

Either way, path URLs such as `shop.gmb01.xyz/abc/` need the frontend to work under a base path (service-worker scope, manifest `start_url`, absolute `/shop/…` links, share routes). That is a separate piece of work and is **not** assumed to exist.

**Recommendation: A.** It keeps the data model below simple (no tenant column), matches today's code, and the sample site can remain its own stack. This design is written for A; B would add a `shop_id` to every table in section 4.

## 4. Data model (schema 18)

All new tables in one migration so only one protected-file change is needed.

```
integration_connection
  id                text primary key
  provider          text   -- NINJAVAN | WHATSAPP_CLOUD | WHATSAPP_QR
  environment       text   -- SANDBOX | PRODUCTION
  status            text   -- NOT_CONFIGURED | CONNECTED | ERROR | DISABLED
  public_config     text   -- JSON, no secrets (country, phone number id, display name)
  secret_ciphertext bytea  -- AES-256-GCM, see section 5
  secret_key_id     text
  last_checked_at, last_error, created_at, updated_at
  unique(provider, environment)

shipment
  id, order_id, delivery_id        -- FK, one parcel per delivery
  connection_id, provider
  request_hash, idempotency_key    -- the same discipline as checkout_idempotency
  status            -- PENDING | CREATED | FAILED | CANCELLED | RECONCILE
  tracking_no, carrier, label_ref
  provider_payload  text           -- sanitized response only
  created_at, updated_at

shipment_event      -- append-only: provider status, raw status, received_at, dedupe_key unique

message_outbox
  id, order_id, connection_id, kind (ORDER_SUBMITTED|CONFIRMED|SHIPPED|…)
  recipient_hash, template, locale, idempotency_key unique
  status (QUEUED|SENDING|ACCEPTED|DELIVERED|READ|FAILED|RECONCILE)
  provider_message_id, attempts, next_attempt_at, last_error

webhook_receipt     -- provider, dedupe_key unique, verified boolean, received_at
integration_audit   -- who connected, rotated or disconnected, no secret values
```

The existing prototype (`integration-ledger.js`) already encodes the intent, outbox, lease and reconcile rules; the work is to replace its synthetic company binding with these tables, not to invent new semantics.

The application role `online_shopping_app` receives table privileges in the same migration (as for schema 17). `secret_ciphertext` is never selected by list endpoints.

## 5. Secrets

- **Never** in git, `compose.production.yaml`, `runtime.env`, the frontend or logs.
- Stored encrypted in `integration_connection.secret_ciphertext` with AES-256-GCM; the 32-byte master key comes from a Docker secret file (the same mechanism as `admin_password`), with a `secret_key_id` so the key can be rotated by re-encrypting rows.
- The seller UI is **write-only**: after saving, it shows only "Connected · last 4 characters", a **Rotate** and a **Disconnect** button. No endpoint returns the secret.
- Saving a credential first makes a harmless authenticated call to the provider (Ninja Van token request; WhatsApp phone-number lookup). Status becomes `CONNECTED` only if it succeeds.
- Every connect, rotate and disconnect is written to `integration_audit` without the value.
- Outbound calls go only to a fixed allow-list of provider hosts (no user-supplied URLs) to avoid SSRF.

## 6. Providers

### 6.1 Ninja Van (shipping)

1. Seller pastes client id and secret for sandbox or production; the backend exchanges them for a short-lived token and caches it in memory.
2. On a confirmed order the seller clicks **Create shipment** (never automatic in the first release). The request is queued as a `shipment` row with an idempotency key, sent by a worker, and the result stores `tracking_no`, `carrier` and a label reference. Existing fields `tracking_carrier` / `tracking_no` are filled so buyers already see tracking.
3. Unknown outcomes (timeout after the request left) go to `RECONCILE` and are **not** retried blindly; the seller sees "Check status" which looks the parcel up before allowing a retry.
4. Label PDF is fetched on demand and streamed, not stored.
5. A webhook endpoint verifies `X-Ninjavan-Hmac-Sha256` over the raw body, rejects replays via `webhook_receipt`, answers within 3 seconds, and applies status changes as `shipment_event` rows (never writes order or payment status directly; it may propose `SHIPPED`/`DELIVERED`, which stay a seller action in the first release).

### 6.2 Shopee Express (SPX)

No public contract **[docs]**. Plan: do not integrate. Offer the existing manual tracking entry, and revisit if SPX or an aggregator (EasyParcel, Delyva) gives API access. Open decision 1 asks whether an aggregator should be the second courier.

### 6.3 WhatsApp Business Platform (production)

1. Seller pastes the permanent access token, phone-number id and business-account id **[assumed]**; the app stores them as in section 5 and shows approved template names fetched from Meta.
2. Messages are business-initiated **templates** (order submitted, confirmed or rejected, shipped), mapped by `kind`; free text only inside the 24-hour window after a buyer reply **[assumed]**.
3. A message is queued only if `whatsapp_opt_in` is true for that order (the checkbox that is already checked by default), and the `message_outbox.idempotency_key` (`order id + kind`) makes a second send impossible.
4. A webhook (verified with Meta's signature) records delivery, read and failure into the outbox.
5. Cost is per message and billed by Meta to the seller's account, not to this system.

### 6.4 WhatsApp QR (sample site only)

- Unofficial client (for example Baileys): **against WhatsApp's terms; the paired number can be banned [docs]**. It must never be offered to a production tenant.
- Runs as a separate container with a persistent session volume; the backend talks to it over the private Docker network with an internal token.
- Only fixed templates; only to the number the visitor enters; limits per visitor, per number and per hour; a visible notice to use a spare number.
- Enabled only when `SELLER_QUICK_LOGIN` is on, so it disappears with the sample site's open login.
- Needs one new compose service, a volume and an env flag (a protected-file change).

## 7. Releases and the auto-deploy gate

Protected files (`compose.production.yaml`, `deploy/cloudflared.yml`, `deploy/init-postgres.sh`, `src/postgres/schema.sql`, `src/postgres-db.js`) make the updater stop at `manual_migration_required` **[repo: `deploy/auto-update.py`]**. This design needs them exactly once:

- **Release P (platform, protected files):** schema 18 migration and grants, master-key secret and its compose wiring, webhook route in the Caddyfile, and (sample site only) the QR service.
- **Releases F1…Fn (features, no protected files):** Ninja Van, WhatsApp Cloud, templates, UI. These auto-deploy like every PR so far.

How to pass the gate for Release P (decision 2):

- **(a) One manual deploy** of that release with a prepared script (backup, schema upgrade as database owner, deploy), then never again.
- **(b) Upgrade the updater once** so it can take a verified backup, run the schema upgrade as the database owner and deploy by itself. After one reinstall, schema changes also auto-deploy. This changes the safety gate, so it needs the owner's explicit approval and a reviewed diff.

Both need one manual step now; (b) removes all future ones. Design neutral on which to pick.

## 8. Privacy and abuse controls

- Recipient name, phone and address go to the courier and to Meta only after the seller connects the provider; the buyer-facing consent text must say so (open decision on retention and lawful basis, "DEC-07" in the earlier plan **[docs]**).
- Message bodies and phone numbers are redacted in logs; `message_outbox` stores a recipient hash, with the number read from the order at send time.
- Webhooks: signature verified before any parsing; bounded body size; dedupe; no secrets in URLs (use an unguessable per-connection path token only as a routing aid, not as authentication).
- All new write endpoints use the existing origin and CSRF checks and the seller session.
- The sample site is rate limited and can never send outside the fixed templates.

## 9. Phases

| Phase | Content | Protected files | Needs from owner |
| --- | --- | --- | --- |
| 0 | Decisions in section 10 | none | answers |
| P | Release P above | **yes, once** | gate choice (a) or (b) |
| 1 | Seller "Connections" page (write-only secrets, connect check, audit) | no | none |
| 2 | Ninja Van: sandbox shipment, tracking fill, label, webhook | no | Ninja Van sandbox client id/secret |
| 3 | WhatsApp Cloud: templates, outbox, webhook, status | no | Meta test app, test number, approved templates |
| 4 | Sample-site QR service | with P | spare test number |
| 5 | Production hardening: reconciliation view, monitoring, retention job | no | none |

Each phase ends with: tests including provider contract fixtures and a retry/duplicate test (as for checkout), a browser check, and a live check after auto-deploy.

## 10. Decisions needed from the owner

1. **Second courier:** an aggregator (EasyParcel/Delyva) or manual tracking only for non-Ninja Van parcels?
2. **Release P gate:** (a) one manual deploy, or (b) upgrade the updater once (approve a reviewed diff)?
3. **Buyer replies:** show WhatsApp replies in the seller panel, or leave them in WhatsApp?
4. **Tenancy:** confirm A (stack per tenant) and decide whether base-path URLs (`/abc/`) are in scope or later.
5. **Which messages first:** suggested order submitted, confirmed or rejected, shipped.
6. **Sample-site QR:** proceed despite the ban risk, with the safeguards in 6.4, or skip it and use the official test number only?

## 11. Risks

- Vendor facts marked **[assumed]** may be out of date; each phase starts by re-reading the vendor documentation.
- Sandbox success does not prove production approval (Meta business verification, template approval, Ninja Van account onboarding take external time).
- A lost provider response after the request left is the main duplicate-parcel risk; the `RECONCILE` state and the idempotency discipline above exist for it.
- Master-key loss makes stored credentials unrecoverable; the key must be backed up separately from the database dump.
