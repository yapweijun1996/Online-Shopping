# Design: append-only `order_event`

**Status: proposal for review. Nothing here is implemented, and no production database is touched.** It addresses gap 3 in [threat-model.md](threat-model.md): `order_event` is the only audit trail, but the application database role can `UPDATE` and `DELETE` it.

## Evidence

- Application code only ever `INSERT`s into `order_event` (`src/orders.js`, `src/seller-orders.js`) and reads it (`src/seller-orders.js`).
- The only deletes are `resetDemo` (`src/shop-setup.js`, Demo shops only) and the import path (`src/sqlite-import.js`, which empties the target before copying).
- `online_shopping_app` holds `SELECT, INSERT, UPDATE, DELETE` on every table (`deploy/init-postgres.sh`).
- Current `SCHEMA_VERSION` is 17 (`src/db.js`). PostgreSQL upgrades run only with an explicit `allowUpgrade` opt-in (`src/postgres-db.js`, `src/postgres/upgrade.js`). `src/postgres/schema.sql`, `src/postgres-db.js` and `deploy/init-postgres.sh` are protected files in `deploy/auto-update.py`, so a release changing them is not deployed automatically.

## Proposal

Block `UPDATE` unconditionally and `DELETE` except for the two sanctioned paths. Updates are never legitimate, so that half carries no behavior risk.

1. **UPDATE guard (both databases).**
   - SQLite: `CREATE TRIGGER order_event_no_update BEFORE UPDATE ON order_event BEGIN SELECT RAISE(ABORT, 'order_event is append-only'); END;`
   - PostgreSQL: a trigger function raising an exception, plus `BEFORE UPDATE ON order_event FOR EACH ROW`. Also `REVOKE UPDATE ON order_event FROM online_shopping_app` in `deploy/init-postgres.sh` and in the upgrade step (guarded by the same `pg_roles` check used for option tables).
2. **DELETE guard.** Production shops never delete events. Options for the Demo and import paths:
   - **A (recommended):** PostgreSQL trigger on `DELETE` that raises unless `current_setting('app.allow_event_purge', true) = 'on'`, set with `SET LOCAL` only inside `resetDemo` and the import. SQLite gets the equivalent through a one-row `audit_guard(purge_allowed)` flag toggled inside the same transaction. The flag is set only by those two code paths.
   - B: `REVOKE DELETE` only and let Demo reset fail in PostgreSQL. Simpler, but Demo reset on PostgreSQL would break.
   - C: leave `DELETE` open and rely on the `UPDATE` guard. Smallest change, weakest guarantee.
3. **Migration.** Schema version 18 for SQLite (`migrate()` in `src/db.js`), idempotent `CREATE TRIGGER IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION`; PostgreSQL step in `upgradePostgres` and the matching text in `schema.sql` for fresh databases. Update `deploy/postgres/schema12.js` only if the schema-proof scripts require it.

## Verification plan

- Tests that `UPDATE`/`DELETE` on `order_event` fail on SQLite and PostgreSQL (CI has PostgreSQL 16), that normal order submit and each seller transition still work, and that `resetDemo` and the SQLite import still succeed.
- `npm run test:schema-compatibility` passes, including the upgrade from the previous version.
- Rehearse the PostgreSQL upgrade on a restored backup before any production release; the release touches protected files, so it needs a manual deploy approved by the owner.

## Risks and rollback

- A missed legitimate `UPDATE`/`DELETE` would surface as a 500 on an order action. Mitigation: the evidence above plus the transition tests.
- Rollback: drop the triggers (idempotent SQL) and restore the grant; no data is changed by this migration.

## Decision needed from the owner

Choose DELETE option A, B or C, and confirm a manual, rehearsed production upgrade is acceptable.
