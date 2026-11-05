# Schema34 live release record

Status: **RELEASED — initial application revision `0131a2861090beeab394612c482f785be1618886`**. The owner explicitly authorized commit, push, merge and deployment on 2026-11-06 (Asia/Kuala_Lumpur). Production migrated from shop29 to34; legacy MCP, MCP v2, AI and WhatsApp QR remain OFF. Production guards remain in place. This record does not authorize enabling the new profiles or claim a later documentation SHA is deployed.

## Source, CI and immutable images

- Baseline: `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`. PR210 merged as `0131a2861090beeab394612c482f785be1618886`, Git tree `3a5e6a153917053fc646af2728e697bddcf54420`.
- Implementation/test source `b8614b46e6061ce06b5bbcc7cc616f228a2bfa7e` passed2012/2012,0failures/0skips,589.123s with all local browser/native opt-ins. [Isolated evidence](10-FINAL-VALIDATION-REPORT.md) retains its original environment and authorization limits.
- Exact-main CI run `42117852538` passed:1980 tests,1934passed,46skipped,0failed,744.321s. WhatsApp QR24/24 and updater39/39 passed; dependency audits reported0vulnerabilities. Skips are explicit, not passing browser/native gates.
- Image publication run `42119769380` passed. Staging verified actual Linux/amd64 metadata and exact revision labels.

| Component | Accepted immutable image |
| --- | --- |
| Backend | `ghcr.io/yapweijun1996/online-shopping-backend@sha256:cb5a2c870840f67547e69ac575c4332b8662fcb493e6b678c903fdd59563b433` |
| Frontend | `ghcr.io/yapweijun1996/online-shopping-frontend@sha256:b293c939a780497816332f67966c1f2e4aa206688af291ad88c18c5f7858592f` |

Earlier branch run `42115702842` and PR verification were cancelled at the ten-minute job maximum. Observed branch progress was971 completed tests,0reported failures and18skips, stopping during media review: incomplete runs, not passes or observed assertion failures. Only the main verify budget changed10→30minutes; QR remains10. Application code, permissions, assertions and defaults were unchanged by that correction.

## Private restore and migration acceptance

Live preflight verified default shop29/platform2 and no nondefault tenants. Backups, raw archives, credentials and customer records remain private.

- A real isolated clone rehearsed29→34, an idempotent34 rerun, coordinated revert to29 with the old image actually ready, then re-upgrade34 with readiness. Full metadata, ACL and count comparisons passed.
- With final writers stopped, the final backup's same-clone rehearsal passed29→34, an idempotent34 rerun, then revert29 and old-image readiness. A second pristine29 restore and old-image readiness also passed. This final clone was not re-upgraded34; the initial rehearsal above included that additional step. Its manifest records the native PostgreSQL container identity matching the unchanged live container. The initial online backup lacked that identity; the omission is preserved, not invented or backfilled.
- The first restore metadata comparison exposed three built-in PostgreSQL grantor mismatches. The accepted correction preserved the original opaque archive hash and derived a stream removing only the two exact bootstrap-owner global DROP/CREATE statements before the first database connection, preserving owner OID10. Every ALTER and the entire database body remained byte-identical. All restore errors were fatal; actual roles/grantor metadata matched. No `pg_auth` system-catalog patch was used.
- Actual live owner migration34, idempotent rerun and verification passed. Platform stayed2; nondefault tenants stayed0; existing counts stayed35products/0orders. Inventory coverage/state has35 MIGRATED baselines at revision0 and0movements; no pre-cutover movement history was fabricated. All required table DML and USAGE/SELECT on both audit sequences verified true.

PostgreSQL container/volume, installed Compose/runtime/controller and secrets were unchanged. The separate reviewed owner migration ran under the manual-release lock; updater image activation did not migrate the database.

## Activation and public acceptance

Candidate health was accepted at `2026-11-05T22:21:58.385486Z` (2026-11-06 Asia/Kuala_Lumpur). Backend and frontend readiness reported exact revision `0131a2861090beeab394612c482f785be1618886`.

Public smokes passed17/17: TLS and exact readiness, shop/seller/platform HTML, `script-src 'self'` CSP (image policy permits `data:`), cross-host private routes404, unauthenticated seller API401, MCP404 and internal routes404. Production verification used read-only HTTP probes; application/data changes were limited to images and the reviewed database migration. No checkout, message or provider send was performed. Legacy/new MCP, AI and QR remain OFF.

Timer acceptance passed at `2026-11-05T22:23:40.468127Z`; independent readback at22:24UTC confirmed timer active/enabled and accepted state `deployed`, current0131a286, shop34, with previous/pending/failed/schema-fence targets cleared. Backend/PostgreSQL were healthy and frontend running, without OOM. Owned restore/probe containers were removed; private archives/scratch were retained. Observed remaining resources were17GB free disk and1281MB available RAM, not a capacity guarantee.

The cutover job began at22:20:31.062UTC and candidate health passed at22:21:58.385UTC. These are job milestones, **not a measured exact outage duration**; public smokes passed afterwards. The first staging attempt failed safely on a commit/tree API identity assumption before image or database mutation. The corrected control verifies commit→tree, then fetches that exact tree. Reviewed helper SHA256 prefixes were control `3e71ed2f`, cutover `67d54b`, backup `dc57` and probe `b7`. Observed anonymous GitHub quota moved57→34; verified local identity checks avoided redundant requests without bypassing API limits.

## Rollback and subsequent documentation release

After schema34 commits, rollback requires a compatible schema34 image or the approved coordinated restore with writers stopped. Never run schema29 images alone against schema34. Restoring a pre-backup state after new writes requires explicit reconciliation and acceptance of that data boundary; it is not automatic image rollback.

This describes initial0131a286 only. A subsequent documentation-only PR still needs normal merge, exact-main CI, published images and normal updater acceptance before its later SHA can be called deployed. No future documentation SHA is asserted live here.
