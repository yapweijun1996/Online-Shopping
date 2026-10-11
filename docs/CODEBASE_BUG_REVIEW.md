# Codebase Bug Review — 2026-10-11

Reviewed commit: `41407a7bda20adf167e2825900a268f3949316cc`.

This review records **15 confirmed defects: 7 P1 and 8 P2** at the reviewed commit. Following the approved P1 repair scope, **B01–B07 are fixed and locally verified; B08–B15 remain open**. This commit includes the P1 repairs and review documentation. No push, production deployment or installed-controller update was performed. Finding descriptions and reproductions below preserve the original baseline behavior; source links are pinned to that baseline. This is a bounded review, not a guarantee that every possible defect has been found.

## P1 repair verification — 2026-10-11

| Finding | Current resolution | Regression evidence |
| --- | --- | --- |
| B01 | Own-password verification, active-session recheck, hash replacement and revocation share a transaction with recovery. | `test/p1-regressions.test.js`: overlapping host reset wins and revoked tokens cannot change the recovered password, on SQLite and PostgreSQL. |
| B02 | Login verifies credentials and issues its session in the same transaction. | Actual API login paused at credential read; later recovery revokes the issued session on both stores. |
| B03 | Confirm/cancel advance product timestamps. The editor sends a revision for every variant and omits unchanged stock; preconditions run before shared-gallery stripping. | Stale metadata/stock drafts and non-holder gallery variants return `PRODUCT_CHANGED`; fresh edits work. Real Chromium editor preserves the rejected draft and sends no unchanged stock. |
| B04 | Limited/unlimited tracking switches return `STOCK_TRACKING_CONFLICT` while any affected order is CONFIRMED. No schema migration is needed. | Both tracking directions, rollback, cancellation stock totals and shipping release are covered. Finite-to-finite adjustments remain allowed. |
| B05 | Exact unresolved requests and their keys/context are persisted under shop-scoped storage before send. Reload replays them; corruption/storage failure blocks sends; unresolved intent defers PWA updates. | Eight checkout tests cover reload, changed details, corrected rejections, blocked/corrupt storage, receipt-render failure with an empty cart and an unavailable cart product. Recovery shows the original snapshot without requiring current catalog reads. |
| B06 | Main-only upgrades use maintenance, deployment backup, tracked runners and durable restore intent regardless of platform enablement. | Python regressions cover failed health rollback ordering, unknown main outcome, missing backup, downgrade refusal and failed restore retention. Docker effects are mocked. |
| B07 | Import/fresh-target/digest checks include all five integration/message tables in dependency order. | Real SQLite→PostgreSQL fixture preserves sealed credentials, audit, reconcile outbox, inbound reply and receipt, with every-table digests and schema inventory checks. |

| Post-repair check | Result |
| --- | --- |
| `npm run check` (Node 24.21.0) | Passed |
| `NODE_ENV=test SHOP_TEST_DATABASE_URL=<temporary UTF-8 PostgreSQL 16> npm test` | **522 passed, 0 skipped, 0 failed** |
| `python3 test/auto-update.test.py` | **39 passed** |
| `npm audit --omit=dev --audit-level=high` (pre-commit recheck) | **0 vulnerabilities** |
| Chromium seller editor | Stale write rejected, draft retained, unchanged stock omitted, confirmed stock preserved |
| Chromium guest checkout, 390px | Real HTTP order commit followed by synthetic response loss; reload replayed identical key/body with 200, only one new order, receipt shown and intent cleared |
| Tenant storage-scope probe | Actual helper segregates pending intents and clears only the selected tenant namespace |

The first post-repair run exposed old assertions for allowed tracking changes and the seller worker version; they were updated to the new contract. Its disposable PostgreSQL cluster had SQL_ASCII encoding, causing Unicode length failures unrelated to the application change. Rebuilding that cluster with UTF-8 resolved them; the final full run above passed. No production system was used.

Limits: product PATCH clients that omit `expectedUpdatedAt` retain last-write metadata/stock behavior; the seller editor supplies it. Recovery depends on retained browser storage and does not coordinate independent simultaneous checkout intents across tabs/devices. This change prevents new tracking-mode inconsistencies but does not infer or repair any historical stock discrepancy. Deployment tests do not constitute a real Docker restore drill, and the installed updater must be separately replaced during an authorized release.

## Original review scope and verification

Inspected the application router, seller authentication and account recovery, order/stock handling, listing/variant/gallery mutations, options, CSV and database import, guest checkout and browser storage/update guards, platform authentication/routing/lifecycle, WhatsApp connections/inbound/outbox/erasure, database adapters/schema, and deployment/backup/restore logic. Existing review documents were treated as historical evidence rather than current findings.

Verification used Node **24.21.0**, SQLite in-memory stores, and a temporary local PostgreSQL **16** cluster. The shell's default Node 23 did not satisfy the repository's Node requirement, so checks explicitly used the installed Node 24 binary.

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `NODE_ENV=test npm test`, without PostgreSQL URL | 455 passed, 48 skipped, 0 failed |
| `NODE_ENV=test SHOP_TEST_DATABASE_URL=<isolated local fixture> npm test` | **503 passed, 0 skipped, 0 failed** |
| `python3 test/auto-update.test.py` | **36 passed** |
| Targeted deterministic probes for findings B01–B05 and B08–B15 | Same failure reproduced with SQLite and PostgreSQL stores |
| B06 deployment probe | Actual updater control flow, mocked Docker/network/health effects; rollback reached `rollback_failed` |
| B07 migration probe | Actual SQLite → fresh PostgreSQL import; returned success while omitting connection/audit rows |

The checkout probe remounted the actual checkout module in the existing tests' fake-DOM style to represent a page reload. Authentication probes paused a captured database read, performed a real reset, then resumed the request. These establish deterministic interleavings; they do not measure production incidence. The image probe compared returned bytes and version, without relying on browser cache timing. All fixtures used fictional data, generated test keys, and stub transports. No production database, real provider call, message send, deployment or customer data was used.

Original review limits: no live production or real-browser end-to-end run, dependency/security scanner, real Meta test, or real Docker rollback drill was performed during that review. The later P1 repair browser checks are recorded above. Platform and PostgreSQL integration tests ran locally. The removed Worker runtime was syntax/test checked, not treated as a supported deployment. QA scripts, third-party print code and static assets were not exhaustively audited. Accepted design limits and speculative risks are not counted as confirmed defects.

## Findings index

| ID | Priority | Defect | Main location |
| --- | --- | --- | --- |
| B01 | P1 | In-flight password change overwrites a completed password reset | [accounts.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/accounts.js#L99) |
| B02 | P1 | In-flight login creates a valid session using a replaced password | [auth.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/auth.js#L44) |
| B03 | P1 | Stale product form restores stock already deducted by confirmation | [seller-orders.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/seller-orders.js#L198) |
| B04 | P1 | Cancellation restores stock that confirmation never deducted | [seller-orders.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/seller-orders.js#L203) |
| B05 | P1 | Lost checkout response plus reload creates a duplicate order | [checkout.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/checkout.js#L23) |
| B06 | P1 | Single-shop schema upgrades bypass maintenance and database rollback | [auto-update.py](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/deploy/auto-update.py#L250) |
| B07 | P1 | SQLite migration silently omits WhatsApp data and audit | [sqlite-import.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/sqlite-import.js#L3) |
| B08 | P2 | Shared App Secret makes one connection's webhooks disappear | [whatsapp-inbound.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/whatsapp-inbound.js#L32) |
| B09 | P2 | Late WhatsApp reply repopulates an erased order with personal text | [whatsapp-inbound.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/whatsapp-inbound.js#L73) |
| B10 | P2 | Catalog chooses a fully reserved variant while a sibling is available | [products.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L315) |
| B11 | P2 | Shared listing changes do not invalidate sibling editor revisions | [listings.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/listings.js#L57) |
| B12 | P2 | Demo reset retains orphan listings and resurrects their old content | [shop-setup.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/shop-setup.js#L32) |
| B13 | P2 | Truncated option labels reject distinct valid variant combinations | [options.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/options.js#L211) |
| B14 | P2 | Local Singapore numbers beginning with 65 are shortened incorrectly | [profile.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/profile.js#L5) |
| B15 | P2 | Thumbnail backfill changes an immutable URL's bytes without changing its version | [products.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L243) |

## B01 — P1: An in-flight password change can overwrite a completed reset

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [src/accounts.js:99](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/accounts.js#L99), [104](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/accounts.js#L104), [115](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/accounts.js#L115).

The own-password flow reads and verifies `password_hash` before starting its write transaction. The later update checks only account ID. A host, platform, or Owner reset can change the password and revoke sessions between that read and the update. The older request then replaces the reset password and clears `must_change_password`.

**Reproduction:** Start `changeOwnPassword` with the old password and pause after capturing its account row. Complete `resetPasswordFromHost` with a different password. Resume the change. The password chosen by the in-flight request authenticates; the host-reset password no longer authenticates. Both stores reproduced this result.

**Impact:** Account recovery can be defeated by a request that was authorized before recovery. This requires a pre-existing authenticated request and knowledge of the old password, rather than arbitrary unauthenticated access.

**Fix direction / regression:** Revalidate the current hash and account/session state atomically with the update, using a serialized transaction or credential-version/hash compare-and-set. A request whose captured credential was replaced by recovery must fail without changing the replacement password or its forced-change flag.

## B02 — P1: An old-password login can survive password rotation or reset

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [src/auth.js:44](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/auth.js#L44), [58](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/auth.js#L58), [src/app.js:215](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/app.js#L215).

`authenticate` reads the hash, awaits scrypt, and returns a captured account. The router creates the session separately. Reset deletes existing sessions, but no credential revision is checked before inserting a new one.

**Reproduction:** Pause `authenticate` after reading the old hash. Complete a password reset, then resume verification of the old password and create the session through the same sequence used by the router. `readSession` accepts that newly created session after the reset. Separately repeat with a legitimate `changeOwnPassword` operation: the new session is valid and `mustChangePassword` is false, so business routes remain available. Both stores reproduced both interleavings.

**Impact:** Someone holding the previous password can retain access by racing credential rotation, even though the operation reports success and clears other sessions. A default forced-password reset limits business routes until the password is changed; ordinary password rotation has no such restriction. The window also includes the gap between completed authentication and session insertion.

**Fix direction / regression:** Make authentication plus session issuance atomic with credential reset, or require the verified credential revision/hash to remain current when creating the session. Test resets both during password verification and immediately before session insertion. This is separate from B01: fixing the password mutation alone does not fix session issuance.

## B03 — P1: Saving unrelated product text can undo stock deduction

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [src/seller-orders.js:198](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/seller-orders.js#L198), [204](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/seller-orders.js#L204), [public/seller/products.js:932](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/seller/products.js#L932), [src/products.js:131](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L131).

Confirm/cancel modifies `stock_quantity` without advancing `product.updated_at`. The seller editor always submits its stock field, including unchanged stock. Its gallery revision precondition therefore accepts an editor snapshot taken before an order decision.

**Reproduction:** Open a product with stock 10 and retain its `updatedAt`. Confirm an order for one unit: stock becomes 9, but `updatedAt` stays unchanged. Save only a description edit through the editor-shaped patch, including the old `stockQuantity: 10`, gallery and expected timestamp. The request succeeds and stock returns to **10**. Both stores reproduced it.

**Impact:** Ordinary editing can resurrect sold inventory and permit overselling. A stale form can also overwrite stock restored by cancellation.

**Fix direction / regression:** Advance the product concurrency token on every inventory mutation, enforce the token on stock writes, and omit unchanged stock from editor patches. Test the actual seller payload after concurrent confirmation/cancellation, including grouped variants whose gallery requests currently discard the precondition.

## B04 — P1: Cancellation invents inventory after tracking mode changes

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [src/seller-orders.js:192](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/seller-orders.js#L192), [203](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/seller-orders.js#L203), [src/product-input.js:44](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/product-input.js#L44).

Confirmation skips deduction when stock is unlimited (`NULL`). Cancellation restores the ordered quantity whenever stock is currently non-NULL. It does not record whether that order actually deducted inventory.

**Reproduction:** Confirm an order for one unit while the product is unlimited. Set its stock to 10. Cancel the confirmed order. The resulting stock is **11**, although confirmation never deducted anything. Both stores reproduced it.

**Impact:** Stock integrity depends on the seller never changing tracking mode between confirm and cancel, a restriction the product API does not impose.

**Fix direction / regression:** Track the actual inventory deduction per order/product and reverse that movement, or explicitly prevent incompatible tracking changes while reversible commitments exist. Test unlimited → tracked and tracked → unlimited transitions around cancellation. Do not infer past inventory movements from the current nullable stock field.

## B05 — P1: Reload after a lost receipt creates a second order

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [public/shop/checkout.js:23](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/checkout.js#L23), [141](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/checkout.js#L141), [191](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/checkout.js#L191), [public/shop/app.js:1248](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/app.js#L1248).

The pending checkout key/body lives only in the `mountCheckout` closure. If the server commits but the response is lost, the cart remains available and the page reports a network error. Reloading clears that intent; the next submit generates a different key. The update guard stops blocking once `submitting` is false and does not include an unresolved checkout intent.

**Reproduction:** Run the actual checkout submit handler against `createOrder`; after the first committed order, throw a synthetic lost-response error. Remount the checkout with the same cart/profile/address, representing reload, and retry. The database holds **two orders with two keys**, rather than replaying the first receipt. Both stores reproduced it.

**Impact:** A normal recovery action after a mobile/network failure duplicates the order and can consume inventory twice. Same-page retry is covered by existing tests; reload is not.

**Fix direction / regression:** Persist the unresolved key and exact intent in shop-scoped storage before submitting; reconcile/replay it after startup and clear it only on a definitive outcome. Include unresolved intent in update safety. Test a lost committed response followed by reload, offline/reconnect and worker activation.

## B06 — P1: Single-shop database upgrades cannot roll back safely

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [deploy/auto-update.py:250](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/deploy/auto-update.py#L250), [328](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/deploy/auto-update.py#L328), [343](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/deploy/auto-update.py#L343), [439](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/deploy/auto-update.py#L439), [src/postgres-db.js:20](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/postgres-db.js#L20).

With `PLATFORM_ENABLED` unset or `0`, `migration_required` returns false even when the main shop schema increases. `migrate` still upgrades that database, but creates no durable migration/restore state. Candidate health failure then restores only the previous images. Those images reject the upgraded schema. Business requests were also not drained before the upgrade/snapshot.

**Reproduction:** Execute the real updater `deploy`/`migrate` path with synthetic release schemas 24 → 25, platform disabled, and mocked command effects. Make upgrade succeed and candidate health fail. The old image's health fails against schema 25; updater ends in **`rollback_failed`**. Neither maintenance nor database restoration is called. No real Docker/database deployment was executed.

**Impact:** A supported single-shop installation can remain down after a failed schema-changing release despite the advertised rollback. An interrupted non-platform migration likewise has no durable database recovery intent.

**Fix direction / regression:** Main-shop schema changes must use the maintenance/drain, verified backup, tracked runner and durable restore protocol independently of platform enablement. Test failed health and lost upgrade outcomes with the platform off; restore the old schema before activating the old image, and keep writes paused on unverified restore.

## B07 — P1: SQLite migration reports success while dropping integration data

**Status:** Fixed locally; see the P1 repair table above.

**Source:** [src/sqlite-import.js:3](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/sqlite-import.js#L3), [21](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/sqlite-import.js#L21), [33](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/sqlite-import.js#L33), [src/postgres/schema.sql:213](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/postgres/schema.sql#L213).

The importer enumerates only legacy shopping tables. It omits `integration_connection`, `integration_audit`, `webhook_receipt`, `message_outbox` and `message_inbound`. Those tables exist in both current schemas, but neither fresh-target checks nor row/digest verification cover them.

**Reproduction:** Save one synthetic connected WhatsApp account in current-schema SQLite, producing one connection and one audit row. Import into fresh current-schema PostgreSQL with the real `importSqlite`. It returns verified success, while the destination has **0 connections and 0 integration audit rows**. Its evidence list contains neither omitted table.

**Impact:** A migration disables configured WhatsApp and loses message/reconciliation/deduplication/audit history in the destination. The source is retained, so this probe does not establish irreversible source destruction. Outbox/inbound/receipt omission follows the same enumerated-table path; the connection/audit loss was directly measured.

**Fix direction / regression:** Include all durable application tables in dependency order, validate that the entire destination is fresh, and verify every table. Compare the importer inventory against schema inventory. Add a migration fixture containing sealed credentials, an outbox operation, inbound message and webhook receipt, preserving IDs, relationships and content digests.

## B08 — P2: Two connections sharing an App Secret lose webhook events

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/whatsapp-inbound.js:32](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/whatsapp-inbound.js#L32), [50](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/whatsapp-inbound.js#L50), [56](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/whatsapp-inbound.js#L56), [src/integration-connections.js:128](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/integration-connections.js#L128).

Signature matching returns the first connected environment with a matching App Secret. `PRODUCTION` sorts before `SANDBOX`. The parsed events are then filtered against only that connection's phone-number ID. An App Secret can be entered for both supported environments; the save API accepts this configuration.

**Reproduction:** Connect PRODUCTION phone `222222` and SANDBOX phone `111111` using one synthetic App Secret. Deliver a correctly signed message for `111111`. Result: **`processed`, 0 messages, 1 skipped**. The body receipt is persisted, so replay is deduplicated rather than recovered. Both stores reproduced it.

**Impact:** Supported multi-connection configuration silently discards one environment's replies and status receipts while acknowledging successful processing. This is an edge-case routing defect, not a signature forgery.

**Fix direction / regression:** Verify the raw body against candidate secrets, then route each verified item using its phone-number ID to the appropriate matching connection. Test shared secrets and batches containing both phone IDs; unmatched items must not prevent processing valid items for another authenticated connection.

## B09 — P2: Erased orders can acquire personal reply text again

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/whatsapp-inbound.js:73](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/whatsapp-inbound.js#L73), [src/erase-contact.js:21](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/erase-contact.js#L21), [31](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/erase-contact.js#L31).

Erasure blanks existing reply bodies and sets `contact_erased_at`, but retains sender hashes for threading. Inbound matching subsequently uses the historical outbox recipient hash without checking the erased order. It stores new text under that same order. Erasure refuses every subsequent attempt with `ALREADY_ERASED`.

**Reproduction:** Reject an order, create an accepted synthetic outbox record, and erase the order contact. Deliver a signed late text reply from the same sender. The reply body is stored and linked to the erased order. A second erasure returns **`ALREADY_ERASED`**, leaving the new personal text intact. Both stores reproduced it.

**Impact:** The order remains labelled erased while carrying readable personal content that the existing erasure action cannot remove. This is a product/data-retention recovery gap; no legal conclusion is inferred.

**Fix direction / regression:** Define and enforce handling of messages associated with an erased order: avoid retaining their bodies, detach them with a separately erasable retention policy, or support repeat erasure safely. Test late replies after erasure and concurrent inbound/erasure transactions.

## B10 — P2: A reserved cheap variant hides an available sibling

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/products.js:32](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L32), [315](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L315), [src/stock-reservation.js:11](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/stock-reservation.js#L11).

Public listing selection ranks variants by physical `stock_quantity > 0`, while `inStock` subtracts pending-order reservations. The representative variant can therefore be unavailable even though another active variant is available.

**Reproduction:** Create two variants in one group, each with stock 1, priced 100 and 200. Submit an order reserving the cheap variant. `listProducts` chooses that variant and returns **`inStock: false`**; its sibling detail returns **`inStock: true`**. Both stores reproduced it.

**Impact:** The catalog presents a sold-out card for a purchasable listing and uses the unavailable variant's price.

**Fix direction / regression:** Rank by the same effective-stock expression used to present availability, with a consistent reservation cutoff. Test fully reserved, partially reserved, unlimited and expired reservations across sibling prices.

## B11 — P2: Shared listing edits leave sibling concurrency tokens unchanged

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/listings.js:56](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/listings.js#L56), [57](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/listings.js#L57), [src/products.js:132](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L132), [185](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L185).

`syncListing` rewrites shared fields on all variants but advances only the listing timestamp. The directly patched product advances its own timestamp; siblings do not. Editor preconditions read the product timestamp rather than the authoritative listing revision.

**Reproduction:** Capture the main variant A's title and timestamp. Edit sibling B's shared title to `New shared title`. A now shows the new title with its old timestamp. Save stale A with its old title, gallery and expected timestamp. The precondition passes, and B's new title is overwritten with the old title. Both stores reproduced it.

**Impact:** A valid-looking stale editor silently erases another listing edit. This is independent of the inventory revision gap in B03.

**Fix direction / regression:** Use an authoritative listing concurrency revision for shared fields/gallery, or coherently advance and validate affected sibling revisions. A shared change through any sibling must invalidate an older editor of every affected sibling.

## B12 — P2: Demo reset leaves orphan listings and reuses their stale text

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/shop-setup.js:32](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/shop-setup.js#L32), [src/listings.js:42](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/listings.js#L42).

The reset deletes products, options and categories but omits `listing`. Reseeding adds new standalone listings. `listingFor` later reuses any retained group code and its old title/description/category.

**Reproduction:** Seed the demo (35 listings) and add a synthetic grouped item (36 listings). Reset. Listing count becomes **71**, including the old group. Create a product with that group code and request `New synthetic title`; the result instead contains **`Old synthetic title`**. Both stores reproduced it.

**Impact:** Reset does not restore a clean demo state, repeatedly grows orphan data, and can resurrect pre-reset product content or obsolete category references.

**Fix direction / regression:** Delete listings after their dependent products and before categories, inside the existing reset transaction. Repeated reset must keep a stable seeded listing count; recreating a deleted group must use newly supplied content.

## B13 — P2: Long option labels collapse distinct combinations

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/options.js:202](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/options.js#L202), [211](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/options.js#L211), [src/products.js](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js) (`DUPLICATE_VARIANT` handling).

The derived variant display label concatenates option labels then truncates to 80 characters. The legacy group/label unique constraint still treats that truncated display string as variant identity.

**Reproduction:** Define two option types. The first selected value has a valid 80-character label; the second type has values `One` and `Two`. Create combinations `(long value, One)` and `(long value, Two)` in the same group. The first succeeds with an 80-character label; the second fails **`DUPLICATE_VARIANT`**, despite distinct option-value IDs. Both stores reproduced it.

**Impact:** Valid seller-defined combinations cannot be created; renaming values can also make distinct existing labels collide.

**Fix direction / regression:** Enforce option-combination identity independently of truncated display text, retaining a separate policy for legacy free-text variants. Test long common prefixes and type/value renames as well as ordinary creation.

## B14 — P2: A valid local Singapore number is mistaken for an international prefix

**Status:** Open; outside the approved P1 repair scope.

**Source:** [public/shop/profile.js:5](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/profile.js#L5), [22](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/profile.js#L22), [104](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/profile.js#L104), [public/shop/addresses.js:170](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/public/shop/addresses.js#L170).

`localPhoneInput` strips `65` whenever digits start with it, even when the input is already an eight-digit Singapore local number. Both buyer profile and delivery-address inputs use it on blur/normalization.

**Reproduction:** The server's `normalizeContactPhone` accepts fictional fixture `+6565812345`. Enter its local form `65812345` with country code `+65`. The helper returns **`812345`**, and profile validation fails with **`profilePhoneInvalid`**. Displaying a saved canonical number and blurring it also re-applies the faulty stripping. This frontend behavior is database-independent; the same probe passed through both store runs.

**Impact:** Valid numbers in the supported numbering range cannot be entered or reliably edited, blocking profile/address completion.

**Fix direction / regression:** Distinguish explicitly international input or supported international lengths from a local number before removing the country code. Normalization should be idempotent. Test local, `+65` and unprefixed international forms, including local numbers starting with the country-code digits.

## B15 — P2: Thumbnail updates violate immutable image caching

**Status:** Open; outside the approved P1 repair scope.

**Source:** [src/products.js:221](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L221), [243](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L243), [253](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/products.js#L253), [src/app.js:52](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/app.js#L52), [180](https://github.com/yapweijun1996/Online-Shopping/blob/41407a7bda20adf167e2825900a268f3949316cc/src/app.js#L180).

Public versioned images receive `max-age=31536000, immutable`. Thumbnail backfill writes `thumb_data` without changing `product.updated_at`; gallery thumbnail updates likewise keep `created_at`, the gallery version source. A `size=thumb` request initially falls back to the full image, then returns different thumbnail bytes at the same versioned URL after backfill.

**Reproduction:** Create a product with a full image and no thumbnail. Capture `getProductImage(..., thumb=true)` bytes/version, backfill a synthetic PNG thumbnail, and read again. Bytes differ, but **version is unchanged**. Both stores reproduced it. No one-year browser cache wait was simulated; that caching consequence follows the route's explicit immutable headers.

**Impact:** Previously cached clients can retain the large fallback for a year and miss thumbnail changes. The defect concerns cache invalidation and payload efficiency; it does not establish that the main photo is replaced incorrectly.

**Fix direction / regression:** Version full images and thumbnails by their own content/revision, or advance the advertised version whenever thumbnail bytes change. Cover main and gallery paths; an immutable URL must always represent identical bytes.

## Documentation corrections

`threat-model.md` is updated alongside this report to distinguish the real WhatsApp runtime from its separate offline simulation foundation, describe the existing reservation window and explicit sample-login configuration, and expose the confirmed limitations of password revocation, erased-message retention, checkout retry and non-platform upgrade recovery. The threat model now also records the verified B01–B07 controls, retained browser-state boundary and production-installation limits. B08–B15 remain documented as open.

## Remaining repair order

1. Repair webhook routing/erasure (B08, B09).
2. Repair catalog/listing/reset/options/phone/cache behavior (B10–B15).

Each repair should add the corresponding failure scenario as a regression and run the full SQLite/PostgreSQL verification required by `AGENTS.md`.
