# Customer v112 integration into current main

## Scope and ancestry

This integration preserves repair branch `fd60136ebfd6a556965de303b124e6e35ed54baa` (implementation checkpoint `23349abe6e70374d322c35c0c7980426756eda1c`) and main `85a54cd00665dd2963e1c21ae06fadf01531271d`. Earlier checkpoint documents describe historical validation, not acceptance of this merge.

Current assets are Customer v113 and Seller v91. Both version modules and service workers use these versions. Seller v90 had different bytes on the two branches; its cache name must not be reused. The merge retains main's asynchronous PostgreSQL adapter, inventory, fulfilment/cancellation statuses, tracking and synchronous Worker runtime. Canonical gallery edits, stale-edit checks, image ownership and customer UI repairs are implemented in both runtime paths.

## Database contract

The current schema is 15. Version 14 is reserved by the separate, unmerged multi-tenant work and is intentionally rejected. This change does not incorporate that branch.

SQLite migration identifies the divergent historical schema12 by physical product columns, supplies nullable stock for the gallery branch, retains main's fulfilment upgrade, then adds canonical gallery layouts and ten upload positions. Readiness verifies required columns and tables. Failed gallery migration rolls back its stage and remains at schema13; startup can retry. It does not relabel an incompatible schema as ready.

PostgreSQL fresh initialization uses schema15. Versions10/11/12/13 require `openPostgresDatabase(url, { allowUpgrade: true })` in an explicit operator maintenance process. Normal server startup refuses older versions and does not enable automatic upgrades. All upgrade operations run inside the existing store-owned transaction/advisory lock. Unknown versions/constraint shapes fail closed. `deploy/postgres/schema12.js` remains a historical, offline fixture; it is not the runtime initializer.

Before migrating a production database: stop writers, create and independently restore/verify a backup, review the exact physical schema, run the upgrade in maintenance, verify readiness and preserved data, then switch application traffic. Rollback means restoring the pre-upgrade database together with the old binary; restarting a schema13 binary against schema15 is unsupported. Never restore over live data without separate authorization.

## Validation and limits

The local combined Node suite passed 233/233 with Node24 and actual PostgreSQL16, zero skips. PostgreSQL10/11/12/13 tests use separate disposable databases and verify explicit upgrade, injected transaction rollback, image byte retention, gallery mutations and reopen. SQLite backup/restore tests use isolated files. Historical SQL mock tests remain labelled by their module and do not substitute for real PostgreSQL execution.

Browser checks exercise loopback Node/API through Worker forwarding, synthetic stores and blocked external requests. Search/history:14 scenarios; profile/addresses:16; controlled sharing branches:42. Sharing tests verify application handling of controlled browser APIs; they do not certify native share sheets or real outbound messages.

Demo public-contact suppression from main is retained. Public contact tests use a configured, isolated shop; no WhatsApp links are opened. Provider integrations remain not configured and dispatch disabled. Payment, live provider transport, physical mobile devices and production database recovery are not certified by this integration. Customer profile remains local guest data; authenticated customer accounts and customer-side order cancellation are separate product work. Seller cancellation and customer status display remain intact.

Builds, final PWA lifecycle and merge validation are recorded in the accompanying delivery checkpoint. This document does not claim QA100 or production readiness. Merging main may trigger Cloudflare Builds; the PostgreSQL auto-deploy controller intentionally requires manual migration for schema changes.
