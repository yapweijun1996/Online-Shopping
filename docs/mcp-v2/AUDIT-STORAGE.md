# Audit storage 34

Global schema 34 adds database-owned monotonic insertion sequences to `mcp_audit`
and `mcp_v2_event`. SQLite uses an INTEGER PRIMARY KEY AUTOINCREMENT; PostgreSQL
uses GENERATED ALWAYS AS IDENTITY. Existing UUID `id` values remain unique and all
existing fields/rows are preserved. The new numeric sequence is an internal snapshot
anchor, not an authorization identifier or a timestamp.

`mcp_audit.operation_id` is nullable and deliberately has no foreign key: historical
audit can outlive a scrubbed or purged operation. The fixed tool whitelist covers all
32 known legacy/new names and adds the typed CALL event. A whitelist entry grants no
scope, approval, role or tool registration. Legacy eight-tool READ behavior and the
90 day audit retention policy remain unchanged.

Logical `mcp_v2_event` records retain their old IDs, fields and historical preview-tool
labels. New typed MCP READ/CALL records serve a different purpose: actual invocation
names, controlled outcomes and original operation correlation. This migration does
not rewrite old records or claim complete historical RPC/replay coverage. The engine
must append initial/commit/replay CALL records inside its writer transaction before
the new public controls can be accepted; a post-commit audit wrapper is insufficient.

## Explicit migration and physical checks

The 33-to34 migration first validates the exact known old `mcp_audit` physical shape
and the existing operation extension metadata/fingerprint. Unknown columns, indexes,
constraints or unsigned prototypes are rejected. A partially applied migration is
not adopted. SQLite rebuilds audit tables transactionally. PostgreSQL alters identity
and key constraints transactionally and backfills sequence order by timestamp, UUID.
The operation extension metadata advances from 2 to 3 and includes identity properties.

The mixed combination of an already34 audit table with version2 operation metadata
is rejected before mutation: no historical supported upgrade produces it. A legacy
audit table with version3 metadata is supported because pre30 upgrades can initialize
the current operation extension before reaching the explicit audit migration. Legacy
test fixtures recreate the actual old audit table rather than retaining fresh34 DDL.

Fresh PostgreSQL SQL is generated from the same audit/operation DDL and metadata SQL.
The frozen 33 source fixture is `test/fixtures/postgres-schema33.sql`, SHA256
`b87df3c9706743c458bff7a9d73a978da640e4dbe1388dd512b5626dd43e13d7`.
Older 30 golden DDL stays byte-exact through the explicit legacy option; source-version
upgrades retain the 32 inventory table fingerprint and 33 covering order index unchanged.

Trusted SQLite import uses OVERRIDING SYSTEM VALUE for the two PostgreSQL identity
columns, verifies exact historical row digests and resets both sequences above their
maximum copied value. Active v2 operations/consent/proofs remain excluded by the existing
import contract. Restoring audit history does not grant new operation rights.

Legacy application upgrades grant only the required audit table and the two named
sequence privileges under the existing legacy-database/role guard. Tenant databases
never receive cross-grants to that legacy role. No production role was modified by
development tests; all tests use the owned disposable PostgreSQL server.

## Rollback and acceptance

DDL/history/version changes share one migration transaction; interruption rolls them
all back. Reverting application code is not a database downgrade. A reviewed rollback
requires an appropriate prior snapshot and the existing all-instance external epoch
rotation procedure. Source code and synthetic restore tests do not authorize production
migration or attest to an external deployment.

Targeted tests cover fresh storage, exact prior 33, supported older paths, preserved
UUID/field values, non-reused sequences, malformed-shape rejection, late DDL rollback,
specific role privileges, SQLite import/reset and actual snapshots/restore. Public
operation controls, stable signed pagination and typed engine CALL acceptance remain
separate application checkpoints.
