# MCP v2 validation snapshots

## Latest inventory foundation and authority acceptance

Root sourceeee6556 (workerc4440ef), Node24.22.0, SQLite and owned PostgreSQL16: `NODE_ENV=test SHOP_TEST_DATABASE_URL=<private synthetic URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 test/*.test.js`, exit0, **1249 total/1224 passed/0 failed/25 browser opt-ins skipped**,228.994s (`.local/manager-inventory-foundation-full.tap`). This includes prior root media resource/frame/cancel follow-ups and the additional actual authenticated portal test file. Schema32, all stock writers, ledger/history rollback, exact31 migration, restricted roles, actual SQLite/PostgreSQL restore, import and catalog OAuth identity are covered. Inventory tools and complete computed-hold proposal revisions are not implemented by this foundation.

The worker's earlier full1216/1190pass/1fail/25skip,244.327s failed a synthetic platform downgrade fixture that retained new inventory children. Its exact dependency teardown and legacy cross-grant assertions were corrected; worker final1217/1192pass/0fail/25skip,259.719s then passed, plus separately discovered portal tests2/2. Root's larger run above independently includes that file. No business or security assertion was removed.

Media authority successor73d3833: root `node --test --test-concurrency=1 test/mcp-media-authority.test.js test/mcp-operation-engine.test.js test/mcp-operation-approval.test.js test/mcp-v2-oauth.test.js`, same Node/database environment, exit0, **37/37**,0skip,15.093s (`.local/manager-media-authority.tap`). Fixed media policies require every token/grant scope and its separate identity/epoch/time-bound consent. Legacy operation paths remain compatible. No media default registration, real image review or arbitrary adapter authority is established by these tests.

Portable client abort successord67e23d: root `node --test --test-concurrency=1 media-codec/test/codec.test.js media-codec/test/runtime.test.js test/mcp-media-codec-cancel.test.js`, exit0, **20/20**,0skip,3.725s (`.local/manager-media-codec-cancel-unit.tap`). Real Unix-socket cancellation and an unrelated healthy connection are covered; the independent5s bound and fixed wire remain. Worker initially lacked its private Sharp dependency link; that failed runtime run is retained separately from the corrected7/7 worker run. Current native coordinator E2E remains pending and does not inherit human-review proof from these tests.

## Internal frame follow-up — sourcef5043c5

Root Node24.22.0 with SQLite/disposable PostgreSQL: `node --test --test-concurrency=1 test/mcp-media-frame-storage.test.js test/mcp-media-storage.test.js test/mcp-media-manifest.test.js test/mcp-media-policy.test.js`, exit0, **34/34**,0skip,4.220s (`.local/manager-media-frame.tap`). Sourcef39638b adds internal scalar inspection and canonical policy/page/asset/pin persistence; this does not expose a tool or route.

Independent review found that a matching stage SHA/codec alone did not compare the actual stage MIME/length to its manifest alias. Follow-upf5043c5 now binds both through each exact stage reference, including deduplicated aliases. Otherwise valid manifests with incorrect MIME or length fail with controlled503 and no frame writes on both adapters. Existing policy, graph ownership, live authority, native validation and first-party approval remain separate mandatory checks.

## Latest storage and resource acceptance — sources5eba37b and3f4c1e9

Root full Node24.22.0, SQLite and owned disposable PostgreSQL command below, exit0: **1190 total/1165 passed/0 failed/25 browser opt-ins skipped**,200.437s (`.local/manager-media-storage-full.tap`). This accepts atomic stage quotas/append/lease/pin/consume and bounded cleanup, dataful synthetic SQLite snapshot/PostgreSQL dump restore, feature-off suspended-tenant CLI, import exclusion and legacy regressions. Storage fixture bytes are deliberately synthetic; these storage tests do not claim native decoding or real human approval.

At successor3f4c1e9, root `node --test --test-concurrency=1 test/mcp-media-resources.test.js test/mcp-media-storage.test.js test/mcp-media-manifest.test.js test/mcp-media-policy.test.js` with the same Node/test PostgreSQL environment: exit0,**46/46**,0skip,18.780s (`.local/manager-media-resource-storage.tap`). Resource snapshots bind complete physical ownership, membership, labels and full/thumbnail SHA; count/byte preflight precedes BLOB reads. Exactly300 members/3300 physical identities and32 content keys are covered; loader does not independently rehash every other image per delivery. Coordinator must recheck complete revision and authority.

Actual browser regression at3f4c1e9: `QA_PLAYWRIGHT_MODULE=<cached Playwright module> node --test --test-concurrency=1 test/mcp-operation-review-app-browser.test.js test/mcp-operation-review-browser.test.js test/mcp-catalog-app-browser.test.js`, same Node/test database environment, exit0,**3/3**,0skip,4.724s (`.local/manager-media-foundation-browser.tap`). Actual synthetic HTTPS password/PKCE/consent/review and Chromium paths are exercised, without injected approval. This tests existing reviews; new media delivery/ACK/approval has not yet been implemented or tested.

## Latest media foundation acceptance — source5ecf145, metadata successor edda35c

Root full command: Node24.22.0, `NODE_ENV=test SHOP_TEST_DATABASE_URL=<private synthetic URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 test/*.test.js`, exit0. **1150 total/1125 passed/0 failed/25 browser opt-ins skipped**,220.185s; `.local/manager-media-schema-gallery-fixed-full.tap`. This includes schema31, all supported migrations/readiness/import checks, shared SELECT-only gallery planning and the existing business surfaces. Staging cleanup, actual media authority/coordinator and visual approval are not completed by this result.

Earlier c0ec064 full run exited1:1150total/1121pass/4fail/25skip,225.751s (`.local/manager-media-schema-gallery-full.tap`). Historical test fixtures dropped old parent tables before new media children. Fix694c3e6 adds reverse dependency teardown in two test files without CASCADE or weaker assertions; the full suite above was rerun after that fix and descriptor/index refinement5ecf145. The failed snapshot is retained.

Portable codec source45d38ea: root18/18 unit tests again against schema31,2.341s (`.local/manager-media-portable-schema31-unit.tap`), plus4/4 actual ARM64 Alpine container tests,10.478s (`.local/manager-media-portable-container.tap`). Image6417fd93519f8ffb111823ef5167bb69951a52738ad308afecaafd29bac9e2a1; peak168611840bytes, watchdog5087ms. Actual OOM137/true and crash137/false preserve the synthetic parent API. Development-only Docker context includes only the private codec package and shared wire/client. Production package/manifests remain unchanged. Trusted startup/pre-opened-descriptor limitations remain.

Pure policy/manifest sourceedda35c: root `node --test --test-concurrency=1 test/mcp-media-policy.test.js test/mcp-media-manifest.test.js test/mcp-operation-envelope.test.js`, exit0,22/22,0skip,0.573s (`.local/manager-media-policy.tap`). Canonical metadata and retained descriptor checks are tested; they are not token, ownership, native-byte or human-approval evidence.

## Latest analytics and knowledge acceptance

Root sourcef7dc171 full Node24.22.0+SQLite/disposablePG: **1120 total,1095 passed,0 failed,25 browser opt-ins skipped**,213.239s, exit0; log.local/manager-analytics-integrated-full.tap, same full command below. Targeted analytics/shared-read/dashboard/query-plan29/29,0skip,10.722s; response/default5/5,0skip,8.448s. Fresh analytics.extended/current figures.read gates the three built-ins; v1/dashboard definitions are unchanged. Independent fixtures, safe integer money and bounded/incomplete coverage are tested; query plans are synthetic, not production capacity.

Review reproduced a legal74315-byte Unicode page returning Internal error. Shared preflighta212be0/rootca6da6e now returns controlled503 for all three services, without partial data/success audit; smaller pages preserve IDs/totals. Source budgets precede currency filtering. A worker process took332.94s; later worker/root runs finished as recorded, with no claimed causal fix. Existing pg concurrent-query deprecation was observed; future dependency upgrades need verification. Knowledgecc56449/root66d232c independently passed8/8bothDB,0skip,11.737s (.local/manager-knowledge-boundary.tap): real commerce RPC/OAuth/approval/revocation with synthetic external knowledge only. Real LLM/vendor/KB outage is unverified; no runtime KB fallback added.

## Sealed codec follow-up018ea6a

Root13/13unit,0.504s, plus4/4 actualARM64Alpine Docker,14.161s,0skip. Logs.local/manager-media-codec-seal-unit.tap and.local/manager-media-codec-seal-container.tap. Image86945adf537fe0a3b7edcdad8a7899a78c2113ce4aa1ce2ebf660882d5fa39aa. Kernel192MiB/swap0/pids32/0.5CPU; peak167333888bytes. UID10001 cannot create/delete/rename files, restore directory write or modify readonly token after trusted seal0710. Real OOM137/true, crash137/false and watchdog70after5106ms preserve synthetic parent API; owned containers removed. Trusted startup/pre-opened descriptor caveat remains, no quota/production-supervisor claim. Media application workflow remains unaccepted; schema31/storage, portable wire and shared gallery planning are in progress. No push/merge/deploy, production commerce data or service/tunnel/timer changes.

## Latest catalog safe-subset acceptance — source707052c

Independent root Node24.22.0 full command with private disposable PostgreSQL: `NODE_ENV=test SHOP_TEST_DATABASE_URL=<synthetic URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 'test/*.test.js'`. Exit0: **1094 total,1069 passed,0 failed,25 browser opt-ins skipped**,206.247s; log.local/manager-phase2-catalog-final-full.tap. Actual loopback HTTPS Chromium approval plus catalog/company default-registration tests with QA_PLAYWRIGHT_MODULE: **7/7**,0skip,5.307s; log.local/manager-phase2-catalog-browser.tap. Final core/contracts after option-code bound fix: **39/39**,SQLite+PG,0skip,9.876s; log.local/manager-phase2-catalog-safe-final.tap.

Historical full core1ec14ad passed1087/1063/0failed/24skipped,189.006s. Default70fd75c full run exited1:1094/1067passed/2failed/25skipped,154.876s (log.local/manager-phase2-catalog-default-full.tap). Both failures were stale OAuth expectations9 versus correct13 for explicit catalog.write+company.read. Fix698c71c/root707052c asserts exact names/schemas and unchanged legacy8; the complete rerun above passed. Passing broad tests did not prove later edge cases absent: review also fixed unknown-resource transport, per-dialect label uniqueness, full resolved option labels despite80-character clipping, legal60-character option codes and historical per-member text review.

Four catalog tools are gated built-ins alongside company tools, using shared validation/current services/history, bounded affected-set revision and minimal receipts. Actual browser paths exercise fresh PKCE/password/consent handlers, first-party password approval, inert untrusted description, commit/replay once and synthetic storefront rendering. Existing-stock/media/group/holder paths remain rejected. Full Phase2 and the complete project remain incomplete; production v2 stays blocked.

## Separate isolated codec experiment — source842d39b / rootf585896

Root independently installed only the separate codec package with ignore-scripts, audited it (0 reported vulnerabilities), ran11/11unit and rebuilt pinned Node24.20Alpine ARM64. Actual Docker4/4passed,0skip,12.474s; log.local/manager-media-codec-container.tap. Root imagefc70305cfa111319bf01ae067fb008848357f435247f04cbf10daef1e32aa071. Kernel201326592bytes/swap0/pids32/cpu50000of100000; measured peak168161280bytes includes instrumentation and is not a worst-case capacity guarantee. Max4Mi-pixel PNG/JPEG/WebP decoded; genuine controlled OOM137/true, separate crash137/false, wall watchdog70 after5231ms; distinct synthetic parent API stayed alive and returned503. All owned containers removed.

This experiment has no app staging, media MCP registration, visual approval, DB credentials or network. Same-UID writable socket directory is a documented limitation being strengthened in a separate follow-up. Media/production remain NOT READY. Root package/lock and production manifests unchanged. Accessed local worktrees, synthetic DBs, loopback HTTPS/browser, owned local Docker images/containers and KB context. No production commerce data, service/tunnel/timer, push/merge/deploy changes. The following sections are named earlier snapshots, not current whole-project completion.

Date: 2026-11-05. **The complete Seller Operations Engine is not finished.** The Phase 0 sections below are a named historical snapshot; the subsequent Phase 1 section records the integrated company tools at08136e6. New authority is default-off and production v2 activation is rejected.

## A. Baseline

Repository: `yapweijun1996/Online-Shopping`. Isolated branch: `codex/mcp-v2-phase0`; baseline `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`. Latest source checkpoint: `25ec84f` (recorded timestamp expiry fix). Environment: persistent host `yapvmmcp`, Node 24.22.0, SQLite, a new password-protected UTF-8 PostgreSQL 16 loopback cluster and cached Playwright/Chromium. All test data is synthetic.

## B. Implementation

Implemented: default-off configuration, external restore epoch, source-derived build digest, schema 30 migrations, explicit OAuth scope consent, current scope/RBAC validation, immutable proposals, first-party review, single-use session/hash-bound challenges, fresh password verification, transactional commit and receipt replay. The existing eight read tools retain their contracts. The server-owned operation registry dispatches outside the tenant transaction, preserving platform-before-tenant lock order. Its application default is empty.

Schema 30 has SQLite migration, matching fresh PostgreSQL SQL and every supported PostgreSQL upgrade path. Imports exclude active v2 authority. Expired terminal proposals are redacted; only validated minimal receipts are stored. Receipt retention ends at original grant expiry plus 90 days; audit retention remains 90 days. Request maintenance is limited to successful authenticated operation data requests. The existing bounded cleanup CLI also supports feature-off cleanup and private suspended-shop hygiene without enabling business authority.

Changed areas: `src/mcp/`, config/database/migrations/import, tenant routing/guards, cleanup CLI and associated tests. Exact inventory: `git diff 1634735..25ec84f --stat`. No domain business adapter is accepted by this report.

## C. Executed verification

Private disposable connection values and epochs are intentionally omitted. All commands used Node 24 where applicable.

| Command / scope | Exit | Observed result |
| --- | --- | --- |
| `NODE_ENV=test SHOP_TEST_DATABASE_URL=<synthetic URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 'test/*.test.js'` at `25ec84f` | 0 | **1015 tests: 991 passed, 0 failed, 24 browser opt-ins skipped**, 162.082 s. `.local/manager-phase0-full-clock-fixed.tap`. |
| Snapshot restore + cleanup CLI + historical account upgrade + both review browser tests, PostgreSQL and `QA_PLAYWRIGHT_MODULE` enabled | 0 | **14 passed, 0 failed/skipped**, 6.942 s. `.local/manager-phase0-restore-cli-browser.tap`. Includes actual local HTTPS login/review and real SQLite/PG snapshot restore. |
| Exact PostgreSQL concurrent RPC commit case twice at frozen `39b204d` | 0, 0 | **1 passed** in each isolated run, 0 failures/skips. |
| Integrated config/storage/OAuth/v1 checkpoint `faed47b` | 0 | **68 passed**, 0 failed/skipped. |
| Real approval/engine/routes/browser checkpoint `e5a4b8a` | 0 | **24 passed**, 0 failed/skipped. |
| `npm run check` | 0 | JavaScript syntax checks passed. |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 vulnerabilities reported for the unchanged lockfile at execution time. |
| `python3 test/auto-update.test.py` | 0 | **39 passed**. |
| `python3 test/gcp-deploy.test.py` | 0 | **17 passed**. |
| `git diff --check` | 0 | Passed. |

The timestamp-fix approval/engine/registry targeted run independently passed **24/24**, 0 skipped, 9.923 s (`.local/manager-phase0-clock-fix.tap`). The full run at `39b204d` previously passed 1013 tests (989 passed, 24 skipped); the real timing defect described below was subsequently reproduced and fixed rather than hidden by that passing run.

### Failures found and resolved

- A pre-registry full run at `d7233f9` exited 1: **991 tests, 966 passed, 1 failed, 24 skipped**. A historical schema-22 fixture tried to drop `oauth_grant` before the new dependent v2 tables. The fixture now drops dependencies explicitly and closes its store in `finally`; original upgrade assertions remain intact.
- Actual PG dump/restore exposed readiness failure because PG16 flattened equivalent nested `BETWEEN` conditions. Shared DDL now uses explicit comparisons; restored catalog manifests match while removed indexes/weakened constraints are still rejected. Both raw restores revive old grants/tokens/sessions/approval rows, but a changed external epoch denies v2 writes and approval; adapter invocation remains zero.
- Independent review found anonymous/failed review requests could drive maintenance. Public assets and denied requests no longer trigger it; successful authenticated data requests still clean expired proposals.
- Intermittent broad-run commit failures were traced to two separate clock reads: approval expiry could be 300001 ms after its recorded creation time and was correctly rejected by the strict 300000 ms engine bound. Deterministic advancing-clock tests failed before the fix on both databases. Challenge/approval expiry now derives from the single recorded timestamp, preserving the strict bound. This was a real timing defect, not dismissed as pool contention or labelled flaky.

## D. Risks and limits

Cross-agent source review is not external penetration-test certification. Real AI-vendor OAuth interoperability, physical-device browsers, production capacity, coordinated multi-instance draining/epoch rotation and production restore are unverified. Filesystem checks cannot prove the epoch is outside every operational backup domain. Restored v1 credentials still need operational invalidation under the existing runbook; v2 epoch fencing does not replace that step. Every future business adapter still needs complete affected-set revisions, service-rule, privacy, concurrency and rollback verification. Media remains ineligible until byte validation and old/new review exist.

`11-SOURCE-SHA256SUMS.txt` identifies the original prototype and is historical, not the current integration manifest.

## E. Readiness and rollback

Development foundation: independently verified at `25ec84fd63f8e7801aa6cae92b041b237b6f8436`; final verification is recorded by exact snapshot above. Full MCP v2: incomplete. Staging/production writes: **not ready**; production activation is explicitly blocked. Schema 30 is a protected future release. Feature disablement cannot downgrade the schema; an old schema-29 binary rejects version 30. Synthetic snapshot recovery/fencing is verified, production coordinated rollback is not.

## F. Production safety

Accessed: local source/worktrees, synthetic databases, GitHub read-only fetch and KB-MCP context/skills. No push, main merge, deployment, production cleanup, production commerce-data access or service/timer/cron changes occurred in this run. Commits are local isolated development commits. No real secrets/customer data entered tests.

## G. Next actions

Continue the already authorized company tools and later phases after the verified foundation. Keep production disabled, preserve the eight v1 tools, and require phase acceptance before enabling business adapters. A development completion is not production release authorization.


## Subsequent Phase1 company acceptance — 2026-11-05

Source08136e6 oncodex/mcp-v2-seller-engine independently passed full **1051 tests,1027 passed,0 failed,24 browser opt-ins skipped**,133.989s, exit0 (`.local/manager-phase1-company-full.tap`). Separate actual browser/default registration/currency/mode tests passed **11/11**,0skipped,8.026s (`.local/manager-phase1-company-browser-final.tap`). Earlier company/default/OAuth/v1 targeted78/78 and core/service/browser45/45 passed.

Three company tools are built into safe development opt-in, with existing-service normalization, bounded complete revision, strict OWNER/current scope, authentic human currency acknowledgment and minimal receipts. V1 grants remain8tools; appropriately consented new grants can see11. A current configured ordinary shop is required for allv2authority; deployment production mode remains blocked. Schema remains30. Actual machine schemas/examples are03-COMPANY-IMPLEMENTED.json; unsupported company fields are not fabricated.

Development Phase1 is accepted. Staging/production readiness remainsNO. Catalog safe-subset implementation and media design continue; later inventory/order/analytics/operations tools are incomplete. No push/main merge/deploy/production-data or cron/service changes occurred. The earlier Phase0 sections remain evidence for their own named snapshots, not the current final project status.
