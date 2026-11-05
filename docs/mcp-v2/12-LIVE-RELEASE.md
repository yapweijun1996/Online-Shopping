# Schema34 live release record

Status: **AUTHORIZED / PENDING**. This record separates the completed isolated implementation from live release acceptance. On 2026-11-06 (Asia/Kuala_Lumpur), the owner explicitly authorized commit, push, merge and deployment. The authorized release keeps MCP, AI and WhatsApp QR disabled. It does not remove the production guards or authorize enabling the new MCP v2, media or full catalog profiles.

## Accepted source and live preflight

- Production baseline: `1634735aa70090dcdf54b8d09e2cc09b33cd8a77`. Release source: `7db571ad2950a67b28e5f127be382dccbb08c737`; its implementation/test source `b8614b46e6061ce06b5bbcc7cc616f228a2bfa7e` passed all2012 tests,0failures/0skips,589.123s with the browser/native opt-ins. [Full isolated evidence](10-FINAL-VALIDATION-REPORT.md) includes historical failures and limitations. This CI-timeout/documentation successor requires its own exact-main CI and images.
- The release operator's live preflight reports default shop schema29, platform schema2 and no nondefault tenants. MCP, AI and QR are OFF. Preserve platform2, the existing PostgreSQL container and volume, secrets and installed runtime policy.
- The updater timer/service are paused and application images remain unchanged. **No live database migration or application deployment has occurred in this release record.**
- A private backup succeeded. Its isolated restore metadata comparison still needs a correction for three built-in PostgreSQL grantors; this is pending validation, not evidence that restore or migration acceptance has passed. Private backup/credential details are not recorded here.

## Observed CI timeout and bounded correction

Branch push run `42115702842` was cancelled at the verify job's ten-minute maximum. Its observed progress was971 completed tests,0reported failures and18skips, stopping during media-review tests; the PR run also reached the ten-minute limit. These are incomplete, timed-out runs, **not passing runs or observed test assertion failures**.

The integrated suite now contains2012 tests and its fully enabled local run took589.123s before GitHub job setup, dependency installation and other checks. GitHub runner execution was slower and exhausted the old whole-job budget. Raise only the main `verify` job's `timeout-minutes` from10 to30 so it can finish and report actual results. Keep the WhatsApp QR job at10, all steps, permissions, assertions and feature defaults unchanged. This increases the time budget; it does not establish that the next run passes or that opt-in browser/native tests ran in GitHub's ordinary environment.

## Mandatory gates before live acceptance

1. Complete the private restore metadata correction and validate the restored baseline, roles and schema. Rehearse schema29→34 migration and the reviewed rollback/restore procedure on the isolated restore; verify storage, inventory coverage and application-role grants while platform stays2.
2. Pause/drain all relevant writers under the reviewed manual-release lock and retain a final coordinated backup with verified manifest. Reconfirm default-only topology and all OFF flags. Never recreate PostgreSQL or change its volume as a release shortcut.
3. Require the actual postmerge main SHA's latest successful `verify.yml` push run and matching immutable backend/frontend image digests/revision labels. Recheck the reviewed source tree and protected delta, including this workflow change. PR/branch CI and an earlier SHA do not replace exact-main acceptance.
4. Perform the explicit owner migration only after the independent rehearsal and final-backup gates. Require shop34, operation storage3, inventory storage/grants and unchanged platform2. Updater image activation itself does not migrate the database.
5. Activate the candidate using the existing manual Updater interface with `initial=False`, the same control lock and no incompatible old-image automatic recovery target. Verify exact revision/readiness through backend and frontend, then normal seller/shop behavior and public host isolation, with MCP/AI/QR still OFF.
6. Record actual migration, immutable images, health, public smokes and rollback evidence before declaring **RELEASED** or resuming the timer. If activation fails, retain the manual schema fence and keep the timer stopped; never start schema29 images against committed schema34 without the approved coordinated restore.

Only the release operator's later verified evidence can advance this record. Backup success, isolated tests and extended CI timeout alone do not establish live release acceptance.
