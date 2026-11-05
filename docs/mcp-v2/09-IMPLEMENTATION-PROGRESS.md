# Implementation progress

Latest acceptance, 2026-11-05: root eee6556 integrates schema 32 and the shared inventory writer. Independent full suite: 1249 total, 1224 passed, 0 failed, 25 browser opt-ins skipped, 228.994s. Stock, ledger, stock revision and domain history share one transaction; migration preserves honest coverage without invented movements. The four inventory tools remain in progress. Media central-authority successor73d3833 separately passed37/37,0skip,15.093s; actual upload and visual approval remain incomplete. Accepted callable business functionality is still three company, four restricted catalog and three analytics tools, alongside the original eight reads. Full catalog, media, inventory tools, order decisions and operations tools are not complete.

The portable codec client/wire passed18/18 unit tests against schema31 and4/4 real ARM64 Alpine container tests after extraction. Kernel192MiB/swap0/pids32/0.5CPU, UID10001 sealed directory, actual OOM/crash/watchdog and synthetic parent API survival are verified. Application staging, multi-scope image authority and actual old/new approval remain incomplete. Inventory source audit is complete; read-only analytics and the current-tool knowledge boundary have passed their named acceptance snapshots.

Updated 2026-11-05. Baseline `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`; foundation branch `codex/mcp-v2-phase0`, integration branch `codex/mcp-v2-seller-engine`. Foundation source checkpoint `25ec84fd63f8e7801aa6cae92b041b237b6f8436` is independently verified. **The complete MCP v2 project is not finished. No production action is authorized by this progress report.**

| Phase | State | Evidence / next acceptance |
| --- | --- | --- |
| Read-only audit | Complete at original snapshot | Architecture audit distinguishes source evidence and historical KB; initial prototype merged previously at `1634735`. |
| 0 — security foundation | **Verified in isolated development** | Default-off/prod-blocked config, explicit OAuth consent, schema30, authentic first-party challenge/password approval, platform lifecycle fence, immutable operation engine, minimal receipts, bounded cleanup/CLI, gated trusted registry, actual snapshot restore. Independent full suite **1015 total, 991 passed, 0 failed, 24 browser opt-ins skipped**. See validation report for separately executed browser tests and limits. |
| 1 — company | **Verified in isolated development** | Source08136e6; three built-in tools under safe explicit opt-in and consent. Shared service rules, affected-set revision, dedicated human currency ACK, actual default RPC path. Independent full1051/1027passed/0failed/24skipped and targeted browser/default/mode11/11. |
| 2 — products | **Safe subset verified; full expansion incomplete** | Source707052c: four built-ins, shared listing/option review, existing services/history and revision protection. Full1094/1069pass/0fail/25skip; actual browser/default7/7. Group/media/stock paths remain gated. |
| 3 — images | Storage/cleanup/snapshots verified; application incomplete | Root5eba37b full1190/1165pass/0fail/25skip; 3f4c1e9 resource/storage46/46 and existing review browsers3/3. Actual coordinator/central media policy/visual approval remain in progress. [Media delivery plan](MEDIA-DELIVERY-PLAN.md); no media application tools eligible until complete flow acceptance. |
| 4 — inventory | All-writer foundation verified; tools in progress | Rooteee6556 full1249/1224pass/0fail/25skip. [Foundation](INVENTORY-FOUNDATION.md): schema32, all-writer atomic evidence, fixed actors, coverage and controlled overflow. Complete hold revision and four real tools remain pending. |
| 5 — orders | Not started | Existing decisions/state machine only; stock deduction exactly once and explicit human approval. |
| 6 — analytics | **Verified in isolated development** | Sourcef7dc171, three safe-opt-in reads, shared definitions/independent fixtures/bounded coverage; full1120/1095passed/0failed/25skipped, response/default5/5, core29/29. |
| 7 — operations/audit | Not started | Resource-bound inspection/cancellation/audit tools; foundation maintenance is not their implementation. |
| 8 — KB integration | Current-tool boundary verified | Source66d232c, independent8/8 bothDB; no runtime KB call/fallback. Real-vendor/LLM and future business-phase acceptance remain unverified. |

## Verified foundation behavior

- `readConfig` exposes v2 only after explicit development opt-in, an HTTPS seller origin, password login and canonical external epoch. Production activation is rejected. Source/public/package contents determine the build digest; operator labels cannot supply it.
- SQLite and PostgreSQL use schema30, with matching fresh SQL and all supported PostgreSQL10-29 upgrade paths. A preliminary optional-extension checkpoint was replaced by proper migrations to follow repository rules. Empty new tables confer no scopes. Import excludes active v2 consent, requests, operations, approval and challenges.
- New scopes require separately recorded consent bound to tenant/account/client/grant/auth-version/epoch/time. Legacy tokens and grants never gain writes by scope-string edits or refresh.
- Real application routes serve the first-party review. Exact Origin/CSRF, current authenticated session, fresh password and a one-use operation/session/hash-bound challenge are mandatory. Locks are released during password verification, then account, grant, tenant revision and password identity are rechecked under the platform-first fence.
- The engine persists immutable canonical proposals, uses only their server-stored changes, validates resource revisions, consumes approval and records outcome atomically. Registry dispatch occurs outside the v1 tenant transaction to preserve lock order. Only server code can supply adapters; safe opt-in now registers the accepted company and catalog subset.
- Adapters must convert results to a validated minimal receipt (<=2KiB). Expired terminal proposals are redacted; authorized replays return receipts without applying again. Receipts survive to original grant expiry plus90days; audit remains90days. Maintenance is bounded and occurs after locks; anonymous/failed review requests cannot drive it. Existing CLI supports repeated feature-off cleanup with a private hygiene-only guard for suspended tenants.
- Actual SQLite and PostgreSQL snapshot restores were exercised. A different external epoch denies restored v2 authority even though rows physically reappear. A PostgreSQL deparser/fingerprint mismatch and a1ms approval timestamp defect were found, reproduced and fixed without weakening checks.

## Independent evidence and limits

Latest full command: Node24.22.0, `NODE_ENV=test SHOP_TEST_DATABASE_URL=<private disposable URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 'test/*.test.js'`, exit0, **1015 tests /991 passed /0 failed /24 skipped**,162.082s. Targeted timestamp-fix approval/engine/registry tests:24/24. Actual snapshot/CLI/accounts/both review browsers:14/14. Syntax, dependency audit (0 reported vulnerabilities), updater39/39 and GCP deployment17/17 checks passed. Exact snapshots and earlier failed runs are retained in [validation report](10-FINAL-VALIDATION-REPORT.md).

Source reviews are independent cross-agent reviews, not external security certification. Production artifacts, physical devices, external OAuth vendors, operational backup-domain separation and coordinated multi-instance restore/epoch rotation remain unverified. A schema29 binary rejects30; flags cannot downgrade databases. New business phases still require their own service, privacy, concurrency, rollback and negative tests before acceptance.


## Company milestone — source08136e6

Company.get/preview_update/commit_update now use the existing settings business service and a shared pure normalizer. Unsupported names/registration/logo columns were not invented. The revision hashes complete company state plus bounded exact catalog-currency counts, covering every relevant writer. Existing product currencies and historical order snapshots are preserved.

Safe development opt-in registers three company tools; old read grants still see8, explicitly consented company read/write grants can see11. Explicit empty registries remain empty. All new v2 authority now additionally requires a configured ordinary shop (database modeproduction, distinct from deployment NODE_ENVproduction which remains blocked); demo/unconfigured reads/prepares/commits/replays are denied.

Actual currency changes require an unchecked, first-party human acknowledgment bound to the immutable proposal and an atomic fixed ACK audit marker. Commit verifies exact evidence identity/time/correlation; model flags cannot replace it. Actual schemas/examples are in03-COMPANY-IMPLEMENTED.json andCOMPANY-TOOLS.md.

Independent root full source08136e6: `NODE_ENV=test SHOP_TEST_DATABASE_URL=<private disposable URL> env -u QA_PLAYWRIGHT_MODULE node --test --test-concurrency=1 'test/*.test.js'`, exit0, **1051 total/1027 passed/0 failed/24 skipped**,133.989s. Actual browser/default/currency/mode targeted run: **11/11**,0skip,8.026s. Logs are in.local/manager-phase1-company-full.tap and.local/manager-phase1-company-browser-final.tap.

Catalog work remains incomplete: metadata/price/active/option safe subset is being implemented; existing group membership/media-holder effects require Phase3 image policy, and existing-stock updates require Phase4 inventory policy. No full product/variant/inventory completion is claimed. Media staging and image review remain design-only. A separately capped development codec batch has been delegated; byte decoding is not yet independently accepted or connected to commerce tools.
