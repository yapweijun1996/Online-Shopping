# Approve & Finish production extension release

This is an optional, explicitly installed storage extension over shop schema 34.
It does not change the global base schema or silently migrate every tenant. The
existing SQLite/PostgreSQL base migration and operation storage contract remain
unchanged when finish is OFF. Both dialects use the same separately versioned
finish DDL and structural checks. Development may initialize the extension;
production application startup only calls its assertion, never DDL or grants.

## Authority and current policy

The owner explicitly chose existing authenticated seller sessions instead of a
second operation password prompt. First-party approval still requires a genuine
current seller session/account/auth version, Origin/CSRF, exact proposal hash,
expiring session-bound challenge, complete PAGE/ASSET acknowledgments and an
explicit decision. OAuth grants, consent scopes, tenant binding, current
capability, epoch/build and revision remain enforced at every execution.

`MCP_V2_FINISH_ENABLED=1` is optional only within the existing complete trusted
`seller-operations-v1` production profile. It cannot enable MCP, native media,
catalog tools or a production profile by itself. The ordinary flag default is
OFF. Missing/incompatible tables and missing app DML deny enabled startup.

## Installer and SQL boundary

`node scripts/install-seller-mcp-finish.js` is host-only. It opens an EXISTING
shop store directly, verifies base schema 34 and operation storage, requires
production shop setup, matches exact expected HTTPS seller origin and database,
and checks that stored OAuth/operation/media identities match `--tenant`.
It never calls application bootstrap, account creation, grant issuance, consent,
product services or operation commit.

Example, inside a reviewed one-off candidate backend container with the same
private network, app environment and required read-only media/epoch mounts:

```
node scripts/install-seller-mcp-finish.js --action=install \
  --expected-origin=https://seller.pomelostem.com \
  --expected-database=online_shopping --expected-schema=34 --tenant=default
```

For PostgreSQL production installation, additionally supply
`FINISH_DATABASE_OWNER_PASSWORD_FILE` as a private regular read-only file with
no group/world permission, and `FINISH_DATABASE_OWNER_USER=postgres` (or the
reviewed database-owner role). These settings belong only to the one-off
installer, never the running app. The owner URL reuses the app URL's exact host,
port and database, but loads the separate owner secret file. The connected role
must own that database or be a database superuser. No password is put in an
argument, output, source or receipt.

The installer creates all extension objects and grants in one transaction.
The existing app role receives SELECT/INSERT/UPDATE/DELETE on the six fixed
finish data tables and SELECT only on `seller_mcp_finish_schema`. It receives
no CREATE, role, function, sequence or database ownership privilege. Role names
are source-bounded identifiers; table names are fixed source constants. No
`GRANT ON ALL TABLES`, ALTER DEFAULT PRIVILEGES or password reset is performed.
If grants fail, installation rolls back rather than leaving a half-authorized
extension. Run `--action=verify` with the ordinary app connection and WITHOUT
the installer owner secret afterward; it must read the actual structure and
prove app DML access.

Version 1 development prototypes and unversioned/partial tables are rejected.
Do not adopt them by editing digest rows or deleting tables. Export/review any
needed metadata and use a separately reviewed conversion if such a database
must retain it. Production has not used that isolated prototype.

## Required operator sequence

1. Review the exact main candidate and its local/CI/native/browser evidence.
   Preserve the currently deployed immutable images and all installed controller,
   Compose/runtime configuration and updater state for rollback.
2. Check the current release, all three managed timers, PostgreSQL container ID,
   start time and mounted volume, free disk and the manual protected-file gate.
   This release changes `src/config.js`, MCP code and optional host policy: it
   is a manual protected/config release, never a forced automatic update.
3. Stage candidate artifacts and the reviewed controller/Compose/runtime files.
   New controller runtime parsing accepts only a binary optional finish flag,
   requires the complete MCP profile when ON, and probes the running backend's
   actual flag (missing means OFF for older releases). Do not install partial
   host policy or erase updater baselines to bypass its protected gate.
4. Stop update/recovery/maintenance timers and services, take the shared update
   lock, persist pending intent, pause ingress and drain ALL business writers.
   Take a fresh backup of all default/platform/tenant databases and configuration;
   verify an isolated restore BEFORE changing storage. Reuse the reviewed stopped
   writer backup/restore procedure, not a live uncoordinated SQL dump.
5. Run the candidate's explicit installer with the exact reviewed database,
   origin, tenant, schema and separately mounted owner connection. Verify under
   the ordinary app role. For existing non-default tenants, use their separately
   scoped database/role and immutable tenant UUID; never install default identity
   authority in another database. Activation requires each enabled target ready.
6. Install the exact reviewed matched controller/Compose/runtime configuration,
   record its new audited local baseline, and set the optional finish flag ON.
   Activate the immutable candidate through the installed lifecycle supervisor;
   preserve PostgreSQL identity/volume and the existing epoch policy. The backend
   must start in genuine production mode and assert all extension storage.
7. Verify exact readiness revision, frontend/backend artifact identities, current
   profile and finish flag, public review/login and actual authenticated session
   review/approval/execution/read-back in a separately approved safe test target.
   No real seller product is auto-approved as a release probe. Check tenant and
   malformed/unapproved/expired/changed-content negatives. Save audit receipts.
8. Unpause only after health and storage/profile checks succeed, clear pending
   intent to the exact accepted release, then restore the three previous timers.
   A failed activation stays quarantined or follows the tested rollback path.

## Rollback

Disable the optional finish flag and restore the previous immutable application,
controller/Compose/runtime tuple through the reviewed operator procedure. New
extension metadata may remain: older/disabled app code does not read or write it.
Do not drop tables or delete product/order/history records to roll back. A
coordinated database restore is a separate exceptional rollback, requires all
writers stopped and the existing session/OAuth/epoch invalidation policy, and
may lose writes since the backup. Never restore a database merely to hide a
failed feature probe.

## Retention, rates and recovery

Finish job metadata is retained 90 days. Existing maintenance calls its
metadata-only cleanup under the trusted tenant fence, even with finish OFF.
One call deletes at most 100 total child/parent rows; it drains events, mappings
and items before an empty expired job. It creates no tables, executes no
business operation and cannot grant approval. Missing extension means no-op;
structural drift fails closed. Operation receipt cleanup can independently
cascade operation-linked finish metadata; jobs cannot pin old operation rows.
The per-account job cap remains 1,000.

Top-level mutations reserve one of 120 attempts per account/15 minutes in a
separate committed transaction; failed validation cannot roll the reservation
back. Progress reads are bounded to 600 per 15 minutes. Internal progress updates
and individual engine fences do not multiply those reservations. Batches are
at most five individually atomic operations. Progress itself is never authority.

A saved job can request approval only for its remaining pending operations in
order, with fresh per-operation challenges/image acknowledgments. Already
approved/committed items are omitted from that proof packet. A stale revision
still produces renewed review, never silent approval transfer. A renewed owner session may read progress under the same live original grant.
Old-session APPROVED items are held with RENEWED_APPROVAL_REQUIRED and require
a new proposal, complete review and explicit current-session approval. Committed
receipts are reconciled without reapplying operations. A job marker never
transfers approval authority.

Unified parent integration: the same installer transaction creates and verifies
`seller_mcp_create_draft*` alongside finish storage. Application DML grants cover
the two draft data tables; both schema metadata tables are SELECT-only. Production
startup asserts both structural manifests. Cleanup is tenant-fenced and bounded
to 100 total draft mutations; it must preserve active/bound stages and the
operation receipt/audit horizon. Never enable finish with only finish tables
installed. The optional `catalog.prepare_create` registration is present only
when the native runtime has the gated creation coordinator.
