# Durable Object historical rebuild integrity

PR28 merged as 480e1af756330bc1fa4226b77eb49430a998f585. Its application integration passed Node, PostgreSQL and browser verification. Subsequent read-only live checks found that Cloudflare static assets updated to Customer113 while /ready still returned500 (1101), a failure also observed before PR28.

Cloudflare production logs identify the error: Durable Object reset/rollback because FOREIGN KEY constraint failed. The existing adapter deferred constraints during DROP/RENAME, but SQLite retains a deferred violation counter after the parent table is restored. A Node SQLite rebuild with foreign_keys disabled does not reproduce this runtime boundary.

The adapter now runs PRAGMA foreign_key_check over every actual relationship before clearing deferred mode. Invalid relationships throw inside transactionSync and roll back all schema/data changes. Foreign key enforcement is never disabled. The SQLite explanation and the required integrity check are documented at https://sqlite.org/forum/info/64fb781a226df95c0f4edc474e590214c28ae1b4b5ddeee8f7ec4ad77286796c and https://www.sqlite.org/lang_altertable.html.

A committed regression executes the actual adapter/migration under Miniflare's real workerd SQLite Durable Object. It imports the historical repair schema12 fixture using deferred, validated relationships; reproduces the pre-fix runtime reset; verifies schema15 and unchanged order/item/delivery snapshots after repair; injects migration failure and proves schema12/data rollback and retry; rejects invalid references in rebuilds; and proves normal writes still enforce foreign keys.

This is isolated historical Durable Object verification, not a production backup/restore claim. No real customer data was downloaded or manually migrated. Preview readiness503 remains separate from a successful preview build and requires configured preview admin secrets. PostgreSQL production remains subject to the installed updater's maintenance gate.

Validation:236 combined Node tests pass with zero failures/skips and real isolated PostgreSQL16, including the actual workerd regression. Syntax and Worker dry-run pass. The first combined invocation correctly refused PostgreSQL because NODE_ENV=test was missing; its failure log was retained and the same suite rerun with the required isolated-test environment.
