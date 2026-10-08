# WhatsApp Cloud integration: implementation plan

Status: plan for owner review. Nothing here is implemented. Written against `main` (schema 20); slice 1 moves it to schema 21. It turns sections 4, 5, 6.3, 6.5 and 8 of [INTEGRATION_DESIGN.md](INTEGRATION_DESIGN.md) into pull requests; it does not change those decisions. WhatsApp QR (6.4) and Ninja Van (6.1) are separate plans.

Facts are marked **[repo]** (checked in this repository) or **[assumed]** (vendor behaviour to re-check against Meta's documentation before the slice that needs it).

## 1. Scope of the first release

- Send three order messages through the seller's own WhatsApp Business account: order submitted, order confirmed or rejected, order shipped. Template messages only.
- Send only when the buyer ticked consent for that order (`whatsapp_opt_in`), and never twice for the same order and kind.
- Receive Meta's webhook: delivery and read receipts update the outbox; buyer replies are stored and shown read-only in the seller panel.
- Not in scope: free-text answers from the panel, media, WhatsApp QR, couriers, automatic sending of any other kind.

## 2. What already exists

- **[repo]** `src/whatsapp-webhook.js`: `parseWhatsAppWebhook` turns an already verified body into replies and statuses (bounded, unknown fields ignored); `senderHash` and `advanceOutboxStatus` are exported beside it, and `verifyMetaSignature` (raw-body HMAC check) lives in `src/integration-contracts.js`. No route calls any of them.
- **[repo]** `src/secret-box.js`: AES-256-GCM sealing bound to a context string, key file `id=base64key` per line, rotation by resealing. No table stores sealed values yet.
- **[repo]** `src/integration-requests.js`: `buildWhatsAppMessageRequest` and `normalizeProviderStatus('WHATSAPP_CLOUD', …)`; `src/integration-ledger.js` and `src/integration-consent.js` hold the intent, outbox, lease, retry and `RECONCILE` rules, today bound to a synthetic company and an in-memory store.
- **[repo]** `shop_order` already carries `whatsapp_opt_in`, `whatsapp_consent_at`, `whatsapp_consent_version`. The seller list at `GET /api/v1/seller/integrations` is a static catalog hidden by `SHOW_INTEGRATIONS = false`.
- **[repo]** The updater now applies additive schema upgrades after a verified backup. A new Docker secret (the master key) is allowed by the compose gate because existing secrets stay unchanged; the key file itself must exist on the host once (see slice 0).

## 3. Slices (one pull request each, in order)

| # | Slice | Schema | Who writes it | Verification |
| --- | --- | --- | --- | --- |
| 0 | **Done (#105).** Master-key secret: compose entry, loader, host key file, health check that fails closed without it | none | me | updater test, compose gate test, key-loading unit tests |
| 1 | **Done.** Tables `integration_connection`, `integration_audit`, `webhook_receipt`, `message_outbox`, `message_inbound` (schema 21) with SQLite and PostgreSQL parity, grants, upgrade test from schema 20 | 21 | me (data model and migration are the risky part) | schema compatibility tests, restore-a-real-backup upgrade rehearsal |
| 2 | **Done (#107).** Connection store: save (seal with context `WHATSAPP_CLOUD:<env>`), verify against Meta with the allow-listed host, status, rotate, disconnect, audit rows; write-only responses | none | Codex, from my written spec | unit tests with a fixture transport; a test that no response or log contains the secret |
| 3 | **Done.** Seller "Connections" page for WhatsApp (connect, status, last 4 characters, rotate, disconnect); behind a flag until slice 5 | none | Codex for markup and wiring, I review the UI in a browser | browser check at desktop and 390 px; i18n keys for all seven languages |
| 4 | **Done.** Outbox sender: queue on order events with key `order id + kind`, consent check, bounded retries, `RECONCILE` for unknown outcomes, rate limits | none | Codex for the worker and tests, I review the state rules | duplicate-send test, retry and lost-response tests, no real network |
| 5 | **Done.** The connection also seals the Meta app secret and a reply hash key next to the access token, and keeps a verify token for the handshake. Webhook route: verify signature over the raw body, size limit, dedupe in `webhook_receipt`, apply receipts to the outbox, store replies | none | me (trust boundary) | signature, replay, oversize, unsigned and malformed-body tests; threat-model update |
| 6 | Replies in the seller panel: unread count in the menu, list, order detail section, retention and deletion with the order | none | Codex, I review privacy rules | browser check, deletion test |
| 7 | Live enablement with a Meta test number, then the owner's real account | none | me, with the owner for credentials | one real message to a number the owner controls, receipt seen in the panel |

Slices 0 and 1 must land first; 2 and 5 can be built in parallel after 1; 3 needs 2; 4 needs 1 and 2; 6 needs 5.

Note for slice 7: the live shop currently has quick sign-in on (the passwordless sample entry). Connections are refused while it is on, so the stack that gets the owner's real WhatsApp account must have `SELLER_QUICK_LOGIN` off.

## 4. Delegation rules for Codex and Pi

- One slice, one isolated git worktree and branch; the task text names the exact files it may create or edit and the test command it must run.
- Run in the background; I am woken when it ends and set a fallback follow-up at about one and a half times the expected time.
- I never merge on its report alone: I read the whole diff, run the full test suite (SQLite and PostgreSQL) and, for UI, check in a browser.
- Nothing that touches secrets, signature checking, consent, the migration or the compose and updater files is delegated.
- Fixtures and fictional data only; no real credentials, numbers or network calls in tests.

## 5. Needs from the owner

- Slice 0: create the master key file on the MacBook Air once (32 random bytes, base64, `id=key` line) and keep a copy separate from the database backups. A lost key makes stored credentials unrecoverable.
- Slice 7: a Meta developer app with a test phone number, the three approved templates (names and languages), and the permanent access token pasted into the seller page, never into chat or git.
- Confirm the template wording the buyer will see, and that buyers in Singapore and Malaysia receive the same text.

### Template contract (slice 4)

The owner creates these four templates in Meta, in every language the shop uses (language codes `en`, `ms`, `zh_CN`, `vi`, `th`, `ja`, `ko`), with exactly these names and body variables, in this order. A mismatch is rejected by Meta and the message ends as `FAILED`.

| Template name | Sent when | Body variables |
| --- | --- | --- |
| `order_submitted` | the buyer submits the order | `{{1}}` buyer name, `{{2}}` order number |
| `order_confirmed` | the seller confirms | `{{1}}` buyer name, `{{2}}` order number |
| `order_rejected` | the seller rejects | `{{1}}` buyer name, `{{2}}` order number |
| `order_shipped` | the seller ships | `{{1}}` buyer name, `{{2}}` order number, `{{3}}` carrier, `{{4}}` tracking number (`-` when empty) |

Rules the sender follows: only orders whose buyer ticked the WhatsApp consent; only events newer than the connection and at most 6 hours old (no backlog after a reconnect); never in a sample shop; the production connection wins over sandbox when both exist. Each message is claimed with one atomic update, sent outside any transaction, and recorded as `ACCEPTED`, `FAILED` (rejected by Meta) or `RECONCILE` (outcome unknown: timeout, network error, 429, 5xx, unparsable answer, or a claim that outlived its 2 minute lease). `RECONCILE` is never retried automatically; showing and resolving those rows belongs to the seller panel (slice 6). Only failures before anything left the server (connection or consent gone) are retried, with backoff, up to 5 attempts. Known limit: a status webhook that arrives before the send result is recorded finds no message id and is consumed by deduplication, so that message stays `ACCEPTED`.

## 6. Risks

- Meta's payload shapes and template rules are **[assumed]**; slice 5 and slice 7 start by re-reading the current documentation and adjusting the fixtures.
- Template approval and business verification take external time and can block slice 7 even when the code is done.
- A response lost after the request left is the duplicate-message risk; `RECONCILE` plus the idempotency key exist for it and slice 4 must prove it with a test.
- Replies are personal data; retention and lawful basis (DEC-07) are still to be confirmed before slice 6 goes live.
