# Bug and improvement register

Reviewed: 2026-11-12. Source baseline: `243bde4ad7425382ecd64d3cc8bf6049edf45b49`.

This is a bounded source review, not an exhaustive security assessment or production acceptance. Seven confirmed application defects are locally repaired against this baseline. No production writes, provider calls, push or deployment were performed. The original findings below are retained as before-fix evidence; the repair ledger is authoritative for current local status.

## Evidence and scope

Reviewed repository rules, historical findings, seller budget UI and accounting/provider error paths, catalog representative selection, thumbnail versioning, option labels, demo reset and shopper phone normalization. Historical findings are retained in [CODEBASE_BUG_REVIEW.md](docs/CODEBASE_BUG_REVIEW.md); their old test results do not establish current behavior.

Two defects were reproduced in local Chrome with a disposable SQLite seller fixture. Added service regressions reproduced B10/B12/B14/B15 against a detached baseline checkout; B11 was reproduced before its local repair. B13 behavior was changed with explicit user authorization. No P0/P1 finding was established by this bounded review.

| ID | Priority | Status / evidence | Issue |
| --- | --- | --- | --- |
| BUG-016 | P2 | Locally repaired; browser regression | Next crashes after initial budget analytics failure |
| B14 | P2 | Locally repaired; normalization regression | Singapore local number loses its leading country-code digits |
| B10 | P2 | Locally repaired; service regression | Catalog representative selection ignores reservations |
| B11 | P2 | Locally repaired; stale sibling editor regression | Shared listing edits leave sibling revisions unchanged |
| B13 | P2 | Authorized compatibility repair; both-store schema37 tests | Distinct structured combinations collide after display-label truncation |
| B12 | P2 | Locally repaired; service regression | Demo reset omits listings |
| B15 | P2 | Locally repaired; service regression | Thumbnail backfill changes bytes without changing image version |
| DOC-001 | P3 | Reconciled local/historical status | Historical review summaries disagree about fixed findings |

## Local repair ledger (2026-11-12)

| ID | Repair and evidence |
| --- | --- |
| BUG-016 | Disable Previous/Next until analytics exists and during requests; guard nextOffset with Number.isSafeInteger. Chrome regression fails initial analytics, verifies disabled navigation/no page error, restores the endpoint and refreshes successfully. |
| B10 | Representative ranking uses physical stock minus active reservations, matching public availability. SQLite/PostgreSQL regression selects the available sibling instead of the cheaper reserved variant. |
| B11 | Shared listing changes monotonically advance sibling product revisions. Both stores reject a stale sibling editor with PRODUCT_CHANGED. Legacy unversioned-content security tests retain explicit timestamp-restoration fixtures. |
| B12 | Demo reset deletes listings after dependent products/details. Repeated reset and reseed rollback are tested on disposable stores. |
| B13 | Owner authorized ID-based structured option uniqueness. Schema37 replaces the lossy display-label unique index with a lookup index; canonical option type/value ID validation runs inside the existing serialized writer transaction. Legacy free-text collisions remain application-enforced. Creation, updates, concurrent identical combinations and schema36 upgrades are covered on both stores. |
| B14 | Strip Singapore prefix only for a complete 10-digit international number. Local eight-digit numbers starting with 65 remain intact; normalization is idempotent. |
| B15 | Main/gallery thumbnail changes monotonically advance the existing public asset version clock. Identical MIME/bytes are a no-op. Both stores verify changed bytes change versions. Gallery created_at serves as the existing asset clock; visual order remains position-based. |
| DOC-001 | Historical summaries now consistently identify B01–B09 as the repairs completed at that review date, with this ledger recording subsequent work. |

### B13 compatibility and release requirements

The approved rule concerns structured combinations: two different option-value ID combinations can produce the same 80-character display label. The label is not identity. Exact combinations remain forbidden; legacy free-text labels retain dialect-specific case-insensitive comparisons. Display text alone must not be used to identify a variant; use product IDs and full option selections.

SQLite upgrades schema36 transactionally on normal migration. PostgreSQL requires the existing explicit operator upgrade path; fresh baseline and storage readiness accept schema37. Migration preserves rows, replaces only the label index, and is **not** an authorization to migrate production. The shared SQLite BEGIN IMMEDIATE / PostgreSQL advisory writer transaction is now the uniqueness enforcement boundary for service writes. Direct database writes bypass this application invariant; supported imports must preserve validated source data. Downgrade to schema36 is not automatic and may be impossible after creating equal display labels.

### Validation status

Final local acceptance completed on 2026-11-12:

- `npm run check`: passed.
- `NODE_ENV=test npm test` with disposable PostgreSQL16, `SHOP_TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin` and canonical `TMPDIR=/private/tmp`: **2,232 tests; 2,105 passed; 0 failed; 127 skipped**, 480.55 seconds. Optional browser/isolated-codec environments account for skips; they are not claimed as executed coverage.
- `test/ai-studio-budget-browser.test.js` with local Chrome/Playwright: **5 passed, 0 failed, 0 skipped**, including 390px/1440px dashboards, settings save and initial analytics failure/recovery. The full-suite skip count includes these tests, executed separately here.
- Targeted SQLite/PostgreSQL compatibility checks: 73 passed; storage checks: 13 passed; Unicode labels: 8 passed; real PostgreSQL backup/restore/import: 3 passed. These cases also pass in the final full suite.
- `git diff --check`: passed. Seller/Shop cache versions and shell fingerprints updated for the changed browser assets.

Earlier runs exposed legacy version/behavior assertions and historical schema reconstruction assumptions. Those fixtures now reflect the approved semantics while preserving the original historical schema SHA checks and security content-fence assertions. Interrupted/superseded runs are not acceptance evidence. No application source changed during the final successful run. All provider responses are simulated; no paid calls were made.

No commit, push, production schema migration or deployment was performed in this local repair round.

## BUG-016 — Next dereferences null after initial analytics failure

Source: [public/seller/budget-ui.js](public/seller/budget-ui.js), `current`, `load`, `paint` and the Next click handler.

**Trigger:** Open Usage & budget when the initial analytics request fails (for example HTTP 503), then click Next. `current` remains null. Initial `paint()` returns before disabling navigation. The condition `current?.nextOffset !== null` evaluates true because `undefined !== null`; the body then dereferences `current.nextOffset`.

**Observed:** A local Chrome run intercepted only the analytics endpoint with a synthetic HTTP 503. Clicking Next raised `Cannot read properties of null (reading 'nextOffset')` as a page error. No recovery request was issued by that handler.

**Impact:** A transient backend/network failure leaves an enabled action that crashes instead of recovering. The whole application does not necessarily become unusable; Refresh remains a potential recovery path.

**Fix direction:** Disable pagination until a successful response exists, require a valid non-null next offset, and disable or serialize navigation during loading. Keep the explicit Refresh recovery action.

**Acceptance:** Delay or fail the initial GET, click Next/Previous, and assert no page error or invalid-offset request. Restore service, refresh and verify normal pagination. Also test failures on later pages.

## B14 — Singapore local numbers starting with 65 are shortened

Source: [public/shop/profile.js](public/shop/profile.js), `localPhoneInput` and `normalizeProfile`.

**Trigger:** Select +65 and enter the eight-digit local number `65123456`. The helper strips non-digits, sees the `65` prefix and removes it regardless of the original length or explicit international notation.

**Observed:** Importing the actual module in Chrome returned `123456` from `localPhoneInput('65123456', '+65')`. `normalizeProfile` then constructs a number with too few digits and rejects it under its own Singapore validation rule. No telephone/network call was made.

**Impact:** A structurally supported local number cannot be saved. The result does not establish that the example number is assigned to a real subscriber.

**Fix direction:** Distinguish local-length input from an explicitly international or full international-length number before removing the prefix. Make normalization idempotent.

**Acceptance:** Cover local `65123456`, `+6565123456`, `6565123456`, already normalized profiles and unrelated +60 behavior.

## B10 — Available sibling can be hidden by a reserved representative

Source: [src/products.js](src/products.js), public `listProducts` query near line 520; [src/stock-reservation.js](src/stock-reservation.js).

**Baseline evidence:** Public `ROW_NUMBER` ranks variants using physical `stock_quantity > 0`, then price. The row projection separately includes reserved quantity. Thus representative selection and effective availability use different stock definitions. This matches the historical B10 mechanism; it is not a newly executed order-flow reproduction.

**Trigger / impact:** Two active variants each have one physical unit. A submitted order reserves the cheaper one. The catalog may select the reserved cheaper variant and show an unavailable listing while the sibling remains purchasable.

**Fix direction:** Rank with the same effective availability definition used by the public response, including reservation expiry and unlimited stock.

**Acceptance:** Repeat the historical two-variant/order fixture on both stores; verify expired reservations and unlimited stock as well as the selected price and ID.

## B12 — Demo reset retains orphan listing records

Source: [src/shop-setup.js](src/shop-setup.js), `resetDemo`; [src/listings.js](src/listings.js).

**Baseline evidence:** The transactional deletion list includes `listing_detail_image`, `listing_detail` and `product`, but still omits `listing` before reseeding. The historical report documents retained group content and growing listing counts. That full fixture was not rerun in this review.

**Trigger / impact:** Repeated demo resets can retain orphan listing rows; later reuse of an old group identity can recover stale listing content rather than the newly supplied content.

**Fix direction:** Include listing cleanup in dependency order in the existing reset transaction. Review inventory and rich-detail dependencies before changing the deletion order.

**Acceptance:** Reset twice and compare stable seeded listing counts; recreate an old group with new content; fault-inject reseeding and prove rollback preserves the preceding state.

## B15 — Backfilled thumbnail bytes keep the immutable image URL

Source: [src/products.js](src/products.js), `getProductImage`, `getGalleryImage` and thumbnail writes near lines 450/460; image response caching in [src/app.js](src/app.js).

**Baseline evidence:** Main thumbnail updates write `thumb_mime` and `thumb_data` without advancing `updated_at`. Gallery thumbnail updates likewise leave `created_at` unchanged. The read paths continue deriving versions from those unchanged fields and fall back to original bytes when no thumbnail exists. The historical immutable-cache consequence remains supported by these paths; no fresh browser-cache reproduction was run.

**Trigger / impact:** A client caches the original-image fallback at a thumbnail URL before backfill. Backfill changes the response bytes without changing that URL/version, so an immutable cache can keep the larger old payload.

**Fix direction:** Give image representations content-based versions or advance the appropriate version whenever representation bytes change.

**Acceptance:** Capture bytes and URL before/after main and gallery backfill, then verify distinct URLs for distinct bytes and stable URLs for unchanged bytes. Include browser cache behavior.

## DOC-001 — Historical status summaries contradict the repaired entries

Source: [docs/CODEBASE_BUG_REVIEW.md](docs/CODEBASE_BUG_REVIEW.md), opening summary, B08/B09 sections and closing summary; [docs/threat-model.md](docs/threat-model.md), review status paragraph.

The historical review opening says B08–B15 remain open, but its B08/B09 sections explicitly describe fixed, locally verified regressions. The threat model says B01–B09 are fixed. This discrepancy can cause duplicate work or misreporting. Reconcile summary statements with the dated evidence while retaining the historical baseline and avoiding an unsupported claim of current production verification.

## Improvements and follow-up checks (not confirmed defects)

1. **Budget count definitions:** `budgetStatus` counts PENDING/OK/AMBIGUOUS calls, whereas analytics series use `COUNT(*)` across all outcomes. Label attempted versus counted/billable-uncertain calls explicitly so an ERROR-only period is not mistaken for inconsistent arithmetic. Retain these distinct measures; relabeling is a follow-up UX task, not a reason to silently change accounting queries.
2. **Budget blocking capability:** `checkBudget` intentionally blocks every request when BLOCK mode has any configured monetary limit and no proven maximum request cost exists, even with zero spend. This is documented fail-closed behavior, not an accidental threshold bug. Consider a clearly disabled/unsupported control or supported conservative reservations as a separate product change.
3. **Test environment runbook:** Document `SHOP_TEST_DATABASE_URL`, `SHOP_TEST_PG_BIN` and a canonical macOS TMPDIR together. The preceding release work demonstrated environment-only PostgreSQL/restore failures. Do not count those historical failures as newly reproduced application defects.
4. **Historical B11/B13:** Revalidated and locally repaired as recorded above; the B13 compatibility decision was explicitly approved.
5. **Scope still unreviewed:** Full current auth/race/tenant isolation, WhatsApp delivery, external-provider compatibility, populated mobile workflows and live signed-in acceptance require separate targeted review. This document does not certify those surfaces.

## Remaining limits

The repairs are local, not a production acceptance claim. Browser coverage includes budget error recovery and responsive budget settings; immutable browser cache behavior is established through version/byte service regressions rather than a separate cache-replay browser test. Security tests cover the affected content fences; this is not a new comprehensive security audit. The optional budget UX/product enhancements listed above remain follow-ups, not confirmed defects silently marked fixed.

Test environment setup is documented in [LOCAL_REGRESSION_TESTING.md](docs/LOCAL_REGRESSION_TESTING.md).
